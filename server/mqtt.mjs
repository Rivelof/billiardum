// Мост MQTT (контракт M1 §6, docs/protocol.md v1 §2, §6) — единственный, кто публикует в cmd.
//
// * Подписка на bl/v1/+/+/{state,status,event,ack}, clean session. Устройство и его клуб —
//   по device_id из базы (bl.device_club); club_id из топика не доверяем: расхождение —
//   журнал и тревога.
// * Онлайн: status = online и получен state. Офлайн: status = offline или нет state 150 с.
// * Одна неподтверждённая команда на устройство: остальные ждут в очереди. Команда — seq и
//   журнал в одной транзакции, публикация после коммита, повтор с тем же id и seq каждые 3 с
//   до 5 раз, затем тревога cmd_no_ack и отказ от команды. Пока устройство офлайн, повторов
//   и тревоги cmd_no_ack нет; недоставленные команды не пересылаются (кроме config.set —
//   он досылается новой командой: новый seq и запись в журнале, старый seq контроллер отверг бы).
// * Нет связи с брокером — ничего не публикуется: неподтверждённые команды брошены (abandoned),
//   очереди сброшены, исходящие QoS 1 библиотеки mqtt удалены (иначе после переподключения
//   ушли бы устаревшие команды). После переподключения — актуальное состояние онлайн-столам.
// * Ошибка базы при отправке не теряет команду: она возвращается в очередь и повторяется
//   через DB_RETRY_MS; sweep раз в 5 с дочитывает bl.device_commands онлайн-устройств
//   (страховка от потерянного NOTIFY).
// * M1: команды бизнес-логики лежат в bl.device_commands (queued); мост забирает их по
//   wake(deviceId) после коммита (LISTEN bl_light) и перед отправкой зовёт prepare — тело
//   (remaining_ms по paid_until и т. п.) считается в момент отправки, в той же транзакции,
//   что seq и журнал.
// * После возвращения онлайн и после boot — актуальное состояние стола (actualState):
//   session.resume с остатком по paid_until, service.start, state.pending/state.reserved
//   или state.free. Команды, поставленные до возвращения, помечаются superseded.
// * События — в журнал один раз по (device_id, boot_id, n); новые события — в hooks.onEvent.
// * Сверка state.mode с базой: расхождение дольше 10 с — hooks.onMismatch (журнал, тревога).
// * Офлайн во время сессии дольше 120 с — hooks.onOfflineAlarm (decisions №16).
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
/** Пауза перед повтором команды после ошибки базы; после DB_MAX_FAILURES ошибок подряд — отказ. */
export const DB_RETRY_MS = 5_000;
export const DB_MAX_FAILURES = 5;
export const UNKNOWN_RECHECK_MS = 60_000;
export const TOUCH_EVERY_MS = 60_000;
export const SEQ_GAP_LIMIT = 1_000_000;
/** Расхождение state.mode с базой дольше этого — тревога (protocol §6). */
export const MISMATCH_ALARM_MS = 10_000;
/** Офлайн во время сессии дольше этого — тревога critical (decisions №16). */
export const OFFLINE_ALARM_MS = 120_000;
/** boot сразу после выхода онлайн — та же загрузка: актуальное состояние уже отправлено. */
export const BOOT_SYNC_WINDOW_MS = 10_000;
/** Предел входящих сообщений: state и event — 4096 байт (§2); ack и status не больше. */
export const MAX_INCOMING_BYTES = Math.max(MAX_STATE_BYTES, MAX_EVENT_BYTES);
export const SUBSCRIPTIONS = ['state', 'status', 'event', 'ack'].map((kind) => `bl/v1/+/+/${kind}`);
/** Команды, которые после офлайна или перезагрузки досылаются; остальные заменяет актуальное состояние. */
export const RESEND_AFTER_RECONNECT = new Set(['config.set']);
export const DEVICE_MODES = new Set(['free', 'pending', 'reserved', 'active', 'ending', 'grace', 'service', 'fault']);

