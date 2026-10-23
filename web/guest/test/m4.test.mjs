import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { notCountedText } from '@billiardum/shared/plus';
import { entryState, filterTournaments, opponents, placesLeft, sortMatches, disciplineOfTable, seasonNow, maskPhones, shownMatchScore, shownTournamentScore, canDispute, clubAnswerState, clubClosedText, parseClubAnswer, peopleWords } from '../src/lib/plus.js';
import { CLUB_REQUEST_LINKS } from '../src/mock/m4.js';
import { matchRoute } from '../src/lib/router.js';
import { isTournamentBusy, tournamentExtendText } from '../src/lib/game.js';
import { BRACKET_MATCH } from '@billiardum/shared/plus';
import { ROUTES } from '../src/lib/routes.js';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const T = Date.parse('2026-10-23T15:00:00Z');
const q = (o) => new URLSearchParams(o);

test('T22/T23 на заглушке: партия подтверждена — рейтинг у обоих; 4-я партия пары за сутки — не засчитана', async () => {
  let now = T;
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('plusgame');
  const session = (await b.handle('GET', '/api/sessions/6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10')).body;
  const me = (await b.handle('GET', '/api/me')).body.user.id;
  const rivals = opponents(session, me);
  assert.equal(rivals.length, 1, 'соперник — участник сессии с user_id');
  for (const p of session.participants) assert.ok('label' in p && 'nick' in p, 'nick и label от light');
  const created = await b.handle('POST', '/api/plus/matches', { session_id: session.id, discipline: 'pyramid', opponent_id: rivals[0].user_id, my_score: 8, opponent_score: 5 });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'pending');
  now += 5000; // соперник в заглушке подтверждает через 4 секунды
  const m = (await b.handle('GET', '/api/plus/matches')).body.items.find((x) => x.id === created.body.id);
  assert.equal(m.status, 'confirmed');
  assert.equal(m.counted, false);
  assert.equal(m.not_counted_reason, 'pair_daily_limit');
  const list = (await b.handle('GET', '/api/plus/matches', undefined, q({ session_id: session.id }))).body.items;
  assert.equal(list.length, 4);
  assert.equal(list.filter((x) => x.counted).length, 3);
});

test('№148 на заглушке: 7-я партия игрока за сутки не засчитана — «лимит партий за сутки», обоим plus.match_not_counted', async () => {
  let now = T;
  const mem = memory();
  const b = createBackend({ ...mem, now: () => now });
  b.scenario('pluslimit');
  const session = (await b.handle('GET', '/api/sessions/6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10')).body;
  const me = (await b.handle('GET', '/api/me')).body.user.id;
  const opp = opponents(session, me)[0];
  const created = (await b.handle('POST', '/api/plus/matches', { session_id: session.id, discipline: 'pyramid', opponent_id: opp.user_id, my_score: 8, opponent_score: 5 })).body;
  now += 5000;
  const m = (await b.handle('GET', '/api/plus/matches')).body.items.find((x) => x.id === created.id);
  assert.equal(m.counted, false);
  assert.equal(m.not_counted_reason, 'player_daily_limit');
  assert.equal(notCountedText(m.not_counted_reason), 'в рейтинг не засчитана — лимит партий за сутки');
  const sent = (mem.load().m4.notifications ?? []).filter((n) => n.kind === 'plus.match_not_counted' && n.data.match_id === created.id);
  assert.deepEqual(sent.map((n) => n.user_id).sort(), [me, opp.user_id].sort());
  assert.equal(sent[0].data.reason, 'player_daily_limit');
  assert.match(sent[0].text, /не засчитана: лимит партий за сутки/);
});

test('T22: обычная партия засчитана — рейтинг меняется у обоих', async () => {
  let now = T;
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('game');
  const session = (await b.handle('GET', '/api/sessions/6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10')).body;
  const me = (await b.handle('GET', '/api/me')).body.user.id;
  const opp = opponents(session, me)[0];
  const before = (await b.handle('GET', '/api/plus/me')).body.ratings.find((r) => r.discipline === 'pyramid').rating;
  const created = (await b.handle('POST', '/api/plus/matches', { session_id: session.id, discipline: 'pyramid', opponent_id: opp.user_id, my_score: 8, opponent_score: 5 })).body;
  now += 5000;
  const m = (await b.handle('GET', '/api/plus/matches')).body.items.find((x) => x.id === created.id);
  assert.equal(m.counted, true);
  assert.equal(m.rating_delta[me] + m.rating_delta[opp.user_id], 0);
  const after = (await b.handle('GET', '/api/plus/me')).body.ratings.find((r) => r.discipline === 'pyramid').rating;
  assert.equal(after - before, m.rating_delta[me]);
});

