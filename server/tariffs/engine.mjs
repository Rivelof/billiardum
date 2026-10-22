// Движок тарифов: чистые функции без базы (PRODUCT §9, decisions №43, №44).
//
// * Каждая минута игры считается по своему правилу bl.tariff_rules.
// * Правило задано в местном времени клуба (IANA). Тип дня (будни, выходной, праздник)
//   берётся по рабочим суткам клуба: сутки начинаются в day_start_local (по умолчанию 06:00),
//   поэтому ночь с пятницы на субботу 00:00–06:00 — пятничная (№43).
// * Праздник (bl.holidays) считается выходным: его рабочие сутки сопоставляются с правилами
//   как день holiday_iso_day (по умолчанию 7 — воскресенье).
// * Интервал правила, который пересекает начало рабочих суток (например 04:00–08:00),
//   принадлежит рабочим суткам, в которых начинается.
// * Сумма считается поминутно точно (цена часа / 60, дробные копейки) и округляется
//   один раз до price_rounding_kopecks по правилу «половина вверх» (№44).
// * Минуты считаются по реальному времени (UTC): переход на летнее время в поясе клуба
//   не теряет и не добавляет минут — каждая реальная минута оценивается по своему
//   местному времени.

export const MINUTE_MS = 60_000;
const DAY_MIN = 1440;
const BUCKET_MS = 15 * MINUTE_MS;

export class TariffError extends Error {
  /** code: 'no_tariff' — на минуту нет правила; 'bad_tariff' — неверные данные. */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TariffError';
    this.code = code;
    this.details = details;
  }
}

// Время ------------------------------------------------------------------------

