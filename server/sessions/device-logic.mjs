// Связь сессий с мостом MQTT (protocol v1 §5–§6, контракт M1 §6): тело команды на момент
// отправки, актуальное состояние стола после boot и возвращения онлайн, ack, события
// контроллера, сверка state с базой, тревоги офлайна.

import { phaseOf, playEnd, UNPLAYED_THRESHOLD_MS, unplayedMs } from './kit.mjs';
import { activeHold, isOpen, isUuid, loadClub, loadDevice, loadSession, openSessionOn } from './queries.mjs';
import { buzzerFlag } from './settings.mjs';

export const MAX_REMAINING_MS = 86_400_000;
/** Запас на расхождение таймеров контроллера и сервера при решении «доиграл ли он сам». */
export const DEVICE_END_SLACK_MS = 5_000;
const RUNNING_MODES = new Set(['active', 'ending', 'grace']);
const SESSION_CMDS = new Set(['session.start', 'session.resume', 'session.extend']);

/** Уровни тревог событий контроллера (PRODUCT §8: свет в обход — критично, сразу). */
export const EVENT_ALARMS = Object.freeze({
  bypass_detected: { type: 'bypass_detected', level: 'critical' },
  relay_fault: { type: 'relay_fault', level: 'critical' },
  bad_sig: { type: 'bad_sig', level: 'critical' },
  lamp_fault: { type: 'lamp_fault', level: 'important' },
  replayed_seq: { type: 'replayed_seq', level: 'important' },
  events_dropped: { type: 'events_dropped', level: 'important' },
  ota_failed: { type: 'ota_failed', level: 'important' },
  offline_resume_denied: { type: 'offline_resume_denied', level: 'info' },
});

/** Безопасная копия data события для тревоги: только числа, булевы и короткие коды. */
function alarmData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!/^[a-z_]{1,32}$/.test(k)) continue;
    if (Number.isSafeInteger(v) || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v)) out[k] = v;
  }
  return out;
}

/**
 * @param {{ service: object, kit: object, log: object, withContext: Function, pool: object }} opts
 */
