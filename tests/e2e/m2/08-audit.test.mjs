// Журнал после сценариев M2: audit_verify клуба — ok (API владельца и функция базы); у каждой
// продажи кассы и гостя (pos.sale), возврата (pos.refund и payment.refunded), принятой заявки
// стола (reception.accept), пробитого чека ККТ (kkt.receipt_printed), смены (shift.open,
// shift.close) клуба есть запись в журнале. Окно — E2E_AUDIT_SINCE_MIN минут (по умолчанию 240).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, CLUB_A, ok, staff } from './helpers.mjs';

const SINCE = new Date(Date.now() - Number(process.env.E2E_AUDIT_SINCE_MIN || 240) * 60_000);
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
  assert.equal(Number(v.count), m[0].n);
});

async function missingAudit(sql, action, key = 'object_id') {
  const { rows } = await db.query(sql, [CLUB_A, SINCE]);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { total: 0, missing: [] };
  const cond = key === 'object_id' ? 'object_id = any($3::uuid[])' : `data->>'${key}' = any($3::text[])`;
  const { rows: au } = await db.query(
    `select ${key === 'object_id' ? 'object_id::text' : `data->>'${key}'`} as id from bl.audit_log where club_id = $1 and action = $2 and ${cond}`,
    [CLUB_A, action, ids],
  );
  const have = new Set(au.map((r) => r.id));
  return { total: ids.length, missing: ids.filter((id) => !have.has(id)) };
}

test('у каждой продажи, возврата, заявки, чека ККТ и смены есть запись в журнале', async (t) => {
  const checks = [
    ['продажи (pos.sale)', "select id from bl.pos_sales where club_id = $1 and status = 'completed' and created_at >= $2", 'pos.sale'],
    ['возвраты кассы (pos.refund)', 'select sale_id as id from bl.pos_refunds where club_id = $1 and created_at >= $2', 'pos.refund'],
    ['возвраты денег (payment.refunded)', 'select payment_id as id from bl.refunds where club_id = $1 and created_at >= $2', 'payment.refunded', 'payment_id'],
    ['заявки стола (reception.accept)', "select id from bl.reception_requests where club_id = $1 and status = 'accepted' and created_at >= $2", 'reception.accept', 'request_id'],
    ['чеки ККТ (kkt.receipt_printed)', "select id from bl.receipts where club_id = $1 and channel = 'kkt' and status = 'printed' and created_at >= $2 and coalesce(kkt_job->>'manual', 'false') <> 'true'", 'kkt.receipt_printed'],
    ['смены (shift.open)', 'select id from bl.shifts where club_id = $1 and opened_at >= $2', 'shift.open'],
    ['закрытые смены (shift.close)', 'select id from bl.shifts where club_id = $1 and opened_at >= $2 and closed_at is not null', 'shift.close'],
  ];
  let bad = 0;
  for (const [name, sql, action, key] of checks) {
    let r;
    try {
      r = await missingAudit(sql, action, key);
    } catch (e) {
      t.diagnostic(`${name}: запрос не выполнен (${e.message})`);
      bad += 1;
      continue;
    }
    t.diagnostic(`${name}: ${r.total} шт., без записи ${r.missing.length}${r.missing.length ? ` (${r.missing.slice(0, 3).join(', ')})` : ''}`);
    bad += r.missing.length;
  }
  assert.equal(bad, 0);
});
