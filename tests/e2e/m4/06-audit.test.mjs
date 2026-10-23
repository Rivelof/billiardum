// Журнал после сценариев M4 (инварианты 1, 2, 8). Окно — E2E_AUDIT_SINCE_MIN минут (по умолчанию 300).
// 1. audit_verify клуба (API владельца и функция базы) и журнала платформы (club_id null) — ok.
// 2. Каждая команда контроллерам столов 1–6, ушедшая на устройство, имеет device.cmd с тем же cmd_id,
//    включая свет турнирных матчей (сессии source tournament).
// 3. Ручные действия M4 — с причиной: manual.tournament_score, manual.tournament_cancel,
//    plus.match_resolve; действия оператора платформы — в журнале платформы (actor_type support).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, CLUB_A, ok, staff } from './helpers.mjs';

const SINCE = new Date(Date.now() - Number(process.env.E2E_AUDIT_SINCE_MIN || 300) * 60_000);
const TABLES = [1, 2, 3, 4, 5, 6];
let db;

before(async () => {
  db = await adminClient();
});

after(async () => {
  await db?.end();
});

test('audit_verify клуба и журнала платформы — ok', async (t) => {
  const owner = await staff('owner');
  const v = await ok(api('GET', `/api/clubs/${CLUB_A}/audit/verify`, { token: owner.token }));
  const { rows } = await db.query('select * from bl.audit_verify($1)', [CLUB_A]);
  const { rows: p } = await db.query('select * from bl.audit_verify(null)');
  const { rows: m } = await db.query('select count(*)::int as n from bl.audit_log where club_id = $1', [CLUB_A]);
  t.diagnostic(`клуб: API ${JSON.stringify({ ok: v.ok, broken_seq: v.broken_seq, count: v.count })}, база ${JSON.stringify({ ok: rows[0].ok, checked: rows[0].checked })}, записей ${m[0].n}; платформа: ${JSON.stringify({ ok: p[0].ok, checked: p[0].checked, first_bad_seq: p[0].first_bad_seq })}`);
  assert.equal(v.ok, true);
  assert.equal(rows[0].ok, true);
  assert.equal(Number(v.count), m[0].n);
  assert.equal(p[0].ok, true);
});

test('каждая команда свету столов 1–6 за окно имеет device.cmd (и турнирные)', async (t) => {
  const { rows: cmds } = await db.query(
    `select c.id::text as id, c.type, c.status, r.number, s.source from bl.device_commands c join bl.devices d on d.id = c.device_id join bl.resources r on r.id = d.resource_id
       left join bl.sessions s on s.id = c.session_id
      where c.club_id = $1 and c.created_at >= $2 and r.number = any($3::int[]) and c.sent_at is not null`,
    [CLUB_A, SINCE, TABLES],
  ).catch(async () =>
    db.query(
      `select c.id::text as id, c.type, c.status, r.number, null as source from bl.device_commands c join bl.devices d on d.id = c.device_id join bl.resources r on r.id = d.resource_id
        where c.club_id = $1 and c.created_at >= $2 and r.number = any($3::int[]) and c.sent_at is not null`,
      [CLUB_A, SINCE, TABLES],
    ),
  );
  const ids = cmds.map((c) => c.id);
  const { rows: au } = await db.query("select data->>'cmd_id' as id from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = any($2::text[])", [CLUB_A, ids]);
  const have = new Set(au.map((r) => r.id));
  const missing = cmds.filter((c) => !have.has(c.id));
  const types = {};
  for (const c of cmds) types[c.type] = (types[c.type] ?? 0) + 1;
  const tour = cmds.filter((c) => c.source === 'tournament');
  const failed = cmds.filter((c) => c.status === 'failed');
  t.diagnostic(`команд отправлено ${cmds.length} (${JSON.stringify(types)}); из них турнирных ${tour.length} (${[...new Set(tour.map((c) => `${c.type}@${c.number}`))].join(', ')}); без device.cmd ${missing.length}; отклонено контроллером ${failed.length}`);
  assert.ok(cmds.length > 0);
  assert.ok(tour.length > 0, 'есть команды света турнирных матчей');
  assert.deepEqual(missing.map((c) => `${c.type}@${c.number}`), []);
});

test('ручные действия M4 — с причиной; платформа — в своём журнале от имени сотрудника', async (t) => {
  const { rows } = await db.query(
    `select action, count(*)::int as n, count(*) filter (where coalesce(reason, '') = '')::int as no_reason
       from bl.audit_log where created_at >= $1 and action = any($2::text[]) group by action order by action`,
    [SINCE, ['manual.tournament_score', 'manual.tournament_cancel', 'plus.match_resolve', 'platform.review_hide', 'platform.listing_approve']],
  );
  const { rows: plat } = await db.query(
    "select action, actor_type, count(*)::int as n from bl.audit_log where club_id is null and created_at >= $1 group by 1, 2 order by 1",
    [SINCE],
  );
  const { rows: m4 } = await db.query(
    "select action, count(*)::int as n from bl.audit_log where created_at >= $1 and (action like 'tournament.%' or action like 'plus.%' or action like 'directory.%') group by 1 order by 1",
    [SINCE],
  );
  t.diagnostic(`ручные: ${rows.map((r) => `${r.action} ${r.n} (без причины ${r.no_reason})`).join(', ')}; платформа: ${plat.map((r) => `${r.action}/${r.actor_type} ${r.n}`).join(', ')}; M4: ${m4.map((r) => `${r.action} ${r.n}`).join(', ')}`);
  for (const r of rows.filter((x) => x.action.startsWith('manual.') || x.action === 'plus.match_resolve' || x.action === 'platform.review_hide')) assert.equal(r.no_reason, 0, `${r.action} без причины`);
  assert.ok(plat.every((r) => ['support', 'system'].includes(r.actor_type)));
});