export function createDeviceLogic({ kit, log, withContext, pool }) {
  const { now, audit, alarm, markInterrupted } = kit;
  const sys = (clubId) => ({ clubId, actorType: 'system' });

  /** session.start/resume: остаток по paid_until на момент отправки; в льготу — её остаток. */
  async function sessionBody(db, s, t) {
    const club = await loadClub(db, s.club_id);
    const P = s.paid_until.getTime();
    const T = t.getTime();
    const buzzer = buzzerFlag(club.settings, t, club.timezone);
    let remaining = P - T;
    let grace = s.grace_ms;
    if (remaining < 1) {
      if (T >= P + s.grace_ms) return null; // льгота кончилась — играть нечего
      remaining = 1;
      grace = P + s.grace_ms - T;
    }
    return {
      session_id: s.id,
      remaining_ms: Math.min(remaining, MAX_REMAINING_MS),
      warn_ms: [...s.warn_ms],
      grace_ms: Math.min(grace, 600_000),
      buzzer,
    };
  }

  /**
   * Тело команды в транзакции выделения seq (store.allocateCommand). null — команда
   * устарела (сессия закрыта, удержание снято) и не уходит: «нет оплаты — нет света».
   */
  async function prepare(db, { deviceId, type, body, sessionId, deviceState }) {
    const t = now();
    if (SESSION_CMDS.has(type)) {
      const s = await loadSession(db, sessionId ?? body?.session_id);
      if (!s || !isOpen(s)) return null;
      const device = await loadDevice(db, deviceId);
      if (!device || device.resource_id !== s.resource_id) return null;
      const full = await sessionBody(db, s, t);
      if (!full) return null;
      if (type === 'session.extend') {
        const running = deviceState && deviceState.session_id === s.id && RUNNING_MODES.has(deviceState.mode);
        // Контроллер не ведёт эту сессию (перезагрузка, офлайн): extend дал бы wrong_session.
        if (running && full.remaining_ms > 1) return { type, body: { session_id: s.id, remaining_ms: full.remaining_ms, buzzer: full.buzzer } };
        return { type: 'session.resume', body: full };
      }
      return { type, body: full };
    }
    if (type === 'service.start' || type === 'state.pending' || type === 'state.reserved') {
      const device = await loadDevice(db, deviceId);
      if (!device?.resource_id) return null;
      const kind = type === 'service.start' ? 'service' : type.slice('state.'.length);
      const h = await activeHold(db, device.resource_id, t);
      if (!h || h.kind !== kind) return null;
      const left = Math.min(h.until.getTime() - t.getTime(), MAX_REMAINING_MS);
      if (left < 1) return null;
      if (type === 'service.start') return { type, body: { duration_ms: left, reason_code: h.reason_code } };
      return { type, body: { until_ms: left } };
    }
    return { type, body: body ?? {} };
  }

  /**
   * Актуальное состояние стола после boot, возвращения онлайн или расхождения (protocol §6).
   * Сам решает, доиграл ли контроллер без связи: тогда сессия interrupted, свет не возвращается.
   */
  async function actualState({ clubId, deviceId, reason, deviceState }) {
    return withContext(pool, sys(clubId), async (db) => {
      const t = now();
      const T = t.getTime();
      const device = await loadDevice(db, deviceId);
      if (!device?.resource_id) return { type: 'state.free', body: {} };
      const ds = deviceState ?? {};
      const s = await openSessionOn(db, device.resource_id, { lock: true });
      if (s) {
        const resume = { type: 'session.resume', body: { session_id: s.id }, sessionId: s.id };
        const running = reason !== 'boot' && ds.session_id === s.id && RUNNING_MODES.has(ds.mode);
        if (running) return resume;
        // Контроллер не ведёт сессию. Если по последнему подтверждённому остатку он ещё
        // должен гореть — он перезагрузился (T7): возвращаем свет с остатком по paid_until.
        const deviceEnd = playEnd(s).getTime() + s.grace_ms;
        if (T < deviceEnd - DEVICE_END_SLACK_MS) return resume;
        // Иначе он доиграл сам без связи (T5/T6). Оплачено больше — выбор гостя.
        const unplayed = unplayedMs(s);
        if (unplayed > UNPLAYED_THRESHOLD_MS) {
          await markInterrupted(db, s, t, unplayed);
        } else if (T < s.paid_until.getTime() + s.grace_ms) {
          return resume;
        }
      }
      if (ds.session_id && RUNNING_MODES.has(ds.mode) && (!s || ds.session_id !== s.id)) {
        // Контроллер ведёт сессию, которой нет в базе: свет без оплаты гасим (инвариант 4).
        return { type: 'session.stop', body: { session_id: ds.session_id, reason_code: 'not_paid' } };
      }
      const h = await activeHold(db, device.resource_id, t);
      if (h?.kind === 'service') return { type: 'service.start', body: {} };
      if (ds.mode === 'service') return { type: 'service.stop', body: {} };
      if (h?.kind === 'pending') return { type: 'state.pending', body: {} };
      if (h?.kind === 'reserved') return { type: 'state.reserved', body: {} };
      return { type: 'state.free', body: {} };
    });
  }

  /** ack: сессия подтвердила свет до device_paid_until; метрика light_latency для старта по оплате. */
  async function onAck({ clubId, entry, ok, ack, at }) {
    if (!ok) {
      const error = typeof ack.error === 'string' ? ack.error : 'unknown';
      if (error === 'bad_sig') {
        await withContext(pool, sys(clubId), (db) =>
          alarm(db, clubId, { type: 'bad_sig', level: 'critical', data: { device_id: entry.deviceId, type: entry.type, seq: entry.seq } }),
        );
      }
      // Контроллер не ведёт сессию или отверг тело — шлём актуальное состояние.
      return { resync: ['wrong_session', 'bad_body', 'replayed_seq'].includes(error) && entry.type !== 'state.free' };
    }
    if (!SESSION_CMDS.has(entry.type) || !isUuid(entry.body?.session_id)) return {};
    const remaining = entry.body.remaining_ms;
    if (!Number.isSafeInteger(remaining)) return {};
    await withContext(pool, sys(clubId), async (db) => {
      const deviceUntil = new Date(at.getTime() + remaining);
      await db.query(
        `update bl.sessions set device_paid_until = $2 where id = $1 and status = any('{active,ending,grace}'::text[])`,
        [entry.body.session_id, deviceUntil],
      );
      if (entry.type === 'session.start' && isUuid(entry.paymentId)) {
        const { rows } = await db.query('select confirmed_at from bl.session_payments where payment_id = $1', [entry.paymentId]);
        const confirmedAt = rows[0]?.confirmed_at;
        if (confirmedAt) {
          log.info('light_latency', { session_id: entry.body.session_id, ms: at.getTime() - new Date(confirmedAt).getTime() });
        } else {
          log.warn('light_latency_unknown', { session_id: entry.body.session_id });
        }
      }
    });
    return {};
  }

  /** Новое событие контроллера (уже в журнале): тревоги и прерванная игра. */
  async function onEvent({ clubId, deviceId, ev }) {
    await withContext(pool, sys(clubId), async (db) => {
      const device = await loadDevice(db, deviceId);
      const resourceId = device?.resource_id ?? null;
      const rule = EVENT_ALARMS[ev.type];
      if (rule) {
        await alarm(db, clubId, { type: rule.type, level: rule.level, resourceId, data: { device_id: deviceId, ...alarmData(ev.data) } });
      }
      if (ev.type === 'offline_session_finished' && isUuid(ev.data?.session_id)) {
        const s = await loadSession(db, ev.data.session_id, { lock: true });
        if (!s || s.club_id !== clubId || !isOpen(s) || s.resource_id !== resourceId) return;
        const unplayed = unplayedMs(s);
        if (unplayed > UNPLAYED_THRESHOLD_MS) await markInterrupted(db, s, now(), unplayed);
      }
    });
  }

  /** Какой режим контроллера ожидается по базе (для сверки state). */
  async function expected({ clubId, deviceId }) {
    return withContext(pool, sys(clubId), async (db) => {
      const t = now();
      const T = t.getTime();
      const device = await loadDevice(db, deviceId);
      if (!device?.resource_id) return null;
      const s = await openSessionOn(db, device.resource_id);
      if (s) {
        const P = s.paid_until.getTime();
        // Сессия только что кончилась или контроллер ещё не получил продление: не тревожим.
        if (T >= P + s.grace_ms - DEVICE_END_SLACK_MS || T >= playEnd(s).getTime() + s.grace_ms - DEVICE_END_SLACK_MS) {
          return { modes: ['active', 'ending', 'grace', 'free'], sessionId: null, lightAllowed: true };
        }
        return { modes: ['active', 'ending', 'grace'], sessionId: s.id, lightAllowed: true, phase: phaseOf(s.paid_until, t, s.warn_ms) };
      }
      const h = await activeHold(db, device.resource_id, t);
      if (h?.kind === 'service') {
        const ending = h.until.getTime() - T <= DEVICE_END_SLACK_MS;
        return { modes: ending ? ['service', 'free'] : ['service'], sessionId: null, lightAllowed: true };
      }
      if (h?.kind === 'pending') return { modes: ['pending', 'free'], sessionId: null, lightAllowed: false };
      if (h?.kind === 'reserved') return { modes: ['reserved', 'free'], sessionId: null, lightAllowed: false };
      return { modes: ['free', 'pending', 'reserved'], sessionId: null, lightAllowed: false };
    });
  }

  /** Расхождение state с базой дольше 10 с: событие в журнал и тревога (protocol §6). */
  async function onMismatch({ clubId, deviceId, expected: exp, state }) {
    await withContext(pool, sys(clubId), async (db) => {
      const device = await loadDevice(db, deviceId);
      const lightWithoutSession = state.relay === true && !exp.lightAllowed;
      await audit(db, {
        action: 'device.state_mismatch',
        objectType: 'device',
        objectId: deviceId,
        data: { mode: state.mode, relay: state.relay, session_id: state.session_id, expected: exp.modes, expected_session_id: exp.sessionId },
      });
      await alarm(db, clubId, {
        type: lightWithoutSession ? 'light_without_session' : 'state_mismatch',
        level: lightWithoutSession ? 'critical' : 'important',
        resourceId: device?.resource_id ?? null,
        data: { device_id: deviceId, mode: state.mode, relay: state.relay },
      });
    });
  }

  /** Офлайн дольше 120 с: тревога critical, только если на столе идёт сессия (decisions №16). */
  async function onOfflineAlarm({ clubId, deviceId, offlineMs }) {
    return withContext(pool, sys(clubId), async (db) => {
      const device = await loadDevice(db, deviceId);
      if (!device?.resource_id) return false;
      const s = await openSessionOn(db, device.resource_id);
      if (!s) return false;
      await alarm(db, clubId, {
        type: 'device_offline',
        level: 'critical',
        resourceId: device.resource_id,
        data: { device_id: deviceId, session_id: s.id, offline_s: Math.round(offlineMs / 1000) },
      });
      return true;
    });
  }

  async function onNoAck({ clubId, deviceId, entry }) {
    await withContext(pool, sys(clubId), async (db) => {
      const device = await loadDevice(db, deviceId);
      await alarm(db, clubId, {
        type: 'cmd_no_ack',
        level: 'important',
        resourceId: device?.resource_id ?? null,
        data: { device_id: deviceId, type: entry.type, seq: entry.seq },
      });
    });
  }

  return { prepare, actualState, onAck, onEvent, expected, onMismatch, onOfflineAlarm, onNoAck, sessionBody };
}
