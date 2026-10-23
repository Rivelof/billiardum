// RLS турниров (инвариант 5, decisions №12): клуб видит только свои турниры, записи и матчи; без клуба
// в контексте — только опубликованные турниры (афиша без ПДн); игрок — свои записи и матчи; права app_api.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { CLUB_A, CLUB_B, player, setup, STAFF, table } from './harness.mjs';

const TABLES = ['tournaments', 'tournament_resources', 'tournament_entries', 'tournament_payments', 'tournament_matches'];

let h;
let pub;
let draft;
let users;
before(async () => {
  h = await setup();
  pub = await h.createTournament({ title: 'Открытый', resource_ids: [table(1), table(2)] });
  draft = await h.createTournament({ title: 'Черновик' }, { publish: false });
  const list = await h.enroll(pub.id, [
    { phone: player(1), rating: 1500, nick: 'Первый' },
    { phone: player(2), rating: 1400, nick: 'Второй' },
    { phone: player(3), rating: 1300, nick: 'Третий' },
  ]);
  users = list.map((x) => x.user);
  const manager = await h.login(STAFF.manager);
  const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${pub.id}/start`, { token: manager.token });
  assert.equal(r.status, 200, r.text);
});
after(async () => {
  await h?.close();
});

const count = async (c, table, where = 'true', params = []) => (await c.query(`select count(*)::int as n from bl.${table} where ${where}`, params)).rows[0].n;

describe('RLS турниров', () => {
  it('ENABLE и FORCE ROW LEVEL SECURITY на всех таблицах турниров', async () => {
    const { rows } = await h.admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'bl'::regnamespace and relname = any($1)`,
      [TABLES],
    );
    assert.equal(rows.length, TABLES.length);
    for (const r of rows) assert.ok(r.relrowsecurity && r.relforcerowsecurity, r.relname);
  });

  it('клуб B не видит турниры, записи, матчи, платежи и столы турниров клуба A и не пишет в клуб A', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_B, actorType: 'user' }, async (c) => {
      for (const t of TABLES) assert.equal(await count(c, t), 0, t);
      const err = await tryQuery(
        c,
        `insert into bl.tournaments (club_id, title, discipline, format, race_to, places, match_minutes, starts_at, ends_at, registration_closes_at, status, created_at, updated_at)
         values ($1, 'x', 'pool', 'single_elim', 2, 8, 60, now() + interval '1 day', now() + interval '2 days', now() + interval '1 day', 'draft', now(), now())`,
        [CLUB_A],
      );
      assert.ok(err, 'вставка в клуб A прошла');
      const upd = await c.query("update bl.tournaments set title = 'взлом' where id = $1", [pub.id]);
      assert.equal(upd.rowCount, 0);
    });
  });

  it('клуб A видит своё целиком', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'tournaments', 'id = any($1)', [[pub.id, draft.id]]), 2);
      assert.equal(await count(c, 'tournament_entries', 'tournament_id = $1', [pub.id]), 3);
      assert.ok((await count(c, 'tournament_matches', 'tournament_id = $1', [pub.id])) >= 3);
    });
  });

  it('без клуба (сайт, планировщик): опубликованные турниры — да, черновик, записи, матчи — нет', async () => {
    for (const ctx of [{ actorType: 'user' }, { actorType: 'system' }]) {
      await asRole(h.admin, 'app_api', ctx, async (c) => {
        assert.equal(await count(c, 'tournaments', 'id = $1', [pub.id]), 1);
        assert.equal(await count(c, 'tournaments', 'id = $1', [draft.id]), 0);
        for (const t of TABLES.slice(1)) assert.equal(await count(c, t), 0, t);
        const upd = await c.query("update bl.tournaments set title = 'взлом' where id = $1", [pub.id]);
        assert.equal(upd.rowCount, 0, 'публичная строка только для чтения');
      });
    }
  });

  it('игрок в личном контексте видит свои записи и свои матчи, чужих — нет', async () => {
    const [u1] = users;
    await asRole(h.admin, 'app_api', { userId: u1.id, actorType: 'user' }, async (c) => {
      const e = await c.query('select user_id from bl.tournament_entries');
      assert.deepEqual(e.rows.map((r) => r.user_id), [u1.id]);
      const m = await c.query('select user_a, user_b from bl.tournament_matches');
      assert.ok(m.rows.length >= 1);
      for (const r of m.rows) assert.ok(r.user_a === u1.id || r.user_b === u1.id);
      assert.equal(await count(c, 'tournament_payments'), 0);
    });
  });

  it('app_api: без DELETE записей, матчей и турниров; без UPDATE служебных столбцов', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      for (const t of ['tournaments', 'tournament_entries', 'tournament_matches', 'tournament_payments']) {
        const err = await tryQuery(c, `delete from bl.${t}`);
        assert.equal(err?.code, '42501', t);
      }
      assert.equal((await tryQuery(c, 'update bl.tournaments set club_id = $1', [CLUB_B]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.tournament_entries set user_id = user_id'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.tournament_matches set next_match_id = null'))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.tournament_payments set amount_kopecks = 0'))?.code, '42501');
    });
  });

  it('API: чужой клуб — 403 на турниры клуба A, гость не видит черновик и чужую запись', async () => {
    const ownerB = await h.login(STAFF.ownerB);
    let r = await h.request('GET', `/api/clubs/${CLUB_A}/tournaments/${pub.id}`, { token: ownerB.token });
    assert.equal(r.status, 403);
    r = await h.request('GET', `/api/clubs/${CLUB_B}/tournaments/${pub.id}`, { token: ownerB.token });
    assert.equal(r.status, 404);
    r = await h.request('POST', `/api/clubs/${CLUB_B}/tournaments/${pub.id}/cancel`, { token: ownerB.token, body: { reason: 'чужой' } });
    assert.equal(r.status, 404);
    const guest = await h.login(player(50));
    r = await h.request('GET', `/api/tournaments/${draft.id}/me`, { token: guest.token });
    assert.equal(r.status, 404);
    r = await h.request('POST', `/api/tournaments/${draft.id}/entries`, { token: guest.token, key: crypto.randomUUID(), body: {} });
    assert.equal(r.status, 404);
    r = await h.request('GET', `/api/tournaments/${pub.id}/me`, { token: guest.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.entry, null);
    // Публичная сетка — ники, без user_id.
    r = await h.request('GET', `/api/public/tournaments/${pub.id}`);
    assert.equal(r.status, 200);
    for (const u of users) assert.ok(!r.text.includes(u.id));
    assert.deepEqual(r.json.entries.map((e) => e.nick), ['Первый', 'Второй', 'Третий']);
  });
});
