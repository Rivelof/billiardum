// Критерий 2: UPDATE, DELETE и TRUNCATE в bl.audit_log падают для любой роли.
// Рабочая база стека npm run dev; каждая попытка — в транзакции, которая всегда
// откатывается (ROLLBACK), даже если попытка неожиданно прошла.
//
// Проверяется:
// * суперпользователь supabase_admin (DATABASE_ADMIN_URL), в том числе в режиме
//   session_replication_role = replica (обход обычных триггеров);
// * app_api — настоящий вход по DATABASE_URL, с контекстом клуба и без;
// * SET ROLE суперпользователя во все роли из pg_roles, в которые он может переключиться.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { adminClient, appClient, attempt, CLUB_A, setContext } from './helpers.mjs';

const ATTACKS = [
  ['UPDATE', "update bl.audit_log set reason = 'e2e-tamper', action = 'device.cmd.tampered' where true"],
  ['DELETE', 'delete from bl.audit_log where true'],
  ['TRUNCATE', 'truncate bl.audit_log'],
];

// Отказ защиты: триггер журнала (P0001 «append-only») или нет прав (42501).
// Блокировка (55P03) — не доказательство, а помеха: повторяем.
function classify(r) {
  if (r.ok) return 'ПРОШЛО';
  if (/append-only/.test(r.message)) return 'trigger';
  if (r.code === '42501') return 'no_privilege';
  return `other:${r.code}`;
}

let admin;
let fingerprintBefore;

async function fingerprint(c) {
  const { rows } = await c.query(
    `select count(*)::int as n, coalesce(max(seq), 0)::int as max_seq,
            md5(coalesce(string_agg(hash, ',' order by club_id nulls first, seq), '')) as digest
       from bl.audit_log`,
  );
  return rows[0];
}

/** Одна атака в своей транзакции (BEGIN … ROLLBACK), с повтором при блокировке. */
async function tryAttack(c, prepare, sql) {
  for (let i = 0; i < 5; i += 1) {
    await c.query('begin');
    try {
      await c.query("set local lock_timeout = '3s'");
      await c.query("set local statement_timeout = '10s'");
      await prepare(c);
      const r = await attempt(c, sql);
      if (!r.ok && r.code === '55P03') continue;
      return r;
    } finally {
      await c.query('rollback');
    }
  }
  return { ok: false, code: '55P03', message: 'lock timeout ×5' };
}

before(async () => {
  admin = await adminClient();
  fingerprintBefore = await fingerprint(admin);
});

after(async () => {
  if (!admin) return;
  const fpAfter = await fingerprint(admin);
  // Сервер мог дописать записи (ping после переподключения), но старые не меняются.
  const { rows } = await admin.query(
    `select md5(coalesce(string_agg(hash, ',' order by club_id nulls first, seq), '')) as digest
       from (select hash, club_id, seq from bl.audit_log order by club_id nulls first, seq limit $1) s`,
    [fingerprintBefore.n],
  );
  await admin.end();
  assert.ok(fpAfter.n >= fingerprintBefore.n, 'записей журнала стало меньше');
  assert.equal(rows[0].digest, fingerprintBefore.digest, 'старые записи журнала изменились');
});

test('супер-пользователь supabase_admin: UPDATE/DELETE/TRUNCATE падают (и в режиме replica)', async (t) => {
  const { rows } = await admin.query('select current_user, rolsuper from pg_roles where rolname = current_user');
  assert.equal(rows[0].current_user, 'supabase_admin');
  assert.equal(rows[0].rolsuper, true);
  for (const replica of [false, true]) {
    for (const [name, sql] of ATTACKS) {
      const r = await tryAttack(
        admin,
        async (c) => {
          if (replica) await c.query('set local session_replication_role = replica');
        },
        sql,
      );
      t.diagnostic(`supabase_admin${replica ? ' (replica)' : ''} ${name}: ${r.ok ? 'ПРОШЛО' : `${r.code} ${r.message}`}`);
      assert.equal(r.ok, false, `${name} прошёл у суперпользователя`);
      assert.equal(classify(r), 'trigger', `${name}: ожидали отказ триггера журнала`);
    }
  }
});

