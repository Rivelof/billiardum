// Мост MQTT без брокера и базы: подделки клиента и хранилища, таймеры node:test.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it, mock } from 'node:test';
import {
  BOOT_SYNC_WINDOW_MS,
  createBridge,
  MAX_INCOMING_BYTES,
  MAX_RETRIES,
  OFFLINE_AFTER_MS,
  REPORT_EVERY_MS,
  RETRY_MS,
  SEQ_GAP_LIMIT,
  SUBSCRIPTIONS,
} from '../mqtt.mjs';
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

/** Повторяет логику store.allocateCommand без базы. */
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
    async allocateCommand({ clubId, deviceId, cmdId, type, stateLastSeq, seqGapLimit, build }) {
      const d = devices.get(deviceId);
      if (!d || d.clubId !== clubId) return { status: 'unknown_device', seqGap: null };
      if (!d.keyEnc) return { status: 'no_key', seqGap: null };
      let base = d.lastSeq;
      let seqSync = null;
      let seqGap = null;
      if (Number.isSafeInteger(stateLastSeq) && stateLastSeq > d.lastSeq) {
        if (stateLastSeq - d.lastSeq > seqGapLimit) seqGap = { db_seq: d.lastSeq, state_seq: stateLastSeq };
        else {
          seqSync = { from: d.lastSeq, to: stateLastSeq };
          base = stateLastSeq;
        }
      }
      const seq = base + 1;
      const payload = build({ seq, keyEnc: d.keyEnc });
      if (seqSync) audit.push({ club_id: clubId, action: 'device.seq_sync', object_id: deviceId, data: seqSync });
      d.lastSeq = seq;
      audit.push({ club_id: clubId, action: 'device.cmd', object_id: deviceId, data: { cmd_id: cmdId, seq, type } });
      return { status: 'ok', seq, payload, seqSync, seqGap };
    },
    async touchDevice() {},
    async auditDevice({ clubId, deviceId, action, data }) {
      audit.push({ club_id: clubId, action, object_id: deviceId, data });
    },
  };
}

function device(n, { clubId = CLUB, key = true, lastSeq = 0 } = {}) {
  const keyBytes = randomBytes(32);
  return [DEV(n), { clubId, lastSeq, keyBytes, keyEnc: key ? encryptSecret(keyBytes, encKey, deviceKeyContext(DEV(n))) : null }];
}

const topic = (dev, kind, club = CLUB) => `bl/v1/${club}/${dev}/${kind}`;
const state = (extra = {}) => Buffer.from(JSON.stringify({ v: 1, state_seq: 1, mode: 'free', fw: '1.0.0', caps: ['relay', 'led'], last_seq: 0, ...extra }));
const json = (obj) => Buffer.from(JSON.stringify(obj));

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
const lastCmd = (dev) => JSON.parse(cmds(dev).at(-1).payload);
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function goOnline(dev, club = CLUB, extra = {}) {
  await bridge.onMessage(topic(dev, 'status', club), Buffer.from('online'));
  await bridge.onMessage(topic(dev, 'state', club), state(extra));
}

async function ackLast(dev, extra = {}) {
  const cmd = lastCmd(dev);
  await bridge.onMessage(topic(dev, 'ack'), json({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true, error: null, state_seq: 2, ...extra }));
  await flush();
  return cmd;
}

