// M4 (docs/contracts/m4.md, m4-api.md, decisions №138): столы турнира — удержание source
// tournament, свет на матч без оплаты; участники сессии для Бильярдум+.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import * as api from '../../sessions/api.mjs';
import { CLUB, createTestDb, GUEST, makePayment, MIN, OWNER, RECEPTION, RES, SKIP, startLight } from './harness.mjs';

const caught = async (fn) => {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  return { code: 'ok' };
};

describe('M4: турнир и участники', { skip: SKIP }, () => {
  let t;
  let h;
  let svc;
  let tIntervals = []; // подделка tournamentHolds (модуль турниров)
  const windows = new Map(); // подделка matchLightWindow: окно света матча (№147)
  before(async () => {
    t = await createTestDb();
    const plusApi = { async nicksOf(_db, { userIds }) { return Object.fromEntries(userIds.filter((u) => u === GUEST(1)).map((u) => [u, 'Шар'])); } };
    const tournamentsApi = {
      async tournamentHolds(_db, { resourceId }) { return tIntervals.filter((x) => x.resource === resourceId); },
      async matchLightWindow(_db, { matchId }) { return windows.get(matchId) ?? null; },
    };
    h = await startLight(t, { extra: { plusApi, tournamentsApi } });
    svc = h.st.service;
  });
  after(async () => {
    await h?.stop();
    await t?.drop();
  });
  const at = (ms) => new Date(h.time.t + ms);
  const session = async (id) => (await t.q('select * from bl.sessions where id = $1', [id])).rows[0];
  const M1 = randomUUID();
  const M2 = randomUUID();

  it('удержание турнира на двух столах: QR, оплата, депозит, бронь — table_busy «турнир до»; сервис ресепшена допустим', async () => {
    for (const [n, m] of [[1, M1], [2, M2]]) {
      const r = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(n), until: at(60 * MIN), source: 'tournament', refId: m }));
      assert.equal(r.applied, true);
    }
    const st = await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(1)));
    assert.deepEqual([st.status, st.hold_source, st.busy_until], ['reserved', 'tournament', at(60 * MIN).toISOString()]);
    const qr = await caught(() => h.asUser(GUEST(1), (db) => api.holdPending(db, { resourceId: RES(1), userId: GUEST(1), until: at(3 * MIN) })));
    assert.equal(qr.code, 'table_busy');
    assert.deepEqual(qr.data, { reason: 'tournament', busy_until: at(60 * MIN).toISOString() });
    const pay = await makePayment(t, { resource: 1, user: GUEST(1), minutes: 30, at: h.time.now() });
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', pay), { result: 'refunded', reason: 'tournament' });
    const dep = await caught(() => h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(1), staffId: RECEPTION, depositKopecks: 40_000 }), { clubId: CLUB }));
    assert.equal(dep.code, 'table_busy');
    const bk = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(1), until: at(90 * MIN), userId: GUEST(2), source: 'booking', refId: randomUUID() }));
    assert.deepEqual([bk.applied, bk.reason], [false, 'tournament']);
    const hall = await h.asUser(OWNER, (db) => svc.hall(db, { clubId: CLUB, userId: OWNER }));
    const item = hall.find((x) => x.resource.id === RES(1));
    assert.deepEqual([item.hold.source, item.hold.match_id], ['tournament', M1], 'удержание турнира не заменено бронью');
    const av = await h.asSystem(CLUB, (db) => api.availabilityDuring(db, { resourceId: RES(1), from: at(0), to: at(30 * MIN), userId: GUEST(2), source: 'booking', refId: randomUUID() }));
    assert.deepEqual(av.reasons, ['foreign_hold']);
    // Сервис ресепшена на столе турнира — с причиной.
    const c2 = h.ctl.get(2);
    assert.equal((await caught(() => h.asUser(RECEPTION, (db) => svc.serviceStart(db, { resourceId: RES(2), userId: RECEPTION, minutes: 5, reasonCode: 'cleaning', reasonText: '' }), { clubId: CLUB }))).code, 'reason_required');
    await h.asUser(RECEPTION, (db) => svc.serviceStart(db, { resourceId: RES(2), userId: RECEPTION, minutes: 5, reasonCode: 'cleaning', reasonText: 'Протереть борта' }), { clubId: CLUB });
    await h.until(() => c2.st.mode === 'service', 'сервис');
    await h.asUser(RECEPTION, (db) => svc.serviceStop(db, { resourceId: RES(2), userId: RECEPTION }), { clubId: CLUB });
    await h.until(() => c2.st.mode === 'reserved', 'после сервиса — снова стол турнира');
  });

  it('startFromTournament: свет на матч без оплаты до конца удержания, журнал от системы, без тревоги; идемпотентно; продление — возврат; stop', async () => {
    const c = h.ctl.get(1);
    assert.equal((await caught(() => h.asSystem(CLUB, (db) => api.startFromTournament(db, { resourceId: RES(1), matchId: randomUUID(), system: true })))).code, 'not_found');
    assert.equal((await caught(() => h.asUser(GUEST(1), (db) => api.startFromTournament(db, { resourceId: RES(1), matchId: M1, staffId: GUEST(1) })))).code, 'forbidden');
    const alarmsBefore = (await t.q("select count(*)::int as n from bl.alarms where type = 'manual_action' or type = 'service_light'")).rows[0].n;
    const r = await h.asSystem(CLUB, (db) => api.startFromTournament(db, { resourceId: RES(1), matchId: M1, system: true }));
    assert.equal(r.paid_until, at(60 * MIN).toISOString());
    assert.deepEqual(await h.asSystem(CLUB, (db) => api.startFromTournament(db, { resourceId: RES(1), matchId: M1, system: true })), r, 'повтор — та же сессия');
    const s = await session(r.session_id);
    assert.deepEqual([s.source, s.match_id, s.payer_user_id, s.status], ['tournament', M1, null, 'active']);
    await h.until(() => c.received.at(-1).type === 'session.start' && c.received.at(-1).body.session_id === r.session_id, 'свет');
    assert.equal(c.received.at(-1).body.remaining_ms, 60 * MIN);
    const a = (await t.q("select actor_type, data from bl.audit_log where action = 'session.start' and object_id = $1", [r.session_id])).rows[0];
    assert.deepEqual([a.actor_type, a.data.source, a.data.match_id], ['system', 'tournament', M1]);
    assert.ok((await t.q("select 1 from bl.audit_log where action = 'device.cmd' and data->>'session_id' = $1", [r.session_id])).rowCount >= 1, 'команда в журнале');
    assert.equal((await t.q("select count(*)::int as n from bl.alarms where type = 'manual_action' or type = 'service_light'")).rows[0].n, alarmsBefore, 'не ручное действие');
    assert.deepEqual(await h.asSystem(CLUB, (db) => api.sessionParticipants(db, { sessionId: r.session_id })), []);
    const ext = await makePayment(t, { kind: 'extend', resource: 1, user: GUEST(1), sessionId: r.session_id, minutes: 30, amount: 40_000, at: h.time.now() });
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', ext), { result: 'refunded', reason: 'tournament' });
    await h.advance(20 * MIN);
    const stop = await h.asUser(RECEPTION, (db) => api.stopFromTournament(db, { resourceId: RES(1), matchId: M1, staffId: RECEPTION }), { clubId: CLUB });
    assert.deepEqual([stop.stopped, stop.session_id], [true, r.session_id]);
    await h.until(() => c.received.at(-1).type === 'session.stop', 'свет погашен');
    assert.equal(c.received.at(-1).body.reason_code, 'tournament_end');
    assert.equal((await session(r.session_id)).status, 'closed');
    const ob = await t.q("select payload from bl.outbox where topic = 'session.closed' and payload->>'session_id' = $1", [r.session_id]);
    assert.equal(ob.rows[0].payload.match_id, M1);
    assert.deepEqual(await h.asUser(RECEPTION, (db) => api.stopFromTournament(db, { resourceId: RES(1), matchId: M1, staffId: RECEPTION }), { clubId: CLUB }), { ok: true, stopped: false });
    assert.deepEqual(await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(2), source: 'booking', refId: M2 })), { ok: true, released: false });
    assert.deepEqual(await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(2), source: 'tournament', refId: M2 })), { ok: true, released: true });
  });

  it('sessionParticipants и sessionOf; GET сессии — participants с user_id и ником Бильярдум+', async () => {
    const pay = await makePayment(t, { resource: 3, user: GUEST(1), minutes: 30, at: h.time.now() });
    const { session_id: sid } = await h.outbox.deliver('payment.confirmed', pay);
    await h.asUser(GUEST(2), (db) => svc.join(db, { sessionId: sid, userId: GUEST(2), code: 'TEST000003' }));
    const list = await h.asSystem(CLUB, (db) => api.sessionParticipants(db, { sessionId: sid }));
    assert.deepEqual(list.map((p) => [p.user_id, p.role]), [[GUEST(1), 'payer'], [GUEST(2), 'participant']]);
    assert.ok(list.every((p) => typeof p.joined_at === 'string'));
    const of = await h.asUser(GUEST(2), (db) => api.sessionOf(db, { sessionId: sid }));
    assert.deepEqual([of.id, of.resource_id, of.status, of.source, of.payer_user_id, of.match_id], [sid, RES(3), 'active', 'qr', GUEST(1), null]);
    assert.equal(await h.asUser(GUEST(2), (db) => api.sessionOf(db, { sessionId: randomUUID() })), null);
    const v = await h.asUser(GUEST(2), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(2) }));
    assert.deepEqual(v.participants, [
      { user_id: GUEST(1), nick: 'Шар', label: 'Игрок 1' },
      { user_id: GUEST(2), nick: null, label: 'Игрок 2' },
    ]);
    assert.equal((await caught(() => h.asUser(GUEST(3), (db) => svc.getSession(db, { sessionId: sid, userId: GUEST(3) })))).code, 'not_found', 'чужому — нет');
    const staff = await h.asUser(RECEPTION, (db) => svc.getSession(db, { sessionId: sid, userId: RECEPTION }));
    assert.equal(staff.participants.length, 2, 'персонал клуба видит');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('№146: пока идёт турнир, стол и между матчами не принимает QR, оплату, депозит; начало турнира обрезает игру', async () => {
    tIntervals = [{ resource: RES(4), from: at(-MIN).toISOString(), to: at(120 * MIN).toISOString(), tournament_id: randomUUID() }];
    const st = await h.asSystem(CLUB, (db) => api.getResourceStatus(db, RES(4)));
    assert.deepEqual([st.status, st.hold_source, st.busy_until], ['reserved', 'tournament', at(120 * MIN).toISOString()]);
    const qr = await caught(() => h.asUser(GUEST(1), (db) => api.holdPending(db, { resourceId: RES(4), userId: GUEST(1), until: at(3 * MIN) })));
    assert.deepEqual([qr.code, qr.data], ['table_busy', { reason: 'tournament', busy_until: at(120 * MIN).toISOString() }]);
    const pay = await makePayment(t, { resource: 4, user: GUEST(1), minutes: 30, at: h.time.now() });
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', pay), { result: 'refunded', reason: 'tournament' });
    const dep = await caught(() => h.asUser(RECEPTION, (db) => api.startFromDeposit(db, { resourceId: RES(4), staffId: RECEPTION, depositKopecks: 40_000 }), { clubId: CLUB }));
    assert.equal(dep.code, 'table_busy');
    // Турнир через 30 минут: оплата часа — игра до начала − 5 минут, остаток возвращается.
    tIntervals = [{ resource: RES(4), from: at(30 * MIN).toISOString(), to: at(180 * MIN).toISOString(), tournament_id: randomUUID() }];
    const pay2 = await makePayment(t, { resource: 4, user: GUEST(1), minutes: 60, amount: 80_000, at: h.time.now() });
    const r = await h.outbox.deliver('payment.confirmed', pay2);
    assert.equal(r.result, 'started');
    assert.equal((await session(r.session_id)).paid_until.getTime(), h.time.t + 25 * MIN);
    assert.deepEqual([h.refunds.at(-1).paymentId, h.refunds.at(-1).amountKopecks], [pay2.payment_id, 46_667]);
    const n = await t.q("select text from bl.notifications where kind = 'session.booking_cut' and data->>'session_id' = $1", [r.session_id]);
    assert.match(n.rows[0].text, /турнир, вернули .+ за 35 минут/);
    const v = await h.asUser(GUEST(1), (db) => svc.getSession(db, { sessionId: r.session_id, userId: GUEST(1) }));
    assert.equal(v.extend_limit_until, at(25 * MIN).toISOString(), 'продлить можно только до турнира');
    await h.asUser(GUEST(1), (db) => svc.stop(db, { sessionId: r.session_id, userId: GUEST(1) }));
    tIntervals = [];
  });

  it('Д11: оплата старта отклонена — удержание pending гостя снимается сразу (state.free), матч турнира получает стол', async () => {
    const c = h.ctl.get(3);
    tIntervals = [];
    const p = await h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(3), userId: GUEST(2), until: at(3 * MIN) }));
    assert.equal(p.ok, true);
    await h.until(() => c.st.mode === 'pending', 'pending');
    const freeCmds = async () =>
      (await t.q("select count(*)::int as n from bl.audit_log where action = 'device.cmd' and object_id = $1 and data->>'type' = 'state.free'", ['d1000000-0000-4000-8000-000000000003'])).rows[0].n;
    const free0 = await freeCmds();
    // Турнир на столе начался между котировкой и оплатой: оплата — возврат.
    tIntervals = [{ resource: RES(3), from: at(-MIN).toISOString(), to: at(120 * MIN).toISOString(), tournament_id: randomUUID() }];
    const pay = await makePayment(t, { resource: 3, user: GUEST(2), minutes: 30, at: h.time.now() });
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', pay), { result: 'refunded', reason: 'tournament' });
    const hold = (await t.q("select released_at, release_reason from bl.resource_holds where resource_id = $1 and kind = 'pending' order by created_at desc limit 1", [RES(3)])).rows[0];
    assert.deepEqual([Boolean(hold.released_at), hold.release_reason], [true, 'payment_rejected']);
    await h.until(() => c.st.mode === 'free', 'стол свободен сразу, а не в конце котировки');
    assert.ok((await freeCmds()) > free0, 'команда state.free в журнале');
    // Стол сразу отдаётся матчу турнира (раньше — applied: false, reason: 'pending' до конца котировки).
    tIntervals = [];
    const m = randomUUID();
    const r = await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(3), until: at(60 * MIN), source: 'tournament', refId: m }));
    assert.equal(r.applied, true);
    await h.asSystem(CLUB, (db) => api.clearReserved(db, { resourceId: RES(3), source: 'tournament', refId: m }));
  });

  it('Д11: удержание более новой котировки того же гостя отклонённая оплата не снимает', async () => {
    tIntervals = [];
    const q1 = randomUUID();
    const until1 = at(3 * MIN);
    await h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(3), userId: GUEST(2), until: until1 }));
    await t.q(
      `insert into bl.quotes (id, club_id, resource_id, user_id, kind, unlimited, minutes, from_at, amount_kopecks, breakdown, created_at, valid_until)
       values ($1, $2, $3, $4, 'start', false, 30, $5, 40000, '[]'::jsonb, $5, $6)`,
      [q1, CLUB, RES(3), GUEST(2), h.time.now(), until1],
    );
    // Гость взял новую котировку — удержание продлено до её срока.
    await h.advance(MIN);
    await h.asUser(GUEST(2), (db) => api.holdPending(db, { resourceId: RES(3), userId: GUEST(2), until: at(3 * MIN) }));
    tIntervals = [{ resource: RES(3), from: at(-MIN).toISOString(), to: at(30 * MIN).toISOString(), tournament_id: randomUUID() }];
    const pay = { ...(await makePayment(t, { resource: 3, user: GUEST(2), minutes: 30, at: h.time.now() })), quote_id: q1 };
    assert.deepEqual(await h.outbox.deliver('payment.confirmed', pay), { result: 'refunded', reason: 'tournament' });
    const hold = (await t.q("select released_at from bl.resource_holds where resource_id = $1 and kind = 'pending' and user_id = $2 and until > $3", [RES(3), GUEST(2), until1])).rows;
    assert.deepEqual(hold, [{ released_at: null }], 'удержание новой котировки цело');
    tIntervals = [];
    await h.asUser(GUEST(2), (db) => api.releasePending(db, { resourceId: RES(3), userId: GUEST(2) }));
  });

  it('extendFromTournament: до старта — удержание, в игре — paid_until и session.extend с журналом; идемпотентно', async () => {
    const M3 = randomUUID();
    const c = h.ctl.get(2);
    windows.set(M3, { status: 'playing', tournament_status: 'running', resource_id: RES(2), until_max: at(90 * MIN).toISOString() });
    await h.asSystem(CLUB, (db) => api.setReserved(db, { resourceId: RES(2), until: at(30 * MIN), source: 'tournament', refId: M3 }));
    assert.equal((await caught(() => h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: randomUUID(), until: at(45 * MIN) })))).code, 'not_found');
    const e1 = await h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(45 * MIN) }));
    assert.deepEqual([e1.session_id, e1.until, e1.extended], [null, at(45 * MIN).toISOString(), true]);
    const r = await h.asSystem(CLUB, (db) => api.startFromTournament(db, { resourceId: RES(2), matchId: M3, system: true }));
    assert.equal(r.paid_until, at(45 * MIN).toISOString());
    await h.until(() => c.received.at(-1).type === 'session.start' && c.received.at(-1).body.session_id === r.session_id, 'свет матча');
    await h.advance(40 * MIN);
    const e2 = await h.asUser(RECEPTION, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(20 * MIN), staffId: RECEPTION }), { clubId: CLUB });
    assert.deepEqual([e2.session_id, e2.extended], [r.session_id, true]);
    await h.until(() => c.received.at(-1).type === 'session.extend', 'session.extend');
    assert.equal(c.received.at(-1).body.remaining_ms, 20 * MIN);
    assert.ok(c.lit, 'свет не гаснет посреди матча');
    const a = await t.q("select actor_id, data from bl.audit_log where action = 'session.extend' and object_id = $1", [r.session_id]);
    assert.deepEqual([a.rows[0].actor_id, a.rows[0].data.match_id, a.rows[0].data.source], [RECEPTION, M3, 'tournament']);
    const cmdsBefore = c.received.length;
    const e3 = await h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(20 * MIN) }));
    assert.equal(e3.extended, false, 'повтор — без изменений');
    await h.settle();
    assert.equal(c.received.length, cmdsBefore, 'и без новой команды');
    // №147 (M4-2): за окном турнира (конец + время матча) — отказ; счёт внесён — не продлевается.
    const past = await caught(() => h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(60 * MIN) })));
    assert.equal(past.code, 'limit_exceeded', 'за пределом окна турнира');
    windows.set(M3, { ...windows.get(M3), status: 'pending_confirm' });
    assert.equal((await caught(() => h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(30 * MIN) })))).code, 'session_not_active');
    windows.set(M3, { ...windows.get(M3), status: 'playing', resource_id: RES(1) });
    assert.equal((await caught(() => h.asSystem(CLUB, (db) => api.extendFromTournament(db, { resourceId: RES(2), matchId: M3, until: at(30 * MIN) })))).code, 'not_found', 'окно другого стола');
    windows.set(M3, { ...windows.get(M3), resource_id: RES(2) });
    await h.settle();
    assert.equal(c.received.length, cmdsBefore, 'отказы — без команд контроллеру');
    assert.equal((await session(r.session_id)).paid_until.getTime(), at(20 * MIN).getTime(), 'paid_until не сдвинулся');
    await h.advance(10 * MIN);
    assert.equal((await session(r.session_id)).status, 'active', 'старый конец прошёл, матч идёт');
    await h.asSystem(CLUB, (db) => api.stopFromTournament(db, { resourceId: RES(2), matchId: M3, system: true }));
  });
});
