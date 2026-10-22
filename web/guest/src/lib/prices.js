import { addDays, localDate, zonedMs } from '@billiardum/shared/booking';

/**
 * Ориентировочная цена варианта игры для «фишек» выбора времени (PRODUCT §3, п. 2): по цене сейчас до
 * смены тарифа (price_now.until_local по часам клуба) и по следующей цене после неё; поминутно, один раз
 * до рублей «половина вверх» — как считает сервер (№44). Точную сумму показывает котировка на шаге оплаты.
 * @param {{ price_now?: { price_per_hour_kopecks: number, until_local?: string }, price_next?: { price_per_hour_kopecks: number } | null, club?: { timezone?: string } }} table
 * @param {number | null} minutes null — «Без лимита»: цены нет
 * @param {number} now
 * @returns {number | null} копейки
 */
export function optionPrice(table, minutes, now) {
  const p1 = table?.price_now?.price_per_hour_kopecks;
  if (!Number.isFinite(p1) || !Number.isFinite(minutes) || minutes <= 0) return null;
  const p2 = table.price_next?.price_per_hour_kopecks ?? p1;
  const tz = table.club?.timezone ?? 'Europe/Moscow';
  let first = minutes;
  const m = /^(\d{1,2}):(\d{2})$/.exec(table.price_now.until_local ?? '');
  if (m && p2 !== p1) {
    const at = Number(m[1]) * 60 + Number(m[2]);
    const day = localDate(now, tz);
    let edge = zonedMs(day, at, tz);
    if (edge <= now) edge = zonedMs(addDays(day, 1), at, tz);
    first = Math.min(minutes, Math.max(0, Math.floor((edge - now) / 60000)));
  }
  const exact = (p1 * first + p2 * (minutes - first)) / 60;
  return Math.round(exact / 100) * 100;
}
