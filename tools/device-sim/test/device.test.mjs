// SimDevice без брокера: подменный клиент MQTT. Режимы сбоя, метрика cmd → relay,
// NVS в файле (перезапуск процесса = перезагрузка), HTTP-управление.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SimDevice } from '../lib/device.mjs';
import { FakeClock } from '../lib/clock.mjs';
import { FileNvs, MemoryNvs, NVS_KEYS } from '../lib/nvs.mjs';
import { startControl } from '../lib/control.mjs';
import { createLogger } from '../lib/log.mjs';
import { makeCommand, signed, TEST_KEY_B64 } from './helpers/sign.mjs';

const DEVICE_ID = '0192f3c0-aaaa-7000-8000-000000000001';
const CLUB_ID = '0192f3c0-bbbb-7000-8000-000000000001';
const SESSION = '0192f3c0-0000-7000-8000-0000000000aa';
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeClient extends EventEmitter {
  constructor(url, opts) {
    super();
    this.opts = opts;
    this.published = [];
    this.connected = false;
    this.ended = null;
    queueMicrotask(() => {
      this.connected = true;
      this.emit('connect');
    });
  }

  subscribe(topic, opts, cb) {
    queueMicrotask(() => cb(null, [{ topic, qos: 1 }]));
  }

  publish(topic, payload, opts, cb) {
    this.published.push({ topic, payload: String(payload), opts });
    queueMicrotask(() => cb?.(null));
  }

  end(force) {
    this.ended = { force };
    this.connected = false;
    queueMicrotask(() => this.emit('close'));
  }

  async endAsync() {
    this.end(false);
  }

  async publishAsync(topic, payload, opts) {
    this.publish(topic, payload, opts);
  }
}

function rig(options = {}) {
  const clients = [];
  const lines = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(JSON.parse(l)) });
  const clock = options.clock ?? new FakeClock(0);
  const dev = new SimDevice({
    device: {
      deviceId: DEVICE_ID, clubId: CLUB_ID, table: 4, mqttUsername: null, mqttPassword: 'pw-secret', deviceKey: Buffer.from(TEST_KEY_B64, 'base64'),
    },
    mqttUrl: 'mqtt://broker:1883',
    log,
    clock,
    nvs: options.nvs,
    nvsDir: options.nvsDir,
    faults: options.faults,
    connect: (url, opts) => {
      const c = new FakeClient(url, opts);
      clients.push(c);
      return c;
    },
  });
  let seq = options.seq ?? 0;
  const client = () => clients.at(-1);
  const on = (leaf) => client().published.filter((p) => p.topic.endsWith(`/${leaf}`));
  const send = async (type, body = {}, extra = {}) => {
    seq += 1;
    const raw = signed(makeCommand({ seq, type, body, ...extra }));
    client().emit('message', dev.topics.cmd, Buffer.from(raw));
    await tick();
    return raw;
  };
  return { dev, clients, client, lines, clock, on, send, log: (msg) => lines.filter((l) => l.msg === msg) };
}

test('подключение: Last Will, online после подписки, state и boot', async () => {
  const r = rig();
  r.dev.start();
  await tick();
  const c = r.client();
  assert.equal(c.opts.clientId, DEVICE_ID);
  assert.equal(c.opts.clean, true);
  assert.deepEqual([c.opts.will.topic.endsWith('/status'), String(c.opts.will.payload), c.opts.will.retain, c.opts.will.qos], [true, 'offline', true, 1]);
  assert.deepEqual(r.on('status').map((p) => p.payload), ['online']);
  assert.equal(JSON.parse(r.on('state').at(-1).payload).mode, 'free');
  assert.equal(JSON.parse(r.on('event')[0].payload).type, 'boot');
  await r.dev.stop();
});

