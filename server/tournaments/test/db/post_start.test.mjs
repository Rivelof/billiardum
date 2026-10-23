// После старта турнира (№147, №149): окно и время матча — только через extend с причиной,
// возврат взноса — только по объективной причине, отмена без возврата по умолчанию,
// напоминание организатору о неподтверждённом счёте, ручные строки отчёта смены.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { manualActions } from '../../../reports/queries.mjs';
import { CLUB_A, MIN, player, setup, STAFF, table } from './harness.mjs';

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

const two = (base) => [
  { phone: player(base), rating: 1500, nick: `Игрок${base}` },
  { phone: player(base + 1), rating: 1400, nick: `Игрок${base + 1}` },
];

/** Турнир на двоих (взнос fee), начало через 60 минут, длина lenMin; старт — в начале. */
async function running(tableN, base, { lenMin = 120, matchMinutes = 60, fee = 0 } = {}) {
  const manager = await h.login(STAFF.manager);
  const t0 = h.clock.now().getTime();
  const at = (min) => new Date(t0 + min * MIN).toISOString();
  const t = await h.createTournament({
    title: `После старта ${base}`,
    discipline: 'pool',
    fee_kopecks: fee,
    places: 2,
    match_minutes: matchMinutes,
    resource_ids: [table(tableN)],
    starts_at: at(60),
    ends_at: at(60 + lenMin),
  });
  const ps = await h.enroll(t.id, two(base));
  h.clock.set(t0 + 60 * MIN);
  const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
  assert.equal(r.status, 200, r.text);
  const [m] = await h.matches(t.id);
  const users = ps.map((p) => p.user);
  return {
    t,
    m,
    ps,
    manager,
    startedAt: t0 + 60 * MIN,
    endsAt: t0 + (60 + lenMin) * MIN,
    ua: users.find((u) => u.id === m.user_a),
    ub: users.find((u) => u.id === m.user_b),
  };
}

const path = (t, tail = '') => `/api/clubs/${CLUB_A}/tournaments/${t.id}${tail}`;

