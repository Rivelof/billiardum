// PoC M5.5 — слой БД: RLS ENABLE+FORCE, SECURITY DEFINER (владелец bl_definer, search_path), права
// app_api, триггер BLN10 на club_members (эскалация управляющим сети и клубом), неактивный владелец,
// гонка «один клуб — две сети».
//
// ТОЛЬКО на своём временном Postgres (НЕ на базе стенда). Нужны два адреса:
//   POC_PG_ADMIN_URL  — суперпользователь временной базы с применёнными миграциями (npm run db:migrate
//                       или supabase/lib/db.mjs migrate());
//   POC_PG_APP_URL    — та же база, роль app_api (пароль задан при миграции).
// Без них тест пропускается. См. README.md в этой папке.
//
// Запуск: POC_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres \
//         POC_PG_APP_URL=postgres://app_api:...@127.0.0.1:55432/postgres \
//         node tests/security/m5-5/09-db-guards.test.mjs

import { createRequire } from 'node:module';
import { check, summary } from './_helpers.mjs';

const require = createRequire(new URL('../../../server/package.json', import.meta.url));
const { Client } = require('pg');

const ADMIN = process.env.POC_PG_ADMIN_URL;
const APP = process.env.POC_PG_APP_URL;
if (!ADMIN || !APP) {
  console.log('SKIP: задайте POC_PG_ADMIN_URL и POC_PG_APP_URL (свой временный Postgres)');
  process.exit(0);
}
// Страховка: не работаем с базой стенда.
if (!/(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN)) {
  console.log('STOP: ожидается временный Postgres на 127.0.0.1:55xxx, а не база стенда');
  process.exit(2);
}

const results = [];
const admin = new Client({ connectionString: ADMIN });
await admin.connect();

/** Транзакция app_api с контекстом (club null — личный). Возвращает { ok, error?, value? }. */
async function asApp({ userId, clubId = null, actor = 'user' }, fn, { commit = true } = {}) {
  const c = new Client({ connectionString: APP });
  await c.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true), set_config('app.club_mode', '', true)", [clubId ?? '', userId ?? '', actor]);
    const value = await fn(c);
    await c.query(commit ? 'commit' : 'rollback');
    return { ok: true, value };
  } catch (error) {
    await c.query('rollback').catch(() => {});
    return { ok: false, error };
  } finally {
    await c.end();
  }
}
const code = (r) => (r.ok ? 'ok' : r.error.code ?? r.error.message);

const mkUser = async (phone) => (await admin.query('insert into bl.users (phone, phone_verified_at) values ($1, now()) returning id', [phone])).rows[0].id;
const U = {
  owner: await mkUser(`+7999673${String(Date.now() % 10000).padStart(4, '0')}`),
  mgr: await mkUser(`+7999674${String((Date.now() + 1) % 10000).padStart(4, '0')}`),
  other: await mkUser(`+7999675${String((Date.now() + 2) % 10000).padStart(4, '0')}`),
};
const mkClub = async (userId, name) => (await asApp({ userId }, (c) => c.query("select bl.create_club($1, 'Екатеринбург', null, 'Asia/Yekaterinburg', null) as id", [name]))).value.rows[0].id;
const club1 = await mkClub(U.owner, 'PoC db 1');
const club2 = await mkClub(U.owner, 'PoC db 2');
const clubOther = await mkClub(U.other, 'PoC db other');

const netId = (await asApp({ userId: U.owner }, (c) => c.query("select bl.network_create('PoC net') as id"))).value.rows[0].id;
const net2 = (await asApp({ userId: U.owner }, (c) => c.query("select bl.network_create('PoC net 2') as id"))).value.rows[0].id;
await asApp({ userId: U.owner }, (c) => c.query('select bl.network_add_club($1, $2)', [netId, club1]));
await asApp({ userId: U.owner }, (c) => c.query('select bl.network_add_club($1, $2)', [netId, club2]));
// Управляющий сети: приглашение по телефону, привязка при «входе».
const mgrPhone = (await admin.query('select phone from bl.users where id = $1', [U.mgr])).rows[0].phone;
await asApp({ userId: U.owner }, (c) => c.query("select bl.network_invite($1, $2, now() + interval '7 days')", [netId, mgrPhone]));
await asApp({ userId: U.mgr }, (c) => c.query('select * from bl.network_accept_invites()'));
const mgrRow = (await admin.query('select role, active, network_id from bl.club_members where club_id = $1 and user_id = $2', [club1, U.mgr])).rows[0];
check(results, 'подготовка: управляющий сети получил строку club_members (manager, network_id)', mgrRow?.role === 'manager' && mgrRow?.network_id === netId, JSON.stringify(mgrRow));

