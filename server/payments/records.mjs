// Общие записи денежного модуля: детерминированные id, событие payment.confirmed, строки чеков,
// сессия платежа. Используются оплатой, ресепшеном, списанием заморозки и возвратами.

import { createHash } from 'node:crypto';

/** Детерминированный UUID из строки (id платежа повторяется при повторе запроса). */
export function stableUuid(text) {
  const h = createHash('sha256').update(text).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Сессия платежа: своя колонка (продление) или связь light (bl.session_payments). */
export async function sessionIdOf(db, payment) {
  if (payment.session_id) return payment.session_id;
  const { rows } = await db.query('select session_id from bl.session_payments where payment_id = $1', [payment.id]);
  return rows[0]?.session_id ?? null;
}

/** Событие outbox payment.confirmed (контракт §13). */
export function confirmedPayload(p) {
  return {
    payment_id: p.id,
    club_id: p.club_id,
    quote_id: p.quote_id,
    kind: p.kind,
    session_id: p.session_id ?? null,
    resource_id: p.resource_id,
    user_id: p.user_id,
    minutes: p.minutes,
    unlimited: p.unlimited,
    amount_kopecks: Number(p.amount_kopecks),
    method: p.method,
    // M3: бронь, пакет часов, часть минут балансом, депозит наличными.
    booking_id: p.booking_id ?? null,
    package_id: p.package_id ?? null,
    balance_minutes: p.balance_minutes ?? 0,
    deposit: Boolean(p.deposit),
  };
}

/** Строка чека (продажа или возврат). */
export async function insertReceipt(db, { clubId, paymentId = null, refundId = null, kind = 'sale', channel, status, amountKopecks, items, taxSystemCode = null, userId = null, phone = null, now }) {
  const { rows } = await db.query(
    `insert into bl.receipts (club_id, payment_id, refund_id, kind, channel, status, amount_kopecks, items, tax_system_code,
                              customer_user_id, customer_phone, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $12)
     returning id`,
    [clubId, paymentId, refundId, kind, channel, status, amountKopecks, JSON.stringify(items), taxSystemCode, userId, phone, now],
  );
  return rows[0].id;
}

/** Телефон покупателя из чека продажи платежа (для чека списания и возврата). */
export async function receiptPhoneOf(db, paymentId) {
  const { rows } = await db.query(
    `select customer_phone from bl.receipts where payment_id = $1 and kind = 'sale' and customer_phone is not null
      order by created_at limit 1`,
    [paymentId],
  );
  return rows[0]?.customer_phone ?? null;
}

