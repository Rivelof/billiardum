// Стенд тестов light на настоящем Postgres (образ supabase/postgres): временная база со всеми
// миграциями и сидом, модуль sessions (init) с подделками MQTT, outbox-доставки, SSE и денег,
// поддельные часы и таймеры (ускоренное время), поддельные контроллеры по протоколу v1.
//
// Переменные (без них тесты пропускаются; .env не читается):
//   DATABASE_ADMIN_URL       — суперпользователь (supabase_admin), как у test:db core и CI;
//                              LIGHT_TEST_DB_URL — то же, но только для этих тестов (главнее)
//   LIGHT_TEST_APP_PASSWORD  — необязательно: вход app_api по паролю; без него пул работает
//                              под app_api (роль задаётся при подключении: те же права и RLS)

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { migrate, seed } from '../../../supabase/lib/db.mjs';
import { enqueue as coreEnqueue } from '../../outbox.mjs';
import { createLogger } from '../../lib/log.mjs';
import { verifyCommand } from '../../lib/protocol.mjs';
import { withContext } from '../../lib/store.mjs';
import { deviceKeyContext, encryptSecret } from '../../lib/secrets.mjs';
import { receiptStatus } from '../../payments/api.mjs';
import { init, stop } from '../../sessions/index.mjs';

export const ADMIN_URL = process.env.LIGHT_TEST_DB_URL || process.env.DATABASE_ADMIN_URL || '';
export const APP_PASSWORD = process.env.LIGHT_TEST_APP_PASSWORD ?? '';
export const SKIP = !ADMIN_URL ? 'нужен DATABASE_ADMIN_URL (или LIGHT_TEST_DB_URL): тестовый Postgres' : false;

export const CLUB = 'c1000000-0000-4000-8000-000000000001';
export const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
export const OWNER = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER = 'a1000000-0000-4000-8000-000000000003';
export const RECEPTION = 'a1000000-0000-4000-8000-000000000004';
export const INSTALLER = 'a1000000-0000-4000-8000-000000000009';
export const GUEST = (n) => `a5000000-0000-4000-8000-00000000000${n}`;
export const RES = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const DEV = (n) => `d1000000-0000-4000-8000-00000000000${n}`;
export const RES_B = 'e2000000-0000-4000-8000-000000000001';
export const DEV_B = 'd2000000-0000-4000-8000-000000000001';
/** 12:00 UTC = 17:00 в Екатеринбурге, четверг. */
export const START = Date.parse('2026-10-22T12:00:00.000Z');
export const MIN = 60_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withDb(url, name, { user, password } = {}) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  if (user) {
    u.username = user;
    u.password = encodeURIComponent(password);
  }
  return u.toString();
}