describe('мост MQTT: онлайн, ping, ack', () => {
  beforeEach(() => mock.timers.reset());

  it('подписывается на state, status, event, ack', async () => {
    await setup([device(1)]);
    assert.deepEqual(client.subscribed.sort(), ['bl/v1/+/+/ack', 'bl/v1/+/+/event', 'bl/v1/+/+/state', 'bl/v1/+/+/status']);
    assert.deepEqual([...SUBSCRIPTIONS].sort(), client.subscribed);
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
    assert.deepEqual(sent[0].opts, { qos: 1, retain: false });
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
    await ackLast(DEV(1));
    const line = lines.find((l) => l.includes('"msg":"cmd_ack"'));
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), ['t', 'level', 'msg', 'device_id', 'type', 'seq', 'ok']);
    assert.deepEqual(parsed, { t: parsed.t, level: 'info', msg: 'cmd_ack', device_id: DEV(1), type: 'ping', seq: 1, ok: true });
    mock.timers.tick(RETRY_MS * 10);
    assert.equal(cmds(DEV(1)).length, 1, 'после ack команда не повторяется');
    assert.equal(bridge.stats().pending, 0);
    await bridge.stop();
  });

  it('ack с ошибкой — cmd_ack ok:false и код; ack чужого устройства не засчитывается', async () => {
    await setup([device(1), device(2)]);
    await goOnline(DEV(1));
    await goOnline(DEV(2));
    const cmd = lastCmd(DEV(1));
    await bridge.onMessage(topic(DEV(2), 'ack'), json({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: true }));
    assert.equal(logs('cmd_ack').length, 0);
    await bridge.onMessage(topic(DEV(1), 'ack'), json({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: false, error: 'bad_body' }));
    assert.deepEqual(logs('cmd_ack').map(({ t: _t, ...rest }) => rest), [
      { level: 'warn', msg: 'cmd_ack', device_id: DEV(1), type: 'ping', seq: 1, ok: false, error: 'bad_body' },
    ]);
    await bridge.stop();
  });

  it('ack с cmd_id: null (команда не разобрана) — ответ на неподтверждённую команду, без повторов', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await bridge.onMessage(topic(DEV(1), 'ack'), json({ v: 1, cmd_id: null, seq: null, ok: false, error: 'bad_format', state_seq: 3 }));
    assert.deepEqual(logs('cmd_ack').map(({ t: _t, ...rest }) => rest), [
      { level: 'warn', msg: 'cmd_ack', device_id: DEV(1), type: 'ping', seq: 1, ok: false, error: 'bad_format' },
    ]);
    mock.timers.tick(RETRY_MS * 10);
    assert.equal(cmds(DEV(1)).length, 1);
    await bridge.onMessage(topic(DEV(1), 'ack'), json({ v: 1, cmd_id: null, seq: null, ok: false, error: 'bad_format' }));
    assert.equal(logs('ack_unmatched').at(-1).error, 'bad_format', 'без неподтверждённой команды — только лог');
    await bridge.stop();
  });

  it('devices_online при каждом изменении и раз в 60 с', async () => {
    await setup([device(1), device(2)]);
    await goOnline(DEV(1));
    await goOnline(DEV(2));
    assert.deepEqual(logs('devices_online').map((l) => [l.online, l.total]), [[0, 2], [1, 2], [2, 2]]);
    mock.timers.tick(REPORT_EVERY_MS);
    await flush();
    assert.equal(logs('devices_online').length, 4);
    assert.deepEqual(logs('devices_online').at(-1), { ...logs('devices_online').at(-1), online: 2, total: 2 });
    await bridge.stop();
  });
});

