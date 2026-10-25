import { plural } from '@billiardum/shared/format';
import { cartTotals, orderItems } from '@billiardum/shared/bar';
import { familyOf, resourceName } from '@billiardum/shared/resource';
import { requestName } from './words.js';
import { requestLength } from './court.js';
import { packageItems } from './packages.js';

/**
 * Касса POS ресепшена (контракт M2 §4 `POST /api/pos/sales`): скидка, лимит, тело продажи.
 * Всё в целых копейках. Сервер пересчитывает итог сам; здесь — та же арифметика заранее, чтобы кассир видел сумму.
 */

/** Лимит скидки ресепшена по умолчанию (№82), если клуб не задал свой. */
export const DEFAULT_DISCOUNT_LIMIT = 10;

/** Строки, на которые действует скидка: бар (товары и счёт стола). Время стола — по тарифу и котировке гостя. */
export const DISCOUNTABLE = new Set(['product', 'tab']);

/** Сумма, от которой считается скидка. */
export function discountBase(cart) {
  return cart.lines.filter((l) => DISCOUNTABLE.has(l.kind)).reduce((s, l) => s + l.unit_kopecks * l.qty, 0);
}

/**
 * Скидка в копейках — как у сервера (server/orders/money.mjs): процент — целый от 1 до 100,
 * округление один раз «половина вверх» до копейки; сумма — копейки как есть, не больше базы.
 * @param {number} base копейки
 * @param {{ type: 'percent', value: number } | { type: 'amount', kopecks: number } | null} discount
 * @returns {number}
 */
export function discountKopecks(base, discount) {
  if (!discount || !Number.isSafeInteger(base) || base <= 0) return 0;
  if (discount.type === 'percent') {
    const p = Number(discount.value);
    if (!Number.isInteger(p) || p <= 0 || p > 100) return 0;
    return Math.floor((base * p * 2 + 100) / 200);
  }
  if (discount.type === 'amount') {
    const k = discount.kopecks;
    return Number.isSafeInteger(k) && k > 0 ? Math.min(k, base) : 0;
  }
  return 0;
}

/** Скидку на всю сумму бара сервер не принимает: бесплатно — это не скидка. */
export function wholeDiscount(base, discount) {
  return base > 0 && discount >= base;
}

/**
 * Нужна ли подтверждение управляющего: скидка больше лимита клуба в процентах (№82), ровно лимит — в пределах.
 * Сравнение целыми числами, как у сервера.
 * @param {number} base
 * @param {number} discount копейки
 * @param {number} limitPercent
 */
export function overLimit(base, discount, limitPercent = DEFAULT_DISCOUNT_LIMIT) {
  if (!discount || !base) return false;
  return discount * 100 > limitPercent * base;
}

/** Процент скидки от базы для подписи: 10, 12,5. */
export function discountPercent(base, discount) {
  if (!base || !discount) return 0;
  return Math.round((discount * 1000) / base) / 10;
}

/**
 * Итог чека: сумма строк, скидка, к оплате.
 * @returns {{ count: number, subtotal: number, base: number, discount: number, total: number }}
 */
export function saleTotals(cart, discount) {
  const { count, subtotal_kopecks: subtotal } = cartTotals(cart);
  const base = discountBase(cart);
  const d = discountKopecks(base, discount);
  return { count, subtotal, base, discount: d, total: subtotal - d };
}

/**
 * Тело `POST /api/pos/sales` по backend-pos (server/orders/pos.mjs createSale):
 * { method, items: [{ product_id, qty, modifier_ids }], tabs: [session_id], requests: [request_id],
 *   discount: { percent } | { amount_kopecks } + reason, received_kopecks, to_bar }.
 * Скидка выше лимита у ресепшена — discount.approval_id из POST /api/pos/discount-approvals (PIN управляющего, №95):
 * сервер сверяет ту же скидку (percent или amount_kopecks), корзину не крупнее одобренной и скидку не больше
 * max_discount_kopecks (№100); подтверждение одноразовое и живёт 5 минут.
 */
