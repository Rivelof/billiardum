// Мост MQTT (контракт M0 §6, docs/protocol.md v1 §2, §6) — единственный, кто публикует в cmd.
//
// * Подписка на bl/v1/+/+/{state,status,event,ack}, clean session. Устройство и его клуб —
//   по device_id из базы (bl.device_club); club_id из топика не доверяем: расхождение —
//   журнал и тревога.
// * Онлайн: status = online и получен state. Офлайн: status = offline или нет state 150 с.
// * Одна неподтверждённая команда на устройство: остальные ждут в очереди. Команда — seq и
//   журнал в одной транзакции, публикация после коммита, повтор с тем же id и seq каждые 3 с
//   до 5 раз, затем тревога cmd_no_ack и отказ от команды. Пока устройство офлайн, повторов
//   и тревоги cmd_no_ack нет; недоставленные команды не пересылаются (кроме config.set).
// * После возвращения онлайн и после boot — актуальное состояние стола (actualState; в M0 — ping).
// * seq = greatest(devices.last_seq, state.last_seq) + 1; подъём по state — журнал
//   device.seq_sync; разрыв больше 1 000 000 — тревога без подъёма.
// * Логи — JSON без персональных данных: devices_online, cmd_ack и др.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { buildCommand, deviceTopic, MAX_EVENT_BYTES, MAX_STATE_BYTES, parseDeviceTopic, PROTOCOL_VERSION } from './lib/protocol.mjs';
import { SERVER_CLIENT_ID } from './lib/dynsec.mjs';
import { decryptSecret, deviceKeyContext } from './lib/secrets.mjs';

export const OFFLINE_AFTER_MS = 150_000;
export const RETRY_MS = 3_000;
export const MAX_RETRIES = 5;
export const REPORT_EVERY_MS = 60_000;
export const SWEEP_EVERY_MS = 5_000;
export const UNKNOWN_RECHECK_MS = 60_000;
export const TOUCH_EVERY_MS = 60_000;
export const SEQ_GAP_LIMIT = 1_000_000;
/** boot сразу после выхода онлайн — та же загрузка: актуальное состояние уже отправлено. */
export const BOOT_SYNC_WINDOW_MS = 10_000;
/** Предел входящих сообщений: state и event — 4096 байт (§2); ack и status не больше. */
export const MAX_INCOMING_BYTES = Math.max(MAX_STATE_BYTES, MAX_EVENT_BYTES);
export const SUBSCRIPTIONS = ['state', 'status', 'event', 'ack'].map((kind) => `bl/v1/+/+/${kind}`);
/** Команды, которые после офлайна или перезагрузки досылаются; остальные заменяет актуальное состояние. */
export const RESEND_AFTER_RECONNECT = new Set(['config.set']);

const CODE = /^[a-z][a-z0-9_.]{0,39}$/;
const BOOT_ID = /^[0-9a-f]{8}$/;
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

/** Актуальное состояние стола в M0: сессий ещё нет, симулятор M0 исполняет ping. В M1 —
 * session.resume, service.start, state.pending/reserved или state.free (protocol §6). */
