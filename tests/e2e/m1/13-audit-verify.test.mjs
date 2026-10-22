// Журнал после сценариев: audit_verify клуба — ok, и у каждой команды, исполненной симулятором
// на столах tester (1–6) за окно E2E_AUDIT_SINCE_MIN минут (по умолчанию 180), есть запись
// device.cmd с тем же cmd_id (свет только командой с записью в журнале, инвариант 1).
// Цепочка проверяется и в API владельца (GET /api/clubs/{club}/audit/verify), и функцией базы.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, CLUB_A, logLines, MY_TABLES, ok, SIM_CONTAINER, staff } from './helpers.mjs';

const SINCE = new Date(Date.now() - Number(process.env.E2E_AUDIT_SINCE_MIN || 180) * 60_000);
let db;

before(async () => {
  db = await adminClient();
});

after(async () => {
  await db?.end();
});

test('audit_verify клуба — ok (API владельца и функция базы)', async (t) => {
  const owner = await staff('owner');
  const v = await ok(api('GET', `/api/clubs/${CLUB_A}/audit/verify`, { token: owner.token }));
  t.diagnostic(`GET /api/clubs/{club}/audit/verify → ${JSON.stringify({ ok: v.ok, broken_seq: v.broken_seq, count: v.count, head: v.head_hash?.slice(0, 12) })}`);
  assert.equal(v.ok, true);
  assert.equal(v.broken_seq, null);
  const { rows } = await db.query('select * from bl.audit_verify($1)', [CLUB_A]);
  t.diagnostic(`bl.audit_verify: ${JSON.stringify(rows[0])}`);
  const { rows: m } = await db.query('select count(*)::int as n, max(seq)::int as max from bl.audit_log where club_id = $1', [CLUB_A]);
  assert.equal(Number(v.count), m[0].n, 'проверены все записи клуба');
  const rec = await staff('reception');
  const denied = await api('GET', `/api/clubs/${CLUB_A}/audit/verify`, { token: rec.token });
  t.diagnostic(`ресепшн → audit/verify: HTTP ${denied.status} ${denied.text}`);
  assert.equal(denied.status, 403);
});

test('каждая команда, исполненная контроллером (столы 1–6), есть в журнале device.cmd', async (t) => {
  const lines = logLines(SIM_CONTAINER, SINCE, 'sim_cmd').filter((l) => MY_TABLES.includes(l.table) && ['ok', 'resend'].includes(l.result) && l.cmd_id);
  const ids = [...new Set(lines.map((l) => l.cmd_id))];
  const { rows } = await db.query("select data->>'cmd_id' as cmd_id from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = any($2::text[])", [CLUB_A, ids]);
  const found = new Set(rows.map((r) => r.cmd_id));
  const missing = ids.filter((id) => !found.has(id));
  const relays = logLines(SIM_CONTAINER, SINCE, 'sim_relay').filter((l) => MY_TABLES.includes(l.table));
  const relayMissing = relays.filter((l) => !found.has(l.cmd_id));
  const types = {};
  for (const l of lines) types[l.type] = (types[l.type] ?? 0) + 1;
  t.diagnostic(`команд исполнено: ${ids.length} (${JSON.stringify(types)}); без записи в журнале: ${missing.length}; включений света (sim_relay): ${relays.length}, без записи: ${relayMissing.length}`);
  assert.ok(ids.length > 0);
  assert.deepEqual(missing, []);
  assert.deepEqual(relayMissing, []);
});
