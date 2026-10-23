// Режим «новый контроллер» (--claim, protocol §7, решения №67 и №159, контракт M5.1 §2):
// общие с прошивкой векторы, цикл привязки с повтором, неверный код, закрытое окно,
// повтор после успеха, файл ключей, HTTP-управление, конфиг.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CLAIM_RATE_LIMITED_MS, ClaimingDevice, ClaimStore, claimRetryDelayMs, isClaimCode, parseClaimSpec, parseFactoryArgs,
  postClaim, validateClaimResponse, withJitter,
} from '../lib/claim.mjs';
import { ConfigError, loadConfig } from '../lib/config.mjs';
import { startControl } from '../lib/control.mjs';
import { createLogger } from '../lib/log.mjs';
import { FakeClaimApi, MAX_CLAIM_ATTEMPTS } from './helpers/claim-api.mjs';
import { makeCommand, testSig } from './helpers/sign.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('./claim-vectors.json', import.meta.url), 'utf8'));
const DEVICE_ID = '0192f3c0-dddd-7000-8000-000000000101';
const DEVICE_2 = '0192f3c0-dddd-7000-8000-000000000102';
const CODE = 'K7M2QX9P4TZB';
const OTHER_CODE = 'WRONG2345678';
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const tmp = mkdtempSync(path.join(tmpdir(), 'bl-sim-claim-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let dirN = 0;
const freshDir = () => path.join(tmp, `d${(dirN += 1)}`);

class FakeClient extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.published = [];
    this.connected = false;
    queueMicrotask(() => {
      this.connected = true;
      this.emit('connect');
    });
  }

  subscribe(topic, opts, cb) {
    this.subscribed = topic;
    queueMicrotask(() => cb(null, [{ topic, qos: 1 }]));
  }

  publish(topic, payload, opts, cb) {
    this.published.push({ topic, payload: String(payload), opts });
    queueMicrotask(() => cb?.(null));
  }

  end() {
    this.connected = false;
    queueMicrotask(() => this.emit('close'));
  }

  async endAsync() {
    this.end();
  }

  async publishAsync(topic, payload, opts) {
    this.publish(topic, payload, opts);
  }
}

/** Ручной планировщик: задержки записываются, срабатывают по runNext(). */
function manualScheduler(api) {
  const queue = [];
  return {
    delays: [],
    schedule(fn, ms) {
      const item = { fn, ms, cancelled: false };
      queue.push(item);
      this.delays.push(ms);
      return { cancel: () => { item.cancelled = true; } };
    },
    pending() {
      return queue.filter((i) => !i.cancelled);
    },
    async runNext() {
      const i = queue.findIndex((x) => !x.cancelled);
      assert.ok(i >= 0, 'нет запланированной попытки');
      const [item] = queue.splice(i, 1);
      if (api) api.now += item.ms;
      item.fn();
      await flush();
      return item.ms;
    },
  };
}

function rig({ api = new FakeClaimApi(), dir = freshDir(), code = CODE, deviceId = DEVICE_ID, table = 101, post, mqttUrl = null } = {}) {
  const lines = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l) });
  const sched = manualScheduler(api);
  const clients = [];
  const store = new ClaimStore(dir);
  const dev = new ClaimingDevice({
    factory: { deviceId, claimCode: code, table },
    apiUrl: 'https://api.test',
    store,
    mqttUrl,
    log,
    post: post ?? api.post,
    schedule: (fn, ms) => sched.schedule(fn, ms),
    random: () => 0,
    now: () => api.now,
    connect: (url, opts) => {
      const c = new FakeClient(url, opts);
      clients.push(c);
      return c;
    },
  });
  return {
    api, dev, sched, store, dir, clients, lines,
    log: (msg) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg),
  };
}

// ——— Общие векторы с прошивкой ———

test('векторы factory: консольная команда и строка QR BLD1 — как bl::parseFactoryArgs', () => {
  assert.ok(VECTORS.factory.length >= 20);
  for (const v of VECTORS.factory) {
    const got = parseFactoryArgs(v.args);
    if (v.ok) assert.deepEqual(got, { deviceId: v.device_id, claimCode: v.claim_code }, v.name);
    else assert.equal(got, null, v.name);
  }
});

