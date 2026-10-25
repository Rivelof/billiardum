// Общее для заказов и кассы: контекст клуба, роли, загрузка заказов, вид для API, вставка
// заказа и строк, номер заказа за день, публикация SSE после коммита.


import { afterCommit } from '../lib/store.mjs';
import { PosError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const STAFF_ROLES = Object.freeze(['owner', 'manager', 'reception']);
export const MANAGER_ROLES = Object.freeze(['owner', 'manager']);
/** Экран бара, статусы заказов, стоп-лист (№97): бармен (роль bar) и ресепшн и выше. */
export const BAR_ROLES = Object.freeze(['owner', 'manager', 'reception', 'bar']);
/** Роли маршрутов (как ROLES в api/router.mjs). */
export const ROLES = Object.freeze({
  OWNER: Object.freeze(['owner']),
  MANAGER_UP: MANAGER_ROLES,
  RECEPTION_UP: STAFF_ROLES,
});
export const OPEN_SESSION = Object.freeze(['active', 'ending', 'grace']);
export const QUEUE_STATUSES = Object.freeze(['new', 'preparing', 'ready']);

const iso = (d) => (d ? new Date(d).toISOString() : null);

export async function currentClub(db) {
  const { rows } = await db.query("select nullif(current_setting('app.club_id', true), '') as club_id");
  return rows[0].club_id;
}

/** Перейти в контекст клуба: только если клуба в контексте нет или он тот же. */
export async function enterClub(db, clubId) {
  if (!isUuid(clubId)) throw new PosError('not_found', 'club');
  const cur = await currentClub(db);
  if (cur === clubId) return clubId;
  if (cur !== null) throw new PosError('not_found', 'объект другого клуба');
  await db.query("select set_config('app.club_id', $1, true), set_config('app.club_mode', coalesce(bl.club_mode($1::uuid), ''), true)", [clubId]);
  return clubId;
}

export async function sessionClub(db, sessionId) {
  if (!isUuid(sessionId)) return null;
  const { rows } = await db.query('select bl.session_club($1) as club_id', [sessionId]);
  return rows[0].club_id;
}

export async function objectClub(db, kind, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query('select bl.pos_object_club($1, $2) as club_id', [kind, id]);
  return rows[0].club_id;
}

/** Найти клуб сессии и войти в его контекст; нет — not_found. */
export async function enterSessionClub(db, sessionId) {
  const clubId = await sessionClub(db, sessionId);
  if (!clubId) throw new PosError('not_found', 'session');
  return enterClub(db, clubId);
}

export async function rolesIn(db, clubId, userId) {
  if (!isUuid(clubId) || !isUuid(userId)) return [];
  const { rows } = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [clubId, userId]);
  return rows.map((r) => r.role);
}

export const hasRole = (roles, allowed) => Array.isArray(roles) && roles.some((r) => allowed.includes(r));

export async function isParticipant(db, sessionId, userId) {
  const { rowCount } = await db.query('select 1 from bl.session_participants where session_id = $1 and user_id = $2', [sessionId, userId]);
  return rowCount > 0;
}

