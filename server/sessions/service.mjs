// Сессии стола (контракт M1 §6): оплата → старт и продление, остановка плательщиком,
// «Я играю за этим столом», выбор после interrupted, продление без оплаты, сервисный свет,
// поиск стола, зал, удержание pending (§13, для money) и шаг планировщика.
//
// Все функции принимают db — клиента транзакции. Команды контроллеру ставятся в
// bl.device_commands в той же транзакции и уходят после коммита (queries.queueCommand).

import { createHash } from 'node:crypto';
import { formatMoney, formatTime } from '@billiardum/shared/format';
import { afterCommit } from '../lib/store.mjs';
import { normalizeCode } from './codes.mjs';
import { fail, LightError } from './errors.mjs';
import { createKit, minutesText, phaseOf, playEnd, premarkNotified, UNPLAYED_THRESHOLD_MS, unplayedMs } from './kit.mjs';
import {
  activeHold,
  activeReserved,
  addParticipant,
  currentClub,
  deviceOfResource,
  enterClub,
  isOpen,
  isUuid,
  loadClub,
  loadResource,
  loadSession,
  lockResource,
  notifyLight,
  openSessionOn,
  OPEN_STATUSES,
  participants,
  queueCommand,
  releaseHold,
  resourceClub,
  rolesIn,
  sessionClub,
} from './queries.mjs';
import { graceMs, safeZone, serviceMaxMinutes, warnMs } from './settings.mjs';
import { sessionSummary, sessionView } from './view.mjs';

export const PENDING_MAX_MS = 30 * 60_000;
export const MAX_FREE_EXTEND_MINUTES = 240;
export const MAX_IDENTIFY_SECONDS = 600;
export const MAX_PARTICIPANTS = 20;
export const UNLIMITED_DEFAULT_MINUTES = 120;
/** «Без лимита»: за сколько до extend_limit_until просить подтвердить продолжение (decisions №69). */
export const UNLIMITED_CONFIRM_MS = 5 * 60_000;
/** Продлить можно до начала брони следующего гостя минус 5 минут (decisions №106). */
export const BOOKING_GAP_MS = 5 * 60_000;
/** Срок выбора гостя после interrupted (decisions №65). */
export const INTERRUPTED_DECIDE_MS = 24 * 3600_000;
/** Коды причины сервисного света (контракт §14). */
export const SERVICE_REASONS = Object.freeze(['cleaning', 'repair', 'training', 'other']);
export const ROLES = Object.freeze({
  staff: ['owner', 'manager', 'reception', 'installer'],
  reception: ['owner', 'manager', 'reception'],
  manager: ['owner', 'manager'],
  installer: ['owner', 'installer'],
});
const MINUTE = 60_000;

const iso = (d) => (d ? new Date(d).toISOString() : null);
const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function cleanText(v, max = 2000) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/**
 * @param {{ deps: object, log: object, clock: { now(): Date }, getBridge?: () => any }} opts
 */
