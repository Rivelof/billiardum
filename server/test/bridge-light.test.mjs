// Мост MQTT, поведение M1 без базы и брокера: очередь bl.device_commands (wake, superseded),
// prepare в транзакции seq, актуальное состояние с причиной, события один раз, хуки тревог
// (офлайн > 120 с, расхождение state > 10 с, нет ack), сведения об устройстве.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it, mock } from 'node:test';
import { createBridge, MAX_RETRIES, MISMATCH_ALARM_MS, OFFLINE_ALARM_MS, RETRY_MS } from '../mqtt.mjs';
import { createLogger } from '../lib/log.mjs';
import { verifyCommand } from '../lib/protocol.mjs';
import { deviceKeyContext, encryptSecret } from '../lib/secrets.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const DEV = 'd1000000-0000-4000-8000-000000000001';
const SID = '5e550000-0000-4000-8000-000000000001';
const encKey = randomBytes(32);
const keyBytes = randomBytes(32);
const keyEnc = encryptSecret(keyBytes, encKey, deviceKeyContext(DEV));

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
  }

  publish(topic, payload, _opts, cb) {
    this.published.push({ topic, payload: String(payload) });
    cb?.();
  }

  subscribe(topics, _opts, cb) {
    cb?.(null, topics.map((topic) => ({ topic, qos: 1 })));
  }
}

function fakeStore() {
  const s = {
    lastSeq: 0,
    rows: new Map(), // id → { id, type, body, status, session_id, payment_id, cause }
    events: new Set(),
    audit: [],
    marks: [],
    async deviceClub(id) {
      return id === DEV ? CLUB : null;
    },
    async deviceTotal() {
      return 1;
    },
    async touchDevice() {},
    async auditDevice() {},
    async allocateCommand({ cmdId, rowId, type, body, sessionId, deviceState, prepare, build }) {
      if (rowId && s.rows.get(rowId)?.status !== 'queued') return { status: 'stale', seqGap: null };
      const final = prepare ? await prepare(null, { type, body, sessionId, deviceState }) : { type, body };
      if (!final) {
        if (rowId) s.rows.get(rowId).status = 'cancelled';
        return { status: 'cancelled', seqGap: null };
      }
      s.lastSeq += 1;
      const payload = build({ seq: s.lastSeq, keyEnc, type: final.type, body: final.body });
      s.audit.push({ action: 'device.cmd', cmd_id: cmdId, seq: s.lastSeq, type: final.type });
      if (rowId) Object.assign(s.rows.get(rowId), { status: 'sent', seq: s.lastSeq });
      return { status: 'ok', seq: s.lastSeq, payload, type: final.type, body: final.body, seqSync: null, seqGap: null };
    },
    async loadQueued() {
      return [...s.rows.values()].filter((r) => r.status === 'queued');
    },
    async supersedeQueued() {
      let n = 0;
      for (const r of s.rows.values()) {
        if (r.status === 'queued') {
          r.status = 'superseded';
          n += 1;
        }
      }
      return n;
    },
    async markCommand({ cmdId, status, error }) {
      s.marks.push({ cmdId, status, error });
      if (s.rows.has(cmdId)) s.rows.get(cmdId).status = status;
    },
    async recordEvent({ ev }) {
      const key = `${ev.boot_id}:${ev.n}`;
      if (s.events.has(key)) return false;
      s.events.add(key);
      s.audit.push({ action: 'device.event', type: ev.type });
      return true;
    },
    queue(type, body = {}, extra = {}) {
      const id = randomUUID();
      s.rows.set(id, { id, type, body, status: 'queued', session_id: null, payment_id: null, cause: 'staff', ...extra });
      return id;
    },
  };
  return s;
}

const topic = (kind) => `bl/v1/${CLUB}/${DEV}/${kind}`;
const json = (o) => Buffer.from(JSON.stringify(o));

let client;
let store;
let bridge;
let lines;
let calls;
let expected;
let actual;