export async function loadSession(db, sessionId) {
  const { rows } = await db.query(
    `select s.id, s.club_id, s.status, s.resource_id, r.number as resource_number, r.type as resource_type
       from bl.sessions s join bl.resources r on r.id = s.resource_id where s.id = $1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

/** Требования к телу: комментарий заказа. */
export function parseComment(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new PosError('bad_request', 'comment');
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length === 0) return null;
  if (s.length > 200) throw new PosError('bad_request', 'comment');
  return s;
}

export function requireKey(info) {
  const key = typeof info.idempotencyKey === 'string' ? info.idempotencyKey.toLowerCase() : null;
  if (!isUuid(key)) throw new PosError('bad_request', 'нужен Idempotency-Key (UUID)');
  return key;
}

export function requireUser(info) {
  if (!isUuid(info.userId)) throw new PosError('unauthorized', 'нет пользователя');
  return info.userId;
}

/** Номер заказа за местные сутки клуба (под блокировкой клуба: без гонки двух заказов). */
export async function nextOrderNumber(db, clubId, at) {
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.orders.number:' || $1::text, 0))", [clubId]);
  const { rows } = await db.query(
    `select coalesce(max(o.number), 0) + 1 as n
       from bl.orders o, bl.clubs c
      where c.id = $1 and o.club_id = $1
        and o.created_at >= (date_trunc('day', $2::timestamptz at time zone c.timezone) at time zone c.timezone)`,
    [clubId, at],
  );
  return Number(rows[0].n);
}

/**
 * Вставить заказ и его строки.
 * @returns {Promise<{ order: object, items: object[] }>}
 */
export async function insertOrder(db, o, lines) {
  const number = await nextOrderNumber(db, o.clubId, o.at);
  const { rows } = await db.query(
    `insert into bl.orders (id, club_id, number, source, pay_mode, status, session_id, resource_id, user_id, created_by, subtotal_kopecks,
                            comment, request_key, committed_at, payment_id, status_at, created_at, updated_at)
     values (coalesce($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16, $16)
     returning *`,
    [o.id ?? null, o.clubId, number, o.source, o.payMode, o.status ?? 'new', o.sessionId ?? null, o.resourceId ?? null, o.userId ?? null,
      o.createdBy ?? null, lines.reduce((s, l) => s + l.amount_kopecks, 0), o.comment ?? null, o.requestKey ?? null, o.committedAt ?? null,
      o.paymentId ?? null, o.at],
  );
  const order = rows[0];
  const items = [];
  for (const [position, l] of lines.entries()) {
    const r = await db.query(
      `insert into bl.order_items (club_id, order_id, position, product_id, product_name, name, qty, unit_price_kopecks, amount_kopecks, modifiers,
                                   stock_factor, track_stock, is_alcohol, vat_code, payment_subject, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::numeric, $12, $13, $14, $15, $16)
       returning *, stock_factor::text as stock_factor`,
      [o.clubId, order.id, position, l.product_id, l.product_name ?? null, l.name, l.qty, l.unit_price_kopecks, l.amount_kopecks,
        JSON.stringify(l.modifiers), l.stock_factor, l.track_stock, l.is_alcohol, l.vat_code, l.payment_subject, o.at],
    );
    items.push(r.rows[0]);
  }
  return { order, items };
}

/** Заказы с позициями и номером стола. */
export async function loadOrders(db, ids, { lock = false } = {}) {
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `select o.*, r.number as resource_number, r.type as resource_type from bl.orders o left join bl.resources r on r.id = o.resource_id
      where o.id = any($1::uuid[]) order by o.created_at, o.id ${lock ? 'for update of o' : ''}`,
    [ids],
  );
  const items = await db.query(
    `select oi.*, oi.stock_factor::text as stock_factor, coalesce(oi.product_name, p.name) as product_name
       from bl.order_items oi join bl.products p on p.id = oi.product_id
      where oi.order_id = any($1::uuid[]) order by oi.order_id, oi.position`,
    [ids],
  );
  const byOrder = new Map();
  for (const i of items.rows) {
    const list = byOrder.get(i.order_id) ?? [];
    list.push(i);
    byOrder.set(i.order_id, list);
  }
  return rows.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] }));
}

export async function loadOrder(db, id, opts) {
  return (await loadOrders(db, [id], opts))[0] ?? null;
}

/** Заказ для API: гостю и персоналу (персоналу — ещё кто отменил и почему). */
export function orderView(o, { staff = false } = {}) {
  const view = {
    id: o.id,
    number: o.number,
    source: o.source,
    status: o.status,
    pay_mode: o.pay_mode,
    paid: Boolean(o.paid_at),
    awaiting_payment: !o.committed_at && o.status !== 'canceled',
    session_id: o.session_id,
    resource: o.resource_id ? { id: o.resource_id, number: o.resource_number ?? null } : null,
    items: (o.items ?? []).map((i) => ({
      id: i.id,
      product_id: i.product_id,
      product_name: i.product_name ?? null,
      name: i.name,
      qty: i.qty,
      unit_price_kopecks: Number(i.unit_price_kopecks),
      amount_kopecks: Number(i.amount_kopecks),
      modifiers: (i.modifiers ?? []).map((m) => ({ id: m.id, name: m.name })),
    })),
    subtotal_kopecks: Number(o.subtotal_kopecks),
    comment: o.comment,
    payment_id: o.payment_id,
    sale_id: o.sale_id,
    created_at: iso(o.created_at),
    status_at: iso(o.status_at),
    paid_at: iso(o.paid_at),
    canceled_at: iso(o.canceled_at),
  };
  if (staff) {
    view.cancel_reason = o.cancel_reason;
    view.canceled_by = o.canceled_by;
    view.created_by = o.created_by;
    view.committed_at = iso(o.committed_at);
  }
  return view;
}

/** SSE после коммита: bar в club:{id} (только заказы, которые видит бар), order в session:{id}. */
export async function publishOrder(db, deps, o) {
  const staffView = orderView(o, { staff: true });
  const guestView = orderView(o);
  await afterCommit(db, () => {
    try {
      if (o.committed_at || o.status === 'canceled') deps.sse.publish(`club:${o.club_id}`, 'bar', staffView);
      if (o.session_id) deps.sse.publish(`session:${o.session_id}`, 'order', guestView);
    } catch (err) {
      deps.log?.warn?.('sse_publish_failed', { error: err.message });
    }
  });
}

export async function publishClub(db, deps, clubId, event, data) {
  await afterCommit(db, () => {
    try {
      deps.sse.publish(`club:${clubId}`, event, data);
    } catch (err) {
      deps.log?.warn?.('sse_publish_failed', { error: err.message });
    }
  });
}

export { iso };
