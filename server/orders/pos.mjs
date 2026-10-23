// Касса ресепшена и оплаты бара (контракт M2 §4, §5; decisions №79, №81–83; инварианты 7, 8, 10).
//
// Продажа (bl.pos_sales) — одна оплата бара:
//   * касса (channel pos): корзина товаров с модификаторами, счета столов (tabs), заявки стола M1
//     (requests — принимаются функцией ресепшена money acceptRequest: её платёж, её чек ККТ,
//     её payment.confirmed для света); скидка; оплата cash (полученная сумма, сдача),
//     card_terminal или sbp (QR ЮKassa на экране ресепшена);
//   * гость (channel guest): заказ со стола онлайн или счёт стола онлайн (СБП, карта).
// Без открытой смены касса не продаёт (shift_closed, currentShift kkt).
// Завершение (completeSale) — в одной транзакции: заказы оплачены, склад (sale), чек
// (ККТ — enqueueReceipt kkt; ЮKassa — чек платежа), outbox sale.completed, журнал pos.sale.
// Наличные и терминал завершаются сразу; СБП и карта — по payment.confirmed (settleSale).
// Заказ, оплаченный дважды (наличные на кассе, пока шла оплата онлайн), — возврат лишнего
// ЮKassa и тревога (двойная оплата счёта).
// Возврат (refundSale) — управляющий и выше, с причиной: деньги (bl.refunds money), чек
// возврата, склад (return), журнал pos.refund, тревога владельцу; деньги, чек возврата и
// payment.refunded — функция refund money.
// Платежи — только через функции money (server/payments/api.mjs), см. ./payments.mjs.
//
// Пакет часов на кассе (M3, контракт m3.md §1 п. 10; decisions №112): позиция корзины
// { kind: 'package', package_id, user_id | phone } — гость обязателен (guest_required). Строка чека —
// money packageSaleLine (признак расчёта «предоплата 100 %»), скидка кассы на пакет не действует.
// Платёж продажи — бар после скидки + пакеты (bl.pos_sales.package_kopecks, строки
// bl.pos_sale_packages). После оплаты (completeSale) — money creditPackageForSale: минуты на баланс
// гостя (повтор — та же партия). Гость — только существующий (decisions №117): учётка по id или
// телефону с согласием на обработку данных (bl.pos_guest, учётку не создаёт); нет — 409
// guest_not_found, в лог — маска телефона.
// Возврат пакета (№118) — в возврате продажи (`packages: [idx]`), целиком и пока партия минут не
// тронута: money revokeLotOnly отзывает партию (package_used, already_refunded — 409), деньги и чек
// возврата (позиция «предоплата 100 %») — как у бара. Без `packages` возврат пакеты не затрагивает.

import { randomUUID } from 'node:crypto';
import { maskPhone } from '../lib/log.mjs';
import { withContext as storeWithContext } from '../lib/store.mjs';
import { ALARM_TEXT as LOOKUP_ALARM_TEXT, ALARM_TYPE as LOOKUP_ALARM_TYPE, guestLookupGuard } from './guest-lookup.mjs';
import { acceptRequest } from '../reception/index.mjs';
import { stableUuid } from '../payments/records.mjs';
import { syncPayment } from '../payments/pay.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';
import { resolveItems, alcoholAllowedForGuests } from '../catalog/api.mjs';
import { insertMovement, recordReturns, recordSales, toMilli } from '../stock/api.mjs';
import { enqueueReceiptDirect } from './deps.mjs';
import { PosError } from './errors.mjs';
import { allocate, discountKopecks, overLimit, receiptLines, refundAmount, rub } from './money.mjs';
import { creditPackage, offlinePayment, onlineAvailable, onlinePayment, packageLine, receiptCustomer, refundPayment, revokePackage } from './payments.mjs';
import { posSettings } from './settings.mjs';
import { useApproval } from './approvals.mjs';
import {
  hasRole,
  insertOrder,
  isUuid,
  iso,
  loadOrders,
  MANAGER_ROLES,
  orderView,
  publishClub,
  publishOrder,
  requireKey,
} from './core.mjs';

export const POS_METHODS = Object.freeze(['cash', 'card_terminal', 'sbp']);
export const GUEST_METHODS = Object.freeze(['sbp', 'card']);
const MAX_CHANGE_KOPECKS = 10_000_000;
export const MAX_CART_LINES = 50;
export const MAX_PACKAGES = 5;
const PHONE = /^\+[1-9]\d{7,14}$/;

const bad = (detail) => new PosError('bad_request', detail);

async function operatorName(db, userId) {
  if (!isUuid(userId)) return 'Кассир';
  const { rows } = await db.query('select name from bl.users where id = $1', [userId]);
  return (rows[0]?.name ?? '').trim().slice(0, 64) || 'Кассир';
}

/** Открытая смена клуба; forUpdate — строка смены заблокирована до конца транзакции (закрытие ждёт). */
async function currentShift(db, deps, clubId, { forUpdate = false } = {}) {
  const shift = await deps.shifts.currentShift(db, clubId, forUpdate ? { forUpdate: true } : undefined);
  return shift && isUuid(shift.id) ? shift : null;
}

/** Задание на чек ККТ: модуль kkt (enqueueReceipt) или строка bl.receipts напрямую. */
async function enqueueKktReceipt(db, deps, args) {
  if (typeof deps.kkt.enqueueReceipt === 'function') {
    const res = await deps.kkt.enqueueReceipt(db, {
      clubId: args.clubId,
      kind: args.kind,
      lines: args.lines,
      payments: args.payments,
      operatorName: args.operatorName,
      paymentId: args.paymentId ?? undefined,
      saleId: args.saleId ?? undefined,
      refundId: args.refundId ?? undefined,
    });
    return typeof res === 'string' ? res : res?.receipt_id ?? res?.id ?? null;
  }
  return enqueueReceiptDirect(db, args);
}

// Корзина: товары бара и пакеты часов -------------------------------------------------------------

/**
 * Разделить корзину кассы на товары бара (как в каталоге) и пакеты часов.
 * Пакет: { kind: 'package', package_id, user_id } или { kind: 'package', package_id, phone } (E.164).
 * @returns {{ products: object[], packages: { package_id: string, user_id: string|null, phone: string|null }[] }}
 */
export function splitCart(items) {
  if (items === undefined || items === null) return { products: [], packages: [] };
  if (!Array.isArray(items) || items.length > MAX_CART_LINES) throw bad('items');
  const products = [];
  const packages = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw bad(`items[${i}]`);
    if (it.kind === 'package') {
      if (!isUuid(it.package_id)) throw bad(`items[${i}].package_id`);
      if (it.qty !== undefined && it.qty !== 1) throw bad(`items[${i}].qty: один пакет в строке`);
      const hasUser = it.user_id !== undefined && it.user_id !== null;
      const hasPhone = it.phone !== undefined && it.phone !== null && it.phone !== '';
      if (!hasUser && !hasPhone) throw new PosError('guest_required', `items[${i}]`);
      if (hasUser && hasPhone) throw bad(`items[${i}]: user_id или phone`);
      if (hasUser && !isUuid(it.user_id)) throw bad(`items[${i}].user_id`);
      if (hasPhone && (typeof it.phone !== 'string' || !PHONE.test(it.phone))) throw bad(`items[${i}].phone`);
      packages.push({ package_id: it.package_id, user_id: hasUser ? it.user_id : null, phone: hasPhone ? it.phone : null });
      return;
    }
    if (it.kind !== undefined && it.kind !== 'product') throw bad(`items[${i}].kind`);
    const { kind: _kind, ...product } = it;
    products.push(product);
  });
  if (packages.length > MAX_PACKAGES) throw bad(`пакетов в продаже не больше ${MAX_PACKAGES}`);
  return { products, packages };
}

/**
 * Гость пакета — только существующий (№117): учётка по id или телефону, не влитая, с телефоном и
 * согласием (bl.pos_guest; учётку не создаёт). Нет — 409 guest_not_found, телефон в лог — маской.
 * №121: не больше 20 поисков в минуту на сотрудника (429 rate_limited); 10 промахов за час —
 * тревога владельцу guest_lookup_misses (своей транзакцией: транзакция запроса откатится).
 */
