// Журнал только дополняется (инвариант 2, decisions №13, контракт M0 §5):
// UPDATE, DELETE, TRUNCATE падают для каждой роли; DDL над журналом запрещена.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { appendAudit, asRole, CLUB_A, createTestDatabase, existingRoles, tryQuery } from './helpers.mjs';

const ATTEMPTS = {
  UPDATE: "update bl.audit_log set action = 'tampered'",
  DELETE: 'delete from bl.audit_log',
  TRUNCATE: 'truncate bl.audit_log',
};
// Роли из контракта: суперпользователь, роль миграций (владелец таблиц), app_api,
// anon, authenticated, service_role, authenticator; плюс прочие роли Supabase и владелец журнала.
const REQUIRED = [
  'bl_owner',
  'bl_audit_owner',
  'app_api',
  'anon',
  'authenticated',
  'service_role',
  'authenticator',
  'postgres',
  'supabase_read_only_user',
];

let db;
let superuser;

before(async () => {
  db = await createTestDatabase();
  await appendAudit(db.pool, CLUB_A, 'test.first');
  await appendAudit(db.pool, CLUB_A, 'test.second');
  await appendAudit(db.pool, null, 'test.platform');
  superuser = (await db.pool.query('select current_user as u')).rows[0].u;
});

after(async () => {
  await db?.drop();
});

async function auditCount() {
  const { rows } = await db.pool.query('select count(*)::int as n from bl.audit_log');
  return rows[0].n;
}

