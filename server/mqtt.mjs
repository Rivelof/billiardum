// Мост MQTT (контракт M0 §6, docs/protocol.md §2, §6) — единственный, кто публикует в cmd.
//
// * Подписка на bl/v1/+/+/{state,status,event,ack}. Устройство и его клуб — по device_id
//   из базы (bl.device_club), club_id из топика не доверяем: расхождение — журнал и тревога.
// * Онлайн: status = online и получен state. Офлайн: status = offline или нет state 150 с.
// * Устройству, ставшему онлайн, — ping: seq и журнал в одной транзакции, публикация после
//   коммита, повтор с тем же id и seq каждые 3 с до 5 раз, затем тревога cmd_no_ack.
// * Логи — JSON без персональных данных: devices_online, cmd_ack и др.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { buildCommand, deviceTopic, parseDeviceTopic, PROTOCOL_VERSION } from './lib/protocol.mjs';
import { decryptSecret, deviceKeyContext } from './lib/secrets.mjs';

export const OFFLINE_AFTER_MS = 150_000;
export const RETRY_MS = 3_000;
export const MAX_RETRIES = 5;
export const REPORT_EVERY_MS = 60_000;
export const SWEEP_EVERY_MS = 5_000;
export const UNKNOWN_RECHECK_MS = 60_000;
export const TOUCH_EVERY_MS = 60_000;
export const MAX_PAYLOAD_BYTES = 16 * 1024;
export const SUBSCRIPTIONS = ['state', 'status', 'event', 'ack'].map((kind) => `bl/v1/+/+/${kind}`);

const CODE = /^[a-z][a-z0-9_.]{0,39}$/;
const KNOWN_CAPS = new Set(['relay', 'led', 'buzzer', 'current', 'dimmer']);

