// T8. Повтор старой команды session.extend → replayed_seq, свет не продлён, событие в журнале.
//
// Гость платит 3 минуты и дважды продлевает на 1 минуту (две команды session.extend). Через
// 100 с старая команда (первое продление: его remaining_ms уже на ~40 с больше текущего остатка) подаётся
// контроллеру повторно: режим симулятора replay-old (как атакующий, записавший команду с провода).
// Ожидаемо: ack replayed_seq, остаток контроллера = paid_until − сейчас (не вырос), событие
// replayed_seq в bl.device_events и в журнале (device.event), тревога replayed_seq.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  brief,
  CLUB_A,
  extendGame,
  logLines,
  ok,
  session,
  sim,
  SIM_CONTAINER,
  simPost,
  sleep,
  staff,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_T8_TABLE || 1);
let db;
let faultOn = false;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  if (faultOn) await simPost(TABLE, 'fault', { name: 'replay-old', on: false });
  await db?.end();
});

test(`T8: стол ${TABLE} — повтор старой session.extend не продлевает свет`, { timeout: 4 * 60_000 }, async (t) => {
  const game = await startGame(TABLE, 3);
  await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  const sid = game.sessionId;
  const rid = game.tbl.resource.id;
  await extendGame(game.guest, rid, sid, 1);
  await waitFor(async () => (await db.query("select 1 from bl.device_commands where session_id = $1 and type = 'session.extend' and status = 'acked'", [sid])).rowCount === 1, { timeoutMs: 10_000, what: 'первое продление acked' });
  await extendGame(game.guest, rid, sid, 1);
  await waitFor(async () => (await db.query("select 1 from bl.device_commands where session_id = $1 and type = 'session.extend' and status = 'acked'", [sid])).rowCount === 2, { timeoutMs: 10_000, what: 'второе продление acked' });
  const { rows: ext } = await db.query("select id, seq, (body->>'remaining_ms')::int as rem, acked_at from bl.device_commands where session_id = $1 and type = 'session.extend' order by seq", [sid]);
  t.diagnostic(`продления: ${JSON.stringify(ext.map((e) => ({ seq: e.seq, remaining_ms: e.rem })))}`);

  // Ждём, пока остаток первого продления станет заметно больше текущего (второе дало +60 с).
  await sleep(100_000);
  const before = await sim(TABLE);
  assert.ok(ext[0].rem - before.state.remaining_ms > 30_000, 'повтор старой команды дал бы лишнее время');
  const s = await session(game.guest.token, sid);
  const tReplay = new Date();
  const r = await simPost(TABLE, 'fault', { name: 'replay-old', on: true });
  faultOn = true;
  t.diagnostic(`replay-old: ${JSON.stringify(r.json.replayed)}; до повтора: ${brief(before)}; сервер remaining=${s.remaining_ms}`);
  assert.equal(r.json.replayed?.type, 'session.extend', 'повторена старая session.extend');
  assert.equal(Number(r.json.replayed?.seq), Number(ext[0].seq), 'именно первое продление');
  assert.equal(r.json.replayed?.result, 'replayed_seq');
  await simPost(TABLE, 'fault', { name: 'replay-old', on: false });
  faultOn = false;

  await sleep(1500);
  const after = await sim(TABLE);
  const s2 = await session(game.guest.token, sid);
  const expected = new Date(s2.paid_until).getTime() - Date.now();
  const oldRem = ext[0].rem;
  t.diagnostic(`после повтора: ${brief(after)}; ожидаемый остаток по paid_until ${expected}; remaining_ms старой команды ${oldRem}`);
  assert.ok(Math.abs(after.state.remaining_ms - expected) < 3000, 'остаток не изменился');
  assert.ok(after.state.remaining_ms < oldRem - 30_000, 'старая команда не вернула остаток');
  assert.equal(s2.paid_until, s.paid_until);

  const simLog = logLines(SIM_CONTAINER, tReplay, ['sim_cmd', 'sim_replay_old']).filter((l) => l.table === TABLE);
  t.diagnostic(`симулятор: ${simLog.map((l) => `${l.msg}:${l.type}:${l.seq}:${l.result}`).join(', ')}`);
  assert.ok(simLog.some((l) => l.msg === 'sim_cmd' && l.result === 'replayed_seq'));

  const ev = await waitFor(
    async () => (await db.query("select type, data, received_at from bl.device_events where device_id = $1 and type = 'replayed_seq' and received_at >= $2", [before.device_id, tReplay])).rows[0],
    { timeoutMs: 10_000, what: 'событие replayed_seq у сервера' },
  );
  const { rows: au } = await db.query("select action, data from bl.audit_log where club_id = $1 and created_at >= $2 and object_id = $3 and action = 'device.event'", [CLUB_A, tReplay, before.device_id]);
  t.diagnostic(`bl.device_events: ${JSON.stringify(ev)}; журнал device.event: ${JSON.stringify(au.map((a) => a.data.type))}`);
  assert.ok(au.some((a) => a.data.type === 'replayed_seq'), 'replayed_seq в журнале');
  const owner = await staff('owner');
  const alarms = await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }));
  const al = alarms.find((a) => a.type === 'replayed_seq' && (a.resource_id ?? a.resource?.id) === rid);
  t.diagnostic(`тревога: ${JSON.stringify(al && { type: al.type, level: al.level, count: al.count, last_raised_at: al.last_raised_at })}`);
  assert.ok(al, 'тревога replayed_seq');

  await ok(api('POST', `/api/sessions/${sid}/stop`, { token: game.guest.token, body: {} }));
  await waitSim(TABLE, (x) => x.state.mode === 'free', { timeoutMs: 5000 });
});
