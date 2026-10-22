import { plural, formatMoney } from '@billiardum/shared/format';

const HOURS = ['час', 'часа', 'часов'];
const MINUTES = ['минута', 'минуты', 'минут'];

/** Минуты словами: 90 → '1 час 30 минут'. */
export function minutesWords(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} ${plural(h, HOURS)}`);
  if (rest > 0 || h === 0) parts.push(`${rest} ${plural(rest, MINUTES)}`);
  return parts.join(' ');
}

/** Коротко для плиток ресепшена: 120 → '2 ч', 90 → '1 ч 30 мин', 30 → '30 мин', null → 'без лимита'. */
export function minutesShort(minutes) {
  if (minutes === null || minutes === undefined) return 'без лимита';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

/** Заявка ресепшена по контракту: «Стол 4 · 2 ч · 1 600 ₽». */
export function requestTitle(req) {
  return `Стол ${req.resource_number} · ${minutesShort(req.minutes)} · ${formatMoney(req.amount_kopecks)}`;
}

/** «2 минуты назад», «только что». */
export function agoWords(ms) {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, MINUTES)} назад`;
  const h = Math.floor(min / 60);
  return `${h} ${plural(h, HOURS)} назад`;
}

export const METHOD_LABEL = {
  sbp: 'СБП',
  card: 'Карта онлайн',
  cash: 'Наличные',
  card_terminal: 'Карта на терминале',
};

export const ROLE_LABEL = {
  owner: 'Владелец',
  manager: 'Управляющий',
  reception: 'Ресепшн',
  installer: 'Монтажник',
};
