// Регресс после ревью (tests/e2e/REGRESSION-review.md):
// R2 — удержание брони во время сервиса не гасит сервисный свет; индикатор брони — когда стол свободен.
// R1 — availabilityDuring для booking (связь, игра, сервис, неактивный стол, чужое удержание)
//      и online в статусе стола при удержании брони.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as api from '../../sessions/api.mjs';
import { CLUB, createTestDb, GUEST, makePayment, MIN, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

describe('регресс R1, R2: бронь, сервис и связь', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t);
    svc = h.st.service;
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });
  const at = (ms) => new Date(h.time.t + ms);
  const avail = (args) => h.asSystem(CLUB, (db) => api.availabilityDuring(db, args));

  it('R2: сервис 15 мин → бронь подтверждена → сервис идёт до конца (и после перезагрузки), затем синий индикатор', async () => {
    const c = h.ctl.get(1);
    await h.asUser(RECEPTION, (db) => svc.serviceStart(db, { resourceId: RES(1), userId: RECEPTION, minutes: 15, reasonCode: 'cleaning', reasonText: 'Уборка' }), { clubId: CLUB });
    await h.until(() => c.st.mode === 'service', 'сервис');
    await h.advance(60_000); // бронь подтверждают позже начала сервиса
    const bookingId = randomUUID();
    const r = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(1), until: at(40 * MIN), userId: GUEST(1), source: 'booking', refId: bookingId }));
    assert.deepEqual([r.applied, r.reason], [false, 'service']);
    assert.equal((await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(1)))).status, 'service');
    // Сверка дольше 10 с и перезагрузка контроллера: актуальное состояние — снова сервис.
    await h.advance(20_000);
    assert.equal(c.st.mode, 'service');
    await c.reboot();
    await h.until(() => c.received.at(-1).type === 'service.start' && c.st.mode === 'service', 'сервис после перезагрузки');
    await h.advance(60_000);
    const types = c.received.map((x) => x.type);
    assert.ok(!types.includes('service.stop'), 'сервис не гасился');
    assert.ok(!types.includes('state.reserved'), 'бронь не показывалась поверх сервиса');
    assert.equal(c.st.mode, 'service');
    // Бронь в окне сервиса недоступна (booking: table_unavailable), своё удержание не в счёт.
    const a = await avail({ resourceId: RES(1), from: at(0), to: at(5 * MIN), userId: GUEST(1), source: 'booking', refId: bookingId });
    assert.deepEqual([a.unavailable, a.reasons], [true, ['service']]);
    const other = await avail({ resourceId: RES(1), from: at(0), to: at(5 * MIN), userId: GUEST(2), source: 'booking', refId: randomUUID() });
    assert.deepEqual(other.reasons.sort(), ['foreign_hold', 'service']);
    // Сервис кончился по таймеру контроллера: стол свободен — синий индикатор брони, без тревоги.
    await h.advance(13 * MIN);
    await h.until(() => c.st.mode === 'reserved', 'state.reserved после сервиса', 6000);
    const alarms = await t.q("select count(*)::int as n from bl.alarms where type = 'state_mismatch' and resource_id = $1", [RES(1)]);
    assert.equal(alarms.rows[0].n, 0);
    await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(1), source: 'booking', refId: bookingId }));
  });

  it('R1: стол без связи при удержании брони — status reserved, online false; availabilityDuring видит офлайн по истории', async () => {
    const c = h.ctl.get(2);
    const bookingId = randomUUID();
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(2), until: at(30 * MIN), userId: GUEST(1), source: 'booking', refId: bookingId }));
    const own = { userId: GUEST(1), source: 'booking', refId: bookingId };
    assert.equal((await avail({ resourceId: RES(2), from: at(0), to: at(0), ...own })).unavailable, false, 'своё удержание не в счёт');
    const lost = h.time.t;
    await c.disconnect();
    await h.settle();
    const st = await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(2)));
    assert.deepEqual([st.status, st.online], ['reserved', false]);
    const now1 = await avail({ resourceId: RES(2), from: at(0), to: at(0), ...own });
    assert.deepEqual([now1.unavailable, now1.reasons], [true, ['offline']]);
    await h.advance(5 * MIN);
    await c.connect();
    await h.until(async () => (await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(2)))).online === true, 'онлайн');
    assert.equal((await avail({ resourceId: RES(2), from: at(0), to: at(0), ...own })).unavailable, false, 'связь вернулась');
    const past = await avail({ resourceId: RES(2), from: new Date(lost - MIN), to: at(0), ...own });
    assert.deepEqual(past.reasons, ['offline']);
    assert.equal(past.intervals.length, 1);
    assert.ok(Math.abs(Date.parse(past.intervals[0].from) - lost) <= 1_000);
    assert.ok(Math.abs(Date.parse(past.intervals[0].to) - (lost + 5 * MIN)) <= 5_000);
    const ep = await t.q('select offline_from, online_at from bl.device_offline where device_id = (select id from bl.devices where resource_id = $1)', [RES(2)]);
    assert.equal(ep.rowCount, 1);
    assert.ok(ep.rows[0].online_at);
    await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(2), source: 'booking', refId: bookingId }));
  });

  it('R1: игра — недоступно, кроме игры самого гостя; неактивный стол; плохое окно — bad_request', async () => {
    const pay = await makePayment(t, { resource: 3, user: GUEST(1), minutes: 30, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    const mine = await avail({ resourceId: RES(3), from: at(0), to: at(10 * MIN), userId: GUEST(1), source: 'booking', refId: randomUUID() });
    assert.equal(mine.unavailable, false, 'своя игра не в счёт');
    const foreign = await avail({ resourceId: RES(3), from: at(0), to: at(10 * MIN), userId: GUEST(2) });
    assert.deepEqual(foreign.reasons, ['session']);
    assert.equal(foreign.intervals[0].to, at(10 * MIN).toISOString(), 'обрезано окном');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
    const later = await avail({ resourceId: RES(3), from: at(MIN), to: at(10 * MIN), userId: GUEST(2) });
    assert.equal(later.unavailable, false, 'после остановки стол свободен');
    await t.q('update bl.resources set active = false where id = $1', [RES(4)]);
    assert.deepEqual((await avail({ resourceId: RES(4), from: at(0), to: at(0) })).reasons, ['inactive']);
    await t.q('update bl.resources set active = true where id = $1', [RES(4)]);
    const bad = await avail({ resourceId: RES(4), from: at(MIN), to: at(0) }).catch((e) => e);
    assert.equal(bad.code, 'bad_request');
  });
});
