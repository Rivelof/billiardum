// PoC M4: Бильярдум+ — партии и рейтинг (T22, T23, №136), приватность (№137, №144),
// узкие функции SECURITY DEFINER (0850, 0851).
//
// Всё ниже — проверенные защиты (выдержали), плюс ЗАМЕЧАНИЕ M4-I3: лимит T23 считается по паре,
// поэтому один игрок с несколькими своими учётками в одной оплаченной сессии набирает рейтинг
// (3 засчитанные победы на каждую учётку в сутки). Это не нарушение правил №136 — вопрос к продукту.
//
// Запуск: DATABASE_ADMIN_URL=… node --test --test-concurrency=1 tests/security/m4/plus_attacks.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CLUB_A, CLUB_B, MIN, PHONES, setup, table, TABLE_B } from '../../../server/plus/test/db/harness.mjs';

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

let k = 0;
const nick = (p) => `${p}${(k += 1)}`;

test('выдержало: чужую партию не подтвердить и не оспорить; свою — не «подтвердить второй раз» за соперника', async () => {
  const a = await h.player(nick('Альфа'));
  const b = await h.player(nick('Бета'));
  const x = await h.player(nick('Чужой'));
  const s = await h.session({ resourceId: table(1), players: [a.id, b.id] });
  const m = await h.play(a, b, s, { confirm: false });
  for (const action of ['confirm', 'dispute']) {
    const r = await h.request('POST', `/api/plus/matches/${m.id}/${action}`, { token: x.token, body: { reason: 'хочу' } });
    assert.equal(r.status, 404, `${action} чужим: ${r.text}`);
  }
  const again = await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: a.token });
  assert.equal(again.status, 200);
  assert.equal(again.json.status, 'pending', 'автор не засчитывает партию сам');
  const [row] = await h.q('select status from bl.matches where id = $1', [m.id]);
  assert.equal(row.status, 'pending');
  // Соперник не в сессии — партия сохранена, но не засчитывается.
  const c = await h.request('POST', '/api/plus/matches', { token: a.token, body: { session_id: s, discipline: 'pyramid', opponent_id: x.id, my_score: 8, opponent_score: 0 } });
  assert.equal(c.status, 201);
  assert.equal(c.json.status, 'confirmed');
  assert.equal(c.json.not_counted_reason, 'not_same_session');
  // Сессия, где меня нет, — 404 (в т. ч. чужого клуба).
  const sb = await h.session({ resourceId: TABLE_B, clubId: CLUB_B, players: [b.id, x.id] });
  const r = await h.request('POST', '/api/plus/matches', { token: a.token, body: { session_id: sb, discipline: 'pyramid', opponent_id: b.id, my_score: 8, opponent_score: 0 } });
  assert.equal(r.status, 404);
});

test('выдержало: спор и подтверждение после 30 минут — партия истекла, рейтинг не меняется', async () => {
  const a = await h.player(nick('Ранний'));
  const b = await h.player(nick('Поздний'));
  const s = await h.session({ resourceId: table(2), players: [a.id, b.id] });
  const m = await h.play(a, b, s, { confirm: false });
  h.clock.add(31 * MIN);
  const d = await h.request('POST', `/api/plus/matches/${m.id}/dispute`, { token: b.token, body: { reason: 'не так' } });
  assert.equal(d.status, 200);
  assert.equal(d.json.status, 'expired');
  const c = await h.request('POST', `/api/plus/matches/${m.id}/confirm`, { token: b.token });
  assert.equal(c.status, 409);
  assert.equal(await h.rating(a.id), null);
});

test('выдержало: T23 под гонкой — 4 партии пары в 4 сессиях подтверждаются параллельно, засчитано ровно 3', async () => {
  const a = await h.player(nick('Гонка'));
  const b = await h.player(nick('Пара'));
  const ids = [];
  for (const t of [1, 2, 3, 4]) {
    const s = await h.session({ resourceId: table(t), players: [a.id, b.id] });
    ids.push((await h.play(a, b, s, { confirm: false })).id);
  }
  const res = await Promise.all(ids.map((id) => h.request('POST', `/api/plus/matches/${id}/confirm`, { token: b.token })));
  for (const r of res) assert.equal(r.status, 200, r.text);
  const rows = await h.q('select status, reject_reason from bl.matches where id = any($1::uuid[])', [ids]);
  assert.equal(rows.filter((x) => x.status === 'counted').length, 3);
  assert.equal(rows.filter((x) => x.reject_reason === 'pair_daily_limit').length, 1);
  assert.equal((await h.rating(a.id)).games, 3);
});

