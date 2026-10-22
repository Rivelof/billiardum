// M3 (контракт m3.md §1, §3): старт по брони, удержание reserved, предел продления по брони,
// «Без лимита» по депозиту наличными. Настоящая база, ускоренные часы, поддельные контроллеры.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as api from '../../sessions/api.mjs';
import { CLUB, createTestDb, GUEST, makePayment, MIN, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

const code = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err.code;
  }
  return 'ok';
};

describe('M3: бронь, reserved, предел продления, депозит', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  let nextBooking = null; // подделка bookings.nextBookingStart (модуль брони — backend-booking)
  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { extra: { bookingsApi: { nextBookingStart: async () => nextBooking } } });
    svc = h.st.service;
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });
  const session = async (id) => (await t.q('select * from bl.sessions where id = $1', [id])).rows[0];

  it('setReserved: синий индикатор, чужой гость не удерживает стол; startFromBooking: свет без оплаты, идемпотентно, журнал и outbox', async () => {
    const c = h.ctl.get(1);
    const r = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(1), until: new Date(h.time.t + 30 * MIN), userId: GUEST(1) }));
    assert.equal(r.applied, true);
    await h.until(() => c.received.at(-1).type === 'state.reserved', 'state.reserved');
    assert.equal(c.st.mode, 'reserved');
    assert.equal(c.received.at(-1).body.until_ms, 30 * MIN);
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(1), userId: GUEST(2), until: new Date(h.time.t + 3 * MIN) }))), 'table_busy');
    assert.equal((await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(1)))).status, 'reserved');
    const prepay = await makePayment(t, { resource: 1, user: GUEST(1), minutes: 60, amount: 80_000, at: h.time.now() });
    const booking = { id: randomUUID(), club_id: CLUB, resource_id: RES(1) };
    const start = (db) => api.startFromBooking(db, { booking, userId: GUEST(1), paidMinutes: 75, paymentIds: [prepay.payment_id] });
    const sid = await h.asUser(GUEST(1), start);
    assert.equal(await h.asUser(GUEST(1), start), sid, 'повтор — та же сессия');
    const s = await session(sid);
    assert.deepEqual([s.status, s.source, s.booking_id], ['active', 'booking', booking.id]);
    assert.equal(s.paid_until.getTime() - s.started_at.getTime(), 75 * MIN);
    await h.until(() => c.received.at(-1).type === 'session.start' && c.received.at(-1).body.session_id === sid, 'свет');
    assert.equal(c.received.at(-1).body.remaining_ms, 75 * MIN);
    assert.ok(c.lit);
    assert.equal((await t.q('select session_id from bl.payments where id = $1', [prepay.payment_id])).rows[0].session_id, sid);
    assert.equal((await t.q('select session_id from bl.session_payments where payment_id = $1', [prepay.payment_id])).rows[0].session_id, sid);
    const holds = await t.q("select release_reason from bl.resource_holds where resource_id = $1 and kind = 'reserved'", [RES(1)]);
    assert.deepEqual(holds.rows.map((x) => x.release_reason), ['session']);
    const a = await t.q("select actor_id, data from bl.audit_log where action = 'session.start' and object_id = $1", [sid]);
    assert.equal(a.rows[0].data.booking_id, booking.id);
    assert.equal(a.rows[0].actor_id, GUEST(1));
    const ob = await t.q("select payload from bl.outbox where topic = 'session.started' and payload->>'session_id' = $1", [sid]);
    assert.equal(ob.rows[0].payload.booking_id, booking.id);
    // Другая бронь на занятый стол — table_busy.
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => api.startFromBooking(db, { booking: { id: randomUUID(), club_id: CLUB, resource_id: RES(1) }, userId: GUEST(2), paidMinutes: 60 }))), 'table_busy');
  });

  it('extend_limit_until: у брони следующего гостя — её начало минус 5 минут; «Без лимита» — меньший из пределов', async () => {
    const sid = (await t.q("select id from bl.sessions where resource_id = $1 and status = 'active'", [RES(1)])).rows[0].id;
    let v = await h.asUser(GUEST(1), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(1) }));
    assert.equal(v.extend_limit_until, null, 'броней нет — предела нет');
    nextBooking = new Date(h.time.t + 3 * 60 * MIN);
    v = await h.asUser(GUEST(1), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(1) }));
    assert.equal(v.extend_limit_until, new Date(nextBooking.getTime() - 5 * MIN).toISOString());
    const pay = await makePayment(t, { resource: 2, user: GUEST(2), minutes: 30, unlimited: true, method: 'card', amount: 40_000, at: h.time.now() });
    const { session_id: u } = await h.outbox.deliver('payment.confirmed', pay);
    v = await h.asUser(GUEST(2), (db) => svc.getSession(db, { sessionId: u, userId: GUEST(2) }));
    assert.equal(v.extend_limit_until, v.paid_until, 'заморозка кончается раньше брони');
    nextBooking = new Date(h.time.t + 20 * MIN);
    v = await h.asUser(GUEST(2), (db) => svc.getSession(db, { sessionId: u, userId: GUEST(2) }));
    assert.equal(v.extend_limit_until, new Date(h.time.t + 15 * MIN).toISOString(), 'бронь раньше заморозки');
    nextBooking = null;
    await h.asUser(GUEST(2), (db) => svc.stop(db, { sessionId: u, userId: GUEST(2) }));
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('setReserved на занятый стол — удержание есть, индикатор синий после освобождения; clearReserved — state.free', async () => {
    const c = h.ctl.get(3);
    const pay = await makePayment(t, { resource: 3, user: GUEST(1), minutes: 30, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.until(() => c.lit, 'свет');
    const r = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(3), until: new Date(h.time.t + 60 * MIN) }));
    assert.deepEqual([r.applied, r.reason], [false, 'busy']);
    assert.notEqual(c.received.at(-1).type, 'state.reserved');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
    await h.until(() => c.received.at(-1).type === 'state.reserved', 'state.reserved после игры');
    assert.equal(c.st.mode, 'reserved');
    // Перезагрузка контроллера (позже 10 с после выхода онлайн): актуальное состояние — тоже reserved.
    await h.advance(11_000);
    await c.reboot();
    await h.until(() => c.received.at(-1).type === 'state.reserved' && c.st.mode === 'reserved', 'reserved после перезагрузки');
    assert.deepEqual(await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(3) })), { ok: true, released: true });
    await h.until(() => c.received.at(-1).type === 'state.free', 'state.free');
    assert.equal(c.st.mode, 'free');
  });

  it('депозит наличными: остаток по тарифу (400 ₽ при 800 ₽/ч — 30 минут), без подтверждения «Без лимита», закрытие с расчётом для money', async () => {
    const c = h.ctl.get(4);
    assert.equal(await code(() => h.asUser(GUEST(1), (db) => api.startFromDeposit(db, { resourceId: RES(4), staffId: GUEST(1), depositKopecks: 40_000 }), { clubId: CLUB })), 'forbidden');
    assert.equal(await code(() => h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(4), staffId: RECEPTION, depositKopecks: 1 }), { clubId: CLUB })), 'limit_exceeded');
    const r = await h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(4), userId: GUEST(3), staffId: RECEPTION, depositKopecks: 40_000 }), { clubId: CLUB });
    assert.equal(r.minutes, 30);
    const s = await session(r.session_id);
    assert.deepEqual([s.unlimited, Number(s.deposit_kopecks), s.payer_user_id], [true, 40_000, GUEST(3)]);
    await h.until(() => c.received.at(-1).type === 'session.start', 'свет');
    assert.equal(c.received.at(-1).body.remaining_ms, 30 * MIN);
    await h.advance(32 * MIN + 1_000);
    assert.equal((await session(r.session_id)).status, 'closed');
    const kinds = (await t.q("select kind from bl.notifications where kind like 'session.%' and data->>'session_id' = $1 order by created_at", [r.session_id])).rows.map((x) => x.kind);
    assert.deepEqual(kinds, ['session.t10', 'session.t1', 'session.t0', 'session.closed'], 'без session.unlimited_confirm');
    const ob = await t.q("select payload from bl.outbox where topic = 'session.closed' and payload->>'session_id' = $1", [r.session_id]);
    assert.deepEqual([ob.rows[0].payload.deposit_kopecks, ob.rows[0].payload.used_kopecks], [40_000, 40_000]);
    // Досрочно: закрывает ресепшн, расчёт по фактическим минутам.
    const r2 = await h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(4), staffId: RECEPTION, depositKopecks: 80_000 }), { clubId: CLUB });
    assert.equal(r2.minutes, 60);
    await h.advance(45 * MIN);
    assert.equal(await code(() => h.asUser(GUEST(2), (db) => svc.stop(db, { sessionId: r2.session_id, userId: GUEST(2) }))), 'not_found');
    await h.asUser(RECEPTION, (db) => svc.stop(db, { sessionId: r2.session_id, userId: RECEPTION }), { clubId: CLUB });
    const ob2 = await t.q("select payload from bl.outbox where topic = 'session.closed' and payload->>'session_id' = $1", [r2.session_id]);
    assert.equal(ob2.rows[0].payload.used_kopecks, 60_000, '45 минут по 800 ₽/ч (минимум тарифа 30 минут)');
    assert.equal(ob2.rows[0].payload.reason, 'stopped');
  });
});

