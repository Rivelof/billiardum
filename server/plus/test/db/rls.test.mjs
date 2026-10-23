// RLS и неизменяемость таблиц Бильярдум+ (инварианты 2, 5; решение №137) — под ролью app_api.
// DATABASE_ADMIN_URL обязателен; без него файл пропускается.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { CLUB_A, CLUB_B, setup, table, TABLE_B } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

const TABLES = ['players', 'ratings', 'matches', 'match_confirmations', 'rating_history', 'friendships', 'friend_requests', 'lfg', 'invites', 'achievements'];

describe('Бильярдум+: RLS и неизменяемость', { skip, concurrency: false }, () => {
  let h;
  let a;
  let b;
  let x;
  let matchA;
  let matchB;
  before(async () => {
    h = await setup();
    a = await h.player('Alpha');
    b = await h.player('Beta');
    x = await h.player('Gamma');
    const s = await h.session({ players: [a.id, b.id], resourceId: table(1) });
    matchA = (await h.play(a, b, s)).id;
    // Партия в клубе Б (другие игроки).
    const sb = await h.session({ clubId: CLUB_B, resourceId: TABLE_B, players: [x.id, b.id] });
    matchB = (await h.play(x, b, sb, { discipline: 'pool', my: 5, opp: 3 })).id;
    await h.request('POST', '/api/plus/friends', { token: a.token, body: { nick: 'Beta' } });
  });
  after(async () => {
    await h?.close();
  });

  it('FORCE RLS на всех таблицах, у app_api нет TRUNCATE и DELETE (кроме дружбы)', async () => {
    const { rows } = await h.admin.query(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'bl'::regnamespace and relname = any ($1)",
      [TABLES],
    );
    assert.equal(rows.length, TABLES.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
    await asRole(h.admin, 'app_api', { clubId: CLUB_A }, async (c) => {
      for (const t of TABLES) {
        assert.equal((await tryQuery(c, `truncate bl.${t}`))?.code, '42501', `truncate ${t}`);
        if (t !== 'friendships') assert.equal((await tryQuery(c, `delete from bl.${t}`))?.code, '42501', `delete ${t}`);
      }
    });
  });

  it('без контекста app_api не видит ни одной строки', async () => {
    await asRole(h.admin, 'app_api', {}, async (c) => {
      for (const t of TABLES) assert.equal((await c.query(`select count(*)::int as n from bl.${t}`)).rows[0].n, 0, t);
    });
  });

  it('личный контекст: только свой профиль, рейтинг, свои партии и заявки', async () => {
    await asRole(h.admin, 'app_api', { userId: x.id, actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select nick from bl.players')).rows, [{ nick: 'Gamma' }]);
      assert.ok((await c.query('select user_id from bl.ratings')).rows.every((r) => r.user_id === x.id));
      const ms = (await c.query('select id from bl.matches')).rows.map((r) => r.id);
      assert.deepEqual(ms, [matchB], 'партия A–B чужая');
      assert.equal((await c.query('select count(*)::int as n from bl.friend_requests')).rows[0].n, 0);
      assert.equal((await c.query('select count(*)::int as n from bl.rating_history where match_id = $1', [matchA])).rows[0].n, 0);
      // Чужой профиль не изменить, чужую дружбу не создать.
      assert.equal((await c.query("update bl.players set nick = 'hacked' where user_id = $1", [a.id])).rowCount, 0);
      assert.equal((await tryQuery(c, 'insert into bl.friendships (user_id, friend_id, created_at) values ($1, $2, now())', [a.id, b.id]))?.code, '42501');
      // Заявку от чужого имени не отправить.
      assert.equal((await tryQuery(c, "insert into bl.friend_requests (from_user, to_user, status, created_at, updated_at) values ($1, $2, 'pending', now(), now())", [a.id, x.id]))?.code, '42501');
    });
  });

  it('рейтинг пишет только bl.plus_settle_match: app_api не меняет ratings, rating_history и итог партии', async () => {
    await asRole(h.admin, 'app_api', { userId: a.id, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, 'update bl.ratings set rating = 3000'))?.code, '42501');
      assert.equal((await tryQuery(c, "insert into bl.ratings (user_id, discipline, season, rating, games, wins, updated_at) values ($1, 'pool', 'all', 3000, 0, 0, now())", [a.id]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.rating_history set delta = 100'))?.code, '42501');
    });
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, userId: a.id, actorType: 'user' }, async (c) => {
      // Засчитанная партия окончательна; счёт без решения управляющего не меняется.
      assert.equal((await tryQuery(c, "update bl.matches set status = 'disputed' where id = $1", [matchA]))?.code, '42501');
      const s = await h.session({ players: [a.id, b.id], resourceId: table(2) });
      const pending = await c.query(
        `insert into bl.matches (club_id, source, session_id, resource_id, discipline, player_a, player_b, score_a, score_b, status, played_at, confirm_until, created_at, updated_at)
         values ($1, 'session', $2, $3, 'pyramid', $4, $5, 8, 1, 'pending', now(), now() + interval '30 minutes', now(), now()) returning id`,
        [CLUB_A, s, table(2), a.id, b.id],
      );
      const id = pending.rows[0].id;
      assert.equal((await tryQuery(c, "update bl.matches set status = 'counted' where id = $1", [id]))?.code, '42501', 'counted — только функция');
      assert.equal((await tryQuery(c, 'update bl.matches set score_a = 1, score_b = 8 where id = $1', [id]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.matches set player_b = $2 where id = $1', [id, x.id]))?.code, '42501');
      // Подтвердить за соперника нельзя.
      assert.equal((await tryQuery(c, "insert into bl.match_confirmations (match_id, club_id, user_id, decision, created_at) values ($1, $2, $3, 'confirm', now())", [id, CLUB_A, b.id]))?.code, '42501');
      // Без двух подтверждений функция не засчитывает.
      await c.query("update bl.matches set status = 'confirmed' where id = $1", [id]);
      assert.equal((await tryQuery(c, 'select * from bl.plus_settle_match($1, now())', [id]))?.code, '55000');
    });
  });

  it('журналируемое не удаляется и не меняется даже суперпользователем', async () => {
    await asRole(h.admin, null, {}, async (c) => {
      assert.equal((await tryQuery(c, 'delete from bl.matches where id = $1', [matchA]))?.code, '42501');
      assert.equal((await tryQuery(c, "update bl.matches set status = 'pending' where id = $1", [matchA]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.rating_history set delta = 0'))?.code, '42501');
      assert.equal((await tryQuery(c, 'delete from bl.match_confirmations'))?.code, '42501');
      assert.equal((await tryQuery(c, "insert into bl.achievements (user_id, code, earned_at) values ($1, 'comeback', now())", [a.id]))?.code, '23514', '«Камбэк» в M4 не выдаётся');
      await c.query("insert into bl.achievements (user_id, code, earned_at) values ($1, 'regular', now())", [a.id]);
      assert.equal((await tryQuery(c, 'delete from bl.achievements'))?.code, '42501');
      assert.equal((await tryQuery(c, "update bl.achievements set code = 'dry'"))?.code, '42501');
      assert.equal((await tryQuery(c, 'truncate bl.rating_history'))?.code, '42501');
    });
    await asRole(h.admin, null, { replica: true }, async (c) => {
      assert.equal((await tryQuery(c, 'delete from bl.rating_history'))?.code, '42501', 'replica-режим триггеры не выключает');
    });
  });

  it('контекст клуба A не видит партий, подтверждений и истории клуба Б', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      const ids = (await c.query('select id from bl.matches')).rows.map((r) => r.id);
      assert.ok(ids.includes(matchA));
      assert.ok(!ids.includes(matchB));
      assert.equal((await c.query('select count(*)::int as n from bl.match_confirmations where match_id = $1', [matchB])).rows[0].n, 0);
      assert.equal((await c.query('select count(*)::int as n from bl.rating_history where match_id = $1', [matchB])).rows[0].n, 0);
      assert.equal((await tryQuery(c, `insert into bl.matches (club_id, source, tournament_id, tournament_match_id, discipline, player_a, player_b, score_a, score_b, status, multiplier_x10, played_at, created_at, updated_at)
        values ($1, 'tournament', gen_random_uuid(), gen_random_uuid(), 'pool', $2, $3, 1, 0, 'confirmed', 15, now(), now(), now())`, [CLUB_B, a.id, b.id]))?.code, '42501');
      assert.equal((await c.query("update bl.matches set status = 'disputed' where id = $1", [matchB])).rowCount, 0);
    });
  });

  it('узкие функции отдают только публичные поля; приватное — по выбору игрока', async () => {
    await asRole(h.admin, 'app_api', { userId: x.id, actorType: 'user' }, async (c) => {
      const br = (await c.query('select * from bl.plus_briefs($1::uuid[])', [[a.id]])).rows[0];
      assert.deepEqual(Object.keys(br).sort(), ['nick', 'ratings', 'user_id']);
      const card = (await c.query("select * from bl.plus_card(null, 'alpha', '2026-10')")).rows[0];
      assert.equal(card.is_self, false);
      assert.equal(card.privacy, null);
      assert.equal(card.history, null);
      assert.equal(card.achievements, null);
      const self = (await c.query("select * from bl.plus_card(null, 'gamma', '2026-10')")).rows[0];
      assert.equal(self.is_self, true);
      assert.ok(Array.isArray(self.history));
      assert.equal((await c.query('select count(*)::int as n from bl.plus_friends_in_club()')).rows[0].n, 0);
    });
    // Владелец функций не видит лишнего в чужих таблицах: у участников сессий — без ролей и ordinal.
    await asRole(h.admin, 'bl_definer', {}, async (c) => {
      assert.equal((await tryQuery(c, 'select role from bl.session_participants'))?.code, '42501');
      assert.equal((await tryQuery(c, 'select payer_user_id from bl.sessions'))?.code, '42501');
    });
  });
});
