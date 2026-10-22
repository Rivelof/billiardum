import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { PID, MOD } from '../src/mock/m2.js';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

test('заглушка кассы: продажа бара, счёта и заявки наличными, чек ККТ, склад и смена (как backend-pos)', async () => {
  let now = Date.parse('2026-10-22T15:00:00Z');
  const b = createBackend(memory(), () => now);
  b.scenario('pos');
  const tabs = (await req(b, 'GET', '/api/clubs/c/tabs')).body;
  const t1 = tabs.find((t) => t.resource.number === 1);
  assert.ok(t1 && t1.orders === 2 && Number.isSafeInteger(t1.total_kopecks));
  const reqs = (await req(b, 'GET', '/api/clubs/c/reception/requests')).body;
  const shiftBefore = (await req(b, 'GET', '/api/clubs/c/shifts/current')).body.shift;
  const colaBefore = b.state.m2.catalog.products.find((p) => p.id === PID['Кола, 0,33 л']).stock_qty;

  const body = {
    method: 'cash',
    items: [{ product_id: PID['Кола, 0,33 л'], qty: 1, modifier_ids: [] }, { product_id: PID['Американо'], qty: 2, modifier_ids: [MOD['0,4 л']] }],
    tabs: [t1.session_id],
    requests: [reqs[0].id],
    received_kopecks: 1_000_000,
    to_bar: true,
  };
  const sale = (await req(b, 'POST', '/api/pos/sales', body)).body;
  const bar = 15000 + 2 * 22000 + t1.total_kopecks;
  assert.equal(sale.status, 'completed');
  assert.equal(sale.bar_kopecks, bar);
  assert.equal(sale.table_kopecks, reqs[0].amount_kopecks);
  assert.equal(sale.change_kopecks, 1_000_000 - bar - reqs[0].amount_kopecks);
  assert.equal(sale.receipt_status, 'receipt_pending');
  assert.equal(b.state.m2.catalog.products.find((p) => p.id === PID['Кола, 0,33 л']).stock_qty, colaBefore - 1, 'склад уменьшился');
  assert.ok(!(await req(b, 'GET', '/api/clubs/c/tabs')).body.some((t) => t.session_id === t1.session_id), 'счёт стола закрыт');
  const shiftAfter = (await req(b, 'GET', '/api/clubs/c/shifts/current')).body.shift;
  assert.equal(shiftAfter.expected_cash_kopecks - shiftBefore.expected_cash_kopecks, sale.total_kopecks);
  now += 3000;
  assert.equal((await req(b, 'GET', `/api/pos/sales/${sale.sale_id}`)).body.receipt_status, 'printed');
  assert.ok((await req(b, 'GET', '/api/clubs/c/bar/queue')).body.some((o) => o.sale_id === sale.sale_id && o.source === 'pos'), 'заказ кассы на экране бара');
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', tabs: [t1.session_id] })).body.error, 'already_paid');
});

test('заглушка кассы: СБП — QR и оплата позже, заявку по СБП нельзя, скидка выше лимита — управляющий или подтверждение', async () => {
  let now = Date.parse('2026-10-22T15:00:00Z');
  const b = createBackend(memory(), () => now);
  b.scenario('pos');
  const sbp = (await req(b, 'POST', '/api/pos/sales', { method: 'sbp', items: [{ product_id: PID['Сэндвич с курицей'], qty: 1 }] })).body;
  assert.equal(sbp.status, 'pending');
  assert.equal(sbp.confirmation.type, 'qr');
  assert.match(sbp.confirmation.confirmation_data, /^https:\/\/qr\.nspk\.ru\//);
  now += 10_000;
  const later = (await req(b, 'GET', `/api/pos/sales/${sbp.sale_id}`)).body;
  assert.equal(later.status, 'completed');
  assert.equal(later.confirmation, undefined);
  const reqs = (await req(b, 'GET', '/api/clubs/c/reception/requests')).body;
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'sbp', requests: [reqs[0].id] })).status, 400, 'заявку стола принимает money: наличные и терминал');

  const pizza = { product_id: PID['Пицца «Маргарита»'], qty: 1 };
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza], discount: { percent: 10 } })).body.status, 'completed', '10 % — в пределах лимита');
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza], discount: { percent: 20, reason: 'x' } })).body.error, 'limit_exceeded', 'ресепшну выше лимита нельзя');
  const managers = (await req(b, 'GET', '/api/clubs/c/staff/approvers')).body;
  assert.equal((await req(b, 'POST', '/api/pos/discount-approvals', { user_id: managers[0].user_id, pin: '0000', discount_kopecks: 11800, reason_code: 'promo', reason_text: 'Акция' })).body.error, 'pin_invalid');
  const ok = (await req(b, 'POST', '/api/pos/discount-approvals', { user_id: managers[0].user_id, pin: '1234', discount_kopecks: 11800, base_kopecks: 59000, reason_code: 'promo', reason_text: 'Акция' })).body;
  const sale = (await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza], discount: { percent: 20, reason: 'Акция', approval_id: ok.approval_id } })).body;
  assert.equal(sale.discount_kopecks, 11800);
  assert.equal(b.state.alarms[0].type, 'discount_over_limit', 'тревога владельцу');
  b.scenario('manager');
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza], discount: { percent: 30 } })).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza], discount: { percent: 100, reason: 'x' } })).status, 400, 'не на всю сумму');
  b.scenario('noshift');
  assert.equal((await req(b, 'POST', '/api/pos/sales', { method: 'card_terminal', items: [pizza] })).body.error, 'shift_closed', 'без смены касса не продаёт ничем');
});

