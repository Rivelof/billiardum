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
// * packageLine     → packageSaleLine: позиция чека пакета часов (предоплата 100 %) и цена (M3).
// * revokePackage   → revokeLotOnly: отозвать нетронутую партию минут пакета при возврате продажи
//   (№118; деньги и чек возврата — refundPayment, как у бара); package_used, already_refunded — 409.
// * onlineAvailable → onlineMethodAvailable: доступен ли клубу способ онлайн-оплаты (sbp, card) —
//   до поиска гостя пакета (pentester L1-R2). Пока функции у money нет — те же флаги настроек
//   клуба, что проверяет createOnlinePayment (loadPaymentSettings: sbp, card).
// * creditPackage   → creditPackageForSale: начислить минуты пакета гостю после оплаты продажи;
//   повтор (тот же платёж, пакет и номер в продаже) — та же партия минут.
// id платежа и ключ ЮKassa детерминированы по продаже: stableUuid('bl.payment/bar/<sale>'), bar-<sale>.

import * as moneyApi from '../payments/api.mjs';
import { createOnlinePayment, creditPackageForSale, packageSaleLine, recordOfflinePayment, refund, revokeLotOnly } from '../payments/api.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';

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

/**
 * Пакет часов в корзине кассы: позиция чека и цена (money; пакет — активный, этого клуба под RLS).
 * @returns {Promise<{ line: object, amount_kopecks: number, package: object }>}
 */
export function packageLine(db, packageId) {
  return packageSaleLine(db, { packageId });
}

/**
 * Начислить пакет гостю по оплаченному платежу продажи (строка bl.payments).
 * @returns {Promise<object>} партия минут bl.balance_lots
 */
export function creditPackage(db, deps, { payment, packageId, userId, index }) {
  return creditPackageForSale(db, { payment, packageId, userId, index }, injected(deps));
}

/**
 * Отозвать партию минут пакета (возврат пакета на кассе, №118): целиком и только нетронутую.
 * Журнал manual.package_refund и тревога — у money. Деньги не возвращает.
 * @returns {Promise<{ lot_id: string, payment_id: string, amount_kopecks: number }>}
 */
export function revokePackage(db, deps, { lotId, reason, staffId }) {
  return revokeLotOnly(db, { lotId, reason, staffId }, injected(deps));
}

/**
 * Способ онлайн-оплаты доступен клубу (магазин ЮKassa есть, способ включён).
 * @returns {Promise<boolean>}
 */
export async function onlineAvailable(db, { clubId, method }) {
  if (typeof moneyApi.onlineMethodAvailable === 'function') return Boolean(await moneyApi.onlineMethodAvailable(db, { clubId, method }));
  const settings = await loadPaymentSettings(db, clubId);
  if (method === 'sbp') return Boolean(settings.sbp);
  if (method === 'card') return Boolean(settings.card);
  return false;
}
