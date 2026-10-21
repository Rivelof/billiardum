// Роли (decisions №12, №34): роли Supabase не читают схему bl, app_api без BYPASSRLS
// и ничем не владеет, роли-владельцы без входа и без членов.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { adminUrl, ALL_TABLES, asRole, CLUB_A, createTestDatabase, tryQuery } from './helpers.mjs';

const OURS = ['bl_owner', 'bl_audit_owner', 'bl_definer', 'app_api'];
// Служебные роли Supabase без входа и без CREATEROLE (decisions №39).
const NOLOGIN_ROLES = [
  'postgres',
  'authenticator',
  'pgbouncer',
  'supabase_auth_admin',
  'supabase_storage_admin',
  'supabase_read_only_user',
  'supabase_replication_admin',
];
// Роли Supabase с BYPASSRLS и роли, в которые может переключиться authenticator.
const SUPABASE_KEY_ROLES = ['postgres', 'service_role', 'supabase_read_only_user', 'anon', 'authenticated', 'authenticator'];

let db;
let roles;

before(async () => {
  db = await createTestDatabase();
  roles = (await db.pool.query('select * from pg_roles order by rolname')).rows;
});

after(async () => {
  await db?.drop();
});

/** Все роли без суперпользователя, кроме наших. */
function foreignRoles() {
  return roles.filter((r) => !r.rolsuper && !OURS.includes(r.rolname)).map((r) => r.rolname);
}

describe('роли Supabase и схема bl', () => {
  it('у всех ролей кроме наших нет USAGE на bl и прав на таблицы', async () => {
    const checked = [];
    for (const role of foreignRoles()) {
      if (['pg_read_all_data', 'pg_write_all_data'].includes(role)) continue; // проверены отдельно: членов нет
      const { rows } = await db.pool.query(
        `select has_schema_privilege($1, 'bl', 'USAGE') as usage,
                bool_or(has_table_privilege($1, 'bl.' || t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) as any_table
           from unnest($2::text[]) as t`,
        [role, ALL_TABLES],
      );
      assert.equal(rows[0].usage, false, `${role}: USAGE на bl`);
      assert.equal(rows[0].any_table, false, `${role}: права на таблицы bl`);
      checked.push(role);
    }
    for (const r of SUPABASE_KEY_ROLES) assert.ok(checked.includes(r), `роль ${r} не проверена`);
  });

  it('роли с BYPASSRLS и роли authenticator не читают ни одной таблицы bl', async (t) => {
    const bypass = roles.filter((r) => r.rolbypassrls && !r.rolsuper).map((r) => r.rolname);
    t.diagnostic(`BYPASSRLS без суперпользователя: ${bypass.join(', ')}`);
    const viaAuthenticator = (
      await db.pool.query(
        `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
          where m.member = 'authenticator'::regrole order by 1`,
      )
    ).rows.map((r) => r.rolname);
    const targets = [...new Set([...bypass, 'authenticator', ...viaAuthenticator, ...SUPABASE_KEY_ROLES])];
    for (const role of targets) {
      await asRole(db.pool, role, { clubId: CLUB_A }, async (c) => {
        for (const table of ALL_TABLES) {
          const err = await tryQuery(c, `select * from bl.${table} limit 1`);
          assert.ok(err, `${role} прочитал bl.${table}`);
          assert.equal(err.code, '42501', `${role} ${table}: ${err.message}`);
        }
        assert.ok(await tryQuery(c, "select bl.device_club('d1000000-0000-4000-8000-000000000001')"), `${role}: device_club`);
      });
    }
  });

  it('pg_read_all_data и pg_write_all_data есть только у суперпользователей', async () => {
    const { rows } = await db.pool.query(`
      select r.rolname as role_name, u.rolname as member
        from pg_auth_members m
        join pg_roles r on r.oid = m.roleid
        join pg_roles u on u.oid = m.member
       where r.rolname in ('pg_read_all_data', 'pg_write_all_data') and not u.rolsuper`);
    assert.deepEqual(rows, []);
  });

  it('права на объекты bl и bl_guard — только у наших ролей', async () => {
    const { rows } = await db.pool.query(`
      with objs as (
        select 'table ' || c.relname as obj, c.relacl as acl from pg_class c
         where c.relnamespace in ('bl'::regnamespace, 'bl_guard'::regnamespace)
        union all
        select 'function ' || p.proname, p.proacl from pg_proc p
         where p.pronamespace in ('bl'::regnamespace, 'bl_guard'::regnamespace)
        union all
        select 'schema ' || n.nspname, n.nspacl from pg_namespace n where n.nspname in ('bl', 'bl_guard')
      )
      select obj, coalesce(r.rolname, 'PUBLIC') as grantee, a.privilege_type
        from objs, aclexplode(objs.acl) a
        left join pg_roles r on r.oid = a.grantee
       where coalesce(r.rolname, 'PUBLIC') not in ('bl_owner', 'bl_audit_owner', 'bl_definer', 'app_api')
         and not coalesce(r.rolsuper, false)`);
    assert.deepEqual(rows, []);
  });
});