test('заглушка бара и смен: статусы вперёд, закрытие с недостачей — тревога, отчёт сходится до копейки, мост ККТ', async () => {
  const b = createBackend(memory());
  b.scenario('pos');
  const queue = (await req(b, 'GET', '/api/clubs/c/bar/queue')).body;
  const fresh = queue.find((o) => o.status === 'new');
  assert.ok(fresh.resource.number && fresh.subtotal_kopecks && fresh.pay_mode);
  assert.equal((await req(b, 'POST', `/api/orders/${fresh.id}/status`, { status: 'preparing' })).body.status, 'preparing');
  assert.equal((await req(b, 'POST', `/api/orders/${fresh.id}/status`, { status: 'served' })).body.status, 'served', 'можно пропускать шаги');
  assert.equal((await req(b, 'POST', `/api/orders/${fresh.id}/status`, { status: 'ready' })).body.error, 'order_closed');

  const cur = (await req(b, 'GET', '/api/clubs/c/shifts/current')).body.shift;
  const closed = (await req(b, 'POST', `/api/shifts/${cur.id}/close`, { actual_cash_kopecks: cur.expected_cash_kopecks - 50000 })).body;
  assert.equal(closed.discrepancy_kopecks, -50000);
  assert.equal(b.state.alarms[0].type, 'shift_discrepancy');
  assert.equal((await req(b, 'GET', '/api/clubs/c/shifts/current')).body.shift, null);
  assert.equal((await req(b, 'POST', '/api/clubs/c/shifts', { float_kopecks: 300000 })).body.float_kopecks, 300000);
  assert.equal((await req(b, 'POST', '/api/clubs/c/shifts', { float_kopecks: 300000 })).body.error, 'shift_open');

  b.scenario('owner');
  const list = (await req(b, 'GET', '/api/clubs/c/shifts')).body.items;
  const r = (await req(b, 'GET', `/api/shifts/${list[1].id}/report`)).body;
  const sum = (o) => Object.values(o).reduce((a, v) => a + v, 0);
  assert.equal(r.revenue.total_kopecks, sum(r.revenue.tables.by_method) + sum(r.revenue.bar.by_method));
  assert.equal(r.reconciliation.kkt.system_kopecks, r.revenue.by_method.cash + r.revenue.by_method.card_terminal);
  assert.equal(r.reconciliation.kkt.ok, true);
  assert.equal(r.cash.discrepancy_kopecks, -50000);

  const reg = (await req(b, 'POST', '/api/clubs/c/kkt/bridges', { name: 'ПК ресепшена 2' })).body;
  assert.match(reg.token, /^[A-Za-z0-9_-]{40,128}$/, 'формат токена как у tools/kkt-bridge');
  assert.equal(reg.bridge.online, false);
  assert.equal((await req(b, 'POST', `/api/kkt/bridges/${reg.bridge.id}/revoke`)).body.revoked_at !== null, true);
  b.scenario('reception');
  assert.equal((await req(b, 'POST', '/api/clubs/c/kkt/bridges', { name: 'x' })).body.error, 'forbidden', 'мост ККТ — только владелец');
});
