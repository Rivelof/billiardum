// Прогноз загрузки на сутки (M5.6 №196) — владелец и управляющий.
//   GET /api/clubs/{club}/forecast?date=YYYY-MM-DD&kind   → прогноз суток date по медиане последних 8 недель
// Без date — текущие рабочие сутки клуба. date — не дальше 366 суток от сегодня в обе стороны.
// Ошибки: 400 bad_request (date, kind), 401, 403 (ресепшн, бар, чужой клуб), 404.
// Кэш процесса — 60 с на (клуб, сутки, тип стола), после проверки прав.

import { ROLES } from '../router.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { clubForecast, forecastForDate } from '../../server/dashboard/forecast.mjs';
import { TYPES } from '../../server/dashboard/day.mjs';
import { loadClub } from '../../server/dashboard/store.mjs';
import { addDays, isDay, workingDayOf } from '../../server/dashboard/time.mjs';

export const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const MAX_OFFSET_DAYS = 366;
/** Кэш ответов процесса: ключ → { expires, json }. */
export const cache = new Map();

async function handler(ctx, req) {
  const club = await loadClub(ctx.db, ctx.club);
  if (!club) throw new HttpError(404, 'not_found');
  const now = ctx.clock.now();
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const date = req.query.date ?? today;
  if (!isDay(date) || date < addDays(today, -MAX_OFFSET_DAYS) || date > addDays(today, MAX_OFFSET_DAYS)) throw new HttpError(400, 'bad_request', { detail: 'date' });
  const kind = req.query.kind === undefined || req.query.kind === '' ? null : req.query.kind;
  if (kind !== null && !TYPES.includes(kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  const key = `${club.id}|${today}|${date}|${kind ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now.getTime()) return { json: hit.json, headers: { 'x-cache': 'hit' } };
  const { forecast, history } = await clubForecast(ctx.db, club, { now, kind });
  // Праздник суток date (свой день клуба важнее федерального) — строка дня недели holiday_iso_day.
  const h = await ctx.db.query('select title from bl.holidays where day = $1 and (club_id is null or club_id = $2) order by club_id nulls first', [date, club.id]);
  const title = h.rows.at(-1)?.title ?? null;
  const json = { club_id: club.id, kind, ...forecastForDate(forecast, { date, holidayTitle: title, order: history.order }), generated_at: now.toISOString() };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { expires: now.getTime() + CACHE_TTL_MS, json });
  return { json };
}

export const routes = [
  { method: 'GET', path: '/api/clubs/{club}/forecast', auth: 'staff', roles: [...ROLES.MANAGER_UP], rateLimit: { max: 60, windowMs: 60_000 }, handler },
];
