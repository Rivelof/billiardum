// T17. Повторный вебхук ЮKassa на тот же платёж: одна оплата, одна сессия / один заказ, один чек.
//
// Эмулятор ЮKassa: «Оплатить» (вебхук) и сразу же /__emu/payments/{id}/webhook?repeat=10 —
// десять одновременных повторов, гонка с первым вебхуком. Затем ещё 5 повторов после обработки.
// Три платежа: A — заказ бара онлайн со стола (СБП), B — старт игры на столе (СБП),
// C — продажа бара на кассе по QR СБП (нужна своя смена).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditFor,
  CLUB_A,
  closeMyShift,
  emu,
  emuSucceed,
  newGuest,
  ok,
  openMyShift,
  P,
  pay,
  posSale,
  providerId,
  quote,
  rub,
  sleep,
  staff,
  startGame,
  table,
  waitPaymentSession,
  waitSale,
  waitTableFree,
  ykId,
  ensureStock,
  serveOrders,
} from './helpers.mjs';

const TABLE_A = Number(process.env.E2E_T17_TABLE || 5);
const TABLE_B = Number(process.env.E2E_T17_TABLE_B || 6);
let db;
let rec;
let man;
let shift;
let gameA;
let gameB;
const posSales = [];

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
});

after(async () => {
  const served = await serveOrders(db, rec.token, { saleIds: posSales, sessionIds: [gameA?.sessionId] }).catch(() => 0);
  console.log(`# заказы теста убраны с экрана бара («выдан»): ${served}`);
  for (const g of [gameA, gameB]) if (g?.sessionId) await api('POST', `/api/sessions/${g.sessionId}/stop`, { token: g.guest.token, body: {} }).catch(() => {});
  if (shift) {
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e T17' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно, расхождение ${closed.discrepancy_kopecks}`);
  }
  await db?.end();
});

/** «Оплатить» без ожидания и сразу 10 одновременных повторов, потом ещё 5. */
function hammer(pid) {
  emuSucceed(pid, { wait: false });
  const r1 = emu(`/__emu/payments/${pid}/webhook?repeat=10`, { post: true });
  return r1;
}

async function paymentFacts(pid) {
  const { rows: pays } = await db.query('select id, kind, status, amount_kopecks, session_id, confirmed_at from bl.payments where provider_payment_id = $1', [pid]);
  const p = pays[0];
  const { rows: rc } = await db.query("select id, kind, channel, status from bl.receipts where payment_id = $1 and kind = 'sale'", [p.id]);
  const succ = await auditFor(db, p.id, ['payment.succeeded']);
  const hooks = emu('/__emu/webhooks').filter((w) => (w.object_id ?? w.objectId ?? w.payment_id ?? w.body?.object?.id) === pid);
  return { pays, p, rc, succ, hooks };
}

test(`T17: заказ бара онлайн (стол ${TABLE_A}) — повторные вебхуки: один платёж, один заказ, один чек`, async (t) => {
  await waitTableFree(TABLE_A);
  gameA = await startGame(TABLE_A, 20);
  const r = await api('POST', '/api/orders', { token: gameA.guest.token, idem: true, body: { session_id: gameA.sessionId, items: [{ product_id: P.chips, qty: 1 }, { product_id: P.waterSpark, qty: 1 }], pay: 'online', method: 'sbp' } });
  assert.equal(r.status, 201, r.text);
  const pid = ykId(r.json.payment.confirmation);
  const stock0 = (await db.query("select count(*)::int as n from bl.stock_movements m join bl.order_items oi on oi.id = m.order_item_id where oi.order_id = $1 and m.kind = 'sale'", [r.json.order.id])).rows[0].n;
  const h = hammer(pid);
  t.diagnostic(`заказ №${r.json.order.number} ${rub(r.json.order.subtotal_kopecks)}: «Оплатить» + 10 одновременных повторов → ${JSON.stringify(h.deliveries?.map((d) => d.delivered))}`);
  await waitSale(rec.token, r.json.payment.sale_id);
  const h2 = emu(`/__emu/payments/${pid}/webhook?repeat=5`, { post: true });
  await sleep(1500);
  const f = await paymentFacts(pid);
  const { rows: orders } = await db.query('select id, status, paid_at, sale_id, committed_at from bl.orders where payment_id = $1', [f.p.id]);
  const { rows: sales } = await db.query('select id, status from bl.pos_sales where payment_id = $1', [f.p.id]);
  const { rows: mv } = await db.query("select count(*)::int as n from bl.stock_movements m join bl.order_items oi on oi.id = m.order_item_id where oi.order_id = $1 and m.kind = 'sale'", [r.json.order.id]);
  const posAudit = await auditFor(db, sales[0].id, ['pos.sale']);
  t.diagnostic(`ещё 5 повторов → ${JSON.stringify(h2.deliveries?.map((d) => d.delivered))}; доставок вебхука по платежу в эмуляторе: ${f.hooks.length}`);
  t.diagnostic(`платежей ${f.pays.length} (${f.p.status}); заказов ${orders.length} (paid ${orders.filter((o) => o.paid_at).length}); продаж ${sales.length} (${sales.map((s) => s.status)}); чеков ${f.rc.length} (${f.rc.map((x) => `${x.channel}/${x.status}`)}); движений склада sale ${stock0} → ${mv[0].n}; журнал payment.succeeded ${f.succ.length}, pos.sale ${posAudit.length}`);
  assert.equal(f.pays.length, 1);
  assert.equal(f.p.status, 'succeeded');
  assert.equal(orders.length, 1);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].status, 'completed');
  assert.equal(f.rc.length, 1, 'один чек');
  assert.equal(mv[0].n, 2, 'склад списан один раз (2 строки)');
  assert.equal(f.succ.length, 1);
  assert.equal(posAudit.length, 1);
  const ep = emu(`/__emu/payments/${pid}`);
  t.diagnostic(`эмулятор: ${ep.status}, чеков у платежа ${ep.receipts?.length ?? (ep.receipt ? 1 : 0)}, возвратов ${ep.refunded_amount?.value ?? 0}`);
  assert.equal(Number(ep.refunded_amount?.value ?? 0), 0, 'двойной оплаты нет — возвратов нет');
});

