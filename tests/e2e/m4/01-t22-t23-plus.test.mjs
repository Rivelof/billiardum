// T22, T23 и Бильярдум+: партия двух игроков одной сессии стола (E2E_PLUS_TABLE, по умолчанию 1),
// подтверждение без персонала, пересчёт Эло у обоих; четвёртая партия пары за рабочие сутки — не
// засчитана (pair_daily_limit); соперник не из сессии — not_same_session; спор (только pending) →
// управляющий решает с причиной; публичные таблицы и приватность профиля; отзывы (только после
// игры, маскирование телефонов, ответ клуба, жалоба → оператор скрывает с причиной).
//
// Играет одна настоящая сессия (СБП в эмуляторе ЮKassa, свет в симуляторе), в конце гость
// завершает игру. Гости — синтетические +7999…, ники e2e_…

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditAny,
  brief2,
  CLUB_A,
  ensureFree,
  flat,
  newGuest,
  ok,
  phonesIn,
  platform,
  PLATFORM_IDS,
  plusMe,
  plusProfile,
  ratingOf,
  session,
  sim,
  staff,
  startGame,
  tableCode,
  waitFor,
  waitNotification,
  waitSim,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_PLUS_TABLE || 1);
let db;
const P = {}; // игроки
const M = {}; // партии
let game;

before(async () => {
  db = await adminClient();
  await ensureFree(TABLE);
});

after(async () => {
  if (game?.sessionId) {
    const r = await api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} });
    if (r.status !== 200) console.log(`стоп сессии: ${brief2(r)}`);
  }
  await db?.end();
});

function match(guest, body) {
  return api('POST', '/api/plus/matches', { token: guest.token, body: { session_id: game.sessionId, discipline: 'pyramid', ...body } });
}

test('подготовка: профили, игра на столе, второй игрок входит по коду стола', async (t) => {
  for (const k of ['A', 'B', 'C', 'D']) P[k] = await newGuest();
  const me0 = await plusMe(P.A);
  assert.equal(me0.nick, null, 'профиль по умолчанию без ника');
  await plusProfile(P.A);
  // Ник: занятый (без учёта регистра) — 409, с телефоном/7 цифрами — 400.
  const taken = await api('PATCH', '/api/plus/me', { token: P.B.token, body: { nick: P.A.nick.toUpperCase() } });
  assert.equal(taken.status, 409);
  assert.equal(taken.json.error, 'nick_taken');
  const digits = await api('PATCH', '/api/plus/me', { token: P.B.token, body: { nick: 'p79991234567' } });
  assert.equal(digits.status, 400, 'ник с 11 цифрами — 400');
  await plusProfile(P.B);
  await plusProfile(P.C);

  game = await startGame(TABLE, 60, { guest: P.A });
  await waitSim(TABLE, (x) => x.state?.relay === true, { what: `свет стола ${TABLE}` });
  const noCode = await api('POST', `/api/sessions/${game.sessionId}/join`, { token: P.B.token, body: {} });
  assert.equal(noCode.status, 400);
  const wrongCode = await api('POST', `/api/sessions/${game.sessionId}/join`, { token: P.B.token, body: { code: tableCode(TABLE === 1 ? 2 : 1) } });
  assert.equal(wrongCode.status, 404);
  await ok(api('POST', `/api/sessions/${game.sessionId}/join`, { token: P.B.token, body: { code: tableCode(TABLE) } }));
  const s = await session(P.A.token, game.sessionId);
  const ids = s.participants.map((p) => p.user_id);
  assert.ok(ids.includes(P.A.user.id) && ids.includes(P.B.user.id));
  assert.equal(s.participants.find((p) => p.user_id === P.B.user.id).nick, P.B.nick);
  t.diagnostic(`ники ${P.A.nick}, ${P.B.nick}, ${P.C.nick}; занятый ник в другом регистре — 409 nick_taken, 11 цифр — 400; сессия ${game.sessionId.slice(0, 8)} стол ${TABLE}, свет relay=true; вход без кода — 400, чужой код — 404; участники: ${s.participants.map((p) => p.nick ?? p.label).join(', ')}`);
});

