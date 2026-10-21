// Мост MQTT без брокера и базы: подделки клиента и хранилища, таймеры node:test.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it, mock } from 'node:test';
import { createBridge, MAX_RETRIES, OFFLINE_AFTER_MS, REPORT_EVERY_MS, RETRY_MS, SUBSCRIPTIONS } from '../mqtt.mjs';
import { createLogger } from '../lib/log.mjs';
import { verifyCommand } from '../lib/protocol.mjs';
import { deviceKeyContext, encryptSecret } from '../lib/secrets.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OTHER_CLUB = 'c2000000-0000-4000-8000-000000000002';
const DEV = (n) => `d1000000-0000-4000-8000-00000000000${n}`;
const encKey = randomBytes(32);

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
    this.subscribed = [];
  }

  publish(topic, payload, opts, cb) {
    this.published.push({ topic, payload: String(payload), opts });
    cb?.();
  }

  subscribe(topics, opts, cb) {
    this.subscribed.push(...topics);
    cb?.(null, topics.map((topic) => ({ topic, qos: 1 })));
  }
}

function fakeStore(devices) {
  const audit = [];
  return {
    audit,
    devices,
    async deviceClub(id) {
      return devices.get(id)?.clubId ?? null;
    },
    async deviceTotal() {
      return devices.size;
    },
    async allocateCommand({ clubId, deviceId, cmdId, type, minSeq, build }) {
      const d = devices.get(deviceId);
      if (!d || d.clubId !== clubId) return { status: 'unknown_device' };
      if (!d.keyEnc) return { status: 'no_key' };
      const seq = Math.max(d.lastSeq, minSeq ?? 0) + 1;
      const payload = build({ seq, keyEnc: d.keyEnc });
      d.lastSeq = seq;
      audit.push({ club_id: clubId, action: 'device.cmd', object_id: deviceId, data: { cmd_id: cmdId, seq, type } });
      return { status: 'ok', seq, payload };
    },
    async touchDevice() {},
    async auditDevice({ clubId, deviceId, action, data }) {
      audit.push({ club_id: clubId, action, object_id: deviceId, data });
    },
  };
}

function device(n, { clubId = CLUB, key = true } = {}) {
  const keyBytes = randomBytes(32);
  return [DEV(n), { clubId, lastSeq: 0, keyBytes, keyEnc: key ? encryptSecret(keyBytes, encKey, deviceKeyContext(DEV(n))) : null }];
}

const topic = (dev, kind, club = CLUB) => `bl/v1/${club}/${dev}/${kind}`;
const state = (extra = {}) => Buffer.from(JSON.stringify({ v: 1, state_seq: 1, mode: 'free', fw: '1.0.0', caps: ['relay', 'led'], last_seq: 0, ...extra }));

let client;
let store;
let lines;
let bridge;

function setup(devs) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_792_598_400_000 });
  client = new FakeClient();
  store = fakeStore(new Map(devs));
  lines = [];
  const log = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  bridge = createBridge({ client, store, encKey, log, now: () => Date.now() });
  return bridge.start();
}

const logs = (msg) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg);
const cmds = (dev) => client.published.filter((p) => p.topic === topic(dev, 'cmd'));

async function goOnline(dev, club = CLUB, extra = {}) {
  await bridge.onMessage(topic(dev, 'status', club), Buffer.from('online'));
  await bridge.onMessage(topic(dev, 'state', club), state(extra));
}

