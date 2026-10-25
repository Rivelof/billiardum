// Корт в заказах бара и заявках ресепшена (M5.8, п. 8–9 пакета после M5.5): в resource заказа — type и
// family («Корт 1», а не «Стол 1»); в заявке ресепшена — billing и slot_minutes (длина слота корта).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, newKey, P, PHONES, setup, TABLE_1 } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
let h;
let reception;
let g1;

before(async () => {
  if (SKIP) return;
  h = await setup();
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
});