async function resolveGuest(db, deps, p, { clubId, staffId, at }) {
  const guard = deps.guestLookup ?? guestLookupGuard;
  guard.lookup(staffId, at);
  const { rows } = await db.query('select bl.pos_guest($1, $2) as id', [p.user_id ?? null, p.user_id ? null : p.phone]);
  if (rows[0]?.id) return rows[0].id;
  // Тревога — своей транзакцией и без ожидания (pentester R-1): обработчик не держит соединение запроса,
  // пока ждёт второе из того же пула; запрос откатится и отдаст соединение, тревога запишется следом.
  if (guard.miss(staffId, at)) void raiseLookupAlarm(deps, { clubId, staffId, misses: guard.missesInHour(staffId, at) });
  throw new PosError('guest_not_found', p.user_id ? `user ${p.user_id}` : `phone ${maskPhone(p.phone)}`);
}

async function raiseLookupAlarm(deps, { clubId, staffId, misses }) {
  const raise = (db) =>
    deps.alarms.raise(db, clubId, {
      type: LOOKUP_ALARM_TYPE,
      level: 'important',
      data: { staff_id: staffId, misses },
      text: LOOKUP_ALARM_TEXT,
      dedupeKey: `staff:${staffId}`,
    });
  try {
    if (deps.pool) await (deps.withContext ?? storeWithContext)(deps.pool, { clubId, actorType: 'system' }, raise);
    else deps.log?.error?.('guest_lookup_alarm_unrouted', { club_id: clubId, staff_id: staffId, misses });
  } catch (err) {
    deps.log?.error?.('guest_lookup_alarm_failed', { club_id: clubId, staff_id: staffId, error: err.message });
  }
}

/** Пакеты корзины: позиция чека и цена (money); гость — позже, resolvePackageGuests. */
async function resolvePackages(db, packages) {
  const out = [];
  for (const p of packages) {
    const sale = await packageLine(db, p.package_id);
    out.push({ ...p, user_id: null, amount_kopecks: sale.amount_kopecks, line: sale.line, title: sale.package.title });
  }
  return out;
}

/**
 * Гости пакетов — последний шаг проверки корзины (pentester L1, №121): после счетов, товаров,
 * пакетов, заявок стола, скидки, смены и способа оплаты, до записи и платежей. Любая другая ошибка
 * корзины отвечает раньше и одинаково для существующего и несуществующего гостя — сверка номеров
 * по виду ошибки невозможна, а такие запросы не идут в лимит и промахи.
 */
async function resolvePackageGuests(db, deps, packages, who) {
  for (const p of packages) p.user_id = await resolveGuest(db, deps, { user_id: p.user_id_in ?? null, phone: p.phone ?? null }, who);
}

async function loadSalePackages(db, saleId) {
  const { rows } = await db.query('select * from bl.pos_sale_packages where sale_id = $1 order by idx', [saleId]);
  return rows.map((r) => ({ ...r, amount_kopecks: Number(r.amount_kopecks) }));
}

// Строки продажи ---------------------------------------------------------------------------------

/** Строки продажи с данными заказа (для чека, склада, возврата). */
async function loadSaleItems(db, saleId, { lockOrders = false } = {}) {
  const { rows } = await db.query(
    `select si.*, oi.name, coalesce(oi.product_name, p.name) as product_name, oi.qty as item_qty, oi.product_id, oi.stock_factor::text as stock_factor, oi.track_stock, oi.vat_code,
            oi.payment_subject, oi.is_alcohol, oi.amount_kopecks as item_amount
       from bl.pos_sale_items si join bl.order_items oi on oi.id = si.order_item_id join bl.orders o on o.id = si.order_id
       join bl.products p on p.id = oi.product_id
      where si.sale_id = $1
      order by o.created_at, o.id, oi.position`,
    [saleId],
  );
  if (lockOrders && rows.length > 0) {
    await db.query('select id from bl.orders where id = any($1::uuid[]) order by id for update', [[...new Set(rows.map((r) => r.order_id))]]);
  }
  return rows.map((r) => ({ ...r, amount_kopecks: Number(r.amount_kopecks), refunded_kopecks: Number(r.refunded_kopecks) }));
}

function linesFor(rows) {
  return receiptLines(rows.map((r) => ({ name: r.name, qty: r.qty, amount_kopecks: r.amount_kopecks, vat_code: r.vat_code, payment_subject: r.payment_subject })));
}

/**
 * Вставить строки продажи: скидка раскладывается по строкам пропорционально суммам.
 * @param {{ order_id: string, id: string, qty: number, amount_kopecks: number|string }[]} items строки заказов
 */
/** Раскладка скидки по строкам; строка не дешевле копейки за единицу (иначе позиция чека с нулём). */
export function splitDiscount(items, discount) {
  const amounts = items.map((i) => Number(i.amount_kopecks));
  const parts = allocate(discount, amounts);
  items.forEach((i, k) => {
    if (amounts[k] - parts[k] < i.qty) throw bad('скидка: строка дешевле копейки за единицу');
  });
  return { amounts, parts };
}

