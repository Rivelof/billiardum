// Часовой пояс клуба (инвариант 10): только имена IANA, которые знает Intl этого Node —
// иначе расчёты по местному времени (тарифы, сводки, брони) упадут с RangeError.
// В базе bl.is_valid_timezone (0707) отсекает сокращения и posix/…;
// при записи пояса (API, настройки, заведение клуба) проверять ещё и здесь.

let supported = null;

/** Допустимые пояса: Intl.supportedValuesOf('timeZone') и UTC. */
export function supportedTimeZones() {
  if (!supported) supported = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
  return supported;
}

/** Пояс можно записать клубу. */
export function isValidTimeZone(tz) {
  return typeof tz === 'string' && tz.length <= 64 && supportedTimeZones().has(tz);
}
