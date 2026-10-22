/**
 * Местное время клуба без библиотек: смещение пояса из Intl, начало суток клуба в UTC.
 * Нужно журналу («Сегодня», «Вчера», «7 дней») — фильтр уходит в API в UTC (инвариант 10).
 */

/**
 * Смещение пояса в минутах для момента ms (Екатеринбург: +300).
 * @param {number} ms
 * @param {string} timeZone
 */
export function zoneOffsetMinutes(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * Начало местных суток клуба (00:00) для момента ms, в мс UTC.
 * @param {number} ms
 * @param {string} timeZone
 * @param {number} [daysBack] сколько суток назад: 0 — сегодня, 1 — вчера
 */
export function startOfLocalDay(ms, timeZone, daysBack = 0) {
  const offset = zoneOffsetMinutes(ms, timeZone) * 60000;
  const local = ms + offset;
  const dayStartLocal = Math.floor(local / 86_400_000) * 86_400_000 - daysBack * 86_400_000;
  // смещение могло быть другим в начале тех суток (переход на летнее время) — пересчитываем
  const guess = dayStartLocal - offset;
  return dayStartLocal - zoneOffsetMinutes(guess, timeZone) * 60000;
}

/**
 * Период журнала → from/to в ISO UTC.
 * @param {'today' | 'yesterday' | 'week'} period
 * @param {number} now
 * @param {string} timeZone
 * @returns {{ from: string, to: string }}
 */
export function periodRange(period, now, timeZone) {
  const today = startOfLocalDay(now, timeZone, 0);
  if (period === 'yesterday') return { from: new Date(startOfLocalDay(now, timeZone, 1)).toISOString(), to: new Date(today).toISOString() };
  if (period === 'week') return { from: new Date(startOfLocalDay(now, timeZone, 6)).toISOString(), to: new Date(now).toISOString() };
  return { from: new Date(today).toISOString(), to: new Date(now).toISOString() };
}