test('app_api (вход по DATABASE_URL): UPDATE/DELETE/TRUNCATE падают с контекстом клуба и без', async (t) => {
  const app = await appClient();
  try {
    const { rows } = await app.query(
      'select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    assert.equal(rows[0].current_user, 'app_api');
    assert.equal(rows[0].rolsuper, false);
    assert.equal(rows[0].rolbypassrls, false);
    for (const club of [CLUB_A, null]) {
      // С контекстом клуба записи журнала видны (SELECT), но не меняются.
      await app.query('begin');
      await setContext(app, club);
      const visible = Number((await app.query('select count(*) from bl.audit_log')).rows[0].count);
      await app.query('rollback');
      for (const [name, sql] of ATTACKS) {
        const r = await tryAttack(app, (c) => setContext(c, club), sql);
        t.diagnostic(`app_api club=${club ? 'A' : '—'} (видно записей: ${visible}) ${name}: ${r.ok ? 'ПРОШЛО' : `${r.code} ${r.message}`}`);
        assert.equal(r.ok, false, `${name} прошёл у app_api`);
        assert.ok(['trigger', 'no_privilege'].includes(classify(r)), `${name}: неожиданная ошибка ${r.code}`);
      }
      if (club) assert.ok(visible > 0, 'с контекстом клуба app_api должен видеть журнал клуба');
    }
  } finally {
    await app.end();
  }
});

test('SET ROLE во все роли pg_roles: UPDATE/DELETE/TRUNCATE падают у каждой', async (t) => {
  const { rows: roles } = await admin.query('select rolname from pg_roles order by rolname');
  const switched = [];
  const notSwitchable = [];
  const table = [];
  for (const { rolname } of roles) {
    // Можно ли переключиться в роль (суперпользователь — во все, кроме особых).
    await admin.query('begin');
    let canSwitch = true;
    try {
      await admin.query(`set local role ${pg.escapeIdentifier(rolname)}`);
    } catch (err) {
      canSwitch = false;
      notSwitchable.push(`${rolname} (${err.code})`);
    } finally {
      await admin.query('rollback');
    }
    if (!canSwitch) continue;
    switched.push(rolname);
    const row = [rolname];
    for (const [name, sql] of ATTACKS) {
      const r = await tryAttack(
        admin,
        async (c) => {
          await c.query(`set local role ${pg.escapeIdentifier(rolname)}`);
          if (rolname === 'app_api') await setContext(c, CLUB_A);
        },
        sql,
      );
      row.push(`${name}=${classify(r)}`);
      assert.equal(r.ok, false, `${name} прошёл под ролью ${rolname}`);
      assert.ok(['trigger', 'no_privilege'].includes(classify(r)), `${rolname} ${name}: неожиданная ошибка ${r.code} ${r.message}`);
    }
    table.push(row.join(' '));
  }
  t.diagnostic(`ролей в pg_roles: ${roles.length}; переключились: ${switched.length}; нельзя: ${notSwitchable.join(', ') || 'нет'}`);
  for (const line of table) t.diagnostic(line);
  // Обязательные роли из контракта M0 §5 присутствуют в проверке.
  for (const must of ['supabase_admin', 'bl_owner', 'bl_audit_owner', 'app_api', 'anon', 'authenticated', 'service_role', 'authenticator', 'postgres']) {
    assert.ok(switched.includes(must), `роль ${must} не проверена`);
  }
});

test('суперпользователь не снимает защиту DDL-командой (в транзакции с ROLLBACK)', async (t) => {
  const ddl = [
    'alter table bl.audit_log disable trigger audit_log_immutable_row',
    'alter table bl.audit_log disable trigger all',
    'alter table bl.audit_log no force row level security',
    'drop trigger audit_log_no_truncate on bl.audit_log',
    'alter table bl.audit_log owner to supabase_admin',
  ];
  for (const sql of ddl) {
    const r = await tryAttack(admin, async () => {}, sql);
    t.diagnostic(`${sql}: ${r.ok ? 'ПРОШЛО' : `${r.code} ${r.message}`}`);
    assert.equal(r.ok, false, `DDL прошла: ${sql}`);
  }
});

test('владелец журнала bl_audit_owner и pg_write_all_data упираются именно в триггер', async (t) => {
  for (const role of ['bl_audit_owner', 'pg_write_all_data']) {
    for (const [name, sql] of ATTACKS.slice(0, 2)) {
      const r = await tryAttack(admin, (c) => c.query(`set local role ${role}`), sql);
      t.diagnostic(`${role} ${name}: ${r.code} ${r.message}`);
      assert.equal(classify(r), 'trigger');
    }
  }
});