/** Временная база: все миграции, сид, ключи устройств, гости, второй клуб. */
export async function createTestDb() {
  const name = `light_t_${process.pid}_${randomBytes(3).toString('hex')}`;
  const adminUrl = withDb(ADMIN_URL, name);
  // CREATE DATABASE и миграция 0001 (роли кластера) — по очереди для параллельных файлов
  // тестов (рекомендательная блокировка в базе подключения, общая для процессов).
  const lock = new pg.Client({ connectionString: ADMIN_URL });
  await lock.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtextextended('bl.light_test_migrate', 0))");
    // Фоновые процессы образа (timescaledb) ненадолго подключаются к template1:
    // CREATE DATABASE тогда отвечает 55006 — повторяем.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await lock.query(`create database ${name} template template1`);
        break;
      } catch (err) {
        if (err.code !== '55006' || attempt >= 10) throw err;
        await sleep(500);
      }
    }
    await migrate({ connectionString: adminUrl, quiet: true });
    await seed({ connectionString: adminUrl, quiet: true });
  } finally {
    await lock.end();
  }
  const admin = new pg.Pool({ connectionString: adminUrl, max: 5 });
  admin.on('error', () => {});
  const app = APP_PASSWORD
    ? new pg.Pool({ connectionString: withDb(ADMIN_URL, name, { user: 'app_api', password: APP_PASSWORD }), max: 20 })
    : new pg.Pool({ connectionString: adminUrl, max: 20, options: '-c role=app_api' }); // роль с первого запроса
  app.on('error', () => {});
  const encKey = randomBytes(32);
  const keys = new Map();
  for (let n = 1; n <= 8; n += 1) {
    const key = randomBytes(32);
    keys.set(DEV(n), key);
    await admin.query('update bl.devices set device_key_enc = $2 where id = $1', [DEV(n), encryptSecret(key, encKey, deviceKeyContext(DEV(n)))]);
  }
  await admin.query(`
    insert into bl.users (id, phone) values
      ('${GUEST(1)}', '+70000000101'), ('${GUEST(2)}', '+70000000102'), ('${GUEST(3)}', '+70000000103'),
      ('${INSTALLER}', '+70000000109'), ('a2000000-0000-4000-8000-000000000002', '+70000000202');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB}', '${INSTALLER}', 'installer');
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_B}', 'Клуб Б', 'Владивосток', 'Asia/Vladivostok');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_B}', 'a2000000-0000-4000-8000-000000000002', 'owner');
    insert into bl.resources (id, club_id, type, number, title) values ('${RES_B}', '${CLUB_B}', 'billiard_pool', 1, 'Стол 1');
    insert into bl.devices (id, club_id, resource_id, mqtt_username) values ('${DEV_B}', '${CLUB_B}', '${RES_B}', '${DEV_B}');
  `);
  return {
    name,
    admin,
    app,
    encKey,
    keys,
    q: (sql, params) => admin.query(sql, params),
    async drop() {
      await app.end().catch(() => {});
      await admin.end().catch(() => {});
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}

/** Поддельные часы и таймеры: время идёт только в advance(). */
export class FakeTime {
  constructor(start = START) {
    this.t = start;
    this.seq = 0;
    this.queue = new Map();
    this.now = () => new Date(this.t);
    this.setTimeout = (fn, ms = 0) => {
      const id = { fake: (this.seq += 1) };
      this.queue.set(id, { at: this.t + Math.max(0, ms), fn, every: null });
      return id;
    };
    this.clearTimeout = (id) => this.queue.delete(id);
    this.setInterval = (fn, ms) => {
      const id = { fake: (this.seq += 1) };
      this.queue.set(id, { at: this.t + ms, fn, every: ms });
      return id;
    };
    this.clearInterval = (id) => this.queue.delete(id);
  }

  /**
   * Прыжок времени (сутки и больше): периодические таймеры сработают один раз после прыжка,
   * разовые — по очереди. Так 24 часа проходят без тысяч промежуточных state и обходов.
   */
  async jump(ms, settle = async () => {}) {
    this.t += ms;
    for (const x of this.queue.values()) if (x.every && x.at < this.t) x.at = this.t;
    await this.advance(0, settle);
  }

  /** Сдвинуть время, по очереди исполняя наступившие таймеры; settle — дождаться работы. */
  async advance(ms, settle = async () => {}) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
      for (const [id, x] of this.queue) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      const [id, x] = next;
      this.t = Math.max(this.t, x.at);
      if (x.every) x.at += x.every;
      else this.queue.delete(id);
      x.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

export class FakeMqtt extends EventEmitter {
  constructor() {
    super();
    this.connected = true;
    this.published = [];
    this.handlers = new Map();
  }

  publish(topic, payload, _opts, cb) {
    this.published.push({ topic, payload: String(payload) });
    cb?.();
    const h = this.handlers.get(topic);
    if (h) setImmediate(() => h(String(payload)));
  }

  subscribe(topics, _opts, cb) {
    cb?.(null, topics.map((topic) => ({ topic, qos: 1 })));
  }
}

const RUNNING = new Set(['active', 'ending', 'grace']);

/**
 * Поддельный контроллер стола: проверяет подпись и seq (protocol §3), исполняет команды
 * (§3.3) с локальным таймером по поддельным часам, отвечает ack и публикует state.
 */
export class FakeController {
  constructor({ client, bridge, time, deviceId, clubId, key, caps = ['relay', 'led', 'buzzer', 'current'] }) {
    Object.assign(this, { client, bridge, time, deviceId, clubId, key, caps });
    this.online = false;
    this.auto = true;
    this.boot = 1;
    this.bootId = randomBytes(4).toString('hex');
    this.n = 0;
    this.stateSeq = 0;
    this.saved = { seq: 0, id: null, ack: null };
    this.st = { mode: 'free', session_id: null, endAt: null, graceMs: 120_000, warn: [300_000, 60_000], until: null };
    this.received = [];
    this.dropped = [];
    this.acks = [];
    client.handlers.set(this.topic('cmd'), (p) => {
      this.work = (this.work ?? Promise.resolve()).then(() => this.onCmd(p));
    });
    this.timer = time.setInterval(() => {
      if (this.online) this.publishState().catch(() => {});
    }, 60_000);
  }

  topic(kind) {
    return `bl/v1/${this.clubId}/${this.deviceId}/${kind}`;
  }

  async send(kind, obj) {
    await this.bridge.onMessage(this.topic(kind), Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)));
  }

  /** Локальный автомат §5: active → ending → grace → free по своему таймеру. */
  refresh() {
    const s = this.st;
    const t = this.time.t;
    if (RUNNING.has(s.mode) && s.endAt !== null) {
      const rem = s.endAt - t;
      if (rem <= -s.graceMs) {
        if (!this.online) this.finishedOffline = s.session_id;
        Object.assign(s, { mode: 'free', session_id: null, endAt: null });
      } else if (rem <= 0) s.mode = 'grace';
      else if (rem <= s.warn[0]) s.mode = 'ending';
      else s.mode = 'active';
    }
    if (['service', 'pending', 'reserved'].includes(s.mode) && s.until !== null && t >= s.until) Object.assign(s, { mode: 'free', until: null });
  }

  stateMsg() {
    this.refresh();
    const s = this.st;
    this.stateSeq += 1;
    const running = RUNNING.has(s.mode);
    return {
      v: 1,
      state_seq: this.stateSeq,
      mode: s.mode,
      session_id: running ? s.session_id : null,
      remaining_ms: running ? Math.max(0, s.endAt - this.time.t) : s.mode === 'service' ? Math.max(0, s.until - this.time.t) : null,
      relay: running || s.mode === 'service',
      dim: running || s.mode === 'service' ? 100 : 0,
      led: 'off',
      buzzer: false,
      current_ma: 0,
      caps: this.caps,
      fw: '1.0.0-fake',
      boot: this.boot,
      rssi: -50,
      uptime_s: 100,
      last_seq: this.saved.seq,
    };
  }

  async publishState() {
    await this.send('state', this.stateMsg());
  }

  async connect() {
    this.refresh(); // доиграл без связи — запомнит finishedOffline
    this.online = true;
    await this.send('status', 'online');
    await this.publishState();
    if (this.finishedOffline) {
      const sid = this.finishedOffline;
      this.finishedOffline = null;
      await this.event('offline_session_finished', { session_id: sid, finished_uptime_ms: 1000 });
    }
  }

  async disconnect() {
    this.refresh();
    this.online = false;
    await this.send('status', 'offline');
  }

  async event(type, data = {}, { n } = {}) {
    if (n === undefined) this.n += 1;
    await this.send('event', { v: 1, boot: this.boot, boot_id: this.bootId, n: n ?? this.n, type, at_uptime_ms: 1000, data });
  }

  /** Перезагрузка: свет выключен, новый boot_id, ждём session.resume (правило 4). */
  async reboot() {
    this.boot += 1;
    this.bootId = randomBytes(4).toString('hex');
    this.n = 0;
    this.stateSeq = 0;
    Object.assign(this.st, { mode: 'free', session_id: null, endAt: null, until: null });
    this.online = true;
    await this.send('status', 'online');
    await this.publishState();
    await this.event('boot', { fw: '1.0.0-fake', caps: this.caps, reset_reason: 'sw' });
  }

  async ack(obj) {
    this.acks.push(obj);
    await this.send('ack', obj);
  }

  async onCmd(payload) {
    if (!this.online || !this.auto) {
      this.dropped.push(payload);
      return;
    }
    const v = verifyCommand(payload, this.key);
    if (v.result === 'bad_format') return this.ack({ v: 1, cmd_id: null, seq: null, ok: false, error: 'bad_format', state_seq: this.stateSeq });
    if (v.result === 'bad_sig') {
      await this.event('bad_sig', { cmd_id: v.cmd.id, seq: v.cmd.seq });
      return this.ack({ v: 1, cmd_id: v.cmd.id, seq: v.cmd.seq, ok: false, error: 'bad_sig', state_seq: this.stateSeq });
    }
    const cmd = v.cmd;
    if (cmd.seq === this.saved.seq && cmd.id === this.saved.id) return this.ack(this.saved.ack);
    if (cmd.seq <= this.saved.seq) {
      await this.event('replayed_seq', { cmd_id: cmd.id, seq: cmd.seq });
      return this.ack({ v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: false, error: 'replayed_seq', state_seq: this.stateSeq });
    }
    this.received.push(cmd);
    this.refresh();
    const s = this.st;
    const b = cmd.body;
    let error = null;
    switch (cmd.type) {
      case 'session.start':
      case 'session.resume':
        Object.assign(s, { mode: 'active', session_id: b.session_id, endAt: this.time.t + b.remaining_ms, graceMs: b.grace_ms ?? 120_000, warn: b.warn_ms ?? [300_000, 60_000], until: null });
        break;
      case 'session.extend':
        if (!RUNNING.has(s.mode) || s.session_id !== b.session_id) error = 'wrong_session';
        else s.endAt = this.time.t + b.remaining_ms;
        break;
      case 'session.stop':
        if (!RUNNING.has(s.mode) || s.session_id !== b.session_id) error = 'wrong_session';
        else Object.assign(s, { mode: 'free', session_id: null, endAt: null });
        break;
      case 'service.start':
        Object.assign(s, { mode: 'service', until: this.time.t + b.duration_ms });
        break;
      case 'service.stop':
        if (s.mode === 'service') Object.assign(s, { mode: 'free', until: null });
        break;
      case 'state.pending':
      case 'state.reserved':
        // Как прошивка и симулятор: во время сессии и сервиса — wrong_session.
        if (RUNNING.has(s.mode) || s.mode === 'service') error = 'wrong_session';
        else Object.assign(s, { mode: cmd.type.slice(6), until: this.time.t + b.until_ms });
        break;
      case 'state.free':
        Object.assign(s, { mode: 'free', session_id: null, endAt: null, until: null });
        break;
      case 'identify':
      case 'ping':
      case 'config.set':
        break;
      default:
        error = 'unknown_type';
    }
    this.refresh();
    const state = this.stateMsg();
    const ack = { v: 1, cmd_id: cmd.id, seq: cmd.seq, ok: error === null, error, state_seq: state.state_seq };
    this.saved = { seq: cmd.seq, id: cmd.id, ack };
    await this.send('state', state);
    await this.ack(ack);
  }

  get lit() {
    this.refresh();
    return RUNNING.has(this.st.mode) || this.st.mode === 'service';
  }
}

