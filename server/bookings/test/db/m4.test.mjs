// Бронь в M4: бронь на двоих для «Сыграем?» (createBooking с participants) и запрет броней на
// интервалы турнира (tournamentHolds). Без DATABASE_ADMIN_URL тесты пропускаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createBooking } from '../../api.mjs';
import { CLUB_A, MIN, setup, T0, table } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const DAY = 24 * 60 * MIN;

describe('бронь M4', { skip }, () => {
  let h;
  before(async () => {
    h = await setup({ settings: { booking_prepayment: 'none' } });
  });
  after(async () => {
    await h?.close();
  });

  /** createBooking в транзакции модуля-соседа (plus) от имени гостя. */
  async function inTx(userId, fn) {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.user_id', $1, true), set_config('app.actor_type', 'user', true)", [userId]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
  }

  it('«Сыграем?»: бронь на двоих — участник видит её, может начать игру, но не отменяет', async () => {
    h.clock.set(T0);
    const a = await h.login('+79996660001');
    const b = await h.login('+79996660002');
    const start = T0 + 120 * MIN;
    const v = await inTx(a.id, (db) => createBooking(db, { userId: a.id, resourceId: table(1), startsAt: new Date(start), minutes: 60, participants: [b.id] }));
    assert.equal(v.status, 'confirmed');
    assert.equal(v.participants_count, 1);
    const mineB = await h.request('GET', '/api/me/bookings', { token: b.token });
    const vb = mineB.json.find((x) => x.id === v.id);
    assert.ok(vb, 'участник видит бронь');
    assert.equal(vb.my_role, 'participant');
    assert.equal(vb.cancel.allowed, false);
    assert.equal((await h.request('GET', `/api/bookings/${v.id}`, { token: b.token })).status, 200);
    // Отменить и оплатить участник не может (не найдено как владелец).
    assert.equal((await h.request('POST', `/api/bookings/${v.id}/cancel`, { token: b.token, body: {} })).status, 404);
    // Уведомления — владельцу и участнику.
    assert.ok((await h.notifications(a.id, 'booking.confirmed')).length >= 1);
    assert.ok((await h.notifications(b.id, 'booking.confirmed')).length >= 1);
    // Участник начинает игру у стола — платит доплату он (котировка money на него).
    h.clock.set(start);
    const st = await h.request('POST', `/api/bookings/${v.id}/start`, { token: b.token, body: { code: await h.code(table(1)) } });
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.status, 'payment_required');
    assert.equal(h.moneyCalls.filter((c) => c.fn === 'createBookingQuote' && c.args.bookingId === v.id).at(-1).args.userId, b.id);
    // Через HTTP участников не добавить.
    const http = await h.request('POST', '/api/bookings', { token: a.token, body: { resource_id: table(2), starts_at: new Date(start + 60 * MIN).toISOString(), minutes: 60, participants: [b.id] } });
    assert.equal(http.status, 201, http.text);
    assert.equal(http.json.participants_count, 0);
    // Проверки участников.
    await assert.rejects(inTx(a.id, (db) => createBooking(db, { userId: a.id, resourceId: table(3), startsAt: new Date(start), minutes: 60, participants: [a.id] })), (e) => e.code === 'bad_request');
  });

  it('интервалы турнира: бронь на них — 409 table_busy {reason: tournament, busy_until} (Д7), в доступности — tournament', async () => {
    h.clock.set(T0 + DAY);
    const u = await h.login('+79996660003');
    const from = T0 + DAY + 180 * MIN;
    h.lightHooks.tournamentHolds = async (_db, a) => (a.resourceId === table(4) ? [{ from: new Date(from).toISOString(), to: new Date(from + 120 * MIN).toISOString(), match_id: null }] : []);
    try {
      const clash = await h.request('POST', '/api/bookings', { token: u.token, body: { resource_id: table(4), starts_at: new Date(from + 60 * MIN).toISOString(), minutes: 60 } });
      assert.equal(clash.status, 409);
      assert.deepEqual(clash.json, { error: 'table_busy', reason: 'tournament', busy_until: new Date(from + 120 * MIN).toISOString() });
      const ok = await h.request('POST', '/api/bookings', { token: u.token, body: { resource_id: table(4), starts_at: new Date(from + 120 * MIN).toISOString(), minutes: 60 } });
      assert.equal(ok.status, 201, ok.text);
      const other = await h.request('POST', '/api/bookings', { token: u.token, body: { resource_id: table(5), starts_at: new Date(from).toISOString(), minutes: 60 } });
      assert.equal(other.status, 201, other.text);
      const day = await h.request('GET', `/api/clubs/${CLUB_A}/availability?date=2026-10-27`);
      const t4 = day.json.resources.find((x) => x.number === 4);
      assert.ok(t4.busy.some((x) => x.kind === 'tournament' && x.from === new Date(from).toISOString()));
      // Матч вышел за окно турнира: busy_until — конец примыкающего удержания матча.
      h.lightHooks.tournamentHolds = async (_db, a) =>
        a.resourceId === table(6)
          ? [
              { from: new Date(from).toISOString(), to: new Date(from + 120 * MIN).toISOString(), match_id: null },
              { from: new Date(from + 90 * MIN).toISOString(), to: new Date(from + 150 * MIN).toISOString(), match_id: 'm' },
              { from: new Date(from + 600 * MIN).toISOString(), to: new Date(from + 700 * MIN).toISOString(), match_id: null },
            ]
          : [];
      const chained = await h.request('POST', '/api/bookings', { token: u.token, body: { resource_id: table(6), starts_at: new Date(from - 30 * MIN).toISOString(), minutes: 60 } });
      assert.deepEqual([chained.status, chained.json], [409, { error: 'table_busy', reason: 'tournament', busy_until: new Date(from + 150 * MIN).toISOString() }]);
      const before = await h.request('POST', '/api/bookings', { token: u.token, body: { resource_id: table(6), starts_at: new Date(from - 60 * MIN).toISOString(), minutes: 60 } });
      assert.equal(before.status, 201, before.text);
    } finally {
      h.lightHooks.tournamentHolds = null;
    }
  });
});
