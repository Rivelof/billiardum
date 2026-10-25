import { plural, formatMoney } from '@billiardum/shared/format';
import { familyOf, resourceName } from '@billiardum/shared/resource';

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

/** Ресурс заявки по виду (M5.8: resource_family | resource_type): «Стол 4», «Корт 1»; opts — падеж. */
export function requestName(req, opts) {
  return resourceName(familyOf({ family: req?.resource_family, type: req?.resource_type }), req?.resource_number, opts);
}

/** Заявка ресепшена по контракту: «Стол 4 · 2 ч · 1 600 ₽», у корта — «Корт 1 · 1 ч 30 мин · 2 400 ₽». */
export function requestTitle(req) {
  return `${requestName(req)} · ${minutesShort(req.minutes)} · ${formatMoney(req.amount_kopecks)}`;
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
  bar: 'Бар',
  installer: 'Монтажник',
};

/**
 * Ставка НДС товара для чека (vat_code — код ЮKassa 1–12, как у backend-pos). Пусто — ставка из настроек клуба (№52).
 * Ставки 2026 года: основная 22 %, для УСН — 5 % и 7 %. Проверить с бухгалтером пилотного клуба.
 */
export const VAT_OPTIONS = [
  { value: '', label: 'Как в настройках клуба' },
  { value: '1', label: 'Без НДС' },
  { value: '2', label: 'НДС 0 %' },
  { value: '7', label: 'НДС 5 %' },
  { value: '8', label: 'НДС 7 %' },
  { value: '3', label: 'НДС 10 %' },
  { value: '11', label: 'НДС 22 %' },
];

/** Предмет расчёта в чеке (payment_subject → paymentObject АТОЛ). */
export const SUBJECT_OPTIONS = [
  { value: 'commodity', label: 'Товар' },
  { value: 'excise', label: 'Подакцизный товар (алкоголь)' },
  { value: 'service', label: 'Услуга' },
];

/** Единицы — коды сервера (server/catalog/service.mjs). */
export const UNIT_OPTIONS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'].map((u) => ({ value: u, label: u }));