/** Выдача outbox без core-цикла: события пишутся в bl.outbox (core enqueue), доставка — вручную. */
export function fakeOutbox(pool, log) {
  const handlers = new Map();
  return {
    enqueue: coreEnqueue,
    subscribe(topic, handler, { name } = {}) {
      handlers.set(topic, { handler, name });
      return () => handlers.delete(topic);
    },
    async deliver(topic, payload) {
      const h = handlers.get(topic);
      if (!h) throw new Error(`нет подписчика ${topic}`);
      return withContext(pool, { clubId: payload.club_id ?? null, actorType: 'system' }, (db) => h.handler(payload, { db, log }));
    },
  };
}

/** Запустить модуль light на временной базе. */
export async function startLight(t, { devices = [1, 2, 3, 4], connect = true, time = new FakeTime(), extra = {} } = {}) {
  const lines = [];
  const log = createLogger({ level: 'debug', write: (l) => lines.push(l), now: time.now });
  const client = new FakeMqtt();
  const sse = { events: [], publish(channel, event, data) { this.events.push({ channel, event, data }); } };
  const refunds = [];
  // Возврат — подделка (ЮKassa нет); статусы чеков — настоящая функция money по bl.receipts.
  const paymentsApi = { async refund(_db, x) { refunds.push(x); return { ok: true }; }, receiptStatus };
  const dynsecCalls = [];
  const dynsec = {
    async ensureRole(rolename, acls) { dynsecCalls.push({ op: 'role', rolename, acls }); },
    async ensureClient(c) { dynsecCalls.push({ op: 'client', ...c }); },
  };
  const outbox = fakeOutbox(t.app, log);
  const ctx = {
    config: { encKey: t.encKey, mqtt: { url: 'mqtts://broker.test:8883' }, mqttPublicUrl: 'mqtts://dev.billiardum.test:8883' },
    log,
    pool: t.app,
    clock: { now: time.now },
    timers: time,
    outbox,
    sse,
    paymentsApi,
    mqttClient: client,
    dynsec,
    ...extra,
  };
  const st = await init(ctx);
  const ctl = new Map();
  for (const n of devices) {
    ctl.set(n, new FakeController({ client, bridge: st.bridge, time, deviceId: DEV(n), clubId: CLUB, key: t.keys.get(DEV(n)) }));
  }
  async function settle() {
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setImmediate(r));
      await Promise.all([...ctl.values()].map((c) => c.work));
      await st.bridge.idle();
      await st.scheduler.idle();
    }
  }
  const h = {
    st,
    ctx,
    time,
    client,
    sse,
    refunds,
    dynsecCalls,
    outbox,
    ctl,
    lines,
    settle,
    logs: (msg) => lines.map((l) => JSON.parse(l)).filter((l) => l.msg === msg),
    /** Подождать (реальное время), пока условие не станет истинным: LISTEN/NOTIFY асинхронен. */
    async until(fn, what = 'условие', timeoutMs = 4000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        await settle();
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`не дождались: ${what}`);
        await sleep(10);
      }
    },
    async advance(ms) {
      await time.advance(ms, settle);
      await sleep(30);
      await settle();
    },
    async jump(ms) {
      await time.jump(ms, settle);
      await sleep(30);
      await settle();
    },
    /** Транзакция как у маршрута: app_api, контекст пользователя (и клуба). */
    asUser(userId, fn, { clubId = null } = {}) {
      return withContext(t.app, { clubId, userId, actorType: 'user' }, fn);
    },
    asSystem(clubId, fn) {
      return withContext(t.app, { clubId, actorType: 'system' }, fn);
    },
    cmds: (n) => (ctl.get(n)?.received ?? []).map((c) => ({ type: c.type, body: c.body, seq: c.seq })),
    async stop() {
      await stop();
    },
  };
  if (connect) {
    for (const c of ctl.values()) await c.connect();
    // Актуальное состояние после выхода онлайн: state.free каждому столу.
    await h.until(() => [...ctl.values()].every((c) => c.received.length >= 1), 'state.free после онлайна');
  }
  return h;
}

