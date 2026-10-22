// Денежный API для light и кассы (контракт M1 §13, §14; M2 §5): возвраты, статус чеков,
// платежи бара и кассы.
//
//   refund(db, { paymentId, amountKopecks, reason, key?, items?, customer?, requestedBy?, description? })
//       → { refund_id, status, amount_kopecks }; у платежа бара items (позиции чека возврата) обязательны
//   receiptStatus(db, { paymentIds }) → { [paymentId]: 'pending' | 'succeeded' | 'receipt_pending'
//                                           | 'failed' | 'canceled' | 'none' }
//   createOnlinePayment(db, { clubId, saleId, method, amountKopecks, items, customer, ... })
//       → { payment, confirmation } — СБП или карта ЮKassa бара и кассы (kind bar)
//   recordOfflinePayment(db, { clubId, saleId, method, amountKopecks, receivedKopecks?, staffId, ... })
//       → payment — наличные или терминал на кассе (kind bar), сразу succeeded
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
import { enterClub } from './context.mjs';
import { createYooKassaPayment } from './pay.mjs';
import { receiptPhone, yookassaReceipt, receiptItems } from './receipt.mjs';
import { insertReceipt, receiptPhoneOf, sessionIdOf, stableUuid } from './records.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { YooKassaError, formatValue, parseValue } from './yookassa.mjs';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_RECEIPT_IDS = 200;

/**
 * Статус чека продажи по каждому платежу (чек сессии, light). db — транзакция с контекстом
 * клуба: чужие платежи RLS не покажет (для них — 'none'). Чек ККТ в статусе printed (пробит,
 * M2) отдаётся как succeeded — набор статусов для light не меняется.
 * Действующий чек — последний чек продажи, кроме отменённых (у заморозки чек на сумму
 * заморозки отменяется и заменяется чеком на фактическую сумму); все отменены — 'canceled';
 * чека нет — 'none'. Чеки возвратов сюда не входят.
 * @param {import('pg').ClientBase} db
 * @param {{ paymentIds: string[] }} args
 * @returns {Promise<Record<string, string>>}
 */
export async function receiptStatus(db, { paymentIds } = {}) {
  if (!Array.isArray(paymentIds)) throw new MoneyError('bad_request', 'paymentIds');
  const ids = [...new Set(paymentIds.filter((id) => typeof id === 'string' && UUID.test(id)))];
  if (ids.length > MAX_RECEIPT_IDS) throw new MoneyError('bad_request', 'paymentIds: слишком много');
  const out = Object.fromEntries(ids.map((id) => [id, 'none']));
  if (ids.length === 0) return out;
  const { rows } = await db.query(
    `select distinct on (payment_id) payment_id, status
       from bl.receipts
      where payment_id = any($1::uuid[]) and kind = 'sale'
      order by payment_id, (status = 'canceled'), created_at desc, id desc`,
    [ids],
  );
  // printed — чек пробит на ККТ клуба (M2, server/kkt): для чека сессии это успех, отдаём succeeded.
  for (const r of rows) out[r.payment_id] = r.status === 'printed' ? 'succeeded' : r.status;
  return out;
}

/** Позиции чека 54-ФЗ от вызывающего: формат ЮKassa, сумма (цена × количество) = amount. */
export function checkItems(items, amountKopecks) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 100) throw new MoneyError('bad_request', 'items');
  let milli = 0;
  for (const it of items) {
    const price = parseValue(it?.amount?.value);
    const qty = Number(it?.quantity);
    if (
      price === null || price <= 0 || it.amount.currency !== 'RUB' || !Number.isFinite(qty) || qty <= 0 ||
      typeof it.description !== 'string' || it.description.length < 1 || it.description.length > 128 ||
      !Number.isInteger(it.vat_code) || it.vat_code < 1 || it.vat_code > 12
    ) {
      throw new MoneyError('bad_request', 'позиция чека');
    }
    milli += Math.round(price * qty * 1000);
  }
  if (milli !== amountKopecks * 1000) throw new MoneyError('bad_request', 'сумма позиций чека не равна сумме');
  return items;
}

