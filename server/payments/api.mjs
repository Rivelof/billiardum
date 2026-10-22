// Денежный API для light (контракт M1 §13): возврат за interrupted и аварийный.
//
//   refund(db, { paymentId, amountKopecks, reason, key? }) → { refund_id, status, amount_kopecks }
//
// * db — транзакция вызывающего с контекстом клуба платежа.
// * Идемпотентно: ключ (key или хеш платежа, суммы и причины) хранится в bl.refunds
//   и уходит в ЮKassa как Idempotence-Key — повтор обработчика outbox не вернёт деньги дважды.
// * Сумма возвратов не больше оплаченного (у заморозки — списанного).
// * ЮKassa: POST /v3/refunds с чеком возврата 54-ФЗ. Заморозка, которая ещё не списана,
//   отменяется целиком (возврат всей суммы) или списывается за вычетом возврата.
// * Наличные и терминал: возврат «manual» (деньги отдаёт ресепшн) и задание на чек возврата
//   ККТ (receipt_pending, M2); владелец и ресепшн получают уведомление.
// * Журнал payment.refunded с причиной, outbox payment.refunded, уведомление владельцу (инвариант 8).

import { createHash } from 'node:crypto';
import { moneyConfig } from './config.mjs';
import { resolveDeps } from './deps.mjs';
import { MoneyError } from './errors.mjs';
import { yookassaReceipt, receiptItems } from './receipt.mjs';
import { insertReceipt, receiptPhoneOf, sessionIdOf } from './records.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { YooKassaError, formatValue } from './yookassa.mjs';

let runtime = null;

/** init(ctx) денежного модуля задаёт зависимости и настройки; без него — из окружения. */
export function setRuntime(rt) {
  runtime = rt;
}

async function rt() {
  if (runtime) return runtime;
  const deps = await resolveDeps({});
  return { deps, config: moneyConfig(undefined) };
}

function refundKey({ paymentId, amountKopecks, reason, key }) {
  if (key) return String(key).slice(0, 64);
  return `r-${createHash('sha256').update(`${paymentId}|${amountKopecks}|${reason}`).digest('hex').slice(0, 40)}`;
}

/** Статус возврата из ЮKassa; succeeded — журнал, outbox, уведомление (один раз). */
export async function applyRefundStatus(db, deps, refund, status, { now = deps.clock.now() } = {}) {
  const map = { succeeded: 'succeeded', canceled: 'canceled', pending: 'pending' };
  const next = map[status];
  if (!next || next === refund.status) return refund;
  const { rows } = await db.query(
    `update bl.refunds set status = $2, updated_at = $3 where id = $1 and status in ('pending') returning *`,
    [refund.id, next, now],
  );
  if (rows.length === 0) return refund;
  if (next === 'succeeded') await refunded(db, deps, rows[0], now);
  return rows[0];
}

async function refunded(db, deps, refund, now) {
  const { rows } = await db.query('select * from bl.payments where id = $1', [refund.payment_id]);
  const p = rows[0];
  const amount = Number(refund.amount_kopecks);
  await deps.audit.appendAudit(db, {
    action: 'payment.refunded',
    objectType: 'payment',
    objectId: p.id,
    reason: refund.reason,
    data: { payment_id: p.id, refund_id: refund.id, method: p.method, amount_kopecks: amount, status: refund.status },
  });
  const sessionId = await sessionIdOf(db, p);
  await deps.outbox.enqueue(db, 'payment.refunded', { payment_id: p.id, club_id: p.club_id, session_id: sessionId, amount_kopecks: amount });
  try {
    await deps.notify.sendToClubStaff(db, p.club_id, refund.status === 'manual' ? ['owner', 'manager', 'reception'] : ['owner'], {
      kind: 'refund',
      text:
        refund.status === 'manual'
          ? `Возврат ${formatValue(amount).replace('.', ',')} ₽ гостю на ресепшене: ${refund.reason}`
          : `Возврат ${formatValue(amount).replace('.', ',')} ₽: ${refund.reason}`,
      data: { payment_id: p.id, refund_id: refund.id, amount_kopecks: amount },
    });
  } catch (err) {
    deps.log?.warn?.('refund_notify_failed', { refund_id: refund.id, error: err.message });
  }
  deps.log?.info?.('payment_refunded', { payment_id: p.id, refund_id: refund.id, club_id: p.club_id, amount_kopecks: amount, at: now.toISOString() });
}

/**
 * Возврат денег гостю.
 * @param {import('pg').PoolClient} db транзакция с контекстом клуба
 * @param {{ paymentId: string, amountKopecks: number, reason: string, key?: string }} args
 */
