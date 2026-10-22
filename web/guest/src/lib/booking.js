// Бронь на экране стола (M3): какую свою бронь можно начать у этого стола. Отдельно от JSX — проверяется в Node.

const MIN = 60_000;
/** Бронь, которую можно начать у стола: живая, не раньше чем за 2 часа до начала и до конца удержания (server/bookings, №107). */
export function startableBooking(list, resourceId, now = Date.now()) {
  return (
    (Array.isArray(list) ? list : []).find(
      (b) => b.resource?.id === resourceId && ['confirmed', 'reserved'].includes(b.status) && Date.parse(b.starts_at) - now <= 120 * MIN && now < Date.parse(b.hold_until ?? b.ends_at),
    ) ?? null
  );
}