const CODE = /^[a-z][a-z0-9_.]{0,39}$/;
const BOOT_ID = /^[0-9a-f]{8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
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

/** Только проверенные поля state: устройство аутентифицировано, но данным не доверяем. */
export function sanitizeState(state) {
  return {
    mode: DEVICE_MODES.has(state.mode) ? state.mode : null,
    session_id: typeof state.session_id === 'string' && UUID.test(state.session_id) ? state.session_id : null,
    relay: state.relay === true,
    remaining_ms: safeInt(state.remaining_ms),
    rssi: Number.isSafeInteger(state.rssi) && state.rssi >= -150 && state.rssi <= 0 ? state.rssi : null,
    boot: safeInt(state.boot),
    uptime_s: safeInt(state.uptime_s),
    state_seq: safeInt(state.state_seq),
  };
}

/** Актуальное состояние стола без модуля сессий (M0): ping. В M1 его даёт sessions (actualState). */
export async function defaultActualState() {
  return { type: 'ping', body: {} };
}

/**
 * Мост без сетевых зависимостей: клиент MQTT, хранилище и таймеры передаются снаружи
 * (в тестах — подделки).
 *
 * hooks (все необязательны, ошибки ловятся и пишутся в лог):
 *   prepare(client, { clubId, deviceId, type, body, sessionId, deviceState }) → { type, body } | null
 *       — внутри транзакции выделения seq (store.allocateCommand); null — команда устарела.
 *   onAck({ clubId, deviceId, entry, ack, ok, at }) → { resync?: boolean }
 *   onEvent({ clubId, deviceId, ev, at }) — только новые события (после записи в журнал).
 *   expected({ clubId, deviceId }) → { modes: string[], sessionId: string|null, lightAllowed: boolean } | null
 *   onMismatch({ clubId, deviceId, expected, state, sinceMs })
 *   onOfflineAlarm({ clubId, deviceId, offlineMs }) → true, если тревога поднята (была сессия)
 *   onNoAck({ clubId, deviceId, entry })
 */
export function createBridge({
  client,
  store,
  encKey,
  log,
  now = Date.now,
  timers = globalThis,
  actualState = defaultActualState,
  hooks = {},
  offlineAfterMs = OFFLINE_AFTER_MS,
  retryMs = RETRY_MS,
  maxRetries = MAX_RETRIES,
  reportEveryMs = REPORT_EVERY_MS,
  sweepEveryMs = SWEEP_EVERY_MS,
  dbRetryMs = DB_RETRY_MS,
  seqGapLimit = SEQ_GAP_LIMIT,
  mismatchAlarmMs = MISMATCH_ALARM_MS,
  offlineAlarmMs = OFFLINE_ALARM_MS,
}) {
  /** @type {Map<string, any>} */
  const devices = new Map();
  const intervals = [];
  let total = null;
  let lastReport = null;
  let connected = false;
  let everConnected = false;
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

  async function hook(name, args) {
    const fn = hooks[name];
    if (typeof fn !== 'function') return undefined;
    try {
      return await fn(args);
    } catch (err) {
      log.error('bridge_hook_failed', { hook: name, device_id: args.deviceId, error: err.message });
      return undefined;
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
        lastState: null,
        online: false,
        onlineAt: null,
        offlineAt: null,
        offlineAlarmed: false,
        lastSyncAt: null,
        reportedLastSeq: null,
        seqGapAlarmed: null,
        fw: null,
        caps: null,
        touchedAt: 0,
        mismatchSince: null,
        mismatchAlarmed: false,
        queue: Promise.resolve(),
        inflight: null, // единственная неподтверждённая команда
        outbox: [], // ждут своей очереди: { type, body, rowId?, resendOf?, failures? } | { sync: true, reason, failures? }
        retryAt: 0, // после ошибки базы очередь стоит до этого момента
        unknownLogged: false,
        mismatchLogged: new Set(),
      };
      devices.set(deviceId, d);
    }
    return d;
  }

  /** Работа в очереди сообщений устройства (из таймеров и внешних вызовов). */
  function kick(d, work = () => pump(d)) {
    d.queue = d.queue.then(work).catch((err) => log.error('device_queue_failed', { device_id: d.id, error: err.message }));
    return d.queue;
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

  async function mark(d, entry, status, extra = {}) {
    if (typeof store.markCommand !== 'function') return;
    try {
      await store.markCommand({ clubId: d.clubId, cmdId: entry.cmdId, status, attempts: entry.retries + 1, ...extra });
    } catch (err) {
      log.error('db_error', { op: 'mark_command', device_id: d.id, error: err.message });
    }
  }

  // Команды ------------------------------------------------------------------------

  function publish(entry) {
    // Без связи mqtt положил бы команду в свою очередь и отправил после переподключения —
    // устаревшей. Не публикуем: команду бросит onClose, после connect уйдёт актуальное состояние.
    if (!connected || !client.connected) {
      log.debug('cmd_publish_skipped', { ...cmdFields(entry), reason: 'mqtt_disconnected' });
      return;
    }
    client.publish(entry.topic, entry.payload, { qos: 1, retain: false }, (err) => {
      if (err) log.warn('cmd_publish_failed', { device_id: entry.deviceId, type: entry.type, seq: entry.seq, error: err.message });
    });
  }

  function cmdFields(entry) {
    return { device_id: entry.deviceId, type: entry.type, seq: entry.seq };
  }

  function scheduleRetry(d, entry) {
    entry.timer = timers.setTimeout(() => {
      if (stopped || d.inflight !== entry || !d.online || !connected) return;
      if (entry.retries >= maxRetries) {
        d.inflight = null;
        // Тревога «контроллер не отвечает» и отказ от команды (protocol §6).
        log.error('cmd_no_ack', { ...cmdFields(entry), attempts: entry.retries + 1, alarm: 'controller_not_responding' });
        kick(d, async () => {
          await mark(d, entry, 'no_ack');
          await hook('onNoAck', { clubId: d.clubId, deviceId: d.id, entry });
          await pump(d);
        });
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
    entry.sentAt = now();
    publish(entry);
    scheduleRetry(d, entry);
  }

  /** seq и журнал в базе, подпись, затем публикация. null — команда не ушла; 'error' — ошибка базы. */
  async function allocateAndSend(d, item, sync = false) {
    const cmdId = item.rowId ?? randomUUID();
    let result;
    try {
      result = await store.allocateCommand({
        clubId: d.clubId,
        deviceId: d.id,
        cmdId,
        rowId: item.rowId ?? null,
        type: item.type,
        body: item.body,
        sessionId: item.sessionId ?? null,
        paymentId: item.paymentId ?? null,
        cause: item.cause ?? (sync ? 'sync' : 'system'),
        stateLastSeq: d.reportedLastSeq,
        seqGapLimit,
        deviceState: d.lastState,
        prepare: hooks.prepare,
        build: ({ seq, keyEnc, type = item.type, body = item.body }) => {
          const key = decryptSecret(keyEnc, encKey, deviceKeyContext(d.id));
          return buildCommand({ id: cmdId, seq, type, body, issuedAt: Math.floor(now() / 1000) }, key).payload;
        },
      });
    } catch (err) {
      log.error('cmd_failed', { device_id: d.id, type: item.type, error: err.message });
      return 'error';
    }
    if (result.seqGap && d.seqGapAlarmed !== result.seqGap.state_seq) {
      d.seqGapAlarmed = result.seqGap.state_seq;
      log.error('device_seq_gap', { device_id: d.id, db_seq: result.seqGap.db_seq, state_seq: result.seqGap.state_seq, alarm: 'seq_gap' });
    }
    if (result.status !== 'ok') {
      if (result.status === 'cancelled' || result.status === 'stale') log.debug('cmd_skipped', { device_id: d.id, type: item.type, reason: result.status });
      else log.warn('cmd_skipped', { device_id: d.id, type: item.type, reason: result.status });
      return null;
    }
    if (result.seqSync) log.warn('device_seq_sync', { device_id: d.id, from: result.seqSync.from, to: result.seqSync.to });
    const entry = {
      cmdId,
      deviceId: d.id,
      seq: result.seq,
      type: result.type ?? item.type,
      body: result.body ?? item.body,
      sessionId: item.sessionId ?? result.body?.session_id ?? null,
      paymentId: item.paymentId ?? null,
      topic: deviceTopic(d.clubId, d.id, 'cmd'),
      payload: result.payload,
      sync,
      retries: 0,
      timer: null,
      sentAt: null,
    };
    log.debug('cmd_sent', cmdFields(entry));
    if (item.resendOf) log.info('cmd_resend', { ...cmdFields(entry), resend_of: item.resendOf });
    send(d, entry);
    return entry;
  }

  /**
   * Ошибка базы: команда (или актуальное состояние) возвращается в начало очереди, очередь
   * ждёт dbRetryMs (sweep повторит). После DB_MAX_FAILURES ошибок подряд — отказ от команды
   * (строка bl.device_commands остаётся queued; её заменит актуальное состояние).
   */
  function retryLater(d, next, what) {
    next.failures = (next.failures ?? 0) + 1;
    if (next.failures >= DB_MAX_FAILURES) {
      log.error('cmd_given_up', { device_id: d.id, type: next.type ?? 'sync', what, failures: next.failures });
      // Строку очереди — в cancelled, иначе sweep подхватывал бы её снова и снова.
      if (next.rowId) kick(d, () => mark(d, { cmdId: next.rowId, retries: next.failures - 1 }, 'cancelled', { error: 'db_error' }));
      if (!next.sync) queueActualState(d, 'db_error');
      return;
    }
    d.outbox.unshift(next);
    d.retryAt = now() + dbRetryMs;
  }

  /** Отправить следующую команду, если связь есть, устройство онлайн и неподтверждённой нет. */
  async function pump(d) {
    while (!stopped && connected && d.online && !d.inflight && d.outbox.length > 0 && now() >= d.retryAt) {
      const next = d.outbox.shift();
      let item = next;
      if (next.sync) {
        d.lastSyncAt = now();
        try {
          item = await actualState({ deviceId: d.id, clubId: d.clubId, reason: next.reason ?? 'sync', deviceState: d.lastState });
        } catch (err) {
          log.error('actual_state_failed', { device_id: d.id, error: err.message });
          retryLater(d, next, 'actual_state');
          return;
        }
        if (!item) continue;
      }
      const res = await allocateAndSend(d, item, Boolean(next.sync));
      if (res === 'error') {
        retryLater(d, next, 'allocate');
        return;
      }
    }
  }

  /** Актуальное состояние стола — первым в очередь, не чаще одного раза. */
  function queueActualState(d, reason) {
    if (d.inflight?.sync || d.outbox.some((x) => x.sync)) return;
    d.outbox.unshift({ sync: true, reason });
  }

  /**
   * Связь прервалась или устройство перезагрузилось: неподтверждённая команда больше
   * не повторяется (abandoned), недоставленные команды не пересылаются. RESEND_AFTER_RECONNECT
   * досылается новой командой — новый seq и журнал (старый seq контроллер отверг бы как replayed_seq).
   */
  async function dropUndelivered(d, reason) {
    const keep = [];
    const entry = d.inflight;
    if (entry) {
      timers.clearTimeout(entry.timer);
      d.inflight = null;
      log.info('cmd_abandoned', { ...cmdFields(entry), reason });
      await mark(d, entry, 'abandoned');
      if (RESEND_AFTER_RECONNECT.has(entry.type)) {
        keep.push({ type: entry.type, body: entry.body, sessionId: entry.sessionId, paymentId: entry.paymentId, cause: 'system', resendOf: entry.cmdId });
      }
    }
    for (const x of d.outbox) {
      if (RESEND_AFTER_RECONNECT.has(x.type)) keep.push(x);
      else if (!x.sync) log.info('cmd_dropped', { device_id: d.id, type: x.type, reason });
    }
    d.outbox = keep;
    d.retryAt = 0;
  }

  /** Команды из bl.device_commands (queued) — в очередь устройства по порядку. */
  async function loadQueued(d) {
    if (typeof store.loadQueued !== 'function' || !d.clubId) return;
    let rows;
    try {
      rows = await store.loadQueued({ clubId: d.clubId, deviceId: d.id });
    } catch (err) {
      log.error('db_error', { op: 'load_queued', device_id: d.id, error: err.message });
      return;
    }
    const known = new Set(d.outbox.filter((x) => x.rowId).map((x) => x.rowId));
    if (d.inflight) known.add(d.inflight.cmdId);
    for (const r of rows) {
      if (known.has(r.id)) continue;
      d.outbox.push({ rowId: r.id, type: r.type, body: r.body, sessionId: r.session_id, paymentId: r.payment_id, cause: r.cause });
    }
  }

  // Онлайн и офлайн ------------------------------------------------------------------

  async function evaluate(d, reason) {
    const shouldBeOnline = d.status === 'online' && d.lastStateAt !== null && now() - d.lastStateAt <= offlineAfterMs;
    if (shouldBeOnline && !d.online) {
      d.online = true;
      d.onlineAt = now();
      d.offlineAt = null;
      d.offlineAlarmed = false;
      log.info('device_online', { device_id: d.id });
      report();
      // Поставленные до возвращения команды заменяет актуальное состояние (protocol §6).
      if (typeof store.supersedeQueued === 'function') {
        try {
          const n = await store.supersedeQueued({ clubId: d.clubId, deviceId: d.id });
          if (n > 0) log.info('cmd_superseded', { device_id: d.id, count: n });
        } catch (err) {
          log.error('db_error', { op: 'supersede_queued', device_id: d.id, error: err.message });
        }
      }
      d.outbox = d.outbox.filter((x) => RESEND_AFTER_RECONNECT.has(x.type));
      d.retryAt = 0;
      queueActualState(d, 'online');
      await pump(d);
    } else if (!shouldBeOnline && d.online) {
      d.online = false;
      d.offlineAt = now();
      d.offlineAlarmed = false;
      d.mismatchSince = null;
      await dropUndelivered(d, 'offline');
      log.info('device_offline', { device_id: d.id, reason });
      report();
    } else if (!shouldBeOnline && d.offlineAt === null && d.status === 'offline') {
      d.offlineAt = now(); // офлайн с момента, как узнали (например, после перезапуска сервера)
    }
  }

  // Сверка state с базой --------------------------------------------------------------

  function matches(expected, st) {
    if (!expected || !st.mode) return true;
    if (st.mode === 'fault') return false;
    if (!expected.modes.includes(st.mode)) return false;
    if (expected.sessionId && ['active', 'ending', 'grace'].includes(st.mode) && st.session_id !== expected.sessionId) return false;
    if (!expected.lightAllowed && st.relay) return false;
    return true;
  }

  async function reconcile(d) {
    if (!hooks.expected || !d.online || !d.lastState || d.inflight || d.outbox.length > 0) {
      d.mismatchSince = null;
      return;
    }
    const expected = await hook('expected', { clubId: d.clubId, deviceId: d.id });
    if (!expected) return;
    if (matches(expected, d.lastState)) {
      if (d.mismatchSince !== null) log.info('device_state_match', { device_id: d.id });
      d.mismatchSince = null;
      d.mismatchAlarmed = false;
      return;
    }
    if (d.mismatchSince === null) {
      d.mismatchSince = now();
      log.info('device_state_mismatch_start', { device_id: d.id, mode: d.lastState.mode });
      return;
    }
    const sinceMs = now() - d.mismatchSince;
    if (sinceMs >= mismatchAlarmMs && !d.mismatchAlarmed) {
      d.mismatchAlarmed = true;
      log.error('device_state_mismatch', { device_id: d.id, mode: d.lastState.mode, relay: d.lastState.relay, expected: expected.modes, alarm: 'state_mismatch' });
      await hook('onMismatch', { clubId: d.clubId, deviceId: d.id, expected, state: d.lastState, sinceMs });
      queueActualState(d, 'mismatch');
      await pump(d);
    }
  }

  async function checkOffline(d) {
    if (d.online || d.offlineAt === null || d.offlineAlarmed || !d.clubId) return;
    const offlineMs = now() - d.offlineAt;
    if (offlineMs < offlineAlarmMs) return;
    d.offlineAlarmed = true; // один раз за эпизод офлайна
    const raised = await hook('onOfflineAlarm', { clubId: d.clubId, deviceId: d.id, offlineMs });
    if (raised) log.error('device_offline_alarm', { device_id: d.id, offline_ms: offlineMs, alarm: 'device_offline_in_session' });
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
    const matched = entry && (ack.cmd_id === null ? ack.ok !== true : ack.cmd_id === entry.cmdId);
    if (!matched) {
      if (ack.cmd_id === null) log.warn('ack_unmatched', { device_id: d.id, error: code(ack.error) ?? 'unknown' });
      else log.debug('ack_unmatched', { device_id: d.id });
      return;
    }
    timers.clearTimeout(entry.timer);
    d.inflight = null;
    if (ack.cmd_id !== null && ack.seq !== entry.seq) log.warn('ack_seq_mismatch', cmdFields(entry));
    const ok = ack.ok === true;
    const error = ok ? null : (code(ack.error) ?? 'unknown');
    const fields = { ...cmdFields(entry), ok };
    if (ok) log.info('cmd_ack', fields);
    else log.warn('cmd_ack', { ...fields, error });
    await mark(d, entry, ok ? 'acked' : 'failed', { error, ackedAt: new Date(now()) });
    const res = await hook('onAck', { clubId: d.clubId, deviceId: d.id, entry, ack, ok, at: new Date(now()) });
    if (res?.resync) queueActualState(d, 'ack');
    await pump(d);
  }

  async function handleState(d, payload) {
    const state = parseJsonObject(payload);
    if (!state || state.v !== PROTOCOL_VERSION) {
      log.warn('state_bad_format', { device_id: d.id });
      return;
    }
    d.lastStateAt = now();
    d.lastState = sanitizeState(state);
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
    await reconcile(d);
  }

  async function handleEvent(d, payload) {
    const ev = parseJsonObject(payload);
    if (!ev || ev.v !== PROTOCOL_VERSION) {
      log.warn('event_bad_format', { device_id: d.id });
      return;
    }
    const type = code(ev.type) ?? 'unknown';
    const bootId = typeof ev.boot_id === 'string' && BOOT_ID.test(ev.boot_id) ? ev.boot_id : null;
    const n = safeInt(ev.n);
    log.info('device_event', { device_id: d.id, type, boot: safeInt(ev.boot), boot_id: bootId, n });
    const clean = {
      type,
      boot: safeInt(ev.boot),
      boot_id: bootId,
      n,
      at_uptime_ms: safeInt(ev.at_uptime_ms),
      data: ev.data !== null && typeof ev.data === 'object' && !Array.isArray(ev.data) ? ev.data : {},
    };
    // Журнал один раз по (device_id, boot_id, n) (protocol §4, decisions №33, №37).
    if (typeof store.recordEvent === 'function') {
      if (bootId === null || n === null || n < 1 || type === 'unknown') {
        log.warn('event_unrecorded', { device_id: d.id, type });
        return;
      }
      let fresh;
      try {
        fresh = await store.recordEvent({ clubId: d.clubId, deviceId: d.id, ev: clean, at: new Date(now()) });
      } catch (err) {
        log.error('db_error', { op: 'record_event', device_id: d.id, error: err.message });
        return;
      }
      if (!fresh) {
        log.debug('device_event_duplicate', { device_id: d.id, type, boot_id: bootId, n });
        return;
      }
    }
    if (type === 'boot') {
      // Контроллер перезагрузился и ждёт актуальное состояние (§5, правило 4): старые
      // команды не досылаются. Если boot пришёл сразу после выхода онлайн, состояние
      // для этой загрузки уже отправлено.
      const recent = d.online && d.lastSyncAt !== null && d.lastSyncAt >= d.onlineAt && now() - d.onlineAt <= BOOT_SYNC_WINDOW_MS;
      if (!recent) {
        await dropUndelivered(d, 'boot');
        if (d.online) {
          queueActualState(d, 'boot');
          await pump(d);
        }
      }
    }
    await hook('onEvent', { clubId: d.clubId, deviceId: d.id, ev: clean, at: new Date(now()) });
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
      if (d.online) {
        d.queue = d.queue
          .then(async () => {
            await evaluate(d, 'no_state');
            if (d.online && d.mismatchSince !== null) await reconcile(d);
            // Страховка от потерянного NOTIFY и повтор после ошибки базы.
            if (d.online && connected && !d.inflight) {
              await loadQueued(d);
              await pump(d);
            }
          })
          .catch(() => {});
      } else if (d.offlineAt !== null && !d.offlineAlarmed) {
        d.queue = d.queue.then(() => checkOffline(d)).catch(() => {});
      }
    }
  }

  function onConnect() {
    const reconnect = everConnected && !connected;
    connected = true;
    everConnected = true;
    log.info('mqtt_connected', { reconnect });
    client.subscribe(SUBSCRIPTIONS, { qos: 1 }, (err, granted) => {
      if (err) {
        log.error('mqtt_subscribe_failed', { error: err.message });
        return;
      }
      const denied = (granted ?? []).filter((g) => g.qos === 128).map((g) => g.topic);
      if (denied.length > 0) log.error('mqtt_subscribe_denied', { topics: denied });
    });
    if (reconnect) {
      // Пока связи не было, команды не уходили: онлайн-столам — актуальное состояние по базе,
      // поставленные за это время команды им заменяются (как при возвращении устройства онлайн).
      for (const d of devices.values()) {
        if (!d.online || !d.clubId) continue;
        kick(d, async () => {
          if (typeof store.supersedeQueued === 'function') {
            try {
              await store.supersedeQueued({ clubId: d.clubId, deviceId: d.id });
            } catch (err) {
              log.error('db_error', { op: 'supersede_queued', device_id: d.id, error: err.message });
            }
          }
          d.outbox = d.outbox.filter((x) => RESEND_AFTER_RECONNECT.has(x.type));
          queueActualState(d, 'reconnect');
          await pump(d);
        });
      }
    }
  }

  /** Исходящие QoS 1 библиотеки mqtt (не дошедшие до брокера) — удалить: они устарели. */
  function purgeOutgoing() {
    if (typeof client.removeOutgoingMessage !== 'function' || !client.outgoing) return 0;
    const ids = Object.keys(client.outgoing);
    for (const id of ids) client.removeOutgoingMessage(Number(id));
    return ids.length;
  }

  function onClose() {
    if (!connected) return;
    connected = false;
    log.warn('mqtt_disconnected', {});
    const purged = purgeOutgoing();
    if (purged > 0) log.info('mqtt_outgoing_purged', { count: purged });
    for (const d of devices.values()) {
      if (d.inflight || d.outbox.length > 0) kick(d, () => dropUndelivered(d, 'mqtt_closed'));
    }
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
     * Команда устройству в обход bl.device_commands (M0, отладка). Офлайн-устройству команда
     * не ставится (кроме RESEND_AFTER_RECONNECT): после возвращения уйдёт актуальное состояние.
     * @returns {Promise<'queued' | 'offline' | 'unknown_device'>}
     */
    command(deviceId, type, body = {}) {
      const d = devices.get(deviceId);
      if (!d || !d.clubId) return Promise.resolve('unknown_device');
      if (!d.online && !RESEND_AFTER_RECONNECT.has(type)) return Promise.resolve('offline');
      d.outbox.push({ type, body });
      return kick(d).then(() => 'queued');
    },
    /**
     * Сигнал после коммита: в bl.device_commands есть команды для устройства. Онлайн —
     * забрать и отправить; офлайн — оставить (после возвращения их заменит актуальное состояние).
     */
    wake(deviceId) {
      const d = devices.get(deviceId);
      if (!d || !d.clubId || !d.online) return Promise.resolve(false);
      return kick(d, async () => {
        await loadQueued(d);
        await pump(d);
      }).then(() => true);
    },
    /** Перепроверить все онлайн-устройства (после восстановления LISTEN). */
    wakeAll() {
      return Promise.all([...devices.keys()].map((id) => this.wake(id)));
    },
    /** Сверка состояния стола по требованию (после изменения в базе). */
    resync(deviceId, reason = 'request') {
      const d = devices.get(deviceId);
      if (!d || !d.clubId || !d.online) return Promise.resolve(false);
      return kick(d, async () => {
        queueActualState(d, reason);
        await pump(d);
      }).then(() => true);
    },
    /** Перечитать клуб устройства (после привязки). */
    forget(deviceId) {
      const d = devices.get(deviceId);
      if (!d) return;
      d.clubId = undefined;
      d.unknownLogged = false;
      d.mismatchLogged.clear();
    },
    /** Что мост знает об устройстве: онлайн, rssi, прошивка, возможности, режим. */
    deviceInfo(deviceId) {
      const d = devices.get(deviceId);
      if (!d) return null;
      return {
        online: d.online,
        rssi: d.lastState?.rssi ?? null,
        fw: d.fw,
        caps: d.caps,
        mode: d.lastState?.mode ?? null,
        relay: d.lastState?.relay ?? null,
        session_id: d.lastState?.session_id ?? null,
        offline_since: d.offlineAt === null ? null : new Date(d.offlineAt),
      };
    },
    /** Дождаться, пока очереди всех устройств опустеют (тесты). */
    async idle() {
      for (let i = 0; i < 5; i += 1) {
        const queues = [...devices.values()].map((d) => d.queue);
        await Promise.allSettled(queues);
        if ([...devices.values()].every((d, j) => d.queue === queues[j])) return;
      }
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
