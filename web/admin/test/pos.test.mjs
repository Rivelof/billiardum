import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFixed, addProduct, emptyCart, normalizeMenu } from '@billiardum/shared/bar';
import { discountBase, discountKopecks, discountPercent, kktState, normalizeSale, overLimit, receiptView, requestLine, saleBody, saleTotals, tabLine, wholeDiscount } from '../src/lib/pos.js';
import { errorMessage } from '@billiardum/shared/errors';

const menu = normalizeMenu({
  categories: [{ id: 'c', name: 'Кофе', products: [
    { id: 'p-amer', name: 'Американо', price_kopecks: 18000, available: true, stop_list: false, modifier_groups: [{ id: 'g', name: 'Объём', min_select: 1, max_select: 1, modifiers: [{ id: 'm3', name: '0,3 л', price_delta_kopecks: 0, is_default: true }, { id: 'm4', name: '0,4 л', price_delta_kopecks: 4000 }] }] },
    { id: 'p-cola', name: 'Кола', price_kopecks: 15000, available: true, stop_list: false, modifier_groups: [] },
  ] }],
});

function cart() {
  let c = emptyCart();
  c = addProduct(c, menu.byId.get('p-amer'), ['m4'], 2); // 2 × 220 ₽
  c = addProduct(c, menu.byId.get('p-cola'), []); // 150 ₽
  c = addFixed(c, requestLine({ id: 'r1', resource_number: 4, minutes: 120, amount_kopecks: 160000 }));
  c = addFixed(c, tabLine({ session_id: 's3', resource: { id: 'x', number: 3 }, orders: 2, total_kopecks: 44000 }));
  return c;
}

test('скидка действует на бар (товары и счёт стола), не на время стола', () => {
  const c = cart();
  assert.equal(discountBase(c), 44000 + 15000 + 44000);
  const t = saleTotals(c, { type: 'percent', value: 10 });
  assert.deepEqual(t, { count: 5, subtotal: 263000, base: 103000, discount: 10300, total: 252700 });
});

test('процент — целый, округление «половина вверх» до копейки, как у сервера (server/orders/money.mjs)', () => {
  assert.equal(discountKopecks(33333, { type: 'percent', value: 10 }), 3333);
  assert.equal(discountKopecks(33335, { type: 'percent', value: 10 }), 3334, '3333,5 → 3334');
  assert.equal(discountKopecks(100000, { type: 'percent', value: 12.5 }), 0, 'дробный процент сервер не примет');
  assert.equal(discountKopecks(100000, { type: 'percent', value: 0 }), 0);
  assert.equal(discountKopecks(100000, { type: 'amount', kopecks: 30000 }), 30000);
  assert.equal(discountKopecks(100000, { type: 'amount', kopecks: 300000 }), 100000, 'не больше базы');
  assert.equal(discountKopecks(0, { type: 'percent', value: 10 }), 0);
  assert.equal(wholeDiscount(100000, 100000), true, 'скидку на всю сумму сервер не принимает');
  assert.equal(discountPercent(103000, 10300), 10);
  assert.equal(discountPercent(80000, 10000), 12.5);
});

test('лимит скидки ресепшена: ровно лимит — можно, больше — управляющий с причиной (№82)', () => {
  assert.equal(overLimit(100000, 10000, 10), false, 'ровно 10 % — в пределах');
  assert.equal(overLimit(100000, 10001, 10), true);
  assert.equal(overLimit(103000, 10300, 10), false);
  assert.equal(overLimit(0, 100, 10), false);
  assert.equal(overLimit(100000, 15000, 20), false, 'свой лимит клуба');
});