test('T22: партия 8:5, соперник подтверждает — рейтинг пересчитан у обоих', async (t) => {
  assert.ok(game, 'нужна сессия');
  const noProfile = await match(P.A, { opponent_id: P.D.user.id, my_score: 8, opponent_score: 5 });
  assert.equal(noProfile.status, 409, `соперник без профиля: ${brief2(noProfile)}`);
  const bad = [
    [{ opponent_id: P.B.user.id, my_score: 7, opponent_score: 5 }, 400, 'в пирамиде у победителя 8'],
    [{ opponent_id: P.B.user.id, my_score: 8, opponent_score: 8 }, 400, 'ничья'],
    [{ opponent_id: P.B.user.id, my_score: 8, opponent_score: 5, discipline: 'pool' }, 400, 'дисциплина не стола'],
    [{ opponent_id: P.A.user.id, my_score: 8, opponent_score: 5 }, 400, 'сам с собой'],
  ];
  for (const [body, code, what] of bad) {
    const r = await match(P.A, body);
    assert.equal(r.status, code, `${what}: ${brief2(r)}`);
  }
  const stranger = await api('POST', '/api/plus/matches', { token: P.C.token, body: { session_id: game.sessionId, discipline: 'pyramid', opponent_id: P.A.user.id, my_score: 8, opponent_score: 0 } });
  assert.equal(stranger.status, 404, 'не участник сессии — 404');

  const t1 = Date.now();
  const r = await match(P.A, { opponent_id: P.B.user.id, my_score: 8, opponent_score: 5 });
  assert.equal(r.status, 201, brief2(r));
  M.m1 = r.json;
  assert.equal(r.json.status, 'pending');
  assert.equal(r.json.players[0].user_id, P.A.user.id);
  assert.equal(r.json.players[0].confirmed, true);
  assert.equal(r.json.players[1].confirmed, false);
  const cu = (new Date(r.json.confirm_until) - new Date(r.json.played_at ?? t1)) / 60_000;
  assert.ok(cu >= 29.9 && cu <= 30.1, `confirm_until через ${cu} мин`);
  const dup = await match(P.A, { opponent_id: P.B.user.id, my_score: 8, opponent_score: 1 });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'duplicate');
  const note = await waitNotification(db, P.B.user.id, 'plus.match_confirm', { since: t1 });
  const foreign = await api('POST', `/api/plus/matches/${M.m1.id}/confirm`, { token: P.C.token, body: {} });
  assert.ok([403, 404].includes(foreign.status), `подтверждение чужим: ${foreign.status}`);
  const stale = await api('POST', `/api/plus/matches/${M.m1.id}/confirm`, { token: P.B.token, body: { score_a: 8, score_b: 4 } });
  assert.equal(stale.status, 409, `подтверждение не того счёта: ${brief2(stale)}`);
  assert.equal(stale.json.error, 'score_changed');
  const tc = Date.now();
  const c = await api('POST', `/api/plus/matches/${M.m1.id}/confirm`, { token: P.B.token, body: { score_a: 8, score_b: 5 } });
  assert.equal(c.status, 200, brief2(c));
  assert.equal(c.json.status, 'confirmed');
  assert.equal(c.json.counted, true);
  assert.equal(c.json.rating_delta[P.A.user.id], 20);
  assert.equal(c.json.rating_delta[P.B.user.id], -20);
  M.m1 = c.json;
  const again = await ok(api('POST', `/api/plus/matches/${M.m1.id}/confirm`, { token: P.B.token, body: {} }));
  assert.equal(again.counted, true, 'повтор подтверждения — тот же ответ');
  const a = await plusMe(P.A);
  const b = await plusMe(P.B);
  assert.equal(ratingOf(a).rating, 1220);
  assert.equal(ratingOf(b).rating, 1180);
  assert.equal(ratingOf(a).games, 1);
  assert.equal(a.history[0].match_id, M.m1.id);
  assert.equal(a.history[0].counted, true);
  assert.equal(a.history[0].delta, 20);
  assert.equal(a.history[0].opponent_nick, P.B.nick);
  const { rows: hist } = await db.query('select user_id, delta, kind from bl.rating_history where match_id = $1 order by delta desc', [M.m1.id]);
  assert.deepEqual(hist.map((h) => Number(h.delta)), [20, -20]);
  const au = await auditAny(db, { actions: ['plus.match_counted'], since: t1, like: M.m1.id });
  assert.equal(au.length, 1);
  const rn = await waitNotification(db, P.A.user.id, 'plus.rating', { since: tc });
  t.diagnostic(`соперник без профиля — 409 ${noProfile.json.error}; 7:5, 8:8, pool на столе пирамиды, сам с собой — 400; не участник — 404; партия pending, confirm_until +30 мин, дубль — 409 duplicate; B получил «${note.text}»; чужой confirm — ${foreign.status}; confirm со счётом 8:4 — 409 score_changed; B подтвердил 8:5 через ${Date.now() - tc} мс: counted, Δ A +20 → 1220, B −20 → 1180; rating_history ${hist.length} строки; журнал plus.match_counted; A «${rn.text}»`);
});