describe('мост MQTT: очередь и повторы (protocol §6)', () => {
  beforeEach(() => mock.timers.reset());

  it('одна неподтверждённая команда на устройство: следующая — только после ack', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await ackLast(DEV(1));
    assert.equal(await bridge.command(DEV(1), 'identify', { duration_ms: 30000 }), 'queued');
    assert.equal(await bridge.command(DEV(1), 'ping'), 'queued');
    assert.deepEqual(cmds(DEV(1)).map((c) => JSON.parse(c.payload).type), ['ping', 'identify']);
    assert.equal(bridge.stats().pending, 2);
    await ackLast(DEV(1));
    assert.deepEqual(cmds(DEV(1)).map((c) => JSON.parse(c.payload).seq), [1, 2, 3]);
    await ackLast(DEV(1));
    assert.equal(bridge.stats().pending, 0);
    await bridge.stop();
  });

  it('без ack: повтор через 3 с с тем же id и seq до 5 раз, затем тревога и отказ; журнал не растёт; очередь идёт дальше', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    // Устройство отвечает state раз в 60 с — без этого через 150 с оно стало бы офлайн.
    await bridge.command(DEV(1), 'identify', { duration_ms: 1000 });
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
    await flush();
    const alarm = logs('cmd_no_ack');
    assert.equal(alarm.length, 1);
    assert.equal(alarm[0].level, 'error');
    assert.equal(alarm[0].attempts, 1 + MAX_RETRIES);
    // После отказа уходит следующая команда из очереди.
    assert.equal(cmds(DEV(1)).length, 2 + MAX_RETRIES);
    assert.equal(lastCmd(DEV(1)).type, 'identify');
    assert.deepEqual(store.audit.map((a) => a.data.type), ['ping', 'identify']);
    // Поздний ack на брошенную команду ничего не ломает.
    await bridge.onMessage(topic(DEV(1), 'ack'), Buffer.from(first.replace(/.*"id":"([^"]+)".*/, '{"v":1,"cmd_id":"$1","seq":1,"ok":true}')));
    assert.equal(logs('cmd_ack').length, 0);
    await bridge.stop();
  });

  it('офлайн: повторов и cmd_no_ack нет, команда брошена; после возвращения — актуальное состояние с новым seq', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    const old = cmds(DEV(1))[0].payload;
    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('offline'));
    assert.equal(bridge.stats().online, 0);
    assert.equal(logs('device_offline')[0].reason, 'status');
    assert.deepEqual(logs('cmd_abandoned').map((l) => [l.type, l.reason]), [['ping', 'offline']]);
    mock.timers.tick(RETRY_MS * 20);
    assert.equal(cmds(DEV(1)).length, 1, 'офлайн — без повторов');
    assert.equal(logs('cmd_no_ack').length, 0, 'офлайн — без тревоги «не отвечает»');
    assert.equal(await bridge.command(DEV(1), 'identify', { duration_ms: 1 }), 'offline', 'офлайн-устройству команды не ставятся');

    await goOnline(DEV(1));
    assert.equal(cmds(DEV(1)).length, 2);
    assert.notEqual(cmds(DEV(1))[1].payload, old, 'старая команда не пересылается');
    assert.equal(lastCmd(DEV(1)).seq, 2);
    assert.equal(lastCmd(DEV(1)).type, 'ping');
    await bridge.stop();
  });

  it('офлайн по 150 с без state', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await ackLast(DEV(1));
    mock.timers.tick(OFFLINE_AFTER_MS - 5_000);
    await flush();
    assert.equal(bridge.stats().online, 1, '145 с без state — ещё онлайн');
    mock.timers.tick(10_000);
    await flush();
    assert.equal(bridge.stats().online, 0, 'больше 150 с без state — офлайн');
    assert.equal(logs('device_offline').at(-1).reason, 'no_state');
    await bridge.stop();
  });

  it('config.set, не подтверждённый до офлайна, досылается после актуального состояния новой командой: новый id, seq и журнал', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await ackLast(DEV(1));
    await bridge.command(DEV(1), 'config.set', { led_brightness: 10 });
    const cfg = lastCmd(DEV(1));
    assert.equal(cfg.seq, 2);
    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('offline'));
    assert.equal(logs('cmd_abandoned').at(-1).seq, 2);
    await goOnline(DEV(1), CLUB, { last_seq: 2 });
    assert.equal(lastCmd(DEV(1)).type, 'ping', 'сначала актуальное состояние');
    await ackLast(DEV(1));
    const again = lastCmd(DEV(1));
    assert.equal(again.type, 'config.set');
    assert.deepEqual(again.body, { led_brightness: 10 });
    assert.notEqual(again.id, cfg.id);
    assert.equal(again.seq, 4, 'seq новый: старый (2) контроллер отверг бы как replayed_seq');
    assert.deepEqual(store.audit.filter((a) => a.data.type === 'config.set').map((a) => a.data.seq), [2, 4], 'каждая отправка — в журнале');
    assert.equal(logs('cmd_resend').at(-1).resend_of, cfg.id);
    await bridge.stop();
  });

  it('нет связи с брокером: публикаций нет, неподтверждённая команда брошена, исходящие mqtt удалены; после connect — актуальное состояние', async () => {
    await setup([device(1), device(2)]);
    await goOnline(DEV(1));
    await goOnline(DEV(2));
    await ackLast(DEV(2));
    const pending = lastCmd(DEV(1)); // ping без ack
    client.outgoing = { 7: { cb() {} }, 9: { cb() {} } };
    const removed = [];
    client.removeOutgoingMessage = (id) => {
      removed.push(id);
      delete client.outgoing[id];
    };
    client.connected = false;
    client.emit('close');
    await flush();
    await bridge.idle();
    assert.deepEqual(removed, [7, 9]);
    assert.equal(logs('cmd_abandoned').at(-1).seq, pending.seq);
    assert.equal(bridge.stats().pending, 0);
    const before = client.published.length;
    await bridge.command(DEV(2), 'ping', {});
    mock.timers.tick(RETRY_MS * (MAX_RETRIES + 2));
    await flush();
    assert.equal(client.published.length, before, 'без связи ничего не публикуется');
    assert.equal(logs('cmd_no_ack').length, 0, 'и тревоги «нет ответа» нет');
    client.connected = true;
    client.emit('connect');
    await flush();
    await bridge.idle();
    assert.equal(lastCmd(DEV(1)).type, 'ping', 'актуальное состояние первому столу');
    assert.equal(lastCmd(DEV(2)).type, 'ping', 'и второму');
    assert.equal(logs('mqtt_connected').at(-1).reconnect, true);
    await bridge.stop();
  });

  it('база недоступна при старте 20 с (R4): после подъёма в пределах 30 с все устройства онлайн, актуальное состояние, retained заново', async () => {
    await setup([device(1), device(2)]);
    let down = true;
    const fail = () => {
      if (down) throw Object.assign(new Error('the database system is not accepting connections'), { code: '57P03' });
    };
    for (const name of ['deviceClub', 'deviceTotal', 'allocateCommand', 'touchDevice']) {
      const real = store[name].bind(store);
      store[name] = async (...args) => {
        fail();
        return real(...args);
      };
    }
    // Брокер: retained state/status отдаются заново при повторной подписке.
    const retained = new Map();
    const subscribe = client.subscribe.bind(client);
    client.subscribe = (topics, opts, cb) => {
      subscribe(topics, opts, cb);
      for (const [tp, payload] of retained) if (topics.some((f) => tp.endsWith(f.slice(f.lastIndexOf('/'))))) setImmediate(() => client.emit('message', tp, payload));
    };
    const deliver = async (dev, kind, payload) => {
      if (kind === 'status' || kind === 'state') retained.set(topic(dev, kind), payload);
      await bridge.onMessage(topic(dev, kind), payload);
    };
    // Контроллеры онлайн, сообщения пришли один раз (status retained и больше не повторится).
    for (const dev of [DEV(1), DEV(2)]) {
      await deliver(dev, 'status', Buffer.from('online'));
      await deliver(dev, 'state', state());
    }
    assert.equal(bridge.stats().online, 0);
    assert.equal(logs('device_message_failed').at(-1).retry, true);
    const step = async () => {
      mock.timers.tick(5_000);
      await flush();
      await bridge.idle();
      await flush();
      await bridge.idle();
    };
    for (let i = 0; i < 4; i += 1) await step(); // 20 с базы нет
    assert.equal(bridge.stats().online, 0);
    assert.equal(cmds(DEV(1)).length, 0);
    down = false;
    let waited = 0;
    while (bridge.stats().online < 2 && waited < 30_000) {
      await step();
      waited += 5_000;
    }
    assert.equal(bridge.stats().online, 2, `онлайн через ${waited} мс после подъёма базы`);
    assert.ok(waited <= 30_000);
    assert.equal(lastCmd(DEV(1)).type, 'ping', 'актуальное состояние первому');
    assert.equal(lastCmd(DEV(2)).type, 'ping', 'и второму');
    assert.equal(logs('db_recovered').length, 1);
    assert.ok(logs('mqtt_resubscribe').length >= 1, 'retained запрошены заново');
    assert.equal(logs('devices_online').at(-1).online, 2, 'devices_online не висит на 0');
    await bridge.stop();
  });

  it('ошибка базы при отправке: команда не теряется, повтор после паузы; sweep дочитывает очередь из базы', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await ackLast(DEV(1));
    const rows = [];
    store.loadQueued = async () => rows.filter((r) => r.status === 'queued');
    store.markCommand = async ({ cmdId, status }) => {
      const r = rows.find((x) => x.id === cmdId);
      if (r) r.status = status;
    };
    const real = store.allocateCommand;
    let failures = 2;
    store.allocateCommand = async (args) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('connection terminated');
      }
      const r = rows.find((x) => x.id === args.rowId);
      if (r) r.status = 'sent';
      return real(args);
    };
    rows.push({ id: 'b1000000-0000-4000-8000-000000000001', type: 'state.pending', body: {}, status: 'queued' });
    // NOTIFY потерян: wake не вызывался — sweep сам находит команду.
    mock.timers.tick(5_000);
    await flush();
    await bridge.idle();
    assert.equal(logs('cmd_failed').length, 1);
    assert.equal(lastCmd(DEV(1)).type, 'ping', 'команда пока не ушла');
    mock.timers.tick(5_000);
    await flush();
    await bridge.idle();
    assert.equal(logs('cmd_failed').length, 2);
    mock.timers.tick(5_000);
    await flush();
    await bridge.idle();
    assert.equal(lastCmd(DEV(1)).type, 'state.pending', 'ушла после восстановления базы');
    assert.equal(lastCmd(DEV(1)).id, rows[0].id);
    assert.equal(rows[0].status, 'sent');
    await bridge.stop();
  });

  it('boot сразу после выхода онлайн — один ping; boot позже — старая команда брошена, новое состояние', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1));
    await bridge.onMessage(topic(DEV(1), 'event'), json({ v: 1, boot: 1, boot_id: '9f3a61c2', n: 1, type: 'boot', at_uptime_ms: 5, data: {} }));
    assert.equal(cmds(DEV(1)).length, 1, 'та же загрузка — без второго ping');
    await ackLast(DEV(1));

    mock.timers.tick(BOOT_SYNC_WINDOW_MS + 1);
    await bridge.onMessage(topic(DEV(1), 'state'), state({ last_seq: 1 }));
    await bridge.command(DEV(1), 'identify', { duration_ms: 1 });
    assert.equal(lastCmd(DEV(1)).type, 'identify');
    await bridge.onMessage(topic(DEV(1), 'event'), json({ v: 1, boot: 2, boot_id: '0badc0de', n: 1, type: 'boot', at_uptime_ms: 5, data: {} }));
    assert.deepEqual(logs('cmd_abandoned').map((l) => [l.type, l.reason]), [['identify', 'boot']]);
    assert.equal(lastCmd(DEV(1)).type, 'ping');
    assert.equal(lastCmd(DEV(1)).seq, 3);
    await bridge.stop();
  });
});

