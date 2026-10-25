import { plural, formatMoney } from '@billiardum/shared/format';
import { isSlot, resourceName, slotLabel } from '@billiardum/shared/resource';

const HOURS = ['час', 'часа', 'часов'];
const MINUTES = ['минута', 'минуты', 'минут'];
const MINUTES_ACC = ['минуту', 'минуты', 'минут']; // «осталось 21 минута», но «продлить на 21 минуту»
const SECONDS = ['секунда', 'секунды', 'секунд'];

/**
 * Минуты словами: 30 → '30 минут', 60 → '1 час', 90 → '1 час 30 минут'.
 * @param {number} minutes
 * @param {{ accusative?: boolean }} [options] винительный падеж: «на 1 минуту»
 */
export function minutesWords(minutes, options = {}) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const mf = options.accusative ? MINUTES_ACC : MINUTES;
  const parts = [];
  if (h > 0) parts.push(`${h} ${plural(h, HOURS)}`);
  if (rest > 0 || h === 0) parts.push(`${rest} ${plural(rest, mf)}`);
  return parts.join(' ');
}

/**
 * Оставшееся время словами для экранного диктора: '1 час 5 минут', '4 минуты 59 секунд', '42 секунды'.
 * @param {number} ms
 */
export function durationWords(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} ${plural(h, HOURS)} ${m} ${plural(m, MINUTES)}` : `${h} ${plural(h, HOURS)}`;
  if (m > 0) return s > 0 && m < 5 ? `${m} ${plural(m, MINUTES)} ${s} ${plural(s, SECONDS)}` : `${m} ${plural(m, MINUTES)}`;
  return `${s} ${plural(s, SECONDS)}`;
}

/** Вариант времени игры из API: 60 | 120 | 180 | 30 | 'unlimited' (null в котировке). */
export function optionMinutes(option) {
  return option === 'unlimited' || option === null ? null : Number(option);
}

/**
 * Подпись варианта: '1 час', '2 часа', '30 минут', 'Без лимита'; у корта (M5.8, слоты) — коротко '1,5 ч', '3 ч'.
 * @param {number | 'unlimited' | null} option
 * @param {object} [resource] ресурс из API: billing 'slot' или slot_minutes — корт
 */
export function optionLabel(option, resource) {
  const m = optionMinutes(option);
  if (m === null) return 'Без лимита';
  return resource && isSlot(resource) ? slotLabel(m) : minutesWords(m);
}

/** Цена за час: '800 ₽/ч'. */
export function perHour(kopecks) {
  return `${formatMoney(kopecks)}/ч`;
}

/**
 * Название ресурса: 'Стол 4', у корта (M5.8) — 'Корт 2'. Слово — по семье вида (resource.family, kind, type),
 * без ресурса — «стол», как раньше.
 * @param {number | null | undefined} number
 * @param {object | string} [resource] ресурс из API или семья 'table' | 'court'
 */
export function tableName(number, resource) {
  return resourceName(resource ?? 'table', number === undefined ? null : number);
}
