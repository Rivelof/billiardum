// Один виртуальный стол: TableMachine + подключение MQTT по протоколу §2.
// client id и логин — device_id, Last Will `offline` (retained, QoS 1) в `status`,
// после подписки на `cmd` — `online` (retained) и `state`, затем досылка событий.
// Режимы сбоя (lib/faults.mjs): обрыв связи, перезагрузка, свет в обход, неисправная лампа,
// медленный ack, повтор старой команды. Управляются флагами CLI и lib/control.mjs.

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import mqtt from 'mqtt';
import { TableMachine } from './machine.mjs';
import { RealClock } from './clock.mjs';
import { FileNvs, MemoryNvs, NVS_KEYS } from './nvs.mjs';
import { FAULTS, FAULT_DEFAULT_MS, MAX_FAULT_MS, FaultFlags } from './faults.mjs';
import { simSensor } from './scenario.mjs';

export const KEEPALIVE_S = 30;
export const RECONNECT_MS = 3000;
const REPLAY_KEEP = 32; // сколько принятых команд помнить для replay-old

export function topicsFor(clubId, deviceId) {
  const prefix = `bl/v1/${clubId}/${deviceId}/`;
  return {
    prefix,
    cmd: `${prefix}cmd`,
    ack: `${prefix}ack`,
    state: `${prefix}state`,
    event: `${prefix}event`,
    status: `${prefix}status`,
  };
}

export class FaultError extends Error {}

export class SimDevice {
  #cfg;
  #log;
  #clock;
  #nvs;
  #connect;
  #client = null;
  #gen = 0; // поколение клиента MQTT: события старого клиента после обрыва не учитываются
  #machine = null;
  #topics;
  #flags;
  #ready = false; // подписаны на cmd и объявили online
  #wasConnected = false;
  #stopping = false;
  #powered = false;
  #netUp = true;
  #lastError = null; // одинаковые ошибки переподключения пишем в лог один раз
  #inflight = new Set();
  #faults = { bypass: false, lampFault: false, slowAckMs: 0, replayOld: false, replayMs: 1000 };
  #timers = new Map(); // имя → таймер снятия сбоя или отложенного действия
  #accepted = []; // [{ raw, seq, type }] принятые команды — для replay-old
  #currentRaw = null;
  #cmdAt = null; // performance.now() при получении команды — метрика cmd → relay

  /**
   * @param {{
   *   device: { deviceId: string, clubId: string, table: number, mqttUsername: string | null, mqttPassword: string, deviceKey: Buffer },
   *   mqttUrl: string, ca?: Buffer | null, caps?: string[], faults?: { name: string, table: number | null, ms: number | null }[],
   *   log: object, clock?: object, nvs?: object, nvsDir?: string | null, connect?: typeof mqtt.connect, reconnectMs?: number,
   * }} options
   */
  constructor(options) {
    this.#cfg = options;
    this.#clock = options.clock ?? new RealClock();
    const { deviceId, clubId, table } = options.device;
    this.#nvs = options.nvs ?? (options.nvsDir ? new FileNvs(options.nvsDir, deviceId) : new MemoryNvs());
    this.#connect = options.connect ?? mqtt.connect;
    this.#topics = topicsFor(clubId, deviceId);
    this.#log = options.log.child({ device_id: deviceId, table });
    this.#flags = new FaultFlags(options.faults ?? [], table);
  }

  get machine() {
    return this.#machine;
  }

  get topics() {
    return this.#topics;
  }

  get table() {
    return this.#cfg.device.table;
  }