function setup(hooksExtra = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_792_598_400_000 });
  client = new FakeClient();
  store = fakeStore();
  lines = [];
  calls = { prepare: [], actual: [], ack: [], event: [], mismatch: [], offline: [], noack: [] };
  expected = { modes: ['free', 'pending', 'reserved'], sessionId: null, lightAllowed: false };
  actual = { type: 'state.free', body: {} };
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  bridge = createBridge({
    client,
    store,
    encKey,
    log,
    now: () => Date.now(),
    actualState: async (args) => {
      calls.actual.push(args);
      return actual;
    },
    hooks: {
      prepare: async (_db, args) => {
        calls.prepare.push(args);
        if (args.type === 'session.extend' && args.deviceState?.session_id !== SID) return { type: 'session.resume', body: { session_id: SID, remaining_ms: 1000 } };
        return { type: args.type, body: args.body };
      },
      onAck: async (args) => {
        calls.ack.push(args);
        return { resync: args.ack.error === 'wrong_session' };
      },
      onEvent: async (args) => calls.event.push(args),
      expected: async () => expected,
      onMismatch: async (args) => calls.mismatch.push(args),
      onOfflineAlarm: async (args) => {
        calls.offline.push(args);
        return true;
      },
      onNoAck: async (args) => calls.noack.push(args),
      ...hooksExtra,
    },
  });
  return bridge.start();
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  await bridge.idle();
};
const cmds = () => client.published.filter((p) => p.topic === topic('cmd')).map((p) => JSON.parse(p.payload));
const state = (extra = {}) => json({ v: 1, state_seq: 1, mode: 'free', session_id: null, relay: false, fw: '1.0.0', caps: ['relay'], last_seq: store.lastSeq, rssi: -60, ...extra });
async function online(extra) {
  await bridge.onMessage(topic('status'), Buffer.from('online'));
  await bridge.onMessage(topic('state'), state(extra));
  await flush();
}
async function ack(cmd, extra = {}) {
  await bridge.onMessage(topic('ack'), json({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true, error: null, state_seq: 2, ...extra }));
  await flush();
}

describe('мост M1: очередь команд в базе', () => {
  beforeEach(() => mock.timers.reset());

  it('выход онлайн: очередь superseded, актуальное состояние (reason online, deviceState) первым', async () => {
    await setup();
    const old = store.queue('session.extend', { session_id: SID });
    await online({ mode: 'active', session_id: SID });
    assert.equal(store.rows.get(old).status, 'superseded');
    assert.equal(calls.actual[0].reason, 'online');
    assert.equal(calls.actual[0].deviceState.session_id, SID);
    assert.deepEqual(cmds().map((c) => c.type), ['state.free']);
    assert.equal(verifyCommand(client.published[0].payload, keyBytes).result, 'ok');
    await bridge.stop();
  });

  it('wake: строки queued уходят по одной, id команды = id строки; prepare видит state устройства и меняет тип', async () => {
    await setup();
    await online();
    await ack(cmds()[0]);
    const a = store.queue('session.extend', { session_id: SID });
    const b = store.queue('identify', { duration_ms: 1000 });
    assert.equal(await bridge.wake(DEV), true);
    await flush();
    assert.equal(cmds().length, 2, 'вторая ждёт ack первой');
    assert.equal(cmds()[1].id, a);
    assert.equal(cmds()[1].type, 'session.resume', 'контроллер не ведёт сессию — extend заменён');
    assert.equal(calls.prepare.at(-1).deviceState.mode, 'free');
    await ack(cmds()[1]);
    assert.equal(cmds()[2].id, b);
    assert.deepEqual(store.marks.map((m) => m.status), ['acked', 'acked']);
    await bridge.wake(DEV);
    await flush();
    assert.equal(cmds().length, 3, 'повторный wake не дублирует');
    await bridge.stop();
  });

  it('офлайн: wake не отправляет, строка ждёт; после возвращения — superseded и актуальное состояние', async () => {
    await setup();
    await online();
    await ack(cmds()[0]);
    await bridge.onMessage(topic('status'), Buffer.from('offline'));
    const id = store.queue('session.extend', { session_id: SID });
    assert.equal(await bridge.wake(DEV), false);
    assert.equal(store.rows.get(id).status, 'queued');
    await online({ mode: 'active', session_id: SID });
    assert.equal(store.rows.get(id).status, 'superseded');
    assert.equal(cmds().at(-1).type, 'state.free');
    assert.equal(calls.actual.at(-1).reason, 'online');
    await bridge.stop();
  });

  it('ack wrong_session — хук просит актуальное состояние; нет ack — 1 + 5 повторов, no_ack и onNoAck', async () => {
    await setup();
    await online();
    await bridge.onMessage(topic('ack'), json({ v: 1, cmd_id: cmds()[0].id, seq: cmds()[0].seq, ok: false, error: 'wrong_session' }));
    await flush();
    assert.equal(calls.ack[0].ok, false);
    assert.equal(cmds().length, 2, 'актуальное состояние ещё раз');
    assert.equal(calls.actual.at(-1).reason, 'ack');
    for (let i = 0; i <= MAX_RETRIES; i += 1) {
      mock.timers.tick(RETRY_MS);
      await flush();
    }
    assert.equal(cmds().length, 2 + MAX_RETRIES);
    assert.equal(calls.noack.length, 1);
    assert.equal(store.marks.at(-1).status, 'no_ack');
    await bridge.stop();
  });
});