test('выдержало: решение спора — только owner/manager клуба партии, с причиной; не спор — 409', async () => {
  const a = await h.player(nick('Спор'));
  const b = await h.player(nick('Ответ'));
  const s = await h.session({ resourceId: table(7), players: [a.id, b.id] });
  const m = await h.play(a, b, s, { confirm: false, discipline: 'pool' });
  const reception = await h.login(PHONES.reception);
  const ownerB = await h.login(PHONES.ownerB);
  const manager = await h.login(PHONES.manager);
  let r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, body: { result: 'a', reason: 'рано' } });
  assert.equal(r.status, 409, 'не в споре');
  await h.request('POST', `/api/plus/matches/${m.id}/dispute`, { token: b.token, body: { reason: 'счёт неверный' } });
  r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: reception.token, body: { result: 'a', reason: 'я ресепшн' } });
  assert.equal(r.status, 403);
  r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: ownerB.token, body: { result: 'a', reason: 'чужой клуб' } });
  assert.ok([403, 404].includes(r.status), `владелец B: ${r.status}`);
  r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: a.token, body: { result: 'a', reason: 'я игрок' } });
  assert.equal(r.status, 403);
  r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, body: { result: 'b' } });
  assert.equal(r.json.error, 'reason_required');
  r = await h.request('POST', `/api/plus/matches/${m.id}/resolve`, { token: manager.token, body: { result: 'annul', reason: 'видео' } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await h.audit('plus.match_resolve')).filter((x) => x.object_id === m.id && x.reason === 'видео').length, 1);
});

test('выдержало: приватность — клубы скрыты (show_clubs=false) — нет в таблице клуба, есть в таблице страны; карточка другим без истории', async () => {
  const hidden = await h.player(nick('Скрытый'));
  const open = await h.player(nick('Открытый'));
  await h.request('PATCH', '/api/plus/me', { token: open.token, body: { privacy: { show_clubs: true } } });
  const s = await h.session({ resourceId: table(5), players: [hidden.id, open.id] });
  await h.play(hidden, open, s);
  const club = await h.request('GET', `/api/public/rating?discipline=pyramid&scope=club&club=${CLUB_A}`);
  assert.equal(club.status, 200, club.text);
  const country = await h.request('GET', '/api/public/rating?discipline=pyramid&scope=country');
  const nicksClub = club.json.items.map((x) => x.nick);
  const nicksCountry = country.json.items.map((x) => x.nick);
  assert.ok(!nicksClub.includes(hidden.nick), 'скрывший клубы не в таблице клуба');
  assert.ok(nicksClub.includes(open.nick));
  assert.ok(nicksCountry.includes(hidden.nick));
  for (const it of [...club.json.items, ...country.json.items]) assert.deepEqual(Object.keys(it).sort(), ['games', 'level', 'nick', 'place', 'rating']);
  // Город по названию из bl.public_clubs — тоже без скрывшего.
  const city = await h.request('GET', '/api/public/rating?discipline=pyramid&scope=city&city=ekaterinburg');
  assert.ok(!(city.json.items ?? []).map((x) => x.nick).includes(hidden.nick));
  // Профиль: посторонний видит ник и рейтинг, без истории и достижений; приватность — только сам.
  const viewer = await h.player(nick('Зритель'));
  const card = await h.request('GET', `/api/plus/players/${hidden.nick}`, { token: viewer.token });
  assert.equal(card.status, 200);
  assert.deepEqual(Object.keys(card.json).sort(), ['nick', 'ratings']);
  // Публичный рейтинг кэшируется общим: токен не влияет на ответ, me = null.
  const withToken = await h.request('GET', `/api/public/rating?discipline=pyramid&scope=club&club=${CLUB_A}`, { token: open.token });
  assert.equal(withToken.json.me, null);
});

