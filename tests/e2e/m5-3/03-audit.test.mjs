// Журнал после M5.2/M5.3 (инварианты 1, 2, 8): клубы сценария M5.3 (E2E_M53_DIR), клуб сида и цепочка
// платформы — bl.audit_verify ok; у каждой исполненной команды контроллерам клубов сценария — device.cmd;
// у каждого manual.* (в том числе manual.billing_mark_paid, manual.billing_price) — причина; записи
// кассы управляющего и журнала не правятся.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, appClient, CLUB_A, clubCmdsWithAudit, loadState } from './helpers.mjs';

const st = loadState();
const clubs = [st.club, st.club2].filter(Boolean);
let db;

before(async () => {
  db = await adminClient();
});
after(async () => db?.end());

test('audit_verify: клубы M5.3, клуб сида, платформа — ok; команды с device.cmd; manual.* с причиной', async (t) => {
  const out = [];
  for (const c of [...clubs, CLUB_A, null]) {
    const { rows } = await db.query('select * from bl.audit_verify($1)', [c]);
    out.push(`${c ? c.slice(0, 8) : 'платформа'}: ${JSON.stringify(rows[0])}`);
    assert.equal(rows[0].ok, true, `audit_verify ${c ?? 'платформа'}`);
  }
  for (const c of clubs) {
    const { rows: dev } = await db.query('select id from bl.devices where club_id = $1', [c]);
    const { rows: m } = await db.query('select created_at from bl.clubs where id = $1', [c]);
    const { cmds, missing } = await clubCmdsWithAudit(db, c, dev.map((d) => d.id), m[0].created_at);
    out.push(`${c.slice(0, 8)}: команд ${cmds.length}, без device.cmd ${missing.length}`);
    assert.deepEqual(missing, []);
  }
  const man = (await db.query("select action, reason from bl.audit_log where (club_id = any($1::uuid[]) or club_id is null) and action like 'manual.%' and created_at > now() - interval '1 day'", [clubs])).rows;
  assert.ok(man.every((x) => x.reason && x.reason.trim()), 'причина у каждого ручного действия');
  const byAction = {};
  for (const x of man) byAction[x.action] = (byAction[x.action] ?? 0) + 1;
  t.diagnostic(`${out.join('; ')}; manual.* за сутки: ${JSON.stringify(byAction)}`);
});

test('журнал и касса управляющего только дополняются: UPDATE/DELETE — отказ у app_api и у администратора базы', async (t) => {
  const app = await appClient();
  const res = [];
  try {
    for (const [sql, label] of [
      ['update bl.audit_log set reason = $2 where club_id = $1 and seq = (select max(seq) from bl.audit_log where club_id = $1)', 'audit UPDATE'],
      ['delete from bl.audit_log where club_id = $1 and seq = (select max(seq) from bl.audit_log where club_id = $1)', 'audit DELETE'],
      ['update bl.cashbook_entries set amount_kopecks = 1 where club_id = $1', 'cashbook UPDATE'],
      ['delete from bl.cashbook_entries where club_id = $1', 'cashbook DELETE'],
    ]) {
      for (const [who, conn] of [['app_api', app], ['admin', db]]) {
        await conn.query('begin');
        if (who === 'app_api') await conn.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB_A]);
        let r;
        try {
          const x = await conn.query(sql, label.startsWith('audit UPDATE') ? [CLUB_A, 'e2e'] : [CLUB_A]);
          r = `выполнено, строк ${x.rowCount}`;
        } catch (e) {
          r = `отказ ${e.code}`;
        }
        await conn.query('rollback');
        res.push(`${label} ${who}: ${r}`);
        assert.ok(/отказ|строк 0/.test(r), `${label} ${who}: ${r}`);
      }
    }
  } finally {
    await app.end();
  }
  t.diagnostic(res.join('; '));
});
