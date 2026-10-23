// Партии Бильярдум+ на Postgres: T22, T23, окно подтверждения, сессия, спор и решение управляющего,
// гонки подтверждений, турнирные партии ×1,5, сверка Эло базы с формулой.
// DATABASE_ADMIN_URL обязателен; без него файл пропускается.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { applyElo } from '../../elo.mjs';
import { applyMatch } from '../../api.mjs';
import { CLUB_A, CLUB_B, MIN, PHONES, setup, table, T0 } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('Бильярдум+: партии', { skip, concurrency: false }, () => {
  let h;
  before(async () => {
    h = await setup();
  });
  after(async () => {
    await h?.close();
  });

  it('T22: партия 8:5, оба подтвердили — рейтинг пересчитан у обоих', async () => {
    const a = await h.player('Ace');
    const b = await h.player('Bob');
    const s = await h.session({ players: [a.id, b.id] });
    const c = await h.request('POST', '/api/plus/matches', {
      token: a.token,
      body: { session_id: s, discipline: 'pyramid', opponent_id: b.id, my_score: 8, opponent_score: 5 },
    });
    assert.equal(c.status, 201, c.text);
    assert.equal(c.json.status, 'pending');
    assert.equal(c.json.counted, null);
    assert.deepEqual(c.json.players.map((p) => [p.nick, p.score, p.confirmed]), [['Ace', 8, true], ['Bob', 5, false]]);
    assert.equal(c.json.confirm_until, new Date(T0 + 30 * MIN).toISOString());
    assert.equal((await h.notifications(b.id, 'plus.match_confirm')).length, 1);
    assert.equal(await h.rating(a.id), null, 'до подтверждения рейтинга нет');

    h.clock.add(5 * MIN);
    const r = await h.request('POST', `/api/plus/matches/${c.json.id}/confirm`, { token: b.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'confirmed');
    assert.equal(r.json.counted, true);
    assert.deepEqual(r.json.rating_delta, { [a.id]: 20, [b.id]: -20 });
    assert.deepEqual(await h.rating(a.id), { rating: 1220, games: 1, wins: 1 });
    assert.deepEqual(await h.rating(b.id), { rating: 1180, games: 1, wins: 0 });
    assert.deepEqual(await h.rating(a.id, 'pyramid', '2026-10'), { rating: 1220, games: 1, wins: 1 });
    const audit = await h.audit('plus.match_counted');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].club_id, CLUB_A);
    assert.equal((await h.notifications(a.id, 'plus.rating')).length, 1);

    const me = await h.request('GET', '/api/plus/me', { token: a.token });
    const pyr = me.json.ratings.find((x) => x.discipline === 'pyramid');
    assert.deepEqual(pyr, { discipline: 'pyramid', rating: 1220, games: 1, level: 'amateur', season_rating: 1220 });
    assert.equal(me.json.history[0].opponent_nick, 'Bob');
    assert.equal(me.json.history[0].delta, 20);
    assert.equal(me.json.history[0].result, 'win');

    // Повтор подтверждения — тот же ответ, рейтинг не меняется.
    const again = await h.request('POST', `/api/plus/matches/${c.json.id}/confirm`, { token: b.token });
    assert.equal(again.status, 200);
    assert.deepEqual(await h.rating(a.id), { rating: 1220, games: 1, wins: 1 });
    // applyMatch соседа — тоже без второго пересчёта.
    const client = await h.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      assert.deepEqual(await applyMatch(client, { matchId: c.json.id }), { status: 'counted', reject_reason: null });
      await client.query('commit');
    } finally {
      client.release();
    }
    assert.deepEqual(await h.rating(b.id), { rating: 1180, games: 1, wins: 0 });
  });

  it('T23: четвёртая партия пары за рабочие сутки клуба не засчитана (сохранена с причиной)', async () => {
    const a = await h.player('Pair_A');
    const b = await h.player('Pair_B');
    h.clock.set(T0 + 60 * MIN);
    const s = await h.session({ players: [a.id, b.id], resourceId: table(2) });
    for (let i = 0; i < 3; i += 1) {
      const m = await h.play(a, b, s);
      assert.equal(m.counted, true, `партия ${i + 1}`);
      h.clock.add(10 * MIN);
    }
    const before4 = await h.rating(a.id);
    const fourth = await h.play(a, b, s);
    assert.equal(fourth.status, 'confirmed');
    assert.equal(fourth.counted, false);
    assert.equal(fourth.not_counted_reason, 'pair_daily_limit');
    assert.equal(fourth.rating_delta, null);
    assert.deepEqual(await h.rating(a.id), before4);
    const [row] = await h.q('select status, reject_reason from bl.matches where id = $1', [fourth.id]);
    assert.deepEqual(row, { status: 'rejected', reject_reason: 'pair_daily_limit' });
    assert.equal((await h.notifications(a.id, 'plus.match_not_counted')).length, 1);
    const hist = await h.request('GET', '/api/plus/me', { token: a.token });
    assert.equal(hist.json.history[0].counted, false);
    assert.equal(hist.json.history[0].not_counted_reason, 'pair_daily_limit');

    // С другим соперником лимит свой.
    const c = await h.player('Pair_C');
    const s2 = await h.session({ players: [a.id, c.id], resourceId: table(3) });
    assert.equal((await h.play(a, c, s2)).counted, true);

    // Новые рабочие сутки — с 06:00 по Екатеринбургу (01:00 UTC): 05:59 ещё вчера, 06:00 — уже нет.
    h.clock.set(Date.parse('2026-10-27T00:59:00Z'));
    const s3 = await h.session({ players: [a.id, b.id], resourceId: table(4) });
    assert.equal((await h.play(a, b, s3)).not_counted_reason, 'pair_daily_limit');
    h.clock.set(Date.parse('2026-10-27T01:00:00Z'));
    const s4 = await h.session({ players: [a.id, b.id], resourceId: table(5) });
    assert.equal((await h.play(a, b, s4)).counted, true);
  });

  it('засчитывается только партия игроков одной сессии, идущей или закрытой ≤ 30 минут назад', async () => {
    h.clock.set(T0 + 2 * 24 * 60 * MIN);
    const a = await h.player('Sess_A');
    const b = await h.player('Sess_B');
    const x = await h.player('Sess_X');
    // Соперник не участник сессии — партия сохраняется, но не засчитывается.
    const s = await h.session({ players: [a.id, b.id], resourceId: table(6) });
    const foreign = await h.request('POST', '/api/plus/matches', {
      token: a.token, body: { session_id: s, discipline: 'pool', opponent_id: x.id, my_score: 5, opponent_score: 3 },
    });
    assert.equal(foreign.status, 201);
    assert.equal(foreign.json.counted, false);
    assert.equal(foreign.json.not_counted_reason, 'not_same_session');
    // Чужая сессия — 404, без раскрытия.
    const notMine = await h.request('POST', '/api/plus/matches', {
      token: x.token, body: { session_id: s, discipline: 'pool', opponent_id: a.id, my_score: 5, opponent_score: 3 },
    });
    assert.equal(notMine.status, 404);
    // Дисциплина не стола — 400; пирамида не до 8 — 400.
    const wrong = await h.request('POST', '/api/plus/matches', {
      token: a.token, body: { session_id: s, discipline: 'pyramid', opponent_id: b.id, my_score: 8, opponent_score: 3 },
    });
    assert.equal(wrong.status, 400);
    // Закрыта 20 минут назад — можно; 31 минуту — нельзя.
    const closed20 = await h.session({ players: [a.id, b.id], resourceId: table(7), status: 'closed', startedMs: h.clock.now().getTime() - 90 * MIN, endedMs: h.clock.now().getTime() - 20 * MIN });
    assert.equal((await h.play(a, b, closed20, { discipline: 'pool', my: 5, opp: 2 })).counted, true);
    const closed31 = await h.session({ players: [a.id, b.id], resourceId: table(8), status: 'closed', startedMs: h.clock.now().getTime() - 90 * MIN, endedMs: h.clock.now().getTime() - 31 * MIN });
    const late = await h.request('POST', '/api/plus/matches', {
      token: a.token, body: { session_id: closed31, discipline: 'pool', opponent_id: b.id, my_score: 5, opponent_score: 2 },
    });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, 'session_not_active');
    // Без профиля у соперника — no_profile.
    const noProfile = await h.player('none', { profile: false });
    const s2 = await h.session({ players: [a.id, noProfile.id], resourceId: table(1) });
    const np = await h.request('POST', '/api/plus/matches', {
      token: a.token, body: { session_id: s2, discipline: 'pyramid', opponent_id: noProfile.id, my_score: 8, opponent_score: 1 },
    });
    assert.equal(np.status, 409);
    assert.equal(np.json.error, 'no_profile');
    // Вторая неподтверждённая партия той же пары в той же сессии — duplicate.
    await h.play(a, b, s, { discipline: 'pool', my: 5, opp: 1, confirm: false });
    const dup = await h.request('POST', '/api/plus/matches', {
      token: a.token, body: { session_id: s, discipline: 'pool', opponent_id: b.id, my_score: 5, opponent_score: 1 },
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'duplicate');
    const list = await h.request('GET', `/api/plus/matches?session_id=${s}`, { token: b.token });
    assert.equal(list.status, 200);
    assert.equal(list.json.items.length, 2);
    assert.equal((await h.request('GET', `/api/plus/matches?session_id=${s}`, { token: x.token })).status, 404);
  });

  it('нет подтверждения за 30 минут — партия не засчитана (confirm_timeout), в том числе планировщиком', async () => {
    h.clock.set(T0 + 3 * 24 * 60 * MIN);
    const a = await h.player('Late_A');
    const b = await h.player('Late_B');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(2) });
    const m1 = await h.play(a, b, s, { confirm: false });
    h.clock.add(31 * MIN);
    const r = await h.request('POST', `/api/plus/matches/${m1.id}/confirm`, { token: b.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'expired');
    assert.equal(r.json.not_counted_reason, 'confirm_timeout');
    assert.equal(await h.rating(a.id), null);

    const s2 = await h.session({ players: [a.id, b.id], resourceId: table(3) });
    const m2 = await h.play(a, b, s2, { confirm: false });
    h.clock.add(30 * MIN + 1000);
    const t = await h.tick();
    assert.ok(t.processed >= 1);
    const [row] = await h.q('select status, reject_reason from bl.matches where id = $1', [m2.id]);
    assert.deepEqual(row, { status: 'rejected', reject_reason: 'confirm_timeout' });
    assert.ok((await h.notifications(a.id, 'plus.match_not_counted')).length >= 1);
  });

  it('спор → управляющему; решение управляющего с причиной в журнал; ресепшн не решает', async () => {
    h.clock.set(T0 + 4 * 24 * 60 * MIN);
    const a = await h.player('Disp_A');
    const b = await h.player('Disp_B');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(4) });
    const m = await h.play(a, b, s, { my: 8, opp: 6, confirm: false });
    const noReason = await h.request('POST', `/api/plus/matches/${m.id}/dispute`, { token: b.token, body: {} });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.error, 'reason_required');
    const d = await h.request('POST', `/api/plus/matches/${m.id}/dispute`, { token: b.token, body: { reason: 'Я выиграл 8:6' } });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.status, 'disputed');
    // Подтвердить спорную нельзя.
    assert.equal((await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token })).status, 409);
    const dispAudit = await h.audit('plus.match_dispute');
    assert.equal(dispAudit.at(-1).reason, 'Я выиграл 8:6');
    const managerMsgs = await h.notifications('a1000000-0000-4000-8000-000000000003', 'plus.dispute');
    assert.equal(managerMsgs.length, 1);
    assert.equal(managerMsgs[0].level, 'important');

    const manager = await h.login(PHONES.manager);
    const reception = await h.login(PHONES.reception);
    const list = await h.request('GET', `/api/clubs/${CLUB_A}/plus/disputes`, { token: manager.token });
    assert.equal(list.status, 200);
    const item = list.json.items.find((x) => x.id === m.id);
    assert.equal(item.dispute_reason, 'Я выиграл 8:6');
    assert.equal(item.table_number, 4);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/plus/disputes`, { token: reception.token })).status, 403);
    assert.equal((await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: reception.token, club: CLUB_A, body: { result: 'b', reason: 'x' } })).status, 403);
    const nr = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, club: CLUB_A, body: { result: 'b' } });
    assert.equal(nr.json.error, 'reason_required');
    // Владелец другого клуба — не видит партию.
    const ownerB = await h.login(PHONES.ownerB);
    const foreign = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: ownerB.token, club: CLUB_B, body: { result: 'a', reason: 'взлом' } });
    assert.equal(foreign.status, 404);

    const r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, club: CLUB_A, body: { result: 'b', reason: 'Видео зала: победил Disp_B' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'resolved');
    assert.equal(r.json.counted, true);
    assert.deepEqual(r.json.players.map((p) => p.score), [6, 8], 'победитель по решению — счёт развёрнут');
    assert.equal(r.json.rating_delta[b.id], 20);
    const res = await h.audit('plus.match_resolve');
    assert.equal(res.at(-1).reason, 'Видео зала: победил Disp_B');
    assert.equal(res.at(-1).actor_id, manager.id);
    assert.equal(res.at(-1).actor_type, 'user', 'ручная строка отчёта смены (№125)');
    // M4-I5: решение спора — ручное действие: тревога manual_action владельцу с причиной, сотрудником и сутью.
    const [al] = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'match_id' = $2", [CLUB_A, m.id]);
    assert.ok(al, 'тревога manual_action');
    assert.deepEqual([al.data.action, al.data.result, al.data.reason, al.data.staff_id], ['plus.match_resolve', 'b', 'Видео зала: победил Disp_B', manager.id]);
    const owner = await h.login(PHONES.owner);
    const toOwner = (await h.notifications(owner.id, 'alarm')).filter((n) => n.data.alarm_id === al.id);
    assert.equal(toOwner.length, 1, 'владелец узнал сразу');
    assert.match(toOwner[0].text, /Спор по партии на столе 4 решён: счёт 6:8 \(было 8:6\) — .+: Видео зала: победил Disp_B/);
    assert.equal((await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, club: CLUB_A, body: { result: 'a', reason: 'передумал' } })).status, 409);

    // Отмена результата — не засчитана, рейтинг не трогается.
    const m2 = await h.play(a, b, s, { my: 8, opp: 1, confirm: false });
    await h.request('POST', `/api/plus/matches/${m2.id}/dispute`, { token: b.token, body: { reason: 'Не играли' } });
    const before = await h.rating(a.id);
    const an = await h.request('POST', `/api/plus/matches/${m2.id}/resolve`, { token: manager.token, club: CLUB_A, body: { result: 'annul', reason: 'Партии не было' } });
    assert.equal(an.json.status, 'resolved');
    assert.equal(an.json.counted, false);
    assert.equal(an.json.not_counted_reason, 'annulled');
    assert.deepEqual(await h.rating(a.id), before);
    const annulAlarm = await h.q("select data from bl.alarms where type = 'manual_action' and data->>'match_id' = $1", [m2.id]);
    assert.equal(annulAlarm[0]?.data.result, 'annul', 'отмена результата — тоже тревога владельцу');
  });

  it('M4-3: «Подтвердить» с увиденным счётом — не тот счёт 409 score_changed, тот — засчитывается', async () => {
    h.clock.set(T0 + 4 * 24 * 60 * MIN + 30 * MIN);
    const a = await h.player('Seen_A');
    const b = await h.player('Seen_B');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(3) });
    const m = await h.play(a, b, s, { my: 8, opp: 6, confirm: false });
    let r = await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token, body: { score_a: 6, score_b: 8 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'score_changed');
    assert.equal((await h.q('select status from bl.matches where id = $1', [m.id]))[0].status, 'pending', 'ничего не подтверждено');
    r = await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token, body: { score_a: 'восемь', score_b: 6 } });
    assert.equal(r.status, 400);
    r = await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token, body: { score_a: 8, score_b: 6 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.counted, true);
  });

  it('гонка: параллельные подтверждения и applyMatch — рейтинг пересчитан один раз', async () => {
    h.clock.set(T0 + 5 * 24 * 60 * MIN);
    const a = await h.player('Race_A');
    const b = await h.player('Race_B');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(5) });
    const m = await h.play(a, b, s, { confirm: false });
    const results = await Promise.all(Array.from({ length: 8 }, () => h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token })));
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    assert.deepEqual(await h.rating(a.id), { rating: 1220, games: 1, wins: 1 });
    assert.equal((await h.q('select count(*)::int as n from bl.rating_history where match_id = $1', [m.id]))[0].n, 2);
    await Promise.all(Array.from({ length: 6 }, async () => {
      const c = await h.pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
        await applyMatch(c, { matchId: m.id });
        await c.query('commit');
      } finally {
        c.release();
      }
    }));
    assert.deepEqual(await h.rating(a.id), { rating: 1220, games: 1, wins: 1 });

    // Лимит пары под гонкой: 2 засчитаны, ещё 2 подтверждаются одновременно — засчитана ровно одна.
    await h.play(a, b, s);
    const s2 = await h.session({ players: [a.id, b.id], resourceId: table(1) });
    const s3 = await h.session({ players: [a.id, b.id], resourceId: table(2) });
    const p2 = await h.play(a, b, s2, { confirm: false });
    const p3 = await h.play(a, b, s3, { confirm: false });
    const both = await Promise.all([p2, p3].map((x) => h.request('POST', `/api/plus/matches/${x.id}/confirm`, { token: b.token })));
    assert.deepEqual(both.map((x) => x.json.counted).sort(), [false, true]);
    assert.equal((await h.rating(a.id)).games, 3);
  });

  it('турнирная партия по outbox tournament.match_finished — ×1,5, один раз, достижение «Турнирный»', async () => {
    h.clock.set(T0 + 6 * 24 * 60 * MIN);
    const a = await h.player('Tour_A');
    const b = await h.player('Tour_B', { profile: false });
    const ev = { match_id: randomUUID(), tournament_id: randomUUID(), winner_id: b.id, loser_id: a.id, player_ids: [a.id, b.id], discipline: 'pool', score: { a: 1, b: 3 } };
    await h.emit('tournament.match_finished', ev);
    await h.emit('tournament.match_finished', ev);
    await h.drain();
    const [m] = await h.q('select * from bl.matches where tournament_match_id = $1', [ev.match_id]);
    assert.equal(m.status, 'counted');
    assert.equal(m.multiplier_x10, 15);
    assert.equal(m.winner_id, b.id);
    assert.deepEqual(await h.rating(b.id, 'pool'), { rating: 1230, games: 1, wins: 1 });
    assert.deepEqual(await h.rating(a.id, 'pool'), { rating: 1170, games: 1, wins: 0 });
    assert.equal((await h.q("select count(*)::int as n from bl.achievements where code = 'tournament' and user_id = any ($1::uuid[])", [[a.id, b.id]]))[0].n, 2);
    // Без игроков в событии — пропуск без ошибки (outbox не застревает).
    await h.emit('tournament.match_finished', { match_id: randomUUID(), tournament_id: randomUUID(), winner_id: a.id, score: '2:0' });
    await h.drain();
    assert.ok(h.log.lines.some((l) => l.msg === 'plus_tournament_match_skipped'));
  });

  it('исправление счёта турнирного матча (№146): откат записью-коррекцией и новый результат, один раз на ревизию', async () => {
    h.clock.set(T0 + 7 * 24 * 60 * MIN);
    const a = await h.player('Corr_A');
    const b = await h.player('Corr_B');
    const ev = { match_id: randomUUID(), tournament_id: randomUUID(), player_ids: [a.id, b.id], discipline: 'snooker' };
    await h.emit('tournament.match_finished', { ...ev, winner_id: b.id, score: { a: 1, b: 3 } });
    await h.drain();
    assert.deepEqual(await h.rating(b.id, 'snooker'), { rating: 1230, games: 1, wins: 1 });
    // Организатор исправил: победил A 3:2 (revision 1, corrected).
    await h.emit('tournament.match_finished', { ...ev, winner_id: a.id, score: { a: 3, b: 2 }, revision: 1, corrected: true });
    await h.drain();
    assert.deepEqual(await h.rating(a.id, 'snooker'), { rating: 1230, games: 1, wins: 1 });
    assert.deepEqual(await h.rating(b.id, 'snooker'), { rating: 1170, games: 1, wins: 0 });
    assert.deepEqual(await h.rating(a.id, 'snooker', '2026-11'), { rating: 1230, games: 1, wins: 1 });
    const [m] = await h.q('select id, status, score_a, score_b, revision, winner_id from bl.matches where tournament_match_id = $1', [ev.match_id]);
    assert.deepEqual([m.status, m.score_a, m.score_b, m.revision, m.winner_id], ['counted', 3, 2, 1, a.id]);
    const hist = await h.q('select user_id, revision, kind, delta, rating_before, rating_after from bl.rating_history where match_id = $1 order by revision, kind, user_id', [m.id]);
    assert.equal(hist.length, 6, 'история только дополняется: 2 исходные, 2 коррекции, 2 новые');
    const ofA = hist.filter((x) => x.user_id === a.id).map((x) => [x.revision, x.kind, x.delta]);
    assert.deepEqual(ofA, [[0, 'match', -30], [1, 'match', 30], [1, 'reversal', 30]]);
    assert.equal((await h.audit('plus.match_corrected')).length, 1);
    // Повтор той же ревизии и старая ревизия — без изменений.
    await h.emit('tournament.match_finished', { ...ev, winner_id: a.id, score: { a: 3, b: 2 }, revision: 1, corrected: true });
    await h.emit('tournament.match_finished', { ...ev, winner_id: b.id, score: { a: 1, b: 3 } });
    await h.drain();
    assert.deepEqual(await h.rating(a.id, 'snooker'), { rating: 1230, games: 1, wins: 1 });
    assert.equal((await h.q('select count(*)::int as n from bl.rating_history where match_id = $1', [m.id]))[0].n, 6);
    // Ревизии не по порядку: 3, затем 2 — вторая не применяется.
    await h.emit('tournament.match_finished', { ...ev, winner_id: b.id, score: { a: 0, b: 3 }, revision: 3, corrected: true });
    await h.drain();
    await h.emit('tournament.match_finished', { ...ev, winner_id: a.id, score: { a: 3, b: 0 }, revision: 2, corrected: true });
    await h.drain();
    assert.deepEqual(await h.rating(b.id, 'snooker'), { rating: 1230, games: 1, wins: 1 });
    assert.equal((await h.q('select revision from bl.matches where id = $1', [m.id]))[0].revision, 3);
    const view = await h.request('GET', '/api/plus/matches', { token: a.token });
    const item = view.json.items.find((x) => x.id === m.id);
    assert.deepEqual(item.rating_delta, { [a.id]: -30, [b.id]: 30 }, 'дельта — текущей ревизии');
    // Ревизию меняет только функция: app_api напрямую — нет.
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      await assert.rejects(c.query('update bl.matches set revision = 9 where id = $1', [m.id]), (e) => e.code === '42501');
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('Эло базы (bl.plus_settle_match) совпадает с формулой на случайных партиях (K по числу партий, ×1,5)', async () => {
    const users = [];
    for (let i = 0; i < 6; i += 1) {
      const id = randomUUID();
      await h.admin.query('insert into bl.users (id) values ($1)', [id]);
      users.push(id);
    }
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const app = new pg.Pool({ connectionString: h.db.url, max: 1 });
    try {
      for (let i = 0; i < 60; i += 1) {
        const [ia, ib] = [Math.floor(rnd() * 6), Math.floor(rnd() * 6)];
        if (ia === ib) continue;
        const [ua, ub] = [users[ia], users[ib]];
        const ra = { rating: 900 + Math.floor(rnd() * 1200), games: Math.floor(rnd() * 40) };
        const rb = { rating: 900 + Math.floor(rnd() * 1200), games: Math.floor(rnd() * 40) };
        await h.admin.query(
          `insert into bl.ratings (user_id, discipline, season, rating, games, wins, updated_at) values ($1, 'snooker', 'all', $2, $3, 0, now()), ($4, 'snooker', 'all', $5, $6, 0, now())
           on conflict (user_id, discipline, season) do update set rating = excluded.rating, games = excluded.games, wins = 0`,
          [ua, ra.rating, ra.games, ub, rb.rating, rb.games],
        );
        const aWins = rnd() < 0.5;
        const id = randomUUID();
        await h.admin.query(
          `insert into bl.matches (id, club_id, source, tournament_id, tournament_match_id, discipline, player_a, player_b, score_a, score_b,
                                   status, multiplier_x10, played_at, created_at, updated_at)
           values ($1, $2, 'tournament', $3, $4, 'snooker', $5, $6, $7, $8, 'confirmed', 15, now(), now(), now())`,
          [id, CLUB_A, randomUUID(), randomUUID(), ua, ub, aWins ? 2 : 1, aWins ? 1 : 2],
        );
        const c = await app.connect();
        try {
          await c.query('set role app_api');
          const { rows } = await c.query('select * from bl.plus_settle_match($1, now())', [id]);
          assert.equal(rows[0].applied, true);
        } finally {
          await c.query('reset role');
          c.release();
        }
        const exp = applyElo(ra, rb, aWins ? 'a' : 'b', { multiplierX10: 15 });
        const hist = await h.q('select user_id, delta, k from bl.rating_history where match_id = $1', [id]);
        assert.equal(hist.find((x) => x.user_id === ua).delta, exp.a.delta, `a: ${JSON.stringify([ra, rb, aWins])}`);
        assert.equal(hist.find((x) => x.user_id === ub).delta, exp.b.delta, `b: ${JSON.stringify([ra, rb, aWins])}`);
        assert.equal(hist.find((x) => x.user_id === ua).k, exp.a.k);
      }
    } finally {
      await app.end();
    }
  });
});