test('векторы retry: задержки повтора claim — как bl::claimRetryDelayMs', () => {
  for (const v of VECTORS.retry) assert.equal(claimRetryDelayMs(v.failures, v.error), v.ms, `${v.error} × ${v.failures}`);
  assert.equal(withJitter(30_000, () => 0), 30_000);
  assert.equal(withJitter(30_000, () => 0.999999), 36_000, 'добавка до 20 % включительно, как esp_random() % (d/5+1)');
});

test('код привязки — пароль WPA2: 8…63 символа [A-Za-z0-9-]', () => {
  assert.ok(isClaimCode('ABCDEFGH'));
  assert.ok(!isClaimCode('ABCDEFG'));
  assert.ok(!isClaimCode('A'.repeat(64)));
  assert.ok(!isClaimCode(12345678));
});

test('--claim: BLD1[@номер], ошибка без кода привязки в тексте', () => {
  assert.deepEqual(parseClaimSpec(`BLD1:${DEVICE_ID}:${CODE}`), { deviceId: DEVICE_ID, claimCode: CODE, table: null });
  assert.deepEqual(parseClaimSpec(`BLD1:${DEVICE_ID.toUpperCase()}:${CODE}@7`), { deviceId: DEVICE_ID, claimCode: CODE, table: 7 });
  for (const bad of [`${DEVICE_ID}:${CODE}`, `BLD1:${DEVICE_ID}:SHORT`, `BLD1:${DEVICE_ID}:${CODE}@0`, `BLD1:${DEVICE_ID}:${CODE}@x`, `BLD1:${DEVICE_ID}:${CODE}_X`]) {
    assert.throws(() => parseClaimSpec(bad), (err) => !err.message.includes(CODE), bad);
  }
});

test('ответ claim проверяется как в прошивке: mqtts://, ключ 32 байта, club_id UUID, пароль не пуст', () => {
  const ok = { mqtt_username: DEVICE_ID, mqtt_password: 'p', device_key: Buffer.alloc(32, 1).toString('base64'), mqtt_url: 'mqtts://h:8883', club_id: DEVICE_2 };
  assert.ok(validateClaimResponse(ok));
  assert.equal(validateClaimResponse({ ...ok, mqtt_url: 'mqtt://h:1883' }), null);
  assert.equal(validateClaimResponse({ ...ok, device_key: Buffer.alloc(16).toString('base64') }), null);
  assert.equal(validateClaimResponse({ ...ok, club_id: 'club' }), null);
  assert.equal(validateClaimResponse({ ...ok, mqtt_password: '' }), null);
  assert.equal(validateClaimResponse(null), null);
});

// ——— Цикл привязки ———

