// PoC M5.5, заход 2 — миграция 1352 (№218): терминалы управляющего сети гаснут вместе с его доступом.
// «Старые» терминалы (заведённые до исправления) создаются прямой вставкой на СВОЁМ временном Postgres; сами
// операции сети — настоящими маршрутами API (вывод клуба, отзыв управляющего, архив сети).
// Проверяется и границы затрагиваемого: прямое членство не страдает, чужие клубы не затрагиваются, терминал
// не оживает при повторном приглашении, функция недоступна app_api, права bl_definer — ровно два столбца.
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-5/17-network-terminals-db.test.mjs

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { newToken, tokenHash } from '../../../server/auth/index.mjs';
import { CLUB_A, CLUB_B, PHONES, setup } from '../../../server/orders/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const NM1 = '+79990000501';
const NM2 = '+79990000502';
const HYBRID = '+79990000503';

let h;
let owner;
let manager;
let reception;
let net;
const req = (method, path, who, body, extra = {}) => h.request(method, path, { token: who.token, body, club: undefined, ...extra });
const terminal = async (club, createdBy, name) => {
  const token = newToken();
  await h.q(
    `insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at) values ($1, $2, $3, $4, now(), now() + interval '365 days')`,
    [club, name, tokenHash(token), createdBy],
  );
  return token;
};
const alive = async (token) => (await h.request('GET', '/api/staff/terminal', { token })).status === 200;

before(async () => {
  if (SKIP) return;
  h = await setup({ extraRoutes: ['owner.mjs', 'networks.mjs', 'staff.mjs'] });
  owner = await h.login(PHONES.owner);
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
  // Владелец A владеет и клубом B (чтобы собрать сеть из двух клубов).
  await h.q("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'owner') on conflict do nothing", [CLUB_B, OWNER_A]);
  const created = await req('POST', '/api/networks', owner, { name: 'Сеть Т' });
  net = created.json.id;
  for (const c of [CLUB_A, CLUB_B]) assert.equal((await req('POST', `/api/networks/${net}/clubs`, owner, { club_id: c })).status, 201);
});
after(async () => {
  await h?.close();
});

async function invite(phone) {
  const inv = await req('POST', `/api/networks/${net}/managers`, owner, { phone });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  const login = await h.request('POST', '/api/auth/dev', { body: { phone } });
  assert.equal(login.status, 200);
  return { member: inv.json.id, id: login.json.user.id, token: login.json.token };
}