function parseJsonObject(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const code = (value) => (typeof value === 'string' && CODE.test(value) ? value : null);
const safeInt = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/**
 * Мост без сетевых зависимостей: клиент MQTT, хранилище и таймеры передаются снаружи
 * (в тестах — подделки).
 */
export function createBridge({
  client,
  store,
  encKey,
  log,
  now = Date.now,
  timers = globalThis,
  offlineAfterMs = OFFLINE_AFTER_MS,
  retryMs = RETRY_MS,
  maxRetries = MAX_RETRIES,
  reportEveryMs = REPORT_EVERY_MS,
  sweepEveryMs = SWEEP_EVERY_MS,
}) {
  /** @type {Map<string, any>} */
  const devices = new Map();
  /** @type {Map<string, any>} */
  const pending = new Map();
  const intervals = [];
  let total = null;
  let lastReport = null;
  let connected = false;
  let stopped = false;

  function onlineCount() {
    let n = 0;
    for (const d of devices.values()) if (d.online) n += 1;
    return n;
  }

  function report(force = false) {
    const online = onlineCount();
    const t = total ?? 0;
    if (!force && lastReport && lastReport.online === online && lastReport.total === t) return;
    lastReport = { online, total: t };
    log.info('devices_online', { online, total: t });
  }

  async function refreshTotal({ quiet = false } = {}) {
    try {
      total = await store.deviceTotal();
      if (!quiet) report();
    } catch (err) {
      log.error('db_error', { op: 'device_total', error: err.message });
    }
  }

  function record(deviceId) {
    let d = devices.get(deviceId);
    if (!d) {
      d = {
        id: deviceId,
        clubId: undefined,
        resolvedAt: 0,
        status: null,
        lastStateAt: null,
        online: false,
        reportedLastSeq: null,
        fw: null,
        caps: null,
        touchedAt: 0,
        queue: Promise.resolve(),
        unknownLogged: false,
        mismatchLogged: new Set(),
      };
      devices.set(deviceId, d);
    }
    return d;
  }

  async function ensureKnown(d, topicClubId) {
    if (d.clubId === undefined || (d.clubId === null && now() - d.resolvedAt >= UNKNOWN_RECHECK_MS)) {
      d.clubId = await store.deviceClub(d.id);
      d.resolvedAt = now();
      if (d.clubId !== null) d.unknownLogged = false;
    }
    if (d.clubId === null) {
      if (!d.unknownLogged) {
        d.unknownLogged = true;
        log.warn('device_unknown', { device_id: d.id });
      }
      return false;
    }
    if (topicClubId !== d.clubId) {
      if (!d.mismatchLogged.has(topicClubId)) {
        d.mismatchLogged.add(topicClubId);
        log.error('device_club_mismatch', { device_id: d.id, club_id: d.clubId, topic_club_id: topicClubId });
        try {
          await store.auditDevice({
            clubId: d.clubId,
            deviceId: d.id,
            action: 'device.topic_mismatch',
            data: { topic_club_id: topicClubId },
          });
        } catch (err) {
          log.error('db_error', { op: 'audit_mismatch', device_id: d.id, error: err.message });
        }
      }
      return false;
    }
    return true;
  }

  async function evaluate(d, reason) {
    const shouldBeOnline = d.status === 'online' && d.lastStateAt !== null && now() - d.lastStateAt <= offlineAfterMs;
    if (shouldBeOnline && !d.online) {
      d.online = true;
      log.info('device_online', { device_id: d.id });
      report();
      await sendCommand(d, 'ping', {});
    } else if (!shouldBeOnline && d.online) {
      d.online = false;
      log.info('device_offline', { device_id: d.id, reason });
      report();
    }
  }

  function publish(entry) {
    client.publish(entry.topic, entry.payload, { qos: 1, retain: false }, (err) => {
      if (err) log.warn('cmd_publish_failed', { device_id: entry.deviceId, type: entry.type, seq: entry.seq, error: err.message });
    });
  }

  function scheduleRetry(entry) {
    entry.timer = timers.setTimeout(() => {
      if (stopped || pending.get(entry.cmdId) !== entry) return;
      if (entry.retries >= maxRetries) {
        pending.delete(entry.cmdId);
        // Тревога «контроллер не отвечает» (protocol §6). Уведомление владельцу — M1.
        log.error('cmd_no_ack', {
          device_id: entry.deviceId,
          type: entry.type,
          seq: entry.seq,
          attempts: entry.retries + 1,
          alarm: 'controller_not_responding',
        });
        return;
      }
      entry.retries += 1;
      log.debug('cmd_retry', { device_id: entry.deviceId, type: entry.type, seq: entry.seq, retry: entry.retries });
      publish(entry);
      scheduleRetry(entry);
    }, retryMs);
  }

  /** Команда устройству: журнал и seq в базе → публикация после коммита → повторы. */
  async function sendCommand(d, type, body) {
    const cmdId = randomUUID();
    let result;
    try {
      result = await store.allocateCommand({
        clubId: d.clubId,
        deviceId: d.id,
        cmdId,
        type,
        minSeq: d.reportedLastSeq,
        build: ({ seq, keyEnc }) => {
          const key = decryptSecret(keyEnc, encKey, deviceKeyContext(d.id));
          return buildCommand({ id: cmdId, seq, type, body, issuedAt: Math.floor(now() / 1000) }, key).payload;
        },
      });
    } catch (err) {
      log.error('cmd_failed', { device_id: d.id, type, error: err.message });
      return null;
    }
    if (result.status !== 'ok') {
      log.warn('cmd_skipped', { device_id: d.id, type, reason: result.status });
      return null;
    }
    const entry = {
      cmdId,
      deviceId: d.id,
      clubId: d.clubId,
      seq: result.seq,
      type,
      topic: deviceTopic(d.clubId, d.id, 'cmd'),
      payload: result.payload,
      retries: 0,
      timer: null,
    };
    pending.set(cmdId, entry);
    log.debug('cmd_sent', { device_id: d.id, type, seq: entry.seq });
    publish(entry);
    scheduleRetry(entry);
    return entry;
  }

  function handleAck(d, payload) {
    const ack = parseJsonObject(payload);
    if (!ack || ack.v !== PROTOCOL_VERSION || typeof ack.cmd_id !== 'string') {
      log.warn('ack_bad_format', { device_id: d.id });
      return;
    }
    const entry = pending.get(ack.cmd_id);
    if (!entry || entry.deviceId !== d.id) {
      log.debug('ack_unmatched', { device_id: d.id });
      return;
    }
    timers.clearTimeout(entry.timer);
    pending.delete(ack.cmd_id);
    if (ack.seq !== entry.seq) log.warn('ack_seq_mismatch', { device_id: d.id, type: entry.type, seq: entry.seq });
    const ok = ack.ok === true;
    const fields = { device_id: d.id, type: entry.type, seq: entry.seq, ok };
    if (ok) {
      log.info('cmd_ack', fields);
    } else {
      log.warn('cmd_ack', { ...fields, error: code(ack.error) ?? 'unknown' });
    }
  }

  async function handleState(d, payload) {
    const state = parseJsonObject(payload);
    if (!state || state.v !== PROTOCOL_VERSION) {
      log.warn('state_bad_format', { device_id: d.id });
      return;
    }
    d.lastStateAt = now();
    const lastSeq = safeInt(state.last_seq);
    if (lastSeq !== null) d.reportedLastSeq = lastSeq;
    const fw = typeof state.fw === 'string' && /^[0-9A-Za-z.+_-]{1,50}$/.test(state.fw) ? state.fw : null;
    const caps = Array.isArray(state.caps) ? state.caps.filter((c) => KNOWN_CAPS.has(c)).sort() : null;
    const changed = fw !== d.fw || JSON.stringify(caps) !== JSON.stringify(d.caps);
    if (changed || now() - d.touchedAt >= TOUCH_EVERY_MS) {
      d.fw = fw;
      d.caps = caps;
      d.touchedAt = now();
      try {
        await store.touchDevice({ clubId: d.clubId, deviceId: d.id, fw, caps });
      } catch (err) {
        log.error('db_error', { op: 'touch_device', device_id: d.id, error: err.message });
      }
    }
    await evaluate(d, 'state');
  }

  function handleEvent(d, payload) {
    const ev = parseJsonObject(payload);
    if (!ev || ev.v !== PROTOCOL_VERSION) {
      log.warn('event_bad_format', { device_id: d.id });
      return;
    }
    // Журнал событий по (device_id, boot, n) — M1 (protocol §4, decisions №33).
    log.info('device_event', { device_id: d.id, type: code(ev.type) ?? 'unknown', boot: safeInt(ev.boot), n: safeInt(ev.n) });
  }

  async function handle(d, topic, payload) {
    if (!(await ensureKnown(d, topic.clubId))) return;
    switch (topic.kind) {
      case 'status': {
        const value = payload.toString('utf8').trim();
        if (value === 'online') {
          d.status = 'online';
        } else if (value === 'offline') {
          d.status = 'offline';
          d.lastStateAt = null; // после возврата нужен свежий state
        } else {
          log.warn('status_bad_format', { device_id: d.id });
          return;
        }
        await evaluate(d, 'status');
        return;
      }
      case 'state':
        await handleState(d, payload);
        return;
      case 'event':
        handleEvent(d, payload);
        return;
      case 'ack':
        handleAck(d, payload);
        return;
      default:
        return;
    }
  }

  /** Входящее сообщение; сообщения одного устройства обрабатываются строго по порядку. */
  function onMessage(topicName, payload) {
    const topic = parseDeviceTopic(topicName);
    if (!topic || topic.kind === 'cmd') return Promise.resolve();
    if (payload.length > MAX_PAYLOAD_BYTES) {
      log.warn('message_too_large', { device_id: topic.deviceId, kind: topic.kind });
      return Promise.resolve();
    }
    const d = record(topic.deviceId);
    d.queue = d.queue
      .then(() => handle(d, topic, payload))
      .catch((err) => log.error('device_message_failed', { device_id: d.id, kind: topic.kind, error: err.message }));
    return d.queue;
  }

  function sweep() {
    for (const d of devices.values()) {
      if (d.online) d.queue = d.queue.then(() => evaluate(d, 'no_state')).catch(() => {});
    }
  }

  function onConnect() {
    connected = true;
    log.info('mqtt_connected', {});
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (err, granted) => {
      if (err) {
        log.error('mqtt_subscribe_failed', { error: err.message });
        return;
      }
      const denied = (granted ?? []).filter((g) => g.qos === 128).map((g) => g.topic);
      if (denied.length > 0) log.error('mqtt_subscribe_denied', { topics: denied });
    });
  }

  function onClose() {
    if (connected) log.warn('mqtt_disconnected', {});
    connected = false;
  }

  function onError(err) {
    log.warn('mqtt_error', { error: err.message });
  }

  return {
    start() {
      client.on('connect', onConnect);
      client.on('close', onClose);
      client.on('error', onError);
      client.on('message', onMessage);
      if (client.connected) onConnect();
      intervals.push(timers.setInterval(sweep, sweepEveryMs));
      intervals.push(
        timers.setInterval(async () => {
          await refreshTotal({ quiet: true });
          report(true);
        }, reportEveryMs),
      );
      return refreshTotal();
    },
    async stop() {
      stopped = true;
      for (const id of intervals) timers.clearInterval(id);
      for (const entry of pending.values()) timers.clearTimeout(entry.timer);
      pending.clear();
      client.off?.('connect', onConnect);
      client.off?.('close', onClose);
      client.off?.('error', onError);
      client.off?.('message', onMessage);
      await Promise.allSettled([...devices.values()].map((d) => d.queue));
    },
    onMessage,
    sendCommand: (deviceId, type, body = {}) => {
      const d = devices.get(deviceId);
      if (!d || !d.clubId) return Promise.resolve(null);
      return sendCommand(d, type, body);
    },
    stats: () => ({ online: onlineCount(), total: total ?? 0, pending: pending.size }),
    isConnected: () => Boolean(client.connected),
  };
}

/** Подключение сервера к брокеру: TLS с CA из файла, логин bl-server. */
export function connectMqtt({ url, caFile, username, password, clientId = 'bl-server' }) {
  return mqtt.connect(url, {
    clientId,
    username,
    password,
    ca: readFileSync(caFile),
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
  });
}