async function insertSaleItems(db, { clubId, saleId, items, discount }) {
  const { amounts, parts } = splitDiscount(items, discount);
  const out = [];
  for (const [k, i] of items.entries()) {
    const amount = amounts[k] - parts[k];
    const { rows } = await db.query(
      `insert into bl.pos_sale_items (club_id, sale_id, order_id, order_item_id, qty, amount_kopecks, discount_kopecks)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [clubId, saleId, i.order_id, i.id, i.qty, amount, parts[k]],
    );
    out.push(rows[0]);
  }
  return out;
}

// Ответ ------------------------------------------------------------------------------------------

export async function saleView(db, saleId, { confirmation = null } = {}) {
  const { rows } = await db.query('select * from bl.pos_sales where id = $1', [saleId]);
  const s = rows[0];
  if (!s) return null;
  const items = await loadSaleItems(db, saleId);
  const req = await db.query('select request_id, payment_id, amount_kopecks from bl.pos_sale_requests where sale_id = $1 order by request_id', [saleId]);
  let conf = confirmation;
  if (!conf && s.status === 'pending' && s.payment_id) {
    const p = (await db.query('select confirmation_url, method from bl.payments where id = $1', [s.payment_id])).rows[0];
    if (p?.confirmation_url) conf = s.channel === 'pos' ? { type: 'qr', confirmation_data: p.confirmation_url } : { type: 'redirect', url: p.confirmation_url };
  }
  // Чек продажи бара: статус и фискальные признаки ККТ (fd, fp — после пробития, server/kkt).
  const receipt = s.receipt_id ? (await db.query('select status, fd, fp from bl.receipts where id = $1', [s.receipt_id])).rows[0] ?? null : null;
  const packages = await loadSalePackages(db, saleId);
  return {
    sale_id: s.id,
    channel: s.channel,
    status: s.status,
    method: s.method,
    payment_id: s.payment_id,
    session_id: s.session_id,
    shift_id: s.shift_id,
    bar_subtotal_kopecks: Number(s.bar_subtotal_kopecks),
    discount_kopecks: Number(s.discount_kopecks),
    bar_kopecks: Number(s.bar_total_kopecks),
    table_kopecks: Number(s.table_kopecks),
    package_kopecks: Number(s.package_kopecks ?? 0),
    total_kopecks: Number(s.bar_total_kopecks) + Number(s.package_kopecks ?? 0) + Number(s.table_kopecks),
    received_kopecks: s.received_kopecks === null ? null : Number(s.received_kopecks),
    change_kopecks: s.change_kopecks === null ? null : Number(s.change_kopecks),
    refunded_kopecks: Number(s.refunded_kopecks),
    receipt_id: s.receipt_id,
    receipt_status: receipt?.status ?? null,
    receipt_fd: receipt?.fd == null ? null : Number(receipt.fd),
    receipt_fp: receipt?.fp ?? null,
    items: items.map((i) => ({
      id: i.id,
      order_id: i.order_id,
      order_item_id: i.order_item_id,
      product_id: i.product_id,
      product_name: i.product_name,
      name: i.name,
      qty: i.qty,
      amount_kopecks: i.amount_kopecks,
      discount_kopecks: Number(i.discount_kopecks),
      outcome: i.outcome,
      refunded_qty: i.refunded_qty,
      refunded_kopecks: i.refunded_kopecks,
    })),
    packages: packages.map((p) => ({
      package_id: p.package_id,
      user_id: p.user_id,
      title: typeof p.line?.description === 'string' ? p.line.description : null,
      idx: p.idx,
      amount_kopecks: p.amount_kopecks,
      lot_id: p.lot_id ?? null,
      refunded_at: iso(p.refunded_at ?? null),
    })),
    table_payments: req.rows.map((r) => ({ request_id: r.request_id, payment_id: r.payment_id, amount_kopecks: Number(r.amount_kopecks) })),
    ...(conf && s.status === 'pending' ? { confirmation: conf } : {}),
    created_at: iso(s.created_at),
    completed_at: iso(s.completed_at),
    canceled_at: iso(s.canceled_at),
  };
}

// Продажа на кассе -------------------------------------------------------------------------------

function parseUuidList(v, max, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || !v.every(isUuid) || new Set(v).size !== v.length) throw bad(name);
  return v;
}

/** Открытые заказы счёта стола (в счёте, не оплачены, не отменены), заблокированы. */
export async function lockOpenTabOrders(db, sessionIds) {
  if (sessionIds.length === 0) return [];
  const { rows } = await db.query(
    `select id from bl.orders
      where session_id = any($1::uuid[]) and pay_mode = 'tab' and paid_at is null and status <> 'canceled' and committed_at is not null
      order by created_at, id
      for update`,
    [sessionIds],
  );
  return loadOrders(db, rows.map((r) => r.id));
}

/**
 * POST /api/pos/sales (и счёт стола на кассе). info.roles — роли сотрудника в клубе.
 * @returns {Promise<object>} saleView (+ confirmation для СБП)
 */
export async function createSale(db, deps, info) {
  const key = requireKey(info);
  const clubId = info.clubId;
  const staffId = info.userId;
  if (!hasRole(info.roles, ['owner', 'manager', 'reception'])) throw new PosError('forbidden', 'касса');
  const b = info.body ?? {};
  const method = b.method;
  if (!POS_METHODS.includes(method)) throw bad('method');
  const cart = splitCart(b.items);
  const hasItems = cart.products.length > 0;
  const tabs = parseUuidList(b.tabs, 5, 'tabs');
  const requests = parseUuidList(b.requests, 10, 'requests');
  if (!hasItems && cart.packages.length === 0 && tabs.length === 0 && requests.length === 0) throw bad('пустая корзина');
  if (b.to_bar !== undefined && typeof b.to_bar !== 'boolean') throw bad('to_bar');
  if (method === 'sbp' && requests.length > 0) throw bad('заявку стола принимают наличными или картой (money M1)');

  const prev = await db.query('select id from bl.pos_sales where club_id = $1 and request_key = $2', [clubId, key]);
  if (prev.rowCount > 0) return saleView(db, prev.rows[0].id);

  // Строка смены блокируется: закрытие смены ждёт продажу (иначе наличные выпадут из сверки).
  const shift = await currentShift(db, deps, clubId, { forUpdate: true });
  if (!shift) throw new PosError('shift_closed');
  const at = deps.clock.now();
  const settings = await loadPaymentSettings(db, clubId);
  const pos = await posSettings(db, clubId);

  const lines = hasItems ? await resolveItems(db, { clubId, items: cart.products, audience: 'staff', defaultVat: settings.vat_code }) : [];
  const packages = await resolvePackages(db, cart.packages.map((p) => ({ package_id: p.package_id, user_id_in: p.user_id, phone: p.phone })));
  const packageTotal = packages.reduce((sum, p) => sum + p.amount_kopecks, 0);
  const tabOrders = await lockOpenTabOrders(db, tabs);
  if (tabs.length > 0 && tabOrders.length === 0) throw new PosError('already_paid', 'счёт стола пуст или оплачен');
  for (const sid of tabs) {
    if (!tabOrders.some((o) => o.session_id === sid)) throw new PosError('already_paid', `счёт ${sid}`);
  }

  // Заявки стола M1: сумма и статус — до приёма (принимает money).
  const reqRows = [];
  for (const id of requests) {
    const { rows } = await db.query('select id, amount_kopecks, status, expires_at from bl.reception_requests where id = $1 for update', [id]);
    const r = rows[0];
    if (!r) throw new PosError('not_found', `request ${id}`);
    // Те же проверки, что у приёма заявки money (acceptRequest), — до поиска гостя пакета.
    if (r.status === 'accepted') throw new PosError('quote_used', `request ${id}`);
    if (r.status !== 'waiting' || new Date(r.expires_at).getTime() <= at.getTime()) throw new PosError('quote_expired', `request ${id}`);
    reqRows.push({ id, amount: Number(r.amount_kopecks) });
  }

  const barSubtotal = lines.reduce((s, l) => s + l.amount_kopecks, 0) + tabOrders.reduce((s, o) => s + Number(o.subtotal_kopecks), 0);
  let discount;
  try {
    discount = discountKopecks(b.discount ?? null, barSubtotal);
  } catch {
    throw bad('discount');
  }
  let reason = typeof b.discount?.reason === 'string' ? b.discount.reason.trim() : '';
  if (reason.length > 2000) throw bad('discount.reason');
  const over = overLimit(discount, barSubtotal, pos.discount_limit_percent);
  // Подтверждение PIN управляющего на этом терминале (№95): та же скидка, одноразовое, 5 минут.
  let approval = null;
  if (b.discount?.approval_id !== undefined && b.discount?.approval_id !== null) {
    if (discount <= 0) throw bad('discount.approval_id без скидки');
    approval = await useApproval(db, { approvalId: b.discount.approval_id, discount: b.discount, discountKopecks: discount, subtotal: barSubtotal, at });
    reason = approval.reason_text;
  }
  if (over && !approval) {
    // Скидка выше лимита клуба — только управляющий и выше (сам на кассе или PIN), с причиной (№82).
    if (!hasRole(info.roles, MANAGER_ROLES)) throw new PosError('limit_exceeded', 'скидка выше лимита ресепшена');
    if (!reason) throw new PosError('reason_required', 'скидка выше лимита');
  }
  const barTotal = barSubtotal - discount;
  if (barSubtotal > 0 && barTotal <= 0) throw bad('скидка на всю сумму');
  const tableTotal = reqRows.reduce((s, r) => s + r.amount, 0);
  // Платёж продажи: бар после скидки и пакеты часов (заявки стола — свои платежи money).
  const saleTotal = barTotal + packageTotal;
  const total = saleTotal + tableTotal;
  if (total <= 0) throw bad('сумма');

  let received = null;
  let change = null;
  if (method === 'cash') {
    received = b.received_kopecks;
    if (!Number.isSafeInteger(received) || received < total || received > total + MAX_CHANGE_KOPECKS) throw bad('received_kopecks');
    change = received - total;
  } else if (b.received_kopecks !== undefined && b.received_kopecks !== null && b.received_kopecks !== total) {
    throw bad('received_kopecks для безналичной оплаты');
  }

  const sbp = method === 'sbp';
  // Раскладка скидки по строкам (только суммы и количества) и контакт для чека СБП — проверить до
  // поиска гостя: позже корзина падать не должна.
  splitDiscount([...lines, ...tabOrders.flatMap((o) => o.items)], discount);
  let sbpCustomer = null;
  if (sbp && saleTotal > 0) {
    // СБП у клуба выключена или нет магазина ЮKassa — тот же ответ, что дала бы money, но до поиска.
    if (!(await onlineAvailable(db, { clubId, method: 'sbp' }))) throw bad('СБП недоступна');
    sbpCustomer = receiptCustomer({ phone: b.customer_phone ?? null, email: pos.receipt_email });
    if (b.customer_phone !== undefined && b.customer_phone !== null && !receiptCustomer({ phone: b.customer_phone })) throw bad('customer_phone');
    if (!sbpCustomer) throw new PosError('phone_required', 'нет контакта для чека ЮKassa');
  }
  // Гости пакетов — последней проверкой, до записи и платежей (pentester L1).
  await resolvePackageGuests(db, deps, packages, { clubId, staffId, at });

  // id продажи — от ключа идемпотентности: повтор после таймаута ЮKassa — тот же платёж (bar-<sale>),
  // без второго платежа-сироты.
  const saleId = stableUuid(`bl.pos.sale/${clubId}/${key}`);
  // Заказ кассы: сразу выдан или на экран бара (to_bar). При СБП — после оплаты.
  let posOrder = null;
  if (lines.length > 0) {
    posOrder = await insertOrder(db, {
      clubId,
      source: 'pos',
      payMode: 'pos',
      status: b.to_bar ? 'new' : 'served',
      createdBy: staffId,
      comment: typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 200) : null,
      committedAt: sbp ? null : at,
      at,
    }, lines);
  }
  const saleOrderItems = [
    ...(posOrder ? posOrder.items.map((i) => ({ ...i, order_id: posOrder.order.id })) : []),
    ...tabOrders.flatMap((o) => o.items.map((i) => ({ ...i, order_id: o.id }))),
  ];
  const { amounts, parts } = splitDiscount(saleOrderItems, discount);

  // Платёж бара: наличные и терминал — сразу; СБП — QR ЮKassa.
  let payment = null;
  let confirmation = null;
  if (saleTotal > 0) {
    if (sbp) {
      const customer = sbpCustomer;
      // Позиции чека — из строк продажи после раскладки скидки (в базе их ещё нет: считаем здесь).
      const preview = saleOrderItems.map((i, k) => ({ name: i.name, qty: i.qty, amount_kopecks: amounts[k] - parts[k], vat_code: i.vat_code, payment_subject: i.payment_subject }));
      const r = await onlinePayment(db, deps, {
        clubId,
        saleId,
        method: 'sbp',
        amount: saleTotal,
        lines: [...(preview.length > 0 ? receiptLines(preview) : []), ...packages.map((p) => p.line)],
        customer,
        phone: typeof b.customer_phone === 'string' ? b.customer_phone : null,
        confirmation: 'qr',
        description: 'Бар, касса',
        requestKey: key,
      });
      payment = r.payment;
      confirmation = r.confirmation;
    } else {
      // Наличные: платежу бара — полученное за вычетом заявок стола, сдача — у него.
      payment = await offlinePayment(db, deps, {
        clubId,
        saleId,
        method,
        amount: saleTotal,
        received: method === 'cash' ? received - tableTotal : null,
        staffId,
        requestKey: key,
      });
    }
  }

  await db.query(
    `insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, session_id, created_by, shift_id, bar_subtotal_kopecks,
                               discount_kopecks, bar_total_kopecks, table_kopecks, received_kopecks, change_kopecks, discount_reason,
                               discount_over_limit, request_key, package_kopecks, created_at, updated_at)
     values ($1, $2, 'pos', $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)`,
    [saleId, clubId, method, payment?.id ?? null, tabs.length === 1 ? tabs[0] : null, staffId, shift.id, barSubtotal, discount, barTotal,
      tableTotal, received, change, reason || null, over, key, packageTotal, at],
  );
  if (saleOrderItems.length > 0) await insertSaleItems(db, { clubId, saleId, items: saleOrderItems, discount });
  for (const [idx, p] of packages.entries()) {
    await db.query(
      `insert into bl.pos_sale_packages (club_id, sale_id, idx, package_id, user_id, amount_kopecks, line, created_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [clubId, saleId, idx, p.package_id, p.user_id, p.amount_kopecks, JSON.stringify(p.line), at],
    );
  }

  // Заявки стола — через ресепшн money (платёж, чек ККТ, payment.confirmed для света).
  // Наличные: каждой заявке — ровно её сумма, сдача — у последнего платежа (бар или заявка).
  for (const [k, r] of reqRows.entries()) {
    const lastMoney = saleTotal === 0 && k === reqRows.length - 1;
    const res = await acceptRequest(db, deps.money, {
      params: { id: r.id },
      idempotencyKey: stableUuid(`bl.pos.request/${key}/${r.id}`),
      body: { method, ...(method === 'cash' ? { received_kopecks: lastMoney ? received - (tableTotal - r.amount) : r.amount } : {}) },
      userId: staffId,
      clubId,
      roles: info.roles,
      user: { id: staffId },
    });
    await db.query(
      'insert into bl.pos_sale_requests (sale_id, club_id, request_id, payment_id, amount_kopecks) values ($1, $2, $3, $4, $5)',
      [saleId, clubId, r.id, res.payment_id, r.amount],
    );
  }

  if (discount > 0) {
    if (approval) await approval.mark(saleId);
    // Подтверждённая скидка — действие управляющего (журнал от его имени, №95).
    await deps.audit.appendAudit(db, {
      action: over ? 'manual.discount' : 'pos.discount',
      objectType: 'pos_sale',
      objectId: saleId,
      reason: reason || null,
      data: {
        sale_id: saleId, discount_kopecks: discount, subtotal_kopecks: barSubtotal, limit_percent: pos.discount_limit_percent, over_limit: over,
        ...(approval ? { approval_id: approval.id, reason_code: approval.reason_code, cashier_id: staffId } : {}),
      },
      actorType: 'user',
      actorId: approval ? approval.approver_id : staffId,
    });
    if (over) {
      const who = approval ? `, подтвердил ${await operatorName(db, approval.approver_id)} (PIN)` : '';
      await deps.alarms.raise(db, clubId, {
        type: 'discount_over_limit',
        level: 'important',
        manual: true,
        data: { sale_id: saleId, discount_kopecks: discount, subtotal_kopecks: barSubtotal, ...(approval ? { approval_id: approval.id } : {}) },
        text: `Скидка ${rub(discount)} из ${rub(barSubtotal)} выше лимита ${pos.discount_limit_percent} %${who}: ${reason}`.slice(0, 900),
      });
    }
  }

  if (!sbp || saleTotal === 0) {
    const { rows } = await db.query('select * from bl.pos_sales where id = $1', [saleId]);
    await completeSale(db, deps, rows[0], { at, actorId: staffId });
  }
  deps.log?.info?.('pos_sale', {
    sale_id: saleId, club_id: clubId, method, bar_kopecks: barTotal, package_kopecks: packageTotal, packages: packages.length, table_kopecks: tableTotal,
    pending: sbp && saleTotal > 0,
  });
  return saleView(db, saleId, { confirmation });
}