/** 'HH:MM' или 'HH:MM:SS' → минуты от полуночи. */
export function parseLocalTime(value) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(String(value));
  if (!m) throw new TariffError('bad_tariff', `время ${value} не в формате HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new TariffError('bad_tariff', `время ${value} вне суток`);
  return (h * 60 + min) % DAY_MIN;
}

/** Минуты от полуночи → 'HH:MM'. */
export function formatLocalTime(minuteOfDay) {
  const m = ((minuteOfDay % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' ± дни (наивная дата без пояса). */
export function addDays(date, days) {
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO-день недели наивной даты: 1 = пн … 7 = вс. */
export function isoWeekday(date) {
  const [y, mo, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

const formatters = new Map();
function formatterFor(timezone) {
  let f = formatters.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
      });
    } catch {
      throw new TariffError('bad_tariff', `неизвестный часовой пояс ${timezone}`);
    }
    formatters.set(timezone, f);
  }
  return f;
}

/** Смещение местного времени от UTC в мс в момент ms (с точностью до минуты). */
function exactOffset(timezone, ms) {
  const parts = formatterFor(timezone).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return localAsUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * Календарь клуба: местное время, рабочие сутки и тип дня.
 * @param {{ timezone: string, dayStartLocal?: string, holidays?: Iterable<string>, holidayIsoDay?: number }} opts
 */
export function createCalendar({ timezone, dayStartLocal = '06:00', holidays = [], holidayIsoDay = 7 }) {
  if (typeof timezone !== 'string' || timezone.length === 0) throw new TariffError('bad_tariff', 'нет часового пояса клуба');
  formatterFor(timezone);
  const dayStart = parseLocalTime(dayStartLocal);
  if (!Number.isInteger(holidayIsoDay) || holidayIsoDay < 1 || holidayIsoDay > 7) {
    throw new TariffError('bad_tariff', 'holiday_iso_day — от 1 до 7');
  }
  const holidaySet = new Set(holidays);
  // Смещение кешируется по 15-минутным отрезкам UTC; если на концах отрезка смещения
  // разные (переход на летнее время внутри), считается точно для каждой минуты.
  const bucketCache = new Map();
  function offsetAt(ms) {
    const b = Math.floor(ms / BUCKET_MS);
    let entry = bucketCache.get(b);
    if (entry === undefined) {
      const start = b * BUCKET_MS;
      const o1 = exactOffset(timezone, start);
      const o2 = exactOffset(timezone, start + BUCKET_MS - 1);
      entry = o1 === o2 ? o1 : null;
      if (bucketCache.size > 5000) bucketCache.clear();
      bucketCache.set(b, entry);
    }
    return entry === null ? exactOffset(timezone, ms) : entry;
  }

  function dayType(date) {
    return holidaySet.has(date) ? holidayIsoDay : isoWeekday(date);
  }

  /** Местное время в момент ms: дата, минута суток, день недели. */
  function localAt(ms) {
    const wall = Math.floor(ms / MINUTE_MS) * MINUTE_MS + offsetAt(ms);
    const d = new Date(wall);
    const date = d.toISOString().slice(0, 10);
    return { date, minuteOfDay: d.getUTCHours() * 60 + d.getUTCMinutes(), isoWeekday: isoWeekday(date) };
  }

  /** Рабочие сутки в момент ms: дата суток, минута от их начала, тип дня этих и прошлых суток. */
  function workdayAt(ms) {
    const local = localAt(ms);
    const offset = (local.minuteOfDay - dayStart + DAY_MIN) % DAY_MIN;
    const workday = local.minuteOfDay >= dayStart ? local.date : addDays(local.date, -1);
    return {
      workday,
      offset,
      minuteOfDay: local.minuteOfDay,
      localDate: local.date,
      dayType: dayType(workday),
      prevDayType: dayType(addDays(workday, -1)),
    };
  }

  return { timezone, dayStart, holidayIsoDay, localAt, workdayAt, dayType, isHoliday: (date) => holidaySet.has(date) };
}

// Правила ------------------------------------------------------------------------

/**
 * Правила для ресурса в порядке старшинства: сначала правила конкретного стола, затем
 * по priority (больше — главнее), затем новее, затем по id.
 * @param {Array<object>} rows строки bl.tariff_rules
 * @param {{ id: string, type: string }} resource
 * @param {{ dayStart: number }} calendar
 */
export function compileRules(rows, resource, calendar) {
  const out = [];
  for (const r of rows) {
    if (r.active === false) continue;
    const specific = r.resource_id != null;
    if (specific ? r.resource_id !== resource.id : r.resource_type !== resource.type) continue;
    const start = parseLocalTime(r.start_local);
    const end = parseLocalTime(r.end_local);
    const len = (end - start + DAY_MIN) % DAY_MIN || DAY_MIN;
    const price = Number(r.price_per_hour);
    if (!Number.isSafeInteger(price) || price < 0) throw new TariffError('bad_tariff', `цена правила ${r.id} не целые копейки`);
    const step = Number(r.step_minutes ?? 1);
    const min = Number(r.min_minutes ?? 0);
    if (!Number.isInteger(step) || step < 1) throw new TariffError('bad_tariff', `шаг правила ${r.id}`);
    if (!Number.isInteger(min) || min < 0) throw new TariffError('bad_tariff', `минимум правила ${r.id}`);
    out.push({
      id: r.id,
      days: new Set((r.days ?? []).map(Number)),
      start,
      end,
      startOffset: (start - calendar.dayStart + DAY_MIN) % DAY_MIN,
      len,
      price,
      step,
      min,
      specific,
      priority: Number(r.priority ?? 0),
      createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
    });
  }
  out.sort(
    (a, b) =>
      Number(b.specific) - Number(a.specific) ||
      b.priority - a.priority ||
      b.createdAt - a.createdAt ||
      String(a.id).localeCompare(String(b.id)),
  );
  return out;
}

/** Правило минуты по рабочим суткам (или null). */
export function matchRule(rules, wd) {
  for (const r of rules) {
    const endOffset = r.startOffset + r.len;
    // Своё начало в этих сутках.
    if (wd.offset >= r.startOffset && wd.offset < endOffset && r.days.has(wd.dayType)) return r;
    // Хвост интервала, начатого в прошлых рабочих сутках.
    if (endOffset > DAY_MIN && wd.offset < endOffset - DAY_MIN && r.days.has(wd.prevDayType)) return r;
  }
  return null;
}

/** Правило в момент ms. */
export function ruleAt(rules, calendar, ms) {
  return matchRule(rules, calendar.workdayAt(ms));
}

// Минуты и округление ---------------------------------------------------------------

/** Округление дроби numerator/60 копеек до кратного rounding «половина вверх». */
export function roundAmount(numerator, rounding) {
  // numerator = Σ цена часа по минутам; сумма в копейках = numerator / 60.
  const unit = 60 * rounding;
  return Math.floor((numerator + unit / 2) / unit) * rounding;
}

function checkRounding(rounding) {
  if (!Number.isSafeInteger(rounding) || rounding < 1 || rounding > 100_000) {
    throw new TariffError('bad_tariff', 'price_rounding_kopecks — целое от 1 до 100000');
  }
}

/** Минуты к оплате: вверх до шага и не меньше минимума. */
export function billedMinutes(minutes, { step = 1, min = 0, applyMinimum = true } = {}) {
  if (!Number.isInteger(minutes) || minutes < 0) throw new TariffError('bad_tariff', 'минуты — целое ≥ 0');
  let m = Math.ceil(minutes / step) * step;
  if (applyMinimum) m = Math.max(m, min);
  return m;
}

/** Фактические минуты игры: начатая минута считается целой, доли секунды отбрасываются. */
export function actualMinutes(fromMs, toMs) {
  const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1000));
  return Math.ceil(seconds / 60);
}

/**
 * Правило каждой минуты [from, from + minutes).
 * fill: 'error' — минута без правила даёт TariffError('no_tariff');
 *       'carry' — берётся правило ближайшей минуты до неё (или после, если до нет).
 */
export function rulesForMinutes(rules, calendar, fromMs, minutes, { fill = 'error' } = {}) {
  const perMinute = new Array(minutes);
  let missing = 0;
  for (let i = 0; i < minutes; i += 1) {
    const r = ruleAt(rules, calendar, fromMs + i * MINUTE_MS);
    perMinute[i] = r;
    if (!r) missing += 1;
  }
  if (missing > 0) {
    if (fill !== 'carry') {
      const idx = perMinute.findIndex((r) => r === null);
      throw new TariffError('no_tariff', 'на это время нет тарифа', { at: new Date(fromMs + idx * MINUTE_MS).toISOString() });
    }
    let last = null;
    for (let i = 0; i < minutes; i += 1) {
      if (perMinute[i]) last = perMinute[i];
      else perMinute[i] = last;
    }
    let next = null;
    for (let i = minutes - 1; i >= 0; i -= 1) {
      if (perMinute[i]) next = perMinute[i];
      else perMinute[i] = next;
    }
    if (minutes > 0 && perMinute[0] === null) {
      // Ни одной минуты с правилом: ищем последнее правило до начала (до 7 суток назад).
      let found = null;
      for (let i = 1; i <= 7 * DAY_MIN && !found; i += 1) found = ruleAt(rules, calendar, fromMs - i * MINUTE_MS);
      if (!found) throw new TariffError('no_tariff', 'на это время нет тарифа', { at: new Date(fromMs).toISOString() });
      perMinute.fill(found);
    }
  }
  return perMinute;
}

/**
 * Сумма за minutes минут с from. Разбивка — отрезки подряд идущих минут с одной ценой;
 * их суммы получены разностью округлённых нарастающих итогов, поэтому кратны
 * rounding и в сумме дают ровно итог.
 */
export function amountForMinutes({ rules, calendar, from, minutes, rounding = 100, fill = 'error' }) {
  checkRounding(rounding);
  const fromMs = toMs(from);
  if (!Number.isInteger(minutes) || minutes < 0) throw new TariffError('bad_tariff', 'минуты — целое ≥ 0');
  const perMinute = rulesForMinutes(rules, calendar, fromMs, minutes, { fill });
  const breakdown = [];
  let numerator = 0;
  let prevRounded = 0;
  let segStart = 0;
  for (let i = 0; i <= minutes; i += 1) {
    const r = perMinute[i];
    const boundary = i === minutes || (i > segStart && r.price !== perMinute[segStart].price);
    if (boundary && i > segStart) {
      const rounded = roundAmount(numerator, rounding);
      breakdown.push({
        from: new Date(fromMs + segStart * MINUTE_MS).toISOString(),
        to: new Date(fromMs + i * MINUTE_MS).toISOString(),
        price_per_hour_kopecks: perMinute[segStart].price,
        minutes: i - segStart,
        amount_kopecks: rounded - prevRounded,
      });
      prevRounded = rounded;
      segStart = i;
    }
    if (i < minutes) numerator += r.price;
  }
  return { amount_kopecks: roundAmount(numerator, rounding), exact_kopecks: numerator / 60, minutes, breakdown, firstRule: perMinute[0] ?? null };
}

/**
 * Цена сейчас и следующая (экран стола): цена текущей минуты и до какого местного
 * времени она действует, затем следующая цена. Поиск — на horizonMinutes вперёд.
 */
export function pricesAround({ rules, calendar, at, horizonMinutes = DAY_MIN }) {
  const atMs = Math.floor(toMs(at) / MINUTE_MS) * MINUTE_MS;
  const price = (r) => (r ? r.price : null);
  const now = ruleAt(rules, calendar, atMs);
  let changeAt = null;
  let next = null;
  for (let i = 1; i <= horizonMinutes; i += 1) {
    const r = ruleAt(rules, calendar, atMs + i * MINUTE_MS);
    if (price(r) !== price(now)) {
      changeAt = atMs + i * MINUTE_MS;
      next = r;
      break;
    }
  }
  const localTime = (ms) => formatLocalTime(calendar.localAt(ms).minuteOfDay);
  let priceNext = null;
  if (changeAt !== null && next) priceNext = { price_per_hour_kopecks: next.price, from_local: localTime(changeAt), from: new Date(changeAt).toISOString() };
  if (!now && changeAt === null) return { price_now: null, price_next: null };
  return {
    price_now: now
      ? { price_per_hour_kopecks: now.price, until_local: changeAt === null ? null : localTime(changeAt), until: changeAt === null ? null : new Date(changeAt).toISOString() }
      : null,
    price_next: priceNext,
  };
}

/** Длительность для чека и экранов: 60 → «1 ч», 90 → «1 ч 30 мин», 30 → «30 мин». */
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} ч ${m} мин`;
  if (h > 0) return `${h} ч`;
  return `${m} мин`;
}

export function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TariffError('bad_tariff', 'неверное время');
  return ms;
}