export function createLightService(opts) {
  const { deps, log } = opts;
  const kit = createKit(opts);
  const { now, audit, emit, alarm, manualAction, notifyParticipants, sessionEvent, deviceOnline, markInterrupted } = kit;

  // Контекст и права ---------------------------------------------------------------

  async function enterSession(db, sessionId) {
    const clubId = await sessionClub(db, sessionId);
    if (!clubId) fail('not_found', 'session');
    await enterClub(db, clubId);
    return clubId;
  }

  async function enterResource(db, resourceId) {
    const clubId = await resourceClub(db, resourceId);
    if (!clubId) fail('not_found', 'resource');
    await enterClub(db, clubId);
    return clubId;
  }

  /** Для интерфейса §13: без контекста клуба — перейти в клуб ресурса; с контекстом — RLS. */
  async function ensureResourceClub(db, resourceId) {
    if ((await currentClub(db)) !== null) return;
    const clubId = await resourceClub(db, resourceId);
    if (clubId) await enterClub(db, clubId);
  }

  async function requireRole(db, clubId, userId, allowed) {
    const roles = await rolesIn(db, clubId, userId);
    if (!roles.some((r) => allowed.includes(r))) fail('forbidden', 'role');
    return roles;
  }

  /** Предел продления из-за брони следующего гостя: её начало минус 5 минут (№106). */
  async function bookingLimit(db, s) {
    if (!isOpen(s)) return null;
    const next = await deps.bookings.nextBookingStart(db, { resourceId: s.resource_id, after: now() });
    if (!next) return null;
    return new Date(new Date(next).getTime() - BOOKING_GAP_MS);
  }

  async function view(db, s, userId) {
    return sessionView(s, { now: now(), userId, participants: await participants(db, s.id), bookingLimit: await bookingLimit(db, s) });
  }

  /**
   * outbox session.closed (§13): общие поля и, для депозита наличными (№112), расчёт для money:
   * used_kopecks — фактическое время по тарифу (не дольше оплаченного), не больше депозита.
   */
  async function closedEvent(db, s, { endedAt, reason, extra = {} }) {
    const out = sessionEvent(s, { started_at: iso(s.started_at), ended_at: iso(endedAt), unlimited: s.unlimited, reason, ...extra });
    if (s.booking_id) out.booking_id = s.booking_id;
    if (s.deposit_kopecks) {
      const to = new Date(Math.min(new Date(endedAt).getTime(), s.paid_until.getTime()));
      let used = 0;
      if (to > s.started_at) {
        const a = await deps.tariffs.amountForActual(db, { resourceId: s.resource_id, from: s.started_at, to });
        used = Math.min(s.deposit_kopecks, Number(a.amount_kopecks));
      }
      out.deposit_kopecks = s.deposit_kopecks;
      out.used_kopecks = used;
    }
    return out;
  }

  async function command(db, s, { type, body = {}, cause, paymentId = null }) {
    const device = await deviceOfResource(db, s.resource_id);
    if (!device) {
      log.warn('light_no_device', { session_id: s.id, resource_id: s.resource_id, type });
      return null;
    }
    return queueCommand(db, { clubId: s.club_id, deviceId: device.id, type, body, cause, sessionId: s.id, paymentId, now: now() });
  }

  async function changed(db, s) {
    await notifyLight(db, { k: 'session', c: s.club_id, s: s.id, r: s.resource_id });
  }

  // Статус стола и удержание (§13, light → money) ----------------------------------

  /**
   * Статус стола. online — связь с контроллером сейчас, при любом статусе: у reserved, service,
   * pending статус главнее offline, а booking надо видеть, что стол без связи (регресс R1).
   */
  async function resourceStatus(db, resourceId, { userId = null } = {}) {
    await ensureResourceClub(db, resourceId);
    const t = now();
    const online = deviceOnline(await deviceOfResource(db, resourceId));
    const s = await openSessionOn(db, resourceId);
    if (s) return { status: 'busy', busy_until: iso(s.paid_until), session_id: s.id, online };
    const h = await activeHold(db, resourceId, t);
    if (h?.kind === 'service') return { status: 'service', busy_until: iso(h.until), session_id: null, online };
    if (h?.kind === 'pending') return { status: 'pending', busy_until: iso(h.until), session_id: null, pending_mine: userId !== null && h.user_id === userId, online };
    if (h?.kind === 'reserved') return { status: 'reserved', busy_until: iso(h.until), session_id: null, online };
    if (!online) return { status: 'offline', busy_until: null, session_id: null, online };
    return { status: 'free', busy_until: null, session_id: null, online };
  }

  /**
   * Доступен ли стол в окне [from, to] (для booking, регресс R1 №128): по истории и текущему
   * состоянию. Причины: offline (эпизоды без связи bl.device_offline; связи нет сейчас — до to;
   * стол без контроллера — всё окно), session (игра), service, inactive, foreign_hold (чужое
   * удержание pending/reserved). Не учитываются удержание этой брони (source + refId) и игра
   * самого гостя (userId — плательщик или участник; и сессия этой брони). from = to — «сейчас».
   * @returns {Promise<{ unavailable: boolean, reasons: string[], intervals: { reason: string, from: string, to: string }[] }>}
   */
  async function availabilityDuring(db, { resourceId, from, to, userId = null, source = null, refId = null }) {
    if (!isUuid(resourceId)) fail('bad_request', 'resourceId');
    if (userId !== null && !isUuid(userId)) fail('bad_request', 'userId');
    if (refId !== null && !isUuid(refId)) fail('bad_request', 'refId');
    if (source !== null && !['booking', 'waitlist', 'staff'].includes(source)) fail('bad_request', 'source');
    const F = new Date(from).getTime();
    const T0 = new Date(to).getTime();
    if (!Number.isFinite(F) || !Number.isFinite(T0) || T0 < F || T0 - F > 7 * 24 * 3600_000) fail('bad_request', 'window');
    // Точка («сейчас») — как окно в 1 мс: интервал [a, b) задевает её, если a ≤ from < b.
    const T = Math.max(T0, F + 1);
    await ensureResourceClub(db, resourceId);
    const t = now();
    const res = await loadResource(db, resourceId);
    if (!res) fail('not_found', 'resource');
    const intervals = [];
    const add = (reason, a, b) => {
      const lo = Math.max(F, new Date(a).getTime());
      const hi = Math.min(T, b === null ? T : new Date(b).getTime());
      if (hi > lo) intervals.push({ reason, from: new Date(lo).toISOString(), to: new Date(Math.min(hi, Math.max(T0, lo))).toISOString(), lo });
    };
    if (!res.active) add('inactive', F, T);
    const ownBooking = source === 'booking' && refId !== null ? refId : null;
    const sessions = await db.query(
      `select s.id, s.status, s.started_at, s.ended_at, s.paid_until, s.grace_ms, s.interrupted_at, s.booking_id,
              (s.payer_user_id = $4 or exists (select 1 from bl.session_participants p where p.session_id = s.id and p.user_id = $4)) as mine
         from bl.sessions s
        where s.resource_id = $1 and s.started_at < $3 and (s.ended_at is null or s.ended_at > $2)`,
      [resourceId, new Date(F), new Date(T), userId],
    );
    for (const x of sessions.rows) {
      if (x.mine || (ownBooking && x.booking_id === ownBooking)) continue;
      let end;
      if (OPEN_STATUSES.includes(x.status)) end = Math.max(x.paid_until.getTime() + x.grace_ms, t.getTime());
      else if (x.status === 'interrupted') end = (x.interrupted_at ?? x.started_at).getTime(); // стол не держит
      else end = (x.ended_at ?? x.paid_until).getTime();
      add('session', x.started_at, end);
    }
    const holds = await db.query(
      `select kind, source, ref_id, user_id, created_at, least(until, coalesce(released_at, until)) as ends
         from bl.resource_holds
        where resource_id = $1 and created_at < $3 and least(until, coalesce(released_at, until)) > $2`,
      [resourceId, new Date(F), new Date(T)],
    );
    for (const h of holds.rows) {
      if (h.kind === 'service') add('service', h.created_at, h.ends);
      else if (source !== null && refId !== null && h.source === source && h.ref_id === refId) continue; // удержание этой брони
      else if (h.kind === 'pending' && userId !== null && h.user_id === userId) continue; // гость сам идёт к оплате
      else add('foreign_hold', h.created_at, h.ends);
    }
    const device = await deviceOfResource(db, resourceId);
    if (!device) {
      add('offline', F, T);
    } else {
      let since = null;
      await db.query('savepoint light_offline_hist');
      try {
        const eps = await db.query(
          `select offline_from, online_at from bl.device_offline
            where device_id = $1 and offline_from < $3 and (online_at is null or online_at > $2) order by offline_from`,
          [device.id, new Date(F), new Date(T)],
        );
        await db.query('release savepoint light_offline_hist');
        for (const e of eps.rows) {
          if (e.online_at === null) since = e.offline_from;
          else add('offline', e.offline_from, e.online_at);
        }
      } catch (err) {
        await db.query('rollback to savepoint light_offline_hist');
        if (err?.code !== '42P01') throw err;
      }
      // Связи нет сейчас: стол недоступен с начала эпизода (или с последнего контакта) до конца окна.
      if (!deviceOnline(device)) add('offline', since ?? device.last_seen_at ?? F, T);
    }
    intervals.sort((a, b) => a.lo - b.lo);
    const out = intervals.map(({ reason, from: a, to: b }) => ({ reason, from: a, to: b }));
    const reasons = [...new Set(out.map((x) => x.reason))];
    return { unavailable: out.length > 0, reasons, intervals: out };
  }

  /** Гость перешёл к оплате: стол за ним на until (3 минуты). Гонку решает FOR UPDATE ресурса. */
  async function holdPending(db, { resourceId, userId, until }) {
    const t = now();
    const u = new Date(until);
    if (!isUuid(userId) || Number.isNaN(u.getTime()) || u <= t || u.getTime() - t.getTime() > PENDING_MAX_MS) fail('bad_request', 'until');
    await ensureResourceClub(db, resourceId);
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    if (await openSessionOn(db, resourceId)) fail('table_busy');
    const h = await activeHold(db, resourceId, t);
    if (h?.kind === 'service') fail('table_service');
    if (h && h.user_id !== userId) fail(h.kind === 'pending' ? 'table_pending' : 'table_busy');
    // Владелец брони начинает игру по брони (предоплата уже внесена), а не обычной оплатой по QR (№128).
    if (h?.kind === 'reserved' && h.source === 'booking') throw new LightError('booking_start_required', 'booking', { booking_id: h.ref_id ?? null });
    const device = await deviceOfResource(db, resourceId);
    if (!deviceOnline(device)) fail('table_offline');
    let holdId;
    if (h?.kind === 'pending') {
      await db.query('update bl.resource_holds set until = $2 where id = $1', [h.id, u]);
      holdId = h.id;
    } else {
      if (h) await releaseHold(db, h.id, t, 'replaced');
      const ins = await db.query(
        `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, created_at)
         values ($1, $2, 'pending', $3, $4, $5) returning id`,
        [res.club_id, resourceId, userId, u, t],
      );
      holdId = ins.rows[0].id;
    }
    await queueCommand(db, { clubId: res.club_id, deviceId: device.id, type: 'state.pending', body: {}, cause: 'hold', now: t });
    await notifyLight(db, { k: 'hall', c: res.club_id, r: resourceId });
    return { ok: true, hold_id: holdId, until: u.toISOString() };
  }

  async function releasePending(db, { resourceId, userId }) {
    await ensureResourceClub(db, resourceId);
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res) return { ok: true, released: false };
    const h = await activeHold(db, resourceId, t);
    if (!h || h.kind !== 'pending' || h.user_id !== userId) return { ok: true, released: false };
    await releaseHold(db, h.id, t, 'released');
    if (!(await openSessionOn(db, resourceId))) {
      const device = await deviceOfResource(db, resourceId);
      if (device) await queueCommand(db, { clubId: res.club_id, deviceId: device.id, type: 'state.free', body: {}, cause: 'hold', now: t });
    }
    await notifyLight(db, { k: 'hall', c: res.club_id, r: resourceId });
    return { ok: true, released: true };
  }

  /** Стол по коду (/api/t/{code}). Переводит транзакцию в контекст клуба стола. */
  async function getResourceByCode(db, code) {
    const c = normalizeCode(code);
    if (!c) return null;
    const { rows } = await db.query('select resource_id, club_id from bl.resource_by_code($1)', [c]);
    if (rows.length === 0) return null;
    const cur = await currentClub(db);
    if (cur !== null && cur !== rows[0].club_id) return null;
    await enterClub(db, rows[0].club_id);
    const r = await loadResource(db, rows[0].resource_id);
    const club = await loadClub(db, rows[0].club_id);
    if (!r || !club) return null;
    return {
      resource: { id: r.id, club_id: r.club_id, number: r.number, type: r.type, title: r.title, code: r.code },
      club: { id: club.id, name: club.name, timezone: club.timezone, settings: club.settings },
    };
  }

  async function getSessionForExtend(db, { sessionId, userId }) {
    const clubId = await sessionClub(db, sessionId);
    if (!clubId) return null;
    const cur = await currentClub(db);
    if (cur !== null && cur !== clubId) return null;
    await enterClub(db, clubId);
    const s = await loadSession(db, sessionId);
    if (!s) return null;
    const list = await participants(db, sessionId);
    return {
      id: s.id,
      club_id: s.club_id,
      resource_id: s.resource_id,
      paid_until: iso(s.paid_until),
      status: s.status,
      is_participant: list.some((p) => p.user_id === userId),
      is_payer: s.payer_user_id === userId,
      unlimited: s.unlimited,
      grace_ms: s.grace_ms,
    };
  }

  // Оплата (outbox payment.confirmed, контракт §6) ------------------------------------

  async function paymentConfirmedAt(db, paymentId) {
    // Таблица money (0200). Без неё (тесты light, параллельная разработка) — без метрики.
    await db.query('savepoint light_confirmed_at');
    try {
      const { rows } = await db.query('select confirmed_at from bl.payments where id = $1', [paymentId]);
      await db.query('release savepoint light_confirmed_at');
      return rows[0]?.confirmed_at ?? null;
    } catch {
      await db.query('rollback to savepoint light_confirmed_at');
      return null;
    }
  }

  /** bl.payments.session_id (money) — один раз; без таблицы money (тесты light) — пропуск. */
  async function linkPayment(db, paymentId, sessionId) {
    await db.query('savepoint light_link_payment');
    try {
      await db.query('update bl.payments set session_id = $2 where id = $1 and session_id is null', [paymentId, sessionId]);
      await db.query('release savepoint light_link_payment');
    } catch (err) {
      await db.query('rollback to savepoint light_link_payment');
      if (err?.code !== '42P01') log.warn('payment_link_failed', { payment_id: paymentId, code: err?.code ?? null });
    }
  }

  function validPayment(p) {
    return (
      p &&
      isUuid(p.payment_id) &&
      isUuid(p.club_id) &&
      (p.kind === 'start' || p.kind === 'extend') &&
      (p.kind === 'start' ? isUuid(p.resource_id) && isUuid(p.user_id) : isUuid(p.session_id)) &&
      (p.minutes === null || p.minutes === undefined || intIn(p.minutes, 1, 1440)) &&
      (p.minutes || p.unlimited) &&
      intIn(p.amount_kopecks, 0, Number.MAX_SAFE_INTEGER)
    );
  }

  async function recordPayment(db, p, { sessionId, outcome, minutes, confirmedAt, refunded = 0 }) {
    await db.query(
      `insert into bl.session_payments
         (payment_id, club_id, session_id, quote_id, kind, outcome, minutes, unlimited, amount_kopecks, method, refunded_kopecks, confirmed_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        p.payment_id,
        p.club_id,
        sessionId,
        isUuid(p.quote_id) ? p.quote_id : null,
        p.kind,
        outcome,
        minutes,
        Boolean(p.unlimited),
        p.amount_kopecks,
        typeof p.method === 'string' && /^[a-z_]{1,32}$/.test(p.method) ? p.method : null,
        refunded,
        confirmedAt,
        now(),
      ],
    );
  }

  /** Стол занят к моменту оплаты (крайний случай): тревога и автоматический возврат. */
  async function rejectPayment(db, p, { reason, resourceId, minutes, confirmedAt, cap = null }) {
    await recordPayment(db, p, { sessionId: null, outcome: 'refunded', minutes, confirmedAt, refunded: p.amount_kopecks });
    if (p.amount_kopecks > 0) {
      await deps.payments.refund(db, { paymentId: p.payment_id, amountKopecks: p.amount_kopecks, reason: `light_${reason}` });
    }
    await audit(db, {
      action: 'session.start_rejected',
      objectType: 'resource',
      objectId: isUuid(resourceId) ? resourceId : null,
      data: { payment_id: p.payment_id, reason, amount_kopecks: p.amount_kopecks, kind: p.kind },
    });
    await alarm(db, p.club_id, {
      type: 'payment_conflict',
      level: 'important',
      resourceId: isUuid(resourceId) ? resourceId : null,
      data: { payment_id: p.payment_id, reason, amount_kopecks: p.amount_kopecks },
    });
    if (reason === 'booking' && cap) await notifyBookingCut(db, p, { resourceId, sessionId: null, cap, refund: p.amount_kopecks, cutMs: minutes * MINUTE });
    log.warn('payment_rejected', { payment_id: p.payment_id, reason });
    return { result: 'refunded', reason };
  }

  /** Предел игры из-за ближайшей брони (№129): её начало минус 5 минут, или null. */
  async function bookingCap(db, resourceId, t) {
    const next = await deps.bookings.nextBookingStart(db, { resourceId, after: t });
    return next ? new Date(new Date(next).getTime() - BOOKING_GAP_MS) : null;
  }

  async function notifyBookingCut(db, p, { resourceId, sessionId, cap, refund, cutMs }) {
    if (!isUuid(p.user_id)) return;
    const club = await loadClub(db, p.club_id);
    const r = await loadResource(db, resourceId);
    const at = formatTime(new Date(cap.getTime() + BOOKING_GAP_MS), safeZone(club.timezone));
    const cutMin = Math.max(1, Math.round(cutMs / MINUTE));
    try {
      await deps.notify.send(db, p.user_id, {
        kind: 'session.booking_cut',
        text: `Стол ${r?.number ?? ''}: забронирован на ${at}, вернули ${formatMoney(refund)} за ${minutesText(cutMin)}`,
        data: { session_id: sessionId, refund_kopecks: refund, booking_start: new Date(cap.getTime() + BOOKING_GAP_MS).toISOString() },
      });
    } catch (err) {
      log.error('notify_failed', { kind: 'session.booking_cut', error: err.message });
    }
  }

  /**
   * Игра обрезана бронью (№129): вернуть гостю долю платежа за cutMs (частичный возврат,
   * детерминированный ключ от платежа), журнал session.booking_cut, уведомление гостю.
   * «Без лимита» по карте не возвращается: money спишет фактическое время.
   */
  async function refundCut(db, p, s, { cutMs, minutes, cap }) {
    const covered = minutes * MINUTE;
    const take = Math.min(cutMs, covered);
    let refund = 0;
    if (!p.unlimited && p.amount_kopecks > 0 && take > 0) {
      refund = take >= covered - UNSHOWN_TOLERANCE_MS ? p.amount_kopecks : Math.min(p.amount_kopecks, Math.ceil((p.amount_kopecks * take) / covered));
      await deps.payments.refund(db, { paymentId: p.payment_id, amountKopecks: refund, reason: 'booking_conflict', key: `booking-cut-${p.payment_id}` });
      await db.query('update bl.session_payments set refunded_kopecks = least(amount_kopecks, refunded_kopecks + $2) where payment_id = $1', [p.payment_id, refund]);
    }
    await audit(db, {
      action: 'session.booking_cut',
      objectType: 'session',
      objectId: s.id,
      data: { session_id: s.id, payment_id: p.payment_id, cut_ms: take, refund_kopecks: refund, paid_until: iso(cap) },
    });
    if (refund > 0) await notifyBookingCut(db, p, { resourceId: s.resource_id, sessionId: s.id, cap, refund, cutMs: take });
    log.info('session_booking_cut', { session_id: s.id, cut_ms: take, refund_kopecks: refund });
    return refund;
  }

  async function startFromPayment(db, p, t, confirmedAt, minutes) {
    const res = await lockResource(db, p.resource_id);
    if (!res || res.club_id !== p.club_id) return rejectPayment(db, p, { reason: 'no_resource', resourceId: null, minutes, confirmedAt });
    const open = await openSessionOn(db, res.id);
    const h = await activeHold(db, res.id, t);
    let busy = null;
    if (open) busy = 'busy';
    else if (h?.kind === 'service') busy = 'service';
    else if (h && h.user_id !== p.user_id) busy = h.kind;
    if (busy) return rejectPayment(db, p, { reason: busy, resourceId: res.id, minutes, confirmedAt });
    // Игра не заходит в интервал брони (№129): бронь могли создать между котировкой и оплатой.
    const cap = await bookingCap(db, res.id, t);
    if (cap && cap.getTime() - t.getTime() < MINUTE) return rejectPayment(db, p, { reason: 'booking', resourceId: res.id, minutes, confirmedAt, cap });

    const club = await loadClub(db, p.club_id);
    const warn = warnMs(club.settings);
    let paidUntil = new Date(t.getTime() + minutes * MINUTE);
    let cutMs = 0;
    if (cap && paidUntil > cap) {
      cutMs = paidUntil.getTime() - cap.getTime();
      paidUntil = cap;
    }
    const ins = await db.query(
      `insert into bl.sessions (club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until,
                                warn_ms, grace_ms, notified, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $7, $7) returning id`,
      [
        p.club_id,
        res.id,
        phaseOf(paidUntil, t, warn),
        ['cash', 'card_terminal'].includes(p.method) ? 'reception' : 'qr',
        p.user_id,
        Boolean(p.unlimited),
        t,
        paidUntil,
        warn,
        graceMs(club.settings),
        JSON.stringify(premarkNotified({}, paidUntil, t)),
      ],
    );
    const s = await loadSession(db, ins.rows[0].id);
    await addParticipant(db, { session: s, userId: p.user_id, role: 'payer', now: t });
    await recordPayment(db, p, { sessionId: s.id, outcome: 'applied', minutes, confirmedAt });
    await linkPayment(db, p.payment_id, s.id);
    if (cutMs > 0) await refundCut(db, p, s, { cutMs, minutes, cap });
    if (h && h.user_id === p.user_id) await releaseHold(db, h.id, t, 'session');
    await audit(db, {
      action: 'session.start',
      objectType: 'session',
      objectId: s.id,
      data: { session_id: s.id, paid_until: iso(paidUntil), payment_id: p.payment_id, resource_id: res.id, minutes, unlimited: s.unlimited },
    });
    await emit(db, 'session.started', sessionEvent(s));
    await command(db, s, { type: 'session.start', body: { session_id: s.id }, cause: 'payment', paymentId: p.payment_id });
    await changed(db, s);
    log.info('session_started', { session_id: s.id, resource_id: res.id, minutes });
    return { result: 'started', session_id: s.id };
  }

  async function extendFromPayment(db, p, t, confirmedAt, minutes) {
    const s = await loadSession(db, p.session_id, { lock: true });
    if (!s || s.club_id !== p.club_id) return rejectPayment(db, p, { reason: 'no_session', resourceId: p.resource_id, minutes, confirmedAt });
    const add = minutes * MINUTE;
    if (isOpen(s)) {
      // paid_until += minutes; из льготы тоже (контракт §6). Не дальше брони (№129).
      let paidUntil = new Date(s.paid_until.getTime() + add);
      const cap = await bookingCap(db, s.resource_id, t);
      if (cap && cap.getTime() - Math.max(s.paid_until.getTime(), t.getTime()) < MINUTE) {
        return rejectPayment(db, p, { reason: 'booking', resourceId: s.resource_id, minutes, confirmedAt, cap });
      }
      let cutMs = 0;
      if (cap && paidUntil > cap) {
        cutMs = paidUntil.getTime() - cap.getTime();
        paidUntil = cap;
      }
      await db.query(
        `update bl.sessions set paid_until = $2, status = $3, notified = $4::jsonb, updated_at = $5 where id = $1`,
        [s.id, paidUntil, phaseOf(paidUntil, t, s.warn_ms), JSON.stringify(premarkNotified(s.notified, paidUntil, t)), t],
      );
      if (isUuid(p.user_id)) await addParticipant(db, { session: s, userId: p.user_id, role: 'player', now: t });
      await recordPayment(db, p, { sessionId: s.id, outcome: 'applied', minutes, confirmedAt });
      if (cutMs > 0) await refundCut(db, p, s, { cutMs, minutes, cap });
      await audit(db, {
        action: 'session.extend',
        objectType: 'session',
        objectId: s.id,
        data: { session_id: s.id, paid_until: iso(paidUntil), payment_id: p.payment_id, minutes },
      });
      await emit(db, 'session.extended', sessionEvent({ ...s, paid_until: paidUntil }));
      await command(db, s, { type: 'session.extend', body: { session_id: s.id }, cause: 'payment', paymentId: p.payment_id });
      await changed(db, s);
      log.info('session_extended', { session_id: s.id, minutes });
      return { result: 'extended', session_id: s.id };
    }
    if (s.status === 'interrupted') {
      // Свет уже погас: оплаченное время добавляется к недоигранному, гость выбирает сам.
      const paidUntil = new Date(s.paid_until.getTime() + add);
      await db.query('update bl.sessions set paid_until = $2, unplayed_ms = unplayed_ms + $3, updated_at = $4 where id = $1', [
        s.id,
        paidUntil,
        add,
        t,
      ]);
      await recordPayment(db, p, { sessionId: s.id, outcome: 'applied', minutes, confirmedAt });
      await audit(db, {
        action: 'session.extend',
        objectType: 'session',
        objectId: s.id,
        data: { session_id: s.id, paid_until: iso(paidUntil), payment_id: p.payment_id, minutes, interrupted: true },
      });
      await emit(db, 'session.extended', sessionEvent({ ...s, paid_until: paidUntil }));
      await changed(db, s);
      return { result: 'extended_interrupted', session_id: s.id };
    }
    if (s.status === 'closed' && s.close_reason === 'expired') {
      // Продление оплачено в льготу, а подтверждение пришло после закрытия: если стол
      // свободен, игра продолжается с момента подтверждения; иначе — возврат.
      const res = await lockResource(db, s.resource_id);
      const open = await openSessionOn(db, s.resource_id);
      const h = await activeHold(db, s.resource_id, t);
      if (!res || open || (h && (h.kind === 'service' || h.user_id !== p.user_id))) {
        return rejectPayment(db, p, { reason: 'busy', resourceId: s.resource_id, minutes, confirmedAt });
      }
      const cap = await bookingCap(db, s.resource_id, t);
      if (cap && cap.getTime() - t.getTime() < MINUTE) {
        return rejectPayment(db, p, { reason: 'booking', resourceId: s.resource_id, minutes, confirmedAt, cap });
      }
      if (h) await releaseHold(db, h.id, t, 'session');
      let paidUntil = new Date(t.getTime() + add);
      let cutMs = 0;
      if (cap && paidUntil > cap) {
        cutMs = paidUntil.getTime() - cap.getTime();
        paidUntil = cap;
      }
      await db.query(
        // Новый отрезок игры начинается сейчас: всё до t уже сыграно (или возвращено). Без этого
        // неотыгранное считалось бы от started_at и включало прошлые отрезки (инвариант 4).
        `update bl.sessions set status = $2, paid_until = $3, ended_at = null, close_reason = null, device_paid_until = $5,
                                notified = $4::jsonb, updated_at = $5 where id = $1`,
        [s.id, phaseOf(paidUntil, t, s.warn_ms), paidUntil, JSON.stringify(premarkNotified({}, paidUntil, t)), t],
      );
      if (isUuid(p.user_id)) await addParticipant(db, { session: s, userId: p.user_id, role: 'player', now: t });
      await recordPayment(db, p, { sessionId: s.id, outcome: 'applied', minutes, confirmedAt });
      if (cutMs > 0) await refundCut(db, p, s, { cutMs, minutes, cap });
      await audit(db, {
        action: 'session.extend',
        objectType: 'session',
        objectId: s.id,
        data: { session_id: s.id, paid_until: iso(paidUntil), payment_id: p.payment_id, minutes, reopened: true },
      });
      await emit(db, 'session.extended', sessionEvent({ ...s, paid_until: paidUntil }));
      await command(db, s, { type: 'session.start', body: { session_id: s.id }, cause: 'payment', paymentId: p.payment_id });
      await changed(db, s);
      return { result: 'reopened', session_id: s.id };
    }
    return rejectPayment(db, p, { reason: 'session_closed', resourceId: s.resource_id, minutes, confirmedAt });
  }

  /**
   * Обработчик outbox payment.confirmed. Идемпотентен по payment_id (bl.session_payments).
   * db — транзакция outbox; контекст клуба ставится по payload.club_id.
   */
  async function onPaymentConfirmed(db, p) {
    // Платежи не за стол (бар M2 и др.) — не дело light: без тревоги и без записи.
    if (p && typeof p === 'object' && p.kind !== 'start' && p.kind !== 'extend' && typeof p.kind === 'string' && /^[a-z_]{1,32}$/.test(p.kind)) {
      log.debug('payment_confirmed_ignored', { payment_id: isUuid(p.payment_id) ? p.payment_id : null, kind: p.kind });
      return { result: 'ignored' };
    }
    if (!validPayment(p)) {
      log.error('payment_confirmed_invalid', { payment_id: isUuid(p?.payment_id) ? p.payment_id : null });
      if (isUuid(p?.club_id)) {
        await enterClub(db, p.club_id);
        await alarm(db, p.club_id, { type: 'payment_unapplied', level: 'critical', data: { payment_id: isUuid(p.payment_id) ? p.payment_id : null } });
      }
      return { result: 'invalid' };
    }
    await enterClub(db, p.club_id);
    await db.query("select set_config('app.actor_type', 'system', true)");
    const dup = await db.query('select session_id, outcome from bl.session_payments where payment_id = $1', [p.payment_id]);
    if (dup.rowCount > 0) return { result: 'duplicate', session_id: dup.rows[0].session_id };
    const t = now();
    const confirmedAt = await paymentConfirmedAt(db, p.payment_id);
    const minutes = p.minutes ?? UNLIMITED_DEFAULT_MINUTES;
    if (p.kind === 'start') return startFromPayment(db, p, t, confirmedAt, minutes);
    return extendFromPayment(db, p, t, confirmedAt, minutes);
  }

  /** Сколько возвращено по платежу (bl.refunds, money); без таблицы money — null. */
  async function refundedTotal(db, paymentId) {
    await db.query('savepoint light_refunded');
    try {
      const { rows } = await db.query(
        "select coalesce(sum(amount_kopecks), 0)::bigint as total from bl.refunds where payment_id = $1 and status in ('succeeded', 'manual')",
        [paymentId],
      );
      await db.query('release savepoint light_refunded');
      return Number(rows[0].total);
    } catch {
      await db.query('rollback to savepoint light_refunded');
      return null;
    }
  }

  /**
   * outbox payment.refunded. Сумма возвратов платежа сверяется по bl.refunds (событие несёт
   * сумму одного возврата, а возвраты самого light уже учтены). Если возвращено всё
   * оплаченное, идущая сессия отменяется и свет гаснет (возврат персоналом, money).
   */
  async function onPaymentRefunded(db, p) {
    if (!p || !isUuid(p.club_id) || !isUuid(p.payment_id)) return { result: 'invalid' };
    await enterClub(db, p.club_id);
    await db.query("select set_config('app.actor_type', 'system', true)");
    const row = await db.query('select session_id from bl.session_payments where payment_id = $1', [p.payment_id]);
    if (row.rowCount === 0 || !row.rows[0].session_id) return { result: 'ignored' };
    const total = await refundedTotal(db, p.payment_id);
    if (total !== null) {
      await db.query('update bl.session_payments set refunded_kopecks = least(amount_kopecks, greatest(refunded_kopecks, $2)) where payment_id = $1', [
        p.payment_id,
        total,
      ]);
    }
    const s = await loadSession(db, row.rows[0].session_id, { lock: true });
    if (!s || !isOpen(s)) return { result: 'ignored' };
    const totals = await db.query(
      "select coalesce(sum(amount_kopecks), 0) as paid, coalesce(sum(refunded_kopecks), 0) as refunded from bl.session_payments where session_id = $1 and outcome = 'applied'",
      [s.id],
    );
    if (Number(totals.rows[0].refunded) < Number(totals.rows[0].paid)) {
      await changed(db, s);
      return { result: 'partial' };
    }
    const t = now();
    await db.query("update bl.sessions set status = 'cancelled', ended_at = $2, close_reason = 'cancelled', updated_at = $2 where id = $1", [s.id, t]);
    await audit(db, { action: 'session.stop', objectType: 'session', objectId: s.id, data: { session_id: s.id, paid_until: iso(s.paid_until), payment_id: p.payment_id, reason: 'refunded' } });
    await emit(db, 'session.closed', await closedEvent(db, s, { endedAt: t, reason: 'cancelled' }));
    await command(db, s, { type: 'session.stop', body: { session_id: s.id, reason_code: 'refunded' }, cause: 'system' });
    await showReservedIfAny(db, s, t);
    await changed(db, s);
    return { result: 'cancelled', session_id: s.id };
  }

  // Бронь и депозит (M3, контракт §3) -------------------------------------------------------

  /** Свободен ли стол для старта без оплаты в этот момент; иначе — код ошибки. */
  async function assertFreeFor(db, resourceId, userId, t) {
    if (await openSessionOn(db, resourceId)) fail('table_busy');
    const h = await activeHold(db, resourceId, t);
    if (h?.kind === 'service') fail('table_service');
    if (h?.kind === 'pending' && h.user_id !== userId) fail('table_pending');
    // Бронь по телефону (user_id null) тоже держит стол: booking снимает её сам (clearReserved) при приходе.
    if (h?.kind === 'reserved' && (!h.user_id || h.user_id !== userId)) fail('table_busy');
    return h;
  }

  /** Платёж money (bl.payments) для связи с сессией; без таблицы или платежа — null. */
  async function paymentRow(db, paymentId) {
    await db.query('savepoint light_payment_row');
    try {
      const { rows } = await db.query('select id, amount_kopecks, minutes, method, confirmed_at from bl.payments where id = $1', [paymentId]);
      await db.query('release savepoint light_payment_row');
      return rows[0] ?? null;
    } catch {
      await db.query('rollback to savepoint light_payment_row');
      return null;
    }
  }

  async function insertSession(db, { clubId, resourceId, payer, unlimited, source, paidUntil, t, bookingId = null, depositKopecks = null }) {
    const club = await loadClub(db, clubId);
    const warn = warnMs(club.settings);
    const ins = await db.query(
      `insert into bl.sessions (club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until,
                                warn_ms, grace_ms, notified, booking_id, deposit_kopecks, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $7, $7) returning id`,
      [clubId, resourceId, phaseOf(paidUntil, t, warn), source, payer, unlimited, t, paidUntil, warn, graceMs(club.settings),
        JSON.stringify(premarkNotified({}, paidUntil, t)), bookingId, depositKopecks],
    );
    const s = await loadSession(db, ins.rows[0].id);
    await addParticipant(db, { session: s, userId: payer, role: 'payer', now: t });
    return s;
  }

  /**
   * Старт по брони (контракт M3 §3): без новой оплаты — время покрыто предоплатой брони и
   * доплатой при раннем приходе (paidMinutes). Команда свету — как при оплате; журнал
   * session.start, outbox session.started с booking_id. Идемпотентно по booking.id.
   */
  async function startFromBooking(db, { booking, userId, paidMinutes = null, paidUntil: paidUntilArg = null, paymentIds = [] }) {
    if (!booking || !isUuid(booking.id) || !isUuid(booking.club_id) || !isUuid(booking.resource_id)) fail('bad_request', 'booking');
    if (!isUuid(userId)) fail('bad_request', 'userId');
    if (paidUntilArg === null && !intIn(paidMinutes, 1, 1440)) fail('bad_request', 'paidMinutes');
    if (!Array.isArray(paymentIds) || !paymentIds.every(isUuid)) fail('bad_request', 'paymentIds');
    await enterClub(db, booking.club_id);
    const t = now();
    const res = await lockResource(db, booking.resource_id);
    if (!res || !res.active || res.club_id !== booking.club_id) fail('not_found', 'resource');
    const existing = await db.query('select id from bl.sessions where booking_id = $1', [booking.id]);
    if (existing.rowCount > 0) return existing.rows[0].id;
    const h = await assertFreeFor(db, res.id, userId, t);
    // Игра по брони кончается ровно в конце брони (№123): booking передаёт paidUntil.
    const paidUntil = paidUntilArg !== null ? new Date(paidUntilArg) : new Date(t.getTime() + paidMinutes * MINUTE);
    if (Number.isNaN(paidUntil.getTime()) || paidUntil <= t || paidUntil.getTime() - t.getTime() > 24 * 3600_000) fail('bad_request', 'paidUntil');
    const minutesPaid = Math.ceil((paidUntil.getTime() - t.getTime()) / MINUTE);
    const s = await insertSession(db, { clubId: booking.club_id, resourceId: res.id, payer: userId, unlimited: false, source: 'booking', paidUntil, t, bookingId: booking.id });
    for (const id of [...new Set(paymentIds)]) {
      const p = await paymentRow(db, id);
      if (!p) {
        log.warn('booking_payment_missing', { booking_id: booking.id, payment_id: id });
        continue;
      }
      await db.query(
        `insert into bl.session_payments (payment_id, club_id, session_id, kind, outcome, minutes, unlimited, amount_kopecks, method, confirmed_at, created_at)
         values ($1, $2, $3, 'start', 'applied', $4, false, $5, $6, $7, $8) on conflict (payment_id) do nothing`,
        [id, booking.club_id, s.id, Math.min(1440, p.minutes ?? minutesPaid), p.amount_kopecks, typeof p.method === 'string' && /^[a-z_]{1,32}$/.test(p.method) ? p.method : null, p.confirmed_at, t],
      );
      await linkPayment(db, id, s.id);
    }
    if (h) await releaseHold(db, h.id, t, 'session');
    await audit(db, {
      action: 'session.start',
      objectType: 'session',
      objectId: s.id,
      actorType: 'user',
      actorId: userId,
      data: { session_id: s.id, paid_until: iso(paidUntil), booking_id: booking.id, payment_ids: paymentIds, minutes: minutesPaid, resource_id: res.id, source: 'booking' },
    });
    await emit(db, 'session.started', sessionEvent(s, { booking_id: booking.id }));
    await command(db, s, { type: 'session.start', body: { session_id: s.id }, cause: 'guest' });
    await changed(db, s);
    log.info('session_started', { session_id: s.id, resource_id: res.id, minutes: minutesPaid, booking_id: booking.id });
    return s.id;
  }

  /**
   * Бронь ждёт гостя (№107): удержание reserved до until и state.reserved контроллеру.
   * Стол занят игрой или сервисом — удержание записывается, синий индикатор загорится, когда
   * стол освободится (а pending другим гостем стол не получит). Стол в pending — не трогаем.
   * @returns {{ ok: true, applied: boolean, until?: string, reason?: string }}
   */
  async function setReserved(db, { resourceId, until, userId = null, source = 'booking', refId = null }) {
    if (!['booking', 'waitlist', 'staff'].includes(source)) fail('bad_request', 'source');
    if (refId !== null && !isUuid(refId)) fail('bad_request', 'refId');
    const t = now();
    const u = new Date(until);
    if (Number.isNaN(u.getTime()) || u <= t || u.getTime() - t.getTime() > 24 * 3600_000) fail('bad_request', 'until');
    if (userId !== null && !isUuid(userId)) fail('bad_request', 'userId');
    await ensureResourceClub(db, resourceId);
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    const busy = await openSessionOn(db, resourceId);
    const h = await activeHold(db, resourceId, t);
    if (h?.kind === 'pending') return { ok: true, applied: false, reason: 'pending' };
    // Во время сервиса главное удержание — сервис; reserved ищем отдельно (регресс R2).
    const r = await activeReserved(db, resourceId, t);
    if (r && r.user_id === userId && r.source === source && (r.ref_id ?? null) === refId) {
      await db.query('update bl.resource_holds set until = $2 where id = $1', [r.id, u]);
    } else {
      // Другое удержание reserved (другой гость, бронь вместо очереди) заменяется новым.
      if (r) await releaseHold(db, r.id, t, 'replaced');
      await db.query(
        `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, source, ref_id, created_at) values ($1, $2, 'reserved', $3, $4, $5, $6, $7)`,
        [res.club_id, resourceId, userId, u, source, refId, t],
      );
    }
    const shown = !busy && h?.kind !== 'service';
    if (shown) {
      const device = await deviceOfResource(db, resourceId);
      if (device) await queueCommand(db, { clubId: res.club_id, deviceId: device.id, type: 'state.reserved', body: {}, cause: 'hold', now: t });
    }
    await notifyLight(db, { k: 'hall', c: res.club_id, r: resourceId });
    return { ok: true, applied: shown, until: u.toISOString(), ...(shown ? {} : { reason: busy ? 'busy' : 'service' }) };
  }

  /**
   * Бронь отменена, сгорела или началась: снять reserved; стол свободен — state.free.
   * source/refId — снять только своё удержание (бронь не снимает очередь и наоборот).
   */
  async function clearReserved(db, { resourceId, source = null, refId = null }) {
    if (source !== null && !['booking', 'waitlist', 'staff'].includes(source)) fail('bad_request', 'source');
    if (refId !== null && !isUuid(refId)) fail('bad_request', 'refId');
    const t = now();
    await ensureResourceClub(db, resourceId);
    const res = await lockResource(db, resourceId);
    if (!res) return { ok: true, released: false };
    const r = await db.query(
      `update bl.resource_holds set released_at = $2, release_reason = 'released'
        where resource_id = $1 and kind = 'reserved' and released_at is null and until > $2
          and ($3::text is null or source = $3) and ($4::uuid is null or ref_id = $4)`,
      [resourceId, t, source, refId],
    );
    if (r.rowCount === 0) return { ok: true, released: false };
    if (!(await openSessionOn(db, resourceId)) && !(await activeHold(db, resourceId, t))) {
      const device = await deviceOfResource(db, resourceId);
      if (device) await queueCommand(db, { clubId: res.club_id, deviceId: device.id, type: 'state.free', body: {}, cause: 'hold', now: t });
    }
    await notifyLight(db, { k: 'hall', c: res.club_id, r: resourceId });
    return { ok: true, released: true };
  }

  /** Стол освободился (конец игры или сервиса): если его ждёт бронь — синий индикатор. */
  async function showReservedIfAny(db, s, t) {
    const h = await activeHold(db, s.resource_id, t);
    if (h?.kind !== 'reserved') return;
    const device = await deviceOfResource(db, s.resource_id);
    if (device) await queueCommand(db, { clubId: s.club_id, deviceId: device.id, type: 'state.reserved', body: {}, cause: 'hold', now: t });
  }

  /** Сколько минут покрывает сумма по тарифу стола начиная с from (без минимума и шага). */
  async function minutesFor(db, resourceId, from, kopecks) {
    const price = async (m) => Number((await deps.tariffs.amountFor(db, { resourceId, from, minutes: m, minimum: false, exact: true })).amount_kopecks);
    if ((await price(1)) > kopecks) return 0;
    let lo = 1;
    let hi = 1440;
    if ((await price(hi)) <= kopecks) return hi;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await price(mid)) <= kopecks) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * «Без лимита» по депозиту наличными (№112, деньги — у money: takeDeposit/settleDeposit).
   * paid_until — по остатку депозита по тарифу стола; сама не продлевается; при исчерпании —
   * обычные сигналы и льгота. При закрытии session.closed несёт deposit_kopecks и used_kopecks.
   * @returns {Promise<{ session_id: string, paid_until: string, minutes: number }>}
   */
  async function startFromDeposit(db, { resourceId, userId = null, staffId, depositKopecks }) {
    if (!intIn(depositKopecks, 1, 100_000_000)) fail('bad_request', 'depositKopecks');
    if (!isUuid(staffId) || (userId !== null && !isUuid(userId))) fail('bad_request', 'user');
    const clubId = await enterResource(db, resourceId);
    await requireRole(db, clubId, staffId, ROLES.reception);
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    const h = await assertFreeFor(db, resourceId, userId, t);
    if (!deviceOnline(await deviceOfResource(db, resourceId))) fail('table_offline');
    let minutes = await minutesFor(db, resourceId, t, depositKopecks);
    if (minutes < 1) fail('limit_exceeded', 'депозит меньше минуты игры');
    // Ближайшая бронь (№129): до неё меньше минимума тарифа — не начинать, иначе — не дальше брони.
    const cap = await bookingCap(db, resourceId, t);
    if (cap) {
      const room = Math.floor((cap.getTime() - t.getTime()) / MINUTE);
      const q = await deps.tariffs.amountFor(db, { resourceId, from: t, minutes: 1, minimum: true });
      const minMinutes = Math.max(1, Number(q.min_minutes) || 0);
      if (room < minMinutes) fail('booking_conflict', 'до брони меньше минимума тарифа');
      minutes = Math.min(minutes, room);
    }
    const paidUntil = new Date(t.getTime() + minutes * MINUTE);
    const s = await insertSession(db, { clubId, resourceId, payer: userId ?? staffId, unlimited: true, source: 'reception', paidUntil, t, depositKopecks });
    if (h) await releaseHold(db, h.id, t, 'session');
    await audit(db, {
      action: 'session.start',
      objectType: 'session',
      objectId: s.id,
      actorType: 'user',
      actorId: staffId,
      data: { session_id: s.id, paid_until: iso(paidUntil), deposit_kopecks: depositKopecks, minutes, resource_id: resourceId, unlimited: true, source: 'deposit' },
    });
    await emit(db, 'session.started', sessionEvent(s, { deposit_kopecks: depositKopecks }));
    await command(db, s, { type: 'session.start', body: { session_id: s.id }, cause: 'staff' });
    await changed(db, s);
    log.info('session_started', { session_id: s.id, resource_id: resourceId, minutes, deposit: true });
    return { session_id: s.id, paid_until: paidUntil.toISOString(), minutes };
  }

  // Гость ---------------------------------------------------------------------------------

  /** «Закончить игру» — только плательщик (decisions №46). Фиксированное время не возвращается (№45). */
  async function stop(db, { sessionId, userId }) {
    await enterSession(db, sessionId);
    const s = await loadSession(db, sessionId, { lock: true });
    if (!s) fail('not_found', 'session');
    // Депозит наличными (№112) закрывает и ресепшн: гость мог прийти без приложения.
    const staffStop = s.deposit_kopecks && (await rolesIn(db, s.club_id, userId)).some((r) => ROLES.reception.includes(r));
    if (s.payer_user_id !== userId && !staffStop) {
      const list = await participants(db, s.id);
      fail(list.some((p) => p.user_id === userId) ? 'not_payer' : 'not_found', 'stop');
    }
    if (!isOpen(s)) fail('session_not_active');
    const t = now();
    await db.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'stopped', updated_at = $2 where id = $1", [s.id, t]);
    await audit(db, {
      action: 'session.stop',
      objectType: 'session',
      objectId: s.id,
      actorType: 'user',
      actorId: userId,
      data: { session_id: s.id, paid_until: iso(s.paid_until), ended_at: iso(t), unlimited: s.unlimited },
    });
    await emit(db, 'session.closed', await closedEvent(db, s, { endedAt: t, reason: 'stopped' }));
    await command(db, s, { type: 'session.stop', body: { session_id: s.id, reason_code: 'guest_stop' }, cause: 'guest' });
    await showReservedIfAny(db, s, t);
    await changed(db, s);
    return view(db, await loadSession(db, s.id), userId);
  }

  /**
   * «Я играю за этим столом». Нужен код стола (из QR, ревью п. 9): одного session_id мало —
   * он не секрет. Код не того стола — not_found, как и чужая сессия.
   */
  async function join(db, { sessionId, userId, code }) {
    if (!isUuid(userId)) fail('unauthorized');
    const c = normalizeCode(code);
    if (!c) fail('bad_request', 'code');
    await enterSession(db, sessionId);
    const s = await loadSession(db, sessionId, { lock: true });
    if (!s) fail('not_found', 'session');
    const byCode = await db.query('select resource_id from bl.resource_by_code($1)', [c]);
    if (byCode.rows[0]?.resource_id !== s.resource_id) fail('not_found', 'code');
    if (!isOpen(s)) fail('session_not_active');
    const list = await participants(db, s.id);
    if (list.some((p) => p.user_id === userId)) return { ok: true };
    if (list.length >= MAX_PARTICIPANTS) fail('limit_exceeded', 'participants');
    await addParticipant(db, { session: s, userId, role: 'player', now: now() });
    await changed(db, s);
    return { ok: true };
  }

  /** Деление неотыгранного времени по платежам с конца (decisions №73, shareRefunds). */
  async function refundShares(db, s, unplayed) {
    const { rows } = await db.query(
      `select payment_id, minutes, amount_kopecks, refunded_kopecks from bl.session_payments
        where session_id = $1 and outcome = 'applied' order by created_at desc, payment_id desc`,
      [s.id],
    );
    return shareRefunds(rows, unplayed);
  }

  /**
   * Возврат за неотыгранное время прерванной сессии (выбор гостя или автоматически через 24 часа,
   * decisions №65). Фиксированное время — доли последних платежей; «Без лимита» — закрытие по
   * концу света, money спишет фактическое по session.closed. Порог — больше 60 с.
   */
  async function refundInterrupted(db, s, t, { actorType, actorId = null, auto = false }) {
    let refundTotal = 0;
    let endedAt = t;
    const unplayed = s.unplayed_ms ?? 0;
    if (s.unlimited) {
      endedAt = playEnd(s);
    } else if (unplayed > UNPLAYED_THRESHOLD_MS) {
      for (const r of await refundShares(db, s, unplayed)) {
        await deps.payments.refund(db, { paymentId: r.paymentId, amountKopecks: r.amountKopecks, reason: auto ? 'interrupted_auto' : 'interrupted' });
        await db.query('update bl.session_payments set refunded_kopecks = refunded_kopecks + $2 where payment_id = $1', [r.paymentId, r.amountKopecks]);
        refundTotal += r.amountKopecks;
      }
    }
    await db.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'refunded', updated_at = $3 where id = $1", [s.id, endedAt, t]);
    await audit(db, {
      action: 'session.resolve',
      objectType: 'session',
      objectId: s.id,
      actorType,
      actorId,
      data: { session_id: s.id, choice: 'refund', auto, paid_until: iso(s.paid_until), unplayed_ms: unplayed, refund_kopecks: refundTotal },
    });
    await emit(db, 'session.closed', await closedEvent(db, s, { endedAt, reason: 'refunded', extra: { refund_kopecks: refundTotal } }));
    if (auto) {
      await notifyParticipants(
        db,
        s,
        {
          kind: 'session.refunded',
          text: refundTotal > 0
            ? `Стол ${s.resource_number}: вернули ${formatMoney(refundTotal)} за неотыгранное время`
            : `Стол ${s.resource_number}: игра закрыта, неотыгранное время пересчитано`,
          data: { action: 'receipt', refund_kopecks: refundTotal },
        },
        { payerOnly: true },
      );
    }
    log.info('session_refunded', { session_id: s.id, refund_kopecks: refundTotal, auto });
    return refundTotal;
  }

  /** «Продолжить» обрезано бронью (№129): возврат за cutMs долями платежей с конца, журнал, уведомление. */
  async function refundResumeCut(db, s, t, { cutMs, cap }) {
    let refund = 0;
    if (!s.unlimited) {
      for (const r of await refundShares(db, s, cutMs)) {
        await deps.payments.refund(db, {
          paymentId: r.paymentId,
          amountKopecks: r.amountKopecks,
          reason: 'booking_conflict',
          key: `bcr-${r.paymentId}-${t.getTime().toString(36)}`,
        });
        await db.query('update bl.session_payments set refunded_kopecks = refunded_kopecks + $2 where payment_id = $1', [r.paymentId, r.amountKopecks]);
        refund += r.amountKopecks;
      }
    }
    await audit(db, {
      action: 'session.booking_cut',
      objectType: 'session',
      objectId: s.id,
      data: { session_id: s.id, cut_ms: cutMs, refund_kopecks: refund, paid_until: iso(cap), resumed: true },
    });
    if (refund > 0) {
      await notifyBookingCut(db, { user_id: s.payer_user_id, club_id: s.club_id }, { resourceId: s.resource_id, sessionId: s.id, cap, refund, cutMs });
    }
    return refund;
  }

  /** Выбор после interrupted (T6): continue — оплаченный остаток с этого момента; refund — возврат. */
  async function resolve(db, { sessionId, userId, choice }) {
    if (choice !== 'continue' && choice !== 'refund') fail('bad_request', 'choice');
    await enterSession(db, sessionId);
    const s = await loadSession(db, sessionId, { lock: true });
    if (!s) fail('not_found', 'session');
    if (s.payer_user_id !== userId) {
      const list = await participants(db, s.id);
      fail(list.some((p) => p.user_id === userId) ? 'not_payer' : 'not_found', 'resolve');
    }
    if (s.status !== 'interrupted') fail('session_not_active');
    const t = now();
    if (choice === 'continue') {
      await lockResource(db, s.resource_id);
      if (await openSessionOn(db, s.resource_id)) fail('table_busy');
      const h = await activeHold(db, s.resource_id, t);
      if (h?.kind === 'service') fail('table_service');
      if (h && h.user_id !== userId) fail(h.kind === 'pending' ? 'table_pending' : 'table_busy');
      if (!deviceOnline(await deviceOfResource(db, s.resource_id))) fail('table_offline');
      // Не дальше ближайшей брони (№129): остаток сверх неё возвращается долями платежей.
      const cap = await bookingCap(db, s.resource_id, t);
      if (cap && cap.getTime() - t.getTime() < MINUTE) fail('booking_conflict', 'стол забронирован');
      if (h) await releaseHold(db, h.id, t, 'session');
      let paidUntil = new Date(t.getTime() + s.unplayed_ms);
      let cutMs = 0;
      if (cap && paidUntil > cap) {
        cutMs = paidUntil.getTime() - cap.getTime();
        paidUntil = cap;
      }
      await db.query(
        // Отрезок «Продолжить» начинается сейчас: неотыгранное потом — не больше прежнего долга
        // плюс оплаченное с тех пор (device_paid_until = t, а не NULL → started_at).
        `update bl.sessions set status = $2, paid_until = $3, unplayed_ms = null, device_paid_until = $5,
                                notified = $4::jsonb, updated_at = $5 where id = $1`,
        [s.id, phaseOf(paidUntil, t, s.warn_ms), paidUntil, JSON.stringify(premarkNotified({}, paidUntil, t)), t],
      );
      await audit(db, {
        action: 'session.resolve',
        objectType: 'session',
        objectId: s.id,
        actorType: 'user',
        actorId: userId,
        data: { session_id: s.id, choice, paid_until: iso(paidUntil), unplayed_ms: s.unplayed_ms },
      });
      if (cutMs > 0) await refundResumeCut(db, s, t, { cutMs, cap });
      await emit(db, 'session.started', sessionEvent({ ...s, paid_until: paidUntil }, { resumed: true }));
      await command(db, s, { type: 'session.start', body: { session_id: s.id }, cause: 'guest' });
    } else {
      await refundInterrupted(db, s, t, { actorType: 'user', actorId: userId });
    }
    await changed(db, s);
    return view(db, await loadSession(db, s.id), userId);
  }

  async function getSession(db, { sessionId, userId }) {
    await enterSession(db, sessionId);
    const s = await loadSession(db, sessionId);
    if (!s) fail('not_found', 'session');
    const list = await participants(db, s.id);
    if (!list.some((p) => p.user_id === userId)) {
      const roles = await rolesIn(db, s.club_id, userId);
      if (!roles.some((r) => ROLES.reception.includes(r))) fail('not_found', 'session');
    }
    return sessionView(s, { now: now(), userId, participants: list, bookingLimit: await bookingLimit(db, s) });
  }

  /** Сессии гостя во всех клубах (идущие и ждущие выбора после interrupted). */
  async function listCurrent(db, { userId }) {
    if (!isUuid(userId)) fail('unauthorized');
    const start = await currentClub(db);
    const { rows } = await db.query(
      `select s.id, s.club_id from bl.sessions s join bl.session_participants p on p.session_id = s.id
        where p.user_id = $1 and s.status = any($2::text[]) order by s.started_at desc limit 20`,
      [userId, [...OPEN_STATUSES, 'interrupted']],
    );
    const out = [];
    for (const r of rows) {
      if (start !== null && start !== r.club_id) continue;
      await db.query("select set_config('app.club_id', $1, true)", [r.club_id]);
      const s = await loadSession(db, r.id);
      if (s) out.push(sessionView(s, { now: now(), userId, participants: await participants(db, s.id), bookingLimit: await bookingLimit(db, s) }));
    }
    await db.query("select set_config('app.club_id', $1, true)", [start ?? '']);
    return out;
  }

  async function receipt(db, { sessionId, userId }) {
    await enterSession(db, sessionId);
    const s = await loadSession(db, sessionId);
    if (!s) fail('not_found', 'session');
    const list = await participants(db, s.id);
    if (!list.some((p) => p.user_id === userId)) {
      const roles = await rolesIn(db, s.club_id, userId);
      if (!roles.some((r) => ROLES.reception.includes(r))) fail('not_found', 'session');
    }
    const { rows } = await db.query(
      `select payment_id, kind, minutes, unlimited, amount_kopecks, refunded_kopecks, method, created_at
         from bl.session_payments where session_id = $1 and outcome = 'applied' order by created_at, payment_id`,
      [s.id],
    );
    const lines = rows.map((r) => ({
      title: r.unlimited ? `Стол ${s.resource_number}, без лимита` : `Стол ${s.resource_number}, ${minutesText(r.minutes)}`,
      kind: r.kind,
      minutes: r.minutes,
      amount_kopecks: Number(r.amount_kopecks),
    }));
    const payments = rows.map((r) => ({
      payment_id: r.payment_id,
      method: r.method,
      amount_kopecks: Number(r.amount_kopecks),
      refunded_kopecks: Number(r.refunded_kopecks),
      at: iso(r.created_at),
    }));
    // Чеки 54-ФЗ — у money (receiptStatus): статус по каждому платежу и один итог для экрана.
    let byPayment = {};
    if (typeof deps.payments.receiptStatus === 'function' && rows.length > 0) {
      byPayment = (await deps.payments.receiptStatus(db, { paymentIds: rows.map((r) => r.payment_id) })) ?? {};
    }
    for (const p of payments) p.receipt_status = byPayment[p.payment_id] ?? 'none';
    const receiptStatus = summarizeReceipts(payments.map((p) => p.receipt_status));
    return {
      lines,
      total_kopecks: payments.reduce((sum, p) => sum + p.amount_kopecks - p.refunded_kopecks, 0),
      payments,
      receipt_status: receiptStatus,
    };
  }

  // Персонал ------------------------------------------------------------------------------

  /** Продление без оплаты — ручное действие: причина, журнал, тревога владельцу сразу (инвариант 8). */
  async function extendFree(db, { sessionId, userId, minutes, reasonText }) {
    const reason = cleanText(reasonText);
    if (!reason) fail('reason_required');
    if (!Number.isSafeInteger(minutes) || minutes < 1) fail('bad_request', 'minutes');
    if (minutes > MAX_FREE_EXTEND_MINUTES) fail('limit_exceeded', 'minutes');
    const clubId = await enterSession(db, sessionId);
    await requireRole(db, clubId, userId, ROLES.manager);
    const s = await loadSession(db, sessionId, { lock: true });
    if (!s) fail('not_found', 'session');
    if (!isOpen(s)) fail('session_not_active');
    const t = now();
    const paidUntil = new Date(s.paid_until.getTime() + minutes * MINUTE);
    await db.query('update bl.sessions set paid_until = $2, status = $3, notified = $4::jsonb, updated_at = $5 where id = $1', [
      s.id,
      paidUntil,
      phaseOf(paidUntil, t, s.warn_ms),
      JSON.stringify(premarkNotified(s.notified, paidUntil, t)),
      t,
    ]);
    await audit(db, {
      action: 'manual.extend_free',
      objectType: 'session',
      objectId: s.id,
      reason,
      actorType: 'user',
      actorId: userId,
      data: { session_id: s.id, minutes, paid_until: iso(paidUntil) },
    });
    await manualAction(db, clubId, {
      type: 'manual_action',
      resourceId: s.resource_id,
      data: { action: 'manual.extend_free', session_id: s.id, minutes, actor_id: userId },
      text: `Стол ${s.resource_number}: продление без оплаты на ${minutesText(minutes)}`,
    });
    await emit(db, 'session.extended', sessionEvent({ ...s, paid_until: paidUntil }, { free: true }));
    await command(db, s, { type: 'session.extend', body: { session_id: s.id }, cause: 'staff' });
    await changed(db, s);
    return view(db, await loadSession(db, s.id), userId);
  }

  /** Сервисный свет — ручное действие: reason_code и reason_text обязательны, предел минут клуба. */
  async function serviceStart(db, { resourceId, userId, minutes, reasonCode, reasonText }) {
    const text = cleanText(reasonText);
    if (typeof reasonCode !== 'string' || reasonCode === '' || !text) fail('reason_required');
    if (!SERVICE_REASONS.includes(reasonCode)) fail('bad_request', 'reason_code');
    if (!Number.isSafeInteger(minutes) || minutes < 1) fail('bad_request', 'minutes');
    const clubId = await enterResource(db, resourceId);
    await requireRole(db, clubId, userId, ROLES.reception);
    const club = await loadClub(db, clubId);
    if (minutes > serviceMaxMinutes(club.settings)) fail('limit_exceeded', 'minutes');
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res || !res.active) fail('not_found', 'resource');
    if (await openSessionOn(db, resourceId)) fail('table_busy');
    const h = await activeHold(db, resourceId, t);
    if (h?.kind === 'service') fail('table_service');
    if (h?.kind === 'pending') fail('table_pending');
    if (h) fail('table_busy');
    const device = await deviceOfResource(db, resourceId);
    if (!deviceOnline(device)) fail('table_offline');
    const until = new Date(t.getTime() + minutes * MINUTE);
    await db.query(
      `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, reason_code, reason_text, created_at)
       values ($1, $2, 'service', $3, $4, $5, $6, $7)`,
      [clubId, resourceId, userId, until, reasonCode, text, t],
    );
    await audit(db, {
      action: 'service.start',
      objectType: 'resource',
      objectId: resourceId,
      reason: text,
      actorType: 'user',
      actorId: userId,
      data: { minutes, reason_code: reasonCode, until: iso(until), resource_number: res.number },
    });
    await manualAction(db, clubId, {
      type: 'service_light',
      resourceId,
      data: { action: 'service.start', minutes, reason_code: reasonCode, actor_id: userId },
      text: `Стол ${res.number}: включён сервисный свет на ${minutesText(minutes)}`,
    });
    await queueCommand(db, { clubId, deviceId: device.id, type: 'service.start', body: { reason_code: reasonCode }, cause: 'staff', now: t });
    await notifyLight(db, { k: 'hall', c: clubId, r: resourceId });
    return { ok: true, until: until.toISOString() };
  }

  async function serviceStop(db, { resourceId, userId, reasonText = null }) {
    const clubId = await enterResource(db, resourceId);
    await requireRole(db, clubId, userId, ROLES.reception);
    const t = now();
    const res = await lockResource(db, resourceId);
    if (!res) fail('not_found', 'resource');
    const h = await activeHold(db, resourceId, t);
    if (!h || h.kind !== 'service') fail('not_found', 'service');
    await releaseHold(db, h.id, t, 'stopped');
    await audit(db, {
      action: 'service.stop',
      objectType: 'resource',
      objectId: resourceId,
      // Ручное действие пишется с причиной: своя или причина включения этого сервисного света.
      reason: cleanText(reasonText) ?? h.reason_text,
      actorType: 'user',
      actorId: userId,
      data: { reason_code: h.reason_code, minutes: Math.ceil((t - h.created_at) / MINUTE), resource_number: res.number },
    });
    const device = await deviceOfResource(db, resourceId);
    if (device) await queueCommand(db, { clubId, deviceId: device.id, type: 'service.stop', body: {}, cause: 'staff', now: t });
    await showReservedIfAny(db, { club_id: clubId, resource_id: resourceId }, t);
    await notifyLight(db, { k: 'hall', c: clubId, r: resourceId });
    return { ok: true };
  }

  /** Мигнуть индикатором, чтобы найти стол при монтаже. */
  async function identify(db, { resourceId, userId, seconds }) {
    if (!intIn(seconds, 1, MAX_IDENTIFY_SECONDS)) fail('bad_request', 'seconds');
    const clubId = await enterResource(db, resourceId);
    await requireRole(db, clubId, userId, [...ROLES.installer, 'manager']);
    const device = await deviceOfResource(db, resourceId);
    if (!deviceOnline(device)) fail('table_offline');
    await queueCommand(db, { clubId, deviceId: device.id, type: 'identify', body: { duration_ms: seconds * 1000 }, cause: 'staff', now: now() });
    return { ok: true };
  }

  /**
   * Ближайшая живая бронь стола для плана зала: { id, starts_at, ends_at, source, status } без
   * имени и телефона — через bookings.nextBooking (server/bookings/api.mjs); без модуля — null.
   */
  async function nextBookingInfo(db, resourceId) {
    const b = await deps.bookings.nextBooking(db, { resourceId, after: now() });
    if (!b) return null;
    return { id: b.id, starts_at: iso(b.starts_at), ends_at: iso(b.ends_at), source: b.source ?? null, status: b.status ?? null };
  }

  /** Удержание в плане зала: без ПДн; у очереди — offer_id, у брони — booking_id (№122). */
  function holdView(h) {
    const out = { kind: h.kind, until: iso(h.until), reason_code: h.reason_code ?? null, source: h.source ?? null };
    if (h.source === 'waitlist') out.offer_id = h.ref_id ?? null;
    if (h.source === 'booking') out.booking_id = h.ref_id ?? null;
    return out;
  }

  /** Элемент зала одного стола (hall и SSE). */
  async function hallItem(db, r, { withSession = true } = {}) {
    const t = now();
    const s = await openSessionOn(db, r.id);
    const h = await activeHold(db, r.id, t);
    const device = await deviceOfResource(db, r.id);
    const info = device ? (opts.getBridge?.()?.deviceInfo?.(device.id) ?? null) : null;
    const online = deviceOnline(device);
    let status = 'free';
    if (!online) status = 'offline';
    else if (s) status = s.status;
    else if (h) status = h.kind;
    else if (info?.mode === 'fault') status = 'fault';
    return {
      resource: { id: r.id, number: r.number, type: r.type, title: r.title, code: r.code, plan_x: r.plan_x, plan_y: r.plan_y, plan_rotation: r.plan_rotation },
      status,
      session: s && withSession ? sessionSummary(s, t) : null,
      busy_until: s ? iso(s.paid_until) : null,
      until: h ? iso(h.until) : null,
      hold: h ? holdView(h) : null,
      next_booking: await nextBookingInfo(db, r.id),
      device: device
        ? { id: device.id, online, rssi: info?.rssi ?? null, fw: info?.fw ?? device.fw ?? null, caps: info?.caps ?? device.caps ?? [], mode: info?.mode ?? null }
        : { id: null, online: false, rssi: null, fw: null, caps: [], mode: null },
    };
  }

  async function hall(db, { clubId, userId }) {
    if (!isUuid(clubId)) fail('not_found', 'club');
    await enterClub(db, clubId);
    const roles = await requireRole(db, clubId, userId, ROLES.staff);
    const withSession = roles.some((r) => ROLES.reception.includes(r));
    const { rows } = await db.query(
      'select id, number, type, title, code, plan_x, plan_y, plan_rotation from bl.resources where active order by number',
    );
    const out = [];
    for (const r of rows) out.push(await hallItem(db, r, { withSession }));
    return out;
  }

  // Планировщик ------------------------------------------------------------------------------

  /**
   * Шаг планировщика для одной сессии: сигналы T−10, T−1, T−0, переходы active → ending →
   * grace и закрытие в T+льгота (или interrupted, если свет не горел оплаченное время).
   * @returns {Promise<Date|null>} когда снова проверить сессию; null — сессия не идёт.
   */
  async function tick(db, sessionId) {
    const s = await loadSession(db, sessionId, { lock: true });
    if (s?.status === 'interrupted') {
      // Выбор гостя ждёт 24 часа, затем — автоматический возврат (decisions №65).
      const t = now();
      const due = new Date(s.interrupted_at).getTime() + INTERRUPTED_DECIDE_MS;
      if (t.getTime() < due) return new Date(due);
      await refundInterrupted(db, s, t, { actorType: 'system', auto: true });
      await changed(db, s);
      return null;
    }
    if (!s || !isOpen(s)) return null;
    const t = now();
    const T = t.getTime();
    const P = s.paid_until.getTime();
    const G = s.grace_ms;
    if (T >= P + G) {
      await closeExpired(db, s, t);
      return null;
    }
    const key = s.paid_until.toISOString();
    const notified = { ...s.notified };
    const sends = [];
    if (T >= P - 10 * MINUTE && notified.t10 !== key) {
      notified.t10 = key;
      if (P - T > MINUTE) {
        const left = Math.ceil((P - T) / MINUTE);
        sends.push({ kind: 'session.t10', text: `Стол ${s.resource_number}: осталось ${minutesText(left)}`, data: { action: 'extend', remaining_ms: P - T } });
      }
    }
    // «Без лимита» (decisions №69): за 5 минут до extend_limit_until (= paid_until) — подтвердить
    // продолжение (новая заморозка или блок СБП). Без подтверждения — обычные сигналы конца игры.
    // Депозит наличными не продлевается сам (№112): подтверждать нечего, идут обычные сигналы.
    if (s.unlimited && !s.deposit_kopecks && T >= P - UNLIMITED_CONFIRM_MS && notified.u5 !== key) {
      notified.u5 = key;
      if (T < P) {
        const until = formatTime(s.paid_until, safeZone(s.club_timezone));
        sends.push({
          kind: 'session.unlimited_confirm',
          text: `Стол ${s.resource_number}: заморозка заканчивается в ${until}. Подтвердите продолжение игры`,
          data: { action: 'extend', kind: 'extend', minutes: null, unlimited: true, extend_limit_until: key },
        });
        await afterCommit(db, () => deps.sse.publish(`session:${s.id}`, 'unlimited_confirm', { session_id: s.id, extend_limit_until: key, action: 'extend', minutes: null }));
      }
    }
    if (T >= P - MINUTE && notified.t1 !== key) {
      notified.t1 = key;
      if (T < P) sends.push({ kind: 'session.t1', text: `Стол ${s.resource_number}: осталась минута`, data: { action: 'extend', remaining_ms: P - T } });
    }
    if (T >= P && notified.t0 !== key) {
      notified.t0 = key;
      const g = Math.max(1, Math.round(G / MINUTE));
      sends.push({ kind: 'session.t0', text: `Стол ${s.resource_number}: время вышло, ${minutesText(g)} на продление`, data: { action: 'extend', grace_ms: P + G - T } });
    }
    const status = phaseOf(s.paid_until, t, s.warn_ms);
    if (status !== s.status || JSON.stringify(notified) !== JSON.stringify(s.notified)) {
      await db.query('update bl.sessions set status = $2, notified = $3::jsonb, updated_at = $4 where id = $1', [s.id, status, JSON.stringify(notified), t]);
      if (status !== s.status) await changed(db, s);
    }
    for (const msg of sends) await notifyParticipants(db, s, msg);
    const next = [P - 10 * MINUTE, P - UNLIMITED_CONFIRM_MS, P - s.warn_ms[0], P - MINUTE, P, P + G].filter((x) => x > T);
    return new Date(Math.min(...next));
  }

  async function closeExpired(db, s, t) {
    const unplayed = unplayedMs(s);
    if (unplayed > UNPLAYED_THRESHOLD_MS) {
      // Контроллер не подтвердил оплаченное время (продление не дошло, связь пропала):
      // гость выбирает «Продолжить» или «Вернуть» (T6).
      await markInterrupted(db, s, t, unplayed);
      return;
    }
    await db.query("update bl.sessions set status = 'closed', ended_at = $2, close_reason = 'expired', updated_at = $2 where id = $1", [s.id, t]);
    await audit(db, { action: 'session.close', objectType: 'session', objectId: s.id, data: { session_id: s.id, paid_until: iso(s.paid_until), ended_at: iso(t) } });
    await emit(db, 'session.closed', await closedEvent(db, s, { endedAt: t, reason: 'expired' }));
    await notifyParticipants(db, s, { kind: 'session.closed', text: `Стол ${s.resource_number}: игра завершена`, data: { action: 'receipt' } });
    await showReservedIfAny(db, s, t);
    await changed(db, s);
    log.info('session_closed', { session_id: s.id, reason: 'expired' });
  }

  return {
    kit,
    bookingLimit,
    startFromBooking,
    setReserved,
    clearReserved,
    startFromDeposit,
    resourceStatus,
    availabilityDuring,
    holdPending,
    releasePending,
    getResourceByCode,
    getSessionForExtend,
    onPaymentConfirmed,
    onPaymentRefunded,
    stop,
    join,
    resolve,
    getSession,
    listCurrent,
    receipt,
    extendFree,
    serviceStart,
    serviceStop,
    identify,
    hall,
    hallItem,
    tick,
  };
}

/** Платёж, неотыгранный почти целиком (до 1 с — расхождение часов), не был показан: возврат целиком. */
export const UNSHOWN_TOLERANCE_MS = 1_000;

/**
 * Возврат за неотыгранное время долями платежей, с последнего (decisions №73):
 * время платежа, которое контроллер так и не показал, возвращается целиком; иначе доля
 * суммы округляется вверх до копейки (в пользу гостя), не больше невозвращённого остатка.
 * @param {{ payment_id, minutes, amount_kopecks, refunded_kopecks }[]} rows платежи от новых к старым
 * @returns {{ paymentId: string, amountKopecks: number }[]}
 */
export function shareRefunds(rows, unplayedMs) {
  let left = BigInt(Math.max(0, Math.floor(unplayedMs)));
  const out = [];
  for (const r of rows) {
    if (left <= 0n) break;
    const covered = BigInt(r.minutes ?? 0) * 60_000n;
    if (covered <= 0n) continue;
    const take = left < covered ? left : covered;
    const amount = BigInt(r.amount_kopecks);
    const room = amount - BigInt(r.refunded_kopecks ?? 0);
    let refund;
    if (covered - take <= BigInt(UNSHOWN_TOLERANCE_MS)) refund = room;
    else refund = (amount * take + covered - 1n) / covered; // вверх до копейки
    if (refund > room) refund = room;
    left -= take;
    if (refund > 0n) out.push({ paymentId: r.payment_id, amountKopecks: Number(refund) });
  }
  return out;
}

/**
 * Итог чеков сессии: есть failed → failed; есть pending или receipt_pending → pending;
 * все succeeded (отменённые не в счёт) → succeeded; иначе none.
 */
export function summarizeReceipts(statuses) {
  const list = statuses.filter((x) => x !== 'canceled');
  if (list.includes('failed')) return 'failed';
  if (list.includes('pending') || list.includes('receipt_pending')) return 'pending';
  if (list.length > 0 && list.every((x) => x === 'succeeded')) return 'succeeded';
  return 'none';
}

/** sha256 кода привязки, привязанный к устройству (в базе только хеш). */
export function claimCodeHash(deviceId, code) {
  return createHash('sha256').update(`${deviceId}:${code}`, 'utf8').digest('hex');
}

export { LightError };