const BAR_METHODS_ONLINE = ['sbp', 'card'];
const BAR_METHODS_OFFLINE = ['cash', 'card_terminal'];

/** id и ключ платежа продажи кассы (детерминированные: повтор продажи — тот же платёж). */
export const barPaymentId = (saleId) => stableUuid(`bl.payment/bar/${saleId}`);
export const barIdempotenceKey = (saleId) => `bar-${saleId}`;

/**
 * Платёж ЮKassa бара и кассы (контракт M2 §5): СБП (на экране кассы — confirmation qr) или карта
 * (гостю — redirect). kind = 'bar'. Строки платежа и чека — в транзакции вызывающего (контекст клуба).
 * Подтверждение — общий путь money: вебхук или сверка → outbox payment.confirmed (kind bar);
 * отказ — outbox payment.canceled.
 * @param {{ clubId: string, saleId: string, method: 'sbp'|'card', amountKopecks: number, items: object[],
 *           customer: { phone: string } | { email: string }, phone?: string|null,
 *           confirmation: 'qr'|'redirect', returnUrl?: string, description: string, metadata?: object,
 *           requestKey?: string|null, userId?: string|null, resourceId?: string|null }} args
 */
export async function createOnlinePayment(db, args, injected) {
  const { deps, config } = injected ?? (await rt());
  const { clubId, saleId, method, amountKopecks } = args;
  if (!UUID.test(saleId ?? '')) throw new MoneyError('bad_request', 'saleId');
  if (!BAR_METHODS_ONLINE.includes(method)) throw new MoneyError('bad_request', 'method');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (args.confirmation !== 'qr' && args.confirmation !== 'redirect') throw new MoneyError('bad_request', 'confirmation');
  if (args.confirmation === 'qr' && method !== 'sbp') throw new MoneyError('bad_request', 'QR — только СБП');
  if (args.confirmation === 'redirect' && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(args.returnUrl ?? '')) {
    throw new MoneyError('bad_request', 'returnUrl');
  }
  const customer = args.customer;
  if (!customer || (!customer.phone && !customer.email)) throw new MoneyError('bad_request', 'customer');
  const items = checkItems(args.items, amountKopecks);
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');
  const receipt = { customer, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  return createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId: barPaymentId(saleId),
    idempotenceKey: barIdempotenceKey(saleId),
    requestKey: args.requestKey ?? null,
    kind: 'bar',
    method,
    amountKopecks,
    capture: true,
    receipt,
    confirmation: args.confirmation === 'qr' ? { type: 'qr' } : { type: 'redirect', returnUrl: args.returnUrl },
    description: args.description ?? 'Бар',
    metadata: { ...(args.metadata ?? {}), sale_id: saleId },
    userId: args.userId ?? null,
    resourceId: args.resourceId ?? null,
    phone: args.phone ?? null,
    now: deps.clock.now(),
  });
}

/**
 * Наличные или терминал на кассе (kind bar): платёж сразу succeeded, confirmed_at ставится
 * один раз; outbox payment.confirmed нет (это не игра — продажу завершает касса), чек ККТ
 * ставит касса (server/kkt). Повтор с тем же saleId возвращает тот же платёж.
 * @param {{ clubId: string, saleId: string, method: 'cash'|'card_terminal', amountKopecks: number,
 *           receivedKopecks?: number|null, staffId: string, requestKey?: string|null, userId?: string|null }} args
 */
