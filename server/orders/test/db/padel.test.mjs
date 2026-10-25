// Корт в заказах бара и заявках ресепшена (M5.8, п. 8–9 пакета после M5.5): в resource заказа — type и
// family («Корт 1», а не «Стол 1»); в заявке ресепшена — billing и slot_minutes (длина слота корта).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, newKey, P, PHONES, setup, TABLE_1 } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
let h;
let reception;
let g1;

before(async () => {
  if (SKIP) return;
  h = await setup({ extraRoutes: ['quotes.mjs'] });
  reception = await h.login(PHONES.reception);
  g1 = await h.login('+79990000101');
  await h.openShift();
});

after(async () => {
  await h?.close();
});

describe('корт в заказах бара и заявках ресепшена', { skip: SKIP }, () => {
  it('заказ со стола корта: resource.type и family, номер — в нумерации кортов', async () => {
    const sessionId = await h.session({ resourceId: COURT_1, payer: g1.id });
    const res = await h.request('POST', '/api/orders', { token: g1.token, body: { session_id: sessionId, items: [{ product_id: P.water, qty: 1 }], pay: 'tab' }, key: newKey() });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.deepEqual(
      [res.json.order.resource.number, res.json.order.resource.type, res.json.order.resource.family],
      [1, 'padel_court', 'court'],
    );
    const queue = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    const o = queue.json.find((x) => x.id === res.json.order.id);
    assert.deepEqual([o.resource.type, o.resource.family], ['padel_court', 'court']);
  });

  it('заявка ресепшена: у корта billing slot и slot_minutes из тарифа, у стола — hourly и null', async () => {
    const court = await h.receptionRequest({ resourceId: COURT_1, userId: g1.id, amount: 240000, minutes: 90 });
    const table = await h.receptionRequest({ resourceId: TABLE_1, userId: g1.id, amount: 50000, minutes: 60 });
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/reception/requests`, { token: reception.token, club: CLUB_A });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = r.json.find((x) => x.id === court);
    const t = r.json.find((x) => x.id === table);
    assert.deepEqual([c.resource_type, c.resource_family, c.billing, c.slot_minutes], ['padel_court', 'court', 'slot', 90]);
    assert.deepEqual([t.resource_family, t.billing, t.slot_minutes], ['table', 'hourly', null]);
  });

  it('Н-2 pentester M5.8: копеечный тариф не даёт игру за 0 ₽ — котировка и оплата котировки на 0 ₽ — 400 bad_request', async () => {
    // Тариф стола 1 копейка в час (прямой UPDATE: через мастер такую цену уже не сохранить) → 0 ₽ после округления.
    await h.q("update bl.tariff_rules set price_per_hour = 1 where club_id = $1 and resource_type = 'billiard_pyramid'", [CLUB_A]);
    const quote = await h.request('POST', '/api/quotes', { token: g1.token, body: { resource_id: TABLE_1, kind: 'start', minutes: 60 } });
    assert.deepEqual([quote.status, quote.json], [400, { error: 'bad_request' }]);
    // Котировка на 0 ₽ (строкой напрямую) оплате не подлежит: ни СБП, ни ресепшн.
    const [q] = await h.q(
      `insert into bl.quotes (club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, valid_until)
       values ($1, $2, $3, 'start', 30, now(), 0, now() + interval '3 minutes') returning id`,
      [CLUB_A, TABLE_1, g1.id],
    );
    for (const method of ['sbp', 'reception']) {
      const pay = await h.request('POST', `/api/quotes/${q.id}/pay`, { token: g1.token, key: newKey(), body: { method } });
      assert.deepEqual([pay.status, pay.json], [400, { error: 'bad_request' }], method);
    }
    assert.equal((await h.q('select count(*)::int as n from bl.payments where quote_id = $1', [q.id]))[0].n, 0);
    assert.equal((await h.q('select used_at from bl.quotes where id = $1', [q.id]))[0].used_at, null, 'котировка не потрачена');
  });

  it('Н-3 pentester M5.8: описание платежа корта в ЮKassa — «Корт 2, 1 ч 30 мин», а не «Стол 2»', async () => {
    // Контроллер корта на связи (иначе котировка — table_offline).
    await h.q("update bl.devices set last_seen_at = now(), device_key_enc = coalesce(device_key_enc, '\\x00') where resource_id = $1", [COURT_2]);
    const quote = await h.request('POST', '/api/quotes', { token: g1.token, body: { resource_id: COURT_2, kind: 'start', minutes: 90 } });
    assert.equal(quote.status, 200, JSON.stringify(quote.json));
    const pay = await h.request('POST', `/api/quotes/${quote.json.quote_id}/pay`, { token: g1.token, key: newKey(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, JSON.stringify(pay.json));
    const remote = (await (await fetch(`${h.emuBase}/__emu/payments`)).json()).filter((x) => /Корт|Стол/.test(x.description ?? ''));
    assert.ok(remote.some((x) => x.description === 'Корт 2, 1 ч 30 мин'), JSON.stringify(remote.map((x) => x.description)));
    assert.ok(!remote.some((x) => /Стол 2/.test(x.description) && x.amount?.value === '2400.00'));
  });
});
