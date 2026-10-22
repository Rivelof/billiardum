// Предоплата брони (контракт M3 §1 п. 5, §3; decisions №52, №108).
//
//   createPrepayment(db, { clubId, bookingId, resourceId, userId, amountKopecks, method?, returnUrl?, description?, requestKey? })
//       → { payment, confirmation } — платёж ЮKassa kind booking, чек «предоплата 100 %» (full_prepayment);
//         id платежа и ключ ЮKassa детерминированы по брони (повтор — тот же платёж).
//         Подтверждение — общий путь: вебхук → outbox payment.confirmed { kind: 'booking', booking_id }.
//   settlePrepayment(db, { paymentId, sessionId }) → { payment_id, settled_kopecks, receipt_id }
//       — игра по брони началась: чек зачёта предоплаты (full_payment, оплата «зачёт предоплаты»).
//   forfeitPrepayment(db, { paymentId, percent?, reason }) → { kept_kopecks, refunded_kopecks, refund_id }
//       — бронь сгорела или отменена: удержать percent % (по умолчанию club_payment_settings.booking_forfeit_percent,
//         100 %) с чеком зачёта на удержанное, остальное вернуть с чеком возврата предоплаты.
// db — транзакция вызывающего (booking) с контекстом клуба.

import { enterClub } from './context.mjs';
import { MoneyError } from './errors.mjs';
import { formatValue } from './yookassa.mjs';
import { createYooKassaPayment, returnUrl } from './pay.mjs';
import { receiptPhone } from './receipt.mjs';
import { stableUuid } from './records.mjs';
import { queueSettlementReceipt } from './settle.mjs';
import { loadPaymentSettings } from './settings.mjs';
import { amountFor, TariffError } from '../tariffs/index.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const bookingPaymentId = (bookingId) => stableUuid(`bl.payment/booking/${bookingId}`);

function item(description, amountKopecks, vatCode, paymentMode) {
  return {
    description: description.slice(0, 128),
    quantity: 1,
    amount: { value: formatValue(amountKopecks), currency: 'RUB' },
    vat_code: vatCode,
    payment_mode: paymentMode,
    payment_subject: 'service',
  };
}

async function tableNumber(db, resourceId) {
  const { rows } = await db.query('select number from bl.resources where id = $1', [resourceId]);
  return rows[0]?.number ?? null;
}

export async function createPrepayment(db, deps, config, args) {
  const { clubId, bookingId, resourceId, userId, amountKopecks } = args;
  for (const [k, v] of [['clubId', clubId], ['bookingId', bookingId], ['resourceId', resourceId], ['userId', userId]]) {
    if (!UUID.test(v ?? '')) throw new MoneyError('bad_request', k);
  }
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  const method = args.method ?? 'sbp';
  if (method !== 'sbp' && method !== 'card') throw new MoneyError('bad_request', 'method');
  await enterClub(db, clubId);
  const settings = await loadPaymentSettings(db, clubId);
  if (method === 'sbp' && !settings.sbp) throw new MoneyError('bad_request', 'СБП недоступна');
  if (method === 'card' && !settings.card) throw new MoneyError('bad_request', 'карта недоступна');
  const { rows } = await db.query('select phone from bl.users where id = $1', [userId]);
  const phone = rows[0]?.phone ?? null;
  if (!receiptPhone(phone)) throw new MoneyError('phone_required');
  const number = await tableNumber(db, resourceId);
  if (number === null) throw new MoneyError('not_found', 'стол');
  // Попытки оплаты брони (№116): оплаченная и не зачтённая — already_paid; брошенная (pending) с той же
  // суммой и способом — та же; иначе — новая попытка (старая истечёт в ЮKassa сама; если гость всё же
  // оплатит обе, бронь вернёт лишнюю: forfeitPrepayment с percent 0).
  const { rows: tries } = await db.query(
    `select * from bl.payments where club_id = $1 and booking_id = $2 and kind = 'booking' order by created_at, id`,
    [clubId, bookingId],
  );
  if (tries.some((t) => ['succeeded', 'waiting_for_capture'].includes(t.status) && t.settlement_status === 'open')) {
    throw new MoneyError('already_paid');
  }
  const same = tries.find((t) => t.status === 'pending' && Number(t.amount_kopecks) === amountKopecks && t.method === method);
  const n = tries.length;
  const paymentId = same ? same.id : n === 0 ? bookingPaymentId(bookingId) : stableUuid(`bl.payment/booking/${bookingId}/${n}`);
  const idempotenceKey = same ? same.idempotence_key : n === 0 ? `bk-${bookingId}` : `bk-${bookingId}-${n}`;
  const items = [item(args.description ?? `Предоплата брони, стол ${number}`, amountKopecks, settings.vat_code, 'full_prepayment')];
  const receipt = { customer: { phone: receiptPhone(phone) }, items, ...(settings.tax_system_code != null ? { tax_system_code: settings.tax_system_code } : {}) };
  return createYooKassaPayment(db, deps, config, {
    settings,
    clubId,
    paymentId,
    idempotenceKey,
    requestKey: args.requestKey ?? null,
    kind: 'booking',
    method,
    amountKopecks,
    capture: true,
    receipt,
    confirmation: { type: 'redirect', returnUrl: args.returnUrl ?? returnUrl(config, paymentId) },
    description: `Бронь стола ${number}`,
    metadata: { booking_id: bookingId },
    bookingId,
    resourceId,
    userId,
    phone,
    now: deps.clock.now(),
  });
}