// Оплата гостем ------------------------------------------------------------------------------------

/**
 * Продажа гостю онлайн (заказ со стола или счёт стола): строки заказов, платёж ЮKassa redirect.
 * @param {{ clubId, method, orders: object[], userId, phone, sessionId?, resourceId?, returnUrl, requestKey, description, at }} p
 */
export async function createGuestSale(db, deps, p) {
  // id продажи гостя — от ключа запроса (повтор после таймаута — тот же платёж ЮKassa).
  const saleId = p.saleId ?? (p.requestKey ? stableUuid(`bl.pos.guest_sale/${p.clubId}/${p.userId ?? ''}/${p.requestKey}`) : randomUUID());
  const items = p.orders.flatMap((o) => o.items.map((i) => ({ ...i, order_id: o.id })));
  const total = items.reduce((s, i) => s + Number(i.amount_kopecks), 0);
  const lines = receiptLines(items.map((i) => ({ name: i.name, qty: i.qty, amount_kopecks: Number(i.amount_kopecks), vat_code: i.vat_code, payment_subject: i.payment_subject })));
  const customer = receiptCustomer({ phone: p.phone });
  if (!customer) throw new PosError('phone_required');
  const r = await onlinePayment(db, deps, {
    clubId: p.clubId,
    saleId,
    method: p.method,
    amount: total,
    lines,
    customer,
    phone: p.phone,
    confirmation: 'redirect',
    returnUrl: p.returnUrl,
    userId: p.userId,
    resourceId: p.resourceId ?? null,
    description: p.description,
    requestKey: p.requestKey ?? null,
  });
  return { saleId, total, items, payment: r.payment, confirmation: r.confirmation };
}

/** Вставить строку продажи гостя после того, как заказ записан (FK заказа). */
export async function insertGuestSale(db, { clubId, saleId, method, paymentId, sessionId = null, userId, total, items, requestKey = null, at }) {
  await db.query(
    `insert into bl.pos_sales (id, club_id, channel, method, status, payment_id, session_id, user_id, bar_subtotal_kopecks, bar_total_kopecks,
                               request_key, created_at, updated_at)
     values ($1, $2, 'guest', $3, 'pending', $4, $5, $6, $7, $7, $8, $9, $9)`,
    [saleId, clubId, method, paymentId, sessionId, userId, total, requestKey, at],
  );
  await insertSaleItems(db, { clubId, saleId, items, discount: 0 });
}

// Завершение и отмена ------------------------------------------------------------------------------

/**
 * Завершить продажу (оплата получена). Идемпотентно по статусу продажи.
 * @param {object} sale строка bl.pos_sales
 */
