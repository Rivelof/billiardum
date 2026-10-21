// Проверка рабочей базы из DATABASE_ADMIN_URL (после npm run db:migrate): только чтение
// и попытки, которые откатываются. Ничего не пишет. Без схемы bl тесты пропускаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { listMigrations } from '../lib/db.mjs';
import { adminUrl, ALL_TABLES } from './helpers.mjs';

let client;
let migrated = false;

before(async () => {
  client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  migrated = (await client.query("select to_regclass('bl.schema_migrations') is not null as m")).rows[0].m;
});

after(async () => {
  await client?.end();
});

async function attempt(sql, { role = null, replica = false } = {}) {
  await client.query('begin');
  try {
    if (replica) await client.query('set local session_replication_role = replica');
    if (role) await client.query(`set local role ${pg.escapeIdentifier(role)}`);
    await client.query(sql);
    return null;
  } catch (err) {
    return err;
  } finally {
    await client.query('rollback');
  }
}

describe('рабочая база (DATABASE_ADMIN_URL)', () => {
  it('применены все миграции из supabase/migrations', async (t) => {
    if (!migrated) return t.skip('схемы bl нет — npm run db:migrate не запускался');
    const { rows } = await client.query('select version, checksum from bl.schema_migrations order by version');
    assert.deepEqual(
      rows,
      listMigrations().map((m) => ({ version: m.version, checksum: m.checksum })),
    );
  });

  it('UPDATE, DELETE, TRUNCATE журнала падают у суперпользователя (и в режиме replica) и у ролей Supabase', async (t) => {
    if (!migrated) return t.skip('схемы bl нет');
    for (const sql of ["update bl.audit_log set action = 'x'", 'delete from bl.audit_log', 'truncate bl.audit_log']) {
      for (const opts of [{}, { replica: true }, { role: 'postgres' }, { role: 'service_role' }, { role: 'app_api' }]) {
        assert.ok(await attempt(sql, opts), `${sql} ${JSON.stringify(opts)}`);
      }
    }
  });

  it('роли Supabase не читают таблицы bl', async (t) => {
    if (!migrated) return t.skip('схемы bl нет');
    for (const role of ['postgres', 'service_role', 'supabase_read_only_user', 'anon', 'authenticated', 'authenticator']) {
      for (const table of ALL_TABLES) {
        const err = await attempt(`select 1 from bl.${table} limit 1`, { role });
        assert.equal(err?.code, '42501', `${role} → bl.${table}`);
      }
    }
  });

  it('цепочки журнала всех клубов и платформы целы', async (t) => {
    if (!migrated) return t.skip('схемы bl нет');
    const { rows } = await client.query(`
      select c.club_id, v.ok, v.first_bad_seq, v.checked
        from (select distinct club_id from bl.audit_log) c, lateral bl.audit_verify(c.club_id) v`);
    for (const r of rows) assert.equal(r.ok, true, `цепочка ${r.club_id ?? 'платформы'} испорчена с записи ${r.first_bad_seq}`);
    t.diagnostic(`цепочек: ${rows.length}, записей: ${rows.reduce((s, r) => s + Number(r.checked), 0)}`);
  });
});