test('T23: четвёртая партия пары за сутки сохранена, но в рейтинг не засчитана', async (t) => {
  assert.ok(M.m1?.counted);
  const results = [];
  for (const [who, mine, theirs] of [['B', 8, 6], ['A', 8, 3], ['A', 8, 7]]) {
    const author = P[who];
    const other = who === 'A' ? P.B : P.A;
    const r = await ok(match(author, { opponent_id: other.user.id, my_score: mine, opponent_score: theirs }), 201);
    const c = await ok(api('POST', `/api/plus/matches/${r.id}/confirm`, { token: other.token, body: {} }));
    results.push(c);
  }
  const [m2, m3, m4] = results;
  assert.equal(m2.counted, true);
  assert.equal(m3.counted, true);
  assert.equal(m4.counted, false, 'четвёртая — не засчитана');
  assert.equal(m4.not_counted_reason, 'pair_daily_limit');
  assert.equal(m4.rating_delta, null);
  const a = await plusMe(P.A);
  const b = await plusMe(P.B);
  const ra = ratingOf(a);
  const rb = ratingOf(b);
  assert.equal(ra.games, 3, 'засчитано три партии');
  assert.equal(rb.games, 3);
  assert.equal(ra.rating + rb.rating, 2400, 'сумма Эло пары сохранилась');
  const h4 = a.history.find((h) => h.match_id === m4.id);
  assert.equal(h4.counted, false);
  assert.equal(h4.not_counted_reason, 'pair_daily_limit');
  const { rows } = await db.query('select count(*)::int as n from bl.rating_history where match_id = $1', [m4.id]);
  assert.equal(rows[0].n, 0);
  M.m4 = m4;
  t.diagnostic(`партии 2–3 засчитаны (Δ ${JSON.stringify(m2.rating_delta)}, ${JSON.stringify(m3.rating_delta)}); 4-я ${m4.id.slice(0, 8)}: status ${m4.status}, counted=false, not_counted_reason=pair_daily_limit, в истории игрока с причиной, rating_history нет; рейтинг A ${ra.rating}, B ${rb.rating}, партий 3/3`);
});

test('№148: седьмая засчитанная партия игрока за сутки — player_daily_limit', async (t) => {
  const Q = {};
  for (const k of ['E', 'F', 'G', 'H']) {
    Q[k] = await newGuest();
    await plusProfile(Q[k]);
    await ok(api('POST', `/api/sessions/${game.sessionId}/join`, { token: Q[k].token, body: { code: tableCode(TABLE) } }));
  }
  const res = [];
  for (const opp of ['F', 'F', 'F', 'G', 'G', 'G', 'H']) {
    const r = await ok(match(Q.E, { opponent_id: Q[opp].user.id, my_score: 8, opponent_score: 3 }), 201);
    const c = await ok(api('POST', `/api/plus/matches/${r.id}/confirm`, { token: Q[opp].token, body: { score_a: 8, score_b: 3 } }));
    res.push(c);
  }
  const counted = res.filter((x) => x.counted).length;
  const last = res.at(-1);
  const me = await plusMe(Q.E);
  const h = me.history.find((x) => x.match_id === last.id);
  const hOpp = (await plusMe(Q.H)).history.find((x) => x.match_id === last.id);
  t.diagnostic(`E: 3 партии с F, 3 с G — засчитано ${counted}; 7-я с H: counted=${last.counted}, not_counted_reason=${last.not_counted_reason}; у E партий ${ratingOf(me).games}; в истории E «${h?.not_counted_reason}», у H «${hOpp?.not_counted_reason}»`);
  assert.equal(counted, 6);
  assert.equal(last.counted, false);
  assert.equal(last.not_counted_reason, 'player_daily_limit');
  assert.equal(ratingOf(me).games, 6);
});

