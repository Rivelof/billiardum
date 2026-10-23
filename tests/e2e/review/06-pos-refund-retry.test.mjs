// Ревью (касса): повтор возврата на кассе после «потерянного ответа» ЮKassa — один возврат.
//
// Продажа кассы по СБП (QR), оплачена в эмуляторе. Управляющий оформляет возврат, а ЮKassa на этот
// запрос отвечает 500 (эмулятор fail_next) — исход для сервера неизвестен. Управляющий жмёт ещё
// раз (тот же Idempotency-Key), потом ещё раз с новым ключом (как после перезагрузки экрана).
// Ожидаемо: в ЮKassa один возврат с одним ключом идемпотентности (повторы — тем же ключом),
// одна строка bl.refunds и bl.pos_refunds, один pos.refund в журнале, один чек возврата.
// Второй и третий тест — «операция выполнена, ответ потерян» (эмулятор lose_next_response, e22aa8a):
// ЮKassa провела возврат, но ответила 500 (mode error) или оборвала соединение (mode reset); повтор
// тем же ключом и тем же телом — один возврат и один чек.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  closeMyShift,
  emu,
  emuPayment,
  ensureStock,
  MIN,
  openMyShift,
  P,
  posSale,
  staff,
  waitFor,
  waitSale,
  ykId,
} from '../m3/helpers.mjs';

let db;
let rec;
let man;
let shift;

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await ensureStock(db, man, { [P.teaBlack]: 10, [P.waterStill]: 10 });
  shift = await openMyShift({ rec, man, floatKopecks: 100_000, log: (m) => console.log(m) });
});

after(async () => {
  emu('/__emu/config', { post: true, body: { fail_next: { count: 0 }, lose_next_response: 0 } });
  if (shift) await closeMyShift({ rec, man, shiftId: shift.id }).catch((e) => console.log(`смена не закрыта: ${e.message}`));
  await db?.end();
});

test('возврат на кассе после 500 от ЮKassa и повторов — один возврат', { timeout: 6 * MIN }, async (t) => {
  const items = [{ product_id: P.teaBlack, qty: 1 }, { product_id: P.waterStill, qty: 1 }];
  const r = await posSale(rec.token, { items, method: 'sbp' });
  assert.equal(r.status, 201, r.text);
  const conf = r.json.payment?.confirmation ?? r.json.confirmation;
  const pid = ykId(conf);
  emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });
  const sale = await waitSale(rec.token, r.json.sale_id, { printed: false });
  t.diagnostic(`продажа ${sale.total_kopecks} коп. СБП, платёж ${sale.payment_id}`);

  emu('/__emu/config', { post: true, body: { fail_next: { count: 1, status: 500 } } });
  const key = randomUUID();
  const body = { reason: 'Гость отказался (тест e2e ревью)' };
  const r1 = await api('POST', `/api/pos/sales/${sale.sale_id}/refund`, { token: man.token, idem: key, body });
  const r2 = await api('POST', `/api/pos/sales/${sale.sale_id}/refund`, { token: man.token, idem: key, body });
  const r3 = await api('POST', `/api/pos/sales/${sale.sale_id}/refund`, { token: man.token, idem: true, body });
  t.diagnostic(`возврат при 500: ${r1.status} ${r1.text.slice(0, 160)}; повтор тем же ключом: ${r2.status} ${r2.text.slice(0, 120)}; новым ключом: ${r3.status} ${r3.text.slice(0, 120)}`);

  const refunds = await waitFor(async () => {
    const { rows } = await db.query('select id, amount_kopecks, status, idempotence_key from bl.refunds where payment_id = $1', [sale.payment_id]);
    return rows.length && rows.every((x) => x.status === 'succeeded') ? rows : null;
  }, { timeoutMs: 60_000, intervalMs: 1000, what: 'возврат succeeded' });
  const ep = emuPayment(pid);
  const reqs = emu('/__emu/requests').filter((x) => x.path === '/v3/refunds' && x.method === 'POST');
  const mine = reqs.filter((x) => refunds.some((f) => f.idempotence_key === x.idempotence_key));
  const { rows: pr } = await db.query('select id, amount_kopecks from bl.pos_refunds where sale_id = $1', [sale.sale_id]);
  const { rows: au } = await db.query("select count(*)::int as n from bl.audit_log where action = 'pos.refund' and (object_id = $1 or data->>'sale_id' = $2)", [sale.sale_id, sale.sale_id]);
  const rr = (ep.receipts ?? []).filter((x) => x.kind === 'refund');
  t.diagnostic(`bl.refunds: ${JSON.stringify(refunds.map((x) => [x.amount_kopecks, x.status]))}; запросы POST /v3/refunds по этому возврату: ${JSON.stringify(mine.map((x) => [x.status, x.idempotence_key?.slice(0, 12)]))}; ЮKassa вернула ${ep.refunded_amount?.value}, чеков возврата ${rr.length}; pos_refunds ${pr.length}; журнал pos.refund ${au[0].n}`);
  assert.equal(refunds.length, 1, 'одна строка возврата');
  assert.equal(Math.round(Number(ep.refunded_amount?.value ?? 0) * 100), sale.total_kopecks, 'в ЮKassa возвращено один раз');
  assert.equal(new Set(mine.map((x) => x.idempotence_key)).size, 1, 'повторы — тем же ключом идемпотентности');
  assert.equal(rr.length, 1, 'один чек возврата');
  assert.equal(pr.length, 1, 'один возврат кассы');
  assert.equal(au[0].n, 1, 'один pos.refund');
});

