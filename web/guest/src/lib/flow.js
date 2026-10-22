import { local, session } from './store.js';

/**
 * Состояние покупки между экранами и перезагрузками вкладки (переход на страницу ЮKassa и обратно).
 * Только в sessionStorage этой вкладки, без персональных данных.
 */
const KEY = 'bl-flow';

/**
 * @typedef {object} Flow
 * @property {string} [code] код стола
 * @property {number} [number] номер стола
 * @property {string} [resourceId]
 * @property {string} [timeZone]
 * @property {string} [sessionId] для продления
 * @property {'start' | 'extend'} [kind]
 */

/** @returns {Flow} */
export function getFlow() {
  return session.get(KEY) ?? {};
}

/** @param {Partial<Flow>} patch */
export function setFlow(patch) {
  session.set(KEY, { ...getFlow(), ...patch });
}

export function clearFlow() {
  session.set(KEY, null);
}

/** Часовой пояс клуба: из данных стола; если открыли игру по ссылке — пояс устройства (гость в клубе). */
export function clubTimeZone(fromApi) {
  return fromApi || getFlow().timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
}

const CLUB_KEY = 'bl-club';

/** Клуб, где гость был (стол по QR): для брони и пакетов, пока нет списка клубов. Без персональных данных. */
export function rememberClub(club) {
  if (club?.id) local.set(CLUB_KEY, JSON.stringify({ id: club.id, name: club.name ?? null, timezone: club.timezone ?? null }));
}

/** @returns {{ id: string, name: string | null, timezone: string | null } | null} */
export function lastClub() {
  try {
    const v = JSON.parse(local.get(CLUB_KEY) ?? 'null');
    return v?.id ? v : null;
  } catch {
    return null;
  }
}

const TABLES_KEY = 'bl-tables';

/** Код стола по id ресурса (стол открывали по QR): для «Занять стол» из уведомления листа ожидания. */
export function rememberTable(resourceId, code) {
  if (!resourceId || !code) return;
  try {
    const map = JSON.parse(local.get(TABLES_KEY) ?? '{}');
    map[resourceId] = code;
    local.set(TABLES_KEY, JSON.stringify(Object.fromEntries(Object.entries(map).slice(-20))));
  } catch {
    // нет хранилища — откроют стол по QR
  }
}

export function tableCode(resourceId) {
  try {
    return JSON.parse(local.get(TABLES_KEY) ?? '{}')[resourceId] ?? null;
  } catch {
    return null;
  }
}
