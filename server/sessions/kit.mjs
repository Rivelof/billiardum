// Общие действия модуля light для сервиса сессий, планировщика и хуков моста:
// время (ctx.clock), журнал, outbox, тревоги, уведомления гостю, переходы сессии.

import { plural } from '@billiardum/shared/format';
import { isOpen, notifyLight, participants } from './queries.mjs';

/** Недоигранное время меньше этого не считается прерыванием (потери на перезагрузке, правило 4). */
export const UNPLAYED_THRESHOLD_MS = 60_000;
const MINUTES = ['минута', 'минуты', 'минут'];

const iso = (d) => new Date(d).toISOString();

/** Фаза идущей сессии по paid_until: active → ending (≤ warn_ms[0]) → grace. */
export function phaseOf(paidUntil, now, warnMs) {
  const left = new Date(paidUntil).getTime() - now.getTime();
  if (left <= 0) return 'grace';
  if (left <= warnMs[0]) return 'ending';
  return 'active';
}

/**
 * Сигналы гостю, порог которых уже пройден при создании или продлении сессии, не шлются
 * задним числом: «осталось 10 минут» при покупке 5 минут — шум.
 */
export function premarkNotified(notified, paidUntil, now) {
  const out = { ...(notified ?? {}) };
  const key = iso(paidUntil);
  const left = new Date(paidUntil).getTime() - now.getTime();
  if (left <= 10 * 60_000) out.t10 = key;
  if (left <= 60_000) out.t1 = key;
  return out;
}

export function minutesText(n) {
  return `${n} ${plural(n, MINUTES)}`;
}

/** Где закончилась игра на столе: до этого момента контроллер подтвердил свет. */
export function playEnd(s) {
  return new Date(s.device_paid_until ?? s.started_at);
}

export function unplayedMs(s) {
  return Math.max(0, new Date(s.paid_until).getTime() - playEnd(s).getTime());
}

/**
 * @param {{ deps: object, log: object, clock: { now(): Date }, getBridge?: () => any }} opts
 */
export function createKit({ deps, log, clock, getBridge = () => null }) {
  const now = () => clock.now();

  async function audit(db, entry) {
    return deps.audit.appendAudit(db, { actorType: 'system', ...entry });
  }

  async function emit(db, topic, payload) {
    await deps.outbox.enqueue(db, topic, payload);
  }

  async function alarm(db, clubId, { type, level, resourceId = null, data = {} }) {
    log.warn('alarm', { club_id: clubId, type, level, resource_id: resourceId });
    return deps.alarms.raise(db, clubId, { type, level, resourceId, data });
  }

  /**
   * Ручное действие персонала (инвариант 8): тревога critical и уведомление владельцу сразу.
   * Если тревога того же типа по столу уже открыта, core только увеличивает счётчик без
   * уведомления — тогда владельцу пишем напрямую: каждое ручное действие доходит до него.
   */
  async function manualAction(db, clubId, { type, resourceId = null, data = {}, text }) {
    const res = await alarm(db, clubId, { type, level: 'critical', resourceId, data });
    if (res && res.created === false && typeof deps.notify.sendToClubStaff === 'function') {
      await deps.notify.sendToClubStaff(db, clubId, ['owner'], { kind: 'alarm', level: 'critical', text, data: { type, url: '/club/' } });
    }
    return res;
  }

  /** Уведомление гостям сессии (без персональных данных: номер стола и время, decisions №53). */
  async function notifyParticipants(db, s, { kind, text, data = {} }, { payerOnly = false } = {}) {
    const list = await participants(db, s.id);
    for (const p of list) {
      if (payerOnly && p.user_id !== s.payer_user_id) continue;
      try {
        await deps.notify.send(db, p.user_id, { kind, text, data: { session_id: s.id, ...data } });
      } catch (err) {
        log.error('notify_failed', { session_id: s.id, kind, error: err.message });
      }
    }
  }

  function sessionEvent(s, extra = {}) {
    return { session_id: s.id, club_id: s.club_id, resource_id: s.resource_id, paid_until: iso(s.paid_until), ...extra };
  }

  /** Онлайн ли контроллер стола (мост знает точно; без моста — last_seen_at не старше 150 с). */
  function deviceOnline(device) {
    if (!device || !device.has_key) return false;
    const bridge = getBridge();
    if (bridge?.deviceInfo) return bridge.deviceInfo(device.id)?.online === true;
    return Boolean(device.last_seen_at) && now().getTime() - new Date(device.last_seen_at).getTime() <= 150_000;
  }

  /**
   * Сессия прервана: контроллер доиграл без связи, а оплачено больше (контракт M1 §6, T6).
   * Свет не возвращается сам: гость выбирает «Продолжить игру» или «Вернуть деньги».
   */
  async function markInterrupted(db, s, t, unplayed) {
    if (!isOpen(s)) return false;
    await db.query(
      `update bl.sessions set status = 'interrupted', interrupted_at = $2, unplayed_ms = $3, updated_at = $2 where id = $1`,
      [s.id, t, unplayed],
    );
    await audit(db, {
      action: 'session.interrupted',
      objectType: 'session',
      objectId: s.id,
      data: { session_id: s.id, paid_until: iso(s.paid_until), unplayed_ms: unplayed, device_paid_until: s.device_paid_until ? iso(s.device_paid_until) : null },
    });
    await emit(db, 'session.interrupted', sessionEvent(s, { unplayed_ms: unplayed }));
    const minutes = Math.max(1, Math.round(unplayed / 60_000));
    await notifyParticipants(
      db,
      s,
      {
        kind: 'session.interrupted',
        text: `Стол ${s.resource_number}: связь со столом прерывалась, свет погас раньше времени. Продолжить игру или вернуть деньги за ${minutesText(minutes)}?`,
        data: { action: 'resolve', actions: 'continue,refund', unplayed_ms: unplayed },
      },
      { payerOnly: true },
    );
    await notifyLight(db, { k: 'session', c: s.club_id, s: s.id, r: s.resource_id });
    log.warn('session_interrupted', { session_id: s.id, unplayed_ms: unplayed });
    return true;
  }

  return { now, audit, emit, alarm, manualAction, notifyParticipants, sessionEvent, deviceOnline, markInterrupted };
}