describe('мост MQTT', () => {
  beforeEach(() => mock.timers.reset());

  it('подписывается на state, status, event, ack', async () => {
    await setup([device(1)]);
    assert.deepEqual(client.subscribed.sort(), [...SUBSCRIPTIONS].sort());
    assert.deepEqual(SUBSCRIPTIONS.sort(), ['bl/v1/+/+/ack', 'bl/v1/+/+/event', 'bl/v1/+/+/state', 'bl/v1/+/+/status']);
    await bridge.stop();
  });

  it('онлайн = status online + state; ping подписан ключом устройства, seq и журнал до публикации', async () => {
    const devs = [device(1), device(2)];
    await setup(devs);
    const first = logs('devices_online')[0];
    assert.deepEqual(first, { t: first.t, level: 'info', msg: 'devices_online', online: 0, total: 2 });

    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('online'));
    assert.equal(bridge.stats().online, 0, 'без state устройство ещё не онлайн');
    await bridge.onMessage(topic(DEV(1), 'state'), state());
    assert.equal(bridge.stats().online, 1);
    assert.deepEqual(logs('devices_online').at(-1), { ...logs('devices_online').at(-1), online: 1, total: 2 });

    const sent = cmds(DEV(1));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].opts.qos, 1);
    assert.equal(sent[0].opts.retain, false);
    const checked = verifyCommand(sent[0].payload, devs[0][1].keyBytes);
    assert.equal(checked.result, 'ok');
    assert.equal(checked.cmd.type, 'ping');
    assert.equal(checked.cmd.seq, 1);
    assert.deepEqual(checked.cmd.body, {});
    assert.equal(checked.cmd.issued_at, 1_792_598_400);
    assert.deepEqual(store.audit, [{ club_id: CLUB, action: 'device.cmd', object_id: DEV(1), data: { cmd_id: checked.cmd.id, seq: 1, type: 'ping' } }]);
    await bridge.stop();
  });

  it('state раньше status: онлайн, когда пришёл status', async () => {
    await setup([device(1)]);
    await bridge.onMessage(topic(DEV(1), 'state'), state());
    assert.equal(bridge.stats().online, 0);
    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('online'));
    assert.equal(bridge.stats().online, 1);
    assert.equal(cmds(DEV(1)).length, 1);
    await bridge.stop();
  });

  it('ack по cmd_id: лог cmd_ack строго в формате контракта, повторов нет', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    const cmd = JSON.parse(cmds(DEV(1))[0].payload);
    await bridge.onMessage(topic(DEV(1), 'ack'), Buffer.from(JSON.stringify({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true, error: null, state_seq: 2 })));
    const line = lines.find((l) => l.includes('"msg":"cmd_ack"'));
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), ['t', 'level', 'msg', 'device_id', 'type', 'seq', 'ok']);
    assert.deepEqual(parsed, { t: parsed.t, level: 'info', msg: 'cmd_ack', device_id: DEV(1), type: 'ping', seq: 1, ok: true });
    mock.timers.tick(RETRY_MS * 10);
    assert.equal(cmds(DEV(1)).length, 1, 'после ack команда не повторяется');
    assert.equal(bridge.stats().pending, 0);
    await bridge.stop();
  });

  it('без ack: повтор через 3 с с тем же id и seq до 5 раз, затем тревога; журнал не растёт', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    const first = cmds(DEV(1))[0].payload;
    for (let i = 1; i <= MAX_RETRIES; i += 1) {
      mock.timers.tick(RETRY_MS - 1);
      assert.equal(cmds(DEV(1)).length, i, `до ${i}-го повтора рано`);
      mock.timers.tick(1);
      assert.equal(cmds(DEV(1)).length, i + 1);
    }
    assert.ok(cmds(DEV(1)).every((c) => c.payload === first), 'повтор — тот же байт в байт');
    assert.equal(logs('cmd_no_ack').length, 0);
    mock.timers.tick(RETRY_MS);
    assert.equal(cmds(DEV(1)).length, 1 + MAX_RETRIES);
    const alarm = logs('cmd_no_ack');
    assert.equal(alarm.length, 1);
    assert.equal(alarm[0].level, 'error');
    assert.equal(alarm[0].attempts, 1 + MAX_RETRIES);
    assert.equal(store.audit.length, 1);
    // Поздний ack после тревоги ничего не ломает.
    const cmd = JSON.parse(first);
    await bridge.onMessage(topic(DEV(1), 'ack'), Buffer.from(JSON.stringify({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true })));
    assert.equal(logs('cmd_ack').length, 0);
    await bridge.stop();
  });

  it('ack с ошибкой — cmd_ack ok:false и код ошибки; ack чужого устройства не засчитывается', async () => {
    await setup([device(1), device(2)]);
    await goOnline(DEV(1));
    await goOnline(DEV(2));
    const cmd = JSON.parse(cmds(DEV(1))[0].payload);
    await bridge.onMessage(topic(DEV(2), 'ack'), Buffer.from(JSON.stringify({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true })));
    assert.equal(logs('cmd_ack').length, 0);
    await bridge.onMessage(topic(DEV(1), 'ack'), Buffer.from(JSON.stringify({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: false, error: 'replayed_seq' })));
    assert.deepEqual(logs('cmd_ack').map(({ t: _t, ...rest }) => rest), [
      { level: 'warn', msg: 'cmd_ack', device_id: DEV(1), type: 'ping', seq: 1, ok: false, error: 'replayed_seq' },
    ]);
    await bridge.stop();
  });

  it('офлайн по status offline и по 150 с без state; снова онлайн — новый ping с новым seq', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('offline'));
    assert.equal(bridge.stats().online, 0);
    assert.equal(logs('device_offline')[0].reason, 'status');

    await goOnline(DEV(1));
    assert.equal(bridge.stats().online, 1);
    assert.equal(JSON.parse(cmds(DEV(1)).at(-1).payload).seq, 2);

    mock.timers.tick(OFFLINE_AFTER_MS - 5_000);
    await Promise.resolve();
    assert.equal(bridge.stats().online, 1, '145 с без state — ещё онлайн');
    mock.timers.tick(10_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.stats().online, 0, 'больше 150 с без state — офлайн');
    assert.equal(logs('device_offline').at(-1).reason, 'no_state');
    await bridge.stop();
  });

  it('devices_online при каждом изменении и раз в 60 с', async () => {
    await setup([device(1), device(2)]);
    await goOnline(DEV(1));
    await goOnline(DEV(2));
    assert.deepEqual(logs('devices_online').map((l) => [l.online, l.total]), [[0, 2], [1, 2], [2, 2]]);
    mock.timers.tick(REPORT_EVERY_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(logs('devices_online').at(-1), { ...logs('devices_online').at(-1), online: 2, total: 2 });
    assert.equal(logs('devices_online').length, 4);
    await bridge.stop();
  });

  it('клуб — из базы, а не из топика: расхождение — тревога и запись в журнал, устройство не онлайн', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1), OTHER_CLUB);
    assert.equal(bridge.stats().online, 0);
    assert.equal(client.published.length, 0);
    const alarm = logs('device_club_mismatch');
    assert.equal(alarm.length, 1, 'тревога один раз на топик');
    assert.deepEqual(store.audit, [{ club_id: CLUB, action: 'device.topic_mismatch', object_id: DEV(1), data: { topic_club_id: OTHER_CLUB } }]);
    await bridge.stop();
  });

  it('неизвестное устройство игнорируется', async () => {
    await setup([device(1)]);
    await goOnline(DEV(9));
    assert.equal(bridge.stats().online, 0);
    assert.equal(logs('device_unknown').length, 1);
    assert.equal(client.published.length, 0);
    await bridge.stop();
  });

  it('seq не отстаёт от last_seq устройства из state', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1), CLUB, { last_seq: 41 });
    assert.equal(JSON.parse(cmds(DEV(1))[0].payload).seq, 42);
    await bridge.stop();
  });

  it('устройство без ключа: команда не уходит и журнал не пишется', async () => {
    await setup([device(1, { key: false })]);
    await goOnline(DEV(1));
    assert.equal(bridge.stats().online, 1);
    assert.equal(client.published.length, 0);
    assert.equal(store.audit.length, 0);
    assert.equal(logs('cmd_skipped')[0].reason, 'no_key');
    await bridge.stop();
  });

  it('событие пишется в лог только кодами и числами', async () => {
    await setup([device(1)]);
    await bridge.onMessage(
      topic(DEV(1), 'event'),
      Buffer.from(JSON.stringify({ v: 1, boot: 3, n: 1, type: 'boot', at_uptime_ms: 5, data: { fw: '1.0.0', note: '+79991234567' } })),
    );
    const ev = logs('device_event')[0];
    assert.deepEqual({ ...ev, t: 0 }, { t: 0, level: 'info', msg: 'device_event', device_id: DEV(1), type: 'boot', boot: 3, n: 1 });
    assert.ok(!lines.join('\n').includes('79991234567'));
    await bridge.stop();
  });

  it('мусор в сообщениях не роняет мост', async () => {
    await setup([device(1)]);
    for (const kind of ['state', 'status', 'event', 'ack']) {
      await bridge.onMessage(topic(DEV(1), kind), Buffer.from('{oops'));
    }
    await bridge.onMessage(topic(DEV(1), 'state'), Buffer.alloc(20_000, 0x20));
    await bridge.onMessage('bl/v1/garbage', Buffer.from('x'));
    assert.equal(bridge.stats().online, 0);
    await goOnline(DEV(1));
    assert.equal(bridge.stats().online, 1);
    await bridge.stop();
  });
});