test('новый контроллер: ждёт привязки, повторяет claim 5/10/20/30 с, после bind — ключи и MQTT', async () => {
  const r = rig();
  r.dev.start();
  assert.equal(r.dev.status().claim.state, 'waiting');
  assert.equal(r.dev.status().state, null, 'до привязки состояния стола нет: брокера не знает');
  assert.deepEqual(r.sched.delays, [0], 'первая попытка сразу, как после подключения Wi-Fi');

  for (let i = 0; i < 5; i += 1) await r.sched.runNext();
  assert.equal(r.api.requests.length, 5);
  assert.deepEqual(r.sched.delays, [0, 5000, 10_000, 20_000, 30_000, 30_000]);
  const st = r.dev.status().claim;
  assert.deepEqual([st.state, st.failures, st.last_error, st.next_attempt_in_ms], ['waiting', 5, 'forbidden', 30_000]);
  assert.equal(r.clients.length, 0, 'без ключей к брокеру не ходит');
  assert.equal(r.store.load(DEVICE_ID), null);

  r.api.bind(DEVICE_ID, CODE); // владелец сканирует QR и выбирает стол
  await r.sched.runNext();
  const issued = r.api.issued.get(DEVICE_ID);
  assert.ok(issued);
  assert.equal(r.dev.status().claim.state, 'claimed');
  assert.equal(r.sched.pending().length, 0, 'после привязки claim больше не зовётся');

  // Ключи — в файле 0600, папка 0700.
  const file = r.store.file(DEVICE_ID);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(r.dir).mode & 0o777, 0o700);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(
    [saved.device_id, saved.club_id, saved.mqtt_url, saved.mqtt_password, saved.device_key],
    [DEVICE_ID, r.api.clubId, r.api.mqttUrl, issued.mqtt_password, issued.device_key],
  );

  // MQTT по протоколу §2: логин и client id — device_id, топики с club_id из ответа.
  await flush();
  const c = r.clients.at(-1);
  assert.equal(c.url, r.api.mqttUrl);
  assert.deepEqual([c.opts.clientId, c.opts.username, c.opts.password], [DEVICE_ID, DEVICE_ID, issued.mqtt_password]);
  assert.equal(c.subscribed, `bl/v1/${r.api.clubId}/${DEVICE_ID}/cmd`);
  assert.deepEqual(c.published.filter((p) => p.topic.endsWith('/status')).map((p) => p.payload), ['online']);
  const status = r.dev.status();
  assert.deepEqual([status.online, status.club_id, status.state.mode, status.state.relay, status.claim.source], [true, r.api.clubId, 'free', false, 'claimed']);

  // Команда, подписанная выданным device_key, исполняется.
  const cmd = makeCommand({ seq: 1, type: 'ping' });
  const raw = JSON.stringify({ ...cmd, sig: testSig(cmd, issued.device_key) });
  c.emit('message', `bl/v1/${r.api.clubId}/${DEVICE_ID}/cmd`, Buffer.from(raw));
  await flush();
  assert.equal(JSON.parse(c.published.filter((p) => p.topic.endsWith('/ack')).at(-1).payload).ok, true);

  // В логе нет кода привязки, пароля MQTT и device_key.
  const text = r.lines.join('\n');
  for (const secret of [CODE, issued.mqtt_password, issued.device_key]) assert.ok(!text.includes(secret));
  assert.equal(r.log('sim_claimed').length, 1);
  assert.equal(r.log('sim_claim_failed').length, 5);
  await r.dev.stop();
});

test('неверный код: каждая попытка считается, пятая закрывает окно; контроллер ждёт новой привязки', async () => {
  const r = rig();
  r.api.bind(DEVICE_ID, OTHER_CODE); // владелец ввёл не тот код
  r.dev.start();
  for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i += 1) await r.sched.runNext();
  const w = r.api.window(DEVICE_ID);
  assert.deepEqual([w.failed, w.closed, w.claimed], [MAX_CLAIM_ATTEMPTS, true, false]);
  assert.equal(r.dev.status().claim.last_error, 'forbidden');

  // Окно закрыто: даже верный код теперь не принимается, попытки не считаются.
  await r.sched.runNext();
  assert.equal(r.api.window(DEVICE_ID).failed, MAX_CLAIM_ATTEMPTS);
  assert.equal(r.dev.status().claim.state, 'waiting');
  assert.equal(r.store.load(DEVICE_ID), null);
  assert.equal(r.clients.length, 0);

  // Владелец открывает привязку снова с верным кодом — контроллер привязывается сам.
  r.api.bind(DEVICE_ID, CODE);
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.state, 'claimed');
  await r.dev.stop();
});

test('окно закрыто по времени (30 мин): forbidden; новое окно — привязка', async () => {
  const r = rig();
  r.api.bind(DEVICE_ID, CODE);
  r.dev.setNet(false); // Wi-Fi клуба ещё не введён
  r.dev.start();
  await r.sched.runNext();
  assert.equal(r.api.requests.length, 0, 'без сети код не тратится');
  r.api.now += 31 * 60_000;
  r.dev.setNet(true);
  await r.sched.runNext();
  assert.equal(r.api.requests.length, 1);
  assert.equal(r.dev.status().claim.last_error, 'forbidden');
  assert.equal(r.api.window(DEVICE_ID).failed, 0, 'просроченное окно попытки не считает');
  r.api.bind(DEVICE_ID, CODE);
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.state, 'claimed');
  await r.dev.stop();
});

