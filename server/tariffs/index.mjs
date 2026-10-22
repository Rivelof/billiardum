// Тарифы с базой (контракт M1 §13, money → light). Все функции принимают db — клиент
// транзакции с контекстом клуба (withContext): RLS отдаёт только правила, праздники
// и стол этого клуба.
//
//   pricesAround(db, { resourceId, at })              → { price_now, price_next }
//   amountFor(db, { resourceId, from, minutes })      → { amount_kopecks, breakdown, minutes, ... }
//   amountForActual(db, { resourceId, from, to })     → { amount_kopecks, breakdown, minutes, actual_minutes, ... }
//
// Настройки клуба (clubs.settings): day_start_local ('06:00'), price_rounding_kopecks (100),
// holiday_iso_day (7). Чистая логика — engine.mjs.

import {
  TariffError,
  actualMinutes,
  addDays,
  amountForMinutes,
  billedMinutes,
  compileRules,
  createCalendar,
  pricesAround as enginePricesAround,
  ruleAt,
  toMs,
  MINUTE_MS,
} from './engine.mjs';

export { TariffError, formatDuration } from './engine.mjs';

export const DEFAULT_DAY_START = '06:00';
export const DEFAULT_ROUNDING = 100;
export const DEFAULT_HOLIDAY_ISO_DAY = 7;

/** Настройки тарифа клуба из clubs.settings с проверкой и значениями по умолчанию. */
export function clubTariffSettings(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const dayStart = typeof s.day_start_local === 'string' && /^\d{2}:\d{2}$/.test(s.day_start_local) ? s.day_start_local : DEFAULT_DAY_START;
  const rounding = Number.isSafeInteger(s.price_rounding_kopecks) && s.price_rounding_kopecks >= 1 && s.price_rounding_kopecks <= 100_000
    ? s.price_rounding_kopecks
    : DEFAULT_ROUNDING;
  const holidayIsoDay = Number.isInteger(s.holiday_iso_day) && s.holiday_iso_day >= 1 && s.holiday_iso_day <= 7 ? s.holiday_iso_day : DEFAULT_HOLIDAY_ISO_DAY;
  return { dayStart, rounding, holidayIsoDay };
}