describe('M3: extend_limit_until по настоящему модулю брони (server/bookings/api.mjs)', { skip: SKIP }, () => {
  let t;
  let h;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { devices: [1] });
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });

  it('бронь стола через час — в сессии предел «начало брони минус 5 минут»; без брони — null', async () => {
    const pay = await makePayment(t, { resource: 1, user: GUEST(1), minutes: 30, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    const get = () => h.asUser(GUEST(1), (db) => h.st.service.getSession(db, { sessionId: sid, userId: GUEST(1) }));
    assert.equal((await get()).extend_limit_until, null);
    const startsAt = new Date(h.time.t + 60 * MIN);
    await t.q(
      `insert into bl.bookings (club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at)
       values ($1, $2, $3, 'staff', $4, $5, 'confirmed', 'none', 0, 15, $6, $6)`,
      [CLUB, RES(1), GUEST(2), startsAt, new Date(startsAt.getTime() + 60 * MIN), h.time.now()],
    );
    assert.equal((await get()).extend_limit_until, new Date(startsAt.getTime() - 5 * MIN).toISOString());
    const list = await h.asUser(GUEST(1), (db) => h.st.service.listCurrent(db, { userId: GUEST(1) }));
    assert.equal(list[0].extend_limit_until, new Date(startsAt.getTime() - 5 * MIN).toISOString());
    assert.deepEqual(h.st.deps.missing.includes('bookings'), false, 'модуль брони подключён');
  });
});
