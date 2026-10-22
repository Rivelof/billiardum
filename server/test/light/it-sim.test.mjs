// Интеграция: мост light + настоящий брокер Mosquitto (TLS, Dynamic Security) + симулятор
// контроллера tools/device-sim (в процессе) + outbox core на настоящей базе, реальное время.
// Метрика: от payments.confirmed_at до ack session.start (light_latency), p95 < 1 с.
//
// Переменные (без них тест пропускается), кроме LIGHT_TEST_DB_URL и LIGHT_TEST_APP_PASSWORD:
//   LIGHT_IT_MQTT_URL       mqtts://localhost:<порт> тестового брокера
//   LIGHT_IT_CA_FILE        CA брокера
//   LIGHT_IT_ADMIN_USER     администратор Dynamic Security
//   LIGHT_IT_ADMIN_PASSWORD
//   LIGHT_IT_SESSIONS       сколько оплат для p95 (по умолчанию 20)

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import mqtt from 'mqtt';
import { createDynsec, deviceRoleAcls, deviceRoleName, ensureServerClient, SERVER_CLIENT_ID } from '../../lib/dynsec.mjs';
import { createLogger } from '../../lib/log.mjs';
import { withContext } from '../../lib/store.mjs';
import { connectMqtt } from '../../mqtt.mjs';
import { createOutbox } from '../../outbox.mjs';
import { init, stop } from '../../sessions/index.mjs';
import { SimDevice } from '../../../tools/device-sim/lib/device.mjs';
import { createLogger as createSimLogger } from '../../../tools/device-sim/lib/log.mjs';
import { CLUB, createTestDb, DEV, GUEST, makePayment, RES, SKIP, sleep } from './harness.mjs';

const URL_ = process.env.LIGHT_IT_MQTT_URL;
const CA = process.env.LIGHT_IT_CA_FILE;
const ADMIN = process.env.LIGHT_IT_ADMIN_USER;
const ADMIN_PW = process.env.LIGHT_IT_ADMIN_PASSWORD;
const N = Number(process.env.LIGHT_IT_SESSIONS || 20);
const skip = SKIP || (!URL_ || !CA || !ADMIN || !ADMIN_PW ? 'нужны LIGHT_IT_MQTT_URL, LIGHT_IT_CA_FILE, LIGHT_IT_ADMIN_USER, LIGHT_IT_ADMIN_PASSWORD' : false);