test('повтор после успеха: перезапуск берёт ключи из файла, claim не зовётся; код сгорел', async () => {
  const api = new FakeClaimApi();
  const dir = freshDir();
  const first = rig({ api, dir });
  api.bind(DEVICE_ID, CODE);
  first.dev.start();
  await first.sched.runNext();
  assert.equal(first.dev.status().claim.state, 'claimed');
  const issued = api.issued.get(DEVICE_ID);
  await first.dev.stop();

  // Код сгорел: тот же claim сервер больше не принимает.
  assert.deepEqual(api.claim({ device_id: DEVICE_ID, claim_code: CODE }), { status: 403, json: { error: 'forbidden' } });
  const before = api.requests.length;

  // Перезапуск процесса (перезагрузка контроллера): ключи из файла, к API не ходит.
  const second = rig({ api, dir });
  second.dev.start();
  await flush();
  assert.equal(api.requests.length, before);
  assert.equal(second.sched.delays.length, 0);
  const st = second.dev.status();
  assert.deepEqual([st.claim.state, st.claim.source, st.online, st.club_id], ['claimed', 'stored', true, api.clubId]);
  assert.equal(second.clients.at(-1).opts.password, issued.mqtt_password);
  assert.equal(second.log('sim_claim_stored').length, 1);
  await second.dev.stop();
});

test('повтор после успеха: ответ потерялся — forbidden, пока владелец не привяжет снова; ключ — последний выданный', async () => {
  const api = new FakeClaimApi();
  let lose = true;
  const post = async (req) => {
    const res = await api.post(req);
    if (lose && res.ok) {
      lose = false;
      return { ok: false, error: 'network', status: 0 }; // сервер привязал, ответ не дошёл
    }
    return res;
  };
  const r = rig({ api, post });
  api.bind(DEVICE_ID, CODE);
  r.dev.start();
  await r.sched.runNext();
  assert.ok(api.issued.get(DEVICE_ID), 'сервер ключи выдал');
  assert.equal(r.dev.status().claim.last_error, 'network');
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.last_error, 'forbidden', 'код сгорел');
  assert.equal(r.store.load(DEVICE_ID), null);

  api.bind(DEVICE_ID, CODE); // владелец: «Добавить контроллер» ещё раз
  await r.sched.runNext();
  const last = api.issued.get(DEVICE_ID);
  assert.equal(r.dev.status().claim.state, 'claimed');
  assert.equal(r.store.load(DEVICE_ID).device_key, last.device_key);
  await r.dev.stop();
});

test('bad_request — без автоматического повтора; перезагрузка начинает заново', async () => {
  // Сервер принимает код от 6 символов, симулятор — от 8: короткий код в обход разбора --claim.
  const r = rig({ code: 'BAD_CODE!' });
  r.dev.start();
  await r.sched.runNext();
  assert.deepEqual([r.dev.status().claim.state, r.dev.status().claim.last_error], ['failed', 'bad_request']);
  assert.equal(r.sched.pending().length, 0);
  assert.equal(r.log('sim_claim_failed')[0].level, 'error');
  r.dev.reboot({ downMs: 0 });
  assert.equal(r.dev.status().claim.state, 'waiting');
  await r.sched.runNext();
  assert.equal(r.api.requests.length, 2);
  await r.dev.stop();
});

test('rate_limited — 60 с; bad_response — повтор, ключи не сохраняются', async () => {
  const api = new FakeClaimApi({ mqttUrl: 'mqtt://plain:1883' }); // прошивка не примет ключи без TLS
  api.rateLimitLeft = 0;
  const post = async ({ deviceId, claimCode }) => {
    const { status, json } = api.claim({ device_id: deviceId, claim_code: claimCode });
    if (status !== 200) return { ok: false, error: json.error, status };
    const creds = validateClaimResponse(json);
    return creds ? { ok: true, creds } : { ok: false, error: 'bad_response', status };
  };
  const r = rig({ api, post });
  api.bind(DEVICE_ID, CODE);
  r.dev.start();
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.next_attempt_in_ms, CLAIM_RATE_LIMITED_MS);
  api.rateLimitLeft = Infinity;
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.last_error, 'bad_response');
  assert.equal(r.store.load(DEVICE_ID), null);
  assert.equal(r.sched.delays.at(-1), 10_000, 'вторая неудача подряд');
  await r.dev.stop();
});

