import { plural } from '@billiardum/shared/format';

const HOURS = ['час', 'часа', 'часов'];

/** Цена часа в пакете, округлённая до рубля: для подписи «550 ₽/ч». */
export function packagePerHour(p) {
  const hours = p?.hours ?? (p?.minutes ?? 0) / 60;
  if (!(hours > 0)) return 0;
  return Math.round(p.price_kopecks / hours / 100) * 100;
}

/**
 * Пакет часов в чек кассы (server/orders/pos.mjs splitCart): { kind: 'package', package_id, phone } — гость обязателен
 * (guest_required), минуты лягут на его баланс; скидка кассы на пакет не действует.
 * @param {{ id: string, title: string, hours?: number, minutes?: number, price_kopecks: number }} p
 * @param {string} phone +7XXXXXXXXXX
 */
export function packageLine(p, phone) {
  const hours = p.hours ?? p.minutes / 60;
  return {
    key: `package:${p.id}:${phone}`,
    kind: 'package',
    package_id: p.id,
    phone,
    name: `Пакет «${p.title}»`,
    sub: `${hours} ${plural(hours, HOURS)} на баланс гостя ${maskTail(phone)}`,
    amount_kopecks: p.price_kopecks,
  };
}

/** «…67-89» — хвост номера для подписи в чеке кассира (полный номер не показываем). */
export function maskTail(phone) {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length >= 4 ? `…${d.slice(-4, -2)}-${d.slice(-2)}` : '';
}

/** Позиции пакетов для POST /api/pos/sales.items. */
export function packageItems(cart) {
  return cart.lines.filter((l) => l.kind === 'package').map((l) => ({ kind: 'package', package_id: l.package_id, phone: l.phone }));
}
