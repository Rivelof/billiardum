// Независимое ревью денег (касса и склад) на настоящем Postgres и эмуляторе ЮKassa:
// п. 1 — возврат на кассе идемпотентен по ключу запроса (ответ ЮKassa потерян → повтор → один возврат);
// п. 5 — продажа ждёт закрытие смены (строка смены блокируется);
// п. 4 — payment.refund_canceled откатывает учёт возврата продажи (суммы, позиции, склад), тревога;
// п. 9 — продажа ждёт ревизию товара (строки товаров блокируются);
// п. 10 — id продажи по СБП и онлайн-заказа гостя — от ключа запроса (повтор — тот же платёж ЮKassa).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, newKey, P, PHONES, setup, TABLE_1, waitFor } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
let h;
let reception;
let manager;
let guest;

before(async () => {
  if (SKIP) return;
  h = await setup();
  reception = await h.login(PHONES.reception);
  manager = await h.login(PHONES.manager);
  guest = await h.login('+79990000201');
  await h.openShift();
});

after(async () => {
  await h?.close();
});

const sale = (body, key = newKey()) => h.request('POST', '/api/pos/sales', { token: reception.token, body, key, club: CLUB_A });
const refund = (saleId, body, key = newKey()) => h.request('POST', `/api/pos/sales/${saleId}/refund`, { token: manager.token, body, key, club: CLUB_A });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paidSbpSale(items) {
  const res = await sale({ items, method: 'sbp', customer_phone: '+79990000201' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  await h.emuSucceed(await h.providerId(res.json.payment_id));
  return waitFor(async () => {
    const r = await h.request('GET', `/api/pos/sales/${res.json.sale_id}`, { token: reception.token, club: CLUB_A });
    return r.json.status === 'completed' ? r.json : null;
  });
}

/** Держать строку открытой смены (как закрытие смены в процессе), затем закрыть её. */
async function holdShift() {
  const c = await h.admin.connect();
  await c.query('begin');
  await c.query('select id from bl.shifts where club_id = $1 and closed_at is null for update', [CLUB_A]);
  return {
    async close() {
      await c.query(
        `update bl.shifts set closed_at = now(), closed_by = opened_by, actual_cash_kopecks = 0, expected_cash_kopecks = 0, discrepancy_kopecks = 0
          where club_id = $1 and closed_at is null`,
        [CLUB_A],
      );
      await c.query('commit');
      c.release();
    },
    async release() {
      await c.query('rollback');
      c.release();
    },
  };
}

/** Промис с отметкой «уже завершился». */
function track(p) {
  const t = { done: false };
  t.promise = p.finally(() => {
    t.done = true;
  });
  return t;
}

describe('ревью денег: касса и склад', { skip: SKIP }, () => {
  it('п. 1: возврат СБП — ЮKassa выполнила, ответ потерян (503) → повтор с тем же ключом → один возврат в ЮKassa', async () => {
    const s = await paidSbpSale([{ product_id: P.water, qty: 1 }]);
    const before = h.createdAt('/v3/refunds').length;
    const key = newKey();
    h.loseResponses('/v3/refunds', 1);
    const first = await refund(s.sale_id, { reason: 'Гость передумал' }, key);
    assert.ok(first.status >= 500, `первая попытка: ${first.status} ${JSON.stringify(first.json)}`);
    assert.equal(h.createdAt('/v3/refunds').length, before + 1, 'возврат у ЮKassa создан');
    assert.equal((await h.q('select count(*)::int as n from bl.pos_refunds where sale_id = $1', [s.sale_id]))[0].n, 0, 'откат у нас');
    const second = await refund(s.sale_id, { reason: 'Гость передумал' }, key);
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(h.createdAt('/v3/refunds').length, before + 1, 'второго возврата в ЮKassa нет');
    const third = await refund(s.sale_id, { reason: 'Гость передумал' }, key);
    assert.equal(third.json.pos_refund_id, second.json.pos_refund_id);
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [s.payment_id]))[0].n, 1);
  });

  it('п. 10: продажа по СБП — ответ ЮKassa на создание платежа потерян → повтор с тем же ключом → тот же платёж, одна продажа', async () => {
    const before = h.createdAt('/v3/payments').length;
    const key = newKey();
    h.loseResponses('/v3/payments', 1);
    const body = { items: [{ product_id: P.chips, qty: 1 }], method: 'sbp', customer_phone: '+79990000201' };
    const first = await sale(body, key);
    assert.ok(first.status >= 500, `первая попытка: ${first.status}`);
    const second = await sale(body, key);
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(h.createdAt('/v3/payments').length, before + 1, 'один платёж в ЮKassa');
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales where request_key = $1', [key]))[0].n, 1);
  });

  it('п. 10: онлайн-заказ гостя со стола — ответ ЮKassa потерян → повтор → один платёж ЮKassa', async () => {
    const sid = await h.session({ resourceId: TABLE_1, payer: guest.id });
    const before = h.createdAt('/v3/payments').length;
    const key = newKey();
    const body = { session_id: sid, items: [{ product_id: P.water, qty: 1 }], pay: 'online' };
    h.loseResponses('/v3/payments', 1);
    const first = await h.request('POST', '/api/orders', { token: guest.token, body, key });
    assert.ok(first.status >= 500, `первая попытка: ${first.status}`);
    const second = await h.request('POST', '/api/orders', { token: guest.token, body, key });
    assert.equal(second.status, 201, JSON.stringify(second.json));
    assert.equal(h.createdAt('/v3/payments').length, before + 1, 'один платёж в ЮKassa');
    await h.closeSession(sid);
  });

  it('п. 4: payment.refund_canceled — учёт возврата продажи откатывается (суммы, позиции, склад), возврат отменён, тревога; повтор — без изменений', async () => {
    const res = await sale({ items: [{ product_id: P.water, qty: 2 }], method: 'cash', received_kopecks: 18000 });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const stockSold = await h.stock(P.water);
    const r = await refund(res.json.sale_id, { reason: 'Гость передумал' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(await h.stock(P.water), stockSold + 2);
    const event = { refund_id: r.json.refund_id, payment_id: res.json.payment_id, amount_kopecks: r.json.amount_kopecks, pos_refund_id: r.json.pos_refund_id };
    for (let k = 0; k < 2; k += 1) {
      await h.q('insert into bl.outbox (club_id, topic, payload) values ($1, $2, $3::jsonb)', [CLUB_A, 'payment.refund_canceled', JSON.stringify(event)]);
    }
    await waitFor(async () => (await h.q("select count(*)::int as n from bl.outbox where topic = 'payment.refund_canceled' and processed_at is null"))[0].n === 0);
    const [pr] = await h.q('select * from bl.pos_refunds where id = $1', [r.json.pos_refund_id]);
    assert.ok(pr.canceled_at);
    assert.match(pr.cancel_reason, /отменён ЮKassa/);
    const [ps] = await h.q('select * from bl.pos_sales where id = $1', [res.json.sale_id]);
    assert.equal(Number(ps.refunded_kopecks), 0);
    const items = await h.q('select refunded_qty, refunded_kopecks from bl.pos_sale_items where sale_id = $1', [res.json.sale_id]);
    assert.ok(items.every((i) => i.refunded_qty === 0 && Number(i.refunded_kopecks) === 0));
    assert.equal(await h.stock(P.water), stockSold, 'склад — как после продажи (обратное движение один раз)');
    assert.equal((await h.alarms('pos_refund_canceled')).filter((a) => a.data.pos_refund_id === pr.id).length, 1);
    assert.equal((await h.audit('pos.refund_canceled')).filter((a) => a.data.pos_refund_id === pr.id).length, 1);
  });

  it('п. 5: продажа наличными ждёт закрытие смены и после него — 409 shift_closed, наличные не записаны', async () => {
    const hold = await holdShift();
    const key = newKey();
    const t = track(sale({ items: [{ product_id: P.nuts, qty: 1 }], method: 'cash', received_kopecks: 20000 }, key));
    await sleep(400);
    assert.equal(t.done, false, 'продажа ждёт строку смены');
    await hold.close();
    const res = await t.promise;
    assert.deepEqual([res.status, res.json], [409, { error: 'shift_closed' }]);
    assert.equal((await h.q('select count(*)::int as n from bl.payments where request_key = $1', [key]))[0].n, 0);
    await h.openShift();
  });

  it('п. 5: возврат наличными тоже ждёт закрытие смены', async () => {
    const res = await sale({ items: [{ product_id: P.nuts, qty: 1 }], method: 'cash', received_kopecks: 20000 });
    assert.equal(res.status, 201);
    const hold = await holdShift();
    const t = track(refund(res.json.sale_id, { reason: 'Гость передумал' }));
    await sleep(400);
    assert.equal(t.done, false, 'возврат ждёт строку смены');
    await hold.close();
    const r = await t.promise;
    assert.deepEqual([r.status, r.json], [409, { error: 'shift_closed' }]);
    await h.openShift();
  });

  it('п. 9: продажа товара ждёт ревизию этого товара (строка товара заблокирована)', async () => {
    const c = await h.admin.connect();
    try {
      await c.query('begin');
      await c.query('select id from bl.products where id = $1 for update', [P.water]);
      const t = track(sale({ items: [{ product_id: P.water, qty: 1 }], method: 'card_terminal' }));
      await sleep(400);
      assert.equal(t.done, false, 'продажа ждёт ревизию');
      await c.query('commit');
      const res = await t.promise;
      assert.equal(res.status, 201, JSON.stringify(res.json));
    } finally {
      c.release();
    }
  });
});