test('T24 на заглушке: рейтинг выше лимита — 409 rating_above_limit { limit, rating }; запись со взносом — оплата', async () => {
  const b = createBackend({ ...memory(), now: () => T });
  b.scenario('tour');
  const list = (await b.handle('GET', '/api/public/tournaments')).body.items;
  const limited = list.find((t) => t.rating_limit);
  const res = await b.handle('POST', `/api/tournaments/${limited.id}/entries`, {});
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'rating_above_limit', limit: 1300, rating: 1352 });
  const open = list.find((t) => t.status === 'registration' && !t.rating_limit);
  const e = await b.handle('POST', `/api/tournaments/${open.id}/entries`, {});
  assert.equal(e.body.status, 'pending_payment');
  const pid = e.body.confirmation.url.split('/').pop();
  assert.ok(b.confirm(pid, true));
  const mine = (await b.handle('GET', `/api/tournaments/${open.id}/me`)).body;
  assert.equal(entryState({ ...open, status: 'registration' }, mine), 'entered');
  const running = list.find((t) => t.status === 'running');
  const full = (await b.handle('GET', `/api/public/tournaments/${running.id}`)).body;
  assert.ok(full.bracket.rounds.length >= 2);
  for (const r of full.bracket.rounds) for (const m of r.matches) assert.ok(!('a_id' in m), 'без внутренних id в публичной сетке');
  const my = (await b.handle('GET', `/api/tournaments/${running.id}/me`)).body.match;
  assert.ok(my && my.opponent_nick);
});

test('T25 на заглушке: заявка в клуб без программы — 15 минут без ответа → оператору', async () => {
  let now = T;
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('plus');
  const id = 'c1000000-0000-4000-8000-000000000001';
  assert.equal((await b.handle('GET', `/api/public/listings/${id}`)).body.status, 'listed');
  const r = await b.handle('POST', '/api/clubs/requests', { listing_id: id, starts_at: new Date(T + 3600000).toISOString(), minutes: 120, people: 2 });
  assert.equal(r.body.status, 'sent');
  now += 16 * 60000;
  assert.equal((await b.handle('GET', `/api/clubs/requests/${r.body.id}`)).body.status, 'operator');
});

test('экранная логика Бильярдум+ и турниров', () => {
  assert.equal(disciplineOfTable('billiard_pool'), 'pool');
  assert.equal(disciplineOfTable('billiard_pyramid'), 'pyramid');
  assert.match(seasonNow(T), /^2026-10$/);
  assert.equal(placesLeft({ places: 16, entries_count: 13 }), 3);
  assert.equal(entryState({ status: 'registration', places: 2, entries_count: 2 }, null), 'full');
  assert.equal(entryState({ status: 'running' }, null), 'closed');
  assert.equal(filterTournaments([{ status: 'finished' }, { status: 'registration' }], 'past').length, 1);
  const me = 'a';
  const ms = sortMatches(
    [
      { id: 1, status: 'confirmed', created_at: '2026-10-23T10:00:00Z', players: [{ user_id: 'a', confirmed: true }] },
      { id: 2, status: 'pending', created_at: '2026-10-23T09:00:00Z', players: [{ user_id: 'a', confirmed: false }] },
    ],
    me,
  );
  assert.equal(ms[0].id, 2, 'ждущие моего подтверждения — первыми');
  assert.equal(maskPhones('звоните +7 912 345-67-89'), 'звоните ***');
  assert.equal(opponents({ participants: [{ user_id: 'a' }, { user_id: 'b', nick: null, label: 'Игрок 2' }] }, 'a')[0].nick, 'Игрок 2');
});

