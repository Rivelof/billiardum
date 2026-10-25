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
  // Корт (M5.8 №204): цена за слот — минута стоит price_per_slot_kopecks / slot_minutes
  if (table?.price_now?.slot_minutes) return slotOptionPrice(table, minutes, now);
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

/** Минута смены цены после now по until_local (часы клуба), null — смены нет. */
function changeAt(table, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(table.price_now?.until_local ?? '');
  if (!m) return null;
  const tz = table.club?.timezone ?? 'Europe/Moscow';
  const at = Number(m[1]) * 60 + Number(m[2]);
  const day = localDate(now, tz);
  let edge = zonedMs(day, at, tz);
  if (edge <= now) edge = zonedMs(addDays(day, 1), at, tz);
  return edge;
}

/**
 * Ориентир цены корта: слоты по цене сейчас до смены тарифа и по следующей цене после неё (граница внутри
 * слота — по минутам, как сервер), один раз до рублей «половина вверх». Точная сумма — в котировке.
 */
export function slotOptionPrice(table, minutes, now) {
  const p = table?.price_now;
  const s1 = p?.price_per_slot_kopecks;
  const u1 = p?.slot_minutes;
  if (!Number.isSafeInteger(s1) || !(u1 > 0) || !Number.isFinite(minutes) || minutes <= 0) return null;
  const n = table.price_next;
  const s2 = Number.isSafeInteger(n?.price_per_slot_kopecks) ? n.price_per_slot_kopecks : s1;
  const u2 = n?.slot_minutes > 0 ? n.slot_minutes : u1;
  let first = minutes;
  const edge = s2 !== s1 || u2 !== u1 ? changeAt(table, now) : null;
  if (edge !== null) first = Math.min(minutes, Math.max(0, Math.floor((edge - now) / 60000)));
  // Целые: числитель над общим знаменателем u1·u2, без плавающей точки
  const num = s1 * first * u2 + s2 * (minutes - first) * u1;
  const den = u1 * u2 * 100;
  return Math.floor((num * 2 + den) / (2 * den)) * 100;
}
