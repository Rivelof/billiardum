// Журнал новых клубов M5.1 (инварианты 1, 2, 8): для клубов из 01 и 04 (E2E_M5_DIR/state.json) —
// bl.audit_verify ok (цепочка хешей), у каждой исполненной команды контроллерам клуба есть device.cmd,
// у каждого manual.* — причина и тревога manual_action, журнал не правится (UPDATE/DELETE — отказ).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, appClient, attempt, clubCmdsWithAudit, loadState, stopProcess } from './helpers.mjs';

const st = loadState();
const clubs = [st.club, st.ui1280, st.ui360].filter(Boolean);
const skip = clubs.length ? false : 'нет клубов M5 (E2E_M5_DIR/state.json)';
let db;

before(async () => {
  if (!skip) db = await adminClient();
});
after(async () => {
  await db?.end();
  // Симулятор новых контроллеров из 01 — больше не нужен.
  if (!process.env.E2E_M5_KEEP_SIM && st.simPid) stopProcess(st.simPid);
});

test('журнал новых клубов: цепочка цела, команды с device.cmd, ручные действия с причиной', { skip }, async (t) => {
  for (const c of clubs) {
    const { rows: v } = await db.query('select * from bl.audit_verify($1)', [c]);
    const { rows: m } = await db.query('select mode, created_at from bl.clubs where id = $1', [c]);
    const { rows: dev } = await db.query('select id from bl.devices where club_id = $1', [c]);
    const { cmds, missing } = await clubCmdsWithAudit(db, c, dev.map((d) => d.id), m[0].created_at);
    const { rows: man } = await db.query("select action, reason from bl.audit_log where club_id = $1 and action like 'manual.%'", [c]);
    const { rows: acts } = await db.query('select action, count(*)::int as n from bl.audit_log where club_id = $1 group by action order by action', [c]);
    t.diagnostic(`клуб ${c.slice(0, 8)} (${m[0].mode}): audit_verify ${JSON.stringify(v[0])}; команд ${cmds.length} (${[...new Set(cmds.map((x) => x.type))].join(', ')}), без device.cmd ${missing.length}; manual.* ${man.length}; действия: ${acts.map((a) => `${a.action}×${a.n}`).join(', ')}`);
    assert.equal(v[0].ok, true);
    assert.deepEqual(missing, []);
    assert.ok(man.every((x) => x.reason && x.reason.trim()), 'причина у каждого ручного действия');
  }
});

test('журнал только дополняется: UPDATE и DELETE записей нового клуба — отказ и у app_api, и у администратора базы', { skip }, async (t) => {
  const app = await appClient();
  const out = [];
  try {
    for (const [name, cl] of [['app_api', app], ['admin', db]]) {
      await cl.query('begin');
      await cl.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [st.club]);
      const u = await attempt(cl, "update bl.audit_log set reason = 'x' where club_id = $1 and action = 'club.go_live'", [st.club]);
      const d = await attempt(cl, "delete from bl.audit_log where club_id = $1 and action = 'club.create'", [st.club]);
      await cl.query('rollback');
      out.push(`${name}: update ${u.ok ? `ok(${u.rowCount})` : u.code}, delete ${d.ok ? `ok(${d.rowCount})` : d.code}`);
      assert.ok(!u.ok || u.rowCount === 0);
      assert.ok(!d.ok || d.rowCount === 0);
    }
  } finally {
    await app.end();
  }
  t.diagnostic(out.join('; '));
});
