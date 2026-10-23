// Чек зачёта предоплаты (54-ФЗ; decisions №52, №108, №112).
//
// Предоплата (бронь, пакет часов, депозит) пробивается чеком «предоплата 100 %» в момент оплаты;
// когда услуга оказана (игра началась, минуты пакета списаны, сессия по депозиту закрыта),
// нужен второй чек — позиции «полный расчёт» и оплата «зачёт предоплаты».
//
// * Предоплата через ЮKassa → строка bl.receipts (channel yookassa, receipt_pending) и событие
//   outbox money.receipt_settle; обработчик отправляет POST /v3/receipts по платежу предоплаты
//   (type payment, settlements [{type: prepayment}]) с ключом идемпотентности st-<receipt_id>.
//   Сбой ЮKassa (сеть, 5xx) — повтор outbox с нарастающей паузой; отказ (4xx) — статус failed и
//   тревога с действием «Повторить» (retrySettlementReceipt, POST /api/receipts/{id}/retry, 0656).
// * Предоплата наличными или картой через терминал (депозит, пакет на кассе) → задание ККТ
//   (server/kkt enqueueReceipt) с оплатой «предоплата» (АТОЛ prepaid).
// Поля /v3/receipts, в которых нет уверенности, перечислены в server/payments/README.md.

import { enterClub } from './context.mjs';
import { MoneyError } from './errors.mjs';
import { receiptPhone } from './receipt.mjs';
import { receiptPhoneOf } from './records.mjs';
import { clientFor, loadPaymentSettings } from './settings.mjs';
import { formatValue, YooKassaError } from './yookassa.mjs';

export const SETTLE_TOPIC = 'money.receipt_settle';

/**
 * Поставить чек зачёта предоплаты source на сумму amountKopecks.
 * @param {object} p
 * @param {object} p.source строка bl.payments — платёж предоплаты
 * @param {string} p.forPaymentId платёж, к которому относится чек (bl.receipts.payment_id)
 * @param {object[]} p.items позиции «полный расчёт» (формат ЮKassa), Σ = amountKopecks
 * @param {string} [p.operatorName] кассир (чек ККТ)
 * @returns {Promise<string|null>} id чека или null, если сумма 0
 */
export async function queueSettlementReceipt(db, deps, { source, forPaymentId, items, amountKopecks, operatorName = null, now }) {
  if (!(amountKopecks > 0)) return null;
  const prev = await db.query(
    `select id from bl.receipts where club_id = $1 and payment_id = $2 and settles_payment_id = $3 and kind = 'sale' limit 1`,
    [source.club_id, forPaymentId, source.id],
  );
  if (prev.rows[0]) return prev.rows[0].id;
  const settings = await loadPaymentSettings(db, source.club_id);
  if (source.provider === 'yookassa') {
    const phone = await receiptPhoneOf(db, source.id);
    const { rows } = await db.query(
      `insert into bl.receipts (club_id, payment_id, kind, channel, status, amount_kopecks, items, tax_system_code,
                                customer_user_id, customer_phone, settles_payment_id, settlement_kopecks, created_at, updated_at)
       values ($1, $2, 'sale', 'yookassa', 'receipt_pending', $3, $4::jsonb, $5, $6, $7, $8, $3, $9, $9)
       returning id`,
      [source.club_id, forPaymentId, amountKopecks, JSON.stringify(items), settings.tax_system_code, source.user_id, phone, source.id, now],
    );
    await deps.outbox.enqueue(db, SETTLE_TOPIC, { receipt_id: rows[0].id, club_id: source.club_id });
    return rows[0].id;
  }
  // Наличные и терминал — ККТ клуба, оплата «предоплата» (зачёт аванса); server/kkt сам пишет
  // settles_payment_id и settlement_kopecks и отличает чек зачёта от чека предоплаты при повторе.
  return deps.kkt.enqueueReceipt(db, {
    clubId: source.club_id,
    kind: 'sell',
    lines: items,
    payments: [{ method: 'prepayment', amount_kopecks: amountKopecks }],
    operatorName: operatorName ?? 'Кассир',
    paymentId: forPaymentId,
    settlesPaymentId: source.id,
    settlementKopecks: amountKopecks,
    customerUserId: source.user_id ?? null,
    now,
  });
}

/** Ключ ЮKassa: st-<id>; после ручного повтора (отказ 4xx) — st-<id>-r<n> (см. 0656). */
export function settleKey(r) {
  return r.settle_retry > 0 ? `st-${r.id}-r${r.settle_retry}` : `st-${r.id}`;
}

/**
 * POST /api/receipts/{id}/retry — повторить чек зачёта после отказа ЮKassa (Д2): управляющий и выше,
 * причина обязательна. Только чек зачёта через ЮKassa в статусе failed; уже отправленный или в
 * очереди — тот же ответ без действий. Журнал manual.receipt_retry, событие money.receipt_settle.
 */