test('метрика sim_relay при включении света session.start; без неё на extend', async () => {
  const r = rig();
  r.dev.start();
  await tick();
  const raw = await r.send('session.start', { session_id: SESSION, remaining_ms: 3_600_000, buzzer: true });
  const [m] = r.log('sim_relay');
  assert.equal(m.relay, true);
  assert.equal(m.device_id, DEVICE_ID);
  assert.equal(m.table, 4);
  assert.equal(m.cmd_id, JSON.parse(raw).id);
  assert.equal(m.type, 'session.start');
  assert.ok(typeof m.ms_since_cmd === 'number' && m.ms_since_cmd >= 0 && m.ms_since_cmd < 1000);
  await r.send('session.extend', { session_id: SESSION, remaining_ms: 600_000, buzzer: true });
  assert.equal(r.log('sim_relay').length, 1);
  assert.equal(JSON.parse(r.on('ack').at(-1).payload).ok, true);
  assert.ok(!JSON.stringify(r.lines).includes('pw-secret'));
  await r.dev.stop();
});

test('slow-ack: ack уходит с задержкой, state — сразу', async () => {
  const r = rig();
  r.dev.start();
  await tick();
  r.dev.setFault('slow-ack', true, 80);
  await r.send('ping');
  assert.equal(r.on('ack').length, 0);
  await sleep(120);
  assert.equal(r.on('ack').length, 1);
  r.dev.setFault('slow-ack', false);
  await r.send('ping');
  assert.equal(r.on('ack').length, 2);
  await r.dev.stop();
});

test('net-drop: обрыв без DISCONNECT, через ms — новое подключение; события без связи досылаются', async () => {
  const r = rig();
  r.dev.start();
  await tick();
  const first = r.client();
  r.dev.setFault('net-drop', true, 60);
  await tick();
  assert.deepEqual(first.ended, { force: true }, 'end(true): без DISCONNECT, брокер публикует Last Will');
  assert.equal(r.dev.status().online, false);
  r.dev.machine.handleCommand(Buffer.from(signed(makeCommand({ seq: 1 }), Buffer.alloc(32, 9).toString('base64'))));
  assert.deepEqual(r.dev.status().outbox.map((e) => e.type), ['bad_sig']);
  await sleep(100);
  const second = r.client();
  assert.notEqual(second, first);
  assert.equal(r.dev.status().online, true);
  assert.ok(second.published.some((p) => p.topic.endsWith('/event') && JSON.parse(p.payload).type === 'bad_sig'));
  assert.deepEqual(r.dev.status().outbox, []);
  r.dev.setNet(false);
  r.dev.setNet(true);
  await tick();
  assert.equal(r.clients.length, 3);
  await r.dev.stop();
});

test('reboot: свет гаснет, boot+1, правило 4 — session.resume в окне', async () => {
  const clock = new FakeClock(0);
  const r = rig({ clock });
  r.dev.start();
  await tick();
  await r.send('session.start', { session_id: SESSION, remaining_ms: 600_000, buzzer: true });
  clock.advance(130_000);
  r.dev.reboot({ downMs: 0, resetReason: 'sw' });
  assert.equal(r.dev.status().powered, false);
  await sleep(5);
  await tick();
  const st = r.dev.status();
  assert.deepEqual([st.powered, st.state.mode, st.state.relay, st.state.boot, st.boot_waiting], [true, 'free', false, 2, true]);
  assert.equal(st.nvs_session.remaining_ms, 480_000);
  await r.send('session.resume', { session_id: SESSION, remaining_ms: 470_000, buzzer: true });
  assert.deepEqual([r.dev.status().state.mode, r.dev.status().state.remaining_ms], ['active', 470_000]);
  assert.equal(r.log('sim_relay').at(-1).type, 'session.resume');
  const boots = r.client().published.filter((p) => p.topic.endsWith('/event')).map((p) => JSON.parse(p.payload)).filter((e) => e.type === 'boot');
  assert.deepEqual(boots.map((e) => [e.boot, e.data.reset_reason]), [[2, 'sw']]);
  await r.dev.stop();
});

