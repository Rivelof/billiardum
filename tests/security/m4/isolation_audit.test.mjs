// PoC M4: изоляция клубов на новых таблицах (инвариант 5) и журнал (инвариант 2).
//
// Выдержало:
//   * каждая таблица схемы bl — RLS ENABLE + FORCE (каталог);
//   * в контексте клуба A строки клуба B новых таблиц M4 не видны (кроме публичного по замыслу:
//     опубликованные отзывы, видимые карточки, города); в личном контексте постороннего — ничего
//     чужого: записи на турнир, платежи взносов, заявки T25, партии, подтверждения, приглашения;
//   * вставка с чужим club_id — 42501;
//   * журнал: UPDATE и DELETE запрещены app_api и владельцу таблиц, цепочка сходится (audit_verify).
//
// Запуск: DATABASE_ADMIN_URL=… node --test --test-concurrency=1 tests/security/m4/isolation_audit.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { appendAudit, asRole, CLUB_A, CLUB_B, createTestDatabase, OWNER_A, OWNER_B, seedClubB } from '../../../supabase/tests/helpers.mjs';

let db;
let pool;
const GUEST_B1 = randomUUID();
const GUEST_B2 = randomUUID();
const STRANGER = randomUUID();
const TB = randomUUID();
const ENTRY = randomUUID();
const TM = randomUUID();
const CARD_B = randomUUID();
const REQ = randomUUID();
const MATCH = randomUUID();
const SESSION_B = randomUUID();
const TABLE_B = 'e2000000-0000-4000-8000-000000000001';

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
  await pool.query(`insert into bl.users (id, phone) values ($1, '+79995550001'), ($2, '+79995550002'), ($3, '+79995550003')`, [GUEST_B1, GUEST_B2, STRANGER]);
  const t = new Date();
  await pool.query(
    `insert into bl.tournaments (id, club_id, title, discipline, format, race_to, fee_kopecks, places, match_minutes, starts_at, ends_at,
                                 registration_closes_at, status, created_at, updated_at)
     values ($1, $2, 'Турнир Б', 'pool', 'single_elim', 2, 50000, 8, 60, $3, $4, $3, 'draft', $5, $5)`,
    [TB, CLUB_B, new Date(t.getTime() + 86400_000), new Date(t.getTime() + 90000_000), t],
  );
  await pool.query('insert into bl.tournament_resources (club_id, tournament_id, resource_id) values ($1, $2, $3)', [CLUB_B, TB, TABLE_B]);
  await pool.query(
    `insert into bl.tournament_entries (id, club_id, tournament_id, user_id, nick, rating, status, fee_kopecks, paid_kopecks, confirmed_at, created_at, updated_at)
     values ($1, $2, $3, $4, 'ПлэйерБ', 1200, 'confirmed', 50000, 50000, $5, $5, $5)`,
    [ENTRY, CLUB_B, TB, GUEST_B1, t],
  );
  await pool.query(
    `insert into bl.tournament_payments (payment_id, club_id, entry_id, outcome, amount_kopecks, created_at) values ($1, $2, $3, 'applied', 50000, $4)`,
    [randomUUID(), CLUB_B, ENTRY, t],
  );
  await pool.query(
    `insert into bl.tournament_matches (id, club_id, tournament_id, stage, round, position, entry_a, user_a, status, created_at, updated_at)
     values ($1, $2, $3, 'playoff', 1, 0, $4, $5, 'waiting', $6, $6)`,
    [TM, CLUB_B, TB, ENTRY, GUEST_B1, t],
  );
  await pool.query(
    `insert into bl.club_public (id, city_id, slug, name, status, club_id, visible) values ($1, 'ca000000-0000-4000-8000-000000000002', 'klub-b', 'Клуб Б', 'platform', $2, false)`,
    [CARD_B, CLUB_B],
  );
  await pool.query(
    `insert into bl.club_requests (id, card_id, club_id, user_id, guest_phone, starts_at, minutes, people, status, escalate_at, created_at, updated_at)
     values ($1, $2, $3, $4, '+79995550001', $5, 60, 2, 'sent', $5, $5, $5)`,
    [REQ, CARD_B, CLUB_B, GUEST_B1, t],
  );
  await pool.query(
    `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, created_at, updated_at)
     values ($1, $2, $3, 'active', $4, $5, $6, $5, $5)`,
    [SESSION_B, CLUB_B, TABLE_B, GUEST_B1, t, new Date(t.getTime() + 3600_000)],
  );
  await pool.query(
    `insert into bl.matches (id, club_id, source, session_id, resource_id, discipline, player_a, player_b, score_a, score_b, status, played_at, confirm_until, created_by, created_at, updated_at)
     values ($1, $2, 'session', $3, $4, 'pool', $5, $6, 8, 5, 'pending', $7, $8, $5, $7, $7)`,
    [MATCH, CLUB_B, SESSION_B, TABLE_B, GUEST_B1, GUEST_B2, t, new Date(t.getTime() + 1800_000)],
  );
  await pool.query(`insert into bl.match_confirmations (match_id, club_id, user_id, decision, created_at) values ($1, $2, $3, 'confirm', $4)`, [MATCH, CLUB_B, GUEST_B1, t]);
  await pool.query(
    `insert into bl.reviews (card_id, club_id, user_id, rating, text, status, created_at, updated_at) values ($1, $2, $3, 2, 'скрытый', 'hidden', $4, $4)`,
    [CARD_B, CLUB_B, GUEST_B1, t],
  );
  await pool.query(
    `insert into bl.invites (from_user, to_user, discipline, club_id, starts_at, minutes, status, created_at, updated_at) values ($1, $2, 'pool', $3, $4, 60, 'pending', $4, $4)`,
    [GUEST_B1, GUEST_B2, CLUB_B, new Date(t.getTime() + 86400_000)],
  );
});