test(`T17: старт игры (стол ${TABLE_B}) — повторные вебхуки: одна оплата, одна сессия, одна команда света`, async (t) => {
  await waitTableFree(TABLE_B);
  const guest = await newGuest();
  const tbl = await table(TABLE_B, guest.token);
  const q = await ok(quote(guest.token, { resourceId: tbl.resource.id, minutes: 20 }));
  const pr = await ok(pay(guest.token, q.quote_id, 'sbp'));
  const pid = providerId(pr);
  const t0 = new Date();
  const h = hammer(pid);
  const p = await waitPaymentSession(guest.token, pr.payment_id);
  gameB = { guest, sessionId: p.session_id };
  const h2 = emu(`/__emu/payments/${pid}/webhook?repeat=5`, { post: true });
  await sleep(2000);
  const f = await paymentFacts(pid);
  const { rows: sess } = await db.query('select id, status from bl.sessions where resource_id = $1 and created_at >= $2', [tbl.resource.id, t0]);
  const { rows: sp } = await db.query('select session_id, outcome from bl.session_payments where payment_id = $1', [f.p.id]);
  const { rows: cmds } = await db.query("select data->>'type' as type from bl.audit_log where club_id = $1 and action = 'device.cmd' and created_at >= $2 and data->>'session_id' = $3", [CLUB_A, t0, p.session_id]);
  t.diagnostic(`10 одновременных повторов → ${JSON.stringify(h.deliveries?.map((d) => d.delivered))}, ещё 5 → ${JSON.stringify(h2.deliveries?.map((d) => d.delivered))}; доставок в эмуляторе ${f.hooks.length}`);
  t.diagnostic(`платежей ${f.pays.length} (${f.p.status}); сессий на столе с момента оплаты ${sess.length}; session_payments ${JSON.stringify(sp)}; чеков ${f.rc.length}; payment.succeeded ${f.succ.length}; команды контроллеру по сессии: ${cmds.map((c) => c.type).join(', ')}`);
  assert.equal(f.pays.length, 1);
  assert.equal(sess.length, 1, 'одна сессия');
  assert.equal(sp.length, 1);
  assert.equal(f.rc.length, 1);
  assert.equal(f.succ.length, 1);
  assert.equal(cmds.filter((c) => c.type === 'session.start').length, 1, 'одна команда session.start');
});

test('T17: продажа бара на кассе по QR СБП — повторные вебхуки: одна продажа, один чек', async (t) => {
  shift = await openMyShift({ rec, man, floatKopecks: 0, log: (m) => t.diagnostic(m) });
  const s = await posSale(rec.token, { items: [{ product_id: P.teaBlack, qty: 1, modifier_ids: [] }], method: 'sbp' });
  t.diagnostic(`касса СБП → HTTP ${s.status} status=${s.json?.status} confirmation=${s.json?.confirmation?.type}`);
  assert.equal(s.status, 201, s.text);
  assert.equal(s.json.status, 'pending');
  assert.equal(s.json.confirmation.type, 'qr');
  posSales.push(s.json.sale_id);
  const pid = ykId(s.json.confirmation);
  hammer(pid);
  await waitSale(rec.token, s.json.sale_id);
  emu(`/__emu/payments/${pid}/webhook?repeat=5`, { post: true });
  await sleep(1500);
  const f = await paymentFacts(pid);
  const { rows: sales } = await db.query('select id, status, completed_at from bl.pos_sales where payment_id = $1', [f.p.id]);
  const posAudit = await auditFor(db, sales[0].id, ['pos.sale']);
  const { rows: mv } = await db.query("select count(*)::int as n from bl.stock_movements where sale_id = $1 and kind = 'sale'", [sales[0].id]);
  t.diagnostic(`платежей ${f.pays.length} (${f.p.status}); продаж ${sales.length} (${sales[0].status}); чеков ${f.rc.length} (${f.rc.map((x) => `${x.channel}/${x.status}`)}); журнал payment.succeeded ${f.succ.length}, pos.sale ${posAudit.length}; движений склада ${mv[0].n}; доставок ${f.hooks.length}`);
  assert.equal(f.pays.length, 1);
  assert.equal(sales.length, 1);
  assert.equal(f.rc.length, 1);
  assert.equal(f.succ.length, 1);
  assert.equal(posAudit.length, 1);
  assert.equal(mv[0].n, 1);
});