export async function completeSale(db, deps, sale, { at = deps.clock.now(), actorId = null } = {}) {
  const { rows: locked } = await db.query('select * from bl.pos_sales where id = $1 for update', [sale.id]);
  const s = locked[0];
  if (!s || s.status !== 'pending') return { result: 'already' };
  const items = await loadSaleItems(db, s.id, { lockOrders: true });
  const orderIds = [...new Set(items.map((i) => i.order_id))];
  const orders = await loadOrders(db, orderIds);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const paidIds = [];
  const dupIds = [];
  for (const o of orders) {
    if (o.status === 'canceled' || (o.paid_at && o.sale_id !== s.id)) dupIds.push(o.id);
    else paidIds.push(o.id);
  }
  if (paidIds.length > 0) {
    await db.query(
      `update bl.orders set paid_at = $2, sale_id = $3, committed_at = coalesce(committed_at, $2), updated_at = $2
        where id = any($1::uuid[]) and paid_at is null`,
      [paidIds, at, s.id],
    );
    await db.query("update bl.pos_sale_items set outcome = 'paid' where sale_id = $1 and order_id = any($2::uuid[])", [s.id, paidIds]);
  }
  if (dupIds.length > 0) {
    await db.query("update bl.pos_sale_items set outcome = 'duplicate' where sale_id = $1 and order_id = any($2::uuid[])", [s.id, dupIds]);
  }
  const paidItems = items.filter((i) => paidIds.includes(i.order_id));
  // Склад: строки оплаченных заказов (у счёта стола уже списаны при заказе — повтор не пишется).
  await recordSales(db, {
    items: paidItems.map((i) => ({ order_item_id: i.order_item_id, product_id: i.product_id, qty: i.item_qty, stock_factor: i.stock_factor, track_stock: i.track_stock })),
    saleId: s.id,
    at,
    userId: actorId ?? s.created_by ?? null,
  });

  // Чек продажи: бар и пакеты часов (позиции пакетов — «предоплата 100 %»).
  let receiptId = null;
  const barTotal = Number(s.bar_total_kopecks);
  const packageTotal = Number(s.package_kopecks ?? 0);
  const salePackages = packageTotal > 0 ? await loadSalePackages(db, s.id) : [];
  const saleTotal = barTotal + packageTotal;
  if (saleTotal > 0) {
    if (s.method === 'cash' || s.method === 'card_terminal') {
      const settings = await loadPaymentSettings(db, s.club_id);
      receiptId = await enqueueKktReceipt(db, deps, {
        clubId: s.club_id,
        kind: 'sell',
        lines: [...(items.length > 0 ? linesFor(items) : []), ...salePackages.map((p) => p.line)],
        payments: [{ method: s.method === 'cash' ? 'cash' : 'electronically', amount_kopecks: saleTotal }],
        operatorName: await operatorName(db, s.created_by),
        paymentId: s.payment_id,
        saleId: s.id,
        amountKopecks: saleTotal,
        taxSystemCode: settings.tax_system_code,
        at,
      });
    } else {
      const { rows } = await db.query("select id from bl.receipts where payment_id = $1 and kind = 'sale' order by created_at limit 1", [s.payment_id]);
      receiptId = rows[0]?.id ?? null;
    }
  }
  // Пакеты часов: минуты на баланс гостя (money; повтор — та же партия).
  if (salePackages.length > 0) {
    const { rows: pay } = await db.query('select * from bl.payments where id = $1', [s.payment_id]);
    for (const p of salePackages) {
      const lot = await creditPackage(db, deps, { payment: pay[0], packageId: p.package_id, userId: p.user_id, index: p.idx });
      if (!p.lot_id) await db.query('update bl.pos_sale_packages set lot_id = $2 where id = $1', [p.id, lot.id]);
    }
  }
  const shiftId = s.shift_id ?? (await currentShift(db, deps, s.club_id))?.id ?? null;
  await db.query(
    "update bl.pos_sales set status = 'completed', completed_at = $2, receipt_id = $3, updated_at = $2 where id = $1",
    [s.id, at, receiptId],
  );
  const tableTotal = Number(s.table_kopecks);
  const { rows: tp } = await db.query('select payment_id from bl.pos_sale_requests where sale_id = $1 order by request_id', [s.id]);
  // Для отчёта смены (kkt, bl.shift_sales): сумма продажи = бар + столы из заявок.
  await deps.outbox.enqueue(db, 'sale.completed', {
    sale_id: s.id,
    club_id: s.club_id,
    channel: s.channel,
    payment_id: s.payment_id,
    method: s.method,
    amount_kopecks: saleTotal + tableTotal,
    bar_kopecks: barTotal,
    packages_kopecks: packageTotal,
    tables_kopecks: tableTotal,
    table_payment_ids: tp.map((r) => r.payment_id),
    discount_kopecks: Number(s.discount_kopecks),
    shift_id: shiftId,
    completed_at: at.toISOString(),
  });
  await deps.audit.appendAudit(db, {
    action: 'pos.sale',
    objectType: 'pos_sale',
    objectId: s.id,
    data: {
      sale_id: s.id,
      channel: s.channel,
      method: s.method,
      payment_id: s.payment_id,
      bar_kopecks: barTotal,
      packages_kopecks: packageTotal,
      packages: salePackages.map((p) => ({ package_id: p.package_id, user_id: p.user_id, amount_kopecks: p.amount_kopecks })),
      tables_kopecks: tableTotal,
      discount_kopecks: Number(s.discount_kopecks),
      received_kopecks: s.received_kopecks === null ? null : Number(s.received_kopecks),
      change_kopecks: s.change_kopecks === null ? null : Number(s.change_kopecks),
      orders: paidIds.length,
      duplicates: dupIds.length,
      session_id: s.session_id,
    },
    actorType: s.channel === 'pos' ? 'user' : 'system',
    actorId: s.channel === 'pos' ? s.created_by : null,
  });

  // Двойная оплата: заказ уже оплачен другой продажей или отменён — вернуть его долю.
  if (dupIds.length > 0) await refundDuplicates(db, deps, s, items.filter((i) => dupIds.includes(i.order_id)), at);

  const fresh = await loadOrders(db, orderIds);
  for (const o of fresh) if (paidIds.includes(o.id) || byId.get(o.id)?.committed_at !== o.committed_at) await publishOrder(db, deps, o);
  await publishClub(db, deps, s.club_id, 'pos_sale', { sale_id: s.id, status: 'completed', method: s.method, total_kopecks: saleTotal + tableTotal });
  return { result: 'completed', receipt_id: receiptId, duplicates: dupIds.length };
}

async function refundDuplicates(db, deps, s, items, at) {
  const { rows } = await db.query('select * from bl.payments where id = $1', [s.payment_id]);
  const payment = rows[0];
  const amount = items.reduce((sum, i) => sum + i.amount_kopecks, 0);
  if (!payment || amount <= 0) return;
  const reason = 'Двойная оплата счёта: заказ уже оплачен или отменён';
  const posRefundId = randomUUID();
  const phone = (await db.query("select customer_phone from bl.receipts where payment_id = $1 and kind = 'sale' and customer_phone is not null limit 1", [payment.id])).rows[0]?.customer_phone ?? null;
  const pos = await posSettings(db, s.club_id);
  const customer = receiptCustomer({ phone, email: pos.receipt_email });
  const refund = await refundPayment(db, deps, {
    paymentId: payment.id,
    amount,
    lines: linesFor(items),
    customer,
    reason,
    key: `bard-${s.id}`,
    description: 'Возврат: двойная оплата бара',
  });
  await db.query(
    `insert into bl.pos_refunds (id, club_id, sale_id, refund_id, kind, amount_kopecks, reason, items, created_at)
     values ($1, $2, $3, $4, 'duplicate', $5, $6, $7::jsonb, $8)`,
    [posRefundId, s.club_id, s.id, refund.refund_id, amount, reason, JSON.stringify(items.map((i) => ({ sale_item_id: i.id, qty: i.qty, amount_kopecks: i.amount_kopecks }))), at],
  );
  for (const i of items) {
    await db.query('update bl.pos_sale_items set refunded_qty = qty, refunded_kopecks = amount_kopecks where id = $1', [i.id]);
  }
  await db.query('update bl.pos_sales set refunded_kopecks = refunded_kopecks + $2, updated_at = $3 where id = $1', [s.id, amount, at]);
  await deps.audit.appendAudit(db, {
    action: 'pos.refund',
    objectType: 'pos_sale',
    objectId: s.id,
    reason,
    data: { sale_id: s.id, refund_id: refund.refund_id, amount_kopecks: amount, method: s.method, kind: 'duplicate' },
    actorType: 'system',
    actorId: null,
  });
  await deps.alarms.raise(db, s.club_id, {
    type: 'bar_double_payment',
    level: 'important',
    data: { sale_id: s.id, amount_kopecks: amount },
    text: `Счёт бара оплачен дважды: ${rub(amount)} возвращено гостю`,
  });
}

