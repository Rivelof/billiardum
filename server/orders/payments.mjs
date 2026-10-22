// Платежи бара — функции money M1/M2 (server/payments/api.mjs), без прямой записи в bl.payments:
//
// * offlinePayment  → recordOfflinePayment: наличные или терминал на кассе (kind bar), сразу succeeded.
// * onlinePayment   → createOnlinePayment: СБП или карта ЮKassa с чеком 54-ФЗ позициями бара;
//   гостю — confirmation redirect, кассе — confirmation qr (QR на экране ресепшена, контракт M2 §5).
//   Подтверждение — общий путь money: вебхук или сверка → outbox payment.confirmed (kind bar),
//   отказ → outbox payment.canceled; модуль заказов завершает или отменяет продажу (settleSale).
// * refundPayment   → refund money с позициями чека возврата (сумма позиций = сумме возврата):
//   наличные и терминал — возврат manual и чек возврата ККТ (receipt_pending), ЮKassa — возврат
//   с чеком; журнал payment.refunded, outbox payment.refunded и уведомление — у money.
// id платежа и ключ ЮKassa детерминированы по продаже: stableUuid('bl.payment/bar/<sale>'), bar-<sale>.

import { createOnlinePayment, recordOfflinePayment, refund } from '../payments/api.mjs';

/** Зависимости money для её функций: из контекста запроса или модуля (не из окружения процесса). */
const injected = (deps) => ({ deps: deps.money, config: deps.moneyConfig });

/** Контакт покупателя для чека ЮKassa: телефон без «+» или почта. */
export function receiptCustomer({ phone = null, email = null }) {
  if (typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone)) return { phone: phone.slice(1) };
  if (typeof email === 'string' && email.length > 3) return { email };
  return null;
}

/** Наличные или терминал: строка bl.payments через money. */
export function offlinePayment(db, deps, { clubId, saleId, method, amount, received = null, staffId, requestKey = null }) {
  return recordOfflinePayment(db, {
    clubId,
    saleId,
    method,
    amountKopecks: amount,
    ...(method === 'cash' ? { receivedKopecks: received } : {}),
    staffId,
    requestKey,
  }, injected(deps));
}

/**
 * СБП или карта ЮKassa через money.
 * @returns {Promise<{ payment: object, confirmation: object|null }>}
 */
export function onlinePayment(db, deps, p) {
  return createOnlinePayment(db, {
    clubId: p.clubId,
    saleId: p.saleId,
    method: p.method,
    amountKopecks: p.amount,
    items: p.lines,
    customer: p.customer,
    confirmation: p.confirmation,
    returnUrl: p.returnUrl,
    description: p.description,
    phone: p.phone ?? null,
    userId: p.userId ?? null,
    resourceId: p.resourceId ?? null,
    requestKey: p.requestKey ?? null,
  }, injected(deps));
}

/**
 * Возврат через money с позициями чека возврата.
 * @returns {Promise<{ refund_id: string, status: string, amount_kopecks: number }>}
 */
export function refundPayment(db, deps, { paymentId, amount, lines, customer = null, reason, key, staffId = null, description }) {
  return refund(db, {
    paymentId,
    amountKopecks: amount,
    reason,
    key,
    items: lines,
    ...(customer ? { customer } : {}),
    requestedBy: staffId,
    description,
  }, injected(deps));
}