after(async () => {
  await db?.drop();
});

test('каталог: все таблицы bl — RLS enable + force', async () => {
  const { rows } = await pool.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'bl' and c.relkind in ('r', 'p') order by 1`);
  const bad = rows.filter((r) => (!r.relrowsecurity || !r.relforcerowsecurity) && r.relname !== 'schema_migrations').map((r) => r.relname);
  assert.deepEqual(bad, []);
  // schema_migrations — служебная, у app_api прав нет.
  const priv = await pool.query("select has_table_privilege('app_api', 'bl.schema_migrations', 'select') as s");
  assert.equal(priv.rows[0].s, false);
  for (const t of ['tournaments', 'tournament_entries', 'tournament_matches', 'tournament_payments', 'tournament_resources', 'matches', 'match_confirmations', 'rating_history', 'players', 'ratings', 'friendships', 'friend_requests', 'lfg', 'invites', 'achievements', 'club_public', 'club_requests', 'directory_claims', 'leads', 'reviews', 'review_reports', 'cities', 'platform_members']) {
    assert.ok(rows.some((r) => r.relname === t), `таблица ${t} есть`);
  }
});

const M4_CLUB_TABLES = ['tournaments', 'tournament_resources', 'tournament_entries', 'tournament_payments', 'tournament_matches', 'matches', 'match_confirmations', 'club_requests', 'reviews', 'review_reports', 'rating_history'];

test('контекст клуба A (владелец A): строк клуба B в новых таблицах нет', async () => {
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A, actorType: 'user' }, async (c) => {
    for (const t of M4_CLUB_TABLES) {
      const { rows } = await c.query(`select count(*)::int as n from bl.${t} where club_id = $1`, [CLUB_B]);
      assert.equal(rows[0].n, 0, `bl.${t}`);
    }
    // Скрытая карточка B и черновик турнира B не видны.
    assert.equal((await c.query('select count(*)::int as n from bl.club_public where id = $1', [CARD_B])).rows[0].n, 0);
    assert.equal((await c.query('select count(*)::int as n from bl.invites')).rows[0].n, 0);
    // Вставка с чужим club_id — отказ.
    await c.query('savepoint s');
    await assert.rejects(
      c.query(`insert into bl.tournaments (club_id, title, discipline, format, race_to, places, match_minutes, starts_at, ends_at, registration_closes_at, status, created_at, updated_at)
               values ($1, 'x', 'pool', 'single_elim', 2, 2, 30, now() + interval '1 day', now() + interval '2 day', now() + interval '1 day', 'draft', now(), now())`, [CLUB_B]),
      (e) => e.code === '42501',
    );
    await c.query('rollback to savepoint s');
    await assert.rejects(
      c.query(`insert into bl.reviews (card_id, club_id, user_id, rating, created_at, updated_at) values ($1, $2, $3, 5, now(), now())`, [CARD_B, CLUB_B, OWNER_A]),
      (e) => e.code === '42501',
    );
  });
});

test('личный контекст постороннего: чужие записи, взносы, заявки, партии и приглашения не видны; публичный черновик не виден', async () => {
  await asRole(pool, 'app_api', { clubId: null, userId: STRANGER, actorType: 'user' }, async (c) => {
    for (const t of ['tournament_entries', 'tournament_payments', 'tournament_matches', 'club_requests', 'matches', 'match_confirmations', 'invites', 'directory_claims', 'leads', 'review_reports']) {
      const { rows } = await c.query(`select count(*)::int as n from bl.${t}`);
      assert.equal(rows[0].n, 0, `bl.${t}`);
    }
    assert.equal((await c.query('select count(*)::int as n from bl.tournaments where id = $1', [TB])).rows[0].n, 0, 'черновик не публичен');
    assert.equal((await c.query("select count(*)::int as n from bl.reviews where status = 'hidden'")).rows[0].n, 0, 'скрытый отзыв');
  });
  // Сам игрок видит свою запись и матч в личном контексте.
  await asRole(pool, 'app_api', { clubId: null, userId: GUEST_B1, actorType: 'user' }, async (c) => {
    assert.equal((await c.query('select count(*)::int as n from bl.tournament_entries')).rows[0].n, 1);
    assert.equal((await c.query('select count(*)::int as n from bl.tournament_payments')).rows[0].n, 0, 'платежи — только клубу');
  });
  // Владелец B видит свои; владелец B в контексте клуба A (не член A) — ничего из B.
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_B, actorType: 'user' }, async (c) => {
    assert.equal((await c.query('select count(*)::int as n from bl.tournament_entries where club_id = $1', [CLUB_B])).rows[0].n, 0);
  });
});

test('журнал: UPDATE и DELETE запрещены, цепочка сходится', async () => {
  await appendAudit(pool, CLUB_B, 'test.m4');
  await asRole(pool, 'app_api', { clubId: CLUB_B, userId: OWNER_B, actorType: 'user' }, async (c) => {
    await c.query('savepoint s');
    await assert.rejects(c.query("update bl.audit_log set action = 'x' where club_id = $1", [CLUB_B]));
    await c.query('rollback to savepoint s');
    await assert.rejects(c.query('delete from bl.audit_log where club_id = $1', [CLUB_B]));
  });
  for (const role of ['bl_owner', 'bl_definer']) {
    await asRole(pool, role, {}, async (c) => {
      await c.query('savepoint s');
      await assert.rejects(c.query("update bl.audit_log set action = 'x'"), undefined, `${role} update`);
      await c.query('rollback to savepoint s');
      await assert.rejects(c.query('delete from bl.audit_log'), undefined, `${role} delete`);
    }).catch((e) => {
      if (!/role .* does not exist/.test(e.message)) throw e;
    });
  }
  await asRole(pool, 'app_api', { clubId: CLUB_B, userId: OWNER_B, actorType: 'user' }, async (c) => {
    const v = (await c.query('select * from bl.audit_verify($1)', [CLUB_B])).rows[0];
    assert.equal(v.ok, true, 'цепочка клуба B сходится');
  });
  const fn = (await pool.query("select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'bl' and p.proname = 'audit_verify'")).rows;
  assert.ok(fn.length >= 1, 'bl.audit_verify есть');
  console.log(`  ${fn.map((x) => x.sig).join(', ')}`);
});