export async function recordOfflinePayment(db, args, injected) {
  const { deps } = injected ?? (await rt());
  const { clubId, saleId, method, amountKopecks } = args;
  if (!UUID.test(saleId ?? '')) throw new MoneyError('bad_request', 'saleId');
  if (!BAR_METHODS_OFFLINE.includes(method)) throw new MoneyError('bad_request', 'method');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  if (!UUID.test(args.staffId ?? '')) throw new MoneyError('bad_request', 'staffId');
  let received = null;
  let change = 0;
  if (method === 'cash') {
    received = args.receivedKopecks ?? amountKopecks;
    if (!Number.isSafeInteger(received) || received < amountKopecks || received > amountKopecks + 10_000_000) {
      throw new MoneyError('bad_request', 'receivedKopecks');
    }
    change = received - amountKopecks;
  }
  await enterClub(db, clubId);
  const id = barPaymentId(saleId);
  const prev = (await db.query('select * from bl.payments where id = $1', [id])).rows[0];
  if (prev) {
    if (prev.method !== method || Number(prev.amount_kopecks) !== amountKopecks) throw new MoneyError('idempotency_conflict');
    return prev;
  }
  const now = deps.clock.now();
  const { rows } = await db.query(
    `insert into bl.payments (id, club_id, resource_id, user_id, kind, provider, method, idempotence_key, request_key, status,
                              amount_kopecks, capture, received_kopecks, change_kopecks, accepted_by, confirmed_at, captured_at,
                              created_at, updated_at)
     values ($1, $2, null, $3, 'bar', 'reception', $4, $5, $6, 'succeeded', $7, true, $8, $9, $10, $11, $11, $11, $11)
     returning *`,
    [id, clubId, args.userId ?? null, method, barIdempotenceKey(saleId), args.requestKey ?? null, amountKopecks, received, change, args.staffId, now],
  );
  return rows[0];
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
  // Позиции чека возврата: у бара — от кассы (что именно возвращается), у стола — «Игра, стол N».
  const items = args.items === undefined ? null : checkItems(args.items, amountKopecks);
  if (p.kind === 'bar' && !items) throw new MoneyError('bad_request', 'items: позиции чека возврата бара');
  const requestedBy = UUID.test(args.requestedBy ?? '') ? args.requestedBy : null;

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
      `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
       values ($1, $2, $3, $4, 'manual', $5, $7, $6, $6) returning *`,
      [p.club_id, p.id, key, amountKopecks, reason, now, requestedBy],
    );
    await insertReceipt(db, {
      clubId: p.club_id,
      paymentId: p.id,
      refundId: f[0].id,
      kind: 'refund',
      channel: 'kkt',
      status: 'receipt_pending',
      amountKopecks,
      items: items ?? receiptItems({ resourceNumber: number, minutes: p.minutes, amountKopecks, vatCode: settings.vat_code }),
      taxSystemCode: settings.tax_system_code,
      userId: p.user_id,
      now,
    });
    await refunded(db, deps, f[0], now);
    return { refund_id: f[0].id, status: 'manual', amount_kopecks: amountKopecks };
  }

  const phone = await receiptPhoneOf(db, p.id);
  let receipt;
  if (items) {
    const customer = args.customer ?? (receiptPhone(phone) ? { phone: receiptPhone(phone) } : null);
    if (!customer) throw new MoneyError('bad_request', 'нет контакта покупателя для чека возврата');
    receipt = { customer, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  } else {
    receipt = yookassaReceipt({ phone, resourceNumber: number, minutes: p.minutes, amountKopecks, settings });
  }
  const { rows: ins } = await db.query(
    `insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at)
     values ($1, $2, $3, $4, 'pending', $5, $7, $6, $6) returning *`,
    [p.club_id, p.id, key, amountKopecks, reason, now, requestedBy],
  );
  let f = ins[0];
  let remote;
  try {
    const client = clientFor(settings, config);
    remote = await client.createRefund(
      {
        payment_id: p.provider_payment_id,
        amount: { value: formatValue(amountKopecks), currency: 'RUB' },
        description: String(args.description ?? (p.kind === 'bar' ? 'Возврат: бар' : `Возврат: стол ${number}`)).slice(0, 128),
        receipt,
      },
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