export function saleBody(cart, opts) {
  const body = {
    method: opts.method,
    // Товары бара и пакеты часов (M3: { kind: 'package', package_id, phone })
    items: [...orderItems(cart), ...packageItems(cart)],
    tabs: cart.lines.filter((l) => l.kind === 'tab').map((l) => l.session_id),
    requests: cart.lines.filter((l) => l.kind === 'request').map((l) => l.request_id),
  };
  const { discount } = saleTotals(cart, opts.discount);
  if (discount > 0) {
    body.discount = opts.discount.type === 'percent' ? { percent: Number(opts.discount.value) } : { amount_kopecks: discount };
    if (opts.reason) {
      body.discount.reason = opts.reason.text;
      body.discount.reason_code = opts.reason.code;
    }
    if (opts.approval?.approval_id) body.discount.approval_id = opts.approval.approval_id;
  }
  if (opts.method === 'cash') body.received_kopecks = opts.receivedKopecks;
  if (opts.toBar !== undefined) body.to_bar = Boolean(opts.toBar) && body.items.some((i) => i.kind !== 'package');
  return body;
}

/**
 * Продажа из ответа сервера в один вид: backend-pos отдаёт sale_id, status pending | completed | canceled,
 * receipt_status и confirmation на верхнем уровне; старый вид заглушки — id, payment, receipt.
 */
export function normalizeSale(res) {
  if (!res || typeof res !== 'object') return null;
  const status = res.status === 'paid' ? 'completed' : res.status;
  const receipt = res.receipt ?? (res.receipt_status || res.receipt_id ? { status: res.receipt_status ?? null, receipt_id: res.receipt_id ?? null, fd: res.receipt_fd ?? null, fp: res.receipt_fp ?? null } : null);
  return {
    ...res,
    id: res.sale_id ?? res.id,
    status,
    paid: status === 'completed',
    pending: status === 'pending',
    canceled: status === 'canceled',
    method: res.method ?? res.payment?.method,
    confirmation: res.confirmation ?? res.payment?.confirmation ?? null,
    receipt,
    hasTable: Array.isArray(res.table_payments) ? res.table_payments.length > 0 : Array.isArray(res.lines) && res.lines.some((l) => l.kind === 'request'),
  };
}

/**
 * Состояние кассы ККТ: backend-kkt шлёт { state: online | warning | offline, reason, bridges, queue: { pending, failed } }
 * (и в SSE `kkt`); старый вид — { online, pending_receipts }.
 * @returns {{ known: boolean, online: boolean, warning: boolean, pending: number, failed: number, reason: string | null }}
 */
export function kktState(s) {
  if (!s || typeof s !== 'object') return { known: false, online: true, warning: false, pending: 0, failed: 0, reason: null };
  const online = s.state ? s.state !== 'offline' : s.online !== false;
  return {
    known: true,
    online,
    warning: s.state === 'warning',
    pending: s.queue?.pending ?? s.pending_receipts ?? 0,
    failed: s.queue?.failed ?? 0,
    reason: s.reason ?? null,
  };
}

/** Заявка ресепшена в корзину: «Стол 4 · 2 ч», «Корт 1 · 1 слот · 1,5 ч» (M5.8: resource_family, slot_minutes). */
export function requestLine(r) {
  const court = familyOf({ family: r.resource_family, type: r.resource_type }) === 'court';
  return { key: `request:${r.id}`, kind: 'request', request_id: r.id, name: `${requestName(r)} · ${requestLength(r)}`, sub: r.kind === 'extend' ? 'Продление игры' : court ? 'Время корта' : 'Время стола', amount_kopecks: r.amount_kopecks };
}

/** Название открытого счёта: «Стол 3», «Корт 1» (M5.8: resource.family). */
export const tabName = (t, opts) => resourceName(t.resource ?? 'table', t.resource?.number ?? t.resource_number, opts);

/** Заголовок списка открытых счетов: «Счета столов», «Счета кортов», у клуба с обоими — «Счета столов и кортов». */
export function tabsTitle(tabs) {
  const courts = (tabs ?? []).filter((t) => familyOf(t.resource ?? { type: t.resource_type }) === 'court').length;
  if (!courts) return 'Счета столов';
  return courts === tabs.length ? 'Счета кортов' : 'Счета столов и кортов';
}

