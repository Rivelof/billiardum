// T13. Продажа бара наличными со сдачей: чек ККТ пробит (ФД/ФП в продаже и в bl.receipts,
// документ в эмуляторе АТОЛ), остаток склада уменьшился на проданное с учётом stock_factor
// модификаторов (Американо 0,4 л — 1,3 порции).
//
// Ресепшн открывает свою смену (размен 3 000 ₽) → корзина: Американо 0,4 л с сахаром × 2,
// Чипсы × 1, Чай чёрный без сахара × 1 → наличные: меньше суммы — 400; 1 000 ₽ — сдача.
// Повтор с тем же Idempotency-Key — та же продажа. В конце смена закрывается честно.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditFor,
  catalog,
  cartAmount,
  closeMyShift,
  docsFor,
  kktDocs,
  M,
  openMyShift,
  P,
  posSale,
  receiptRow,
  rub,
  staff,
  stockApi,
  stockOf,
  stockUse,
  waitSale,
  ensureStock,
} from './helpers.mjs';

let db;
let rec;
let man;
let cat;
let shift;
let sale;
const items = [
  { product_id: P.americano, qty: 2, modifier_ids: [M.v04, M.sugar] },
  { product_id: P.chips, qty: 1 },
  { product_id: P.teaBlack, qty: 1, modifier_ids: [M.noSugar] },
];
const before0 = {};

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  cat = await catalog(db, rec.token);
  shift = await openMyShift({ rec, man, floatKopecks: 300_000, log: (m) => console.log(`# ${m}`) });
});

after(async () => {
  if (shift) {
    const closed = await closeMyShift({ rec, man, shiftId: shift.id, comment: 'e2e T13' }).catch((e) => console.log(`# смена не закрыта: ${e.message}`));
    if (closed) console.log(`# смена №${closed.number} закрыта честно: ожидалось ${closed.expected_cash_kopecks}, факт ${closed.actual_cash_kopecks}, расхождение ${closed.discrepancy_kopecks}`);
  }
  await db?.end();
});

test('T13: продажа наличными со сдачей — сдачу считает сервер, повтор идемпотентен', async (t) => {
  t.diagnostic(`смена №${shift.number} открыта ресепшеном, размен ${rub(shift.float_kopecks)}`);
  for (const id of [P.americano, P.chips, P.teaBlack]) before0[id] = await stockOf(db, id);
  const total = cartAmount(cat, items);
  t.diagnostic(`корзина (свой расчёт): ${items.map((i) => `${cat.products.get(i.product_id).name}${(i.modifier_ids ?? []).map((m) => ` +${cat.mods.get(m).name}`).join('')} × ${i.qty}`).join('; ')} = ${rub(total)}`);

  const short = await posSale(rec.token, { items, method: 'cash', received_kopecks: total - 1 });
  t.diagnostic(`наличных на копейку меньше → HTTP ${short.status} ${short.text}`);
  assert.equal(short.status, 400);

  const key = randomUUID();
  const received = 100_000;
  const r = await posSale(rec.token, { items, method: 'cash', received_kopecks: received }, key);
  t.diagnostic(`продажа → HTTP ${r.status}: status=${r.json?.status} total=${r.json?.total_kopecks} received=${r.json?.received_kopecks} change=${r.json?.change_kopecks} receipt_status=${r.json?.receipt_status} fd=${r.json?.receipt_fd} fp=${r.json?.receipt_fp} shift=${r.json?.shift_id === shift.id}`);
  assert.equal(r.status, 201);
  sale = r.json;
  assert.equal(sale.status, 'completed');
  assert.equal(sale.method, 'cash');
  assert.equal(sale.total_kopecks, total);
  assert.equal(sale.received_kopecks, received);
  assert.equal(sale.change_kopecks, received - total, 'сдача = полученное − сумма');
  assert.equal(sale.shift_id, shift.id);
  assert.ok(sale.receipt_id, 'у продажи есть чек ККТ');

  const again = await posSale(rec.token, { items, method: 'cash', received_kopecks: received }, key);
  t.diagnostic(`повтор с тем же ключом → HTTP ${again.status} sale_id совпал: ${again.json?.sale_id === sale.sale_id}`);
  assert.ok([200, 201].includes(again.status));
  assert.equal(again.json.sale_id, sale.sale_id);
  const { rows: pays } = await db.query("select count(*)::int as n from bl.payments where kind = 'bar' and id = $1", [sale.payment_id]);
  assert.equal(pays[0].n, 1, 'один платёж');
  const { rows: dupSales } = await db.query('select count(*)::int as n from bl.pos_sales where request_key = $1', [key]);
  assert.equal(dupSales[0].n, 1, 'одна продажа');
});

