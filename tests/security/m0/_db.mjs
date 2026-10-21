// Помощник БД для PoC M0: временная база (CREATE DATABASE bl_pentest_*), миграции
// через product-раннер supabase/lib/db.mjs, второй клуб для проверки изоляции.
// Рабочую базу не трогает: все разрушающие доказательства идут во временной базе.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { migrate, seed } from '../../../supabase/lib/db.mjs';
import { adminUrl, loadEnv, REPO_ROOT } from './_env.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const OWNER_B = 'a2000000-0000-4000-8000-000000000002';
export const DEV_B = 'd2000000-0000-4000-8000-000000000001';
export const RES_B = 'e2000000-0000-4000-8000-000000000001';
export const ALL_CLUB_TABLES = ['clubs', 'club_members', 'resources', 'devices', 'tariff_rules', 'audit_log'];

function withDb(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Временная база с миграциями и сидом. Возвращает { pool, url, drop }. */
export async function createTempDb({ withSeed = true, withClubB = true } = {}) {
  loadEnv();
  const name = `bl_pentest_${process.pid}_${randomBytes(3).toString('hex')}`;
  const root = new pg.Client({ connectionString: adminUrl() });
  await root.connect();
  try {
    await root.query(`create database ${name} template template1`);
  } finally {
    await root.end();
  }
  const url = withDb(adminUrl(), name);
  await migrate({ connectionString: url, quiet: true });
  if (withSeed) await seed({ connectionString: url, quiet: true });
  const pool = new pg.Pool({ connectionString: url, max: 60 });
  pool.on('error', () => {});
  if (withSeed && withClubB) await seedClubB(pool);
  return {
    name,
    url,
    pool,
    async drop() {
      await pool.end().catch(() => {});
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Второй клуб с участником, столом, устройством, тарифом и записью журнала. */
export async function seedClubB(pool) {
  await pool.query(`
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_B}', 'Клуб Б', 'Владивосток', 'Asia/Vladivostok');
    insert into bl.users (id, phone) values ('${OWNER_B}', '+70000000002');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_B}', '${OWNER_B}', 'owner');
    insert into bl.resources (id, club_id, type, number, title) values ('${RES_B}', '${CLUB_B}', 'billiard_pool', 1, 'Стол 1');
    insert into bl.devices (id, club_id, resource_id, mqtt_username) values ('${DEV_B}', '${CLUB_B}', '${RES_B}', '${DEV_B}');
    insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour)
      values ('${CLUB_B}', 'billiard_pool', '{1,2,3,4,5,6,7}', '10:00', '22:00', 70000);
  `);
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_B]);
    await c.query("insert into bl.audit_log (club_id, action, data) values ($1, 'test.club_b', '{}')", [CLUB_B]);
    await c.query('commit');
  } finally {
    c.release();
  }
}

/** Транзакция под ролью (SET LOCAL ROLE) с контекстом; всегда откат. */
export async function asRole(pool, role, { clubId = null, userId = null, actorType = 'system', replica = false, clubRaw = null } = {}, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (replica) await client.query('set local session_replication_role = replica');
    if (role) await client.query(`set local role ${pg.escapeIdentifier(role)}`);
    const clubValue = clubRaw !== null ? clubRaw : (clubId ?? '');
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
      [clubValue, userId ?? '', actorType],
    );
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/** Выполнить запрос в savepoint; вернуть ошибку или null. */
export async function tryQuery(client, sql, params) {
  await client.query('savepoint t');
  try {
    await client.query(sql, params);
    await client.query('release savepoint t');
    return null;
  } catch (err) {
    await client.query('rollback to savepoint t').catch(() => {});
    return err;
  }
}

export const migrationsDir = path.join(REPO_ROOT, 'supabase', 'migrations');