// A. Каталог: RLS ENABLE+FORCE, владельцы, функции.
{
  const t = (await admin.query(`select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced, pg_get_userbyid(c.relowner) as owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'bl' and c.relname in ('networks','network_clubs','network_members','network_tariff_rules','network_products') order by 1`)).rows;
  check(results, 'новые таблицы сети: ENABLE+FORCE RLS, владелец bl_owner', t.length === 5 && t.every((r) => r.rls && r.forced && r.owner === 'bl_owner'), JSON.stringify(t));
  const f = (await admin.query(`select p.proname, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig::text, '') as cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'bl' and (p.proname like 'network\\_%' or p.proname in ('club_subscriptions_network_plan','club_members_network_guard')) order by 1`)).rows;
  const definers = f.filter((r) => r.definer);
  check(results, 'SECURITY DEFINER-функции сети: владелец bl_definer и search_path закреплён', definers.length >= 12 && definers.every((r) => r.owner === 'bl_definer' && /search_path=pg_catalog, pg_temp/.test(r.cfg)), JSON.stringify(definers.filter((r) => r.owner !== 'bl_definer' || !/search_path=pg_catalog, pg_temp/.test(r.cfg))));
  const guard = f.find((r) => r.proname === 'club_members_network_guard');
  check(results, 'триггерная функция guard: INVOKER, search_path закреплён, владелец bl_owner', guard && !guard.definer && guard.owner === 'bl_owner' && /search_path/.test(guard.cfg), JSON.stringify(guard));
  // Все DEFINER-функции схемы bl (шире M5.5): без search_path или с владельцем-суперпользователем.
  const all = (await admin.query(`select p.proname, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig::text,'') as cfg, r.rolsuper from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner where n.nspname = 'bl' and p.prosecdef`)).rows;
  const weak = all.filter((r) => !/search_path/.test(r.cfg) || r.rolsuper);
  check(results, 'все DEFINER-функции bl: search_path закреплён, владелец не суперпользователь', weak.length === 0, JSON.stringify(weak.map((r) => r.proname)));
}