describe('служебные роли Supabase без входа (decisions №39)', () => {
  it('NOLOGIN, без CREATEROLE и без пароля', async () => {
    for (const name of NOLOGIN_ROLES) {
      const r = roles.find((x) => x.rolname === name);
      assert.ok(r, `нет роли ${name}`);
      assert.deepEqual({ name, login: r.rolcanlogin, createrole: r.rolcreaterole }, { name, login: false, createrole: false });
    }
    const { rows } = await db.pool.query('select rolname from pg_authid where rolname = any($1) and rolpassword is not null', [NOLOGIN_ROLES]);
    assert.deepEqual(rows, []);
  });

  it('входить могут только суперпользователи и app_api', async () => {
    const login = roles.filter((r) => r.rolcanlogin && !r.rolsuper).map((r) => r.rolname);
    assert.deepEqual(login, ['app_api']);
  });

  it('вход под каждой из них с POSTGRES_PASSWORD отвергается', async () => {
    const url = new URL(adminUrl());
    const password = process.env.POSTGRES_PASSWORD || decodeURIComponent(url.password);
    for (const user of NOLOGIN_ROLES) {
      const c = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), database: db.name, user, password });
      c.on('error', () => {});
      const err = await c.connect().then(
        () => null,
        (e) => e,
      );
      if (!err) await c.end();
      assert.ok(err, `вход под ${user} прошёл`);
      assert.ok(['28000', '28P01'].includes(err.code), `${user}: ${err.code} ${err.message}`);
    }
    // Тот же пароль у суперпользователя работает: отказ дал NOLOGIN, а не неверный пароль в тесте.
    const su = new pg.Client({ host: url.hostname, port: Number(url.port || 5432), database: db.name, user: decodeURIComponent(url.username), password });
    await su.connect();
    await su.end();
  });
});

describe('наши роли', () => {
  it('app_api: вход есть, суперпользователя, BYPASSRLS, CREATEROLE, CREATEDB нет, ничем не владеет', async () => {
    const r = roles.find((x) => x.rolname === 'app_api');
    assert.deepEqual(
      { login: r.rolcanlogin, superuser: r.rolsuper, bypassrls: r.rolbypassrls, createrole: r.rolcreaterole, createdb: r.rolcreatedb, replication: r.rolreplication },
      { login: true, superuser: false, bypassrls: false, createrole: false, createdb: false, replication: false },
    );
    const owned = await db.pool.query(`
      select count(*)::int as n from (
        select relowner as o from pg_class
        union all select proowner from pg_proc
        union all select nspowner from pg_namespace
      ) x where o = 'app_api'::regrole`);
    assert.equal(owned.rows[0].n, 0);
  });

  it('владельцы без входа, без BYPASSRLS, ни в кого не входят и никому не выданы', async () => {
    for (const name of ['bl_owner', 'bl_audit_owner', 'bl_definer']) {
      const r = roles.find((x) => x.rolname === name);
      assert.equal(r.rolcanlogin, false, name);
      assert.equal(r.rolbypassrls, false, name);
      assert.equal(r.rolsuper, false, name);
    }
    const { rows } = await db.pool.query(`
      select r.rolname, u.rolname as member from pg_auth_members m
        join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
       where r.rolname = any($1) or u.rolname = any($1)`,
      [OURS],
    );
    assert.deepEqual(rows, []);
  });

  it('все таблицы с club_id: ENABLE и FORCE ROW LEVEL SECURITY, владелец — не app_api', async () => {
    const { rows } = await db.pool.query(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'club_id' and not a.attisdropped) as has_club
        from pg_class c where c.relnamespace = 'bl'::regnamespace and c.relkind = 'r' order by 1`);
    const byName = Object.fromEntries(rows.map((r) => [r.relname, r]));
    for (const r of rows) {
      if (r.has_club || r.relname === 'clubs' || r.relname === 'users') {
        assert.equal(r.relrowsecurity, true, `${r.relname}: ENABLE RLS`);
        assert.equal(r.relforcerowsecurity, true, `${r.relname}: FORCE RLS`);
      }
      assert.notEqual(r.owner, 'app_api');
    }
    assert.equal(byName.audit_log.owner, 'bl_audit_owner');
    assert.equal(byName.devices.owner, 'bl_owner');
  });

  it('в кластере нет значений app.* по умолчанию для ролей и баз', async () => {
    const { rows } = await db.pool.query(`
      select setrole, setdatabase, cfg from pg_db_role_setting, unnest(setconfig) cfg where cfg like 'app.%'`);
    assert.deepEqual(rows, []);
  });

  it('пароль app_api задаётся хешем SCRAM, в pg_authid нет открытого текста', async (t) => {
    const { rows } = await db.pool.query("select rolpassword from pg_authid where rolname = 'app_api'");
    if (rows[0].rolpassword === null) {
      t.skip('пароль app_api ещё не задан (npm run db:migrate не запускался в этом кластере)');
      return;
    }
    assert.match(rows[0].rolpassword, /^SCRAM-SHA-256\$4096:/);
    if (process.env.DB_APP_PASSWORD) assert.ok(!rows[0].rolpassword.includes(process.env.DB_APP_PASSWORD));
    if (db.appUrl) {
      const c = new pg.Client({ connectionString: db.appUrl });
      await c.connect();
      assert.equal((await c.query('select current_user as u')).rows[0].u, 'app_api');
      await c.end();
    }
  });
});