test('до привязки: сбои и inject — not_claimed; unclaim после привязки — ключи стёрты, снова ждёт', async () => {
  const r = rig();
  r.dev.start();
  assert.throws(() => r.dev.setFault('bypass', true), /not_claimed/);
  assert.throws(() => r.dev.inject('{}'), /not_claimed/);
  r.api.bind(DEVICE_ID, CODE);
  await r.sched.runNext();
  assert.ok(existsSync(r.store.file(DEVICE_ID)));
  await r.dev.unclaim();
  assert.ok(!existsSync(r.store.file(DEVICE_ID)));
  assert.equal(r.dev.status().claim.state, 'waiting');
  assert.equal(r.dev.device, null);
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.last_error, 'forbidden', 'код сгорел — нужна новая привязка владельцем');
  r.api.bind(DEVICE_ID, CODE);
  await r.sched.runNext();
  assert.equal(r.dev.status().claim.state, 'claimed');
  await r.dev.stop();
});

test('два новых контроллера рядом: каждый со своим device_id, номером и файлом ключей', async () => {
  const api = new FakeClaimApi();
  const dir = freshDir();
  const a = rig({ api, dir, deviceId: DEVICE_ID, table: 101 });
  const b = rig({ api, dir, deviceId: DEVICE_2, code: 'P4TZBK7M2QX9', table: 102 });
  a.dev.start();
  b.dev.start();
  api.bind(DEVICE_ID, CODE);
  api.bind(DEVICE_2, 'P4TZBK7M2QX9');
  await a.sched.runNext();
  await b.sched.runNext();
  assert.equal(a.dev.status().claim.state, 'claimed');
  assert.equal(b.dev.status().claim.state, 'claimed');
  assert.notEqual(a.store.load(DEVICE_ID).device_key, b.store.load(DEVICE_2).device_key);
  assert.equal(b.clients.at(-1).opts.clientId, DEVICE_2);
  await a.dev.stop();
  await b.dev.stop();
});

// ——— HTTP ———

test('postClaim по HTTP: 200, 403, 400, не JSON, слишком большой ответ, нет сервера', async () => {
  const api = new FakeClaimApi();
  const url = await api.listen();
  try {
    const req = { apiUrl: `${url}/`, deviceId: DEVICE_ID, claimCode: CODE };
    assert.deepEqual(await postClaim(req), { ok: false, error: 'forbidden', status: 403 });
    api.bind(DEVICE_ID, CODE);
    const ok = await postClaim(req);
    assert.equal(ok.ok, true);
    assert.equal(ok.creds.club_id, api.clubId);
    assert.deepEqual(api.requests.at(-1).body, { device_id: DEVICE_ID, claim_code: CODE });
    assert.deepEqual(await postClaim({ ...req, claimCode: 'x' }), { ok: false, error: 'bad_request', status: 400 });
  } finally {
    await api.close();
  }

  const http = await import('node:http');
  const odd = http.createServer((q, s) => {
    if (q.url.startsWith('/big')) s.writeHead(200).end(JSON.stringify({ pad: 'x'.repeat(5000) }));
    else if (q.url.startsWith('/weird')) s.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"<b>"}');
    else s.writeHead(502).end('bad gateway');
  });
  await new Promise((r) => odd.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${odd.address().port}`;
  try {
    assert.deepEqual(await postClaim({ apiUrl: base, deviceId: DEVICE_ID, claimCode: CODE }), { ok: false, error: 'http_502', status: 502 });
    assert.deepEqual(await postClaim({ apiUrl: `${base}/big`, deviceId: DEVICE_ID, claimCode: CODE }), { ok: false, error: 'bad_response', status: 200 });
    assert.deepEqual(await postClaim({ apiUrl: `${base}/weird`, deviceId: DEVICE_ID, claimCode: CODE }), { ok: false, error: 'http_403', status: 403 });
  } finally {
    odd.closeAllConnections?.();
    await new Promise((r) => odd.close(r));
  }
  assert.deepEqual(await postClaim({ apiUrl: base, deviceId: DEVICE_ID, claimCode: CODE }), { ok: false, error: 'network', status: 0 });
});

test('HTTP-управление: стол до привязки, inject — 409 not_claimed, unclaim', async () => {
  const r = rig();
  r.dev.start();
  const control = await startControl({ devices: [r.dev], port: 0, log: createLogger({ write: () => {} }) });
  const base = `http://127.0.0.1:${control.port}`;
  const post = (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const t = await (await fetch(`${base}/sim/tables/101`)).json();
    assert.deepEqual([t.table, t.device_id, t.online, t.state, t.claim.state], [101, DEVICE_ID, false, null, 'waiting']);
    const inj = await post('/sim/tables/101/inject', { raw: '{}' });
    assert.deepEqual([inj.status, (await inj.json()).error], [409, 'not_claimed']);
    r.api.bind(DEVICE_ID, CODE);
    await r.sched.runNext();
    const claimed = await (await fetch(`${base}/sim/tables/101`)).json();
    assert.deepEqual([claimed.claim.state, claimed.state.mode], ['claimed', 'free']);
    assert.ok(!JSON.stringify(claimed).includes(CODE), 'код привязки наружу не отдаётся');
    const un = await (await post('/sim/tables/101/unclaim')).json();
    assert.deepEqual([un.ok, un.table.claim.state], [true, 'waiting']);
  } finally {
    await control.close();
    await r.dev.stop();
  }
});

