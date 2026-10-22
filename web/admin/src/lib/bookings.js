/**
 * Брони в программе клуба (M3): лента дня по столам, ближайшая бронь на плане зала, права на отмену (№115).
 * Ответы — server/bookings/README.md: GET /api/clubs/{club}/bookings?date= → { date, from, to, bookings },
 * GET /api/clubs/{club}/availability?date= → занятость столов (игры, сервис, закрытые часы).
 */

const MIN = 60_000;
const ms = (iso) => (typeof iso === 'number' ? iso : Date.parse(iso));

/** Живые брони: держат стол. */
export const LIVE = Object.freeze(['pending_payment', 'confirmed', 'reserved', 'started']);
export const OPEN = Object.freeze(['pending_payment', 'confirmed', 'reserved']);

export const SOURCE_LABEL = Object.freeze({ app: 'приложение', site: 'сайт', phone: 'по телефону', staff: 'на ресепшене' });

/**
 * Окно ленты: от открытия до закрытия клуба (по availability), с округлением до часа.
 * @returns {{ from: number, to: number, hours: number[] }} hours — начала часов (мс)
 */
export function timelineWindow(day, bookings = []) {
  let from = day?.open_at ? ms(day.open_at) : null;
  let to = day?.close_at ? ms(day.close_at) : null;
  for (const b of bookings) {
    from = from === null ? ms(b.starts_at) : Math.min(from, ms(b.starts_at));
    to = to === null ? ms(b.ends_at) : Math.max(to, ms(b.ends_at));
  }
  if (from === null || to === null) return { from: 0, to: 0, hours: [] };
  const HOUR = 60 * MIN;
  from = Math.floor(from / HOUR) * HOUR;
  to = Math.ceil(to / HOUR) * HOUR;
  const hours = [];
  for (let t = from; t < to; t += HOUR) hours.push(t);
  return { from, to, hours };
}

/** Положение интервала на ленте в процентах. */
export function place(win, fromIso, toIso) {
  const span = win.to - win.from;
  if (span <= 0) return { left: 0, width: 0 };
  const a = Math.max(win.from, ms(fromIso));
  const b = Math.min(win.to, ms(toIso));
  return { left: ((a - win.from) / span) * 100, width: Math.max(0, ((b - a) / span) * 100) };
}

/**
 * Дорожки ленты: по столу — брони дня и занятость без броней (игра, сервис, закрыто).
 * @returns {{ resource: object, bookings: object[], busy: object[] }[]}
 */
export function lanes(day, bookings) {
  const resources = [...(day?.resources ?? [])].sort((a, b) => a.number - b.number);
  return resources.map((r) => ({
    resource: r,
    bookings: bookings.filter((b) => b.resource?.id === r.id && b.status !== 'canceled').sort((a, b) => ms(a.starts_at) - ms(b.starts_at)),
    busy: (r.busy ?? []).filter((x) => x.kind !== 'booking'),
  }));
}

/**
 * Ближайшая живая бронь сегодня для стола на плане зала: hall item + next_booking { starts_at, guest } (янтарная рамка).
 * Идущие брони (started) и прошедшие не показываем.
 */
export function withNextBooking(hall, bookings, now = Date.now()) {
  if (!Array.isArray(hall)) return hall;
  return hall.map((item) => {
    const next = (bookings ?? [])
      .filter((b) => b.resource?.id === item.resource.id && OPEN.includes(b.status) && ms(b.hold_until ?? b.ends_at) > now)
      .sort((a, b) => ms(a.starts_at) - ms(b.starts_at))[0];
    return next ? { ...item, next_booking: { starts_at: next.starts_at, id: next.id } } : item;
  });
}

/**
 * Может ли роль отменить бронь (№115): управляющий и владелец — любую живую, ресепшн — только phone/staff без предоплаты.
 */
export function canCancel(role, b) {
  if (!OPEN.includes(b?.status)) return false;
  if (role === 'owner' || role === 'manager') return true;
  if (role !== 'reception') return false;
  return ['phone', 'staff'].includes(b.source) && !(b.prepayment_kopecks > 0) && !(b.paid_kopecks > 0);
}

/** «Гость пришёл» — для брони по телефону, пока не сгорела. */
export function canArrive(b, now = Date.now()) {
  return ['phone', 'staff'].includes(b?.source) && ['confirmed', 'reserved'].includes(b.status) && now < ms(b.hold_until ?? b.ends_at);
}

/** Статус брони словами для персонала (рядом всегда слово, не только цвет). */
export const BOOKING_STAFF_WORD = Object.freeze({
  pending_payment: 'Ждёт предоплаты',
  confirmed: 'Подтверждена',
  reserved: 'Ждём гостя',
  started: 'Гость пришёл',
  completed: 'Сыграли',
  expired: 'Сгорела',
  canceled: 'Отменена',
});

/** Варианты начала брони по телефону: шаг клуба от открытия до закрытия минус минимум. */
export function startOptions(day, now = Date.now()) {
  if (!day?.open_at) return [];
  const step = (day.step_minutes ?? 30) * MIN;
  const min = (day.min_minutes ?? 60) * MIN;
  const out = [];
  for (let t = ms(day.open_at); t + min <= ms(day.close_at); t += step) if (t >= now) out.push(t);
  return out;
}
