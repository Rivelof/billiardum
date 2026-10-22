/**
 * Терминалы ресепшена (владелец, ревью входа: отзыв и разблокировка) и правила PIN.
 * GET /api/clubs/{club}/terminals → [{ id, name, created_by: { user_id, name }, created_at, expires_at,
 * last_used_at, revoked_at, locked_at }]; DELETE …/terminals/{id} — отзыв (PIN-входы на нём гаснут);
 * POST …/terminals/{id}/unlock — снять блокировку после 10 неверных PIN за час.
 */

/** Владелец и управляющий — PIN ровно из 6 цифр, остальные — 4–6 (ревью входа п. 5). */
export const LONG_PIN_ROLES = ['owner', 'manager'];

export function pinMinLength(role) {
  return LONG_PIN_ROLES.includes(role) ? 6 : 4;
}

/** PIN подходит роли: только цифры, от минимума роли до 6. */
export function pinValid(pin, role) {
  return typeof pin === 'string' && /^\d+$/.test(pin) && pin.length >= pinMinLength(role) && pin.length <= 6;
}

/**
 * Вид ошибки входа по PIN: неверный PIN — 401; PIN сотрудника заблокирован — 429 с Retry-After;
 * терминал заблокирован (10 неверных за час, снимает владелец) — 429 без Retry-After.
 * @returns {'pin_wrong' | 'pin_locked' | 'terminal_locked' | unknown}
 */
export function pinErrorKind(err) {
  if (err?.code === 'forbidden' || err?.code === 'unauthorized') return 'pin_wrong';
  if (err?.code === 'rate_limited') return err.retryAfterSec == null ? 'terminal_locked' : 'pin_locked';
  return err;
}

/**
 * Состояние терминала для списка: отозван, срок вышел, заблокирован, работает.
 * @returns {{ state: 'revoked' | 'expired' | 'locked' | 'active', word: string, tone: 'off' | 'alert' | 'free', canRevoke: boolean, canUnlock: boolean }}
 */
export function terminalState(t, now = Date.now()) {
  if (t?.revoked_at) return { state: 'revoked', word: 'Отозван', tone: 'off', canRevoke: false, canUnlock: false };
  if (t?.expires_at && Date.parse(t.expires_at) <= now) return { state: 'expired', word: 'Срок вышел', tone: 'off', canRevoke: true, canUnlock: false };
  if (t?.locked_at) return { state: 'locked', word: 'Заблокирован', tone: 'alert', canRevoke: true, canUnlock: true };
  return { state: 'active', word: 'Работает', tone: 'free', canRevoke: true, canUnlock: false };
}

/** Сначала заблокированные (требуют решения), затем работающие, в конце отозванные и истёкшие. */
export function sortTerminals(list, now = Date.now()) {
  const rank = { locked: 0, active: 1, expired: 2, revoked: 3 };
  return [...(list ?? [])].sort(
    (a, b) => rank[terminalState(a, now).state] - rank[terminalState(b, now).state] || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
  );
}