test('соперник не из сессии — партия сохранена с not_same_session', async (t) => {
  const r = await match(P.A, { opponent_id: P.C.user.id, my_score: 8, opponent_score: 0 });
  assert.equal(r.status, 201, brief2(r));
  assert.equal(r.json.counted, false);
  assert.equal(r.json.not_counted_reason, 'not_same_session');
  const c = await api('POST', `/api/plus/matches/${r.json.id}/confirm`, { token: P.C.token, body: {} });
  assert.equal(c.status, 409, `подтверждение не засчитываемой: ${brief2(c)}`);
  const me = await plusMe(P.C);
  assert.equal(ratingOf(me)?.games ?? 0, 0);
  t.diagnostic(`партия с игроком не из сессии: status ${r.json.status}, counted=false, not_same_session; подтверждение — 409 ${c.json.error}; у C партий 0`);
});

test('спор: только pending; управляющий решает с причиной, журнал; ресепшн — 403', async (t) => {
  const t1 = Date.now();
  const late = await api('POST', `/api/plus/matches/${M.m1.id}/dispute`, { token: P.B.token, body: { reason: 'Передумал' } });
  assert.equal(late.status, 409);
  assert.equal(late.json.error, 'match_not_pending');
  const r = await ok(match(P.A, { opponent_id: P.B.user.id, my_score: 8, opponent_score: 2 }), 201);
  const noReason = await api('POST', `/api/plus/matches/${r.id}/dispute`, { token: P.B.token, body: {} });
  const authorDispute = await api('POST', `/api/plus/matches/${r.id}/dispute`, { token: P.A.token, body: { reason: 'сам себе' } });
  const d = await api('POST', `/api/plus/matches/${r.id}/dispute`, { token: P.B.token, body: { reason: 'Счёт был 8:6, а не 8:2' } });
  assert.equal(d.status, 200, brief2(d));
  assert.equal(d.json.status, 'disputed');
  const conf = await api('POST', `/api/plus/matches/${r.id}/confirm`, { token: P.B.token, body: {} });
  assert.equal(conf.status, 409, 'после спора подтвердить нельзя');
  const d2 = await api('POST', `/api/plus/matches/${r.id}/dispute`, { token: P.B.token, body: { reason: 'ещё раз' } });
  assert.equal(d2.status, 200, 'повтор спора — тот же ответ');
  assert.equal(d2.json.status, 'disputed');
  const man = await staff('manager');
  const rec = await staff('reception');
  const on = await waitNotification(db, 'a1000000-0000-4000-8000-000000000001', 'plus.dispute', { since: t1 });
  await waitNotification(db, 'a1000000-0000-4000-8000-000000000003', 'plus.dispute', { since: t1 });
  assert.equal(on.level, 'important');
  const recList = await api('GET', `/api/clubs/${CLUB_A}/plus/disputes`, { token: rec.token });
  assert.equal(recList.status, 403);
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/plus/disputes`, { token: man.token }));
  const item = list.items.find((x) => x.id === r.id);
  assert.ok(item, 'спор в списке клуба');
  assert.equal(item.dispute_reason, 'Счёт был 8:6, а не 8:2');
  assert.equal(item.table_number, TABLE);
  assert.ok(!flat(list).includes(P.B.phone) && !flat(list).includes(P.A.phone), 'без телефонов игроков');
  const recResolve = await api('POST', `/api/plus/matches/${r.id}/resolve`, { token: rec.token, body: { result: 'annul', reason: 'x' }, headers: { 'x-club-id': CLUB_A } });
  assert.equal(recResolve.status, 403);
  const nr = await api('POST', `/api/plus/matches/${r.id}/resolve`, { token: man.token, body: { result: 'annul' } });
  assert.equal(nr.status, 400);
  assert.equal(nr.json.error, 'reason_required');
  const res = await api('POST', `/api/plus/matches/${r.id}/resolve`, { token: man.token, body: { result: 'annul', reason: 'Игроки не договорились, видео нет' } });
  assert.equal(res.status, 200, brief2(res));
  assert.equal(res.json.status, 'resolved');
  assert.equal(res.json.counted, false);
  assert.equal(res.json.not_counted_reason, 'annulled');
  const again = await api('POST', `/api/plus/matches/${r.id}/resolve`, { token: man.token, body: { result: 'a', reason: 'передумал' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'match_not_disputed');
  const au = await auditAny(db, { actions: ['plus.match_dispute', 'plus.match_resolve'], since: t1, like: r.id });
  assert.deepEqual(au.map((x) => x.action), ['plus.match_dispute', 'plus.match_resolve']);
  assert.equal(au[1].reason, 'Игроки не договорились, видео нет');
  t.diagnostic(`спор подтверждённой — 409 match_not_pending; без причины — ${noReason.status}; автором — ${authorDispute.status}; спор B — disputed; confirm после спора — 409; повторный спор — 200 (тот же ответ); владельцу и управляющему (${on.level}) «${on.text}»; список споров: ресепшн 403, управляющий видит причину и стол ${item.table_number}; resolve ресепшном 403, без причины 400 reason_required; annul с причиной → resolved/annulled; повтор — 409 match_not_disputed; журнал ${au.map((x) => `${x.action}${x.reason ? `(${x.reason})` : ''}`).join(', ')}`);
});

test('таблицы рейтинга и приватность профиля (№137, №144)', async (t) => {
  const pub = await ok(api('GET', '/api/public/rating?discipline=pyramid&scope=country&season=all'));
  assert.equal(pub.me, null);
  const row = pub.items.find((x) => x.nick === P.A.nick);
  assert.ok(row, 'игрок в таблице страны');
  assert.deepEqual(Object.keys(row).sort(), ['games', 'level', 'nick', 'place', 'rating']);
  const ids = [P.A.user.id, P.B.user.id];
  assert.ok(!ids.some((id) => flat(pub).includes(id)), 'без user_id');
  const mine = await ok(api('GET', '/api/plus/rating?discipline=pyramid&scope=country&season=all', { token: P.A.token }));
  assert.ok(mine.me?.place >= 1);
  const club0 = await ok(api('GET', `/api/public/rating?discipline=pyramid&scope=club&club=${CLUB_A}&season=all`));
  assert.ok(!club0.items.some((x) => x.nick === P.A.nick), 'клубная таблица — без игрока, скрывшего клубы (№144)');
  const card = await ok(api('GET', `/api/plus/players/${encodeURIComponent(P.A.nick)}`, { token: P.C.token }));
  assert.equal(card.nick, P.A.nick);
  assert.equal(card.history, undefined, 'история скрыта по умолчанию');
  assert.equal(card.achievements, undefined);
  await ok(api('PATCH', '/api/plus/me', { token: P.A.token, body: { privacy: { show_history: true, show_clubs: true } } }));
  const card2 = await ok(api('GET', `/api/plus/players/${encodeURIComponent(P.A.nick)}`, { token: P.C.token }));
  t.diagnostic(`карточка после show_history: ${JSON.stringify(card2).slice(0, 600)}`);
  assert.ok(Array.isArray(card2.history) && card2.history.length >= 3);
  assert.ok(!flat(card2).includes(P.A.phone) && !flat(card2).includes(P.B.phone));
  t.diagnostic(`страна: ${P.A.nick} место ${row.place}, поля ${Object.keys(row).join(',')}, me=null без входа; /api/plus/rating me.place=${mine.me.place}; клуб без show_clubs — игрока нет; карточка чужому: ник, рейтинг, без истории; после show_history — история ${card2.history.length} партий, ник соперника ${card2.history[0].opponent_nick ?? 'скрыт'}`);
});

test('отзывы: только после игры, один на гостя, маскирование телефонов, ответ клуба, жалоба → оператор', async (t) => {
  const t1 = Date.now();
  const no = await api('POST', '/api/reviews', { token: P.D.token, body: { club_id: CLUB_A, rating: 5, text: 'Не играл' } });
  assert.equal(no.status, 403);
  assert.equal(no.json.error, 'review_not_allowed');
  const big = await api('POST', '/api/reviews', { token: P.A.token, body: { club_id: CLUB_A, rating: 6, text: 'x' } });
  assert.equal(big.status, 400);
  const long = await api('POST', '/api/reviews', { token: P.A.token, body: { club_id: CLUB_A, rating: 4, text: 'я'.repeat(1001) } });
  assert.equal(long.status, 400);
  const text = 'Хорошие столы. Админ: +7 912 345-67-89, 8 (912) 345 67 89, 89123456789, +7.912.345.67.81, 8/912/345/67/82, +7\u200b912\u200b345\u200b67\u200b83';
  const r1 = await api('POST', '/api/reviews', { token: P.A.token, body: { club_id: CLUB_A, rating: 4, text } });
  assert.equal(r1.status, 200, brief2(r1));
  const r2 = await ok(api('POST', '/api/reviews', { token: P.A.token, body: { club_id: CLUB_A, rating: 5, text: `${text} Обновлено.` } }));
  assert.equal(r2.id, r1.json.id, 'повтор — изменение того же отзыва');
  const { rows } = await db.query('select count(*)::int as n, max(text) as text from bl.reviews where club_id = $1 and user_id = $2', [CLUB_A, P.A.user.id]);
  assert.equal(rows[0].n, 1);
  const stored = rows[0].text;
  const leftInDb = phonesIn(stored);
  const man = await staff('manager');
  const rec = await staff('reception');
  const recReply = await api('POST', `/api/reviews/${r2.id}/reply`, { token: rec.token, body: { text: 'Спасибо' } });
  assert.equal(recReply.status, 403, 'ресепшн не отвечает на отзывы');
  await ok(api('POST', `/api/reviews/${r2.id}/reply`, { token: man.token, body: { text: 'Спасибо! Звоните 8 912 000 11 22' } }));
  const clubList = await ok(api('GET', `/api/clubs/${CLUB_A}/reviews`, { token: man.token }));
  const mineInClub = clubList.items.find((x) => x.id === r2.id);
  assert.ok(mineInClub);
  const pub = await waitFor(
    async () => {
      const x = await api('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
      const it = x.json?.reviews?.items?.find((y) => y.id === r2.id);
      return it?.reply ? { page: x.json, it } : null;
    },
    { timeoutMs: 75_000, intervalMs: 3000, what: 'отзыв с ответом на публичной странице клуба (кэш 60 с)' },
  );
  const pubPhones = phonesIn(flat(pub.it));
  // Жалоба → оператор скрывает с причиной.
  const rep = await api('POST', `/api/reviews/${r2.id}/report`, { token: P.C.token, body: { reason: 'В отзыве телефон' } });
  assert.equal(rep.status, 200, brief2(rep));
  const opNote = await waitNotification(db, PLATFORM_IDS.operator, 'platform.review_report', { since: t1 });
  const op = await platform('operator');
  const reports = await ok(api('GET', '/api/platform/reports?status=new', { token: op.token }));
  const report = reports.items.find((x) => x.review.id === r2.id);
  assert.ok(report);
  const noReason = await api('PATCH', `/api/platform/reports/${report.id}`, { token: op.token, body: { action: 'hide' } });
  assert.equal(noReason.status, 400);
  await ok(api('PATCH', `/api/platform/reports/${report.id}`, { token: op.token, body: { action: 'hide', reason: 'e2e: телефон в тексте' } }));
  const hidden = await waitFor(
    async () => {
      const x = await api('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
      return x.status === 200 && !x.json.reviews.items.some((y) => y.id === r2.id) ? x.json : null;
    },
    { timeoutMs: 75_000, intervalMs: 3000, what: 'скрытый отзыв пропал со страницы клуба' },
  );
  const au = await auditAny(db, { actions: ['platform.review_hide', 'platform.report_hide', 'platform.review_report'], since: t1 });
  t.diagnostic(`без игры — 403 review_not_allowed; оценка 6 и 1001 символ — 400; повтор — тот же отзыв (1 строка); в базе «${stored}»; на сайте «${pub.it.text}», ответ «${pub.it.reply.text}», author_nick ${pub.it.author_nick}; ресепшн reply — 403; жалоба → оператору «${opNote.text}»; hide без причины — 400, с причиной — пропал со страницы (${hidden.reviews.count} отзывов); журнал ${au.map((x) => x.action).join(', ') || 'нет записей platform.*review*'}`);
  assert.deepEqual(leftInDb, [], `телефоны в тексте отзыва не замаскированы: ${leftInDb.join(' | ')}`);
  assert.deepEqual(pubPhones, [], `телефоны на публичной странице: ${pubPhones.join(' | ')}`);
});

test('стол свободен после игры', async (t) => {
  const r = await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: P.A.token, body: {} }));
  game.sessionId = null;
  const s = await waitSim(TABLE, (x) => x.state?.mode === 'free' && x.state?.relay === false, { what: 'стол свободен' });
  t.diagnostic(`стоп: ${r.status ?? 'ok'}; симулятор ${s.state.mode} relay=${s.state.relay}; ${JSON.stringify((await sim(TABLE)).state?.mode)}`);
});