// B. Права app_api: внутренние функции недоступны, прямые записи в таблицы сети запрещены.
{
  const internal = ['bl.network_sync_access(uuid)', 'bl.network_sync_billing(uuid)', 'bl.network_plan_for(uuid)', 'bl.network_me()', 'bl.network_owned(uuid)'];
  const exec = [];
  for (const fn of internal) exec.push([fn, (await admin.query('select has_function_privilege($1, $2::regprocedure, $3) as ok', ['app_api', fn, 'execute'])).rows[0].ok]);
  check(results, 'app_api не может вызвать внутренние функции сети напрямую (sync_access, sync_billing, plan_for, me, owned)', exec.every(([, ok]) => !ok), JSON.stringify(exec.filter(([, ok]) => ok)));
  const pub = (await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='bl' and p.proname like 'network\\_%' and has_function_privilege('public', p.oid, 'execute')`)).rows;
  check(results, 'PUBLIC не имеет EXECUTE на функции сети', pub.length === 0, JSON.stringify(pub));
  const attempts = {
    insert_network: await asApp({ userId: U.owner }, (c) => c.query("insert into bl.networks (owner_user_id, name) values ($1, 'x')", [U.owner])),
    insert_member: await asApp({ userId: U.owner }, (c) => c.query("insert into bl.network_members (network_id, phone, invited_by, expires_at) values ($1, '+79996739999', $2, now() + interval '1 day')", [netId, U.owner])),
    set_owner: await asApp({ userId: U.owner }, (c) => c.query('update bl.networks set owner_user_id = $2 where id = $1', [netId, U.other])),
    delete_network: await asApp({ userId: U.owner }, (c) => c.query('delete from bl.networks where id = $1', [netId])),
    insert_nclub: await asApp({ userId: U.owner }, (c) => c.query('insert into bl.network_clubs (network_id, club_id, added_by) values ($1, $2, $3)', [netId, clubOther, U.owner])),
    set_nclub_network: await asApp({ userId: U.owner, clubId: club1 }, (c) => c.query('update bl.network_clubs set network_id = $2 where club_id = $1', [club1, net2])),
    set_nclub_club: await asApp({ userId: U.owner, clubId: club1 }, (c) => c.query('update bl.network_clubs set club_id = $2 where club_id = $1', [club1, clubOther])),
  };
  const bad = Object.entries(attempts).filter(([, r]) => r.ok && (r.value?.rowCount ?? 1) > 0);
  check(results, 'app_api: прямые INSERT/DELETE/смена владельца и состава сети запрещены', bad.length === 0, bad.map(([k]) => k).join(', ') || Object.entries(attempts).map(([k, r]) => `${k}=${code(r)}`).join(' '));
}

// C. BLN10: эскалация по строке управляющего сети — сам управляющий и владелец клуба.
{
  const mgrCtx = { userId: U.mgr, clubId: club1 };
  const ownCtx = { userId: U.owner, clubId: club1 };
  const tries = {
    'управляющий → role=owner': await asApp(mgrCtx, (c) => c.query("update bl.club_members set role = 'owner' where club_id = $1 and user_id = $2", [club1, U.mgr])),
    'управляющий → active=false (снять запрет/выйти из учёта)': await asApp(mgrCtx, (c) => c.query('update bl.club_members set active = false where club_id = $1 and user_id = $2', [club1, U.mgr])),
    'управляющий → network_id=NULL (оторвать от сети)': await asApp(mgrCtx, (c) => c.query('update bl.club_members set network_id = null where club_id = $1 and user_id = $2', [club1, U.mgr])),
    'управляющий → network_id=другая сеть': await asApp(mgrCtx, (c) => c.query('update bl.club_members set network_id = $3 where club_id = $1 and user_id = $2', [club1, U.mgr, net2])),
    'владелец клуба → role=reception у управляющего сети': await asApp(ownCtx, (c) => c.query("update bl.club_members set role = 'reception' where club_id = $1 and user_id = $2", [club1, U.mgr])),
    'владелец клуба → active=false у управляющего сети': await asApp(ownCtx, (c) => c.query('update bl.club_members set active = false where club_id = $1 and user_id = $2', [club1, U.mgr])),
    'владелец клуба → вставка строки с network_id': await asApp(ownCtx, (c) => c.query("insert into bl.club_members (club_id, user_id, role, network_id, active) values ($1, $2, 'manager', $3, true)", [club1, U.other, netId])),
  };
  const succeeded = Object.entries(tries).filter(([, r]) => r.ok && (r.value?.rowCount ?? 1) > 0);
  check(results, 'эскалация через club_members заблокирована (BLN10 / RLS) во всех 7 вариантах', succeeded.length === 0, succeeded.map(([k]) => k).join('; ') || Object.entries(tries).map(([k, r]) => `${k.slice(0, 22)}=${code(r)}`).join(' | '));
  // ИНФО (не M5.5, M1 №62): политика club_members_app проверяет только club_id = контекст клуба; роль
  // проверяет API-слой. Любая новая ручка, пустившая не-члена в контекст чужого клуба, дала бы запись.
  const nonMember = await asApp({ userId: U.other, clubId: club1 }, (c) => c.query("insert into bl.club_members (club_id, user_id, role, active) values ($1, $2, 'owner', true)", [club1, U.other]));
  console.log(`INFO  RLS club_members доверяет контексту клуба: не-член в контексте чужого клуба вставил owner = ${nonMember.ok ? 'ДА (по API недостижимо)' : code(nonMember)}`);
  await admin.query("delete from bl.club_members where club_id = $1 and user_id = $2 and role = 'owner'", [club1, U.other]);
  // DELETE строки управляющего сети клубом: триггера на DELETE нет — смотрим, что происходит.
  const del = await asApp(ownCtx, (c) => c.query('delete from bl.club_members where club_id = $1 and user_id = $2', [club1, U.mgr]));
  const still = (await admin.query('select count(*)::int as n from bl.club_members where club_id = $1 and user_id = $2', [club1, U.mgr])).rows[0].n;
  check(results, 'DELETE строки управляющего сети рабочей ролью не проходит (нет права/политики)', !del.ok || (del.value?.rowCount ?? 0) === 0 || still === 1, `delete=${code(del)} rowCount=${del.value?.rowCount} строка осталась=${still}`);
  // Контроль: свой PIN управляющий менять может (это нужно для терминала).
  const pin = await asApp(mgrCtx, (c) => c.query("update bl.club_members set pin_hash = 'scrypt$1$1$1$a$b' where club_id = $1 and user_id = $2", [club1, U.mgr]));
  check(results, 'контроль: управляющий сети может задать себе PIN (нужная функция не сломана)', pin.ok && pin.value.rowCount === 1, `pin=${code(pin)}`);
}

// D. Клуб, где ты не активный владелец: деактивированный владелец и чужой клуб.
{
  const own2 = (await admin.query("select 1 from bl.club_members where club_id = $1 and user_id = $2 and role = 'owner' and active", [club2, U.owner])).rowCount;
  await admin.query("update bl.club_members set active = false where club_id = $1 and user_id = $2 and role = 'owner'", [club2, U.owner]);
  await asApp({ userId: U.owner }, (c) => c.query('select bl.network_remove_club($1, $2)', [netId, club2]));
  const re = await asApp({ userId: U.owner }, (c) => c.query('select bl.network_add_club($1, $2)', [netId, club2]));
  check(results, 'деактивированный владелец не может добавить клуб в сеть (BLN01)', own2 === 1 && !re.ok && re.error.code === 'BLN01', `был активным=${own2} результат=${code(re)}`);
  await admin.query("update bl.club_members set active = true where club_id = $1 and user_id = $2 and role = 'owner'", [club2, U.owner]);
  const foreign = await asApp({ userId: U.owner }, (c) => c.query('select bl.network_add_club($1, $2)', [netId, clubOther]));
  check(results, 'чужой клуб в свою сеть (BLN01)', !foreign.ok && foreign.error.code === 'BLN01', `result=${code(foreign)}`);
  const othersNet = await asApp({ userId: U.other }, (c) => c.query('select bl.network_add_club($1, $2)', [netId, clubOther]));
  check(results, 'чужая сеть: свой клуб в чужую сеть (BLN03)', !othersNet.ok && othersNet.error.code === 'BLN03', `result=${code(othersNet)}`);
  const asClubCtx = await asApp({ userId: U.owner, clubId: club1 }, (c) => c.query('select bl.network_add_club($1, $2)', [net2, club2]));
  check(results, 'функции сети не работают из контекста клуба (только личный контекст)', !asClubCtx.ok, `result=${code(asClubCtx)}`);
  const asSystem = await asApp({ userId: U.owner, actor: 'system' }, (c) => c.query('select bl.network_add_club($1, $2)', [net2, club2]));
  check(results, 'функции сети не работают от actor_type != user', !asSystem.ok, `result=${code(asSystem)}`);
}

// E. Гонка: один и тот же клуб одновременно в две сети одного владельца.
{
  const raceClub = await mkClub(U.owner, 'PoC race');
  const run = (n) => asApp({ userId: U.owner }, async (c) => {
    await c.query('select pg_sleep(0.05)');
    return c.query('select bl.network_add_club($1, $2)', [n, raceClub]);
  });
  const [r1, r2] = await Promise.all([run(netId), run(net2)]);
  const active = (await admin.query('select network_id from bl.network_clubs where club_id = $1 and active', [raceClub])).rows;
  const oks = [r1, r2].filter((r) => r.ok).length;
  check(results, 'гонка: клуб одновременно в две сети — ровно одна активная строка', active.length === 1 && oks === 1, `успехов=${oks} активных=${active.length} r1=${code(r1)} r2=${code(r2)}`);
}

// F. RLS: посторонний в личном контексте и контексте чужого клуба не видит сеть.
{
  const tables = ['networks', 'network_clubs', 'network_members', 'network_tariff_rules', 'network_products'];
  const seen = {};
  for (const t of tables) {
    const r = await asApp({ userId: U.other }, (c) => c.query(`select count(*)::int as n from bl.${t}`));
    seen[t] = r.ok ? r.value.rows[0].n : code(r);
  }
  check(results, 'посторонний (личный контекст): не видит ни одной строки таблиц сети', Object.values(seen).every((n) => n === 0), JSON.stringify(seen));
  const seenClub = {};
  for (const t of tables) {
    const r = await asApp({ userId: U.other, clubId: clubOther }, (c) => c.query(`select count(*)::int as n from bl.${t}`));
    seenClub[t] = r.ok ? r.value.rows[0].n : code(r);
  }
  check(results, 'посторонний (контекст своего клуба вне сети): не видит строк таблиц сети', Object.values(seenClub).every((n) => n === 0), JSON.stringify(seenClub));
  // Клуб сети видит ровно свою строку network_clubs, не соседние клубы сети.
  const own = await asApp({ userId: U.owner, clubId: club1 }, (c) => c.query('select club_id from bl.network_clubs'));
  check(results, 'контекст клуба сети: из network_clubs виден только свой клуб', own.ok && own.value.rows.length === 1 && own.value.rows[0].club_id === club1, own.ok ? JSON.stringify(own.value.rows.map((r) => r.club_id === club1)) : code(own));
  // Управляющий сети в личном контексте не видит приглашения и управляющих (только владелец).
  const mem = await asApp({ userId: U.mgr }, (c) => c.query('select count(*)::int as n from bl.network_members where network_id = $1 and user_id <> $2', [netId, U.mgr]));
  const list = await asApp({ userId: U.mgr }, (c) => c.query('select * from bl.network_members_list($1)', [netId]));
  check(results, 'управляющий сети: чужих строк network_members нет, список управляющих — только владельцу', mem.ok && mem.value.rows[0].n === 0 && !list.ok, `members=${mem.ok ? mem.value.rows[0].n : code(mem)} list=${code(list)}`);
}

await admin.end();
process.exit(summary(results).length ? 1 : 0);