describe('1352: границы отзыва терминалов', { skip: SKIP }, () => {
  let nm;
  const t = {};
  it('подготовка: управляющий сети (оба клуба), прямой управляющий A, гибрид (прямой в A и приглашён в сеть)', async () => {
    nm = await invite(NM1);
    t.nmA = await terminal(CLUB_A, nm.id, 'NM в A');
    t.nmB = await terminal(CLUB_B, nm.id, 'NM в B');
    t.direct = await terminal(CLUB_A, manager.id, 'прямой управляющий A');
    t.ownerA = await terminal(CLUB_A, OWNER_A, 'владелец A');
    // Гибрид: сначала прямой управляющий A, затем приглашён в сеть — строка остаётся прямой (network_id пуст).
    const hybridId = (await h.login(HYBRID)).id;
    await h.q("insert into bl.club_members (club_id, user_id, role, active) values ($1, $2, 'manager', true) on conflict (club_id, user_id) do update set active = true, role = 'manager', network_id = null", [CLUB_A, hybridId]);
    t.hybrid = await terminal(CLUB_A, hybridId, 'гибрид');
    const hy = await invite(HYBRID);
    assert.equal(hy.id, hybridId);
    t.hybridMember = hy.member;
    const row = (await h.q('select network_id, active, role from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, hybridId]))[0];
    assert.equal(row.network_id, null, 'прямое членство гибрида не превращено в сетевое');
    // PIN-вход ресепшена на терминале управляющего сети.
    await h.q('update bl.club_members set pin_hash = null where user_id = $1', [reception.id]);
    for (const k of ['nmA', 'nmB', 'direct', 'ownerA', 'hybrid']) assert.equal(await alive(t[k]), true, k);
  });

  it('вывод клуба A из сети: терминал NM в A погашен; NM в B, прямой, владельца и гибрида — живы', async () => {
    assert.equal((await req('DELETE', `/api/networks/${net}/clubs/${CLUB_A}`, owner)).status, 200);
    assert.equal(await alive(t.nmA), false, 'NM в A');
    assert.equal(await alive(t.nmB), true, 'NM в B (клуб B остался в сети)');
    assert.equal(await alive(t.direct), true, 'прямой управляющий A');
    assert.equal(await alive(t.ownerA), true, 'владелец A');
    assert.equal(await alive(t.hybrid), true, 'гибрид (прямое членство в A)');
    const nmRow = (await h.q('select active, network_id from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, nm.id]))[0];
    assert.deepEqual([nmRow.active, nmRow.network_id], [false, null]);
  });

  it('отзыв управляющего: терминал в B погашен; прямые и гибрид — живы; гибрид остаётся управляющим A', async () => {
    assert.equal((await req('POST', `/api/networks/${net}/clubs`, owner, { club_id: CLUB_A })).status, 201); // вернули A
    assert.equal((await req('DELETE', `/api/networks/${net}/managers/${nm.member}`, owner)).status, 200);
    assert.equal(await alive(t.nmB), false, 'NM в B');
    assert.equal(await alive(t.direct), true);
    assert.equal(await alive(t.hybrid), true);
    const hy = (await h.q("select active, role, network_id from bl.club_members where club_id = $1 and user_id = (select id from bl.users where phone = $2)", [CLUB_A, HYBRID]))[0];
    assert.deepEqual([hy.active, hy.role, hy.network_id], [true, 'manager', null]);
  });

  it('отзыв гибрида как управляющего сети не гасит его прямой терминал', async () => {
    assert.equal((await req('DELETE', `/api/networks/${net}/managers/${t.hybridMember}`, owner)).status, 200);
    assert.equal(await alive(t.hybrid), true);
  });

  it('повторное приглашение того же номера не оживляет погашенные терминалы', async () => {
    const again = await invite(NM1);
    assert.equal(again.id, nm.id);
    t.again = again;
    assert.equal(await alive(t.nmA), false);
    assert.equal(await alive(t.nmB), false);
    const revoked = await h.q('select count(*)::int as n from bl.staff_terminals where created_by = $1 and revoked_at is null', [nm.id]);
    assert.equal(revoked[0].n, 0);
  });

  it('побочный эффект: PIN-токен ресепшена, выданный на терминале управляющего сети, умирает с терминалом (клуб теряет рабочее место, пока владелец не заведёт новый)', async () => {
    const again = t.again; // управляющий снова держит доступ к A и B от сети (приглашён в предыдущем тесте)
    const term = await terminal(CLUB_A, again.id, 'NM в A (2)');
    const pin = '246810';
    const set = await h.request('PUT', '/api/staff/pin', { token: reception.token, body: { club_id: CLUB_A, pin } });
    assert.equal(set.status, 200, JSON.stringify(set.json));
    const sw = await h.request('POST', '/api/staff/pin', { token: term, body: { user_id: reception.id, pin } });
    assert.equal(sw.status, 200, JSON.stringify(sw.json));
    const work = () => h.request('GET', `/api/clubs/${CLUB_A}/pos/settings`, { token: sw.json.token, club: CLUB_A });
    assert.equal((await work()).status, 200, 'до отзыва ресепшн работает');
    assert.equal((await req('DELETE', `/api/networks/${net}/managers/${again.member}`, owner)).status, 200);
    assert.equal((await work()).status, 401, 'после отзыва управляющего PIN-токен ресепшена на его терминале мёртв');
  });

  it('архив сети гасит терминалы NM2, выданные в клубах сети', async () => {
    const n2 = await invite(NM2);
    const a = await terminal(CLUB_A, n2.id, 'NM2 в A');
    const b = await terminal(CLUB_B, n2.id, 'NM2 в B');
    assert.equal(await alive(a) && await alive(b), true);
    assert.equal((await req('DELETE', `/api/networks/${net}`, owner)).status, 200);
    assert.equal(await alive(a), false);
    assert.equal(await alive(b), false);
    assert.equal(await alive(t.direct), true, 'прямой терминал пережил архив сети');
    assert.equal(await alive(t.ownerA), true);
  });
});

describe('1352: права и изоляция на уровне базы', { skip: SKIP }, () => {
  it('network_sync_access недоступна app_api и PUBLIC; владелец bl_definer, search_path закреплён', async () => {
    const f = (await h.q(
      `select p.proowner::regrole::text as owner, p.prosecdef, p.proconfig, has_function_privilege('app_api', p.oid, 'execute') as app_exec,
              has_function_privilege('public', p.oid, 'execute') as public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'bl' and p.proname = 'network_sync_access'`,
    ))[0];
    assert.deepEqual([f.owner, f.prosecdef, f.app_exec, f.public_exec], ['bl_definer', true, false, false]);
    assert.ok(f.proconfig.includes('search_path=pg_catalog, pg_temp'));
    // Прямой вызов из контекста клуба: отказ по правам, терминалы не тронуты.
    const attempt = await h.pool.query('select bl.network_sync_access($1)', [net]).then(() => 'ok', (e) => e.code);
    assert.equal(attempt, '42501');
  });

  it('права bl_definer на staff_terminals: select (id, club_id, token_hash, expires_at, revoked_at, created_by), update (revoked_at) — и только они', async () => {
    const cols = await h.q(
      `select a.attname, a.attacl::text from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'bl' and c.relname = 'staff_terminals' and a.attacl is not null and a.attacl::text like '%bl_definer%' order by 1`,
    );
    const map = Object.fromEntries(cols.map((c) => [c.attname, /bl_definer=([a-z]+)\//.exec(c.attacl)[1]]));
    assert.deepEqual(map, { club_id: 'r', created_by: 'r', expires_at: 'r', id: 'r', revoked_at: 'rw', token_hash: 'r' });
    const table = (await h.q("select relacl::text as acl from pg_class where oid = 'bl.staff_terminals'::regclass"))[0].acl;
    assert.ok(!/bl_definer/.test(table), `табличных прав у bl_definer нет: ${table}`);
    const flags = (await h.q("select rolsuper, rolbypassrls from pg_roles where rolname = 'bl_definer'"))[0];
    assert.deepEqual([flags.rolsuper, flags.rolbypassrls], [false, false]);
    const rls = (await h.q("select relrowsecurity, relforcerowsecurity, relowner::regrole::text as owner from pg_class where oid = 'bl.staff_terminals'::regclass"))[0];
    assert.deepEqual([rls.relrowsecurity, rls.relforcerowsecurity, rls.owner], [true, true, 'bl_owner']);
  });

  it('изоляция: из контекста клуба B app_api не видит и не меняет терминалы клуба A (в том числе revoked_at = null)', async () => {
    const tokA = await terminal(CLUB_A, OWNER_A, 'для проверки изоляции');
    await h.q("update bl.staff_terminals set revoked_at = now() where name = 'для проверки изоляции'");
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [CLUB_B, OWNER_A]);
      const seen = await c.query("select count(*)::int as n from bl.staff_terminals where club_id = $1", [CLUB_A]);
      const upd = await c.query("update bl.staff_terminals set revoked_at = null where club_id = $1", [CLUB_A]);
      const ins = await c.query("insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at) values ($1, 'подброшен', $2, $3, now(), now() + interval '1 day')", [CLUB_A, tokenHash(newToken()), OWNER_A]).then(() => 'вставлено', (e) => e.code);
      await c.query('rollback');
      assert.equal(seen.rows[0].n, 0, 'чужие терминалы не видны');
      assert.equal(upd.rowCount, 0, 'чужие терминалы не меняются');
      assert.equal(ins, '42501', `вставка в чужой клуб: ${ins}`);
    } finally {
      c.release();
    }
    assert.equal(await alive(tokA), false);
  });

  it('наблюдение: app_api в контексте СВОЕГО клуба может снять revoked_at у терминала (столбцовое право с 0100) — защиты от оживления в базе нет', async () => {
    const tok = await terminal(CLUB_A, OWNER_A, 'оживление');
    await h.q("update bl.staff_terminals set revoked_at = now() where name = 'оживление'");
    assert.equal(await alive(tok), false);
    const c = await h.pool.connect();
    let revived;
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [CLUB_A, OWNER_A]);
      revived = (await c.query("update bl.staff_terminals set revoked_at = null where name = 'оживление'")).rowCount;
      await c.query('commit');
    } finally {
      c.release();
    }
    console.log(`INFO  app_api вернул погашенный терминал в работу прямым UPDATE: строк ${revived}, жив: ${await alive(tok)} (нужна уязвимость на уровне кода API; совет — триггер «revoked_at не сбрасывается»)`);
    assert.ok(revived === 1);
  });
});