test('«Добавить клуб» и «Подтвердить клуб» на заглушке: заявка оператору, повтор подтверждения — already_claimed', async () => {
  const b = createBackend({ ...memory(), now: () => T });
  b.scenario('plus');
  const add = await b.handle('POST', '/api/directory/add', { city: 'Пермь', name: 'Луза', address: 'ул. Ленина, 10' });
  assert.deepEqual([add.status, add.body.status], [201, 'new']);
  assert.equal((await b.handle('POST', '/api/directory/add', { city: 'Пермь' })).body.error, 'bad_request');
  assert.equal((await b.handle('POST', '/api/directory/claim', { listing_id: 'c1000000-0000-4000-8000-000000000001' })).status, 201);
  assert.equal((await b.handle('POST', '/api/directory/claim', { listing_id: 'c1000000-0000-4000-8000-000000000002' })).body.error, 'already_claimed');
});

test('M4-3 на заглушке: подтверждается показанный счёт; соперник переписал — 409 score_changed, свежий счёт, повтор проходит', async () => {
  const b = createBackend({ ...memory(), now: () => T });
  b.scenario('plusrace');
  const me = (await b.handle('GET', '/api/me')).body.user.id;
  const pending = (await b.handle('GET', '/api/plus/matches')).body.items.find((x) => x.status === 'pending');
  assert.ok(pending, 'партия Андрея ждёт подтверждения');
  const seen = shownMatchScore(pending);
  assert.deepEqual(seen, { score_a: 8, score_b: 5 });
  const raced = await b.handle('POST', `/api/plus/matches/${pending.id}/confirm`, seen);
  assert.equal(raced.status, 409);
  assert.deepEqual(raced.body, { error: 'score_changed' });
  const fresh = (await b.handle('GET', '/api/plus/matches')).body.items.find((x) => x.id === pending.id);
  assert.equal(fresh.status, 'pending', 'партия не подтверждена');
  assert.deepEqual(shownMatchScore(fresh), { score_a: 8, score_b: 3 });
  const ok = await b.handle('POST', `/api/plus/matches/${pending.id}/confirm`, shownMatchScore(fresh));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.players.find((p) => p.user_id === me).confirmed, true);

  // Матч турнира: внесённый счёт подтверждается только тем же счётом
  b.scenario('tour');
  const running = (await b.handle('GET', '/api/public/tournaments')).body.items.find((t) => t.status === 'running');
  const my = (await b.handle('GET', `/api/tournaments/${running.id}/me`)).body.match;
  const id = encodeURIComponent(my.id);
  assert.equal((await b.handle('POST', `/api/tournaments/matches/${id}/score`, { score_a: 2, score_b: 1 })).status, 200);
  const shown = shownTournamentScore((await b.handle('GET', `/api/tournaments/${running.id}/me`)).body.match);
  assert.deepEqual(shown, { score_a: 2, score_b: 1 });
  const bad = await b.handle('POST', `/api/tournaments/matches/${id}/confirm`, { score_a: 1, score_b: 2 });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, 'score_changed');
  assert.equal((await b.handle('POST', `/api/tournaments/matches/${id}/confirm`, shown)).status, 200);
});

test('M4-3: показанный счёт для подтверждения — партия и матч турнира', () => {
  assert.deepEqual(shownMatchScore({ players: [{ score: 8 }, { score: 6 }] }), { score_a: 8, score_b: 6 });
  assert.deepEqual(shownMatchScore(null), { score_a: null, score_b: null });
  // Подтверждаю соперника — его отчёт; ждём соперника — свой; отчётов нет — счёт матча
  assert.deepEqual(shownTournamentScore({ i_confirmed: false, opponent_report: { score_a: 1, score_b: 3, at: 'x' }, my_report: null, score_a: null, score_b: null }), { score_a: 1, score_b: 3 });
  assert.deepEqual(shownTournamentScore({ i_confirmed: true, my_report: { score_a: 3, score_b: 2 }, opponent_report: null }), { score_a: 3, score_b: 2 });
  assert.deepEqual(shownTournamentScore({ i_confirmed: false, opponent_report: null, score_a: 3, score_b: 0 }), { score_a: 3, score_b: 0 });
});

