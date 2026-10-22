// T9. Команда с неверной подписью → bad_sig, тревога.
//
// Команда подаётся контроллеру вживую через HTTP-управление симулятора (только разработка):
// POST /sim/tables/{n}/inject {raw} — строка обрабатывается так, будто пришла в cmd по MQTT
// (проверка §3.1–§3.3, ack в топик ack, события). Брокер и его права тест не трогает.
//
// 1. Учётка bl-admin публиковать в cmd не может: PUBACK 0x87, до контроллера не доходит.
// 2. На свободном столе — session.start (свет на час), подписанная чужим ключом:
//    ack bad_sig (inject и лог сервера), свет не включён, seq контроллера не сдвинулся,
//    событие bad_sig в bl.device_events и журнале (device.event), тревога bad_sig critical в API
//    владельца, alarm.raised в журнале, уведомление владельцу (bl.notifications со статусом).
// 3. На столе с игрой — session.extend той же сессии на час чужим ключом: bad_sig, остаток не вырос.
// Перед прогоном владелец подтверждает старую тревогу bad_sig своего стола (повтор открытой
// тревоги иначе только увеличивает счётчик).

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { connectMqtt, publishQos1, signCommand, topic } from '../m0/helpers.mjs';
import {
  adminClient,
  api,
  brief,
  CLUB_A,
  env,
  loadDevices,
  logLines,
  ok,
  PHONES,
  SERVER_CONTAINER,
  session,
  sim,
  SIM,
  SIM_CONTAINER,
  sleep,
  staff,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_T9_TABLE || 5);
let db;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  await db?.end();
});

/** Команда протокола v1, подписанная чужим ключом (или с заданной подписью). */
function forged(type, body, lastSeq, sig) {
  const cmd = { v: 1, id: randomUUID(), seq: Number(lastSeq) + 1, type, issued_at: Math.floor(Date.now() / 1000), body };
  cmd.sig = sig ?? signCommand(cmd, randomBytes(32).toString('base64')).sig;
  return cmd;
}