export async function defaultActualState() {
  return { type: 'ping', body: {} };
}

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
  actualState = defaultActualState,
  offlineAfterMs = OFFLINE_AFTER_MS,
  retryMs = RETRY_MS,
  maxRetries = MAX_RETRIES,
  reportEveryMs = REPORT_EVERY_MS,
  sweepEveryMs = SWEEP_EVERY_MS,
  seqGapLimit = SEQ_GAP_LIMIT,
}) {
  /** @type {Map<string, any>} */
  const devices = new Map();
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
        onlineAt: null,
        lastSyncAt: null,
        reportedLastSeq: null,
        seqGapAlarmed: null,
        fw: null,
        caps: null,
        touchedAt: 0,
        queue: Promise.resolve(),
        inflight: null, // единственная неподтверждённая команда
        outbox: [], // ждут своей очереди: { type, body } | { sync: true } | { resend: entry }
        unknownLogged: false,
        mismatchLogged: new Set(),
      };
      devices.set(deviceId, d);
    }
    return d;
  }

  /** Работа в очереди сообщений устройства (из таймеров). */
  function kick(d) {
    d.queue = d.queue.then(() => pump(d)).catch((err) => log.error('device_queue_failed', { device_id: d.id, error: err.message }));
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

  // Команды ------------------------------------------------------------------------

  function publish(entry) {
    client.publish(entry.topic, entry.payload, { qos: 1, retain: false }, (err) => {
      if (err) log.warn('cmd_publish_failed', { device_id: entry.deviceId, type: entry.type, seq: entry.seq, error: err.message });
    });
  }

  function cmdFields(entry) {
    return { device_id: entry.deviceId, type: entry.type, seq: entry.seq };
  }

  function scheduleRetry(d, entry) {
    entry.timer = timers.setTimeout(() => {
      if (stopped || d.inflight !== entry || !d.online) return;
      if (entry.retries >= maxRetries) {
        d.inflight = null;
        // Тревога «контроллер не отвечает» и отказ от команды (protocol §6). Уведомление — M1.
        log.error('cmd_no_ack', { ...cmdFields(entry), attempts: entry.retries + 1, alarm: 'controller_not_responding' });
        kick(d);
        return;
      }
      entry.retries += 1;
      log.debug('cmd_retry', { ...cmdFields(entry), retry: entry.retries });
      publish(entry);
      scheduleRetry(d, entry);
    }, retryMs);
  }

  function send(d, entry) {
    d.inflight = entry;
    entry.retries = 0;
    publish(entry);
    scheduleRetry(d, entry);
  }

  /** seq и журнал в базе, подпись, затем публикация. null — команда не ушла. */
  async function allocateAndSend(d, type, body, sync = false) {
    const cmdId = randomUUID();
    let result;
    try {
      result = await store.allocateCommand({
        clubId: d.clubId,
        deviceId: d.id,
        cmdId,
        type,
        stateLastSeq: d.reportedLastSeq,
        seqGapLimit,
        build: ({ seq, keyEnc }) => {
          const key = decryptSecret(keyEnc, encKey, deviceKeyContext(d.id));
          return buildCommand({ id: cmdId, seq, type, body, issuedAt: Math.floor(now() / 1000) }, key).payload;
        },
      });
    } catch (err) {
      log.error('cmd_failed', { device_id: d.id, type, error: err.message });
      return null;
    }
    if (result.seqGap && d.seqGapAlarmed !== result.seqGap.state_seq) {
      d.seqGapAlarmed = result.seqGap.state_seq;
      log.error('device_seq_gap', { device_id: d.id, db_seq: result.seqGap.db_seq, state_seq: result.seqGap.state_seq, alarm: 'seq_gap' });
    }
    if (result.status !== 'ok') {
      log.warn('cmd_skipped', { device_id: d.id, type, reason: result.status });
      return null;
    }
    if (result.seqSync) log.warn('device_seq_sync', { device_id: d.id, from: result.seqSync.from, to: result.seqSync.to });
    const entry = {
      cmdId,
      deviceId: d.id,
      seq: result.seq,
      type,
      topic: deviceTopic(d.clubId, d.id, 'cmd'),
      payload: result.payload,
      sync,
      retries: 0,
      timer: null,
    };
    log.debug('cmd_sent', cmdFields(entry));
    send(d, entry);
    return entry;
  }

  /** Отправить следующую команду, если устройство онлайн и неподтверждённой нет. */
  async function pump(d) {
    while (!stopped && d.online && !d.inflight && d.outbox.length > 0) {
      const next = d.outbox.shift();
      if (next.resend) {
        log.info('cmd_resend', cmdFields(next.resend));
        send(d, next.resend);
        return;
      }
      let type = next.type;
      let body = next.body;
      if (next.sync) {
        d.lastSyncAt = now();
        try {
          ({ type, body } = await actualState({ deviceId: d.id, clubId: d.clubId }));
        } catch (err) {
          log.error('actual_state_failed', { device_id: d.id, error: err.message });
          continue;
        }
      }
      await allocateAndSend(d, type, body, Boolean(next.sync));
    }
  }

  /** Актуальное состояние стола — первым в очередь, не чаще одного раза. */
  function queueActualState(d) {
    if (d.inflight?.sync || d.outbox.some((x) => x.sync)) return;
    d.outbox.unshift({ sync: true });
  }

  /**
   * Связь прервалась или устройство перезагрузилось: неподтверждённая команда больше
   * не повторяется, недоставленные команды не пересылаются (кроме RESEND_AFTER_RECONNECT).
   */
  function dropUndelivered(d, reason) {
    const keep = [];
    const entry = d.inflight;
    if (entry) {
      timers.clearTimeout(entry.timer);
      d.inflight = null;
      if (RESEND_AFTER_RECONNECT.has(entry.type)) keep.push({ resend: entry });
      else log.info('cmd_abandoned', { ...cmdFields(entry), reason });
    }
    for (const x of d.outbox) {
      if (x.resend || RESEND_AFTER_RECONNECT.has(x.type)) keep.push(x);
      else if (!x.sync) log.info('cmd_dropped', { device_id: d.id, type: x.type, reason });
    }
    d.outbox = keep;
  }

  // Онлайн и офлайн ------------------------------------------------------------------

  async function evaluate(d, reason) {
    const shouldBeOnline = d.status === 'online' && d.lastStateAt !== null && now() - d.lastStateAt <= offlineAfterMs;
    if (shouldBeOnline && !d.online) {
      d.online = true;
      d.onlineAt = now();
      log.info('device_online', { device_id: d.id });
      report();
      queueActualState(d);
      await pump(d);
    } else if (!shouldBeOnline && d.online) {
      d.online = false;
      dropUndelivered(d, 'offline');
      log.info('device_offline', { device_id: d.id, reason });
      report();
    }
  }

  // Входящие ---------------------------------------------------------------------------

  async function handleAck(d, payload) {
    const ack = parseJsonObject(payload);
    if (!ack || ack.v !== PROTOCOL_VERSION || !(typeof ack.cmd_id === 'string' || ack.cmd_id === null)) {
      log.warn('ack_bad_format', { device_id: d.id });
      return;
    }
    const entry = d.inflight;
    // cmd_id: null — контроллер не разобрал команду (bad_format, §4). Неподтверждённая команда
    // на устройство одна, значит, ответ — на неё; повтор тех же байт ничего не изменит.
    const matches = entry && (ack.cmd_id === null ? ack.ok !== true : ack.cmd_id === entry.cmdId);
    if (!matches) {
      if (ack.cmd_id === null) log.warn('ack_unmatched', { device_id: d.id, error: code(ack.error) ?? 'unknown' });
      else log.debug('ack_unmatched', { device_id: d.id });
      return;
    }
    timers.clearTimeout(entry.timer);
    d.inflight = null;
    if (ack.cmd_id !== null && ack.seq !== entry.seq) log.warn('ack_seq_mismatch', cmdFields(entry));
    const ok = ack.ok === true;
    const fields = { ...cmdFields(entry), ok };
    if (ok) log.info('cmd_ack', fields);
    else log.warn('cmd_ack', { ...fields, error: code(ack.error) ?? 'unknown' });
    await pump(d);
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

  async function handleEvent(d, payload) {
    const ev = parseJsonObject(payload);
    if (!ev || ev.v !== PROTOCOL_VERSION) {
      log.warn('event_bad_format', { device_id: d.id });
      return;
    }
    const type = code(ev.type) ?? 'unknown';
    // Журнал событий по (device_id, boot_id, n) — M1 (protocol §4, decisions №33, №37).
    log.info('device_event', {
      device_id: d.id,
      type,
      boot: safeInt(ev.boot),
      boot_id: typeof ev.boot_id === 'string' && BOOT_ID.test(ev.boot_id) ? ev.boot_id : null,
      n: safeInt(ev.n),
    });
    if (type === 'boot') {
      // Контроллер перезагрузился и ждёт актуальное состояние (§5, правило 4): старые
      // команды не досылаются. Если boot пришёл сразу после выхода онлайн, состояние
      // для этой загрузки уже отправлено.
      const fresh = d.online && d.lastSyncAt !== null && d.lastSyncAt >= d.onlineAt && now() - d.onlineAt <= BOOT_SYNC_WINDOW_MS;
      if (!fresh) {
        dropUndelivered(d, 'boot');
        if (d.online) {
          queueActualState(d);
          await pump(d);
        }
      }
    }
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
        await handleEvent(d, payload);
        return;
      case 'ack':
        await handleAck(d, payload);
        return;
      default:
        return;
    }
  }

  /** Входящее сообщение; сообщения одного устройства обрабатываются строго по порядку. */
  function onMessage(topicName, payload) {
    const topic = parseDeviceTopic(topicName);
    if (!topic || topic.kind === 'cmd') return Promise.resolve();
    if (payload.length > MAX_INCOMING_BYTES) {
      log.warn('message_too_large', { device_id: topic.deviceId, kind: topic.kind, bytes: payload.length });
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
      for (const d of devices.values()) if (d.inflight) timers.clearTimeout(d.inflight.timer);
      client.off?.('connect', onConnect);
      client.off?.('close', onClose);
      client.off?.('error', onError);
      client.off?.('message', onMessage);
      await Promise.allSettled([...devices.values()].map((d) => d.queue));
    },
    onMessage,
    /**
     * Команда устройству (для M1: сессии, сервисный свет). Офлайн-устройству команда
     * не ставится (кроме RESEND_AFTER_RECONNECT): после возвращения уйдёт актуальное состояние.
     * @returns {Promise<'queued' | 'offline' | 'unknown_device'>}
     */
    command(deviceId, type, body = {}) {
      const d = devices.get(deviceId);
      if (!d || !d.clubId) return Promise.resolve('unknown_device');
      if (!d.online && !RESEND_AFTER_RECONNECT.has(type)) return Promise.resolve('offline');
      d.outbox.push({ type, body });
      kick(d);
      return d.queue.then(() => 'queued');
    },
    stats() {
      let pending = 0;
      for (const d of devices.values()) pending += (d.inflight ? 1 : 0) + d.outbox.length;
      return { online: onlineCount(), total: total ?? 0, pending };
    },
    isConnected: () => Boolean(client.connected),
  };
}

/** Подключение сервера к брокеру: TLS с CA из файла, логин bl-server, clean session (§2). */
export function connectMqtt({ url, caFile, username, password, clientId = SERVER_CLIENT_ID }) {
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