// ——— Конфиг ———

test('конфиг --claim: без файла устройств, номера 101…, SIM_API_URL обязателен, CA брокера по умолчанию', () => {
  const ca = path.join(tmp, 'ca.crt');
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\n');
  const env = { SIM_API_URL: 'https://localhost:8443', MQTT_CA_FILE: ca, SIM_DEVICES_FILE: path.join(tmp, 'нет-такого.json') };
  const cfg = loadConfig({ env, argv: ['--claim', `BLD1:${DEVICE_ID}:${CODE}`, '--claim', `BLD1:${DEVICE_2}:${OTHER_CODE}`] });
  assert.equal(cfg.mode, 'claim');
  assert.deepEqual(cfg.claims.map((c) => [c.deviceId, c.table]), [[DEVICE_ID, 101], [DEVICE_2, 102]]);
  assert.deepEqual([cfg.devices, cfg.mqttUrl, cfg.tls, cfg.apiTls], [[], null, true, true]);
  assert.ok(cfg.ca.length > 0);

  const viaEnv = loadConfig({ env: { ...env, SIM_CLAIM: `BLD1:${DEVICE_ID}:${CODE}@5`, SIM_NVS_DIR: path.join(tmp, 'nvs') }, argv: [`--claim=BLD1:${DEVICE_2}:${OTHER_CODE}`] });
  assert.deepEqual(viaEnv.claims.map((c) => c.table), [5, 101]);
  assert.equal(viaEnv.claimDir, path.join(tmp, 'nvs'), 'ключи рядом с NVS, если SIM_CLAIM_DIR не задан');

  const err = (argv, e = env) => assert.throws(() => loadConfig({ env: e, argv }), ConfigError);
  err([`--claim`, `BLD1:${DEVICE_ID}:${CODE}`], { MQTT_CA_FILE: ca });
  err(['--claim', `BLD1:${DEVICE_ID}:${CODE}`, '--claim', `BLD1:${DEVICE_ID}:${OTHER_CODE}`]);
  err(['--claim', `BLD1:${DEVICE_ID}:${CODE}@3`, '--claim', `BLD1:${DEVICE_2}:${OTHER_CODE}@3`]);
  err(['--claim', `BLD1:${DEVICE_ID}:${CODE}`], { ...env, SIM_API_URL: 'ftp://x' });
  err(['--claim', `BLD1:${DEVICE_ID}:${CODE}`], { ...env, MQTT_CA_FILE: path.join(tmp, 'нет.crt') });
  assert.throws(() => loadConfig({ env, argv: ['--claim', `BLD1:${DEVICE_ID}:SHORT`] }), (e) => e instanceof ConfigError && !e.message.includes('SHORT'));
});