/**
 * Отмена продажи: платёж отменён в ЮKassa (система) или кассир снял QR неоплаченной СБП-продажи
 * (№98). Заказы, ждавшие этой оплаты, отменяются; оплата, пришедшая после отмены, возвращается
 * (settleSale → refundLate).
 */
export async function cancelSale(db, deps, sale, { at = deps.clock.now(), actorId = null, reason = null } = {}) {
  const { rows: locked } = await db.query('select * from bl.pos_sales where id = $1 for update', [sale.id]);
  const s = locked[0];
  if (!s || s.status !== 'pending') return { result: 'already' };
  await db.query("update bl.pos_sales set status = 'canceled', canceled_at = $2, updated_at = $2 where id = $1", [s.id, at]);
  const items = await loadSaleItems(db, s.id, { lockOrders: true });
  const orderIds = [...new Set(items.map((i) => i.order_id))];
  const { rows: waiting } = await db.query(
    `update bl.orders set status = 'canceled', canceled_at = $2, cancel_reason = 'payment_canceled', status_at = $2, updated_at = $2
      where id = any($1::uuid[]) and committed_at is null and status <> 'canceled' returning id`,
    [orderIds, at],
  );
  await recordReturns(db, {
    items: items.filter((i) => waiting.some((w) => w.id === i.order_id))
      .map((i) => ({ order_item_id: i.order_item_id, product_id: i.product_id, qty: i.item_qty, stock_factor: i.stock_factor, track_stock: i.track_stock })),
    at,
    userId: actorId,
    reason: reason ?? 'payment_canceled',
  });
  await deps.audit.appendAudit(db, {
    action: 'pos.sale_canceled',
    objectType: 'pos_sale',
    objectId: s.id,
    reason,
    data: { sale_id: s.id, payment_id: s.payment_id, method: s.method, orders_canceled: waiting.length, by: actorId ? 'staff' : 'payment' },
    actorType: actorId ? 'user' : 'system',
    actorId,
  });
  for (const o of await loadOrders(db, waiting.map((r) => r.id))) await publishOrder(db, deps, o);
  await publishClub(db, deps, s.club_id, 'pos_sale', { sale_id: s.id, status: 'canceled', method: s.method });
  return { result: 'canceled' };
}

/** Продажа ждёт оплаты: применить конечный статус платежа (succeeded → завершить, canceled → отменить). */
export async function settleSale(db, deps, saleId, { sync = false } = {}) {
  const { rows } = await db.query('select * from bl.pos_sales where id = $1', [saleId]);
  const s = rows[0];
  if (!s || !s.payment_id) return { result: 'already' };
  if (s.status === 'canceled' && s.channel === 'pos' && Number(s.refunded_kopecks) === 0) {
    // Кассир отменил продажу, а гость всё же оплатил QR — вернуть деньги (№98).
    const { rows: paid } = await db.query('select status from bl.payments where id = $1', [s.payment_id]);
    if (paid[0]?.status === 'succeeded') return refundLate(db, deps, s);
    return { result: 'already' };
  }
  if (s.status !== 'pending') return { result: 'already' };
  const { rows: pr } = await db.query('select * from bl.payments where id = $1', [s.payment_id]);
  let p = pr[0];
  if (sync && p?.status === 'pending' && p.provider === 'yookassa') {
    const last = new Date(p.checked_at ?? p.created_at).getTime();
    if (deps.clock.now().getTime() - last >= 10_000) {
      await db.query('select id from bl.payments where id = $1 for update', [p.id]);
      try {
        p = (await syncPayment(db, deps.money, deps.moneyConfig, p, { source: 'pos_poll' })).payment;
      } catch (err) {
        deps.log?.warn?.('pos_sync_failed', { sale_id: s.id, error: err.message });
      }
    }
  }
  if (p?.status === 'succeeded') return completeSale(db, deps, s);
  if (p?.status === 'canceled') return cancelSale(db, deps, s);
  return { result: 'pending' };
}

async function refundLate(db, deps, sale, { at = deps.clock.now() } = {}) {
  const { rows: locked } = await db.query('select * from bl.pos_sales where id = $1 for update', [sale.id]);
  const s = locked[0];
  if (!s || s.status !== 'canceled' || Number(s.refunded_kopecks) > 0) return { result: 'already' };
  const items = await loadSaleItems(db, s.id);
  const salePackages = await loadSalePackages(db, s.id);
  const amount = Number(s.bar_total_kopecks) + Number(s.package_kopecks ?? 0);
  if (amount <= 0 || (items.length === 0 && salePackages.length === 0)) return { result: 'already' };
  const reason = 'Оплата после отмены продажи на кассе';
  const phone = (await db.query("select customer_phone from bl.receipts where payment_id = $1 and kind = 'sale' and customer_phone is not null limit 1", [s.payment_id])).rows[0]?.customer_phone ?? null;
  const pos = await posSettings(db, s.club_id);
  const refund = await refundPayment(db, deps, {
    paymentId: s.payment_id,
    amount,
    // Отменённая продажа пакеты не начисляла: возвращается и их предоплата.
    lines: [...(items.length > 0 ? linesFor(items) : []), ...salePackages.map((p) => p.line)],
    customer: receiptCustomer({ phone, email: pos.receipt_email }),
    reason,
    key: `barl-${s.id}`,
    description: 'Возврат: оплата после отмены',
  });
  await db.query(
    `insert into bl.pos_refunds (club_id, sale_id, refund_id, kind, amount_kopecks, reason, items, created_at)
     values ($1, $2, $3, 'late', $4, $5, $6::jsonb, $7)`,
    [s.club_id, s.id, refund.refund_id, amount, reason, JSON.stringify(items.map((i) => ({ sale_item_id: i.id, qty: i.qty, amount_kopecks: i.amount_kopecks }))), at],
  );
  await db.query('update bl.pos_sale_items set refunded_qty = qty, refunded_kopecks = amount_kopecks where sale_id = $1', [s.id]);
  await db.query('update bl.pos_sales set refunded_kopecks = $2, updated_at = $3 where id = $1', [s.id, amount, at]);
  await deps.audit.appendAudit(db, {
    action: 'pos.refund',
    objectType: 'pos_sale',
    objectId: s.id,
    reason,
    data: { sale_id: s.id, refund_id: refund.refund_id, amount_kopecks: amount, method: s.method, kind: 'late' },
    actorType: 'system',
    actorId: null,
  });
  await deps.alarms.raise(db, s.club_id, {
    type: 'bar_late_payment',
    level: 'important',
    data: { sale_id: s.id, amount_kopecks: amount },
    text: `Оплата СБП ${rub(amount)} пришла после отмены продажи на кассе — деньги возвращены`,
  });
  return { result: 'refunded', refund_id: refund.refund_id };
}

/**
 * POST /api/pos/sales/{id}/cancel — ресепшн и выше: снять QR неоплаченной СБП-продажи (№98).
 * Платёж ЮKassa в pending через API не отменяется (QR истечёт сам); если гость всё же заплатит,
 * деньги вернутся автоматически. Оплаченная продажа — 409 already_paid (только возврат).
 */
export async function cancelSaleByStaff(db, deps, info) {
  const id = info.params.id;
  const b = info.body ?? {};
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 2000) : null;
  const { rows } = await db.query('select * from bl.pos_sales where id = $1 for update', [id]);
  const s = rows[0];
  if (!s || s.channel !== 'pos') throw new PosError('not_found', 'sale');
  if (s.status === 'canceled') return saleView(db, id);
  // Перед отменой — свежий статус платежа: вдруг гость уже оплатил.
  await settleSale(db, deps, id, { sync: true });
  const fresh = (await db.query('select * from bl.pos_sales where id = $1', [id])).rows[0];
  if (fresh.status === 'completed') throw new PosError('already_paid', 'продажа оплачена — только возврат');
  if (fresh.status === 'pending') await cancelSale(db, deps, fresh, { actorId: info.userId, reason });
  return saleView(db, id);
}

