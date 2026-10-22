/** Заявка «Оплачу на ресепшене» живёт 15 минут (контракт §5). */
export const REQUEST_TTL = 15 * 60 * 1000;

/** Момент, когда заявка сгорит: expires_at сервера, иначе created_at + 15 минут. */
export function expiresOf(r) {
  return r.expires_at ? Date.parse(r.expires_at) : Date.parse(r.created_at) + REQUEST_TTL;
}

/**
 * Сколько минут до сгорания показывать: от текущего момента, не больше срока самой заявки
 * (часы планшета отстают от сервера и таймер экрана обновляется раз в секунду — без ограничения
 * у новой 15-минутной заявки выходило «сгорит через 16 минут»).
 * @param {{ expires_at?: string, created_at?: string }} r
 * @param {number} now мс
 * @returns {number} целые минуты, от 1 до срока заявки
 */
export function minutesLeft(r, now) {
  const expires = expiresOf(r);
  const created = Date.parse(r.created_at);
  const ttl = Number.isFinite(created) && expires > created ? expires - created : REQUEST_TTL;
  const left = Math.min(Math.max(0, expires - now), ttl);
  return Math.max(1, Math.min(Math.ceil(left / 60000), Math.floor(ttl / 60000) || 1));
}
