// PoC M1 — изоляция клубов на таблицах денег и света (атакующий: посторонний к данным другого клуба).
// Инвариант 5: RLS по club_id. Временная база bl_pentest_iso с двумя клубами; под app_api с
// контекстом клуба A строк клуба B не видно ни в одной таблице M1; с контекстом B — видно
// (значит, прячет именно RLS). API выставляет контекст только на клуб, где у пользователя роль
// (это проверено живыми тестами access.test.mjs). В конце база удаляется.
//
// Запуск: node --test tests/security/m1/isolation_db.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readEnv, adminUrl, sql } from './helper.mjs';

const env = readEnv();
const admin = adminUrl();
const TMPDB = 'bl_pentest_iso';
const adminTmp = admin.replace(/\/postgres(\?|$)/, `/${TMPDB}$1`);
const available = Boolean(admin);

const A = 'c1000000-0000-4000-8000-000000000001'; // клуб из сида
const B = 'caaaaaaa-0000-4000-8000-0000000000bb'; // чужой клуб
const UB = 'aaaaaaaa-0000-4000-8000-0000000000bb';
const RB = 'eaaaaaaa-0000-4000-8000-0000000000bb';
const DB_ = 'daaaaaaa-0000-4000-8000-0000000000bb';
const QB = 'faaaaaaa-0000-4000-8000-0000000000bb';
const PB = 'baaaaaaa-0000-4000-8000-0000000000bb';
const RRB = ' caaaaaaa-0000-4000-8000-0000000000cc'.trim();
const SB = 'aaaaaaaa-0000-4000-8000-0000000000cc';
const HB = 'eaaaaaaa-0000-4000-8000-0000000000cc';
const CMDB = 'daaaaaaa-0000-4000-8000-0000000000cc';

// Таблицы M1, которые должны быть изолированы по клубу.
const TABLES = [
  'quotes', 'payments', 'reception_requests', 'receipts',
  'sessions', 'session_participants', 'session_payments',
  'resource_holds', 'device_commands', 'device_events',
];

async function q(query, params = []) {
  return sql(query, params, adminTmp);
}

let client; // отдельное соединение для проверок под app_api

before(async () => {
  if (!available) return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const run = promisify(execFile);
  await sql(`drop database if exists ${TMPDB}`);
  await sql(`create database ${TMPDB}`);
  const cEnv = { ...process.env, DATABASE_ADMIN_URL: adminTmp, DB_APP_PASSWORD: env.DB_APP_PASSWORD, NODE_ENV: 'development' };
  await run('node', ['supabase/bin/migrate.mjs'], { cwd: ROOT, env: cEnv });
  await run('node', ['supabase/bin/seed.mjs'], { cwd: ROOT, env: cEnv });

  // Клуб B и полная цепочка данных (суперпользователь — мимо RLS).
  await q("insert into bl.clubs (id,name,city,timezone,settings) values ($1,'Клуб B','Казань','Europe/Moscow','{}')", [B]);
  await q("insert into bl.users (id,phone) values ($1,'+79991112233') on conflict do nothing", [UB]);
  await q("insert into bl.resources (id,club_id,type,number,title) values ($1,$2,'billiard_pool',1,'B1')", [RB, B]);
  await q("insert into bl.devices (id,club_id,resource_id,mqtt_username) values ($1,$2,$3,$4)", [DB_, B, RB, DB_]);
  await q("insert into bl.quotes (id,club_id,resource_id,user_id,kind,minutes,from_at,amount_kopecks,valid_until) values ($1,$2,$3,$4,'start',60,now(),50000,now()+interval '3 min')", [QB, B, RB, UB]);
  await q("insert into bl.payments (id,club_id,resource_id,user_id,quote_id,kind,provider,method,provider_payment_id,idempotence_key,status,amount_kopecks,capture) values ($1,$2,$3,$4,$5,'start','yookassa','sbp','prov-b','ik-b','pending',50000,true)", [PB, B, RB, UB, QB]);
  await q("insert into bl.reception_requests (id,club_id,quote_id,resource_id,user_id,kind,minutes,amount_kopecks,status,expires_at) values ($1,$2,$3,$4,$5,'start',60,50000,'waiting',now()+interval '15 min')", [RRB, B, QB, RB, UB]);
  await q("insert into bl.receipts (club_id,payment_id,kind,channel,status,amount_kopecks,items) values ($1,$2,'sale','kkt','receipt_pending',50000,'[]')", [B, PB]);
  await q("insert into bl.sessions (id,club_id,resource_id,status,payer_user_id,started_at,paid_until,created_at,updated_at) values ($1,$2,$3,'active',$4,now(),now()+interval '1 hour',now(),now())", [SB, B, RB, UB]);
  await q("insert into bl.session_participants (session_id,club_id,user_id,role,ordinal,joined_at) values ($1,$2,$3,'payer',1,now())", [SB, B, UB]);
  await q("insert into bl.session_payments (payment_id,club_id,session_id,kind,outcome,minutes,amount_kopecks,created_at) values ($1,$2,$3,'start','applied',60,50000,now())", [PB, B, SB]);
  await q("insert into bl.resource_holds (id,club_id,resource_id,kind,user_id,until,created_at) values ($1,$2,$3,'pending',$4,now()+interval '3 min',now())", [HB, B, RB, UB]);
  await q("insert into bl.device_commands (id,club_id,device_id,seq,type,status,cause,created_at) values ($1,$2,$3,1,'session.start','sent','payment',now())", [CMDB, B, DB_]);
  await q("insert into bl.device_events (club_id,device_id,boot,boot_id,n,type,received_at) values ($1,$2,0,'0a0b0c0d',1,'boot',now())", [B, DB_]);

  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  client = new Client({ connectionString: adminTmp });
  await client.connect();
});

/** Под app_api с контекстом clubId: число видимых строк клуба target в таблице. */
async function visibleRows(table, clubId, target) {
  await client.query('reset role');
  await client.query("select set_config('app.club_id', $1, false)", [clubId]);
  await client.query("select set_config('app.user_id', '', false)");
  await client.query("select set_config('app.actor_type', 'user', false)");
  await client.query('set role app_api');
  let n;
  try {
    const r = await client.query(`select count(*)::int as n from bl.${table} where club_id = $1`, [target]);
    n = Number(r.rows[0].n);
  } finally {
    await client.query('reset role');
  }
  return n;
}

test('контекст клуба A не видит строк клуба B ни в одной таблице M1', { skip: available ? false : 'нет DATABASE_ADMIN_URL' }, async () => {
  for (const t of TABLES) {
    const n = await visibleRows(t, A, B);
    assert.equal(n, 0, `таблица ${t}: под контекстом A видно ${n} строк клуба B (ожидали 0)`);
  }
});

test('контекст клуба B видит свои строки (прячет именно RLS, а не отсутствие данных)', { skip: available ? false : 'нет DATABASE_ADMIN_URL' }, async () => {
  for (const t of TABLES) {
    const n = await visibleRows(t, B, B);
    assert.ok(n >= 1, `таблица ${t}: под контекстом B свои строки не видны (${n})`);
  }
});

test('без контекста клуба (пустой app.club_id) — ноль строк клуба B', { skip: available ? false : 'нет DATABASE_ADMIN_URL' }, async () => {
  for (const t of TABLES) {
    const n = await visibleRows(t, '', B);
    assert.equal(n, 0, `таблица ${t}: без контекста видно ${n} строк (ожидали 0)`);
  }
});

after(async () => {
  if (client) await client.end().catch(() => {});
  if (available) await sql(`drop database if exists ${TMPDB}`);
});
