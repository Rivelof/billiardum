// Журнал после сценариев M3 (инварианты 1, 2, 8). Окно — E2E_AUDIT_SINCE_MIN минут (по умолчанию 240).
// 1. audit_verify клуба — ok (API владельца и функция базы), проверены все записи.
// 2. Каждая команда контроллерам столов tester (1–6) из bl.device_commands, ушедшая на устройство,
//    и каждая команда, исполненная симулятором (лог sim_cmd), имеет запись device.cmd с тем же cmd_id.
// 3. У каждой брони окна есть booking.create; у каждой подтверждённой предоплатой — booking.confirm;
//    сгоревшей — booking.expire; начатой — booking.start; отменённой — booking.cancel или
//    manual.booking_cancel (с причиной); у каждой зачтённой/удержанной предоплаты — payment.settled
//    или payment.forfeited; у каждого депозита — reception.deposit; у каждого отзыва партии
//    пакета — manual.package_refund с причиной.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, CLUB_A, logLines, ok, SIM_CONTAINER, staff } from './helpers.mjs';

const SINCE = new Date(Date.now() - Number(process.env.E2E_AUDIT_SINCE_MIN || 240) * 60_000);
const TABLES = [1, 2, 3, 4, 5, 6];
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
  const { rows } = await db.query('select * from bl.audit_verify($1)', [CLUB_A]);
  const { rows: m } = await db.query('select count(*)::int as n from bl.audit_log where club_id = $1', [CLUB_A]);
  t.diagnostic(`API: ${JSON.stringify({ ok: v.ok, broken_seq: v.broken_seq, count: v.count })}; bl.audit_verify: ${JSON.stringify(rows[0])}; записей клуба ${m[0].n}`);
  assert.equal(v.ok, true);
  assert.equal(v.broken_seq, null);
  assert.equal(rows[0].ok, true);
  assert.equal(Number(v.count), m[0].n);
});

test('каждая команда свету столов 1–6 за окно имеет запись device.cmd', async (t) => {
  const { rows: cmds } = await db.query(
    `select c.id::text as id, c.type, c.status, r.number from bl.device_commands c join bl.devices d on d.id = c.device_id join bl.resources r on r.id = d.resource_id
      where c.club_id = $1 and c.created_at >= $2 and r.number = any($3::int[]) and c.sent_at is not null`,
    [CLUB_A, SINCE, TABLES],
  );
  const simIds = logLines(SIM_CONTAINER, SINCE, 'sim_cmd').filter((l) => TABLES.includes(l.table) && l.cmd_id).map((l) => l.cmd_id);
  const ids = [...new Set([...cmds.map((c) => c.id), ...simIds])];
  const { rows: au } = await db.query("select data->>'cmd_id' as id from bl.audit_log where club_id = $1 and action = 'device.cmd' and data->>'cmd_id' = any($2::text[])", [CLUB_A, ids]);
  const have = new Set(au.map((r) => r.id));
  const missing = ids.filter((id) => !have.has(id));
  const types = {};
  for (const c of cmds) types[c.type] = (types[c.type] ?? 0) + 1;
  const failed = cmds.filter((c) => c.status === 'failed');
  t.diagnostic(`команд отправлено ${cmds.length} (${JSON.stringify(types)}), исполнено симулятором ${new Set(simIds).size}; без записи ${missing.length}; отклонено контроллером ${failed.length} (${failed.map((c) => `${c.type}@${c.number}`).join(', ')})`);
  assert.ok(ids.length > 0);
  assert.deepEqual(missing, []);
});

async function missing(sql, actions, { reason = false } = {}) {
  const { rows } = await db.query(sql, [CLUB_A, SINCE]);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { total: 0, missing: [] };
  const { rows: au } = await db.query(
    `select coalesce(object_id::text, '') as o, data::text as d, reason from bl.audit_log where club_id = $1 and action = any($2::text[]) and created_at >= $3`,
    [CLUB_A, actions, SINCE],
  );
  const bad = ids.filter((id) => !au.some((a) => (a.o === id || a.d.includes(id)) && (!reason || a.reason)));
  return { total: ids.length, missing: bad };
}

test('у броней, предоплат, депозитов и возвратов пакетов M3 есть записи в журнале', async (t) => {
  const checks = [
    ['брони (booking.create)', 'select id::text from bl.bookings where club_id = $1 and created_at >= $2', ['booking.create']],
    ['подтверждённые предоплатой (booking.confirm)', 'select id::text from bl.bookings where club_id = $1 and created_at >= $2 and prepaid_kopecks > 0', ['booking.confirm']],
    ['сгоревшие (booking.expire)', "select id::text from bl.bookings where club_id = $1 and created_at >= $2 and status = 'expired'", ['booking.expire']],
    ['начатые (booking.start)', "select id::text from bl.bookings where club_id = $1 and created_at >= $2 and started_at is not null", ['booking.start']],
    ['отменённые (booking.cancel / manual.booking_cancel)', "select id::text from bl.bookings where club_id = $1 and created_at >= $2 and status = 'canceled'", ['booking.cancel', 'manual.booking_cancel']],
    ['отменённые персоналом — с причиной', "select id::text from bl.bookings where club_id = $1 and created_at >= $2 and status = 'canceled' and canceled_by is distinct from user_id", ['manual.booking_cancel'], true],
    ['предоплаты зачтены/удержаны (payment.settled / payment.forfeited)', "select id::text from bl.payments where club_id = $1 and created_at >= $2 and kind = 'booking' and settlement_status in ('settled', 'forfeited')", ['payment.settled', 'payment.forfeited']],
    ['депозиты (reception.deposit)', 'select session_id::text as id from bl.payments where club_id = $1 and created_at >= $2 and deposit', ['reception.deposit']],
    ['отозванные партии пакетов (manual.package_refund с причиной)', 'select id::text from bl.balance_lots where club_id = $1 and revoked_at >= $2', ['manual.package_refund'], true],
    ['сотрудники отозваны (staff.revoke)', "select object_id::text as id from bl.audit_log where club_id = $1 and created_at >= $2 and action = 'staff.revoke'", ['staff.revoke']],
  ];
  let bad = 0;
  for (const [name, sql, actions, reason] of checks) {
    const r = await missing(sql, actions, { reason });
    t.diagnostic(`${name}: ${r.total} шт., без записи ${r.missing.length}${r.missing.length ? ` (${r.missing.slice(0, 3).join(', ')})` : ''}`);
    bad += r.missing.length;
  }
  assert.equal(bad, 0);
});