test('T13: чек ККТ пробит — ФД/ФП в продаже, bl.receipts и эмуляторе АТОЛ, один документ', async (t) => {
  assert.ok(sale);
  const done = await waitSale(rec.token, sale.sale_id);
  t.diagnostic(`GET продажи: receipt_status=${done.receipt_status} receipt_fd=${done.receipt_fd} receipt_fp=${done.receipt_fp}`);
  assert.equal(done.receipt_status, 'printed');
  assert.ok(done.receipt_fd > 0);
  assert.match(String(done.receipt_fp), /^\d{1,10}$/);
  const rc = await receiptRow(db, sale.receipt_id);
  t.diagnostic(`bl.receipts: kind=${rc.kind} channel=${rc.channel} status=${rc.status} amount=${rc.amount_kopecks} fd=${rc.fd} fp=${rc.fp} fn=${rc.fn} uuids=${JSON.stringify(rc.kkt_job?.uuids)}`);
  assert.equal(rc.channel, 'kkt');
  assert.equal(rc.status, 'printed');
  assert.equal(Number(rc.fd), done.receipt_fd);
  assert.equal(rc.fp, done.receipt_fp);
  assert.equal(Number(rc.amount_kopecks), sale.total_kopecks);
  const docs = docsFor(kktDocs(), rc);
  t.diagnostic(`эмулятор АТОЛ: ${JSON.stringify(docs.map((d) => ({ fd: d.fd, fp: d.fp, kind: d.kind, total: d.total_kopecks, payments: d.payments, operator: d.operator, items: d.items.map((i) => `${i.name} ${i.price_kopecks}×${i.quantity}=${i.amount_kopecks} ${i.payment_object}`) })))}`);
  assert.equal(docs.length, 1, 'ровно один документ на receipt_id');
  const d = docs[0];
  assert.equal(d.kind, 'sell');
  assert.equal(d.fd, done.receipt_fd);
  assert.equal(String(d.fp), String(done.receipt_fp));
  assert.equal(d.total_kopecks, sale.total_kopecks);
  assert.deepEqual(d.payments, [{ type: 'cash', sum_kopecks: sale.total_kopecks }]);
  assert.equal(d.items.reduce((s, i) => s + i.amount_kopecks, 0), sale.total_kopecks, 'позиции = сумма');
  assert.equal(d.operator, 'Ресепшн (тест)');
});

test('T13: остаток склада уменьшился на проданное (stock_factor 0,4 л = 1,3)', async (t) => {
  assert.ok(sale);
  const api1 = await stockApi(rec.token);
  for (const i of items) {
    const want = before0[i.product_id] - stockUse(cat, i);
    const now = await stockOf(db, i.product_id);
    t.diagnostic(`${cat.products.get(i.product_id).name}: было ${before0[i.product_id]}, продано ${stockUse(cat, i)} → стало ${now} (API ${api1.get(i.product_id)})`);
    assert.ok(Math.abs(now - want) < 1e-9, `${i.product_id}: ожидали ${want}, стало ${now}`);
  }
  const { rows } = await db.query('select product_id, qty::text as qty, kind from bl.stock_movements where sale_id = $1 order by product_id', [sale.sale_id]);
  t.diagnostic(`движения склада продажи: ${JSON.stringify(rows)}`);
  assert.ok(rows.length >= 3 && rows.every((r) => r.kind === 'sale' && Number(r.qty) < 0));
  const au = await auditFor(db, sale.sale_id, ['pos.sale']);
  t.diagnostic(`журнал: ${au.map((a) => `${a.action} actor=${a.actor_type}`).join(', ')}`);
  assert.equal(au.length, 1);
  const r = await api('GET', `/api/pos/sales/${sale.sale_id}`, { token: rec.token });
  assert.equal(r.status, 200);
});
