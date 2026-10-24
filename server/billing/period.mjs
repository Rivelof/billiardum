// Периоды подписки по поясу клуба (№182, инвариант 10) и состояние подписки (§3, №184).
//
// Границы периодов — местная полночь клуба. Пробный период кончается в местную полночь через
// trial_days суток (считает база, bl.billing_ensure_subscription); день счёта (anchor_day) — день
// этой даты; дальше счёт раз в месяц в этот день, 29–31 в коротком месяце — последний день.

export const DAY_MS = 86_400_000;
/** Повторы неудачного списания: через 1 и 3 дня после первой неудачи (№184). */
export const RETRY_DAYS = Object.freeze([1, 3]);
export const MAX_ATTEMPTS = RETRY_DAYS.length + 1;
/** Плашка и уведомление — за столько дней до конца оплаченного периода (№184). */
export const REMIND_DAYS = 7;
/** Через столько дней после конца периода без оплаты — уведомление Андрею (№184). */
export const PLATFORM_NOTIFY_DAYS = 14;
export const STATES = Object.freeze(['trial', 'active', 'past_due', 'unpaid', 'canceled']);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formats = new Map();

function partsFormat(timeZone) {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formats.set(timeZone, f);
  }
  return f;
}

function localParts(instant, timeZone) {
  const out = {};
  for (const p of partsFormat(timeZone).formatToParts(instant)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

/** Местная дата клуба 'YYYY-MM-DD' для момента времени. */
export function localDate(instant, timeZone) {
  const p = localParts(new Date(instant), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Смещение пояса (мс) в момент instant: местное − UTC. */
function offsetMs(instant, timeZone) {
  const p = localParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(new Date(instant).getTime() / 1000) * 1000;
}

/** Момент местной полуночи даты 'YYYY-MM-DD' в поясе клуба. */
export function localMidnight(date, timeZone) {
  const m = DATE.exec(date);
  if (!m) throw new RangeError('localMidnight: дата YYYY-MM-DD');
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let t = guess - offsetMs(guess, timeZone);
  // Переход на летнее время между guess и t: поправка по смещению в самом t.
  t = guess - offsetMs(t, timeZone);
  return new Date(t);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Дата через месяц в день anchorDay (29–31 в коротком месяце — последний день, №182). */
export function nextPeriodDate(date, anchorDay) {
  const m = DATE.exec(date);
  if (!m) throw new RangeError('nextPeriodDate: дата YYYY-MM-DD');
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new RangeError('nextPeriodDate: anchorDay');
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  const d = Math.min(anchorDay, daysInMonth(y, mo));
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Период счёта, который начинается в момент start (местная полночь): {start, end, startAt, endAt}. */
export function periodFrom(start, anchorDay, timeZone) {
  const startDate = localDate(start, timeZone);
  const endDate = nextPeriodDate(startDate, anchorDay);
  return { start: startDate, end: endDate, startAt: localMidnight(startDate, timeZone), endAt: localMidnight(endDate, timeZone) };
}

/** Повтор после неудачной попытки n (1-я, 2-я …): момент или null — попыток больше нет. */
export function nextAttemptAt(firstFailedAt, failedAttempt) {
  const days = RETRY_DAYS[failedAttempt - 1];
  return days === undefined ? null : new Date(new Date(firstFailedAt).getTime() + days * DAY_MS);
}

/** Цена за стол: персональная или цена плана. */
export function effectivePrice(sub, plan) {
  return sub?.personal_price_kopecks != null ? Number(sub.personal_price_kopecks) : Number(plan.price_per_table_kopecks);
}

/** Конец текущего оплаченного (или пробного) периода. */
export function periodEnd(sub) {
  return new Date(sub.paid_until ?? sub.trial_until);
}

/** Автоплатёж сработает без участия владельца: включён и способ оплаты сохранён. */
export const autopayReady = (sub) => Boolean(sub?.autopay && sub.payment_method_enc);

/**
 * Состояние подписки (§3): trial — пробный период; active — оплачено; past_due — период кончился,
 * счёт не оплачен; unpaid — 14 дней и больше без оплаты; canceled — клуб вернулся в test
 * (подписка не действует). Без подписки (клуб ещё в test) — null.
 */
export function subscriptionState(sub, { now, live = true, openInvoice = null } = {}) {
  if (!sub) return null;
  if (!live) return 'canceled';
  const t = new Date(now).getTime();
  // Неоплаченный счёт (в том числе долг до приостановки, №188) — по его возрасту.
  const due = openInvoice ? new Date(openInvoice.period_start_at).getTime() : periodEnd(sub).getTime();
  if (!openInvoice && t < due) return sub.paid_until ? 'active' : 'trial';
  return t - due >= PLATFORM_NOTIFY_DAYS * DAY_MS ? 'unpaid' : 'past_due';
}

/** Целых суток до момента (вверх): 6,2 суток → 7; прошло — 0. */
export function daysLeft(until, now) {
  const ms = new Date(until).getTime() - new Date(now).getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * Плашка в программе клуба (№184) владельцу и управляющему:
 *   payment_failed — период кончился, оплата не прошла (или нет карты): {days_overdue};
 *   trial_ending / period_ending — до конца пробного или оплаченного периода ≤ 7 дней, а автоплатёж
 *   не настроен: {days_left}. Автоплатёж настроен и оплата идёт по плану — плашки нет.
 * @returns {{ kind: string, days_left: number, days_overdue: number, until: string } | null}
 */
export function bannerFor(sub, { now, live = true, openInvoice = null } = {}) {
  if (!sub || !live) return null;
  const end = periodEnd(sub);
  const t = new Date(now).getTime();
  if (openInvoice || t >= end.getTime()) {
    const since = openInvoice ? new Date(openInvoice.period_start_at) : end;
    return { kind: 'payment_failed', days_left: 0, days_overdue: Math.max(0, Math.floor((t - since.getTime()) / DAY_MS)), until: since.toISOString(), last_error: openInvoice?.last_error ?? null };
  }
  const left = daysLeft(end, now);
  if (left <= REMIND_DAYS && !autopayReady(sub)) {
    return { kind: sub.paid_until ? 'period_ending' : 'trial_ending', days_left: left, days_overdue: 0, until: end.toISOString(), last_error: null };
  }
  return null;
}
