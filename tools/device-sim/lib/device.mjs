// Один виртуальный стол: TableMachine + подключение MQTT по протоколу §2.
// client id и логин — device_id, Last Will `offline` (retained, QoS 1) в `status`,
// после подписки на `cmd` — `online` (retained) и `state`, затем досылка событий.

import mqtt from 'mqtt';
import { TableMachine } from './machine.mjs';
import { RealClock } from './clock.mjs';
import { MemoryNvs } from './nvs.mjs';
import { FAULTS_IMPLEMENTED_IN, FaultFlags } from './faults.mjs';

export const KEEPALIVE_S = 30;
export const RECONNECT_MS = 3000;

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

export class SimDevice {
  #cfg;
  #log;
  #clock;
  #nvs;
  #connect;
  #client = null;
  #machine = null;
  #topics;
  #faults;
  #ready = false; // подписаны на cmd и объявили online
  #wasConnected = false;
  #stopping = false;
  #lastError = null; // одинаковые ошибки переподключения пишем в лог один раз
  #inflight = new Set();

  /**
   * @param {{
   *   device: { deviceId: string, clubId: string, table: number, mqttUsername: string | null, mqttPassword: string, deviceKey: Buffer },
   *   mqttUrl: string, ca?: Buffer | null, caps?: string[], faults?: { name: string, table: number | null }[],
   *   log: object, clock?: object, nvs?: object, connect?: typeof mqtt.connect, reconnectMs?: number,
   * }} options
   */
  constructor(options) {
    this.#cfg = options;
    this.#clock = options.clock ?? new RealClock();
    this.#nvs = options.nvs ?? new MemoryNvs();
    this.#connect = options.connect ?? mqtt.connect;
    const { deviceId, clubId, table } = options.device;
    this.#topics = topicsFor(clubId, deviceId);
    this.#log = options.log.child({ device_id: deviceId, table });
    this.#faults = new FaultFlags(options.faults ?? [], table);
  }

  get machine() {
    return this.#machine;
  }

  get topics() {
    return this.#topics;
  }

  start() {
    const { device } = this.#cfg;
    for (const name of this.#faults.names) {
      this.#log.warn('sim_fault_not_implemented', { fault: name, until: FAULTS_IMPLEMENTED_IN });
    }
    if (device.mqttUsername && device.mqttUsername !== device.deviceId) {
      this.#log.warn('mqtt_username_mismatch', { note: 'логин MQTT = device_id (протокол §2), mqtt_username из файла не используется' });
    }

    this.#machine = new TableMachine({
      deviceKey: device.deviceKey,
      clock: this.#clock,
      nvs: this.#nvs,
      caps: this.#cfg.caps,
      output: (msg) => this.#onOutput(msg),
    });
    this.#machine.start({ resetReason: 'power_on' });

    const url = this.#cfg.mqttUrl;
    const tls = url.startsWith('mqtts:');
    this.#client = this.#connect(url, {
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

    this.#client.on('connect', () => this.#onConnect());
    this.#client.on('message', (topic, payload) => {
      if (topic !== this.#topics.cmd) return;
      this.#machine.handleCommand(payload);
    });
    this.#client.on('close', () => {
      this.#ready = false;
      if (this.#wasConnected && !this.#stopping) this.#log.warn('mqtt_disconnected');
      this.#wasConnected = false;
    });
    this.#client.on('error', (err) => {
      if (err.message === this.#lastError) return;
      this.#lastError = err.message;
      this.#log.warn('mqtt_error', { code: err.code ?? null, error: err.message });
    });
  }

  async stop() {
    this.#stopping = true;
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

  #onConnect() {
    this.#wasConnected = true;
    this.#lastError = null;
    this.#inflight.clear();
    this.#log.info('mqtt_connected');
    this.#client.subscribe(this.#topics.cmd, { qos: 1 }, (err, granted) => {
      if (err || !granted?.length || granted[0].qos === 128) {
        this.#log.error('mqtt_subscribe_failed', { topic: 'cmd' });
        return;
      }
      this.#ready = true;
      this.#publish(this.#topics.status, 'online', true);
      this.#machine.publishState();
      this.#flushEvents();
    });
  }

  #publish(topic, payload, retain, done) {
    this.#client.publish(topic, payload, { qos: 1, retain }, (err) => {
      if (err) this.#log.warn('mqtt_publish_failed', { topic: topic.slice(this.#topics.prefix.length), error: err.message });
      done?.(err);
    });
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
      case 'ack':
        // M1: здесь режим slow-ack задержит ответ.
        if (this.#client) this.#publish(this.#topics.ack, msg.payload, false);
        break;
      case 'event':
        this.#log.debug('sim_event', { type: msg.entry.type, boot: msg.entry.boot, n: msg.entry.n });
        this.#flushEvents();
        break;
      case 'command': {
        const { info } = msg;
        const level = ['ok', 'resend'].includes(info.result) ? 'info' : 'warn';
        this.#log[level]('sim_cmd', {
          type: info.type, seq: info.seq, cmd_id: info.cmd_id, result: info.result, ...(info.reason ? { reason: info.reason } : {}),
        });
        break;
      }
      default:
        break;
    }
  }

  // Досылка событий из кольцевого буфера; из буфера событие уходит после PUBACK.
  #flushEvents() {
    if (!this.#ready) return;
    for (const entry of this.#machine.pendingEvents()) {
      const key = `${entry.boot}:${entry.n}`;
      if (this.#inflight.has(key)) continue;
      this.#inflight.add(key);
      this.#publish(this.#topics.event, entry.payload, false, (err) => {
        this.#inflight.delete(key);
        if (!err) this.#machine.eventDelivered(entry.boot, entry.n);
      });
    }
  }
}