test('replay-old: старый session.extend подаётся себе — replayed_seq, время не продлено (T8)', async () => {
  const clock = new FakeClock(0);
  const r = rig({ clock });
  r.dev.start();
  await tick();
  assert.deepEqual(r.dev.setFault('replay-old', true).replayed, { result: 'nothing_to_replay' });
  r.dev.setFault('replay-old', false);
  await r.send('session.start', { session_id: SESSION, remaining_ms: 600_000, buzzer: true });
  await r.send('session.extend', { session_id: SESSION, remaining_ms: 7_200_000, buzzer: true });
  await r.send('session.extend', { session_id: SESSION, remaining_ms: 1_200_000, buzzer: true });
  const res = r.dev.setFault('replay-old', true);
  assert.deepEqual(res.replayed, { seq: 2, type: 'session.extend', result: 'replayed_seq' });
  assert.equal(r.dev.status().state.remaining_ms, 1_200_000);
  const ack = JSON.parse(r.on('ack').at(-1).payload);
  assert.deepEqual([ack.seq, ack.ok, ack.error], [2, false, 'replayed_seq']);
  await tick();
  assert.ok(r.on('event').some((p) => JSON.parse(p.payload).type === 'replayed_seq'));
  await r.dev.stop();
});

test('bypass через setFault: bypass_detected после current_confirm_ms; ms снимает сбой', async () => {
  const clock = new FakeClock(0);
  const r = rig({ clock });
  r.dev.start();
  await tick();
  r.dev.setFault('bypass', true);
  assert.equal(r.dev.status().state.current_ma, 380);
  clock.advance(10_000);
  await tick();
  assert.equal(r.dev.status().state.mode, 'fault');
  assert.ok(r.on('event').some((p) => JSON.parse(p.payload).type === 'bypass_detected'));
  r.dev.setFault('bypass', true, 20);
  await sleep(40);
  assert.equal(r.dev.status().faults.bypass, false);
  assert.equal(r.dev.status().state.mode, 'free');
  assert.throws(() => r.dev.setFault('meteor', true), /unknown_fault/);
  assert.throws(() => r.dev.setFault('bypass', 'yes'), /bad_on/);
  assert.throws(() => r.dev.setFault('bypass', true, -5), /bad_ms/);
  await r.dev.stop();
});

