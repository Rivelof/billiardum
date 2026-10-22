// Правила брони клуба (clubs.settings, PRODUCT §6, решения №106–108). Значения по умолчанию —
// здесь; клуб меняет их в настройках (управляющий).
//
//   booking_prepayment            'none' | 'deposit' | 'full'   ('none')
//   booking_deposit_kopecks        депозит при 'deposit', не больше цены брони   (50 000)
//   booking_forfeit_percent        сколько % предоплаты удерживается при сгорании и поздней отмене (100, №108)
//   booking_free_cancel_minutes    отмена гостем раньше чем за N минут до начала — предоплата вернётся целиком (120)
//   booking_min_minutes / booking_max_minutes   длительность брони (60 / 240)
//   booking_step_minutes           шаг начала и длительности (30)
//   booking_lead_minutes           гость бронирует не ближе чем за N минут до начала (15)
//   booking_max_days               не дальше чем на N дней вперёд (30)
//   booking_pay_minutes            сколько бронь ждёт предоплаты (15)
//   booking_hold_minutes / booking_hold_prepaid_minutes   удержание после начала (15 / 30, №107)
//   booking_early_max_minutes      раньше скольких минут до начала можно начать игру по брони (120)
//   booking_early_free_minutes     ранний приход за столько минут до начала — без доплаты (5)
//   booking_max_open_per_guest     живых броней одного гостя в клубе (3)
//   day_start_local                начало рабочих суток (№43, '06:00')

export const RESERVE_BEFORE_MS = 15 * 60_000;
export const REMIND_BEFORE_MS = 60 * 60_000;
/** Продление перед бронью — до её начала минус 5 минут (№106). */
export const EXTEND_GAP_MS = 5 * 60_000;
/** Предложение листа ожидания — 5 минут (№109); удержание после принятия — 3 минуты, как котировка. */
export const OFFER_MS = 5 * 60_000;
export const ACCEPT_HOLD_MS = 3 * 60_000;
/** Предлагать стол из очереди, только если до ближайшей брони не меньше получаса. */
export const OFFER_MIN_FREE_MS = 30 * 60_000;
/** Запись в очереди без движения дольше 6 часов закрывается. */
export const WAITLIST_STALE_MS = 6 * 3600_000;
export const WAITLIST_MAX_PER_GUEST = 3;

function int(v, def, min, max) {
  return Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
}

export function bookingSettings(raw = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const prepayment = ['none', 'deposit', 'full'].includes(s.booking_prepayment) ? s.booking_prepayment : 'none';
  const step = int(s.booking_step_minutes, 30, 5, 120);
  const min = int(s.booking_min_minutes, 60, 15, 720);
  return {
    prepayment,
    depositKopecks: int(s.booking_deposit_kopecks, 50_000, 0, 100_000_000),
    forfeitPercent: int(s.booking_forfeit_percent, 100, 0, 100),
    freeCancelMinutes: int(s.booking_free_cancel_minutes, 120, 0, 10_080),
    minMinutes: min,
    maxMinutes: Math.max(min, int(s.booking_max_minutes, 240, 15, 720)),
    stepMinutes: step,
    leadMinutes: int(s.booking_lead_minutes, 15, 0, 1440),
    maxDays: int(s.booking_max_days, 30, 1, 365),
    payMinutes: int(s.booking_pay_minutes, 15, 5, 120),
    holdMinutes: int(s.booking_hold_minutes, 15, 0, 120),
    holdPrepaidMinutes: int(s.booking_hold_prepaid_minutes, 30, 0, 120),
    earlyMaxMinutes: int(s.booking_early_max_minutes, 120, 0, 720),
    earlyFreeMinutes: int(s.booking_early_free_minutes, 5, 0, 60),
    maxOpenPerGuest: int(s.booking_max_open_per_guest, 3, 1, 50),
    dayStart: typeof s.day_start_local === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s.day_start_local) ? s.day_start_local : '06:00',
  };
}

/** Предоплата брони по правилам клуба. */
export function prepaymentFor(settings, amountKopecks) {
  if (settings.prepayment === 'full') return amountKopecks;
  if (settings.prepayment === 'deposit') return Math.min(amountKopecks, settings.depositKopecks);
  return 0;
}

/** Удержание после начала: 15 минут без предоплаты, 30 — с предоплатой (№107). */
export function holdFor(settings, prepaymentKopecks) {
  return prepaymentKopecks > 0 ? settings.holdPrepaidMinutes : settings.holdMinutes;
}

/** Сколько вернётся из внесённого при удержании percent % — как считает money (forfeitPrepayment): удержание «половина вверх». */
export function refundFor(prepaidKopecks, percent) {
  const kept = Math.floor((prepaidKopecks * percent * 2 + 100) / 200);
  return prepaidKopecks - kept;
}
