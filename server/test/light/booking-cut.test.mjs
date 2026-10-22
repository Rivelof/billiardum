// Ревью брони (№128–№129): оплата, продление, повторное открытие, «Продолжить» и депозит не
// заходят в бронь следующего гостя; удержание брони не пускает её владельца в обычную оплату;
// clearReserved снимает только своё удержание.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as api from '../../sessions/api.mjs';
import { CLUB, createTestDb, GUEST, makePayment, MIN, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

const caught = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return { code: 'ok' };
};

describe('бронь следующего гостя обрезает игру (№129) и удержания брони (№128)', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  let nextBooking = null;
  before(async () => {
    t = await createTestDb();
    h = await startLight(t, { extra: { bookingsApi: { nextBookingStart: async () => nextBooking, nextBooking: async () => null } } });
    svc = h.st.service;
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });
  const session = async (id) => (await t.q('select * from bl.sessions where id = $1', [id])).rows[0];
  const at = (ms) => new Date(h.time.t + ms);
  const cuts = async (sid) => (await t.q("select data from bl.audit_log where action = 'session.booking_cut' and object_id = $1", [sid])).rows.map((r) => r.data);
  const lastCmd = (n) => h.ctl.get(n).received.at(-1);

  it('старт по оплате: время до брони − 5 мин, остаток возвращается частично с ключом от платежа; уведомление гостю', async () => {
    nextBooking = at(45 * MIN);
    const pay = await makePayment(t, { resource: 1, user: GUEST(1), minutes: 60, amount: 80_000, at: h.time.now() });
    const r = await h.outbox.deliver('payment.confirmed', pay);
    assert.equal(r.result, 'started');
    const s = await session(r.session_id);
    assert.equal(s.paid_until.getTime() - s.started_at.getTime(), 40 * MIN);
    assert.deepEqual(h.refunds.at(-1), { paymentId: pay.payment_id, amountKopecks: 26_667, reason: 'booking_conflict', key: `booking-cut-${pay.payment_id}` });
    const sp = (await t.q('select refunded_kopecks from bl.session_payments where payment_id = $1', [pay.payment_id])).rows[0];
    assert.equal(Number(sp.refunded_kopecks), 26_667);
    const [cut] = await cuts(r.session_id);
    assert.deepEqual([cut.cut_ms, cut.refund_kopecks], [20 * MIN, 26_667]);
    const n = (await t.q("select user_id, text from bl.notifications where kind = 'session.booking_cut' and data->>'session_id' = $1", [r.session_id])).rows;
    assert.equal(n.length, 1);
    assert.equal(n[0].user_id, GUEST(1));
    assert.match(n[0].text, /забронирован на \d{2}:\d{2}, вернули .+ за 20 минут/);
    await h.until(() => lastCmd(1).type === 'session.start' && lastCmd(1).body.session_id === r.session_id, 'свет');
    assert.equal(lastCmd(1).body.remaining_ms, 40 * MIN);
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: r.session_id, userId: GUEST(1) }));
  });

  it('старт по оплате: до брони меньше минуты — полный возврат, свет не включается', async () => {
    nextBooking = at(5 * MIN + 30_000);
    const pay = await makePayment(t, { resource: 1, user: GUEST(2), minutes: 30, amount: 40_000, at: h.time.now() });
    const r = await h.outbox.deliver('payment.confirmed', pay);
    assert.deepEqual(r, { result: 'refunded', reason: 'booking' });
    assert.deepEqual(h.refunds.at(-1), { paymentId: pay.payment_id, amountKopecks: 40_000, reason: 'light_booking' });
    assert.equal((await t.q("select count(*)::int as n from bl.sessions where resource_id = $1 and status in ('active','ending','grace')", [RES(1)])).rows[0].n, 0);
    const n = await t.q("select text from bl.notifications where kind = 'session.booking_cut' and user_id = $1", [GUEST(2)]);
    assert.equal(n.rowCount, 1, 'гость узнаёт о брони и возврате');
    nextBooking = null;
  });

  it('продление: до брони − 5 мин с частичным возвратом; упёрлось в предел — полный возврат', async () => {
    const pay = await makePayment(t, { resource: 2, user: GUEST(1), minutes: 30, amount: 40_000, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    nextBooking = at(50 * MIN);
    const ext = await makePayment(t, { kind: 'extend', resource: 2, sessionId: sid, minutes: 30, amount: 40_000, at: h.time.now() });
    assert.equal((await h.outbox.deliver('payment.confirmed', ext)).result, 'extended');
    assert.equal((await session(sid)).paid_until.getTime(), h.time.t + 45 * MIN);
    assert.deepEqual(h.refunds.at(-1), { paymentId: ext.payment_id, amountKopecks: 20_000, reason: 'booking_conflict', key: `booking-cut-${ext.payment_id}` });
    const ext2 = await makePayment(t, { kind: 'extend', resource: 2, sessionId: sid, minutes: 30, amount: 40_000, at: h.time.now() });
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', ext2), { result: 'refunded', reason: 'booking' });
    assert.equal((await session(sid)).paid_until.getTime(), h.time.t + 45 * MIN, 'paid_until не сдвинулся');
    nextBooking = null;
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('повторное открытие после закрытия: не дальше брони, остаток возвращается', async () => {
    const pay = await makePayment(t, { resource: 3, user: GUEST(1), minutes: 10, amount: 15_000, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.advance(12 * MIN + 1_000);
    assert.equal((await session(sid)).close_reason, 'expired');
    nextBooking = at(20 * MIN);
    const ext = await makePayment(t, { kind: 'extend', resource: 3, sessionId: sid, minutes: 30, amount: 40_000, at: h.time.now() });
    assert.equal((await h.outbox.deliver('payment.confirmed', ext)).result, 'reopened');
    assert.equal((await session(sid)).paid_until.getTime(), h.time.t + 15 * MIN);
    assert.deepEqual(h.refunds.at(-1), { paymentId: ext.payment_id, amountKopecks: 20_000, reason: 'booking_conflict', key: `booking-cut-${ext.payment_id}` });
    nextBooking = null;
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('«Продолжить» после interrupted: бронь ближе минуты — booking_conflict; иначе до брони с возвратом остатка', async () => {
    const pay = await makePayment(t, { resource: 4, user: GUEST(1), minutes: 60, amount: 80_000, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    const c = h.ctl.get(4);
    await h.until(() => c.lit, 'свет');
    await h.advance(30 * MIN);
    await c.disconnect();
    await t.q("update bl.sessions set device_paid_until = started_at + interval '30 minutes' where id = $1", [sid]);
    await h.advance(3 * MIN);
    await c.reboot();
    await h.until(async () => (await session(sid)).status === 'interrupted', 'interrupted');
    assert.equal(Number((await session(sid)).unplayed_ms), 30 * MIN);
    nextBooking = at(5 * MIN + 30_000);
    const err = await caught(() => h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'continue' })));
    assert.equal(err.code, 'booking_conflict');
    assert.equal((await session(sid)).status, 'interrupted', 'гость может выбрать возврат');
    nextBooking = at(20 * MIN);
    await h.asUser(GUEST(1), (db) => svc.resolve(db, { sessionId: sid, userId: GUEST(1), choice: 'continue' }));
    const s = await session(sid);
    assert.equal(s.paid_until.getTime(), h.time.t + 15 * MIN);
    const r = h.refunds.at(-1);
    assert.deepEqual([r.paymentId, r.amountKopecks, r.reason], [pay.payment_id, 20_000, 'booking_conflict']);
    assert.match(r.key, new RegExp(`^bcr-${pay.payment_id}-`));
    assert.equal((await cuts(sid))[0].cut_ms, 15 * MIN);
    await h.until(() => lastCmd(4).type === 'session.start' && lastCmd(4).body.session_id === sid, 'свет после «Продолжить»');
    assert.equal(lastCmd(4).body.remaining_ms, 15 * MIN);
    nextBooking = null;
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('депозит: до брони меньше минимума тарифа — booking_conflict; иначе минут не больше, чем до брони', async () => {
    const dep = (kop) => h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(1), staffId: RECEPTION, depositKopecks: kop }), { clubId: CLUB });
    nextBooking = at(30 * MIN); // до предела 25 минут, минимум тарифа — 30
    assert.equal((await caught(() => dep(80_000))).code, 'booking_conflict');
    nextBooking = at(40 * MIN);
    const r = await dep(80_000);
    assert.equal(r.minutes, 35);
    assert.equal((await session(r.session_id)).paid_until.getTime(), h.time.t + 35 * MIN);
    nextBooking = null;
    await h.asUser(RECEPTION, (db) => svc.stop(db, { sessionId: r.session_id, userId: RECEPTION }), { clubId: CLUB });
  });

  it('holdPending: владелец брони — booking_start_required с booking_id; очередь того же гостя — обычная оплата', async () => {
    const bookingId = randomUUID();
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(2), until: at(30 * MIN), userId: GUEST(1), source: 'booking', refId: bookingId }));
    const hold = (user) => h.asUser(user, (db) => api.holdPending(db, { resourceId: RES(2), userId: user, until: at(3 * MIN) }));
    const err = await caught(() => hold(GUEST(1)));
    assert.equal(err.code, 'booking_start_required');
    assert.equal(err.status, 409);
    assert.deepEqual(err.data, { booking_id: bookingId });
    assert.equal((await caught(() => hold(GUEST(2)))).code, 'table_busy');
    const offerId = randomUUID();
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(3), until: at(30 * MIN), userId: GUEST(1), source: 'waitlist', refId: offerId }));
    const ok = await h.asUser(GUEST(1), (db) => api.holdPending(db, { resourceId: RES(3), userId: GUEST(1), until: at(3 * MIN) }));
    assert.equal(ok.ok, true);
    await h.asUser(GUEST(1), (db) => api.releasePending(db, { resourceId: RES(3), userId: GUEST(1) }));
  });

  it('clearReserved снимает только совпадающее удержание (source, refId)', async () => {
    const offerId = randomUUID();
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(3), until: at(30 * MIN), userId: GUEST(3), source: 'waitlist', refId: offerId }));
    const clear = (args) => h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(3), ...args }));
    assert.deepEqual(await clear({ source: 'booking', refId: randomUUID() }), { ok: true, released: false });
    assert.deepEqual(await clear({ source: 'waitlist', refId: randomUUID() }), { ok: true, released: false });
    assert.equal((await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(3)))).status, 'reserved');
    assert.deepEqual(await clear({ source: 'waitlist', refId: offerId }), { ok: true, released: true });
    assert.equal((await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(3)))).status, 'free');
    assert.equal((await caught(() => clear({ source: 'nope' }))).code, 'bad_request');
    // Без фильтра — как раньше: любое reserved.
    await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(2) }));
  });

  it('бронь по телефону (user_id null): депозит и старт по чужой брони — table_busy', async () => {
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(4), until: at(30 * MIN), source: 'booking', refId: randomUUID() }));
    const err = await caught(() => h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(4), staffId: RECEPTION, depositKopecks: 40_000 }), { clubId: CLUB }));
    assert.equal(err.code, 'table_busy');
    const err2 = await caught(() => h.asUser(GUEST(2), (db) => api.startFromBooking(db, { booking: { id: randomUUID(), club_id: CLUB, resource_id: RES(4) }, userId: GUEST(2), paidMinutes: 60 })));
    assert.equal(err2.code, 'table_busy');
    await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(4), source: 'booking' }));
  });
});
