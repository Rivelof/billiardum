// Заказы со стола, экран бара и счёт стола (контракт M2 §4, decisions №76, №79): участник сессии,
// алкоголь не проходит даже прямым запросом, статусы и права, онлайн-оплата через ЮKassa,
// счёт стола (гонка двух гостей, двойная оплата онлайн и на кассе, счёт после закрытия сессии).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, M, newKey, P, PHONES, setup, table, TABLE_1, TABLE_2, TABLE_3, waitFor } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
let h;
let reception;
let manager;
let g1;
let g2;
let stranger;

before(async () => {
  if (SKIP) return;
  h = await setup();
  reception = await h.login(PHONES.reception);
  manager = await h.login(PHONES.manager);
  g1 = await h.login('+79990000101');
  g2 = await h.login('+79990000102');
  stranger = await h.login('+79990000103');
  await h.openShift();
});

after(async () => {
  await h?.close();
});

const order = (token, body, key = newKey()) => h.request('POST', '/api/orders', { token, body, key });
const status = (token, id, body) => h.request('POST', `/api/orders/${id}/status`, { token, body, club: CLUB_A });

describe('заказ со стола в счёт стола', { skip: SKIP }, () => {
  let sessionId;
  before(async () => {
    sessionId = await h.session({ resourceId: TABLE_1, payer: g1.id, players: [g2.id] });
  });

  it('участник заказывает в счёт стола: заказ на экране бара, склад списан, SSE bar и order', async () => {
    const before = await h.stock(P.americano);
    const res = await order(g2.token, {
      session_id: sessionId,
      items: [{ product_id: P.americano, qty: 2, modifier_ids: [M.v04] }, { product_id: P.water, qty: 1 }],
      pay: 'tab',
      comment: 'Без льда',
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const o = res.json.order;
    // Американо 0,4 л: 180 + 40 = 220 ₽ × 2; сахар по умолчанию — «Без сахара».
    assert.equal(o.subtotal_kopecks, 2 * 22000 + 9000);
    assert.equal(o.items[0].name, 'Американо, 0,4 л, Без сахара');
    assert.equal(o.status, 'new');
    assert.equal(o.paid, false);
    assert.equal(o.resource.number, 1);
    assert.equal(Math.round((before - (await h.stock(P.americano))) * 1000), 2600);
    const queue = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(queue.json.some((x) => x.id === o.id));
    assert.ok(h.sseEvents.some((e) => e.channel === `club:${CLUB_A}` && e.event === 'bar' && e.data.id === o.id));
    assert.ok(h.sseEvents.some((e) => e.channel === `session:${sessionId}` && e.event === 'order' && e.data.id === o.id));
    const tab = await h.request('GET', `/api/sessions/${sessionId}/tab`, { token: g1.token });
    assert.equal(tab.json.total_kopecks, 53000);
    assert.equal(tab.json.orders.length, 1);
  });

  it('алкоголь со стола — отказ сервера даже прямым запросом; ничего не записано', async () => {
    const before = (await h.q('select count(*)::int as n from bl.orders'))[0].n;
    const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.beer, qty: 1 }], pay: 'tab' });
    assert.deepEqual([res.status, res.json.error], [404, 'not_found']);
    const online = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.water, qty: 1 }, { product_id: P.beer, qty: 1 }], pay: 'online' });
    assert.equal(online.status, 404);
    assert.equal((await h.q('select count(*)::int as n from bl.orders'))[0].n, before);
    const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: g1.token });
    assert.ok(!JSON.stringify(menu.json).includes(P.beer));
    assert.equal(menu.json.alcohol_hidden, true);
  });

  it('с разрешением платформы (qr_alcohol_allowed) алкоголь виден и заказывается', async () => {
    await h.q("update bl.platform_settings set value = 'true' where key = 'qr_alcohol_allowed'");
    try {
      const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: g1.token });
      assert.ok(JSON.stringify(menu.json).includes(P.beer));
      const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.beer, qty: 1 }], pay: 'tab' });
      assert.equal(res.status, 201);
      // Отменим, чтобы не мешал дальше (персонал, с причиной).
      const c = await status(reception.token, res.json.order.id, { status: 'canceled', reason: 'Тест разрешения' });
      assert.equal(c.json.status, 'canceled');
    } finally {
      await h.q("update bl.platform_settings set value = 'false' where key = 'qr_alcohol_allowed'");
    }
  });

  it('чужой гость не заказывает за чужим столом; без согласия — 403', async () => {
    const res = await order(stranger.token, { session_id: sessionId, items: [{ product_id: P.water, qty: 1 }], pay: 'tab' });
    assert.equal(res.status, 404);
    const nc = await h.login('+79990000199', { consent: false });
    const r2 = await order(nc.token, { session_id: sessionId, items: [{ product_id: P.water, qty: 1 }], pay: 'tab' });
    assert.deepEqual([r2.status, r2.json.error], [403, 'consent_required']);
  });

  it('статусы меняют бар и ресепшн; гость — 403; назад — 400', async () => {
    const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.chips, qty: 1 }], pay: 'tab' });
    const id = res.json.order.id;
    const byGuest = await h.request('POST', `/api/orders/${id}/status`, { token: g1.token, body: { status: 'served' } });
    assert.equal(byGuest.status, 403);
    assert.equal((await status(reception.token, id, { status: 'preparing' })).json.status, 'preparing');
    assert.equal((await status(reception.token, id, { status: 'ready' })).json.status, 'ready');
    const back = await status(reception.token, id, { status: 'preparing' });
    assert.equal(back.status, 400);
    const served = await status(reception.token, id, { status: 'served' });
    assert.equal(served.json.status, 'served');
    const queue = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(!queue.json.some((x) => x.id === id), 'выданный заказ ушёл из очереди');
    const get = await h.request('GET', `/api/orders/${id}`, { token: g2.token });
    assert.equal(get.json.status, 'served');
    const foreign = await h.request('GET', `/api/orders/${id}`, { token: stranger.token });
    assert.equal(foreign.status, 404);
    assert.ok((await h.audit('order.status')).some((a) => a.object_id === id && a.actor_id === reception.id));
  });

  it('отмена заказа в счёте стола — только с причиной, склад возвращён, тревога владельцу', async () => {
    const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.nuts, qty: 2 }], pay: 'tab' });
    const id = res.json.order.id;
    const before = await h.stock(P.nuts);
    const noReason = await status(reception.token, id, { status: 'canceled' });
    assert.deepEqual([noReason.status, noReason.json.error], [400, 'reason_required']);
    const ok = await status(reception.token, id, { status: 'canceled', reason: 'Гость отказался' });
    assert.equal(ok.json.status, 'canceled');
    assert.equal(await h.stock(P.nuts), before + 2);
    const alarms = await h.alarms('order_canceled');
    assert.ok(alarms.length >= 1);
    assert.ok((await h.audit('order.cancel')).some((a) => a.object_id === id && a.reason === 'Гость отказался'));
  });

  it('гость платит счёт онлайн: два гостя одновременно — один платёж; после оплаты счёт пуст', async () => {
    const [a, b] = await Promise.all([
      h.request('POST', `/api/sessions/${sessionId}/tab/pay`, { token: g1.token, body: { method: 'sbp' }, key: newKey() }),
      h.request('POST', `/api/sessions/${sessionId}/tab/pay`, { token: g2.token, body: { method: 'sbp' }, key: newKey() }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.json));
    assert.equal(b.status, 200, JSON.stringify(b.json));
    assert.equal(a.json.payment_id, b.json.payment_id);
    assert.equal(a.json.confirmation.type, 'redirect');
    const tab = await h.request('GET', `/api/sessions/${sessionId}/tab`, { token: g1.token });
    assert.equal(tab.json.pending_payment.payment_id, a.json.payment_id);
    const pays = await h.q("select * from bl.payments where kind = 'bar' and status = 'pending' and id = $1", [a.json.payment_id]);
    assert.equal(pays.length, 1);
    assert.equal(Number(pays[0].amount_kopecks), tab.json.total_kopecks);
    await h.emuSucceed(await h.providerId(a.json.payment_id));
    await waitFor(async () => (await h.q('select status from bl.pos_sales where id = $1', [a.json.sale_id]))[0].status === 'completed');
    const after = await h.request('GET', `/api/sessions/${sessionId}/tab`, { token: g1.token });
    assert.equal(after.json.total_kopecks, 0);
    assert.equal(after.json.pending_payment, null);
    const again = await h.request('POST', `/api/sessions/${sessionId}/tab/pay`, { token: g1.token, body: { method: 'sbp' }, key: newKey() });
    assert.deepEqual([again.status, again.json.error], [409, 'already_paid']);
    const [rc] = await h.q("select * from bl.receipts where payment_id = $1 and kind = 'sale'", [a.json.payment_id]);
    assert.equal(rc.channel, 'yookassa');
    assert.equal(rc.status, 'succeeded');
  });
});

