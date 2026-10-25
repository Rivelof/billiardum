import { formatMoney, plural } from '@billiardum/shared/format';
import { COURT_MAX_PLAYERS, SLOT_MINUTES, familyOf, slotLabel, slotOptions, slotsText } from '@billiardum/shared/resource';
import { minutesShort, requestName } from './words.js';

/**
 * Падел-корт в программе клуба (M5.8, №203–205, №212): слова ресурса по family, слоты корта, игроки «2 из 4».
 * Без JSX и DOM — тестируется в Node (test/court.test.mjs).
 */

/** Предел продления без оплаты у сервера (server/sessions MAX_FREE_EXTEND_MINUTES). */
export const MAX_FREE_EXTEND_MINUTES = 240;

/** Семья ресурса заявки ресепшена: resource_family, иначе по resource_type (M5.8), без них — стол. */
export const requestFamily = (req) => familyOf({ family: req?.resource_family, type: req?.resource_type });

/** Длина слота корта из заявки (M5.8: billing 'slot' и slot_minutes); у стола и без данных — null. */
export function requestSlot(req) {
  const m = Number(req?.slot_minutes);
  return req?.billing !== 'hourly' && Number.isInteger(m) && m > 0 ? m : null;
}

/**
 * Длительность заявки: у корта — слоты, если длина слота известна и делит минуты («2 слота · 3 ч»), иначе часы.
 * @param {{ minutes: number | null }} req
 * @param {number | null} [slot] длина слота корта; не задана — из заявки (slot_minutes), иначе часами
 */
export function requestLength(req, slot = requestSlot(req)) {
  const m = req?.minutes;
  if (requestFamily(req) === 'court' && Number.isInteger(slot) && slot > 0 && Number.isInteger(m) && m > 0 && m % slot === 0) return `${slotsText(m / slot)} · ${slotLabel(m)}`;
  return minutesShort(m);
}

/** Заявка ресепшена: «Стол 4 · 2 ч · 1 600 ₽», «Корт 1 · 1 слот · 1,5 ч · 2 400 ₽». */
export function requestLine(req, slot = requestSlot(req)) {
  return `${requestName(req)} · ${requestLength(req, slot)} · ${formatMoney(req.amount_kopecks)}`;
}

/** Длина слота корта из игры: GET /api/sessions/{id} (resource.slot_minutes) или `session` зала (slot_minutes), иначе null. */
export function sessionSlot(session) {
  const m = Number(session?.resource?.slot_minutes ?? session?.slot_minutes);
  return Number.isInteger(m) && m > 0 ? m : null;
}

/**
 * Нужен ли отдельный GET /api/sessions/{id} окну корта: слот и игроки берём из `session` зала, если они там есть
 * (participants — массив, слот — slot_minutes); в ответе зала игроков пока нет, тогда запрос остаётся.
 * @param {{ participants?: unknown[], slot_minutes?: number } | null} session
 */
export const needsSessionDetail = (session) => Boolean(session) && !(Array.isArray(session.participants) && sessionSlot(session) !== null);

/**
 * Ресурс заявки в зале: по resource_id, иначе по номеру внутри семьи (у стола и корта номера свои, №213).
 * @param {{ resource_id?: string, resource_number?: number }} req
 * @param {object[] | null} hall
 */
export function requestHallItem(req, hall) {
  if (!req || !Array.isArray(hall)) return null;
  const fam = requestFamily(req);
  return hall.find((h) => req.resource_id && h.resource?.id === req.resource_id) ?? hall.find((h) => h.resource?.number === req.resource_number && familyOf(h.resource) === fam) ?? null;
}

/**
 * Игроки корта (№205): «Игроки 2 из 4» — участники вместе с плательщиком; предел — resource.max_players.
 * @param {{ participants?: unknown[], resource?: { max_players?: number } } | null} session
 * @returns {{ count: number, max: number, text: string, full: boolean } | null}
 */
export function courtPlayers(session) {
  if (!session || !Array.isArray(session.participants)) return null;
  const max = Number.isInteger(session.resource?.max_players) && session.resource.max_players > 0 ? session.resource.max_players : COURT_MAX_PLAYERS;
  const count = Math.min(session.participants.length, 99);
  return { count, max, full: count >= max, text: `Игроки ${count} из ${max}` };
}

/** «2 игрока из 4» для экранного диктора. */
export const playersSpoken = (p) => `${p.count} ${plural(p.count, ['игрок', 'игрока', 'игроков'])} из ${p.max}`;

/**
 * Продление без оплаты корта — слотами (шаг продления корта — слот, №204), не дальше предела сервера.
 * Слот неизвестен — длины слота мастера (1 ч, 1,5 ч, 2 ч).
 * @param {number | null} slot
 * @returns {{ minutes: number, label: string }[]}
 */
export function courtFreeOptions(slot) {
  if (Number.isInteger(slot) && slot > 0) {
    return slotOptions(slot)
      .filter((m) => m <= MAX_FREE_EXTEND_MINUTES)
      .map((m) => ({ minutes: m, label: `${slotsText(m / slot)} · ${slotLabel(m)}` }));
  }
  return SLOT_MINUTES.map((m) => ({ minutes: m, label: slotLabel(m) }));
}