describe('мост MQTT: сверка seq', () => {
  beforeEach(() => mock.timers.reset());

  it('seq = greatest(last_seq, state.last_seq) + 1 и запись device.seq_sync', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1), CLUB, { last_seq: 41 });
    assert.equal(lastCmd(DEV(1)).seq, 42);
    assert.deepEqual(store.audit.map((a) => [a.action, a.data.from ?? a.data.seq, a.data.to ?? a.data.type]), [
      ['device.seq_sync', 0, 41],
      ['device.cmd', 42, 'ping'],
    ]);
    assert.deepEqual(logs('device_seq_sync').map((l) => [l.from, l.to]), [[0, 41]]);
    await bridge.stop();
  });

  it('state.last_seq не больше базы — подъёма и записи нет', async () => {
    await setup([device(1, { lastSeq: 100 })]);
    await goOnline(DEV(1), CLUB, { last_seq: 100 });
    assert.equal(lastCmd(DEV(1)).seq, 101);
    assert.deepEqual(store.audit.map((a) => a.action), ['device.cmd']);
    await bridge.stop();
  });

  it(`разрыв больше ${SEQ_GAP_LIMIT} — тревога без подъёма, один раз`, async () => {
    await setup([device(1, { lastSeq: 5 })]);
    await goOnline(DEV(1), CLUB, { last_seq: 5 + SEQ_GAP_LIMIT + 100 });
    assert.equal(lastCmd(DEV(1)).seq, 6);
    await bridge.onMessage(topic(DEV(1), 'ack'), json({ v: 1, cmd_id: lastCmd(DEV(1)).id, seq: 6, ok: false, error: 'replayed_seq' }));
    await bridge.command(DEV(1), 'ping');
    const gap = logs('device_seq_gap');
    assert.equal(gap.length, 1);
    assert.deepEqual({ level: gap[0].level, db: gap[0].db_seq, st: gap[0].state_seq }, { level: 'error', db: 5, st: 5 + SEQ_GAP_LIMIT + 100 });
    assert.ok(!store.audit.some((a) => a.action === 'device.seq_sync'));
    await bridge.stop();
  });
});

