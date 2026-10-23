import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { entryState, filterTournaments, opponents, placesLeft, sortMatches, disciplineOfTable, seasonNow, maskPhones } from '../src/lib/plus.js';

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
