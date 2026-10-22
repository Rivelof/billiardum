// Настройки клуба для света (clubs.settings, jsonb). Значения по умолчанию — PRODUCT §7, контракт M1 §6.
//
//   grace_ms             льгота, 0…600 000 мс (по умолчанию 120 000 — 2 минуты)
//   warn_ms              [порог ending, порог «осталась минута»] (по умолчанию [300000, 60000])
//   service_max_minutes  предел сервисного света, минут (по умолчанию 30)
//   buzzer               false — пищалка выключена всегда (по умолчанию true)
//   buzzer_quiet         тихие часы по местному времени клуба: {"from":"23:00","to":"09:00"}
//                        или массив таких интервалов; конец ≤ начала — через полночь (decisions №32)

export const DEFAULT_GRACE_MS = 120_000;
export const DEFAULT_WARN_MS = Object.freeze([300_000, 60_000]);
export const DEFAULT_SERVICE_MAX_MINUTES = 30;
const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function intIn(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function graceMs(settings) {
  const v = settings?.grace_ms;
  return intIn(v, 0, 600_000) ? v : DEFAULT_GRACE_MS;
}

export function warnMs(settings) {
  const v = settings?.warn_ms;
  if (Array.isArray(v) && v.length === 2 && intIn(v[0], 1, 3_600_000) && intIn(v[1], 1, 3_600_000) && v[0] > v[1]) {
    return [v[0], v[1]];
  }
  return [...DEFAULT_WARN_MS];
}

export function serviceMaxMinutes(settings) {
  const v = settings?.service_max_minutes;
  return intIn(v, 1, 24 * 60) ? v : DEFAULT_SERVICE_MAX_MINUTES;
}

/** Часовой пояс, который понимает Intl (Postgres принимает и такие, как «MSK» или «posix/…»). */
export function validTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Часовой пояс клуба или UTC, если Intl его не знает (команды не должны падать). */
export function safeZone(tz) {
  return validTimeZone(tz) ? tz : 'UTC';
}

/** Минуты от полуночи по местному времени клуба. */
export function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: safeZone(timeZone), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function toMinutes(hhmm) {
  const m = HHMM.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Попадает ли момент в тихие часы клуба. Неверно заданный интервал игнорируется. */
export function inQuietHours(settings, date, timeZone) {
  const raw = settings?.buzzer_quiet;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (list.length === 0) return false;
  const now = localMinutes(date, timeZone);
  for (const item of list) {
    const from = toMinutes(item?.from);
    const to = toMinutes(item?.to);
    if (from === null || to === null || from === to) continue;
    const inside = from < to ? now >= from && now < to : now >= from || now < to;
    if (inside) return true;
  }
  return false;
}

/** Флаг buzzer для session.start/extend/resume (decisions №32). */
export function buzzerFlag(settings, date, timeZone) {
  if (settings?.buzzer === false) return false;
  return !inQuietHours(settings, date, timeZone);
}