test('ota.start: в симуляторе загрузки нет — ack ok, затем ota_failed sim_unsupported', async () => {
  const r = rig();
  r.dev.start();
  await tick();
  await r.send('ota.start', { url: 'https://billiardum.ru/fw/1.0.4.bin', version: '1.0.4', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', image_sig: 'AA==' });
  assert.equal(JSON.parse(r.on('ack').at(-1).payload).ok, true);
  await tick();
  await tick();
  const ev = r.on('event').map((p) => JSON.parse(p.payload)).find((e) => e.type === 'ota_failed');
  assert.deepEqual(ev.data, { version: '1.0.4', error: 'sim_unsupported' });
  await r.dev.stop();
});

test('флаги CLI: bypass и slow-ack с ms при старте', async () => {
  const r = rig({ faults: [{ name: 'slow-ack', table: 4, ms: 50 }, { name: 'bypass', table: null, ms: null }, { name: 'lamp-fault', table: 1, ms: null }] });
  r.dev.start();
  await tick();
  const st = r.dev.status();
  assert.deepEqual(st.faults, { bypass: true, 'lamp-fault': false, 'slow-ack': 50, 'replay-old': false });
  await r.dev.stop();
});

test('SIM_NVS_DIR: перезапуск процесса — перезагрузка с тем же NVS (boot, seq, сессия)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-sim-nvs-'));
  try {
    const clock = new FakeClock(0);
    const a = rig({ clock, nvsDir: dir });
    a.dev.start();
    await tick();
    await a.send('session.start', { session_id: SESSION, remaining_ms: 600_000, buzzer: true });
    clock.advance(61_000);
    await a.dev.stop();
    const file = path.join(dir, `${DEVICE_ID}.json`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes('pw-secret'), 'секретов в NVS симулятора нет');

    const b = rig({ clock, nvsDir: dir, seq: 1 });
    b.dev.start();
    await tick();
    const st = b.dev.status();
    assert.deepEqual([st.state.boot, st.state.last_seq, st.state.mode, st.boot_waiting], [2, 1, 'free', true]);
    assert.equal(st.nvs_session.remaining_ms, 540_000);
    clock.advance(30_000);
    assert.deepEqual([b.dev.status().state.mode, b.dev.status().state.remaining_ms], ['active', 480_000]);
    await b.dev.stop();

    const nvs = new FileNvs(dir, DEVICE_ID);
    assert.equal(nvs.get(NVS_KEYS.session).offline_resumes, 1);
    assert.equal(nvs.get(NVS_KEYS.replay).seq, 1);
    assert.throws(() => new FileNvs(dir, '../etc'), /UUID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('перепривязка (новый device_key): seq, id, ack и сессия сброшены, boot сохранён (§7)', async () => {
  const nvs = new MemoryNvs();
  const clock = new FakeClock(0);
  const a = rig({ clock, nvs });
  a.dev.start();
  await tick();
  await a.send('session.start', { session_id: SESSION, remaining_ms: 600_000, buzzer: true });
  await a.dev.stop();
  const clients = [];
  const b = new SimDevice({
    device: { deviceId: DEVICE_ID, clubId: CLUB_ID, table: 4, mqttUsername: null, mqttPassword: 'x', deviceKey: Buffer.alloc(32, 5) },
    mqttUrl: 'mqtt://broker:1883', log: createLogger({ write: () => {} }), clock, nvs,
    connect: (url, opts) => { const c = new FakeClient(url, opts); clients.push(c); return c; },
  });
  b.start();
  await tick();
  const st = b.status();
  assert.deepEqual([st.state.boot, st.state.last_seq, st.boot_waiting, st.nvs_session], [2, 0, false, null]);
  await b.stop();
});

test('HTTP inject: сырая команда проходит весь путь проверки — ack, события; предел 2048 байт', async () => {
  const r = rig({ nvs: new MemoryNvs() });
  r.dev.start();
  await tick();
  const control = await startControl({ devices: [r.dev], port: 0, log: createLogger({ write: () => {} }) });
  const inject = (raw) => fetch(`http://127.0.0.1:${control.port}/sim/tables/4/inject`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  try {
    const cmd = makeCommand({ seq: 1, type: 'session.start', body: { session_id: SESSION, remaining_ms: 600_000, buzzer: true } });
    const ok = await (await inject(signed(cmd))).json();
    assert.deepEqual([ok.ok, ok.result, ok.ack.ok, ok.ack.cmd_id, ok.table.state.mode], [true, 'ok', true, cmd.id, 'active']);
    assert.equal(JSON.parse(r.on('ack').at(-1).payload).cmd_id, cmd.id, 'ack ушёл в топик ack');
    assert.equal(r.log('sim_relay').length, 1, 'метрика — как у команды из MQTT');

    // T9: подпись чужим ключом — bad_sig, событие, свет не тронут.
    const forged = makeCommand({ seq: 2, type: 'session.stop', body: { session_id: SESSION, reason_code: 'guest_finished' } });
    const bad = await (await inject(signed(forged, Buffer.alloc(32, 9).toString('base64')))).json();
    assert.deepEqual([bad.result, bad.reason, bad.ack.error, bad.ack.cmd_id, bad.table.state.mode], ['bad_sig', 'sig_mismatch', 'bad_sig', forged.id, 'active']);
    await tick();
    assert.ok(r.on('event').some((p) => JSON.parse(p.payload).type === 'bad_sig'));
    assert.ok(!JSON.stringify(r.lines).includes(JSON.parse(signed(forged)).sig), 'подпись не в логе');

    const fmt = await (await inject('{"v":1,"id":')).json();
    assert.deepEqual([fmt.result, fmt.ack.cmd_id, fmt.ack.error], ['bad_format', null, 'bad_format']);
    const replay = await (await inject(signed(cmd))).json();
    assert.equal(replay.result, 'resend', 'точный повтор — сохранённый ack');

    const big = await inject(`{"pad":"${'x'.repeat(2048)}"}`);
    assert.deepEqual([big.status, await big.json()], [413, { error: 'too_large' }]);
    const edge = await (await inject(`{"pad":"${'x'.repeat(2048 - 10)}"}`)).json();
    assert.equal(edge.result, 'bad_format', 'ровно 2048 байт доходят до проверки');
    const notString = await fetch(`http://127.0.0.1:${control.port}/sim/tables/4/inject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: 5 }),
    });
    assert.deepEqual([notString.status, await notString.json()], [400, { error: 'bad_raw' }]);
    r.dev.reboot({ downMs: 60_000 });
    const off = await inject(signed(makeCommand({ seq: 3 })));
    assert.deepEqual([off.status, await off.json()], [409, { error: 'powered_off' }]);
  } finally {
    await control.close();
    await r.dev.stop();
  }
});

test('HTTP-управление: маршруты, JSON обязателен, ошибки кодом', async () => {
  const r = rig({ nvs: new MemoryNvs() });
  r.dev.start();
  await tick();
  const control = await startControl({ devices: [r.dev], port: 0, log: createLogger({ write: () => {} }) });
  const base = `http://127.0.0.1:${control.port}`;
  const post = (p, body, type = 'application/json') => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
  try {
    const all = await (await fetch(`${base}/sim/tables`)).json();
    assert.equal(all.length, 1);
    assert.deepEqual([all[0].table, all[0].device_id, all[0].state.mode], [4, DEVICE_ID, 'free']);
    assert.equal((await (await fetch(`${base}/sim/tables/4`)).json()).table, 4);
    assert.equal((await fetch(`${base}/sim/tables/9`)).status, 404);
    assert.equal((await fetch(`${base}/sim/tables/abc`)).status, 404);
    assert.equal((await fetch(`${base}/other`)).status, 404);
    assert.equal((await fetch(`${base}/sim/tables/4`, { method: 'DELETE' })).status, 405);

    const f = await post('/sim/tables/4/fault', { name: 'bypass', on: true });
    assert.equal(f.status, 200);
    const fb = await f.json();
    assert.deepEqual([fb.ok, fb.fault, fb.on, fb.table.faults.bypass, fb.table.state.current_ma], [true, 'bypass', true, true, 380]);
    assert.equal((await post('/sim/tables/4/fault', { name: 'bypass', on: true }, 'text/plain')).status, 415);
    const bad = await post('/sim/tables/4/fault', { name: 'meteor', on: true });
    assert.deepEqual([bad.status, await bad.json()], [400, { error: 'unknown_fault' }]);
    assert.equal((await post('/sim/tables/4/fault', { name: 'bypass', on: true, ms: 'x' })).status, 400);
    const broken = await fetch(`${base}/sim/tables/4/net`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.deepEqual([broken.status, await broken.json()], [400, { error: 'bad_json' }]);
    const big = await fetch(`${base}/sim/tables/4/net`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"up":true,"x":"${'a'.repeat(17_000)}"}` }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);

    const n = await (await post('/sim/tables/4/net', { up: false })).json();
    assert.deepEqual([n.table.net_up, n.table.online], [false, false]);
    assert.equal((await post('/sim/tables/4/net', { up: 'no' })).status, 400);
    await post('/sim/tables/4/net', { up: true });
    await tick();
    assert.equal(r.dev.status().online, true);

    const rb = await (await post('/sim/tables/4/reboot', { reset_reason: 'task_wdt' })).json();
    assert.equal(rb.ok, true);
    assert.equal((await post('/sim/tables/4/reboot', { reset_reason: 'meteor' })).status, 400);
    await sleep(5);
    assert.equal(r.dev.status().state.boot, 2);
  } finally {
    await control.close();
    await r.dev.stop();
  }
});