async function inject(n, cmd) {
  const r = await fetch(`${SIM}/sim/tables/${n}/inject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ raw: JSON.stringify(cmd) }),
  });
  return { status: r.status, json: await r.json() };
}

test(`T9: bl-admin не может подать команду в cmd стола ${TABLE} (PUBACK 0x87)`, async (t) => {
  const dev = loadDevices().find((d) => d.table_number === TABLE);
  const before = await sim(TABLE);
  const client = await connectMqtt({ clientId: `bl-e2e-t9-${randomBytes(4).toString('hex')}`, username: env('MQTT_ADMIN_USER'), password: env('MQTT_ADMIN_PASSWORD'), protocolVersion: 5 });
  const since = new Date();
  const cmd = forged('ping', {}, before.state.last_seq);
  const r = await publishQos1(client, topic(dev.club_id, dev.device_id, 'cmd'), JSON.stringify(cmd));
  await client.endAsync();
  await sleep(1000);
  const seen = logLines(SIM_CONTAINER, since, 'sim_cmd').filter((l) => l.table === TABLE && l.cmd_id === cmd.id);
  t.diagnostic(`PUBACK: ${JSON.stringify(r)}; симулятор получил: ${seen.length}`);
  assert.equal(r.code, 135);
  assert.equal(seen.length, 0);
});

test(`T9: стол ${TABLE} — session.start с неверной подписью → bad_sig, свет не включён, событие, тревога владельцу`, { timeout: 60_000 }, async (t) => {
  const owner = await staff('owner');
  const rid = (await ok(api('GET', `/api/t/TEST${String(TABLE).padStart(6, '0')}`))).resource.id;
  const open = (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }))).filter((a) => a.type === 'bad_sig' && a.resource_id === rid);
  for (const a of open) await ok(api('POST', `/api/alarms/${a.id}/ack`, { token: owner.token, body: {} }));
  if (open.length) t.diagnostic(`подтверждены старые тревоги bad_sig стола: ${open.length}`);

  const before = await sim(TABLE);
  const since = new Date();
  const cmd = forged('session.start', { session_id: randomUUID(), remaining_ms: 3_600_000, warn_ms: [300_000, 60_000], grace_ms: 120_000, buzzer: true }, before.state.last_seq);
  const r = await inject(TABLE, cmd);
  t.diagnostic(`inject → HTTP ${r.status} result=${r.json.result} reason=${r.json.reason ?? '—'} ack=${JSON.stringify(r.json.ack)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.result, 'bad_sig');
  assert.equal(r.json.ack.ok, false);
  assert.equal(r.json.ack.error, 'bad_sig');
  assert.equal(r.json.ack.cmd_id, cmd.id);

  await sleep(1000);
  const after = await sim(TABLE);
  t.diagnostic(`стол до: ${brief(before)}; после: ${brief(after)}`);
  assert.equal(after.state.relay, false, 'свет не включён');
  assert.equal(after.state.mode, before.state.mode);
  assert.equal(after.state.last_seq, before.state.last_seq, 'seq не сдвинулся');

  const ev = await waitFor(
    async () => (await db.query("select type, data, received_at from bl.device_events where device_id = $1 and type = 'bad_sig' and received_at >= $2", [after.device_id, since])).rows[0],
    { timeoutMs: 10_000, what: 'событие bad_sig у сервера' },
  );
  assert.equal(ev.data.cmd_id, cmd.id);
  const alarm = await waitFor(
    async () => (await ok(api('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: owner.token }))).find((a) => a.type === 'bad_sig' && a.resource_id === rid && new Date(a.last_raised_at) >= since),
    { timeoutMs: 10_000, intervalMs: 200, what: 'тревога bad_sig у владельца' },
  );
  const { rows: au } = await db.query(
    "select action, data from bl.audit_log where club_id = $1 and created_at >= $2 and data->>'type' = 'bad_sig' and action in ('device.event', 'alarm.raised') order by seq",
    [CLUB_A, since],
  );
  const { rows: notes } = await db.query(
    'select n.kind, n.level, n.status, n.text, n.created_at from bl.notifications n join bl.users u on u.id = n.user_id where u.phone = $1 and n.created_at >= $2 order by n.created_at',
    [PHONES.owner, since],
  );
  const ackLog = logLines(SERVER_CONTAINER, since, ['ack_unmatched', 'cmd_ack', 'device_event']).filter((l) => l.device_id === after.device_id).map((l) => `${l.msg}${l.type ? `:${l.type}` : ''}${l.error ? `:${l.error}` : ''}`);
  t.diagnostic(`bl.device_events: ${JSON.stringify(ev.data)} в ${new Date(ev.received_at).toISOString()}; журнал: ${au.map((a) => a.action).join(', ')}; лог сервера: ${ackLog.join(', ') || '—'}`);
  t.diagnostic(`тревога: ${JSON.stringify({ type: alarm.type, level: alarm.level, count: alarm.count, text: alarm.text })} через ${new Date(alarm.last_raised_at) - new Date(ev.received_at)} мс после события; уведомления владельцу: ${notes.map((n) => `${n.kind}/${n.level}[${n.status}] «${n.text}»`).join('; ')}`);
  assert.equal(alarm.level, 'critical');
  assert.ok(au.some((a) => a.action === 'device.event'), 'device.event bad_sig в журнале');
  assert.ok(au.some((a) => a.action === 'alarm.raised'), 'alarm.raised в журнале');
  assert.ok(notes.some((n) => n.kind === 'alarm' && n.level === 'critical' && n.text.includes(`Стол ${TABLE}`)), 'уведомление владельцу');
});

test(`T9: стол ${TABLE} — session.extend идущей игры с неверной подписью не продлевает свет`, { timeout: 60_000 }, async (t) => {
  // Событие bad_sig не чаще раза в 10 с (§4): ждём, чтобы второе тоже дошло.
  await sleep(10_500);
  const game = await startGame(TABLE, 3);
  await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  const before = await sim(TABLE);
  const s0 = await session(game.guest.token, game.sessionId);
  const since = new Date();
  const r = await inject(TABLE, forged('session.extend', { session_id: game.sessionId, remaining_ms: 3_600_000, buzzer: true }, before.state.last_seq));
  const noSig = await inject(TABLE, forged('session.extend', { session_id: game.sessionId, remaining_ms: 3_600_000, buzzer: true }, before.state.last_seq, `${'A'.repeat(43)}=`));
  await sleep(1000);
  const after = await sim(TABLE);
  const expected = new Date(s0.paid_until) - Date.now();
  t.diagnostic(`чужой ключ → ${r.json.result}; подпись из нулей → ${noSig.json.result}; остаток контроллера ${after.state.remaining_ms} мс, по paid_until ${expected} мс; ${brief(after)}`);
  assert.equal(r.json.result, 'bad_sig');
  assert.equal(noSig.json.result, 'bad_sig');
  assert.ok(Math.abs(after.state.remaining_ms - expected) < 3000, 'остаток не вырос');
  assert.equal(after.state.last_seq, before.state.last_seq);
  const ev = await waitFor(
    async () => (await db.query("select count(*)::int as n from bl.device_events where device_id = $1 and type = 'bad_sig' and received_at >= $2", [after.device_id, since])).rows[0].n >= 1,
    { timeoutMs: 10_000, what: 'событие bad_sig' },
  );
  assert.ok(ev);
  const s1 = await session(game.guest.token, game.sessionId);
  assert.equal(s1.paid_until, s0.paid_until);
  await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }));
  await waitSim(TABLE, (x) => x.state.mode === 'free', { timeoutMs: 5000 });
});