export async function refund(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { paymentId, amountKopecks, reason } = args;
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2000) throw new MoneyError('reason_required');
  const now = deps.clock.now();
  const { rows } = await db.query('select * from bl.payments where id = $1 for update', [paymentId]);
  const p = rows[0];
  if (!p) throw new MoneyError('not_found', 'payment');
  const key = refundKey({ ...args, amountKopecks });
  const prev = await db.query('select * from bl.refunds where club_id = $1 and idempotence_key = $2', [p.club_id, key]);
  if (prev.rowCount > 0) {
    const f = prev.rows[0];
    return { refund_id: f.id, status: f.status, amount_kopecks: Number(f.amount_kopecks) };
  }

  const settings = await loadPaymentSettings(db, p.club_id);
  const { rows: res } = await db.query('select number from bl.resources where id = $1', [p.resource_id]);
  const number = res[0]?.number;

  // Заморозка ещё не списана: отменить целиком или списать за вычетом возврата.
  if (p.status === 'waiting_for_capture') {
    if (amountKopecks > Number(p.amount_kopecks)) throw new MoneyError('limit_exceeded', 'возврат больше заморозки');
    const { captureOrRelease } = await import('./capture.mjs');
    await captureOrRelease(db, deps, config, p, { amountKopecks: Number(p.amount_kopecks) - amountKopecks, number, settings, now });
    const { rows: f } = await db.query(
      `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
       values ($1, $2, $3, $4, 'succeeded', $5, $6, $6) returning *`,
      [p.club_id, p.id, key, amountKopecks, reason, now],
    );
    await refunded(db, deps, f[0], now);
    return { refund_id: f[0].id, status: 'succeeded', amount_kopecks: amountKopecks };
  }

  if (p.status !== 'succeeded') throw new MoneyError('payment_pending', `платёж в статусе ${p.status}`);
  const base = p.capture ? Number(p.amount_kopecks) : Number(p.captured_kopecks ?? 0);
  const { rows: sum } = await db.query(
    `select coalesce(sum(amount_kopecks), 0)::bigint as total from bl.refunds where payment_id = $1 and status <> 'canceled'`,
    [p.id],
  );
  if (Number(sum[0].total) + amountKopecks > base) throw new MoneyError('limit_exceeded', 'возврат больше оплаченного');

  if (p.provider === 'reception') {
    const { rows: f } = await db.query(
      `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
       values ($1, $2, $3, $4, 'manual', $5, $6, $6) returning *`,
      [p.club_id, p.id, key, amountKopecks, reason, now],
    );
    await insertReceipt(db, {
      clubId: p.club_id,
      paymentId: p.id,
      refundId: f[0].id,
      kind: 'refund',
      channel: 'kkt',
      status: 'receipt_pending',
      amountKopecks,
      items: receiptItems({ resourceNumber: number, minutes: p.minutes, amountKopecks, vatCode: settings.vat_code }),
      taxSystemCode: settings.tax_system_code,
      userId: p.user_id,
      now,
    });
    await refunded(db, deps, f[0], now);
    return { refund_id: f[0].id, status: 'manual', amount_kopecks: amountKopecks };
  }

  const phone = await receiptPhoneOf(db, p.id);
  const receipt = yookassaReceipt({ phone, resourceNumber: number, minutes: p.minutes, amountKopecks, settings });
  const { rows: ins } = await db.query(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, created_at, updated_at)
     values ($1, $2, $3, $4, 'pending', $5, $6, $6) returning *`,
    [p.club_id, p.id, key, amountKopecks, reason, now],
  );
  let f = ins[0];
  let remote;
  try {
    const client = clientFor(settings, config);
    remote = await client.createRefund(
      { payment_id: p.provider_payment_id, amount: { value: formatValue(amountKopecks), currency: 'RUB' }, description: `Возврат: стол ${number}`, receipt },
      key,
    );
  } catch (err) {
    if (err instanceof YooKassaError) {
      deps.log?.warn?.('refund_provider_error', { payment_id: p.id, status: err.status, code: err.code, retryable: err.retryable });
      throw new MoneyError('payment_failed', err.message, err.retryable ? 503 : 409);
    }
    throw err;
  }
  await db.query('update bl.refunds set provider_refund_id = $2, updated_at = $3 where id = $1', [f.id, remote.id, now]);
  await insertReceipt(db, {
    clubId: p.club_id,
    paymentId: p.id,
    refundId: f.id,
    kind: 'refund',
    channel: 'yookassa',
    status: remote.receipt_registration === 'succeeded' ? 'succeeded' : 'pending',
    amountKopecks,
    items: receipt.items,
    taxSystemCode: settings.tax_system_code,
    userId: p.user_id,
    phone,
    now,
  });
  f = await applyRefundStatus(db, deps, { ...f, provider_refund_id: remote.id }, remote.status, { now });
  return { refund_id: f.id, status: f.status, amount_kopecks: amountKopecks };
}