async function lockBookingPayment(db, paymentId) {
  if (!UUID.test(paymentId ?? '')) throw new MoneyError('bad_request', 'paymentId');
  const { rows } = await db.query('select * from bl.payments where id = $1 for update', [paymentId]);
  const p = rows[0];
  if (!p) throw new MoneyError('not_found', 'payment');
  if (p.kind !== 'booking') throw new MoneyError('bad_request', 'не предоплата брони');
  return p;
}

export async function settlePrepayment(db, deps, { paymentId, sessionId = null }) {
  const p = await lockBookingPayment(db, paymentId);
  const now = deps.clock.now();
  if (p.settlement_status === 'settled') {
    const r = await db.query('select id from bl.receipts where settles_payment_id = $1 and payment_id = $1 limit 1', [p.id]);
    return { payment_id: p.id, settled_kopecks: Number(p.settled_kopecks), receipt_id: r.rows[0]?.id ?? null };
  }
  if (p.settlement_status === 'forfeited') throw new MoneyError('bad_request', 'предоплата уже удержана');
  if (p.status !== 'succeeded') throw new MoneyError('payment_pending', `платёж в статусе ${p.status}`);
  if (sessionId !== null && !UUID.test(sessionId)) throw new MoneyError('bad_request', 'sessionId');
  // Возвращённое (частичная отмена) не зачитывается.
  const { rows: rf } = await db.query(
    `select coalesce(sum(amount_kopecks), 0)::bigint as total from bl.refunds where payment_id = $1 and status <> 'canceled'`,
    [p.id],
  );
  const amount = Number(p.amount_kopecks) - Number(rf[0].total);
  await db.query(
    `update bl.payments set settlement_status = 'settled', settled_kopecks = $2, settled_at = $3, updated_at = $3,
            session_id = coalesce(session_id, $4) where id = $1`,
    [p.id, amount, now, sessionId],
  );
  const settings = await loadPaymentSettings(db, p.club_id);
  const number = await tableNumber(db, p.resource_id);
  const receiptId = await queueSettlementReceipt(db, deps, {
    source: p,
    forPaymentId: p.id,
    items: [item(`Игра, стол ${number} (бронь)`, amount, settings.vat_code, 'full_payment')],
    amountKopecks: amount,
    now,
  });
  await deps.audit.appendAudit(db, {
    action: 'payment.settled',
    objectType: 'payment',
    objectId: p.id,
    data: { payment_id: p.id, booking_id: p.booking_id, session_id: sessionId, amount_kopecks: amount, receipt_id: receiptId },
    actorType: 'system',
  });
  return { payment_id: p.id, settled_kopecks: amount, receipt_id: receiptId };
}