/**
 * Обработчик outbox payment.confirmed и payment.canceled (money): платёж бара (kind bar)
 * завершает или отменяет свою продажу; статус берётся из bl.payments, не из события.
 */
export async function onPaymentConfirmed(db, deps, payload) {
  if (!payload || payload.kind !== 'bar' || !isUuid(payload.payment_id)) return { result: 'ignored' };
  const { rows } = await db.query('select id from bl.pos_sales where payment_id = $1', [payload.payment_id]);
  if (!rows[0]) return { result: 'ignored' };
  return settleSale(db, deps, rows[0].id);
}

// Возврат -------------------------------------------------------------------------------------------

function parseRefundItems(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) throw bad('items');
  const seen = new Set();
  return v.map((x, i) => {
    if (!x || !isUuid(x.order_item_id) || !Number.isInteger(x.qty) || x.qty < 1 || x.qty > 100) throw bad(`items[${i}]`);
    if (seen.has(x.order_item_id)) throw bad('items: повтор');
    seen.add(x.order_item_id);
    return { order_item_id: x.order_item_id, qty: x.qty };
  });
}

/** Номера пакетов продажи к возврату: [idx], без повторов. */
function parseRefundPackages(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PACKAGES) throw bad('packages');
  if (!v.every((x) => Number.isInteger(x) && x >= 0 && x <= 9) || new Set(v).size !== v.length) throw bad('packages');
  return v;
}

/**
 * POST /api/pos/sales/{id}/refund — управляющий и выше (PRODUCT §4): причина обязательна,
 * чек возврата, склад, журнал, тревога владельцу (инвариант 8).
 */