describe('№147: после старта окно турнира меняется только через extend', () => {
  it('PATCH ends_at, match_minutes, starts_at идущего турнира — 409 tournament_started; то же значение и название — можно', async () => {
    const { t, manager } = await running(6, 1000);
    const cur = await h.tournament(t.id);
    for (const body of [
      { ends_at: new Date(cur.ends_at.getTime() + 600 * MIN).toISOString() },
      { match_minutes: 600 },
      { starts_at: new Date(cur.starts_at.getTime() - 60 * MIN).toISOString() },
      { registration_closes_at: new Date(cur.starts_at.getTime() - 60 * MIN).toISOString() },
    ]) {
      const r = await h.request('PATCH', path(t), { token: manager.token, body });
      assert.equal(r.status, 409, JSON.stringify(body));
      assert.equal(r.json.error, 'tournament_started');
    }
    let after = await h.tournament(t.id);
    assert.equal(after.ends_at.getTime(), cur.ends_at.getTime(), 'ends_at не сдвинулся');
    assert.equal(after.match_minutes, cur.match_minutes);
    // Форма прислала то же значение — не правка.
    const r = await h.request('PATCH', path(t), { token: manager.token, body: { title: 'Новое название', ends_at: cur.ends_at.toISOString(), match_minutes: cur.match_minutes } });
    assert.equal(r.status, 200, r.text);
    after = await h.tournament(t.id);
    assert.equal(after.title, 'Новое название');
    assert.equal(after.ends_at.getTime(), cur.ends_at.getTime());
    // Статус после старта PATCH не меняет.
    const s = await h.request('PATCH', path(t), { token: manager.token, body: { status: 'registration' } });
    assert.equal(s.status, 409);
    assert.equal(s.json.error, 'bad_status');
  });

  it('до старта ends_at и match_minutes правятся свободно', async () => {
    const manager = await h.login(STAFF.manager);
    const t = await h.createTournament({ title: 'До старта', resource_ids: [table(5)] });
    const ends = new Date(Date.parse(t.starts_at) + 20 * 60 * MIN).toISOString();
    const r = await h.request('PATCH', path(t), { token: manager.token, body: { ends_at: ends, match_minutes: 300 } });
    assert.equal(r.status, 200, r.text);
    const row = await h.tournament(t.id);
    assert.equal(row.ends_at.toISOString(), ends);
    assert.equal(row.match_minutes, 300);
    // extend до старта — 409 bad_status.
    const x = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { match_minutes: 90, reason: 'рано' } });
    assert.equal(x.status, 409);
    assert.equal(x.json.error, 'bad_status');
  });

  it('extend: только организатор, причина обязательна, пределы — 409 limit_exceeded с extend_limit_until', async () => {
    const { t, manager, startedAt } = await running(6, 1010);
    const reception = await h.login(STAFF.reception);
    const ownerB = await h.login(STAFF.ownerB);
    const later = new Date(h.clock.now().getTime() + 180 * MIN).toISOString();
    let r = await h.request('POST', path(t, '/extend'), { token: reception.token, body: { ends_at: later, reason: 'x' } });
    assert.equal(r.status, 403);
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/extend`, { token: ownerB.token, body: { ends_at: later, reason: 'x' } });
    assert.equal(r.status, 403, 'чужой клуб');
    r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { ends_at: later } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'reason_required');
    r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { reason: 'ничего' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'bad_request');
    // Дальше +12 ч от текущего момента.
    r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { ends_at: new Date(h.clock.now().getTime() + 13 * 60 * MIN).toISOString(), reason: 'долго' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'limit_exceeded');
    assert.equal(r.json.extend_limit_until, new Date(h.clock.now().getTime() + 12 * 60 * MIN).toISOString());
    // В прошлом — 400.
    r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { ends_at: new Date(startedAt).toISOString(), reason: 'назад' } });
    assert.equal(r.status, 400);
    // Время матча сверх 240 минут — 409.
    r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { match_minutes: 300, reason: 'долго' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'limit_exceeded');
    h.clock.set(startedAt);
    assert.equal((await h.audit('manual.tournament_extend')).filter((a) => a.data.tournament_id === t.id).length, 0);
  });

  it('extend с причиной: окно и предел света сдвинуты, журнал manual.tournament_extend, тревога владельцу «было → стало», ручная строка отчёта смены', async () => {
    const { t, m, manager, endsAt, startedAt } = await running(6, 1020, { lenMin: 120, matchMinutes: 60 });
    const newEnds = new Date(endsAt + 90 * MIN).toISOString();
    const r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { ends_at: newEnds, match_minutes: 90, reason: 'Финал затянулся, гости просят доиграть' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ends_at, newEnds);
    assert.equal(r.json.match_minutes, 90);
    const row = await h.tournament(t.id);
    assert.equal(row.ends_at.toISOString(), newEnds);
    assert.equal(row.match_minutes, 90);
    // Предел света для light (№147) — новый.
    const win = await h.pool.connect().then(async (c) => {
      try {
        await c.query('begin');
        await c.query("select set_config('app.club_id', $1, true)", [CLUB_A]);
        return await h.service().lightWindow(c, { matchId: m.id });
      } finally {
        await c.query('rollback');
        c.release();
      }
    });
    // Меньший из пределов: окно турнира (ends_at + 90) и начало матча + 2 × 90 минут.
    assert.equal(win.until_max, new Date(Math.min(endsAt + 90 * MIN + 90 * MIN, startedAt + 2 * 90 * MIN)).toISOString());
    const [a] = (await h.audit('manual.tournament_extend')).filter((x) => x.data.tournament_id === t.id);
    assert.equal(a.reason, 'Финал затянулся, гости просят доиграть');
    assert.equal(a.actor_id, manager.id);
    assert.deepEqual(a.data.before, { ends_at: new Date(endsAt).toISOString(), match_minutes: 60, light_until: new Date(endsAt + 60 * MIN).toISOString() });
    assert.deepEqual(a.data.after, { ends_at: newEnds, match_minutes: 90, light_until: new Date(endsAt + 180 * MIN).toISOString() });
    const [al] = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'manual.tournament_extend' and data->>'tournament_id' = $2", [CLUB_A, t.id]);
    assert.ok(al, 'тревога manual_action');
    assert.equal(al.data.reason, 'Финал затянулся, гости просят доиграть');
    assert.equal(al.data.staff_id, manager.id);
    assert.equal(typeof al.data.staff_name, 'string');
    assert.ok(!/\+7/.test(al.data.staff_name), 'без телефона');
    assert.match(al.data.before, /^до .*\d{2}:\d{2}, матч 60 мин$/);
    assert.match(al.data.after, /^до .*\d{2}:\d{2}, матч 90 мин$/);
    const owner = await h.login(STAFF.owner);
    const n = (await h.notifications(owner.id, 'alarm')).filter((x) => x.data.alarm_id === al.id);
    assert.equal(n.length, 1, 'владелец узнал сразу');
    assert.match(n[0].text, /время продлено без оплаты \(до .+, матч 60 мин → до .+, матч 90 мин\) — .+: Финал затянулся/);
    // Отчёт смены: ручная строка с сутью.
    const rep = await manualActions(h.admin, { clubId: CLUB_A, from: new Date(0), to: new Date('2100-01-01') });
    const item = rep.items.find((i) => i.action === 'manual.tournament_extend' && i.data?.tournament_id === t.id);
    assert.ok(item, 'строка отчёта');
    assert.equal(item.kind, 'manual');
    assert.equal(item.reason, 'Финал затянулся, гости просят доиграть');
    assert.equal(item.data.before.match_minutes, 60);
    assert.equal(item.data.after.ends_at, newEnds);
  });

  it('extend: больше суток от начала турнира — можно, предел только +12 ч от текущего момента', async () => {
    const { t, manager, startedAt } = await running(6, 1025, { lenMin: 20 * 60 });
    h.clock.set(startedAt + 20 * 60 * MIN);
    const ends = new Date(startedAt + 30 * 60 * MIN).toISOString();
    const r = await h.request('POST', path(t, '/extend'), { token: manager.token, body: { ends_at: ends, reason: 'Второй день турнира' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ends_at, ends);
    h.clock.set(startedAt);
  });

  it('предел света от начала матча: не дальше started_at + 2 × match_minutes, даже если окно турнира длиннее; тревога с обоими пределами', async () => {
    const { t, m, startedAt, endsAt } = await running(6, 1027, { lenMin: 10 * 60, matchMinutes: 60 });
    const matchUntil = startedAt + 2 * 60 * MIN;
    for (let x = startedAt; x + 5 * MIN <= startedAt + 4 * 60 * MIN; x += 5 * MIN) {
      h.clock.set(x + 5 * MIN);
      await h.tick();
    }
    const ext = h.calls.light.filter((c) => c.fn === 'extendFromTournament' && c.args.matchId === m.id);
    assert.ok(ext.length >= 1, 'продлевалось');
    for (const e of ext) assert.ok(Date.parse(e.args.until) <= matchUntil, 'не дальше начала матча + 2 × время матча');
    assert.equal(Date.parse(ext.at(-1).args.until), matchUntil);
    const [mm] = await h.matches(t.id);
    assert.equal(mm.hold_until.getTime(), matchUntil);
    const alarms = await h.q("select * from bl.alarms where club_id = $1 and type = 'tournament_match_overdue' and data->>'match_id' = $2", [CLUB_A, m.id]);
    assert.equal(alarms.length, 1);
    assert.deepEqual(
      [alarms[0].data.limit_by, alarms[0].data.light_until, alarms[0].data.match_until, alarms[0].data.tournament_until],
      ['match', new Date(matchUntil).toISOString(), new Date(matchUntil).toISOString(), new Date(endsAt + 60 * MIN).toISOString()],
    );
    h.clock.set(startedAt);
  });

  it('исправление счёта: в тревоге staff_name, в строке отчёта — tournament_id и было → стало', async () => {
    const { t, m, ua, ub, manager } = await running(6, 1030);
    await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ub.token, body: { score_a: 1, score_b: 2 } });
    const r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 2, score_b: 0, reason: 'Видео' } });
    assert.equal(r.status, 200, r.text);
    const [al] = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'match_id' = $2", [CLUB_A, m.id]);
    assert.equal(typeof al.data.staff_name, 'string');
    assert.ok(al.data.staff_name.length > 0);
    const rep = await manualActions(h.admin, { clubId: CLUB_A, from: new Date(0), to: new Date('2100-01-01') });
    const item = rep.items.find((i) => i.action === 'manual.tournament_score' && i.data?.match_id === m.id);
    assert.deepEqual(item.data, { tournament_id: t.id, match_id: m.id, before: 'спор', after: '2:0' });
  });
});

describe('№149: взнос после старта', () => {
  it('возврат одному игроку: код из списка и комментарий, журнал, тревога, деньги через refundTournamentFee; повтор — already_refunded', async () => {
    const { t, ps, manager } = await running(7, 1100, { fee: 50_000 });
    const [p1, p2] = ps;
    const url = (e) => path(t, `/entries/${e}/refund`);
    const reception = await h.login(STAFF.reception);
    let r = await h.request('POST', url(p1.entry_id), { token: reception.token, body: { reason_code: 'health', comment: 'Травма руки' } });
    assert.equal(r.status, 403);
    r = await h.request('POST', url(p1.entry_id), { token: manager.token, body: { reason_code: 'personal', comment: 'Передумал' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'bad_request', 'личные причины не принимаются');
    r = await h.request('POST', url(p1.entry_id), { token: manager.token, body: { reason_code: 'health' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'reason_required');
    r = await h.request('POST', url(randomUUID()), { token: manager.token, body: { reason_code: 'health', comment: 'Травма' } });
    assert.equal(r.status, 404);
    const before = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').length;
    r = await h.request('POST', url(p1.entry_id), { token: manager.token, body: { reason_code: 'health', comment: 'Травма руки, справка' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { entry_id: p1.entry_id, refund_status: 'pending', reason_code: 'health', amount_kopecks: 50_000 });
    await h.drain();
    const calls = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').slice(before);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args.entryId, p1.entry_id);
    assert.equal(calls[0].args.reasonCode, 'health');
    assert.equal(calls[0].args.requestedBy, manager.id);
    assert.match(calls[0].args.reason, /здоровье игрока/);
    const e1 = await h.entry(p1.entry_id);
    assert.equal(e1.refund_status, 'done');
    assert.equal(e1.status, 'confirmed', 'в сетке остаётся');
    const [a] = (await h.audit('manual.tournament_refund')).filter((x) => x.data.entry_id === p1.entry_id);
    assert.equal(a.reason, 'Травма руки, справка');
    assert.deepEqual([a.data.reason_code, a.data.scope, a.data.amount_kopecks], ['health', 'entry', 50_000]);
    const [al] = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'entry_id' = $2", [CLUB_A, p1.entry_id]);
    assert.deepEqual([al.data.action, al.data.reason_code, al.data.staff_id], ['manual.tournament_refund', 'health', manager.id]);
    assert.equal(typeof al.data.staff_name, 'string');
    const owner = await h.login(STAFF.owner);
    const n = (await h.notifications(owner.id, 'alarm')).filter((x) => x.data.alarm_id === al.id);
    assert.equal(n.length, 1);
    assert.match(n[0].text, /взнос 500 ₽ возвращается игроку Игрок110\d после старта: здоровье игрока — .+: Травма руки, справка/);
    // Повтор — 409 already_refunded, денег второй раз нет.
    r = await h.request('POST', url(p1.entry_id), { token: manager.token, body: { reason_code: 'equipment', comment: 'Ещё раз' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'already_refunded');
    // Отчёт смены — ручная строка с суммой.
    const rep = await manualActions(h.admin, { clubId: CLUB_A, from: new Date(0), to: new Date('2100-01-01') });
    const item = rep.items.find((i) => i.action === 'manual.tournament_refund' && i.data?.entry_id === p1.entry_id);
    assert.equal(item.kind, 'manual');
    assert.equal(item.amount_kopecks, 50_000);
    assert.deepEqual(item.data, { tournament_id: t.id, entry_id: p1.entry_id, scope: 'entry', reason_code: 'health', refunds: null });
    assert.ok(p2);
  });

  it('бесплатная запись — 409 not_paid; до старта — 409 bad_status (правила №138)', async () => {
    const { t, ps, manager } = await running(7, 1110);
    let r = await h.request('POST', path(t, `/entries/${ps[0].entry_id}/refund`), { token: manager.token, body: { reason_code: 'venue', comment: 'Свет' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'not_paid');
    const pre = await h.createTournament({ title: 'Ещё не начат', resource_ids: [table(5)] });
    const [x] = await h.enroll(pre.id, [{ phone: player(1120), rating: 1300 }]);
    r = await h.request('POST', path(pre, `/entries/${x.entry_id}/refund`), { token: manager.token, body: { reason_code: 'health', comment: 'Травма' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'bad_status');
  });

  it('отмена после старта — без возврата по умолчанию', async () => {
    const { t, ps, manager } = await running(7, 1130, { fee: 30_000 });
    const before = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').length;
    const r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Игроки разошлись' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { refunded: 0 });
    await h.drain();
    assert.equal(h.calls.money.filter((c) => c.fn === 'refundTournamentFee').length, before, 'денег назад нет');
    for (const p of ps) {
      const e = await h.entry(p.entry_id);
      assert.deepEqual([e.status, e.refund_status], ['canceled', 'none']);
    }
    const [a] = (await h.audit('manual.tournament_cancel')).filter((x) => x.data.tournament_id === t.id);
    assert.equal(a.data.refund, 'none');
    assert.equal((await h.audit('manual.tournament_refund')).filter((x) => x.data.tournament_id === t.id).length, 0);
    const alarms = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'tournament_id' = $2", [CLUB_A, t.id]);
    assert.equal(alarms.length, 1);
    assert.deepEqual([alarms[0].data.refund, alarms[0].data.refunds, alarms[0].data.reason], ['none', 0, 'Игроки разошлись']);
    const n = await h.notifications(ps[0].user.id, 'tournament.canceled');
    assert.ok(!/вернём/.test(n.at(-1).text));
  });

  it('отмена после старта по аварии: refund all с кодом из списка — возврат всем; другой код — 400', async () => {
    const { t, ps, manager } = await running(8, 1140, { fee: 30_000 });
    let r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Пропал свет', refund: 'all', reason_code: 'personal' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'bad_request');
    r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Пропал свет', refund: 'all' } });
    assert.equal(r.status, 400, 'без кода — 400');
    r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Все заболели', refund: 'all', reason_code: 'health' } });
    assert.equal(r.status, 400, 'здоровье — только возврат одному игроку');
    assert.equal(r.json.error, 'bad_request');
    r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Пропал свет', refund: 'some', reason_code: 'venue' } });
    assert.equal(r.status, 400);
    assert.equal((await h.tournament(t.id)).status, 'running', 'ничего не отменено');
    const before = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').length;
    r = await h.request('POST', path(t, '/cancel'), { token: manager.token, body: { reason: 'Пропал свет во всём клубе', refund: 'all', reason_code: 'venue' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { refunded: 2 });
    await h.drain();
    const calls = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').slice(before);
    assert.deepEqual(calls.map((c) => c.args.entryId).sort(), ps.map((p) => p.entry_id).sort());
    assert.ok(calls.every((c) => c.args.reasonCode === 'venue' && c.args.requestedBy === manager.id));
    const [a] = (await h.audit('manual.tournament_refund')).filter((x) => x.data.tournament_id === t.id);
    assert.equal(a.reason, 'Пропал свет во всём клубе');
    assert.deepEqual([a.data.scope, a.data.reason_code, a.data.refunds, a.data.amount_kopecks], ['all', 'venue', 2, 60_000]);
    // Одна тревога об отмене — с данными о возврате.
    const alarms = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'tournament_id' = $2", [CLUB_A, t.id]);
    assert.equal(alarms.length, 1);
    const [al] = alarms;
    assert.deepEqual(
      [al.data.action, al.data.refund, al.data.reason_code, al.data.refunds, al.data.amount_kopecks, al.data.staff_id],
      ['tournament_cancel', 'all', 'venue', 2, 60_000, manager.id],
    );
    assert.equal(typeof al.data.staff_name, 'string');
    const owner = await h.login(STAFF.owner);
    const n = (await h.notifications(owner.id, 'alarm')).filter((x) => x.data.alarm_id === al.id);
    assert.equal(n.length, 1);
    assert.match(n[0].text, /отменён после старта, взносы возвращаются всем \(2, 600 ₽\): авария в клубе/);
  });
});

describe('№149: напоминание организатору о неподтверждённом счёте', () => {
  it('через 15 минут после первого счёта — уведомление управляющему и владельцу, одно на матч', async () => {
    const { t, m, ua } = await running(8, 1200);
    const r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.json.status, 'pending_confirm');
    const reportedAt = h.clock.now().getTime();
    const manager = await h.login(STAFF.manager);
    const owner = await h.login(STAFF.owner);
    const reminders = async (u) => (await h.notifications(u.id, 'tournament.confirm_reminder')).filter((n) => n.data.match_id === m.id);
    h.clock.set(reportedAt + 14 * MIN);
    await h.tick();
    assert.equal((await reminders(manager)).length, 0, 'рано');
    h.clock.set(reportedAt + 15 * MIN);
    await h.tick();
    for (const u of [manager, owner]) {
      const n = await reminders(u);
      assert.equal(n.length, 1);
      assert.match(n[0].text, /не подтверждён соперником 15 минут/);
      assert.equal(n[0].data.tournament_id, t.id);
    }
    h.clock.add(30 * MIN);
    await h.tick();
    await h.tick();
    assert.equal((await reminders(manager)).length, 1, 'одно на матч');
    const [mm] = await h.matches(t.id);
    assert.ok(mm.confirm_reminded_at);
  });

  it('спор — без напоминания (организатору уже ушло уведомление о споре)', async () => {
    const { m, ua, ub } = await running(8, 1210);
    await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ub.token, body: { score_a: 1, score_b: 2 } });
    h.clock.add(30 * MIN);
    await h.tick();
    const manager = await h.login(STAFF.manager);
    assert.equal((await h.notifications(manager.id, 'tournament.confirm_reminder')).filter((n) => n.data.match_id === m.id).length, 0);
  });
});