/** Удержать percent % и вернуть остальное. refund — функция возврата денежного модуля (api.mjs). */
export async function forfeitPrepayment(db, deps, config, { paymentId, percent = null, reason }, refund) {
  if (typeof reason !== 'string' || reason.trim().length === 0) throw new MoneyError('reason_required');
  const p = await lockBookingPayment(db, paymentId);
  const now = deps.clock.now();
  if (p.settlement_status === 'forfeited') {
    const f = await db.query(`select id, amount_kopecks from bl.refunds where payment_id = $1 and idempotence_key = $2`, [p.id, `bkf-${p.id}`]);
    return { kept_kopecks: Number(p.settled_kopecks), refunded_kopecks: Number(f.rows[0]?.amount_kopecks ?? 0), refund_id: f.rows[0]?.id ?? null };
  }
  if (p.settlement_status === 'settled') throw new MoneyError('bad_request', 'предоплата уже зачтена');
  if (p.status !== 'succeeded') throw new MoneyError('payment_pending', `платёж в статусе ${p.status}`);
  const settings = await loadPaymentSettings(db, p.club_id);
  const pct = percent ?? settings.booking_forfeit_percent ?? 100;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new MoneyError('bad_request', 'percent');
  const amount = Number(p.amount_kopecks);
  const kept = Math.floor((amount * pct * 2 + 100) / 200); // «половина вверх»
  const back = amount - kept;
  const number = await tableNumber(db, p.resource_id);
  let refundId = null;
  if (back > 0) {
    const r = await refund(
      db,
      {
        paymentId: p.id,
        amountKopecks: back,
        reason,
        key: `bkf-${p.id}`,
        items: [item(`Предоплата брони, стол ${number}`, back, settings.vat_code, 'full_prepayment')],
        description: `Возврат предоплаты брони, стол ${number}`,
      },
      { deps, config },
    );
    refundId = r.refund_id;
  }
  await db.query(
    `update bl.payments set settlement_status = 'forfeited', settled_kopecks = $2, settled_at = $3, updated_at = $3 where id = $1`,
    [p.id, kept, now],
  );
  if (kept > 0) {
    await queueSettlementReceipt(db, deps, {
      source: p,
      forPaymentId: p.id,
      items: [item(`Бронь стола ${number}: удержание по правилам клуба`, kept, settings.vat_code, 'full_payment')],
      amountKopecks: kept,
      now,
    });
  }
  await deps.audit.appendAudit(db, {
    action: 'payment.forfeited',
    objectType: 'payment',
    objectId: p.id,
    reason,
    data: { payment_id: p.id, booking_id: p.booking_id, percent: pct, kept_kopecks: kept, refunded_kopecks: back, refund_id: refundId },
    actorType: 'system',
  });
  return { kept_kopecks: kept, refunded_kopecks: back, refund_id: refundId };
}

/**
 * Котировка старта по брони (№113, №116): доплата за ранний приход, остаток при частичной
 * предоплате, бронь без предоплаты (с прихода до конца брони). Сумму считает бронь, но money
 * сверяет её тарифом за [from, from + minutes] и не берёт больше тарифа. Оплата — обычный
 * POST /api/quotes/{id}/pay (СБП или карта) → payment.confirmed {kind: 'booking_start', quote_id, booking_id}.
 * @returns {{ quote_id, amount_kopecks, minutes, valid_until, tariff_kopecks, early_minutes }}
 */
export async function createBookingQuote(db, deps, args) {
  const { clubId, bookingId, resourceId, userId, minutes, amountKopecks } = args;
  for (const [k, v] of [['clubId', clubId], ['bookingId', bookingId], ['resourceId', resourceId], ['userId', userId]]) {
    if (!UUID.test(v ?? '')) throw new MoneyError('bad_request', k);
  }
  const from = new Date(args.from);
  if (!Number.isFinite(from.getTime())) throw new MoneyError('bad_request', 'from');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new MoneyError('bad_request', 'minutes');
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0) throw new MoneyError('bad_request', 'amountKopecks');
  const early = args.earlyMinutes ?? 0;
  if (!Number.isInteger(early) || early < 0 || early > minutes) throw new MoneyError('bad_request', 'earlyMinutes');
  await enterClub(db, clubId);
  let tariff;
  try {
    tariff = await amountFor(db, { resourceId, from, minutes, minimum: false, exact: true });
  } catch (err) {
    if (err instanceof TariffError) throw new MoneyError(err.code === 'no_tariff' ? 'no_tariff' : 'not_found', err.message);
    throw err;
  }
  // Клиенту (и соседу) не верим: больше тарифа за это время не берём.
  const amount = Math.min(amountKopecks, tariff.amount_kopecks);
  if (amount <= 0) throw new MoneyError('bad_request', 'нечего оплачивать');
  if (amount < amountKopecks) deps.log?.warn?.('booking_quote_capped', { booking_id: bookingId, asked_kopecks: amountKopecks, tariff_kopecks: tariff.amount_kopecks });
  const now = deps.clock.now();
  const validUntil = new Date(now.getTime() + 3 * 60_000);
  const { rows } = await db.query(
    `insert into bl.quotes (club_id, resource_id, user_id, kind, booking_id, unlimited, minutes, from_at, amount_kopecks, breakdown, created_at, valid_until)
     values ($1, $2, $3, 'booking_start', $4, false, $5, $6, $7, $8::jsonb, $9, $10) returning id`,
    [clubId, resourceId, userId, bookingId, minutes, from, amount, JSON.stringify(amount === tariff.amount_kopecks ? tariff.breakdown : []), now, validUntil],
  );
  return {
    quote_id: rows[0].id,
    amount_kopecks: amount,
    minutes,
    valid_until: validUntil.toISOString(),
    tariff_kopecks: tariff.amount_kopecks,
    early_minutes: early,
  };
}