export async function refundSale(db, deps, info) {
  const key = requireKey(info);
  const staffId = info.userId;
  if (!hasRole(info.roles, MANAGER_ROLES)) throw new PosError('forbidden', 'возврат — управляющий и выше');
  const saleId = info.params.id;
  const b = info.body ?? {};
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!reason) throw new PosError('reason_required');
  if (reason.length > 2000) throw bad('reason');
  const wanted = parseRefundItems(b.items);
  const wantedPackages = parseRefundPackages(b.packages);

  const prev = await db.query('select * from bl.pos_refunds where club_id = $1 and request_key = $2', [info.clubId, key]);
  if (prev.rowCount > 0) return refundView(db, prev.rows[0]);

  const { rows } = await db.query('select * from bl.pos_sales where id = $1 for update', [saleId]);
  const s = rows[0];
  if (!s) throw new PosError('not_found', 'sale');
  if (s.status !== 'completed') throw new PosError('payment_pending', 'продажа не завершена');
  if (Number(s.bar_total_kopecks) === 0 && !wantedPackages) throw bad('в продаже нет бара (стол возвращает money)');
  const items = (await loadSaleItems(db, s.id)).filter((i) => i.outcome === 'paid');
  const plan = [];
  // Пакеты к возврату: строка продажи, не возвращена, партия начислена (её отзывает money ниже).
  const packagePlan = [];
  if (wantedPackages) {
    const salePackages = await loadSalePackages(db, s.id);
    for (const idx of wantedPackages) {
      const p = salePackages.find((x) => x.idx === idx);
      if (!p) throw new PosError('not_found', `package ${idx}`);
      if (p.refunded_at) throw new PosError('already_refunded', `package ${idx}`);
      if (!p.lot_id) throw new PosError('payment_pending', `package ${idx}: партия не начислена`);
      packagePlan.push(p);
    }
  }
  if (wanted) {
    for (const w of wanted) {
      const i = items.find((x) => x.order_item_id === w.order_item_id);
      if (!i) throw new PosError('not_found', `order_item ${w.order_item_id}`);
      if (i.refunded_qty + w.qty > i.qty) throw new PosError('limit_exceeded', 'возврат больше проданного');
      plan.push({ i, qty: w.qty });
    }
  } else if (!wantedPackages) {
    for (const i of items) if (i.refunded_qty < i.qty) plan.push({ i, qty: i.qty - i.refunded_qty });
  }
  if (plan.length === 0 && packagePlan.length === 0) throw new PosError('already_paid', 'всё уже возвращено');
  const at = deps.clock.now();
  const rowsForReceipt = [];
  let amount = 0;
  for (const p of plan) {
    const part = refundAmount(p.i.amount_kopecks, p.i.qty, p.i.refunded_qty, p.qty);
    p.amount = part;
    amount += part;
    rowsForReceipt.push({
      name: p.i.name,
      qty: p.i.qty,
      amount_kopecks: p.i.amount_kopecks,
      vat_code: p.i.vat_code,
      payment_subject: p.i.payment_subject,
      from: p.i.qty - p.i.refunded_qty - p.qty,
      to: p.i.qty - p.i.refunded_qty,
    });
  }
  for (const p of packagePlan) amount += p.amount_kopecks;
  if (Number(s.refunded_kopecks) + amount > Number(s.bar_total_kopecks) + Number(s.package_kopecks ?? 0)) {
    throw new PosError('limit_exceeded', 'возврат больше оплаченного');
  }
  // Чек возврата: позиции бара и пакетов (у пакета — «предоплата 100 %», как в чеке продажи).
  const lines = [...(rowsForReceipt.length > 0 ? receiptLines(rowsForReceipt) : []), ...packagePlan.map((p) => p.line)];
  const { rows: pr } = await db.query('select * from bl.payments where id = $1 for update', [s.payment_id]);
  const payment = pr[0];
  // Наличные возвращаются из кассы смены (№81): без открытой смены — нельзя. Строка смены
  // блокируется: закрытие смены ждёт возврат.
  const shift = await currentShift(db, deps, s.club_id, { forUpdate: true });
  if (s.method === 'cash' && !shift) throw new PosError('shift_closed');

  // id возврата кассы и ключ ЮKassa — от ключа идемпотентности запроса: повтор после таймаута
  // ЮKassa или отката (ответ потерян, сбой после createRefund) — тот же возврат, не второй.
  const posRefundId = stableUuid(`bl.pos.refund/${s.club_id}/${key}`);
  // Партии минут пакетов — отозвать (money: только нетронутые, журнал и тревога там же).
  for (const p of packagePlan) await revokePackage(db, deps, { lotId: p.lot_id, reason, staffId });
  // Деньги, чек возврата (ККТ — receipt_pending, ЮKassa — с чеком), payment.refunded — у money.
  let customer = null;
  if (payment.provider !== 'reception') {
    const phone = (await db.query("select customer_phone from bl.receipts where payment_id = $1 and kind = 'sale' and customer_phone is not null limit 1", [payment.id])).rows[0]?.customer_phone ?? null;
    const pos = await posSettings(db, s.club_id);
    customer = receiptCustomer({ phone, email: pos.receipt_email });
    if (!customer) throw new PosError('phone_required', 'нет контакта для чека возврата');
  }
  const refundRow = await refundPayment(db, deps, {
    paymentId: payment.id,
    amount,
    lines,
    customer,
    reason,
    key: `posr-${posRefundId}`,
    staffId,
    description: 'Возврат: бар',
  });
  const receiptId = (await db.query("select id from bl.receipts where refund_id = $1 and kind = 'refund' order by created_at limit 1", [refundRow.refund_id])).rows[0]?.id ?? null;
  const refundItems = [
    ...plan.map((p) => ({ sale_item_id: p.i.id, order_item_id: p.i.order_item_id, qty: p.qty, amount_kopecks: p.amount })),
    ...packagePlan.map((p) => ({ sale_package_id: p.id, idx: p.idx, package_id: p.package_id, lot_id: p.lot_id, amount_kopecks: p.amount_kopecks })),
  ];
  await db.query(
    `insert into bl.pos_refunds (id, club_id, sale_id, refund_id, kind, amount_kopecks, reason, items, receipt_id, shift_id, created_by, request_key, created_at)
     values ($1, $2, $3, $4, 'staff', $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
    [posRefundId, s.club_id, s.id, refundRow.refund_id, amount, reason, JSON.stringify(refundItems), receiptId, shift?.id ?? null, staffId, key, at],
  );
  for (const p of plan) {
    await db.query('update bl.pos_sale_items set refunded_qty = refunded_qty + $2, refunded_kopecks = refunded_kopecks + $3 where id = $1', [p.i.id, p.qty, p.amount]);
  }
  for (const p of packagePlan) {
    await db.query('update bl.pos_sale_packages set refunded_at = $2, pos_refund_id = $3 where id = $1', [p.id, at, posRefundId]);
  }
  await db.query('update bl.pos_sales set refunded_kopecks = refunded_kopecks + $2, updated_at = $3 where id = $1', [s.id, amount, at]);
  await recordReturns(db, {
    items: plan.map((p) => ({ order_item_id: p.i.order_item_id, product_id: p.i.product_id, qty: p.qty, stock_factor: p.i.stock_factor, track_stock: p.i.track_stock })),
    refundId: posRefundId,
    at,
    userId: staffId,
    reason,
  });
  await deps.audit.appendAudit(db, {
    action: 'pos.refund',
    objectType: 'pos_sale',
    objectId: s.id,
    reason,
    data: {
      sale_id: s.id, refund_id: refundRow.refund_id, pos_refund_id: posRefundId, amount_kopecks: amount, method: s.method, items: plan.length,
      packages: packagePlan.map((p) => ({ idx: p.idx, package_id: p.package_id, lot_id: p.lot_id, amount_kopecks: p.amount_kopecks })),
    },
    actorType: 'user',
    actorId: staffId,
  });
  // Возврат — ручное действие (инвариант 8): тревога и уведомление владельцу сразу.
  await deps.alarms.raise(db, s.club_id, {
    type: 'pos_refund',
    level: 'critical',
    manual: true,
    data: { sale_id: s.id, amount_kopecks: amount },
    text: `Возврат ${rub(amount)} на кассе: ${reason}`.slice(0, 900),
  });
  await publishClub(db, deps, s.club_id, 'pos_sale', { sale_id: s.id, status: 'completed', refunded_kopecks: Number(s.refunded_kopecks) + amount });
  deps.log?.info?.('pos_refund', { sale_id: s.id, refund_id: refundRow.refund_id, amount_kopecks: amount, method: s.method });
  return refundView(db, (await db.query('select * from bl.pos_refunds where id = $1', [posRefundId])).rows[0]);
}

/**
 * outbox payment.refund_canceled (money; ревью денег п. 4): ЮKassa отменила возврат — деньги гостю не
 * вернулись. Учёт возврата продажи кассы откатывается: refunded_kopecks продажи и строк, склад —
 * обратным движением (writeoff по каждому возврату на склад этого возврата), возврат кассы помечается
 * отменённым, журнал pos.refund_canceled, тревога владельцу. Пакеты часов: партии из lots_restored
 * money уже восстановил — с их строк снимается отметка возврата (пакет снова действует, его можно
 * вернуть ещё раз); пакет без восстановленной партии остаётся отмеченным — тревога просит начислить вручную.
 * Нагрузка: { refund_id, payment_id, club_id, amount_kopecks, pos_refund_id?, lots_restored: [lot_id] }. Повтор — already.
 */
export async function onRefundCanceled(db, deps, payload) {
  if (!payload || (!isUuid(payload.refund_id) && !isUuid(payload.pos_refund_id))) return { result: 'ignored' };
  const { rows } = isUuid(payload.pos_refund_id)
    ? await db.query('select * from bl.pos_refunds where id = $1 for update', [payload.pos_refund_id])
    : await db.query('select * from bl.pos_refunds where refund_id = $1 for update', [payload.refund_id]);
  const r = rows[0];
  if (!r) return { result: 'ignored' };
  if (isUuid(payload.refund_id) && r.refund_id !== payload.refund_id) return { result: 'ignored' };
  if (r.canceled_at) return { result: 'already' };
  const at = deps.clock.now();
  const amount = Number(r.amount_kopecks);
  const why = 'Возврат отменён ЮKassa: деньги гостю не вернулись';
  await db.query("select set_config('bl.pos_refund_cancel', 'on', true)");
  const items = Array.isArray(r.items) ? r.items : [];
  for (const i of items) {
    if (!isUuid(i.sale_item_id)) continue;
    await db.query(
      `update bl.pos_sale_items set refunded_qty = greatest(0, refunded_qty - $2), refunded_kopecks = greatest(0, refunded_kopecks - $3)
        where id = $1 and sale_id = $4`,
      [i.sale_item_id, Number(i.qty) || 0, Number(i.amount_kopecks) || 0, r.sale_id],
    );
  }
  await db.query('update bl.pos_sales set refunded_kopecks = greatest(0, refunded_kopecks - $2), updated_at = $3 where id = $1', [r.sale_id, amount, at]);
  // Склад: возврат на склад этого возврата — обратно (списание с причиной).
  const { rows: back } = await db.query(
    "select product_id, qty::text as qty, cost_kopecks, order_item_id from bl.stock_movements where kind = 'return' and refund_id = $1",
    [r.id],
  );
  for (const m of back) {
    await insertMovement(db, {
      productId: m.product_id,
      kind: 'writeoff',
      qtyMilli: -toMilli(m.qty),
      cost: -Number(m.cost_kopecks),
      orderItemId: m.order_item_id,
      refundId: r.id,
      reason: 'refund_canceled',
      at,
    });
  }
  await db.query('update bl.pos_refunds set canceled_at = $2, cancel_reason = $3 where id = $1', [r.id, at, why]);
  const packages = items.filter((i) => isUuid(i.sale_package_id));
  const restored = new Set(Array.isArray(payload.lots_restored) ? payload.lots_restored.filter(isUuid) : []);
  let lost = 0;
  for (const p of packages) {
    if (isUuid(p.lot_id) && restored.has(p.lot_id)) {
      await db.query('update bl.pos_sale_packages set refunded_at = null, pos_refund_id = null where id = $1 and pos_refund_id = $2', [p.sale_package_id, r.id]);
    } else {
      lost += 1;
    }
  }
  await deps.audit.appendAudit(db, {
    action: 'pos.refund_canceled',
    objectType: 'pos_sale',
    objectId: r.sale_id,
    reason: why,
    data: {
      sale_id: r.sale_id, pos_refund_id: r.id, refund_id: r.refund_id, amount_kopecks: amount, items: items.length - packages.length,
      packages: packages.length, packages_restored: packages.length - lost,
    },
    actorType: 'system',
  });
  await deps.alarms.raise(db, r.club_id, {
    type: 'pos_refund_canceled',
    level: 'critical',
    data: { sale_id: r.sale_id, pos_refund_id: r.id, refund_id: r.refund_id, amount_kopecks: amount, packages_restored: packages.length - lost, packages_lost: lost },
    dedupeKey: `pos_refund:${r.id}`,
    text: (`Возврат ${rub(amount)} на кассе отменён ЮKassa — деньги гостю не вернулись, верните вручную` +
      (lost > 0 ? '; минуты пакета часов отозваны — начислите гостю заново' : packages.length > 0 ? '; пакет часов снова действует' : '')).slice(0, 900),
  });
  await publishClub(db, deps, r.club_id, 'pos_sale', { sale_id: r.sale_id, status: 'completed', refund_canceled: r.id });
  deps.log?.warn?.('pos_refund_canceled', { sale_id: r.sale_id, pos_refund_id: r.id, amount_kopecks: amount });
  return { result: 'canceled', pos_refund_id: r.id };
}

async function refundView(db, r) {
  const f = (await db.query('select status from bl.refunds where id = $1', [r.refund_id])).rows[0];
  let receiptStatus = null;
  if (r.receipt_id) receiptStatus = (await db.query('select status from bl.receipts where id = $1', [r.receipt_id])).rows[0]?.status ?? null;
  return {
    pos_refund_id: r.id,
    sale_id: r.sale_id,
    refund_id: r.refund_id,
    status: f?.status ?? null,
    amount_kopecks: Number(r.amount_kopecks),
    items: r.items,
    receipt_id: r.receipt_id,
    receipt_status: receiptStatus,
    created_at: iso(r.created_at),
  };
}

// Списки ---------------------------------------------------------------------------------------------

export async function listSales(db, { clubId, from = null, to = null, limit = 50 }) {
  const { rows } = await db.query(
    `select id from bl.pos_sales where club_id = $1 and ($2::timestamptz is null or created_at >= $2) and ($3::timestamptz is null or created_at < $3)
      order by created_at desc, id limit $4`,
    [clubId, from, to, limit],
  );
  const out = [];
  for (const r of rows) out.push(await saleView(db, r.id));
  return out;
}

export { alcoholAllowedForGuests, orderView };
