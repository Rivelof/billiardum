import { session } from './store.js';

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