test('выдержало: «друзья в клубе» — только взаимные друзья и только с разрешения друга', async () => {
  const me = await h.player(nick('Я'));
  const f = await h.player(nick('Друг'));
  const s = await h.session({ resourceId: table(1), players: [f.id] });
  void s;
  // Заявка в одну сторону — не дружба.
  await h.request('POST', '/api/plus/friends', { token: me.token, body: { nick: f.nick } });
  let r = await h.request('GET', '/api/plus/friends', { token: me.token });
  assert.equal(r.json.friends.length, 0);
  await h.request('POST', '/api/plus/friends', { token: f.token, body: { nick: me.nick } });
  r = await h.request('GET', '/api/plus/friends', { token: me.token });
  assert.equal(r.json.friends.length, 1);
  assert.equal(r.json.friends[0].in_club_now, null, 'друг не разрешил');
  await h.request('PATCH', '/api/plus/me', { token: f.token, body: { privacy: { friends_see_in_club: true } } });
  r = await h.request('GET', '/api/plus/friends', { token: me.token });
  assert.ok(r.json.friends[0].in_club_now, 'с разрешения — видно');
  const stranger = await h.player(nick('Чужак'));
  // Узкая функция — только по friendships вошедшего; подмена user_id через тело невозможна (его нет).
  const c = await h.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.user_id', $1, true), set_config('app.actor_type', 'user', true)", [stranger.id]);
    assert.equal((await c.query('select count(*)::int as n from bl.plus_friends_in_club()')).rows[0].n, 0);
    await c.query('rollback');
  } finally {
    c.release();
  }
});

test('выдержало: все SECURITY DEFINER функции схемы bl — с search_path, без EXECUTE у public', async () => {
  const rows = await h.q(`
    select p.proname, p.proconfig, has_function_privilege('public', p.oid, 'execute') as pub
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'bl' and p.prosecdef`);
  assert.ok(rows.length > 20);
  const bad = rows.filter((r) => !(r.proconfig ?? []).some((c) => /^search_path=pg_catalog, ?pg_temp$/.test(c)) || r.pub);
  assert.deepEqual(bad.map((r) => r.proname), [], 'нет definer без search_path или с execute для public');
  // plus_settle_match без двух подтверждений — отказ; pending — ничего не меняет.
  const a = await h.player(nick('Сеттл'));
  const b = await h.player(nick('Сеттлб'));
  const s = await h.session({ resourceId: table(2), players: [a.id, b.id] });
  const m = await h.play(a, b, s, { confirm: false });
  const c = await h.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.user_id', $1, true)", [a.id]);
    const r = await c.query('select * from bl.plus_settle_match($1, now())', [m.id]);
    assert.equal(r.rows[0].applied, false);
    await c.query("select set_config('app.club_id', $1, true)", [CLUB_A]);
    await c.query('savepoint s1');
    await assert.rejects(c.query("update bl.matches set status = 'counted' where id = $1", [m.id]), (e) => e.code === '42501', 'counted — только plus_settle_match');
    await c.query('rollback to savepoint s1');
    await c.query("update bl.matches set status = 'confirmed' where id = $1", [m.id]);
    await assert.rejects(c.query('select * from bl.plus_settle_match($1, now())', [m.id]), (e) => e.code === '55000', 'одного подтверждения мало');
    await c.query('rollback');
  } finally {
    c.release();
  }
});

test('выдержало: приглашения «Сыграем?» — не больше 10 в сутки', async () => {
  const a = await h.player(nick('Зову'));
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const b = await h.player(nick('Зовут'));
    const r = await h.request('POST', '/api/plus/invites', {
      token: a.token,
      body: { to_user_id: b.id, discipline: 'pyramid', club_id: CLUB_A, starts_at: new Date(h.clock.now().getTime() + 120 * MIN).toISOString(), minutes: 60 },
    });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
  assert.equal(statuses[10], 429);
});

test('ЗАМЕЧАНИЕ M4-I3: три своих учётки в одной сессии — 9 засчитанных побед за сутки, рейтинг +', async () => {
  const main = await h.player(nick('Главный'));
  const socks = [await h.player(nick('Кукла')), await h.player(nick('Кукла')), await h.player(nick('Кукла'))];
  const s = await h.session({ resourceId: table(3), players: [main.id, ...socks.map((x) => x.id)] });
  for (const sock of socks) for (let i = 0; i < 3; i += 1) await h.play(main, sock, s);
  const r = await h.rating(main.id);
  console.log(`  главный: партий ${r.games}, рейтинг ${r.rating}`);
  assert.equal(r.games, 9);
  assert.ok(r.rating > 1300);
  void randomUUID;
});
