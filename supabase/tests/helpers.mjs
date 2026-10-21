// Общее для тестов базы (npm run test:db). Каждый файл тестов создаёт свою временную
// базу из template1, применяет миграции и сид, а в конце удаляет её: журнал нельзя
// очистить, поэтому тесты не пишут в рабочую базу. Пароль app_api не меняется —
// тесты действуют от app_api через SET ROLE (те же права, тот же RLS).

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, requireEnv, seed } from '../lib/db.mjs';

export const CLUB_A = 'c1000000-0000-4000-8000-000000000001'; // клуб сида
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002'; // второй клуб, только в тестах
export const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
export const OWNER_B = 'a2000000-0000-4000-8000-000000000002';

/** Таблицы со столбцом club_id (и clubs, где это id). */
export const CLUB_TABLES = ['club_members', 'resources', 'devices', 'tariff_rules', 'audit_log'];
export const ALL_TABLES = ['users', 'clubs', ...CLUB_TABLES, 'schema_migrations'];

export function adminUrl() {
  return requireEnv('DATABASE_ADMIN_URL');
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * Временная база с миграциями (и сидом). Возвращает { url, pool, drop }.
 * pool подключён суперпользователем к временной базе.
 */
export async function createTestDatabase({ withSeed = true } = {}) {
  const name = `bl_test_${process.pid}_${randomBytes(3).toString('hex')}`;
  const root = new pg.Client({ connectionString: adminUrl() });
  await root.connect();
  try {
    await root.query(`create database ${name} template template1`);
  } finally {
    await root.end();
  }
  const url = withDatabase(adminUrl(), name);
  await migrate({ connectionString: url, quiet: true });
  if (withSeed) await seed({ connectionString: url, quiet: true });
  const pool = new pg.Pool({ connectionString: url, max: 60 });
  pool.on('error', () => {});
  return {
    name,
    url,
    pool,
    /** URL временной базы для входа под app_api, если задан DATABASE_URL. */
    appUrl: process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, name) : null,
    async drop() {
      await pool.end();
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

/**
 * Транзакция от имени роли (SET LOCAL ROLE) с контекстом клуба; всегда откатывается.
 * fn получает клиента; ошибка внутри fn пробрасывается.
 */
export async function asRole(pool, role, { clubId = null, userId = null, actorType = 'system', replica = false } = {}, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (replica) await client.query('set local session_replication_role = replica');
    if (role) await client.query(`set local role ${pg.escapeIdentifier(role)}`);
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
      [clubId ?? '', userId ?? '', actorType],
    );
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

/** Выполнить запрос в точке сохранения; вернуть ошибку или null. */
export async function tryQuery(client, sql, params) {
  await client.query('savepoint t');
  try {
    await client.query(sql, params);
    await client.query('release savepoint t');
    return null;
  } catch (err) {
    await client.query('rollback to savepoint t');
    return err;
  }
}

/** Вставка в журнал от app_api с контекстом клуба (коммит). */
export async function appendAudit(pool, clubId, action = 'test.event', data = {}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role app_api');
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)",
      [clubId ?? ''],
    );
    await client.query('insert into bl.audit_log (club_id, action, data) values ($1, $2, $3)', [clubId, action, data]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Второй клуб с участником, столом, устройством, тарифом и записью журнала. */
export async function seedClubB(pool) {
  await pool.query(`
    insert into bl.clubs (id, name, city, timezone) values
      ('${CLUB_B}', 'Клуб Б', 'Владивосток', 'Asia/Vladivostok');
    insert into bl.users (id, phone) values ('${OWNER_B}', '+70000000002');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_B}', '${OWNER_B}', 'owner');
    insert into bl.resources (id, club_id, type, number, title) values
      ('e2000000-0000-4000-8000-000000000001', '${CLUB_B}', 'billiard_pool', 1, 'Стол 1');
    insert into bl.devices (id, club_id, resource_id, mqtt_username) values
      ('d2000000-0000-4000-8000-000000000001', '${CLUB_B}', 'e2000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001');
    insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour) values
      ('${CLUB_B}', 'billiard_pool', '{1,2,3,4,5,6,7}', '10:00', '22:00', 70000);
  `);
  await appendAudit(pool, CLUB_B, 'test.club_b');
}

/** Роли, которые есть в кластере. */
export async function existingRoles(pool) {
  const { rows } = await pool.query('select rolname, rolsuper, rolcanlogin, rolbypassrls from pg_roles order by rolname');
  return rows;
}
