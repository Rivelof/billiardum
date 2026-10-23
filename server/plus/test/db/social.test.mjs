// Профиль и приватность, таблицы рейтинга, друзья, «Ищу соперника», «Сыграем?», достижения.
// DATABASE_ADMIN_URL обязателен; без него файл пропускается.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, CLUB_B, MIN, setup, table, TABLE_B, T0 } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('Бильярдум+: профиль, рейтинг, друзья, соперники, достижения', { skip, concurrency: false }, () => {
  let h;
  let a;
  let b;
  before(async () => {
    h = await setup();
    a = await h.player('Ann');
    b = await h.player('Boris');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(1) });
    await h.play(a, b, s, { my: 8, opp: 0 });
  });
  after(async () => {
    await h?.close();
  });

  it('профиль: ник уникален без учёта регистра, телефон в нике нельзя, приватность по умолчанию закрыта', async () => {
    const u = await h.player('x', { profile: false });
    const me0 = await h.request('GET', '/api/plus/me', { token: u.token });
    assert.equal(me0.json.nick, null);
    assert.deepEqual(me0.json.privacy, { show_history: false, show_achievements: false, show_clubs: false, friends_see_in_club: false });
    assert.equal(me0.json.ratings.length, 3);
    assert.equal((await h.request('PATCH', '/api/plus/me', { token: u.token, body: { nick: 'ANN' } })).json.error, 'nick_taken');
    assert.equal((await h.request('PATCH', '/api/plus/me', { token: u.token, body: { nick: '89991234567' } })).status, 400);
    assert.equal((await h.request('PATCH', '/api/plus/me', { token: u.token, body: { privacy: { show_history: true } } })).status, 400, 'без ника профиль не создаётся');
    assert.equal((await h.request('PATCH', '/api/plus/me', { token: u.token, body: { nick: 'Third', phone: '+7999' } })).status, 400);
    const ok = await h.request('PATCH', '/api/plus/me', { token: u.token, body: { nick: 'Third', privacy: { show_achievements: true } } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.nick, 'Third');
    assert.equal(ok.json.privacy.show_achievements, true);
    const rn = await h.request('PATCH', '/api/plus/me', { token: u.token, body: { nick: 'Third_2' } });
    assert.equal(rn.json.nick, 'Third_2');
  });

  it('карточка другого игрока: ник, уровень, рейтинг; история и достижения — только по выбору игрока', async () => {
    const card = await h.request('GET', '/api/plus/players/ann', { token: b.token });
    assert.equal(card.status, 200);
    assert.deepEqual(Object.keys(card.json).sort(), ['nick', 'ratings']);
    assert.equal(card.json.nick, 'Ann');
    assert.deepEqual(card.json.ratings.find((r) => r.discipline === 'pyramid'), { discipline: 'pyramid', rating: 1220, games: 1, level: 'amateur', season_rating: 1220 });
    assert.equal(JSON.stringify(card.json).includes('+7'), false, 'телефона нет');
    assert.equal((await h.request('GET', '/api/plus/players/nobody', { token: b.token })).status, 404);

    await h.request('PATCH', '/api/plus/me', { token: a.token, body: { privacy: { show_history: true, show_achievements: true } } });
    const open = await h.request('GET', '/api/plus/players/Ann', { token: b.token });
    assert.equal(open.json.history.length, 1);
    assert.equal(open.json.history[0].opponent_nick, 'Boris', 'сопернику — его собственный ник');
    assert.equal(open.json.history[0].club_name, null, 'клубы скрыты (show_clubs)');
    assert.deepEqual(open.json.achievements.map((x) => x.code), ['dry']);
    const stranger = await h.player('Stranger');
    const third = await h.request('GET', '/api/plus/players/Ann', { token: stranger.token });
    assert.equal(third.json.history[0].opponent_nick, null, 'ник соперника скрыт: Boris историю не открывал');
    await h.request('PATCH', '/api/plus/me', { token: a.token, body: { privacy: { show_clubs: true } } });
    assert.equal((await h.request('GET', '/api/plus/players/Ann', { token: stranger.token })).json.history[0].club_name, 'Тестовый клуб');
  });

  it('достижение «Сухая» за 8:0 в пирамиде — один раз, с уведомлением', async () => {
    const rows = await h.q('select code from bl.achievements where user_id = $1', [a.id]);
    assert.deepEqual(rows.map((r) => r.code), ['dry']);
    assert.equal((await h.notifications(a.id, 'plus.achievement')).length, 1);
    const s = await h.session({ players: [a.id, b.id], resourceId: table(2) });
    await h.play(a, b, s, { my: 8, opp: 0 });
    assert.equal((await h.notifications(a.id, 'plus.achievement')).length, 1, 'второй раз не выдаётся');
    assert.equal((await h.q("select count(*)::int as n from bl.achievements where user_id = $1 and code = 'dry'", [b.id]))[0].n, 0);
  });

  it('достижения по сессиям: «Завсегдатай», «Пять клубов», «Ночная смена» — после session.closed', async () => {
    const p = await h.player('Night');
    // 5 клубов (тестовый, Б и ещё три), 10 игр в тестовом клубе, 5 из них — в 01:00 по Екатеринбургу.
    const extra = [];
    for (let i = 0; i < 3; i += 1) {
      const club = randomUUID();
      const res = randomUUID();
      await h.admin.query("insert into bl.clubs (id, name, city, timezone) values ($1, $2, 'Казань', 'Europe/Moscow')", [club, `Клуб ${i}`]);
      await h.admin.query("insert into bl.resources (id, club_id, type, number, title) values ($1, $2, 'billiard_pool', 1, 'Стол 1')", [res, club]);
      extra.push({ club, res });
    }
    let last = null;
    for (let i = 0; i < 10; i += 1) {
      const night = i < 5 ? Date.parse('2026-10-20T20:00:00Z') + i * 24 * 60 * MIN : T0 - (i + 1) * 24 * 60 * MIN;
      last = await h.session({ players: [p.id], resourceId: table(3), status: 'closed', startedMs: night, endedMs: night + 60 * MIN });
    }
    await h.session({ players: [p.id], clubId: CLUB_B, resourceId: TABLE_B, status: 'closed', startedMs: T0 - 5 * MIN, endedMs: T0 - MIN });
    for (const e of extra) await h.session({ players: [p.id], clubId: e.club, resourceId: e.res, status: 'closed', startedMs: T0 - 5 * MIN, endedMs: T0 - MIN });
    await h.emit('session.closed', { session_id: last, club_id: CLUB_A });
    await h.drain();
    const codes = (await h.q('select code from bl.achievements where user_id = $1 order by code', [p.id])).map((r) => r.code);
    assert.deepEqual(codes, ['five_clubs', 'night_shift', 'regular']);
    await h.emit('session.closed', { session_id: last, club_id: CLUB_A });
    await h.drain();
    assert.equal((await h.notifications(p.id, 'plus.achievement')).length, 3);
  });

  it('таблицы рейтинга: страна, клуб, город, сезон; только ник, уровень, рейтинг; моё место — вошедшему', async () => {
    const pub = await h.request('GET', '/api/public/rating?discipline=pyramid&scope=country');
    assert.equal(pub.status, 200, pub.text);
    assert.match(pub.headers.get('cache-control') ?? '', /public/);
    assert.equal(pub.json.me, null);
    assert.deepEqual(pub.json.items.map((x) => x.nick), ['Ann', 'Boris']);
    assert.deepEqual(Object.keys(pub.json.items[0]).sort(), ['games', 'level', 'nick', 'place', 'rating']);
    assert.equal(pub.json.items[0].place, 1);
    assert.equal(pub.json.items[0].level, 'amateur');
    // Клуб и город — только игроки, открывшие клубы (№144): Ann открыла (show_clubs), Boris — нет.
    const club = await h.request('GET', `/api/public/rating?discipline=pyramid&scope=club&club=${CLUB_A}`);
    assert.deepEqual(club.json.items.map((x) => x.nick), ['Ann']);
    const clubB = await h.request('GET', `/api/public/rating?discipline=pyramid&scope=club&club=${CLUB_B}`);
    assert.equal(clubB.json.items.length, 0);
    const city = await h.request('GET', '/api/public/rating?discipline=pyramid&scope=city&city=' + encodeURIComponent('Екатеринбург'));
    assert.deepEqual(city.json.items.map((x) => x.nick), ['Ann']);
    const season = await h.request('GET', '/api/public/rating?discipline=pyramid&season=2026-10');
    assert.equal(season.json.items.length, 2);
    const other = await h.request('GET', '/api/public/rating?discipline=pyramid&season=2026-09');
    assert.equal(other.json.items.length, 0);
    assert.equal((await h.request('GET', '/api/public/rating?discipline=chess')).status, 400);
    const mine = await h.request('GET', '/api/plus/rating?discipline=pyramid&limit=1', { token: b.token });
    assert.equal(mine.json.items.length, 1);
    assert.deepEqual(mine.json.me, { place: 2, rating: mine.json.me.rating });
    const mineClub = await h.request('GET', `/api/plus/rating?discipline=pyramid&scope=club&club=${CLUB_A}`, { token: b.token });
    assert.equal(mineClub.json.me, null, 'Boris скрыл клубы — его нет и в своей таблице клуба');
    await h.request('PATCH', '/api/plus/me', { token: b.token, body: { privacy: { show_clubs: true } } });
    const opened = await h.request('GET', `/api/plus/rating?discipline=pyramid&scope=club&club=${CLUB_A}`, { token: b.token });
    assert.deepEqual(opened.json.items.map((x) => x.nick), ['Ann', 'Boris']);
    assert.equal(opened.json.me.place, 2);
    await h.request('PATCH', '/api/plus/me', { token: b.token, body: { privacy: { show_clubs: false } } });
  });

  it('друзья: заявка по нику, встречная — дружба; «в клубе сейчас» только с разрешения друга; удаление', async () => {
    const r1 = await h.request('POST', '/api/plus/friends', { token: a.token, body: { nick: 'boris' } });
    assert.equal(r1.status, 200, r1.text);
    assert.deepEqual(r1.json.outgoing.map((x) => x.nick), ['Boris']);
    assert.equal((await h.notifications(b.id, 'plus.friend_request')).length, 1);
    const inc = await h.request('GET', '/api/plus/friends', { token: b.token });
    assert.deepEqual(inc.json.incoming.map((x) => x.nick), ['Ann']);
    const acc = await h.request('POST', '/api/plus/friends', { token: b.token, body: { nick: 'Ann' } });
    assert.deepEqual(acc.json.friends.map((x) => x.nick), ['Ann']);
    assert.equal(acc.json.incoming.length, 0);

    // Ann играет сейчас; Boris её не видит, пока она не разрешит.
    await h.session({ players: [a.id], resourceId: table(4) });
    let f = await h.request('GET', '/api/plus/friends', { token: b.token });
    assert.equal(f.json.friends[0].in_club_now, null);
    await h.request('PATCH', '/api/plus/me', { token: a.token, body: { privacy: { friends_see_in_club: true } } });
    f = await h.request('GET', '/api/plus/friends', { token: b.token });
    assert.equal(f.json.friends[0].in_club_now.club_name, 'Тестовый клуб');
    // Не друг не видит ничего.
    const s = await h.player('Spy');
    assert.equal((await h.request('GET', '/api/plus/friends', { token: s.token })).json.friends.length, 0);

    const del = await h.request('DELETE', `/api/plus/friends/${a.id}`, { token: b.token });
    assert.equal(del.json.friends.length, 0);
    assert.equal((await h.request('GET', '/api/plus/friends', { token: a.token })).json.friends.length, 0);
    assert.equal((await h.request('POST', '/api/plus/friends', { token: a.token, body: { nick: 'Ann' } })).status, 400, 'себя нельзя');
    assert.equal((await h.request('POST', '/api/plus/friends', { token: a.token, body: { nick: 'ghost' } })).status, 404);
  });

  it('«Ищу соперника»: подбор ±150 по рейтингу дисциплины, общий клуб и пересечение времени', async () => {
    const from = new Date(T0 + 60 * MIN).toISOString();
    const to = new Date(T0 + 180 * MIN).toISOString();
    const c1 = await h.player('Close');
    const c2 = await h.player('Far');
    await h.admin.query("insert into bl.ratings (user_id, discipline, season, rating, games, wins, updated_at) values ($1, 'pyramid', 'all', 1500, 30, 10, now())", [c2.id]);
    await h.request('POST', '/api/plus/lfg', { token: c1.token, body: { discipline: 'pyramid', from, to, club_ids: [CLUB_A, CLUB_B] } });
    await h.request('POST', '/api/plus/lfg', { token: c2.token, body: { discipline: 'pyramid', from, to, club_ids: [CLUB_A] } });
    const r = await h.request('POST', '/api/plus/lfg', { token: a.token, body: { discipline: 'pyramid', from, to, club_ids: [CLUB_A] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.candidates.map((x) => x.nick), ['Close']);
    assert.deepEqual(r.json.candidates[0].clubs.sort(), ['Клуб Б', 'Тестовый клуб']);
    assert.equal(r.json.candidates[0].user_id, c1.id);
    assert.equal(r.json.lfg.clubs[0].name, 'Тестовый клуб');
    assert.equal((await h.request('POST', '/api/plus/lfg', { token: a.token, body: { discipline: 'pyramid', from: to, to: from, club_ids: [CLUB_A] } })).status, 400);
    const del = await h.request('DELETE', '/api/plus/lfg', { token: a.token });
    assert.deepEqual(del.json, { lfg: null, candidates: [] });
    assert.equal((await h.request('GET', '/api/plus/lfg', { token: a.token })).json.lfg, null);
  });

  it('«Сыграем?»: приглашение, лимит 10 в сутки, принятие — общая бронь на двоих, свободный стол', async () => {
    const host = await h.player('Host');
    await h.admin.query("update bl.users set phone_verified_at = now() where id = $1", [host.id]);
    const guest = await h.player('Guest');
    const starts = new Date(T0 + 3 * 60 * MIN).toISOString();
    const inv = await h.request('POST', '/api/plus/invites', { token: host.token, body: { to_user_id: guest.id, discipline: 'pyramid', club_id: CLUB_A, starts_at: starts, minutes: 60 } });
    assert.equal(inv.status, 201, inv.text);
    assert.equal(inv.json.status, 'pending');
    assert.deepEqual([inv.json.from.nick, inv.json.to.nick, inv.json.club.name], ['Host', 'Guest', 'Тестовый клуб']);
    assert.equal((await h.notifications(guest.id, 'plus.invite')).length, 1);
    const dup = await h.request('POST', '/api/plus/invites', { token: host.token, body: { to_user_id: guest.id, discipline: 'pyramid', club_id: CLUB_A, starts_at: starts, minutes: 60 } });
    assert.equal(dup.json.error, 'duplicate');

    // Первый стол занят (booking_conflict) — бронь на следующем свободном.
    let n = 0;
    h.hooks.bookingImpl = async (_db, args) => {
      n += 1;
      if (n === 1) throw Object.assign(new Error('busy'), { status: 409, code: 'booking_conflict' });
      return { id: '0b000000-0000-4000-8000-000000000001', status: 'pending_payment', resource_id: args.resourceId };
    };
    const acc = await h.request('POST', `/api/plus/invites/${inv.json.id}/accept`, { token: guest.token });
    assert.equal(acc.status, 200, acc.text);
    assert.equal(acc.json.status, 'accepted');
    assert.equal(acc.json.booking_id, '0b000000-0000-4000-8000-000000000001');
    const calls = h.bookingCalls.slice(-2);
    assert.deepEqual(calls.map((c) => c.resourceId), [table(1), table(2)]);
    assert.equal(calls[1].userId, host.id);
    assert.deepEqual(calls[1].participants, [guest.id]);
    assert.equal(calls[1].minutes, 60);
    assert.match((await h.notifications(host.id, 'plus.invite_accepted'))[0].text, /Оплатите бронь/);
    // Принять чужое приглашение нельзя.
    assert.equal((await h.request('POST', `/api/plus/invites/${inv.json.id}/accept`, { token: host.token })).status, 404);
    const list = await h.request('GET', '/api/plus/invites', { token: guest.token });
    assert.equal(list.json.incoming[0].booking_id, '0b000000-0000-4000-8000-000000000001');

    // Лимит: 10 приглашений за сутки, 11-е — 429 limit_exceeded.
    const targets = [];
    for (let i = 0; i < 10; i += 1) targets.push(await h.player(`Tgt${i}`));
    for (let i = 0; i < 9; i += 1) {
      const r = await h.request('POST', '/api/plus/invites', { token: host.token, body: { to_user_id: targets[i].id, discipline: 'pool', club_id: CLUB_A, starts_at: starts, minutes: 60 } });
      assert.equal(r.status, 201, `${i}: ${r.text}`);
    }
    const over = await h.request('POST', '/api/plus/invites', { token: host.token, body: { to_user_id: targets[9].id, discipline: 'pool', club_id: CLUB_A, starts_at: starts, minutes: 60 } });
    assert.equal(over.status, 429);
    assert.equal(over.json.error, 'limit_exceeded');
    const dec = await h.request('POST', `/api/plus/invites/${(await h.request('GET', '/api/plus/invites', { token: targets[0].token })).json.incoming[0].id}/decline`, { token: targets[0].token });
    assert.equal(dec.json.status, 'declined');
    h.clock.add(24 * 60 * MIN + MIN);
    const next = await h.request('POST', '/api/plus/invites', { token: host.token, body: { to_user_id: targets[9].id, discipline: 'pool', club_id: CLUB_A, starts_at: new Date(h.clock.now().getTime() + 60 * MIN).toISOString(), minutes: 60 } });
    assert.equal(next.status, 201, 'через сутки снова можно');
  });
});
