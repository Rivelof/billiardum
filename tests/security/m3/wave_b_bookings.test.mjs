// Волна B M3 (бронь): события booking/waitlist в канале гостя user:{id} (№119, №120) —
// без чужих событий, кода стола и ПДн; бронь по телефону не попадает ни в один user:*;
// can_cancel персоналу (№115) и отсутствие ПДн/can_cancel у гостя; next_booking в плане зала
// без имени и телефона; return_url у POST /api/bookings/{id}/pay; чужая бронь — 404.
// Обвязка — server/bookings/test/db/harness.mjs (настоящие money, light, эмулятор ЮKassa).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/wave_b_bookings.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, PHONES, setup, T0, table, waitFor } from '../../../server/bookings/test/db/harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const GUEST_NAME = 'Пётр Телефонный';
const GUEST_PHONE = '+79161234567';

describe('волна B: бронь и поток гостя', { skip }, () => {
  let h;
  let a;
  let b;
  let manager;
  let reception;
  let ownerB;

  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'full' } });
    a = await h.login('+79990000021');
    b = await h.login('+79990000022');
    manager = await h.login(PHONES.manager);
    reception = await h.login(PHONES.reception);
    ownerB = await h.login(PHONES.ownerB);
  });
  after(async () => {
    await h?.close();
  });

  const userEvents = (id) => h.sseEvents.filter((e) => e.channel === `user:${id}`);

  it('события брони гостя A уходят только в user:A и без кода стола; B их не получает', async () => {
    h.clock.set(T0);
    const r = await h.request('POST', '/api/bookings', { token: a.token, body: { resource_id: table(3), starts_at: h.at(6 * 60), minutes: 60 } });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: a.token, key: randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await waitFor(async () => (await h.booking(r.json.id)).status === 'confirmed');
    await waitFor(() => userEvents(a.id).some((e) => e.data.id === r.json.id));
    const code = await h.code(table(3));
    const mine = userEvents(a.id).filter((e) => e.event === 'booking');
    assert.ok(mine.length >= 1);
    for (const e of mine) {
      assert.ok(!JSON.stringify(e.data).includes(code), 'нет кода стола (№119)');
      assert.deepEqual(Object.keys(e.data).sort(), ['ends_at', 'id', 'resource', 'starts_at', 'status', 'type']);
    }
    assert.ok(!userEvents(b.id).some((e) => JSON.stringify(e.data).includes(r.json.id)), 'B не видит событий брони A');
  });

  it('бронь по телефону: ни одного события в user:*; в канале клуба нет имени и телефона', async () => {
    h.clock.set(T0);
    const before = h.sseEvents.length;
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/bookings`, {
      token: reception.token,
      body: { resource_id: table(4), starts_at: h.at(7 * 60), minutes: 60, name: GUEST_NAME, phone: GUEST_PHONE },
    });
    assert.equal(r.status, 201, r.text);
    assert.ok(!r.text.includes(GUEST_PHONE), 'телефон в ответе персоналу — маской');
    await waitFor(() => h.sseEvents.length > before);
    const fresh = h.sseEvents.slice(before).filter((e) => JSON.stringify(e.data).includes(r.json.id));
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((e) => !e.channel.startsWith('user:')), 'бронь без учётки — без событий гостям');
    const all = JSON.stringify(h.sseEvents);
    assert.ok(!all.includes(GUEST_NAME) && !all.includes('9161234567'), 'имени и телефона нет ни в одном событии SSE');
  });

  it('can_cancel: ресепшн — только бронь по телефону без предоплаты; гостю нет ни can_cancel, ни данных гостя', async () => {
    const list = await h.request('GET', `/api/clubs/${CLUB_A}/bookings?date=${new Date(T0).toISOString().slice(0, 10)}`, { token: reception.token, club: CLUB_A });
    assert.equal(list.status, 200, list.text);
    const phone = list.json.bookings.find((x) => x.source === 'phone');
    const app = list.json.bookings.find((x) => x.source === 'app' && x.paid_kopecks > 0);
    assert.equal(phone.can_cancel, true);
    assert.equal(app.can_cancel, false);
    // can_cancel отражает реальное право: отмена предоплаченной брони ресепшеном — 403.
    const c = await h.request('POST', `/api/bookings/${app.id}/cancel`, { token: reception.token, club: CLUB_A, body: { reason: 'хочу' } });
    assert.equal(c.status, 403);
    const m = await h.request('GET', `/api/clubs/${CLUB_A}/bookings?date=${new Date(T0).toISOString().slice(0, 10)}`, { token: manager.token, club: CLUB_A });
    assert.equal(m.json.bookings.find((x) => x.id === app.id).can_cancel, true);
    const guestView = await h.request('GET', `/api/bookings/${app.id}`, { token: a.token });
    assert.equal(guestView.status, 200);
    assert.ok(!('can_cancel' in guestView.json) && !('guest' in guestView.json));
  });

  it('чужая бронь: другой гость и владелец другого клуба — 404', async () => {
    const list = await h.request('GET', '/api/me/bookings', { token: a.token });
    const id = list.json[0].id;
    assert.equal((await h.request('GET', `/api/bookings/${id}`, { token: b.token })).status, 404);
    assert.equal((await h.request('GET', `/api/bookings/${id}`, { token: ownerB.token })).status, 404);
    assert.equal((await h.request('POST', `/api/bookings/${id}/pay`, { token: b.token, key: randomUUID(), body: {} })).status, 404);
  });

  it('next_booking в плане зала — без имени и телефона, только id, время, источник, статус', async () => {
    // План зала (light.hallItem) берёт bookings.nextBooking и оставляет поля id/starts_at/ends_at/source/status.
    // В обвязке брони у light нет nextBooking, поэтому проверяем источник напрямую в контексте клуба.
    const { nextBooking } = await import('../../../server/bookings/api.mjs');
    const c = await h.pool.connect();
    let nb;
    try {
      await c.query('begin');
      await c.query('set local role app_api');
      await c.query("select set_config('app.club_id',$1,true), set_config('app.user_id',$2,true)", [CLUB_A, reception.id]);
      nb = await nextBooking(c, { resourceId: table(4), after: new Date(T0) });
      await c.query('rollback');
    } finally {
      c.release();
    }
    assert.ok(nb, 'у стола 4 есть ближайшая бронь (по телефону)');
    assert.deepEqual(Object.keys(nb).sort(), ['ends_at', 'id', 'source', 'starts_at', 'status']);
    assert.equal(nb.source, 'phone');
    const s = JSON.stringify(nb);
    assert.ok(!s.includes(GUEST_NAME) && !s.includes('9161234567'));
  });

  it('POST /api/bookings/{id}/pay: обходы return_url — 400; в money уходит только наш хост', async () => {
    h.clock.set(T0);
    const r = await h.request('POST', '/api/bookings', { token: b.token, body: { resource_id: table(5), starts_at: h.at(8 * 60), minutes: 60 } });
    assert.equal(r.status, 201, r.text);
    const bad = ['https://bl.test.evil.example/x', '/\\evil', '/app\tfoo', ' /app', 'https:/evil', '\\\\evil', '/app"x', '/app<x', 'javascript:alert(1)', 42, null, ['/app']];
    for (const v of bad) {
      const res = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: b.token, key: randomUUID(), body: { method: 'sbp', return_url: v } });
      assert.equal(res.status, 400, JSON.stringify(v));
    }
    const ok = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: b.token, key: randomUUID(), body: { method: 'sbp', return_url: '/%2F%2Fevil.example' } });
    assert.equal(ok.status, 200, ok.text);
    for (const c of h.moneyCalls.filter((x) => x.fn === 'createPrepayment' && x.args.returnUrl)) {
      assert.equal(new URL(c.args.returnUrl).host, 'bl.test', c.args.returnUrl);
    }
  });
});
