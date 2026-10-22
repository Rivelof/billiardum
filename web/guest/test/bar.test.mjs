import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOrder, currentOrder, itemsWord, orderCta, ordersWord, sortGuestOrders, stepIndex, tabSummary } from '../src/lib/bar.js';

test('заказывать к столу можно только во время игры, счёт — и после', () => {
  assert.equal(canOrder({ status: 'active' }), true);
  assert.equal(canOrder({ status: 'grace' }), true);
  assert.equal(canOrder({ status: 'closed' }), false);
  assert.equal(canOrder({ status: 'interrupted' }), false);
  assert.equal(canOrder(null), false);
});

test('счёт стола: сумма, число заказов, идущая оплата', () => {
  assert.deepEqual(tabSummary({ orders: [{}, {}], total_kopecks: 136000, pending_payment: null }), { total: 136000, count: 2, pending: false, open: true });
  assert.deepEqual(tabSummary({ orders: [], total_kopecks: 0, pending_payment: { sale_id: 's' } }), { total: 0, count: 0, pending: true, open: false });
  assert.equal(tabSummary(null).open, false);
});

test('заказы гостя: текущие сверху, выданные и отменённые ниже', () => {
  const list = [
    { id: 'a', status: 'served', created_at: '2026-10-22T10:00:00Z' },
    { id: 'b', status: 'canceled', created_at: '2026-10-22T11:00:00Z' },
    { id: 'c', status: 'preparing', created_at: '2026-10-22T10:30:00Z' },
    { id: 'd', status: 'new', created_at: '2026-10-22T10:40:00Z' },
  ];
  assert.deepEqual(sortGuestOrders(list).map((o) => o.id), ['d', 'c', 'a', 'b']);
  assert.equal(currentOrder(list).id, 'd');
  assert.equal(currentOrder([{ status: 'served' }]), null);
  assert.equal(stepIndex('ready'), 2);
  assert.equal(stepIndex('canceled'), -1);
});

test('слова и кнопки', () => {
  assert.equal(ordersWord(1), '1 заказ');
  assert.equal(ordersWord(3), '3 заказа');
  assert.equal(itemsWord(5), '5 позиций');
  assert.equal(orderCta('tab', '840 ₽'), 'Заказать за 840 ₽ в счёт стола');
  assert.equal(orderCta('online', '840 ₽'), 'Оплатить 840 ₽ и заказать');
});
