import { plural } from '@billiardum/shared/format';

/**
 * Бар со стола для гостя (контракт m2 §4, решения №76, №79): что можно делать с заказом и счётом стола.
 * Логика без JSX — проверяется node --test.
 */

/** Шаги заказа для гостя по порядку — настоящая последовательность, поэтому показываем как шкалу. */
export const ORDER_STEPS = ['new', 'preparing', 'ready', 'served'];

/** Номер шага заказа: 0…3; отменённый — -1. */
export function stepIndex(status) {
  return ORDER_STEPS.indexOf(status);
}

/** Заказывать к столу можно, пока игра идёт (сервер: active, ending, grace). После игры — только оплатить счёт. */
export function canOrder(session) {
  return ['active', 'ending', 'grace'].includes(session?.status);
}

/**
 * Счёт стола из `GET /api/sessions/{id}/tab`: { orders, total_kopecks, pending_payment }.
 * @returns {{ total: number, count: number, pending: boolean, open: boolean }}
 */
export function tabSummary(tab) {
  const total = Number.isSafeInteger(tab?.total_kopecks) ? tab.total_kopecks : 0;
  const count = Array.isArray(tab?.orders) ? tab.orders.length : 0;
  return { total, count, pending: Boolean(tab?.pending_payment), open: total > 0 };
}

/** «2 заказа» */
export function ordersWord(n) {
  return `${n} ${plural(n, ['заказ', 'заказа', 'заказов'])}`;
}

/** «3 позиции» */
export function itemsWord(n) {
  return `${n} ${plural(n, ['позиция', 'позиции', 'позиций'])}`;
}

/**
 * Заказы гостя для экрана: сначала текущие (не выданные), затем выданные; отменённые — в конце.
 * Онлайн-заказ, который ждёт оплаты, тоже текущий: гость должен видеть, что он не дошёл до бара.
 */
export function sortGuestOrders(orders) {
  const rank = (o) => (o.status === 'canceled' ? 3 : o.status === 'served' ? 2 : 1);
  return [...(orders ?? [])].sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)));
}

/** Текущий заказ для полосы на экране «Игра»: самый свежий не выданный и не отменённый. */
export function currentOrder(orders) {
  return sortGuestOrders(orders).find((o) => ['new', 'preparing', 'ready'].includes(o.status)) ?? null;
}

/**
 * Кнопка заказа говорит, что произойдёт.
 * @param {'tab' | 'online'} pay
 * @param {string} amount «840 ₽»
 */
export function orderCta(pay, amount) {
  return pay === 'tab' ? `Заказать за ${amount} в счёт стола` : `Оплатить ${amount} и заказать`;
}