function pct(list, p) {
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

describe('мост + брокер + симулятор (реальное время)', { skip }, () => {
  let t;
  let admin;
  let dynsec;
  let light;
  let outbox;
  let client;
  const sims = new Map();
  const lines = [];
  const simLines = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  const logs = (msg) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);
  const ca = CA ? readFileSync(CA) : null;
  const serverPassword = randomBytes(18).toString('base64url');

  async function until(fn, what, timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`не дождались: ${what}`);
      await sleep(20);
    }
  }

  function startSim(n, { deviceId = DEV(n), password, key }) {
    const sim = new SimDevice({
      device: { deviceId, clubId: CLUB, table: n, mqttUsername: deviceId, mqttPassword: password, deviceKey: key },
      mqttUrl: URL_,
      ca,
      caps: ['relay', 'led', 'buzzer', 'current'],
      log: createSimLogger({ level: 'info', write: (l) => simLines.push(l) }),
      reconnectMs: 500,
    });
    sim.start();
    sims.set(n, sim);
    return sim;
  }

  /** Оплата, как её подтверждает money: платёж и payment.confirmed в outbox одной транзакцией. */
  async function confirm(opts) {
    const pay = await makePayment(t, { ...opts, at: new Date() });
    await withContext(t.app, { clubId: CLUB, actorType: 'system' }, (db) => outbox.enqueue(db, 'payment.confirmed', pay));
    return pay;
  }
  const sessionOf = async (paymentId) =>
    until(async () => (await t.q('select session_id from bl.session_payments where payment_id = $1', [paymentId])).rows[0]?.session_id, 'сессия');
  const snap = (n) => sims.get(n).status().state;

  before(async () => {
    t = await createTestDb();
    // Короткие сигналы, чтобы полный цикл прошёл за минуту: ending за 20 с, льгота 5 с.
    await t.q(`update bl.clubs set settings = settings || '{"warn_ms":[20000,10000],"grace_ms":5000}'::jsonb where id = $1`, [CLUB]);
    admin = await mqtt.connectAsync(URL_, { clientId: `it-admin-${randomBytes(3).toString('hex')}`, username: ADMIN, password: ADMIN_PW, ca, protocolVersion: 4, clean: true, reconnectPeriod: 0 });
    dynsec = await createDynsec(admin);
    await ensureServerClient(dynsec, { username: 'bl-server', password: serverPassword });
    const creds = new Map();
    for (const n of [1, 2, 3, 4]) {
      const password = randomBytes(18).toString('base64url');
      await dynsec.ensureRole(deviceRoleName(DEV(n)), deviceRoleAcls(CLUB, DEV(n)), `it ${n}`);
      await dynsec.ensureClient({ username: DEV(n), password, clientid: DEV(n), rolename: deviceRoleName(DEV(n)), textname: `it ${n}` });
      creds.set(n, password);
    }
    outbox = createOutbox({ pollMs: 1_000 });
    client = connectMqtt({ url: URL_, caFile: CA, username: 'bl-server', password: serverPassword, clientId: SERVER_CLIENT_ID });
    const sse = { publish() {} };
    const paymentsApi = { async refund() {} };
    light = await init({
      config: { encKey: t.encKey, mqtt: { url: URL_, caFile: CA }, mqttPublicUrl: URL_ },
      log,
      pool: t.app,
      clock: { now: () => new Date() },
      outbox,
      sse,
      paymentsApi,
      mqttClient: client,
      dynsec,
    });
    await outbox.start({ pool: t.app, log });
    for (const n of [1, 2, 3]) startSim(n, { password: creds.get(n), key: t.keys.get(DEV(n)) });
    await until(() => light.bridge.stats().online === 3, 'три стола онлайн', 20_000);
    await until(() => [1, 2, 3].every((n) => snap(n)?.last_seq >= 1), 'актуальное состояние каждому столу');
  });

  after(async () => {
    for (const s of sims.values()) await s.stop().catch(() => {});
    await outbox?.stop().catch(() => {});
    await stop().catch(() => {});
    await new Promise((r) => (client ? client.end(false, {}, r) : r()));
    await admin?.endAsync().catch(() => {});
    await t?.drop();
  });

  it(`оплата → свет: ${N} оплат, light_latency p95 < 1 с; остановка плательщиком гасит свет`, async () => {
    const ms = [];
    for (let i = 0; i < N; i += 1) {
      const n = 1 + (i % 3);
      const before = logs('light_latency').length;
      const pay = await confirm({ resource: n, minutes: 30 });
      await until(() => logs('light_latency').length > before, 'light_latency');
      ms.push(logs('light_latency').at(-1).ms);
      const sid = await sessionOf(pay.payment_id);
      assert.equal(snap(n).mode, 'active');
      assert.equal(snap(n).session_id, sid);
      assert.ok(sims.get(n).status().lamp, 'реле включено');
      await withContext(t.app, { clubId: null, userId: GUEST(1), actorType: 'user' }, (db) => light.service.stop(db, { sessionId: sid, userId: GUEST(1) }));
      await until(() => snap(n).mode === 'free', 'свет погас');
    }
    const p50 = pct(ms, 50);
    const p95 = pct(ms, 95);
    process.stdout.write(`# light_latency: n=${ms.length} p50=${p50} мс p95=${p95} мс max=${Math.max(...ms)} мс\n`);
    if (process.env.LIGHT_IT_TRACE) {
      const pick = new Set(['session_started', 'cmd_sent', 'cmd_ack', 'light_latency']);
      process.stdout.write(`# TRACE ${lines.filter((l) => pick.has(JSON.parse(l).msg)).slice(-8).join('\n# TRACE ')}\n`);
      process.stdout.write(`# TRACE ${simLines.filter((l) => l.includes('sim_relay') || l.includes('sim_cmd')).slice(-4).join('\n# TRACE ')}\n`);
    }
    assert.ok(p95 < 1000, `p95 = ${p95} мс`);
  });

  it('продление: session.extend принят симулятором, остаток вырос; полный цикл: ending → grace → свет гаснет, сессия закрыта', async () => {
    const pay = await confirm({ resource: 1, minutes: 1 });
    const sid = await sessionOf(pay.payment_id);
    await until(() => snap(1).mode === 'active' || snap(1).mode === 'ending', 'свет');
    await confirm({ kind: 'extend', resource: 1, sessionId: sid, minutes: 1, amount: 2000 });
    await until(() => snap(1).remaining_ms > 70_000, 'остаток после продления');
    await withContext(t.app, { clubId: null, userId: GUEST(1), actorType: 'user' }, (db) => light.service.stop(db, { sessionId: sid, userId: GUEST(1) }));
    await until(() => snap(1).mode === 'free', 'остановлено');
    // Полный цикл без действий: 1 минута + льгота 5 с.
    const pay2 = await confirm({ resource: 2, minutes: 1 });
    const sid2 = await sessionOf(pay2.payment_id);
    await until(() => snap(2).mode === 'ending', 'ending (≤ 20 с)', 60_000);
    await until(() => snap(2).mode === 'grace', 'grace', 30_000);
    await until(() => snap(2).mode === 'free', 'свет погас', 15_000);
    await until(async () => (await t.q('select status from bl.sessions where id = $1', [sid2])).rows[0].status === 'closed', 'закрыта', 10_000);
  });

  it('T7: перезагрузка посреди игры — session.resume, остаток по paid_until', async () => {
    const pay = await confirm({ resource: 2, minutes: 30 });
    const sid = await sessionOf(pay.payment_id);
    await until(() => snap(2)?.mode === 'active', 'свет');
    sims.get(2).reboot({ downMs: 500 });
    await until(() => snap(2)?.boot >= 2 && snap(2)?.mode === 'active', 'свет после перезагрузки', 15_000);
    const s = (await t.q('select paid_until from bl.sessions where id = $1', [sid])).rows[0];
    const remaining = snap(2).remaining_ms;
    assert.ok(Math.abs(s.paid_until.getTime() - Date.now() - remaining) < 3_000, `остаток ${remaining}`);
    await until(async () => (await t.q("select 1 from bl.device_commands where session_id = $1 and type = 'session.resume' and status = 'acked'", [sid])).rowCount >= 1, 'ack session.resume');
    await withContext(t.app, { clubId: null, userId: GUEST(1), actorType: 'user' }, (db) => light.service.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T6: связь пропала, продление оплачено офлайн — команда ждёт; связь вернулась — свет продлён', async () => {
    const pay = await confirm({ resource: 3, minutes: 1 });
    const sid = await sessionOf(pay.payment_id);
    await until(() => ['active', 'ending'].includes(snap(3)?.mode), 'свет');
    sims.get(3).setNet(false);
    await until(() => light.bridge.deviceInfo(DEV(3))?.online === false, 'офлайн (Last Will)', 10_000);
    await confirm({ kind: 'extend', resource: 3, sessionId: sid, minutes: 2, amount: 3000 });
    await until(async () => (await t.q("select 1 from bl.device_commands where session_id = $1 and type = 'session.extend' and status = 'queued'", [sid])).rowCount === 1, 'в очереди');
    sims.get(3).setNet(true);
    await until(() => snap(3).remaining_ms > 120_000, 'продлено session.resume', 15_000);
    const q = await t.q("select status from bl.device_commands where session_id = $1 and type = 'session.extend'", [sid]);
    assert.equal(q.rows[0].status, 'superseded');
    await withContext(t.app, { clubId: null, userId: GUEST(1), actorType: 'user' }, (db) => light.service.stop(db, { sessionId: sid, userId: GUEST(1) }));
  });

  it('T8: повтор старой команды — replayed_seq, событие в журнале один раз; T9: неверная подпись — bad_sig, тревога', async () => {
    const r = sims.get(1).setFault('replay-old', true);
    assert.equal(r.replayed.result, 'replayed_seq');
    await until(async () => (await t.q("select 1 from bl.audit_log where action = 'device.event' and object_id = $1 and data->>'type' = 'replayed_seq'", [DEV(1)])).rowCount === 1, 'журнал replayed_seq');
    sims.get(1).setFault('replay-old', false);
    // Подделка: команда с чужой подписью от имени сервера (у bl-server есть право публикации).
    const forged = JSON.stringify({ v: 1, id: '0192f3c1-6d1a-4c3e-9b2a-1f0e5d4c3b2a', seq: 999999, type: 'session.start', issued_at: 1, body: { session_id: '0192f3c1-6d1a-4c3e-9b2a-1f0e5d4c3b2b', remaining_ms: 3600000, warn_ms: [300000, 60000], grace_ms: 120000, buzzer: true }, sig: `${'A'.repeat(43)}=` });
    client.publish(`bl/v1/${CLUB}/${DEV(1)}/cmd`, forged, { qos: 1 });
    await until(async () => (await t.q("select level from bl.alarms where type = 'bad_sig'")).rowCount === 1, 'тревога bad_sig');
    assert.equal(snap(1).mode, 'free', 'свет не включён');
    const al = await t.q("select level from bl.alarms where type in ('bad_sig', 'replayed_seq') order by type");
    assert.deepEqual(al.rows.map((x) => x.level), ['critical', 'important']);
  });

  it('T10: ток при выключенном реле — bypass_detected, тревога critical', async () => {
    sims.get(3).setFault('bypass', true);
    await until(async () => (await t.q("select level from bl.alarms where type = 'bypass_detected'")).rows[0]?.level === 'critical', 'тревога', 20_000);
    sims.get(3).setFault('bypass', false);
  });

  it('привязка: окно, claim, Dynamic Security — новый контроллер подключается со своими ключами и получает state.free', async () => {
    const NEW = 'd9000000-0000-4000-8000-0000000000aa';
    await withContext(t.app, { clubId: CLUB, userId: 'a1000000-0000-4000-8000-000000000001', actorType: 'user' }, (db) =>
      light.binding.bind(db, { clubId: CLUB, userId: 'a1000000-0000-4000-8000-000000000001', deviceId: NEW, resourceId: RES(4), claimCode: 'IT-CLAIM-01' }),
    );
    const creds = await withContext(t.app, { clubId: null, actorType: 'user' }, (db) => light.binding.claim(db, { deviceId: NEW, claimCode: 'IT-CLAIM-01' }));
    const sim = startSim(4, { deviceId: NEW, password: creds.mqtt_password, key: Buffer.from(creds.device_key, 'base64') });
    await until(() => light.bridge.deviceInfo(NEW)?.online === true, 'новый контроллер онлайн', 20_000);
    await until(() => sim.status().state?.last_seq >= 1, 'актуальное состояние');
    await until(async () => (await t.q("select 1 from bl.device_commands where device_id = $1 and status = 'acked'", [NEW])).rowCount === 1, 'ack');
    const dc = await t.q('select type, status from bl.device_commands where device_id = $1 order by created_at', [NEW]);
    assert.deepEqual(dc.rows.map((r) => [r.type, r.status]), [['state.free', 'acked']]);
  });
});