describe('мост M1: события, тревоги, сведения', () => {
  beforeEach(() => mock.timers.reset());

  const ev = (type, n, extra = {}) => json({ v: 1, boot: 3, boot_id: '9f3a61c2', n, type, at_uptime_ms: 10, data: { current_ma: 380 }, ...extra });

  it('событие один раз по (boot_id, n): дубль не доходит до хука; без boot_id — не пишется', async () => {
    await setup();
    await bridge.onMessage(topic('event'), ev('bypass_detected', 1));
    await bridge.onMessage(topic('event'), ev('bypass_detected', 1));
    await bridge.onMessage(topic('event'), ev('lamp_fault', 2));
    await bridge.onMessage(topic('event'), ev('lamp_fault', 3, { boot_id: 'bad' }));
    await flush();
    assert.deepEqual(calls.event.map((e) => [e.ev.type, e.ev.n, e.ev.data.current_ma]), [
      ['bypass_detected', 1, 380],
      ['lamp_fault', 2, 380],
    ]);
    assert.deepEqual(store.audit.filter((a) => a.action === 'device.event').map((a) => a.type), ['bypass_detected', 'lamp_fault']);
    await bridge.stop();
  });

  it('boot посреди работы: недоставленное брошено, актуальное состояние с причиной boot; дубль boot — без второй синхронизации', async () => {
    await setup();
    await online();
    await ack(cmds()[0]);
    mock.timers.tick(20_000);
    await bridge.onMessage(topic('event'), ev('boot', 1, { data: {} }));
    await flush();
    assert.equal(calls.actual.at(-1).reason, 'boot');
    const n = cmds().length;
    await bridge.onMessage(topic('event'), ev('boot', 1, { data: {} }));
    await flush();
    assert.equal(cmds().length, n);
    await bridge.stop();
  });

  it(`офлайн во время сессии дольше ${OFFLINE_ALARM_MS / 1000} с — хук тревоги один раз за эпизод`, async () => {
    await setup();
    await online();
    await ack(cmds()[0]);
    await bridge.onMessage(topic('status'), Buffer.from('offline'));
    mock.timers.tick(OFFLINE_ALARM_MS - 5_000);
    await flush();
    assert.equal(calls.offline.length, 0);
    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.offline.length, 1);
    assert.ok(calls.offline[0].offlineMs >= OFFLINE_ALARM_MS);
    mock.timers.tick(60_000);
    await flush();
    assert.equal(calls.offline.length, 1);
    await bridge.stop();
  });

  it(`state расходится с базой дольше ${MISMATCH_ALARM_MS / 1000} с — хук и актуальное состояние; совпало — сброс`, async () => {
    await setup();
    await online();
    await ack(cmds()[0]);
    await bridge.onMessage(topic('state'), state({ mode: 'active', session_id: SID, relay: true }));
    await flush();
    mock.timers.tick(5_000);
    await flush();
    assert.equal(calls.mismatch.length, 0);
    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.mismatch.length, 1);
    assert.equal(calls.mismatch[0].state.relay, true);
    assert.equal(calls.actual.at(-1).reason, 'mismatch');
    await ack(cmds().at(-1));
    await bridge.onMessage(topic('state'), state());
    await flush();
    mock.timers.tick(30_000);
    await flush();
    assert.equal(calls.mismatch.length, 1, 'совпало — новых тревог нет');
    await bridge.stop();
  });

  it('deviceInfo: онлайн, rssi, прошивка, возможности, режим; state без доверия к полям', async () => {
    await setup();
    await online({ mode: 'hacked', session_id: 'not-a-uuid', rssi: 5 });
    const info = bridge.deviceInfo(DEV);
    assert.equal(info.online, true);
    assert.equal(info.mode, null);
    assert.equal(info.session_id, null);
    assert.equal(info.rssi, null);
    assert.equal(info.fw, '1.0.0');
    assert.deepEqual(info.caps, ['relay']);
    assert.equal(bridge.deviceInfo('nope'), null);
    await bridge.stop();
  });
});
