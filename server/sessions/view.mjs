// JSON-представления для API и SSE (контракт M1 §6, M4 m4-api.md). Без персональных данных:
// участники — { user_id, nick, label }: id нужен для выбора соперника в партии (Бильярдум+), nick —
// ник Бильярдум+ или null, label — «Игрок N». Видят только участники сессии и персонал клуба.

import { familyOf, isSlotType, maxPlayers, TYPE_TO_KIND } from '../lib/resource-kinds.mjs';
import { OPEN_STATUSES } from './queries.mjs';

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function nick(ordinal) {
  return `Игрок ${ordinal}`;
}

/**
 * @param {object} s строка сессии (queries.loadSession)
 * @param {{ now: Date, userId?: string|null, participants?: object[], nicks?: Record<string, string|null> }} opts
 */
export function sessionView(s, { now, userId = null, participants = [], bookingLimit = null, nicks = {}, billing = null }) {
  const open = OPEN_STATUSES.includes(s.status);
  const paidUntil = new Date(s.paid_until);
  let remaining = 0;
  if (open) remaining = Math.max(0, paidUntil.getTime() - now.getTime());
  else if (s.status === 'interrupted') remaining = s.unplayed_ms ?? 0;
  return {
    id: s.id,
    club: { id: s.club_id, timezone: s.club_timezone ?? null },
    resource: {
      id: s.resource_id, number: s.resource_number, type: s.resource_type ?? null, title: s.resource_title ?? null,
      // Вид ресурса (M5.8): слово «стол»/«корт» — по family, предел «Я играю» — max_players.
      kind: TYPE_TO_KIND[s.resource_type] ?? null, family: familyOf(s.resource_type), max_players: maxPlayers(s.resource_type),
      // Тарификация (M5.8): у корта — слоты slot_minutes (шаг продления), у стола — hourly и null.
      billing: billing?.billing ?? (isSlotType(s.resource_type) ? 'slot' : 'hourly'),
      slot_minutes: billing?.slot_minutes ?? null,
    },
    status: s.status,
    started_at: iso(s.started_at),
    paid_until: iso(s.paid_until),
    grace_until: s.status === 'grace' ? iso(paidUntil.getTime() + s.grace_ms) : null,
    remaining_ms: remaining,
    unlimited: Boolean(s.unlimited),
    is_payer: userId !== null && s.payer_user_id === userId,
    participants: participants.map((p) => ({ user_id: p.user_id, nick: nicks?.[p.user_id] ?? null, label: nick(p.ordinal) })),
    // До какого момента можно продлить: «Без лимита» — покрыто заморозкой, блоком СБП или
    // депозитом (№69); бронь следующего гостя — её начало минус 5 минут (№106). Меньший из двух.
    extend_limit_until: open ? iso(extendLimit(s, bookingLimit)) : null,
    booking_id: s.booking_id ?? null,
    deposit_kopecks: s.deposit_kopecks ?? null,
    ended_at: iso(s.ended_at),
    close_reason: s.close_reason ?? null,
    interrupted_at: iso(s.interrupted_at),
  };
}

function extendLimit(s, bookingLimit) {
  const own = s.unlimited ? new Date(s.paid_until) : null;
  const booking = bookingLimit ? new Date(bookingLimit) : null;
  if (own && booking) return own < booking ? own : booking;
  return own ?? booking;
}

/** Короткое представление сессии в зале и в SSE hall. */
export function sessionSummary(s, now) {
  const paidUntil = new Date(s.paid_until);
  return {
    id: s.id,
    status: s.status,
    started_at: iso(s.started_at),
    paid_until: iso(s.paid_until),
    grace_until: s.status === 'grace' ? iso(paidUntil.getTime() + s.grace_ms) : null,
    remaining_ms: OPEN_STATUSES.includes(s.status) ? Math.max(0, paidUntil.getTime() - now.getTime()) : 0,
    unlimited: Boolean(s.unlimited),
    deposit_kopecks: s.deposit_kopecks ?? null,
  };
}
