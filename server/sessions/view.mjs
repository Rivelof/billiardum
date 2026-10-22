// JSON-представления для API и SSE (контракт M1 §6). Без персональных данных:
// участники — только «Игрок N», телефоны и id пользователей наружу не уходят.

import { OPEN_STATUSES } from './queries.mjs';

const iso = (d) => (d ? new Date(d).toISOString() : null);

export function nick(ordinal) {
  return `Игрок ${ordinal}`;
}

/**
 * @param {object} s строка сессии (queries.loadSession)
 * @param {{ now: Date, userId?: string|null, participants?: object[] }} opts
 */
export function sessionView(s, { now, userId = null, participants = [] }) {
  const open = OPEN_STATUSES.includes(s.status);
  const paidUntil = new Date(s.paid_until);
  let remaining = 0;
  if (open) remaining = Math.max(0, paidUntil.getTime() - now.getTime());
  else if (s.status === 'interrupted') remaining = s.unplayed_ms ?? 0;
  return {
    id: s.id,
    resource: { id: s.resource_id, number: s.resource_number },
    status: s.status,
    started_at: iso(s.started_at),
    paid_until: iso(s.paid_until),
    grace_until: s.status === 'grace' ? iso(paidUntil.getTime() + s.grace_ms) : null,
    remaining_ms: remaining,
    unlimited: Boolean(s.unlimited),
    is_payer: userId !== null && s.payer_user_id === userId,
    participants: participants.map((p) => ({ nick: nick(p.ordinal) })),
    // Для «Без лимита» — до какого момента оплачено замороженной суммой; дальше нужна новая.
    extend_limit_until: s.unlimited && open ? iso(s.paid_until) : null,
    ended_at: iso(s.ended_at),
    close_reason: s.close_reason ?? null,
    interrupted_at: iso(s.interrupted_at),
  };
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
  };
}