describe('онлайн-заказ со стола', { skip: SKIP }, () => {
  let sessionId;
  before(async () => {
    sessionId = await h.session({ resourceId: TABLE_2, payer: g1.id });
  });

  it('заказ ждёт оплаты и не виден бару; после оплаты — на экране бара, склад списан', async () => {
    const before = await h.stock(P.teaBlack);
    const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.teaBlack, qty: 1, modifier_ids: [M.sugar] }], pay: 'online', method: 'card' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.order.awaiting_payment, true);
    assert.equal(res.json.payment.confirmation.type, 'redirect');
    const queue = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(!queue.json.some((x) => x.id === res.json.order.id));
    assert.equal(await h.stock(P.teaBlack), before);
    const [p] = await h.q('select * from bl.payments where id = $1', [res.json.payment.payment_id]);
    assert.deepEqual([p.kind, p.method, p.user_id, p.resource_id], ['bar', 'card', g1.id, TABLE_2]);
    await h.emuSucceed(p.provider_payment_id);
    const paid = await waitFor(async () => {
      const r = await h.request('GET', `/api/orders/${res.json.order.id}`, { token: g1.token });
      return r.json.paid ? r.json : null;
    });
    assert.equal(paid.awaiting_payment, false);
    assert.equal(await h.stock(P.teaBlack), before - 1);
    const q2 = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(q2.json.some((x) => x.id === res.json.order.id));
    const ev = (await h.outboxEvents('sale.completed')).find((e) => e.payload.payment_id === p.id);
    assert.equal(ev.payload.channel, 'guest');
    assert.equal(ev.payload.amount_kopecks, 15000);
    // Повтор вебхука — без второй продажи и второго списания.
    await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}/webhook?repeat=2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await h.emu.settle();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await h.stock(P.teaBlack), before - 1);
    assert.equal((await h.outboxEvents('sale.completed')).filter((e) => e.payload.payment_id === p.id).length, 1);
  });

  it('гость не платит онлайн за алкоголь в счёте (если персонал добавил бы его) и не меняет статусы', async () => {
    const res = await order(g1.token, { session_id: sessionId, items: [{ product_id: P.water, qty: 1 }], pay: 'online' });
    const st = await h.request('POST', `/api/orders/${res.json.order.id}/status`, { token: g1.token, body: { status: 'canceled', reason: 'x' } });
    assert.equal(st.status, 403);
  });
});