/** Стол, клуб и его правила. null — стола нет (или он другого клуба: RLS). */
export async function loadResourceTariff(db, resourceId) {
  const { rows } = await db.query(
    `select r.id, r.club_id, r.type, r.number, r.title, r.active, c.timezone, c.settings, c.name as club_name
       from bl.resources r join bl.clubs c on c.id = r.club_id
      where r.id = $1`,
    [resourceId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const rules = await db.query(
    `select id, resource_type, resource_id, days, start_local::text as start_local, end_local::text as end_local,
            price_per_hour, step_minutes, min_minutes, priority, active, created_at
       from bl.tariff_rules
      where club_id = $1 and active and (resource_id = $2 or resource_type = $3)`,
    [row.club_id, row.id, row.type],
  );
  return {
    resource: { id: row.id, club_id: row.club_id, type: row.type, number: row.number, title: row.title, active: row.active },
    club: { id: row.club_id, name: row.club_name, timezone: row.timezone, settings: row.settings ?? {} },
    ruleRows: rules.rows,
  };
}

async function loadHolidays(db, clubId, fromDate, toDate) {
  const { rows } = await db.query(
    `select to_char(day, 'YYYY-MM-DD') as day from bl.holidays
      where day between $1::date and $2::date and (club_id is null or club_id = $3)`,
    [fromDate, toDate, clubId],
  );
  return rows.map((r) => r.day);
}

/** Контекст расчёта для стола на отрезок [fromMs, toMs]. */
export async function tariffContext(db, { resourceId, fromMs, toMs: endMs }) {
  const loaded = await loadResourceTariff(db, resourceId);
  if (!loaded) throw new TariffError('not_found', 'стол не найден');
  const settings = clubTariffSettings(loaded.club.settings);
  // Даты праздников — с запасом в двое суток с каждой стороны (пояса и рабочие сутки).
  const probe = createCalendar({ timezone: loaded.club.timezone, dayStartLocal: settings.dayStart });
  const fromDate = addDays(probe.localAt(fromMs).date, -2);
  const toDate = addDays(probe.localAt(endMs).date, 2);
  const holidays = await loadHolidays(db, loaded.club.id, fromDate, toDate);
  const calendar = createCalendar({
    timezone: loaded.club.timezone,
    dayStartLocal: settings.dayStart,
    holidays,
    holidayIsoDay: settings.holidayIsoDay,
  });
  const rules = compileRules(loaded.ruleRows, loaded.resource, calendar);
  return { ...loaded, settings, calendar, rules };
}

/** Цена сейчас и следующая для экрана стола. */
export async function pricesAround(db, { resourceId, at }) {
  const atMs = toMs(at);
  const t = await tariffContext(db, { resourceId, fromMs: atMs, toMs: atMs + 2 * 1440 * MINUTE_MS });
  return enginePricesAround({ rules: t.rules, calendar: t.calendar, at: atMs });
}

/**
 * Сумма за minutes минут с from (котировка, продление).
 * minimum — применять минимальное время правила (старт игры; при продлении — false).
 * exact — минуты как есть, без шага и минимума (DEV_ALLOW_ANY_MINUTES, только разработка).
 * Возвращает minutes — сколько минут оплачивается (после шага и минимума).
 */
export async function amountFor(db, { resourceId, from, minutes, minimum = true, exact = false }) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 1440) throw new TariffError('bad_tariff', 'минуты — целое от 1');
  const fromMs = toMs(from);
  const t = await tariffContext(db, { resourceId, fromMs, toMs: fromMs + (minutes + 1440) * MINUTE_MS });
  const first = ruleAt(t.rules, t.calendar, fromMs);
  if (!first) throw new TariffError('no_tariff', 'на это время нет тарифа', { at: new Date(fromMs).toISOString() });
  const billed = exact ? minutes : billedMinutes(minutes, { step: first.step, min: first.min, applyMinimum: minimum });
  const res = amountForMinutes({ rules: t.rules, calendar: t.calendar, from: fromMs, minutes: billed, rounding: t.settings.rounding });
  return {
    amount_kopecks: res.amount_kopecks,
    breakdown: res.breakdown,
    minutes: billed,
    requested_minutes: minutes,
    step_minutes: first.step,
    min_minutes: first.min,
    rounding_kopecks: t.settings.rounding,
    resource: t.resource,
    club: t.club,
  };
}

/**
 * Фактическая сумма игры [from, to] («Без лимита», interrupted): фактические минуты
 * (начатая минута — целая) вверх до шага, не меньше минимума правила начала.
 * Минуты без правила (клуб «закрыт» по тарифу, а игра шла) считаются по соседнему правилу.
 */
export async function amountForActual(db, { resourceId, from, to, minimum = true }) {
  const fromMs = toMs(from);
  const endMs = toMs(to);
  if (endMs < fromMs) throw new TariffError('bad_tariff', 'конец раньше начала');
  const actual = actualMinutes(fromMs, endMs);
  const t = await tariffContext(db, { resourceId, fromMs: fromMs - 7 * 1440 * MINUTE_MS, toMs: endMs + 1440 * MINUTE_MS });
  let first = ruleAt(t.rules, t.calendar, fromMs);
  if (!first) {
    const probe = amountForMinutes({ rules: t.rules, calendar: t.calendar, from: fromMs, minutes: Math.max(1, actual), rounding: t.settings.rounding, fill: 'carry' });
    first = probe.firstRule;
  }
  const billed = billedMinutes(actual, { step: first.step, min: first.min, applyMinimum: minimum });
  const res = amountForMinutes({ rules: t.rules, calendar: t.calendar, from: fromMs, minutes: billed, rounding: t.settings.rounding, fill: 'carry' });
  return {
    amount_kopecks: res.amount_kopecks,
    breakdown: res.breakdown,
    minutes: billed,
    actual_minutes: actual,
    step_minutes: first.step,
    min_minutes: first.min,
    rounding_kopecks: t.settings.rounding,
    resource: t.resource,
    club: t.club,
  };
}