/** Платёж в bl.payments (money) и payload события payment.confirmed. */
export async function makePayment(t, { kind = 'start', resource = 1, user = GUEST(1), sessionId = null, minutes = 60, amount = 80_000, method = 'sbp', unlimited = false, at = new Date(START) }) {
  const id = randomUUID();
  await t.q(
    `insert into bl.payments (id, club_id, resource_id, user_id, session_id, kind, provider, method, provider_payment_id, idempotence_key,
                              status, amount_kopecks, minutes, unlimited, capture, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'succeeded', $11, $12, $13, $14, $15)`,
    [
      id,
      CLUB,
      RES(resource),
      user,
      sessionId,
      kind,
      ['cash', 'card_terminal'].includes(method) ? 'reception' : 'yookassa',
      method,
      ['cash', 'card_terminal'].includes(method) ? null : `yk-${randomUUID()}`,
      randomUUID(),
      amount,
      minutes,
      unlimited,
      !(unlimited && method === 'card'),
      at,
    ],
  );
  return {
    payment_id: id,
    club_id: CLUB,
    quote_id: null,
    kind,
    session_id: sessionId,
    resource_id: RES(resource),
    user_id: user,
    minutes: minutes,
    unlimited,
    amount_kopecks: amount,
    method,
  };
}
