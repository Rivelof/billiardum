// Заказы бара со стола и экран бара (контракт M2 §4, decisions №76, №79).
//
// * POST /api/orders — гость, участник идущей сессии: pay tab (в счёт стола — заказ сразу на
//   экране бара, склад списан) или online (СБП, карта: заказ на экране бара после оплаты).
//   Алкоголь со стола не принимается сервером (№76), стоп-лист — stop_list.
// * Статусы — бар и ресепшн: new → preparing → ready → served (вперёд, можно пропускать),
//   canceled — с причиной; отмена заказа в счёте стола — ручное действие (тревога владельцу);
//   оплаченный заказ отменяется только возвратом (управляющий, /api/pos/sales/{id}/refund).
// * Счёт стола живёт дольше сессии (№79): открыт, пока заказы не оплачены — гостем онлайн
//   или на кассе. Двойная оплата — один платёж: повторный запрос гостя получает тот же
//   платёж, а заказ, оплаченный на кассе, пока шла оплата онлайн, возвращается.

import { requireGuestReady } from '../payments/context.mjs';
import { loadPaymentSettings } from '../payments/settings.mjs';
import { alcoholAllowedForGuests, resolveItems } from '../catalog/api.mjs';
import { recordReturns, recordSales } from '../stock/api.mjs';
import { PosError } from './errors.mjs';
import { posSettings } from './settings.mjs';
import { createGuestSale, createSale, GUEST_METHODS, insertGuestSale, saleView, settleSale } from './pos.mjs';
import {
  enterClub,
  enterSessionClub,
  hasRole,
  insertOrder,
  isParticipant,
  isUuid,
  loadOrder,
  loadOrders,
  loadSession,
  objectClub,
  OPEN_SESSION,
  orderView,
  parseComment,
  publishOrder,
  QUEUE_STATUSES,
  requireKey,
  requireUser,
  rolesIn,
  STAFF_ROLES,
} from './core.mjs';

const bad = (detail) => new PosError('bad_request', detail);

export function orderReturnUrl(deps, orderId) {
  return `https://${deps.publicHost}/app/orders/${orderId}`;
}

export function tabReturnUrl(deps, sessionId) {
  return `https://${deps.publicHost}/app/sessions/${sessionId}/tab`;
}

/** Заказы счёта стола: в счёте, не оплачены, не отменены. */
async function openTabOrders(db, sessionId) {
  const { rows } = await db.query(
    `select id from bl.orders where session_id = $1 and pay_mode = 'tab' and paid_at is null and status <> 'canceled' and committed_at is not null
      order by created_at, id`,
    [sessionId],
  );
  return loadOrders(db, rows.map((r) => r.id));
}

/**
 * Счёт стола (контракт M2 §5): { orders, total_kopecks } — для чека сессии и экрана ресепшена.
 * db — транзакция с контекстом клуба сессии (или без клуба: контекст ставится по сессии).
 */
export async function openTab(db, sessionId, { staff = false } = {}) {
  await enterSessionClub(db, sessionId);
  const orders = await openTabOrders(db, sessionId);
  return { orders: orders.map((o) => orderView(o, { staff })), total_kopecks: orders.reduce((s, o) => s + Number(o.subtotal_kopecks), 0) };
}

/** Кто смотрит сессию: участник или персонал клуба. Иначе — not_found (сессию не раскрываем). */
async function sessionAccess(db, info, sessionId) {
  const userId = requireUser(info);
  const clubId = await enterSessionClub(db, sessionId);
  const roles = await rolesIn(db, clubId, userId);
  const staff = hasRole(roles, STAFF_ROLES);
  if (!staff && !(await isParticipant(db, sessionId, userId))) throw new PosError('not_found', 'session');
  return { clubId, roles, staff, userId };
}

// Заказ со стола ---------------------------------------------------------------------------------