describe('мост MQTT: недоверие к входящим', () => {
  beforeEach(() => mock.timers.reset());

  it('клуб — из базы, а не из топика: расхождение — тревога и запись в журнал, устройство не онлайн', async () => {
    await setup([device(1)]);
    await goOnline(DEV(1), OTHER_CLUB);
    assert.equal(bridge.stats().online, 0);
    assert.equal(client.published.length, 0);
    assert.equal(logs('device_club_mismatch').length, 1, 'тревога один раз на топик');
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

  it('устройство без ключа: команда не уходит и журнал не пишется', async () => {
    await setup([device(1, { key: false })]);
    await goOnline(DEV(1));
    assert.equal(bridge.stats().online, 1);
    assert.equal(client.published.length, 0);
    assert.equal(store.audit.length, 0);
    assert.equal(logs('cmd_skipped')[0].reason, 'no_key');
    await bridge.stop();
  });

  it(`state и event больше ${MAX_INCOMING_BYTES} байт отбрасываются с записью в лог`, async () => {
    await setup([device(1)]);
    await bridge.onMessage(topic(DEV(1), 'status'), Buffer.from('online'));
    const big = state({ pad: 'x'.repeat(MAX_INCOMING_BYTES) });
    await bridge.onMessage(topic(DEV(1), 'state'), big);
    assert.equal(bridge.stats().online, 0);
    assert.equal(logs('message_too_large')[0].bytes, big.length);
    const base = state({ pad: '' });
    const exact = state({ pad: 'x'.repeat(MAX_INCOMING_BYTES - base.length) });
    assert.equal(exact.length, MAX_INCOMING_BYTES);
    await bridge.onMessage(topic(DEV(1), 'state'), exact);
    assert.equal(bridge.stats().online, 1, 'ровно 4096 байт принимается');
    await bridge.stop();
  });

  it('событие пишется в лог только кодами и числами', async () => {
    await setup([device(1)]);
    await bridge.onMessage(
      topic(DEV(1), 'event'),
      json({ v: 1, boot: 3, boot_id: '9f3a61c2', n: 1, type: 'lamp_fault', at_uptime_ms: 5, data: { note: '+79991234567' } }),
    );
    const ev = logs('device_event')[0];
    assert.deepEqual({ ...ev, t: 0 }, { t: 0, level: 'info', msg: 'device_event', device_id: DEV(1), type: 'lamp_fault', boot: 3, boot_id: '9f3a61c2', n: 1 });
    assert.ok(!lines.join('\n').includes('79991234567'));
    await bridge.stop();
  });

  it('мусор в сообщениях не роняет мост', async () => {
    await setup([device(1)]);
    for (const kind of ['state', 'status', 'event', 'ack']) {
      await bridge.onMessage(topic(DEV(1), kind), Buffer.from('{oops'));
    }
    await bridge.onMessage(topic(DEV(1), 'ack'), json({ v: 1, cmd_id: 42 }));
    await bridge.onMessage('bl/v1/garbage', Buffer.from('x'));
    assert.equal(bridge.stats().online, 0);
    await goOnline(DEV(1));
    assert.equal(bridge.stats().online, 1);
    await bridge.stop();
  });
});