describe('UPDATE, DELETE, TRUNCATE в audit_log', () => {
  it('падают у суперпользователя — с ошибкой триггера', async () => {
    await asRole(db.pool, null, {}, async (c) => {
      for (const [op, sql] of Object.entries(ATTEMPTS)) {
        const err = await tryQuery(c, sql);
        assert.ok(err, `${op} от ${superuser} прошёл`);
        assert.match(err.message, new RegExp(`append-only: ${op} is forbidden`));
      }
    });
    assert.equal(await auditCount(), 3);
  });

  it('падают у суперпользователя и при session_replication_role = replica (триггеры ENABLE ALWAYS)', async () => {
    await asRole(db.pool, null, { replica: true }, async (c) => {
      for (const [op, sql] of Object.entries(ATTEMPTS)) {
        const err = await tryQuery(c, sql);
        assert.ok(err, `${op} в режиме replica прошёл`);
        assert.match(err.message, /append-only/);
      }
    });
  });

  it('падают у владельца журнала bl_audit_owner — с ошибкой триггера, а не прав', async () => {
    await asRole(db.pool, 'bl_audit_owner', {}, async (c) => {
      for (const [op, sql] of Object.entries(ATTEMPTS)) {
        const err = await tryQuery(c, sql);
        assert.ok(err, `${op} от владельца прошёл`);
        assert.match(err.message, /append-only/);
      }
    });
  });

  it('падают у каждой роли кластера (SET ROLE), включая обязательные из контракта', async (t) => {
    const roles = await existingRoles(db.pool);
    const names = roles.map((r) => r.rolname);
    for (const r of REQUIRED) assert.ok(names.includes(r), `в базе нет роли ${r}`);
    const tested = [];
    for (const { rolname } of roles) {
      if (rolname === superuser) continue;
      const result = await asRole(db.pool, null, {}, async (c) => {
        const setErr = await tryQuery(c, `set local role ${pg.escapeIdentifier(rolname)}`);
        if (setErr) return { skipped: setErr.message };
        await c.query("select set_config('app.club_id', $1, true)", [CLUB_A]);
        for (const [op, sql] of Object.entries(ATTEMPTS)) {
          const err = await tryQuery(c, sql);
          assert.ok(err, `${op} от роли ${rolname} прошёл`);
        }
        return { ok: true };
      });
      if (result.skipped) {
        assert.ok(!REQUIRED.includes(rolname), `в обязательную роль ${rolname} нельзя переключиться: ${result.skipped}`);
        t.diagnostic(`SET ROLE ${rolname} невозможен: ${result.skipped}`);
      } else {
        tested.push(rolname);
      }
    }
    for (const r of REQUIRED) assert.ok(tested.includes(r), `роль ${r} не проверена`);
    t.diagnostic(`проверено ролей: ${tested.length + 1} (${superuser}, ${tested.join(', ')})`);
    assert.equal(await auditCount(), 3);
  });

  it('падают у app_api, вошедшей по паролю (если задан DATABASE_URL)', async (t) => {
    if (!db.appUrl) {
      t.skip('DATABASE_URL не задан');
      return;
    }
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      const { rows } = await c.query('select current_user as u, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user');
      assert.deepEqual(rows[0], { u: 'app_api', rolsuper: false, rolbypassrls: false });
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true)", [CLUB_A]);
      for (const [op, sql] of Object.entries(ATTEMPTS)) {
        assert.ok(await tryQuery(c, sql), `${op} от app_api прошёл`);
      }
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('TRUNCATE clubs CASCADE не стирает журнал', async () => {
    await asRole(db.pool, null, {}, async (c) => {
      const err = await tryQuery(c, 'truncate bl.clubs cascade');
      assert.ok(err);
      assert.match(err.message, /append-only: TRUNCATE/);
    });
    assert.equal(await auditCount(), 3);
  });
});

describe('DDL над журналом', () => {
  const DDL = {
    'DISABLE TRIGGER': 'alter table bl.audit_log disable trigger audit_log_immutable_stmt',
    'DISABLE TRIGGER USER': 'alter table bl.audit_log disable trigger user',
    'ENABLE TRIGGER (снять ALWAYS)': 'alter table bl.audit_log enable trigger audit_log_immutable_row',
    'NO FORCE RLS': 'alter table bl.audit_log no force row level security',
    'DISABLE RLS': 'alter table bl.audit_log disable row level security',
    'OWNER TO': 'alter table bl.audit_log owner to postgres',
    'DROP TABLE': 'drop table bl.audit_log',
    'DROP SCHEMA CASCADE': 'drop schema bl cascade',
    'DROP TABLE clubs CASCADE': 'drop table bl.clubs cascade',
    'DROP TRIGGER': 'drop trigger audit_log_no_truncate on bl.audit_log',
    'CREATE TRIGGER': 'create trigger zz before insert on bl.audit_log for each row execute function bl.audit_log_immutable()',
    'CREATE RULE': 'create rule r1 as on update to bl.audit_log do instead nothing',
    'DROP POLICY': 'drop policy audit_log_app_select on bl.audit_log',
    'CREATE POLICY': 'create policy p1 on bl.audit_log for all to public using (true)',
    'DROP CONSTRAINT': 'alter table bl.audit_log drop constraint audit_log_chain_seq',
    'REPLACE FUNCTION':
      "create or replace function bl.audit_row_hash(p_prev_hash text, p_id uuid, p_club_id uuid, p_seq bigint, p_created_at timestamptz, p_actor_type text, p_actor_id uuid, p_action text, p_object_type text, p_object_id uuid, p_reason text, p_data jsonb) returns text language sql stable as $$ select repeat('0', 64) $$",
    'REPLACE TRIGGER FUNCTION':
      'create or replace function bl.audit_log_immutable() returns trigger language plpgsql as $$ begin return null; end $$',
    'RENAME FUNCTION': 'alter function bl.audit_log_chain() rename to x_chain',
    'ALTER FUNCTION OWNER': 'alter function bl.audit_verify(uuid) owner to postgres',
    'DROP FUNCTION CASCADE': 'drop function bl.audit_log_immutable() cascade',
  };

  it('запрещена суперпользователю, в том числе в режиме replica', async () => {
    for (const replica of [false, true]) {
      await asRole(db.pool, null, { replica }, async (c) => {
        for (const [what, sql] of Object.entries(DDL)) {
          const err = await tryQuery(c, sql);
          assert.ok(err, `${what} прошло (replica=${replica})`);
          assert.match(err.message, /protected|append-only/, `${what}: ${err.message}`);
        }
      });
    }
  });

  it('запрещена владельцу журнала (на случай, если его роль кто-то получит)', async () => {
    await asRole(db.pool, 'bl_audit_owner', {}, async (c) => {
      for (const what of ['DISABLE TRIGGER USER', 'NO FORCE RLS', 'DROP TABLE', 'CREATE RULE', 'REPLACE TRIGGER FUNCTION']) {
        const err = await tryQuery(c, DDL[what]);
        assert.ok(err, `${what} от владельца прошло`);
      }
    });
  });

  it('роль с CREATEROLE (postgres) может выдать себе bl_audit_owner, но журнал не меняет', async (t) => {
    await asRole(db.pool, 'postgres', {}, async (c) => {
      const grantErr = await tryQuery(c, 'grant bl_audit_owner to postgres');
      if (grantErr) {
        t.diagnostic(`postgres не может выдать себе bl_audit_owner: ${grantErr.message}`);
      } else {
        t.diagnostic('postgres (CREATEROLE) выдал себе bl_audit_owner — откатывается вместе с транзакцией');
      }
      await c.query('set local role bl_audit_owner').catch(() => {});
      for (const sql of [ATTEMPTS.UPDATE, ATTEMPTS.DELETE, ATTEMPTS.TRUNCATE, DDL['DISABLE TRIGGER USER'], DDL['DROP TABLE']]) {
        assert.ok(await tryQuery(c, sql), `прошло: ${sql}`);
      }
    });
    const { rows } = await db.pool.query("select count(*)::int as n from pg_auth_members where roleid = 'bl_audit_owner'::regrole");
    assert.equal(rows[0].n, 0, 'членство откатилось');
  });

  it('не мешает DDL вне журнала: изменение других таблиц и временные таблицы других ролей', async () => {
    await asRole(db.pool, null, {}, async (c) => {
      assert.equal(await tryQuery(c, 'alter table bl.clubs add column zz_probe int'), null);
      assert.equal(await tryQuery(c, 'create index zz_probe_idx on bl.resources (title)'), null);
    });
    for (const role of ['app_api', 'postgres', 'authenticated']) {
      await asRole(db.pool, role, {}, async (c) => {
        assert.equal(await tryQuery(c, 'create temp table zz_probe (a int)'), null, `временная таблица у ${role}`);
      });
    }
  });

  it('событийные триггеры защиты включены как ALWAYS и принадлежат суперпользователю', async () => {
    const { rows } = await db.pool.query(`
      select e.evtname, e.evtevent, e.evtenabled, r.rolsuper, p.pronamespace::regnamespace::text as fn_schema
        from pg_event_trigger e
        join pg_roles r on r.oid = e.evtowner
        join pg_proc p on p.oid = e.evtfoid
       where e.evtname like 'bl\\_audit\\_guard\\_%'
       order by 1`);
    assert.deepEqual(rows, [
      { evtname: 'bl_audit_guard_ddl', evtevent: 'ddl_command_end', evtenabled: 'A', rolsuper: true, fn_schema: 'bl_guard' },
      { evtname: 'bl_audit_guard_drop', evtevent: 'sql_drop', evtenabled: 'A', rolsuper: true, fn_schema: 'bl_guard' },
    ]);
    const trg = await db.pool.query(`
      select tgname, tgenabled from pg_trigger
       where tgrelid = 'bl.audit_log'::regclass and not tgisinternal order by 1`);
    assert.deepEqual(trg.rows, [
      { tgname: 'audit_log_chain', tgenabled: 'A' },
      { tgname: 'audit_log_immutable_row', tgenabled: 'A' },
      { tgname: 'audit_log_immutable_stmt', tgenabled: 'A' },
      { tgname: 'audit_log_no_truncate', tgenabled: 'A' },
    ]);
  });
});