export async function createGuestOrder(db, deps, info) {
  const userId = requireUser(info);
  const key = requireKey(info);
  const b = info.body ?? {};
  if (!isUuid(b.session_id)) throw bad('session_id');
  if (b.pay !== 'online' && b.pay !== 'tab') throw bad('pay');
  const comment = parseComment(b.comment);
  const clubId = await enterSessionClub(db, b.session_id);

  const prev = await db.query('select id, user_id from bl.orders where club_id = $1 and request_key = $2', [clubId, key]);
  if (prev.rowCount > 0) {
    if (prev.rows[0].user_id !== userId) throw new PosError('idempotency_conflict');
    return guestOrderResponse(db, prev.rows[0].id);
  }
  const session = await loadSession(db, b.session_id);
  if (!session || !(await isParticipant(db, session.id, userId))) throw new PosError('not_found', 'session');
  if (!OPEN_SESSION.includes(session.status)) throw new PosError('session_not_active');
  const { phone } = await requireGuestReady(db, { ...info, userId });

  const settings = await loadPaymentSettings(db, clubId);
  const lines = await resolveItems(db, { clubId, items: b.items, audience: 'guest', defaultVat: settings.vat_code });
  const subtotal = lines.reduce((s, l) => s + l.amount_kopecks, 0);
  const at = deps.clock.now();

  if (b.pay === 'tab') {
    const pos = await posSettings(db, clubId);
    if (pos.tab_limit_kopecks !== null) {
      const { rows } = await db.query(
        `select coalesce(sum(subtotal_kopecks), 0)::bigint as total from bl.orders
          where session_id = $1 and pay_mode = 'tab' and paid_at is null and status <> 'canceled'`,
        [session.id],
      );
      if (Number(rows[0].total) + subtotal > pos.tab_limit_kopecks) throw new PosError('limit_exceeded', 'предел счёта стола');
    }
    const { order, items } = await insertOrder(db, {
      clubId, source: 'qr', payMode: 'tab', sessionId: session.id, resourceId: session.resource_id, userId, comment, requestKey: key,
      committedAt: at, at,
    }, lines);
    await recordSales(db, {
      items: items.map((i) => ({ order_item_id: i.id, product_id: i.product_id, qty: i.qty, stock_factor: i.stock_factor, track_stock: i.track_stock })),
      at,
      userId,
    });
    await auditOrder(db, deps, order, 'order.create', { pay: 'tab', subtotal_kopecks: subtotal, items: items.length }, { actorId: userId });
    const full = await loadOrder(db, order.id);
    await publishOrder(db, deps, full);
    return { order: orderView(full) };
  }

  const method = b.method ?? 'sbp';
  if (!GUEST_METHODS.includes(method)) throw bad('method');
  const orderId = (await db.query('select gen_random_uuid() as id')).rows[0].id;
  const fake = { id: orderId, items: lines.map((l, k) => ({ ...l, id: `line-${k}` })) };
  // Платёж ЮKassa до записи заказа (как money): сбой ЮKassa не оставит заказа без платежа.
  const guest = await createGuestSale(db, deps, {
    clubId, method, orders: [fake], userId, phone, resourceId: session.resource_id, returnUrl: orderReturnUrl(deps, orderId),
    requestKey: key, description: `Бар, стол ${session.resource_number}`, at,
  });
  const { order, items } = await insertOrder(db, {
    id: orderId, clubId, source: 'qr', payMode: 'online', sessionId: session.id, resourceId: session.resource_id, userId, comment,
    requestKey: key, paymentId: guest.payment.id, at,
  }, lines);
  await insertGuestSale(db, {
    clubId, saleId: guest.saleId, method, paymentId: guest.payment.id, userId, total: subtotal,
    items: items.map((i) => ({ ...i, order_id: order.id })), at,
  });
  await auditOrder(db, deps, order, 'order.create', { pay: 'online', method, subtotal_kopecks: subtotal, items: items.length, payment_id: guest.payment.id }, { actorId: userId });
  if (guest.payment.status === 'succeeded') await settleSale(db, deps, guest.saleId);
  const full = await loadOrder(db, order.id);
  await publishOrder(db, deps, full);
  return {
    order: orderView(full),
    payment: { payment_id: guest.payment.id, sale_id: guest.saleId, status: guest.payment.status, ...(guest.confirmation ? { confirmation: guest.confirmation } : {}) },
  };
}