/** Счёт стола в корзину: «Счёт стола 3 · 2 заказа бара». Сервер: { session_id, resource: { number, type, family }, orders: N, total_kopecks }. */
export function tabLine(t) {
  const n = typeof t.orders === 'number' ? t.orders : Array.isArray(t.orders) ? t.orders.length : (t.orders_count ?? 0);
  return {
    key: `tab:${t.session_id}`,
    kind: 'tab',
    session_id: t.session_id,
    name: `Счёт ${tabName(t, { case: 'gen', capital: false })}`,
    sub: n ? `${n} ${plural(n, ['заказ', 'заказа', 'заказов'])} бара` : 'Заказы бара',
    amount_kopecks: t.total_kopecks,
  };
}

/**
 * Состояние фискального чека для кассира. Наличные и карта на терминале — ККТ клуба (№84):
 * printed | receipt_pending | failed; мост не на связи — «пробьётся позже». СБП — чек ЮKassa.
 * @returns {{ tone: 'ok' | 'wait' | 'warn' | 'none', title: string, text: string }}
 */
export function receiptView(receipt, kktOnline, method) {
  const st = receipt?.status ?? null;
  if (method === 'sbp') {
    if (st === 'failed') return { tone: 'warn', title: 'Чек ЮKassa не сформировался', text: 'Оплата прошла. Проверьте чек в личном кабинете ЮKassa.' };
    return { tone: 'none', title: 'Чек отправит ЮKassa', text: 'По СБП фискальный чек формирует ЮKassa.' };
  }
  if (st === 'printed' || st === 'succeeded') {
    return { tone: 'ok', title: 'Чек пробит', text: receipt.fd ? `ФД № ${receipt.fd}${receipt.fp ? `, ФП ${receipt.fp}` : ''}.` : 'Касса напечатала чек.' };
  }
  if (st === 'failed') return { tone: 'warn', title: 'Чек не пробился', text: 'Касса вернула ошибку. Продажа сохранена — проверьте кассу, чек повторится из очереди.' };
  if (kktOnline === false) return { tone: 'warn', title: 'Касса не на связи, чек пробьётся позже', text: 'Продажа сохранена. Чек напечатается, как только касса выйдет на связь.' };
  return { tone: 'wait', title: 'Пробиваем чек…', text: 'Касса печатает чек.' };
}

/** «3 позиции» для кнопки корзины. */
export function itemsWord(n) {
  return plural(n, ['позиция', 'позиции', 'позиций']);
}

/**
 * Тело POST /api/pos/discount-approvals (№95, №100): та же скидка, что уйдёт в продажу, и сумма бара в чеке —
 * { user_id, pin, reason_code, reason_text, percent | amount_kopecks, subtotal_kopecks }.
 */
export function approvalBody({ approver, pin, reason, discount, discountKopecks: kop, subtotalKopecks }) {
  return {
    user_id: approver,
    pin,
    reason_code: reason.code,
    reason_text: reason.text,
    ...(discount.type === 'percent' ? { percent: Number(discount.value) } : { amount_kopecks: kop }),
    subtotal_kopecks: subtotalKopecks,
  };
}

/**
 * Сервер подтвердил ровно то, что видел управляющий (№103): subtotal_kopecks и max_discount_kopecks ответа
 * совпадают с показанными «Корзина … · скидка …». Старый ответ без этих полей — не с чем сверять, принимаем.
 */
export function approvalMatches(res, subtotalKopecks, discountKopecks) {
  if (!res || typeof res !== 'object') return false;
  if (res.subtotal_kopecks !== undefined && res.subtotal_kopecks !== subtotalKopecks) return false;
  if (res.max_discount_kopecks !== undefined && res.max_discount_kopecks !== discountKopecks) return false;
  return true;
}

/** Ответ POST /api/pos/discount-approvals словами: 401 — неверный PIN, 403 — не управляющий, 429 — PIN заблокирован. */
export function approvalError(err) {
  const code = err?.code;
  if (code === 'unauthorized') return { code: 'pin_invalid' };
  if (code === 'rate_limited') return { code: 'pin_locked' };
  if (code === 'forbidden') return { code: 'approver_forbidden' };
  if (code === 'not_found' || code === 'method_not_allowed') return { code: 'approval_unavailable' };
  return err;
}