describe('двойная оплата счёта и счёт после ухода', { skip: SKIP }, () => {
  it('онлайн-оплата идёт, ресепшн берёт наличные — онлайн возвращается целиком, тревога', async () => {
    const sid = await h.session({ resourceId: TABLE_3, payer: g2.id });
    await order(g2.token, { session_id: sid, items: [{ product_id: P.water, qty: 2 }], pay: 'tab' });
    const online = await h.request('POST', `/api/sessions/${sid}/tab/pay`, { token: g2.token, body: { method: 'sbp' }, key: newKey() });
    assert.equal(online.status, 200);
    const cash = await h.request('POST', `/api/sessions/${sid}/tab/pay`, { token: reception.token, body: { method: 'cash', received_kopecks: 20000 }, key: newKey() });
    assert.equal(cash.status, 200, JSON.stringify(cash.json));
    assert.equal(cash.json.status, 'completed');
    assert.equal(cash.json.change_kopecks, 2000);
    await h.emuSucceed(await h.providerId(online.json.payment_id));
    await waitFor(async () => (await h.q('select status from bl.pos_sales where id = $1', [online.json.sale_id]))[0].status === 'completed');
    const refunds = await h.q('select * from bl.refunds where payment_id = $1', [online.json.payment_id]);
    assert.equal(refunds.length, 1);
    assert.equal(Number(refunds[0].amount_kopecks), 18000);
    assert.equal(refunds[0].status, 'succeeded');
    assert.equal((await h.alarms('bar_double_payment')).length, 1);
    const items = await h.q('select outcome from bl.pos_sale_items where sale_id = $1', [online.json.sale_id]);
    assert.ok(items.every((i) => i.outcome === 'duplicate'));
  });

  it('две кассы одновременно закрывают один счёт — одна продажа, вторая 409 already_paid', async () => {
    const sid = await h.session({ resourceId: table(4), payer: g1.id, status: 'grace' });
    await order(g1.token, { session_id: sid, items: [{ product_id: P.chips, qty: 1 }], pay: 'tab' });
    const pay = () => h.request('POST', '/api/pos/sales', { token: reception.token, body: { tabs: [sid], method: 'card_terminal' }, key: newKey(), club: CLUB_A });
    const [a, b] = await Promise.all([pay(), pay()]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [201, 409]);
    const failed = a.status === 409 ? a : b;
    assert.equal(failed.json.error, 'already_paid');
    assert.equal((await h.q("select count(*)::int as n from bl.pos_sales s join bl.pos_sale_items si on si.sale_id = s.id join bl.orders o on o.id = si.order_id where o.session_id = $1", [sid]))[0].n, 1);
  });

  it('счёт живёт дольше сессии: сессия закрыта — новый заказ нельзя, счёт оплачивается на ресепшене', async () => {
    const sid = await h.session({ resourceId: table(5), payer: g2.id });
    await order(g2.token, { session_id: sid, items: [{ product_id: P.nuts, qty: 1 }], pay: 'tab' });
    await h.closeSession(sid);
    const late = await order(g2.token, { session_id: sid, items: [{ product_id: P.water, qty: 1 }], pay: 'tab' });
    assert.deepEqual([late.status, late.json.error], [409, 'session_not_active']);
    const tabs = await h.request('GET', `/api/clubs/${CLUB_A}/tabs`, { token: reception.token });
    const t = tabs.json.find((x) => x.session_id === sid);
    assert.equal(t.total_kopecks, 18000);
    assert.equal(t.session_status, 'closed');
    const guestTab = await h.request('GET', `/api/sessions/${sid}/tab`, { token: g2.token });
    assert.equal(guestTab.json.total_kopecks, 18000);
    const paid = await h.request('POST', `/api/sessions/${sid}/tab/pay`, { token: manager.token, body: { method: 'cash', received_kopecks: 18000 }, key: newKey() });
    assert.equal(paid.status, 200, JSON.stringify(paid.json));
    const after = await h.request('GET', `/api/sessions/${sid}/tab`, { token: g2.token });
    assert.equal(after.json.total_kopecks, 0);
  });
});

describe('сверка смен (№92)', { skip: SKIP }, () => {
  it('продажи счёта стола на кассе ссылаются на существующую смену клуба', async () => {
    assert.ok((await h.q("select count(*)::int as n from bl.pos_sales where channel = 'pos' and shift_id is not null"))[0].n >= 2);
    assert.deepEqual(await h.shiftLinks(CLUB_A), []);
  });
});
