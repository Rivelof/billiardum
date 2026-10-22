// T7. Перезагрузка контроллера посреди игры → свет возвращается после session.resume, остаток верный.
//
// Гость платит 5 минут; через 20 с — перезагрузка симулятора (питание пропало на 2 с). Правило 4:
// после загрузки свет выключен, событие boot, ожидание ответа сервера. Сервер отвечает
// session.resume с остатком по paid_until: свет горит, остаток контроллера = paid_until − сейчас
// (± 3 с). Журнал: device.event boot, device.cmd session.resume. В конце «Закончить игру».

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief, CLUB_A, logLines, ok, session, sim, SIM_CONTAINER, simPost, sleep, startGame, waitFor, waitSim, waitTableFree } from './helpers.mjs';

const TABLE = Number(process.env.E2E_T7_TABLE || 1);
let db;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  await db?.end();
});

test(`T7: стол ${TABLE} — перезагрузка посреди игры, свет после session.resume, остаток верный`, { timeout: 3 * 60_000 }, async (t) => {
  const game = await startGame(TABLE, 5);
  const on = await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  const s0 = await session(game.guest.token, game.sessionId);
  const paidUntil = new Date(s0.paid_until).getTime();
  await sleep(20_000);
  const bootBefore = (await sim(TABLE)).state.boot;

  const tReboot = new Date();
  const r = await simPost(TABLE, 'reboot', { down_ms: 2000, reset_reason: 'poweron' });
  t.diagnostic(`перезагрузка: ${brief(r.json.table)} powered=${r.json.table.powered}`);
  // Сразу после перезагрузки свет выключен.
  const dark = await sim(TABLE);
  assert.equal(dark.state?.relay ?? false, false, 'свет выключен на время перезагрузки');

  const lit = await waitSim(TABLE, (x) => x.powered && x.state.boot > bootBefore && x.state.relay === true && x.state.session_id === game.sessionId, {
    timeoutMs: 40_000,
    intervalMs: 50,
    what: 'свет после session.resume',
  });
  const tLit = Date.now();
  const expected = paidUntil - tLit;
  const cmds = logLines(SIM_CONTAINER, tReboot, ['sim_cmd', 'sim_relay', 'sim_reboot']).filter((l) => l.table === TABLE);
  t.diagnostic(`после загрузки (boot ${bootBefore} → ${lit.state.boot}): ${brief(lit)}; свет через ${((tLit - tReboot) / 1000).toFixed(1)} с после перезагрузки (2 с без питания)`);
  t.diagnostic(`симулятор: ${cmds.map((l) => `${l.msg}${l.type ? `:${l.type}` : ''}${l.result ? `:${l.result}` : ''}`).join(', ')}`);
  t.diagnostic(`остаток контроллера ${lit.state.remaining_ms} мс, ожидаемый по paid_until ${expected} мс, разница ${lit.state.remaining_ms - expected} мс`);
  assert.ok(cmds.some((l) => l.msg === 'sim_relay' && l.type === 'session.resume'), 'свет включила session.resume');
  assert.ok(Math.abs(lit.state.remaining_ms - expected) < 3000, 'остаток верный (±3 с)');
  assert.ok(lit.state.remaining_ms < on.state.remaining_ms, 'перезагрузкой не получить лишнего времени');

  const { rows } = await db.query(
    "select action, data->>'type' as type from bl.audit_log where club_id = $1 and created_at >= $2 and (data->>'session_id' = $3 or (action = 'device.event' and object_id = $4)) order by seq",
    [CLUB_A, tReboot, game.sessionId, on.device_id],
  );
  t.diagnostic(`журнал после перезагрузки: ${rows.map((x) => `${x.action}(${x.type})`).join(', ')}`);
  assert.ok(rows.some((x) => x.action === 'device.cmd' && x.type === 'session.resume'));
  const ev = await waitFor(async () => (await db.query("select type, boot from bl.device_events where device_id = $1 and type = 'boot' and received_at >= $2", [on.device_id, tReboot])).rows[0], { timeoutMs: 5000, what: 'boot' });
  t.diagnostic(`событие boot: ${JSON.stringify(ev)}`);
  const s1 = await session(game.guest.token, game.sessionId);
  assert.equal(s1.paid_until, s0.paid_until, 'оплаченное время не изменилось');

  await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }));
  await waitSim(TABLE, (x) => x.state.mode === 'free' && x.state.relay === false, { timeoutMs: 5000 });
});