test('Д4: «Счёт неверный» — только у партии pending и только тому, кто её ещё не подтвердил', () => {
  const me = 'u-me';
  const m = (status, confirmed) => ({ status, players: [{ user_id: me, confirmed }, { user_id: 'u-2', confirmed: true }] });
  assert.equal(canDispute(m('pending', false), me), true);
  assert.equal(canDispute(m('pending', true), me), false, 'уже подтвердил — ждёт соперника');
  assert.equal(canDispute(m('confirmed', true), me), false, 'подтверждённую не оспорить (409 match_not_pending)');
  assert.equal(canDispute(m('confirmed', false), me), false);
  assert.equal(canDispute(m('disputed', false), me), false);
  assert.equal(canDispute(m('pending', false), 'u-chuzhoy'), false, 'не участник');
  assert.equal(canDispute(null, me), false);
});

test('Д1: маршрут ссылки клуба /app/club-request/{id}?t= и состояние экрана ответа', () => {
  assert.deepEqual(matchRoute('/app/club-request/c3000000-0000-4000-8000-000000000001', ROUTES, '/app/'), { name: 'clubanswer', params: { id: 'c3000000-0000-4000-8000-000000000001' } });
  const nf = { code: 'not_found' };
  assert.equal(clubAnswerState({ token: 'x', request: undefined }), 'loading');
  assert.equal(clubAnswerState({ token: 'x', request: { status: 'sent' } }), 'open');
  assert.equal(clubAnswerState({ token: 'x', request: { status: 'operator' } }), 'open', 'после передачи оператору ответить ещё можно');
  assert.equal(clubAnswerState({ token: 'x', request: { status: 'sent' }, answered: true }), 'open', 'открытая заявка с сервера важнее отметки');
  assert.equal(clubAnswerState({ token: 'x', request: null, error: nf, answered: true }), 'answered', 'повторный вход после ответа');
  assert.equal(clubAnswerState({ token: 'x', request: null, answered: true }), 'answered', 'сразу после ответа');
  assert.equal(clubAnswerState({ token: 'x', request: undefined, answered: true }), 'loading', 'сначала спрашиваем сервер');
  assert.equal(clubAnswerState({ token: 'x', request: null, error: { code: 'network' }, answered: true }), 'error');
  const rc = (status) => ({ code: 'request_closed', data: { status } });
  assert.equal(clubAnswerState({ token: 'x', request: null, error: rc('accepted') }), 'closed', 'ответили с другого устройства');
  assert.equal(clubAnswerState({ token: 'x', request: null, error: rc('declined'), answered: true }), 'answered', 'ответили здесь — с отметкой');
  assert.equal(clubClosedText('accepted').title, 'На заявку уже ответили');
  assert.equal(clubClosedText('declined').title, 'На заявку уже ответили');
  assert.equal(clubClosedText('operator').title, 'Заявка у оператора');
  assert.equal(clubClosedText('closed').title, 'Заявка закрыта');
  assert.equal(clubClosedText(undefined).title, 'Заявка закрыта');
  assert.equal(clubAnswerState({ token: 'x', request: null, error: nf }), 'invalid', 'неверный или просроченный токен');
  assert.equal(clubAnswerState({ token: null }), 'invalid', 'ссылка без токена');
  assert.equal(clubAnswerState({ token: 'x', request: { status: 'accepted' } }), 'closed');
  assert.equal(clubAnswerState({ token: 'x', request: null, error: { code: 'network' } }), 'error');
  assert.deepEqual(parseClubAnswer('{"decision":"accept","at":"2026-10-23T15:00:00.000Z"}'), { decision: 'accept', at: '2026-10-23T15:00:00.000Z' });
  assert.equal(parseClubAnswer('{"decision":"maybe"}'), null);
  assert.equal(parseClubAnswer('не json'), null);
  assert.equal(parseClubAnswer(null), null);
  assert.equal(peopleWords(1), '1 человек');
  assert.equal(peopleWords(4), '4 человека');
  assert.equal(peopleWords(5), '5 человек');
});