async function guestOrderResponse(db, orderId) {
  const o = await loadOrder(db, orderId);
  const out = { order: orderView(o) };
  if (o.pay_mode === 'online' && o.payment_id) {
    const p = (await db.query('select id, status, confirmation_url from bl.payments where id = $1', [o.payment_id])).rows[0];
    const s = (await db.query('select id from bl.pos_sales where payment_id = $1', [o.payment_id])).rows[0];
    out.payment = {
      payment_id: p.id, sale_id: s?.id ?? null, status: p.status,
      ...(p.status === 'pending' && p.confirmation_url ? { confirmation: { type: 'redirect', url: p.confirmation_url } } : {}),
    };
  }
  return out;
}

async function auditOrder(db, deps, o, action, data, { actorId = null, reason = null } = {}) {
  await deps.audit.appendAudit(db, {
    action,
    objectType: 'order',
    objectId: o.id,
    reason,
    data: { order_id: o.id, number: o.number, source: o.source, session_id: o.session_id, resource_id: o.resource_id, ...data },
    actorType: 'user',
    actorId,
  });
}

/** GET /api/orders/{id}: автор заказа, участник сессии или персонал клуба (ресепшн и выше). */
export async function getOrder(db, deps, info) {
  const userId = requireUser(info);
  const id = info.params.id;
  const clubId = await objectClub(db, 'order', id);
  if (!clubId) throw new PosError('not_found', 'order');
  await enterClub(db, clubId);
  let o = await loadOrder(db, id);
  if (!o) throw new PosError('not_found', 'order');
  const staff = hasRole(await rolesIn(db, clubId, userId), STAFF_ROLES);
  if (!staff && o.user_id !== userId && !(o.session_id && (await isParticipant(db, o.session_id, userId)))) throw new PosError('not_found', 'order');
  // Онлайн-оплата ещё идёт — проверить платёж (подтверждение могло прийти без нас).
  if (!o.committed_at && o.status !== 'canceled' && o.payment_id) {
    const s = (await db.query('select id from bl.pos_sales where payment_id = $1', [o.payment_id])).rows[0];
    if (s) {
      await settleSale(db, deps, s.id, { sync: true });
      o = await loadOrder(db, id);
    }
  }
  return orderView(o, { staff });
}

// Статусы ------------------------------------------------------------------------------------------

const FORWARD = { new: ['preparing', 'ready', 'served'], preparing: ['ready', 'served'], ready: ['served'], served: [] };

export async function setOrderStatus(db, deps, info) {
  const id = info.params.id;
  const staffId = requireUser(info);
  if (!hasRole(info.roles, STAFF_ROLES)) throw new PosError('forbidden');
  const { status, reason } = info.body ?? {};
  if (!['preparing', 'ready', 'served', 'canceled'].includes(status)) throw bad('status');
  const o = await loadOrder(db, id, { lock: true });
  if (!o) throw new PosError('not_found', 'order');
  const at = deps.clock.now();
  if (o.status === status) return orderView(o, { staff: true });
  if (status === 'canceled') return cancelOrder(db, deps, o, { staffId, reason, at });
  if (!o.committed_at) throw new PosError('payment_pending', 'заказ ждёт оплаты');
  if (!FORWARD[o.status]?.includes(status)) throw bad(`переход ${o.status} → ${status}`);
  const col = { preparing: 'preparing_at', ready: 'ready_at', served: 'served_at' }[status];
  await db.query(`update bl.orders set status = $2, status_at = $3, ${col} = $3, updated_at = $3 where id = $1`, [id, status, at]);
  await auditOrder(db, deps, o, 'order.status', { from: o.status, to: status }, { actorId: staffId });
  const fresh = await loadOrder(db, id);
  await publishOrder(db, deps, fresh);
  return orderView(fresh, { staff: true });
}

/**
 * Отмена заказа персоналом: причина обязательна. Оплаченный — только возвратом. Отмена заказа,
 * который уже в счёте стола или на экране бара, — ручное действие: тревога владельцу (инвариант 8).
 */