test('тело продажи по backend-pos: items, tabs, requests, discount с причиной, наличные', () => {
  const body = saleBody(cart(), { method: 'cash', receivedKopecks: 300000, toBar: true, discount: { type: 'percent', value: 15 }, reason: { code: 'regular_guest', text: 'Постоянный гость' } });
  assert.deepEqual(body.items, [{ product_id: 'p-amer', qty: 2, modifier_ids: ['m4'] }, { product_id: 'p-cola', qty: 1, modifier_ids: [] }]);
  assert.deepEqual(body.tabs, ['s3']);
  assert.deepEqual(body.requests, ['r1']);
  assert.deepEqual(body.discount, { percent: 15, reason: 'Постоянный гость', reason_code: 'regular_guest' });
  assert.equal(body.received_kopecks, 300000);
  assert.equal(body.to_bar, true);
  const card = saleBody(cart(), { method: 'card_terminal', discount: { type: 'amount', kopecks: 5000 }, approval: { approval_id: 'a1' } });
  assert.deepEqual(card.discount, { amount_kopecks: 5000, approval_id: 'a1' });
  assert.equal('received_kopecks' in card, false);
  const noBar = saleBody(addFixed(emptyCart(), requestLine({ id: 'r9', resource_number: 2, minutes: 60, amount_kopecks: 80000 })), { method: 'cash', receivedKopecks: 100000, toBar: true });
  assert.equal(noBar.to_bar, false, 'без товаров на экран бара нечего передавать');
  assert.equal('discount' in noBar, false);
});

test('ответ продажи и состояние кассы ККТ — в один вид', () => {
  const s = normalizeSale({ sale_id: 'x', status: 'completed', method: 'cash', change_kopecks: 4000, receipt_status: 'receipt_pending', receipt_id: 'r', table_payments: [{ request_id: 'r1' }] });
  assert.equal(s.id, 'x');
  assert.equal(s.paid, true);
  assert.equal(s.hasTable, true);
  assert.deepEqual(s.receipt, { status: 'receipt_pending', receipt_id: 'r', fd: null, fp: null });
  const q = normalizeSale({ sale_id: 'y', status: 'pending', method: 'sbp', confirmation: { type: 'qr', confirmation_data: 'https://qr.nspk.ru/x' } });
  assert.equal(q.pending, true);
  assert.equal(q.confirmation.confirmation_data, 'https://qr.nspk.ru/x');
  assert.deepEqual(kktState({ state: 'offline', reason: 'no_bridge', queue: { pending: 2, failed: 0 } }), { known: true, online: false, warning: false, pending: 2, failed: 0, reason: 'no_bridge' });
  assert.equal(kktState({ state: 'warning', queue: { pending: 0, failed: 1 } }).warning, true);
  assert.equal(kktState(null).known, false);
});

test('чек ККТ словами: пробит, в очереди при кассе не на связи, СБП — ЮKassa', () => {
  assert.equal(receiptView({ status: 'printed', fd: '4812', fp: '1234567890' }, true, 'cash').text, 'ФД № 4812, ФП 1234567890.');
  assert.equal(receiptView({ status: 'receipt_pending' }, false, 'cash').title, 'Касса не на связи, чек пробьётся позже');
  assert.equal(receiptView({ status: 'receipt_pending' }, true, 'card_terminal').tone, 'wait');
  assert.equal(receiptView({ status: 'failed' }, true, 'cash').tone, 'warn');
  assert.equal(receiptView(null, true, 'sbp').title, 'Чек отправит ЮKassa');
});

test('ошибки кассы для персонала: смена закрыта, стоп-лист, уже оплачено', () => {
  assert.match(errorMessage('shift_closed', { audience: 'staff' }).text, /Откройте смену/);
  assert.match(errorMessage('stop_list', { audience: 'staff' }).title, /стоп-листе/);
  assert.match(errorMessage('already_paid', { audience: 'staff' }).title, /уже оплачен/);
  assert.match(errorMessage('phone_required', { audience: 'staff' }).title, /телефон гостя/);
  assert.match(errorMessage('approval_unavailable', { audience: 'staff' }).action, /провести эту продажу самому/);
});
