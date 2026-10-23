import { formatMoney, plural } from '@billiardum/shared/format';

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

/**
 * Партия пакета гостя для экрана возврата (№118): вернуть можно только целиком и пока часы не тратили.
 * Пакет из приложения — POST /api/packages/lots/{id}/refund (деньги — ЮKassa), с кассы — возврат продажи
 * POST /api/pos/sales/{sale_id}/refund { packages: [idx] } (деньги — тем же способом, что при продаже).
 * @returns {{ refundable: boolean, word: string, why: string | null, via: 'app' | 'pos' }}
 */
export function lotView(lot) {
  const via = lot?.source === 'pos' ? 'pos' : 'app';
  if (lot?.refunded_at) return { refundable: false, word: 'Возвращён', why: null, via };
  if ((lot?.minutes_left ?? 0) < (lot?.minutes_total ?? 0)) return { refundable: false, word: 'Часы тратили', why: 'Часы уже начали тратить — пакет не возвращается.', via };
  if (via === 'pos' && (!lot.sale_id || !Number.isInteger(lot.idx))) return { refundable: false, word: 'Не начислен', why: 'Продажа на кассе ещё не завершена.', via };
  return { refundable: true, word: 'Не тронут', why: null, via };
}

/** Тело запроса возврата партии: для кассы — только этот пакет из продажи. */
export function lotRefundCall(lot, reason) {
  return lot.source === 'pos' ? { kind: 'sale', id: lot.sale_id, body: { reason, packages: [lot.idx] } } : { kind: 'lot', id: lot.id, body: { reason } };
}

/**
 * Что сказать после возврата (ревью денег п. 7): наличные без открытой смены ждут её — ответ
 * { status: 'queued' }; ресепшн выдаст деньги и пробьёт чек возврата при открытии смены.
 * @returns {{ title: string, body: string, queued: boolean }}
 */
export function refundDoneText({ title, amount, via, status }) {
  const sum = formatMoney(amount);
  if (status === 'queued') {
    return { title: `Пакет «${title}»: вернём ${sum} наличными при открытии смены`, body: 'Смена сейчас закрыта. Ресепшн выдаст деньги гостю и пробьёт чек возврата, как только откроет смену; владелец получил уведомление.', queued: true };
  }
  return {
    title: `Пакет «${title}» возвращён: ${sum}`,
    body: via === 'pos' ? 'Деньги — тем же способом, что при продаже на кассе; чек возврата пробьётся сам.' : 'Деньги вернутся гостю через ЮKassa на карту или счёт СБП, чек возврата придёт ему сам.',
    queued: false,
  };
}

/**
 * Сбой ЮKassa при возврате (503 payment_failed): сервер доводит возврат тем же ключом, деньги могли
 * уйти. Кассиру — не «не прошло», а «нажмите Повторить»: тот же Idempotency-Key и то же тело.
 * @returns {{ retry: true, title: string, body: string } | null}
 */
export function refundRetryable(err) {
  if (err?.code !== 'payment_failed') return null;
  return {
    retry: true,
    title: 'ЮKassa не ответила. Возврат мог пройти — нажмите «Повторить»: второй раз деньги не спишутся',
    body: 'Не возвращайте деньги вручную, пока возврат не подтвердится.',
  };
}

/**
 * Один возврат партии: ключ идемпотентности создаётся один раз, тело замораживается при первой
 * отправке — «Повторить» после сбоя шлёт тот же запрос с тем же ключом (сервер доведёт, а не задвоит).
 * @param {{ refundSale: Function, refundLot: Function }} api
 * @param {object} lot
 * @param {() => string} newKey
 */
export function createRefund(api, lot, newKey) {
  const key = newKey();
  let call = null;
  let tries = 0;
  return {
    get key() {
      return key;
    },
    get sent() {
      return call !== null;
    },
    get tries() {
      return tries;
    },
    /** Первая отправка с причиной; дальнейшие вызовы — повтор того же запроса (причина уже не меняется). */
    async send(reason) {
      call ??= lotRefundCall(lot, reason);
      tries += 1;
      return call.kind === 'sale' ? api.refundSale(call.id, call.body, key) : api.refundLot(call.id, call.body.reason, key);
    },
  };
}