async function cancelOrder(db, deps, o, { staffId, reason, at }) {
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new PosError('reason_required');
  if (why.length > 2000) throw bad('reason');
  if (o.paid_at) throw new PosError('already_paid', 'оплаченный заказ — возвратом');
  await db.query(
    `update bl.orders set status = 'canceled', canceled_at = $2, canceled_by = $3, cancel_reason = $4, status_at = $2, updated_at = $2 where id = $1`,
    [o.id, at, staffId, why],
  );
  await recordReturns(db, {
    items: o.items.map((i) => ({ order_item_id: i.id, product_id: i.product_id, qty: i.qty, stock_factor: i.stock_factor, track_stock: i.track_stock })),
    at,
    userId: staffId,
    reason: why,
  });
  await auditOrder(db, deps, o, 'order.cancel', { from: o.status, subtotal_kopecks: Number(o.subtotal_kopecks), committed: Boolean(o.committed_at) }, { actorId: staffId, reason: why });
  if (o.committed_at) {
    await deps.alarms.raise(db, o.club_id, {
      type: 'order_canceled',
      level: 'important',
      manual: true,
      resourceId: o.resource_id ?? null,
      data: { order_id: o.id, subtotal_kopecks: Number(o.subtotal_kopecks) },
      text: `${o.resource_number ? `Стол ${o.resource_number}: о` : 'О'}тменён заказ бара №${o.number} на ${(Number(o.subtotal_kopecks) / 100).toFixed(2).replace('.', ',')} ₽: ${why}`.slice(0, 900),
    });
  }
  const fresh = await loadOrder(db, o.id);
  await publishOrder(db, deps, fresh);
  return orderView(fresh, { staff: true });
}

// Экран бара и счета ---------------------------------------------------------------------------------

export async function barQueue(db, { clubId }) {
  const { rows } = await db.query(
    `select id from bl.orders where club_id = $1 and status = any($2::text[]) and committed_at is not null
      order by created_at, id limit 200`,
    [clubId, QUEUE_STATUSES],
  );
  return (await loadOrders(db, rows.map((r) => r.id))).map((o) => orderView(o, { staff: true }));
}

/** Открытые счета столов клуба (ресепшн): сессия, стол, сумма. */
export async function openTabs(db, { clubId }) {
  const { rows } = await db.query(
    `select o.session_id, s.status as session_status, s.resource_id, r.number as resource_number,
            count(*)::int as orders, sum(o.subtotal_kopecks)::bigint as total, min(o.created_at) as since
       from bl.orders o join bl.sessions s on s.id = o.session_id join bl.resources r on r.id = s.resource_id
      where o.club_id = $1 and o.pay_mode = 'tab' and o.paid_at is null and o.status <> 'canceled' and o.committed_at is not null
      group by o.session_id, s.status, s.resource_id, r.number
      order by r.number`,
    [clubId],
  );
  return rows.map((r) => ({
    session_id: r.session_id,
    session_status: r.session_status,
    resource: { id: r.resource_id, number: r.resource_number },
    orders: r.orders,
    total_kopecks: Number(r.total),
    since: new Date(r.since).toISOString(),
  }));
}

/** GET /api/sessions/{id}/tab — счёт стола и идущая онлайн-оплата. */
export async function getTab(db, deps, info) {
  const sessionId = info.params.id;
  const { staff } = await sessionAccess(db, info, sessionId);
  const tab = await openTab(db, sessionId, { staff });
  const { rows } = await db.query(
    "select id from bl.pos_sales where session_id = $1 and status = 'pending' and channel = 'guest' order by created_at desc limit 1",
    [sessionId],
  );
  let pending = null;
  if (rows[0]) {
    await settleSale(db, deps, rows[0].id, { sync: true });
    const v = await saleView(db, rows[0].id);
    if (v.status === 'pending') pending = { sale_id: v.sale_id, payment_id: v.payment_id, total_kopecks: v.total_kopecks, confirmation: v.confirmation ?? null };
  }
  const after = pending ? tab : await openTab(db, sessionId, { staff });
  return { session_id: sessionId, ...after, pending_payment: pending };
}

/** GET /api/sessions/{id}/orders — все заказы сессии (статусы для гостя). */
export async function sessionOrders(db, deps, info) {
  const sessionId = info.params.id;
  const { staff } = await sessionAccess(db, info, sessionId);
  const { rows } = await db.query('select id from bl.orders where session_id = $1 order by created_at, id limit 200', [sessionId]);
  return (await loadOrders(db, rows.map((r) => r.id))).map((o) => orderView(o, { staff }));
}

/**
 * POST /api/sessions/{id}/tab/pay — гость (СБП, карта онлайн) или ресепшн (касса: cash,
 * card_terminal, sbp — как продажа POS со счётом этого стола).
 */