test('Д1 на заглушке: заявка по токену без входа с поясом клуба, повторный ответ — 409 request_closed {status}, чужой токен — 404', async () => {
  let now = T;
  const b = createBackend({ ...memory(), now: () => now });
  b.scenario('clubrequest');
  const [a, op] = CLUB_REQUEST_LINKS;
  assert.equal((await b.handle('GET', `/api/clubs/requests/${a.id}/answer`, undefined, q({ t: 'wrong-token-0000000000000' }))).status, 404);
  assert.equal((await b.handle('GET', `/api/clubs/requests/${a.id}/answer`, undefined, q({ t: op.token }))).status, 404, 'токен другой заявки');
  const got = await b.handle('GET', `/api/clubs/requests/${a.id}/answer`, undefined, q({ t: a.token }));
  assert.equal(got.status, 200);
  assert.equal(got.body.status, 'sent');
  assert.equal(got.body.people, 4);
  assert.equal(got.body.minutes, 120);
  assert.ok(got.body.guest_phone, 'телефон гостя — клубу нужно связаться');
  assert.equal(got.body.timezone, 'Asia/Yekaterinburg', 'время — по поясу клуба');
  assert.equal((await b.handle('POST', `/api/clubs/requests/${a.id}/answer`, { t: a.token, decision: 'maybe' })).status, 400);
  const ans = await b.handle('POST', `/api/clubs/requests/${a.id}/answer`, { t: a.token, decision: 'accept', text: 'Ждём, стол 3' });
  assert.equal(ans.status, 200);
  assert.equal(ans.body.status, 'accepted');
  assert.equal(ans.body.answer_text, 'Ждём, стол 3');
  const again = await b.handle('GET', `/api/clubs/requests/${a.id}/answer`, undefined, q({ t: a.token }));
  assert.deepEqual([again.status, again.body], [409, { error: 'request_closed', status: 'accepted' }], 'повторный вход — уже ответили');
  const twice = await b.handle('POST', `/api/clubs/requests/${a.id}/answer`, { t: a.token, decision: 'decline' });
  assert.deepEqual([twice.status, twice.body.status], [409, 'accepted'], 'второй ответ не принимается');
  assert.equal((await b.handle('GET', `/api/clubs/requests/${op.id}/answer`, undefined, q({ t: op.token }))).body.status, 'operator');
  now += 25 * 60 * 60_000;
  assert.equal((await b.handle('GET', `/api/clubs/requests/${op.id}/answer`, undefined, q({ t: op.token }))).status, 404, 'через 24 часа ссылка не работает');
});

test('№150 на заглушке: запись на турнир без ника — 409 no_profile, после ника — запись', async () => {
  const b = createBackend({ ...memory(), now: () => T });
  b.scenario('plusnew');
  const open = (await b.handle('GET', '/api/public/tournaments')).body.items.find((t) => t.status === 'registration' && !t.rating_limit);
  const no = await b.handle('POST', `/api/tournaments/${open.id}/entries`, {});
  assert.equal(no.status, 409);
  assert.equal(no.body.error, 'no_profile');
  assert.equal((await b.handle('PATCH', '/api/plus/me', { nick: 'Новичок_1' })).status, 200);
  const yes = await b.handle('POST', `/api/tournaments/${open.id}/entries`, {});
  assert.equal(yes.status, 201);
});

test('№146: продление на столе турнира — «Продлить нельзя: на столе турнир с HH:MM»; матч canceled — «Отменён»', () => {
  const fmt = (x) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(x));
  const busy = { code: 'table_busy', data: { reason: 'tournament', busy_until: '2026-10-23T23:00:00Z' } };
  assert.equal(isTournamentBusy(busy), true);
  assert.equal(isTournamentBusy({ code: 'table_busy', data: {} }), false, 'стол занят не турниром — обычный текст');
  assert.equal(tournamentExtendText({ code: 'booking_conflict' }, {}, fmt), null);
  // Предел продления 18:55 — турнир с 19:00; оплачено до 18:00 — можно продлить до 18:55
  const s = { paid_until: '2026-10-23T18:00:00Z', extend_limit_until: '2026-10-23T18:55:00Z' };
  const t = tournamentExtendText(busy, s, fmt);
  assert.equal(t.title, 'Продлить нельзя: на столе турнир с 19:00.');
  assert.match(t.action, /только до 18:55/);
  assert.match(tournamentExtendText(busy, { ...s, paid_until: '2026-10-23T18:55:00Z' }, fmt).action, /Доиграйте оплаченное время/);
  assert.equal(tournamentExtendText(busy, { paid_until: s.paid_until }, fmt).title, 'Продлить нельзя: стол занят турниром до 23:00.', 'предела нет — до конца занятости');
  assert.equal(BRACKET_MATCH.canceled, 'Отменён');
});