  start() {
    const { device } = this.#cfg;
    if (device.mqttUsername && device.mqttUsername !== device.deviceId) {
      this.#log.warn('mqtt_username_mismatch', { note: 'логин MQTT = device_id (протокол §2), mqtt_username из файла не используется' });
    }
    this.#checkBinding();
    this.#powerOn('poweron');
    for (const { name, ms } of this.#flags.list) this.#applyStartupFault(name, ms);
  }

  async stop() {
    this.#stopping = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    this.#machine?.stop();
    const client = this.#client;
    if (!client) return;
    // Настоящий контроллер не выключается штатно; при остановке симулятора
    // объявляем offline сами — после DISCONNECT брокер Last Will не публикует.
    if (client.connected) {
      try {
        await client.publishAsync(this.#topics.status, 'offline', { qos: 1, retain: true });
      } catch {
        // брокер недоступен — Last Will опубликует он сам
      }
    }
    await client.endAsync();
  }

  /** Состояние стола для GET /sim/tables. */
  status() {
    const m = this.#machine;
    return {
      table: this.table,
      device_id: this.#cfg.device.deviceId,
      club_id: this.#cfg.device.clubId,
      powered: this.#powered,
      online: this.#ready,
      net_up: this.#netUp,
      faults: {
        bypass: this.#faults.bypass,
        'lamp-fault': this.#faults.lampFault,
        'slow-ack': this.#faults.slowAckMs,
        'replay-old': this.#faults.replayOld,
      },
      state: m && this.#powered ? m.snapshot() : null,
      lamp: m && this.#powered ? m.lamp : false,
      signals: m ? m.signals : null,
      boot_waiting: m ? m.bootWaiting : false,
      nvs_session: m ? m.nvsSession : null,
      config: m ? m.config : null,
      outbox: m ? m.outbox().map((e) => ({ type: e.type, boot_id: e.boot_id, n: e.n })) : [],
    };
  }

  /**
   * Включить или снять сбой. ms — длительность (bypass, lamp-fault, net-drop), задержка (slow-ack, replay-old)
   * или время выключения питания (reboot).
   * @returns {object} что сделано
   */
  setFault(name, on, ms = null) {
    if (!Object.hasOwn(FAULTS, name)) throw new FaultError('unknown_fault');
    if (typeof on !== 'boolean') throw new FaultError('bad_on');
    if (ms !== null && !(Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_FAULT_MS)) throw new FaultError('bad_ms');
    this.#clearTimer(name);
    const result = { fault: name, on };
    switch (name) {
      case 'bypass':
      case 'lamp-fault':
        if (name === 'bypass') this.#faults.bypass = on;
        else this.#faults.lampFault = on;
        if (this.#powered) this.#machine.sensorChanged();
        if (on && ms !== null) this.#setTimer(name, ms, () => this.setFault(name, false));
        break;
      case 'net-drop':
        this.setNet(!on);
        if (on && ms !== null) this.#setTimer(name, ms, () => this.setNet(true));
        break;
      case 'slow-ack':
        this.#faults.slowAckMs = on ? (ms ?? FAULT_DEFAULT_MS['slow-ack']) : 0;
        break;
      case 'replay-old':
        this.#faults.replayOld = on;
        this.#faults.replayMs = ms ?? FAULT_DEFAULT_MS['replay-old'];
        if (on) result.replayed = this.replayOld();
        break;
      case 'reboot':
        if (on) this.reboot({ downMs: ms ?? 0 });
        break;
      default:
        break;
    }
    this.#log.info('sim_fault', { fault: name, on, ...(ms !== null ? { ms } : {}) });
    return result;
  }

  /** Связь с брокером: false — обрыв без DISCONNECT (Last Will), true — подключиться снова. */
  setNet(up) {
    if (typeof up !== 'boolean') throw new FaultError('bad_up');
    if (up === this.#netUp) return;
    this.#netUp = up;
    this.#log.warn('sim_net', { up });
    if (!up) this.#dropMqtt();
    else if (this.#powered) this.#connectMqtt();
  }

  /**
   * Перезагрузка: питание пропадает (свет гаснет, связь рвётся без DISCONNECT), через downMs
   * контроллер загружается с тем же NVS — правило 4 §5.
   */
  reboot({ downMs = 0, resetReason = 'poweron' } = {}) {
    if (!Number.isSafeInteger(downMs) || downMs < 0 || downMs > MAX_FAULT_MS) throw new FaultError('bad_ms');
    this.#log.warn('sim_reboot', { down_ms: downMs, reset_reason: resetReason });
    this.#powerOff();
    this.#setTimer('power', downMs, () => this.#powerOn(resetReason));
  }

  /**
   * Подаёт себе ранее принятую команду с seq меньше последнего (лучше session.extend) — как атакующий,
   * записавший старую команду. Ответ уходит в `ack`, событие replayed_seq — в `event`.
   */
  replayOld() {
    if (!this.#powered) return null;
    const last = this.#machine.snapshot().last_seq;
    const older = this.#accepted.filter((c) => c.seq < last);
    const pick = older.findLast((c) => c.type === 'session.extend') ?? older.at(-1);
    if (!pick) {
      this.#log.warn('sim_replay_old', { result: 'nothing_to_replay' });
      return { result: 'nothing_to_replay' };
    }
    const res = this.#feed(pick.raw, { replay: true });
    this.#log.warn('sim_replay_old', { seq: pick.seq, type: pick.type, result: res.result });
    return { seq: pick.seq, type: pick.type, result: res.result };
  }

  // Новый device_key (перепривязка, §7): контроллер обнуляет seq, id и ack; сессия и
  // недоставленные события старой привязки тоже стираются. Счётчик загрузок остаётся.
  #checkBinding() {
    const bind = createHash('sha256').update(this.#cfg.device.deviceKey).digest('hex').slice(0, 16);
    const saved = this.#nvs.get(NVS_KEYS.binding);
    if (saved === bind) return;
    if (saved !== undefined) {
      for (const key of this.#nvs.keys()) {
        if (key !== NVS_KEYS.boot && key !== NVS_KEYS.config) this.#nvs.delete(key);
      }
      this.#log.warn('sim_rebind', { note: 'новый device_key: seq, id, ack и сессия сброшены (§7)' });
    }
    this.#nvs.set(NVS_KEYS.binding, bind);
  }

  // ——— Питание и связь ———

  #powerOn(resetReason) {
    const { device } = this.#cfg;
    this.#machine = new TableMachine({
      deviceKey: device.deviceKey,
      clock: this.#clock,
      nvs: this.#nvs,
      caps: this.#cfg.caps,
      output: (msg) => this.#onOutput(msg),
      sensor: simSensor(this.#faults),
    });
    this.#powered = true;
    this.#machine.start({ resetReason });
    if (this.#netUp) this.#connectMqtt();
  }

  #powerOff() {
    this.#powered = false;
    this.#machine?.stop();
    this.#machine?.setOnline(false);
    this.#dropMqtt();
    this.#clearTimer('power');
  }

  #connectMqtt() {
    if (this.#client || this.#stopping) return;
    const { device } = this.#cfg;
    const url = this.#cfg.mqttUrl;
    const tls = url.startsWith('mqtts:');
    const gen = ++this.#gen;
    const client = this.#connect(url, {
      protocolVersion: 4, // MQTT 3.1.1
      clientId: device.deviceId,
      username: device.deviceId,
      password: device.mqttPassword,
      clean: true,
      resubscribe: false, // подписка — в #onConnect, после SUBACK объявляем online
      keepalive: KEEPALIVE_S,
      reconnectPeriod: this.#cfg.reconnectMs ?? RECONNECT_MS,
      connectTimeout: 10_000,
      will: { topic: this.#topics.status, payload: Buffer.from('offline'), qos: 1, retain: true },
      ...(tls ? { ca: this.#cfg.ca ?? undefined, rejectUnauthorized: true } : {}),
    });
    this.#client = client;
    const live = () => gen === this.#gen && this.#powered;

    client.on('connect', () => live() && this.#onConnect(client));
    client.on('message', (topic, payload) => {
      if (!live() || topic !== this.#topics.cmd) return;
      this.#feed(payload);
    });
    client.on('close', () => {
      if (gen !== this.#gen) return;
      this.#ready = false;
      this.#machine?.setOnline(false);
      if (this.#wasConnected && !this.#stopping) this.#log.warn('mqtt_disconnected');
      this.#wasConnected = false;
    });
    client.on('error', (err) => {
      if (gen !== this.#gen || err.message === this.#lastError) return;
      this.#lastError = err.message;
      this.#log.warn('mqtt_error', { code: err.code ?? null, error: err.message });
    });
  }

  // Обрыв без DISCONNECT: end(true) закрывает сокет сразу, брокер публикует Last Will.
  #dropMqtt() {
    const client = this.#client;
    if (!client) return;
    this.#gen += 1;
    this.#client = null;
    this.#ready = false;
    this.#wasConnected = false;
    this.#inflight.clear();
    this.#machine?.setOnline(false);
    client.end(true);
  }

  #onConnect(client) {
    this.#wasConnected = true;
    this.#lastError = null;
    this.#inflight.clear();
    this.#log.info('mqtt_connected');
    client.subscribe(this.#topics.cmd, { qos: 1 }, (err, granted) => {
      if (client !== this.#client) return;
      if (err || !granted?.length || granted[0].qos === 128) {
        this.#log.error('mqtt_subscribe_failed', { topic: 'cmd' });
        return;
      }
      this.#ready = true;
      this.#machine.setOnline(true);
      this.#publish(this.#topics.status, 'online', true);
      this.#machine.publishState();
      this.#flushEvents();
    });
  }

  #publish(topic, payload, retain, done) {
    const client = this.#client;
    if (!client) {
      done?.(new Error('нет связи'));
      return;
    }
    client.publish(topic, payload, { qos: 1, retain }, (err) => {
      if (err && client === this.#client) this.#log.warn('mqtt_publish_failed', { topic: topic.slice(this.#topics.prefix.length), error: err.message });
      done?.(err);
    });
  }

  // ——— Команды ———

  #feed(payload, { replay = false } = {}) {
    this.#currentRaw = Buffer.from(payload);
    this.#cmdAt = performance.now();
    const res = this.#machine.handleCommand(payload);
    this.#currentRaw = null;
    this.#cmdAt = null;
    if (!replay && this.#faults.replayOld && ['ok', 'bad_body', 'unknown_type', 'wrong_session', 'busy_ota', 'hw_fault'].includes(res.result)) {
      this.#setTimer('replay-old', this.#faults.replayMs, () => this.replayOld());
    }
    return res;
  }

  #onOutput(msg) {
    switch (msg.kind) {
      case 'state': {
        if (msg.changed) {
          const s = msg.state;
          this.#log.info('sim_state', {
            mode: s.mode, relay: s.relay, dim: s.dim, led: s.led, buzzer: s.buzzer, remaining_ms: s.remaining_ms,
          });
        }
        if (this.#ready) this.#publish(this.#topics.state, msg.payload, true);
        break;
      }
      case 'ack': {
        const delay = this.#faults.slowAckMs;
        if (delay > 0) {
          this.#log.info('sim_slow_ack', { cmd_id: msg.cmd_id, delay_ms: delay });
          setTimeout(() => this.#publish(this.#topics.ack, msg.payload, false), delay).unref?.();
        } else {
          this.#publish(this.#topics.ack, msg.payload, false);
        }
        break;
      }
      case 'event':
        this.#log.debug('sim_event', { type: msg.entry.type, boot_id: msg.entry.boot_id, n: msg.entry.n });
        this.#flushEvents();
        break;
      case 'command': {
        const { info } = msg;
        const level = ['ok', 'resend'].includes(info.result) ? 'info' : 'warn';
        this.#log[level]('sim_cmd', {
          type: info.type, seq: info.seq, cmd_id: info.cmd_id, result: info.result, ...(info.reason ? { reason: info.reason } : {}),
        });
        if (this.#currentRaw && !['bad_format', 'bad_sig', 'replayed_seq', 'resend'].includes(info.result)) {
          this.#accepted.push({ raw: this.#currentRaw, seq: info.seq, type: info.type });
          if (this.#accepted.length > REPLAY_KEEP) this.#accepted.shift();
        }
        break;
      }
      case 'relay':
        // Метрика M1: от получения команды до включения реле (p95 < 1 с от оплаты до света).
        this.#log.info('sim_relay', {
          relay: true, cmd_id: msg.cmd_id, type: msg.type,
          ms_since_cmd: this.#cmdAt === null ? null : Number((performance.now() - this.#cmdAt).toFixed(3)),
        });
        break;
      case 'signal':
        this.#log.info('sim_signal', { signal: msg.name, beeps: msg.beeps });
        break;
      case 'ota': {
        // Загрузки в симуляторе нет: проверка полей и busy_ota — в автомате, итог — сразу ota_failed.
        const machine = this.#machine;
        this.#log.warn('sim_ota', { version: msg.version, result: 'sim_unsupported' });
        setImmediate(() => machine === this.#machine && this.#powered && machine.otaResult(false, msg.version, 'sim_unsupported'));
        break;
      }
      default:
        break;
    }
  }

  // Досылка событий из кольцевого буфера; из буфера событие уходит после PUBACK.
  #flushEvents() {
    if (!this.#ready) return;
    for (const entry of this.#machine.outbox()) {
      const key = `${entry.boot_id}:${entry.n}`;
      if (this.#inflight.has(key)) continue;
      this.#inflight.add(key);
      const machine = this.#machine;
      this.#publish(this.#topics.event, entry.payload, false, (err) => {
        this.#inflight.delete(key);
        if (!err && machine === this.#machine) machine.eventDelivered(entry.boot_id, entry.n);
      });
    }
  }

  // ——— Сбои из флагов CLI ———

  #applyStartupFault(name, ms) {
    const dflt = FAULT_DEFAULT_MS[name];
    switch (name) {
      case 'net-drop':
        this.setFault('net-drop', true, ms ?? dflt);
        break;
      case 'reboot':
        this.#setTimer('reboot-at', ms ?? dflt, () => this.reboot({ downMs: 0 }));
        this.#log.info('sim_fault', { fault: name, on: true, at_ms: ms ?? dflt });
        break;
      default:
        this.setFault(name, true, ms ?? dflt);
        break;
    }
  }

  #setTimer(name, ms, fn) {
    this.#clearTimer(name);
    const t = setTimeout(() => {
      this.#timers.delete(name);
      if (!this.#stopping) fn();
    }, ms);
    this.#timers.set(name, t);
  }

  #clearTimer(name) {
    const t = this.#timers.get(name);
    if (t) clearTimeout(t);
    this.#timers.delete(name);
  }
}
