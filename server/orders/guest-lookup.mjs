// Поиск гостя на кассе (пакет часов, decisions №117, №121; находка pentester L1 — межклубный оракул
// существования гостя по телефону).
//
// * Лимит: не больше LOOKUPS_PER_MINUTE поисков гостя в минуту на сотрудника — иначе 429 rate_limited.
// * Промахи (guest_not_found) считаются на сотрудника; MISSES_PER_HOUR и больше за час — тревога
//   владельцу guest_lookup_misses («Сотрудник часто ищет несуществующих гостей по телефону»), не чаще
//   раза в час на сотрудника (ключ тревоги — сотрудник).
// Счётчики — в памяти процесса (сервер — один процесс): промах откатывает транзакцию запроса, поэтому
// таблица в той же транзакции счёт бы потеряла; тревога пишется своей транзакцией (pool, контекст клуба).
// После перезапуска счёт начинается заново — допустимо для сигнала, не для учёта денег.

import { PosError } from './errors.mjs';

export const LOOKUPS_PER_MINUTE = 20;
export const MISSES_PER_HOUR = 10;
export const ALARM_TYPE = 'guest_lookup_misses';
export const ALARM_TEXT = 'Сотрудник часто ищет несуществующих гостей по телефону';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const MAX_KEYS = 10_000;

/** Скользящее окно отметок времени по ключу. */
function windowCounter(spanMs) {
  const map = new Map();
  return {
    add(key, t) {
      const list = (map.get(key) ?? []).filter((x) => t - x < spanMs);
      list.push(t);
      map.delete(key);
      map.set(key, list);
      if (map.size > MAX_KEYS) map.delete(map.keys().next().value);
      return list.length;
    },
    count(key, t) {
      return (map.get(key) ?? []).filter((x) => t - x < spanMs).length;
    },
    clear() {
      map.clear();
    },
  };
}

export function createGuestLookupGuard({ lookupsPerMinute = LOOKUPS_PER_MINUTE, missesPerHour = MISSES_PER_HOUR } = {}) {
  const lookups = windowCounter(MINUTE);
  const misses = windowCounter(HOUR);
  const alarmed = new Map(); // staff → время последней тревоги

  return {
    /** Поиск гостя сотрудником: сверх лимита — 429 rate_limited (поиск не выполняется). */
    lookup(staffId, now) {
      const t = now.getTime();
      if (lookups.count(staffId, t) >= lookupsPerMinute) throw new PosError('rate_limited', 'поиск гостя: лимит в минуту', 429);
      lookups.add(staffId, t);
    },
    /** Промах. true — пора поднять тревогу владельцу (порог за час, не чаще раза в час на сотрудника). */
    miss(staffId, now) {
      const t = now.getTime();
      const n = misses.add(staffId, t);
      if (n < missesPerHour) return false;
      const last = alarmed.get(staffId);
      if (last !== undefined && t - last < HOUR) return false;
      alarmed.set(staffId, t);
      if (alarmed.size > MAX_KEYS) alarmed.delete(alarmed.keys().next().value);
      return true;
    },
    missesInHour(staffId, now) {
      return misses.count(staffId, now.getTime());
    },
    reset() {
      lookups.clear();
      misses.clear();
      alarmed.clear();
    },
  };
}

/** Общий страж процесса. */
export const guestLookupGuard = createGuestLookupGuard();