/** Продажа кассы по СБП, оплачена в эмуляторе. → { sale, pid } */
async function sbpSale(t) {
  const r = await posSale(rec.token, { items: [{ product_id: P.teaBlack, qty: 1 }], method: 'sbp' });
  assert.equal(r.status, 201, r.text);
  const pid = ykId(r.json.payment?.confirmation ?? r.json.confirmation);
  emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });
  const sale = await waitSale(rec.token, r.json.sale_id, { printed: false });
  t.diagnostic(`продажа ${sale.total_kopecks} коп. СБП, платёж ${sale.payment_id}`);
  return { sale, pid };
}

for (const mode of ['error', 'reset']) {
  test(`возврат на кассе: ЮKassa провела возврат, ответ потерян (${mode}) — повтор тем же ключом, один возврат`, { timeout: 6 * MIN }, async (t) => {
    const { sale, pid } = await sbpSale(t);
    emu('/__emu/config', { post: true, body: { lose_next_response: { path: '/v3/refunds', count: 1, mode } } });
    const key = randomUUID();
    const body = { reason: `Ответ ЮKassa потерян, ${mode} (тест e2e ревью)` };
    const r1 = await api('POST', `/api/pos/sales/${sale.sale_id}/refund`, { token: man.token, idem: key, body });
    const r2 = await api('POST', `/api/pos/sales/${sale.sale_id}/refund`, { token: man.token, idem: key, body });
    t.diagnostic(`возврат, ответ ЮKassa потерян: ${r1.status} ${r1.text.slice(0, 140)}; повтор тем же ключом: ${r2.status} ${r2.text.slice(0, 140)}`);
    const refunds = await waitFor(async () => {
      const { rows } = await db.query('select id, amount_kopecks, status, idempotence_key from bl.refunds where payment_id = $1', [sale.payment_id]);
      return rows.length && rows.every((x) => x.status === 'succeeded') ? rows : null;
    }, { timeoutMs: 60_000, intervalMs: 1000, what: 'возврат succeeded' });
    const ep = emuPayment(pid);
    const reqs = emu('/__emu/requests').filter((x) => x.path === '/v3/refunds' && x.method === 'POST' && refunds.some((f) => f.idempotence_key === x.idempotence_key));
    const { rows: pr } = await db.query('select id from bl.pos_refunds where sale_id = $1', [sale.sale_id]);
    const { rows: au } = await db.query("select count(*)::int as n from bl.audit_log where action = 'pos.refund' and (object_id = $1 or data->>'sale_id' = $2)", [sale.sale_id, sale.sale_id]);
    const rr = (ep.receipts ?? []).filter((x) => x.kind === 'refund');
    t.diagnostic(`bl.refunds ${JSON.stringify(refunds.map((x) => [x.amount_kopecks, x.status]))}; запросы POST /v3/refunds: ${JSON.stringify(reqs.map((x) => [x.status, x.idempotence_key?.slice(0, 12)]))}; ЮKassa вернула ${ep.refunded_amount?.value}, чеков возврата ${rr.length}; pos_refunds ${pr.length}; pos.refund ${au[0].n}`);
    assert.equal(refunds.length, 1);
    assert.equal(Math.round(Number(ep.refunded_amount?.value ?? 0) * 100), sale.total_kopecks, 'в ЮKassa возвращено один раз');
    assert.equal(new Set(reqs.map((x) => x.idempotence_key)).size, 1, 'повторы — тем же ключом');
    assert.equal(rr.length, 1, 'один чек возврата');
    assert.equal(pr.length, 1);
    assert.equal(au[0].n, 1);
  });
}
