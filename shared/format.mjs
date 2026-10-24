/**
 * Бильярдум — склонения и форматы ru-RU. Без зависимостей, только Intl.
 *
 *   plural(5, ['стол', 'стола', 'столов'])      → 'столов'
 *   formatMoney(149000)                          → '1 490 ₽'
 *   formatMoney(149050)                          → '1 490,50 ₽'
 *   formatTime(date, 'Asia/Yekaterinburg')       → '21:30'
 *   formatDate(date, 'Asia/Yekaterinburg')       → '21 октября'
 *   formatDateShort(date, 'Asia/Yekaterinburg')  → '21.10' (таблицы и печать)
 *   formatDuration(3_900_000)                    → '1:05:00'
 *
 * Пробелы в числах и перед ₽ неразрывные (U+00A0), как их ставит Intl ru-RU.
 * Часовой пояс обязателен: время показываем по поясу клуба (IANA), а не по поясу устройства.
 */

const LOCALE = 'ru-RU';

/**
 * Склонение существительного после числа.
 * @param {number} n целое или дробное число; знак не важен
 * @param {[string, string, string]} forms формы для 1, 2 и 5: ['стол', 'стола', 'столов']
 * @returns {string}
 */
export function plural(n, forms) {
  if (!Array.isArray(forms) || forms.length !== 3) {
    throw new TypeError('plural: нужен массив из трёх форм [one, few, many]');
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError('plural: n должно быть конечным числом');
  }
  const abs = Math.abs(n);
  // Дробные: «1,5 стола», «0,5 часа» — родительный падеж единственного числа
  if (!Number.isInteger(abs)) return forms[1];
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

const moneyWhole = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const moneyKopecks = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Сумма в рублях из целых копеек: 149000 → '1 490 ₽', 149050 → '1 490,50 ₽'.
 * Считает без плавающей точки: копейки делятся как целые (BigInt).
 * @param {number | bigint} kopecks целое число копеек (number — только безопасное целое)
 * @returns {string}
 */
export function formatMoney(kopecks) {
  let k;
  if (typeof kopecks === 'bigint') {
    k = kopecks;
  } else if (typeof kopecks === 'number' && Number.isSafeInteger(kopecks)) {
    k = BigInt(kopecks);
  } else {
    throw new TypeError('formatMoney: нужны целые копейки (safe integer или bigint)');
  }
  const negative = k < 0n;
  const abs = negative ? -k : k;
  const rubles = abs / 100n;
  const rest = abs % 100n;
  const sign = negative ? '-' : '';
  if (rest === 0n) return moneyWhole.format(`${sign}${rubles}`);
  return moneyKopecks.format(`${sign}${rubles}.${String(rest).padStart(2, '0')}`);
}

const timeFormats = new Map();
const dateFormats = new Map();
const shortDateFormats = new Map();

function toDate(date, fn) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError(`${fn}: некорректная дата`);
  return d;
}

function checkZone(timeZone, fn) {
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new TypeError(`${fn}: укажите часовой пояс клуба (IANA), например 'Asia/Yekaterinburg'`);
  }
}

function cached(cache, timeZone, options) {
  let f = cache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { ...options, timeZone });
    cache.set(timeZone, f);
  }
  return f;
}

/**
 * Время по поясу клуба: '21:30', '09:05', '00:30'. 24-часовой формат, часы двумя цифрами, как у Intl ru-RU.
 * @param {Date | number | string} date момент времени (Date, миллисекунды или ISO-строка)
 * @param {string} timeZone IANA, например 'Asia/Yekaterinburg'
 * @returns {string}
 */
export function formatTime(date, timeZone) {
  checkZone(timeZone, 'formatTime');
  const d = toDate(date, 'formatTime');
  return cached(timeFormats, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/**
 * Дата по поясу клуба без года: '21 октября', '1 января'.
 * @param {Date | number | string} date
 * @param {string} timeZone IANA
 * @returns {string}
 */
export function formatDate(date, timeZone) {
  checkZone(timeZone, 'formatDate');
  const d = toDate(date, 'formatDate');
  return cached(dateFormats, timeZone, { day: 'numeric', month: 'long' }).format(d);
}

/**
 * Короткая дата по поясу клуба без года: '21.10', '01.01' — для плотных таблиц и печати.
 * @param {Date | number | string} date
 * @param {string} timeZone IANA
 * @returns {string}
 */
export function formatDateShort(date, timeZone) {
  checkZone(timeZone, 'formatDateShort');
  const d = toDate(date, 'formatDateShort');
  return cached(shortDateFormats, timeZone, { day: '2-digit', month: '2-digit' }).format(d);
}

/**
 * Длительность для таймера игры: '1:05:00'; меньше часа — '5:00', '0:42'.
 * Доли секунды отбрасываются, отрицательное значение показывается как '0:00'.
 * @param {number} ms миллисекунды
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new RangeError('formatDuration: ms должно быть конечным числом');
  }
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