export async function retrySettlementReceipt(db, deps, { receiptId, reason, staffId }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why || why.length > 2000) throw new MoneyError('reason_required');
  const { rows } = await db.query('select * from bl.receipts where id = $1 for update', [receiptId]);
  const r = rows[0];
  if (!r || r.channel !== 'yookassa' || !r.settles_payment_id || r.kind !== 'sale') throw new MoneyError('not_found', 'receipt');
  if (r.status !== 'failed') return { receipt_id: r.id, status: r.status, retried: false };
  if (r.settle_retry >= 100) throw new MoneyError('limit_exceeded', 'повторов чека');
  const now = deps.clock.now();
  const { rows: up } = await db.query(
    `update bl.receipts set status = 'receipt_pending', settle_retry = settle_retry + 1, provider_receipt_id = null, updated_at = $2
      where id = $1 returning settle_retry`,
    [r.id, now],
  );
  await deps.audit.appendAudit(db, {
    action: 'manual.receipt_retry',
    objectType: 'payment',
    objectId: r.payment_id,
    reason: why,
    data: { receipt_id: r.id, payment_id: r.payment_id, settles_payment_id: r.settles_payment_id, attempt: up[0].settle_retry },
    actorType: 'user',
    actorId: staffId ?? null,
  });
  await deps.outbox.enqueue(db, SETTLE_TOPIC, { receipt_id: r.id, club_id: r.club_id });
  return { receipt_id: r.id, status: 'receipt_pending', retried: true };
}

/** Обработчик outbox money.receipt_settle: отправить чек зачёта в ЮKassa. */
export async function sendSettlementReceipt(db, deps, config, payload) {
  await enterClub(db, payload.club_id);
  const { rows } = await db.query(
    `select r.*, p.provider_payment_id as source_provider_id
       from bl.receipts r join bl.payments p on p.id = r.settles_payment_id
      where r.id = $1 for update of r`,
    [payload.receipt_id],
  );
  const r = rows[0];
  if (!r || r.channel !== 'yookassa' || r.provider_receipt_id || r.status !== 'receipt_pending') return { result: 'skipped' };
  const settings = await loadPaymentSettings(db, r.club_id, { isTest: r.is_test });
  const phone = receiptPhone(r.customer_phone);
  const now = deps.clock.now();
  const fail = (code) => failSettlement(db, deps, r, code, now);
  if (!phone) return fail('no_customer');
  const body = {
    type: 'payment',
    payment_id: r.source_provider_id,
    send: true,
    customer: { phone },
    items: r.items,
    settlements: [{ type: 'prepayment', amount: { value: formatValue(Number(r.settlement_kopecks)), currency: 'RUB' } }],
    ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}),
  };
  let remote;
  try {
    remote = await clientFor(settings, config).createReceipt(body, settleKey(r));
  } catch (err) {
    if (err instanceof YooKassaError && !err.retryable) return fail(err.code);
    throw err; // сеть или 5xx — outbox повторит тем же ключом
  }
  const status = { succeeded: 'succeeded', pending: 'pending', canceled: 'failed' }[remote?.status] ?? 'pending';
  await db.query(`update bl.receipts set provider_receipt_id = $2, status = $3, updated_at = $4 where id = $1`, [r.id, remote.id, status, now]);
  if (status === 'failed') await failSettlement(db, deps, r, 'canceled', now);
  return { result: status, provider_receipt_id: remote.id };
}

/** Чек зачёта не пробит: статус failed и тревога с действием «Повторить» (экран тревог). */
async function failSettlement(db, deps, r, code, now) {
  await db.query(`update bl.receipts set status = 'failed', updated_at = $2 where id = $1`, [r.id, now]);
  deps.log?.error?.('settlement_receipt_failed', { receipt_id: r.id, club_id: r.club_id, code });
  await deps.alarms.raise(db, r.club_id, {
    type: 'settlement_receipt_failed',
    level: 'important',
    data: { receipt_id: r.id, code, action_id: 'retry', action_title: 'Повторить', action_url: `/api/receipts/${r.id}/retry` },
  });
  return { result: 'failed' };
}

/**
 * Опрос чека зачёта, который ЮKassa приняла, но ещё не зарегистрировала (pending; п. 6):
 * планировщик, money_due receipt_stale. succeeded — готово; canceled — failed и тревога; pending —
 * отметка updated_at (следующий опрос через минуту).
 */
export async function pollSettlementReceipt(db, deps, config, receiptId) {
  const { rows } = await db.query('select * from bl.receipts where id = $1 for update', [receiptId]);
  const r = rows[0];
  if (!r || r.channel !== 'yookassa' || r.status !== 'pending' || !r.provider_receipt_id) return { result: 'skipped' };
  const now = deps.clock.now();
  const settings = await loadPaymentSettings(db, r.club_id, { isTest: r.is_test });
  const remote = await clientFor(settings, config).getReceipt(r.provider_receipt_id);
  if (remote?.status === 'succeeded') {
    await db.query(`update bl.receipts set status = 'succeeded', updated_at = $2 where id = $1`, [r.id, now]);
    return { result: 'succeeded' };
  }
  if (remote?.status === 'canceled') return failSettlement(db, deps, r, 'canceled', now);
  await db.query('update bl.receipts set updated_at = $2 where id = $1', [r.id, now]);
  return { result: 'pending' };
}

/**
 * Сессия закрыта (outbox session.closed, п. 2): чеки зачёта за минуты баланса, которые реально
 * сыграны. Минуты, вернувшиеся на баланс (возврат light, отказ стола), в чек не попадают — зачёт
 * за неоказанную услугу не пробивается. Повтор — те же чеки (queueSettlementReceipt).
 */
export async function settleSessionBalance(db, deps, { sessionId, now }) {
  const { rows } = await db.query(
    `select p.id from bl.payments p
      where p.balance_minutes > 0 and p.status = 'succeeded'
        and (p.session_id = $1 or p.id in (select sp.payment_id from bl.session_payments sp where sp.session_id = $1 and sp.outcome = 'applied'))
      order by p.created_at, p.id`,
    [sessionId],
  );
  const { issueBalanceReceipts } = await import('../packages/balance.mjs');
  const out = [];
  for (const p of rows) out.push(...(await issueBalanceReceipts(db, deps, { paymentId: p.id, now })));
  return out.filter(Boolean);
}