export async function payTab(db, deps, info) {
  const sessionId = info.params.id;
  const key = requireKey(info);
  const { clubId, roles, staff, userId } = await sessionAccess(db, info, sessionId);
  const b = info.body ?? {};
  if (staff && ['cash', 'card_terminal'].includes(b.method)) {
    return createSale(db, deps, { ...info, clubId, roles, body: { ...b, tabs: [sessionId], items: undefined, requests: undefined } });
  }
  if (staff && b.method === 'sbp' && b.at_reception === true) {
    return createSale(db, deps, { ...info, clubId, roles, body: { ...b, tabs: [sessionId], items: undefined, requests: undefined } });
  }
  if (!(await isParticipant(db, sessionId, userId))) throw new PosError('forbidden', 'оплата онлайн — гостем стола');
  const method = b.method ?? 'sbp';
  if (!GUEST_METHODS.includes(method)) throw bad('method');
  const { phone } = await requireGuestReady(db, { ...info, userId });
  // Два гостя жмут «Оплатить» одновременно — один платёж (блокировка счёта стола).
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.tab:' || $1::text, 0))", [sessionId]);
  const prev = await db.query('select id from bl.pos_sales where club_id = $1 and request_key = $2', [clubId, key]);
  if (prev.rowCount > 0) return tabPayResponse(await saleView(db, prev.rows[0].id));
  const orders = await openTabOrders(db, sessionId);
  if (orders.length === 0) throw new PosError('already_paid', 'счёт пуст');
  const allowAlcohol = await alcoholAllowedForGuests(db);
  if (!allowAlcohol && orders.some((o) => o.items.some((i) => i.is_alcohol))) throw new PosError('forbidden', 'алкоголь — только на ресепшене');
  const itemIds = orders.flatMap((o) => o.items.map((i) => i.id)).sort();
  const total = orders.reduce((s, o) => s + Number(o.subtotal_kopecks), 0);
  const at = deps.clock.now();
  // Оплата того же счёта уже идёт (не дольше 15 минут) — тот же платёж.
  const { rows: pend } = await db.query(
    `select s.id, array_agg(si.order_item_id::text order by si.order_item_id::text) as items
       from bl.pos_sales s join bl.pos_sale_items si on si.sale_id = s.id
      where s.session_id = $1 and s.channel = 'guest' and s.status = 'pending' and s.created_at > $2::timestamptz - interval '15 minutes'
        and s.bar_total_kopecks = $3
      group by s.id order by s.created_at desc`,
    [sessionId, at, total],
  );
  for (const p of pend) {
    const v = await saleView(db, p.id);
    if (JSON.stringify(p.items) === JSON.stringify(itemIds) && v.status === 'pending') {
      await settleSale(db, deps, p.id, { sync: true });
      const again = await saleView(db, p.id);
      if (again.status === 'pending') return tabPayResponse(again);
    }
  }
  const session = await loadSession(db, sessionId);
  const guest = await createGuestSale(db, deps, {
    clubId, method, orders, userId, phone, resourceId: session.resource_id, returnUrl: tabReturnUrl(deps, sessionId), requestKey: key,
    description: `Бар, счёт стола ${session.resource_number}`, at,
  });
  await insertGuestSale(db, {
    clubId, saleId: guest.saleId, method, paymentId: guest.payment.id, sessionId, userId, total, items: guest.items, requestKey: key, at,
  });
  await deps.audit.appendAudit(db, {
    action: 'tab.pay',
    objectType: 'session',
    objectId: sessionId,
    data: { session_id: sessionId, sale_id: guest.saleId, payment_id: guest.payment.id, method, amount_kopecks: total, orders: orders.length },
    actorType: 'user',
    actorId: userId,
  });
  if (guest.payment.status === 'succeeded') await settleSale(db, deps, guest.saleId);
  return tabPayResponse(await saleView(db, guest.saleId, { confirmation: guest.confirmation }));
}

function tabPayResponse(v) {
  return {
    sale_id: v.sale_id,
    payment_id: v.payment_id,
    status: v.status,
    total_kopecks: v.total_kopecks,
    ...(v.confirmation ? { confirmation: v.confirmation } : {}),
  };
}
