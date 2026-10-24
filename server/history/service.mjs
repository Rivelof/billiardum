// Истории программы клуба (M5.2 §7, решения №173–175): заказы гостей, ревизии, списания, приходы.
// Только чтение того, что пишут журнал, касса и склад (№175, инвариант 2) — правок задним числом нет.
//
// Период — рабочие сутки клуба (как у дашборда, №167), по умолчанию — текущий месяц. Поиск q,
// сортировка sort (поле или -поле), курсор — смещение в отсортированном списке (next_cursor).
// Гость — только маска телефона (+7999***4567) или ник Бильярдум+ (№173); имена — только сотрудников.
// Тестовые записи (is_test) не показываются. Количество — числом до тысячных, деньги — копейки.

import { HttpError } from '../http/errors.mjs';
import { maskPhones } from '../notify/index.mjs';
import { dayBounds, daysBetween, isDay, workingDayOf } from '../dashboard/time.mjs';

export const KINDS = ['orders', 'audits', 'writeoffs', 'arrivals'];
export const PAGE = 50;
export const MAX_PAGE = 200;
export const MAX_DAYS = 366;
const ORDER_STATUSES = ['new', 'preparing', 'ready', 'served', 'canceled'];
const WRITEOFF_SOURCES = ['pos', 'program', 'audit'];

const SORTS = {
  orders: { created_at: 'o.created_at', number: 'o.number', amount: 'o.subtotal_kopecks', status: 'o.status', canceled_at: 'o.canceled_at' },
  audits: { created_at: 'a.created_at', items: 'items', diff_kopecks: 'a.total_diff_kopecks', diff_qty: 'diff_qty' },
  writeoffs: { created_at: 'x.created_at', product: 'x.product_name', qty: 'x.qty', cost: 'x.cost_kopecks', source: 'x.source' },
  arrivals: { created_at: 'm.created_at', product: 'p.name', qty: 'm.qty', cost: 'm.cost_kopecks', unit_cost: 'unit_cost' },
};

const like = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Разобрать запрос истории (400 bad_request при ошибке). */
export function parseHistoryQuery(kind, query, { today }) {
  if (!KINDS.includes(kind)) throw new HttpError(404, 'not_found');
  const from = query.from ?? `${today.slice(0, 8)}01`;
  const to = query.to ?? today;
  if (!isDay(from) || !isDay(to) || from > to || daysBetween(from, to) > MAX_DAYS) throw new HttpError(400, 'bad_request', { detail: 'period' });
  let q = null;
  if (query.q !== undefined && query.q !== '') {
    if (typeof query.q !== 'string' || query.q.length > 100) throw new HttpError(400, 'bad_request', { detail: 'q' });
    q = query.q.trim() || null;
  }
  let status = null;
  if (query.status !== undefined && query.status !== '') {
    const allowed = kind === 'orders' ? ORDER_STATUSES : kind === 'writeoffs' ? WRITEOFF_SOURCES : [];
    if (!allowed.includes(query.status)) throw new HttpError(400, 'bad_request', { detail: 'status' });
    status = query.status;
  }
  const rawSort = query.sort ?? '-created_at';
  const desc = rawSort.startsWith('-');
  const field = desc ? rawSort.slice(1) : rawSort;
  if (!SORTS[kind][field]) throw new HttpError(400, 'bad_request', { detail: 'sort' });
  let offset = 0;
  if (query.cursor !== undefined) {
    if (!/^[0-9]{1,6}$/.test(query.cursor)) throw new HttpError(400, 'bad_request', { detail: 'cursor' });
    offset = Number(query.cursor);
  }
  let limit = PAGE;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, 'bad_request', { detail: 'limit' });
  }
  return { kind, from, to, q, status, sort: { field, desc }, offset, limit };
}

/** Гости: маска телефона или ник (№173). */
async function guestLabels(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  if (list.length === 0) return out;
  const nicks = await db.query('select user_id, nick from bl.plus_briefs($1::uuid[])', [list]);
  for (const r of nicks.rows) if (r.nick) out.set(r.user_id, { nick: r.nick, phone_masked: null });
  for (const id of list) {
    if (out.has(id)) continue;
    const b = await db.query('select phone_masked from bl.user_brief($1)', [id]);
    out.set(id, { nick: null, phone_masked: b.rows[0]?.phone_masked ?? null });
  }
  return out;
}

async function staffNames(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (list.length === 0) return new Map();
  const { rows } = await db.query(
    'select u.id, u.name from bl.users u where u.id = any($1::uuid[]) and exists (select 1 from bl.club_members m where m.user_id = u.id)',
    [list],
  );
  return new Map(rows.map((r) => [r.id, r.name ?? null]));
}

function orderBy(kind, sort) {
  const col = SORTS[kind][sort.field];
  return `${col} ${sort.desc ? 'desc' : 'asc'} nulls last`;
}

/**
 * Строки одного клуба: { items, total } — items уже отсортированы и обрезаны до offset + limit
 * (смещение применяет вызывающий: у «всех клубов» списки сливаются).
 */
async function clubRows(db, club, p, { take }) {
  const { from } = dayBounds(p.from, club.timezone, club.day_start_local);
  const { to } = dayBounds(p.to, club.timezone, club.day_start_local);
  const base = [club.id, from, to];
  if (p.kind === 'orders') {
    const where = `o.club_id = $1 and o.created_at >= $2 and o.created_at < $3 and not o.is_test
      and ($4::text is null or o.status = $4)
      and ($5::text is null or o.number::text = $5 or exists (select 1 from bl.order_items i where i.order_id = o.id and i.name ilike $6))`;
    const args = [...base, p.status, p.q, p.q ? like(p.q) : null];
    const totals = await db.query(
      `select count(*)::int as count, coalesce(sum(o.subtotal_kopecks) filter (where o.status <> 'canceled'), 0)::bigint as amount,
              count(*) filter (where o.status = 'canceled')::int as canceled
         from bl.orders o where ${where}`,
      args,
    );
    const { rows } = await db.query(
      `select o.id, o.number, o.source, o.status, o.created_at, o.canceled_at, o.cancel_reason, o.paid_at, o.subtotal_kopecks, o.user_id,
              o.created_by, o.canceled_by, r.number as resource_number, coalesce(ps.method, pm.method) as method
         from bl.orders o
         left join bl.resources r on r.id = o.resource_id
         left join bl.pos_sales ps on ps.id = o.sale_id
         left join bl.payments pm on pm.id = o.payment_id
        where ${where}
        order by ${orderBy('orders', p.sort)}, o.id limit $7`,
      [...args, take],
    );
    const items = rows.length
      ? (await db.query('select order_id, position, name, qty, unit_price_kopecks, amount_kopecks, modifiers from bl.order_items where club_id = $2 and order_id = any($1::uuid[]) order by order_id, position', [rows.map((r) => r.id), club.id])).rows
      : [];
    const guests = await guestLabels(db, rows.map((r) => r.user_id));
    const names = await staffNames(db, rows.flatMap((r) => [r.created_by, r.canceled_by]));
    return {
      total: totals.rows[0].count,
      totals: { count: totals.rows[0].count, amount_kopecks: Number(totals.rows[0].amount), canceled: totals.rows[0].canceled },
      items: rows.map((r) => ({
        club_id: club.id,
        order_id: r.id,
        number: r.number,
        source: r.source,
        status: r.status,
        created_at: iso(r.created_at),
        canceled_at: iso(r.canceled_at),
        cancel_reason: r.cancel_reason ? maskPhones(r.cancel_reason) : null,
        paid_at: iso(r.paid_at),
        guest: r.user_id ? guests.get(r.user_id) ?? { nick: null, phone_masked: null } : null,
        resource_number: r.resource_number ?? null,
        amount_kopecks: Number(r.subtotal_kopecks),
        method: r.method ?? null,
        created_by_name: names.get(r.created_by) ?? null,
        canceled_by_name: names.get(r.canceled_by) ?? null,
        lines: items
          .filter((i) => i.order_id === r.id)
          .map((i) => ({
            name: i.name,
            qty: i.qty,
            unit_price_kopecks: Number(i.unit_price_kopecks),
            amount_kopecks: Number(i.amount_kopecks),
            modifiers: Array.isArray(i.modifiers) ? i.modifiers.map((m) => (typeof m?.name === 'string' ? m.name : null)).filter(Boolean) : [],
          })),
      })),
    };
  }
  if (p.kind === 'audits') {
    const where = `a.club_id = $1 and a.created_at >= $2 and a.created_at < $3
      and ($4::text is null or a.note ilike $5 or exists (select 1 from jsonb_array_elements(a.lines) l where l->>'name' ilike $5))`;
    const args = [...base, p.q, p.q ? like(p.q) : null];
    const select = `select a.id, a.created_at, a.created_by, a.note, a.lines, a.total_diff_kopecks,
                           jsonb_array_length(a.lines) as items,
                           (select coalesce(sum((l->>'diff_qty')::numeric), 0) from jsonb_array_elements(a.lines) l) as diff_qty,
                           (select count(*) from jsonb_array_elements(a.lines) l where (l->>'diff_qty')::numeric <> 0)::int as mismatches
                      from bl.stock_audits a where ${where}`;
    const totals = await db.query(
      `select count(*)::int as count, coalesce(sum(total_diff_kopecks), 0)::bigint as diff,
              coalesce(sum(total_diff_kopecks) filter (where total_diff_kopecks < 0), 0)::bigint as shortage,
              coalesce(sum(total_diff_kopecks) filter (where total_diff_kopecks > 0), 0)::bigint as surplus
         from bl.stock_audits a where ${where}`,
      args,
    );
    const { rows } = await db.query(`select * from (${select}) a order by ${orderBy('audits', p.sort).replace('a.', '')}, a.id limit $6`, [...args, take]);
    const names = await staffNames(db, rows.map((r) => r.created_by));
    return {
      total: totals.rows[0].count,
      totals: { count: totals.rows[0].count, diff_kopecks: Number(totals.rows[0].diff), shortage_kopecks: Number(totals.rows[0].shortage), surplus_kopecks: Number(totals.rows[0].surplus) },
      items: rows.map((r) => ({
        club_id: club.id,
        audit_id: r.id,
        created_at: iso(r.created_at),
        created_by_name: names.get(r.created_by) ?? null,
        note: r.note ? maskPhones(r.note) : null,
        items: r.items,
        mismatches: r.mismatches,
        diff_qty: Number(r.diff_qty),
        diff_kopecks: Number(r.total_diff_kopecks),
        lines: (Array.isArray(r.lines) ? r.lines : []).map((l) => ({
          product_id: l.product_id,
          name: l.name,
          unit: l.unit ?? null,
          expected_qty: num(l.expected_qty),
          actual_qty: num(l.actual_qty),
          diff_qty: num(l.diff_qty),
          unit_cost_kopecks: num(l.unit_cost_kopecks),
          diff_kopecks: num(l.diff_kopecks),
        })),
      })),
    };
  }
  if (p.kind === 'writeoffs') {
    // Списание: со склада программой клуба (writeoff без возврата кассы), касса (отменённый возврат —
    // товар снова списан), ревизия (недостача — поправка audit с минусом).
    const inner = `select m.id, m.created_at, m.created_by, m.reason, m.audit_id, p.name as product_name, p.unit,
                          (-m.qty) as qty, (-m.cost_kopecks) as cost_kopecks,
                          case when m.kind = 'audit' then 'audit' when m.refund_id is not null then 'pos' else 'program' end as source
                     from bl.stock_movements m join bl.products p on p.id = m.product_id
                    where m.club_id = $1 and m.created_at >= $2 and m.created_at < $3
                      and (m.kind = 'writeoff' or (m.kind = 'audit' and m.qty < 0))`;
    const where = `($4::text is null or x.source = $4) and ($5::text is null or x.product_name ilike $6 or x.reason ilike $6)`;
    const args = [...base, p.status, p.q, p.q ? like(p.q) : null];
    const totals = await db.query(`select count(*)::int as count, coalesce(sum(x.cost_kopecks), 0)::bigint as cost from (${inner}) x where ${where}`, args);
    const { rows } = await db.query(`select x.*, x.qty::text as qty_text from (${inner}) x where ${where} order by ${orderBy('writeoffs', p.sort)}, x.id limit $7`, [...args, take]);
    const names = await staffNames(db, rows.map((r) => r.created_by));
    return {
      total: totals.rows[0].count,
      totals: { count: totals.rows[0].count, cost_kopecks: Number(totals.rows[0].cost) },
      items: rows.map((r) => ({
        club_id: club.id,
        movement_id: r.id,
        created_at: iso(r.created_at),
        created_by_name: names.get(r.created_by) ?? null,
        source: r.source,
        product: r.product_name,
        unit: r.unit ?? null,
        qty: Number(r.qty_text),
        reason: r.reason ? maskPhones(r.reason) : null,
        audit_id: r.audit_id ?? null,
        cost_kopecks: Number(r.cost_kopecks),
      })),
    };
  }
  // arrivals
  const where = `m.club_id = $1 and m.created_at >= $2 and m.created_at < $3 and m.kind = 'arrival'
    and ($4::text is null or p.name ilike $5 or m.reason ilike $5)`;
  const args = [...base, p.q, p.q ? like(p.q) : null];
  const totals = await db.query(`select count(*)::int as count, coalesce(sum(m.cost_kopecks), 0)::bigint as cost from bl.stock_movements m join bl.products p on p.id = m.product_id where ${where}`, args);
  const { rows } = await db.query(
    `select m.id, m.created_at, m.created_by, m.reason, m.qty::text as qty_text, m.cost_kopecks, p.name as product_name, p.unit,
            case when m.qty > 0 then round(m.cost_kopecks / m.qty) else null end as unit_cost
       from bl.stock_movements m join bl.products p on p.id = m.product_id
      where ${where} order by ${orderBy('arrivals', p.sort)}, m.id limit $6`,
    [...args, take],
  );
  const names = await staffNames(db, rows.map((r) => r.created_by));
  return {
    total: totals.rows[0].count,
    totals: { count: totals.rows[0].count, cost_kopecks: Number(totals.rows[0].cost) },
    items: rows.map((r) => ({
      club_id: club.id,
      movement_id: r.id,
      created_at: iso(r.created_at),
      created_by_name: names.get(r.created_by) ?? null,
      // Поставщика в модели склада нет (приход — товар, количество, себестоимость, комментарий).
      supplier: null,
      product: r.product_name,
      unit: r.unit ?? null,
      qty: Number(r.qty_text),
      unit_cost_kopecks: num(r.unit_cost),
      cost_kopecks: Number(r.cost_kopecks),
      note: r.reason ? maskPhones(r.reason) : null,
    })),
  };
}

const SORT_VALUE = {
  orders: { created_at: (x) => x.created_at, number: (x) => x.number, amount: (x) => x.amount_kopecks, status: (x) => x.status, canceled_at: (x) => x.canceled_at },
  audits: { created_at: (x) => x.created_at, items: (x) => x.items, diff_kopecks: (x) => x.diff_kopecks, diff_qty: (x) => x.diff_qty },
  writeoffs: { created_at: (x) => x.created_at, product: (x) => x.product, qty: (x) => x.qty, cost: (x) => x.cost_kopecks, source: (x) => x.source },
  arrivals: { created_at: (x) => x.created_at, product: (x) => x.product, qty: (x) => x.qty, cost: (x) => x.cost_kopecks, unit_cost: (x) => x.unit_cost_kopecks },
};

function compare(kind, sort) {
  const f = SORT_VALUE[kind][sort.field];
  return (a, b) => {
    const x = f(a);
    const y = f(b);
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
    return sort.desc ? -c : c;
  };
}

function addTotals(acc, t) {
  for (const [k, v] of Object.entries(t)) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}

/**
 * История по клубам (один или «все мои»): { items, next_cursor, totals, period }.
 * enter(club) — контекст клуба в транзакции перед его запросами.
 */
export async function history(db, { clubs, enter, p, all }) {
  const take = p.offset + p.limit;
  const merged = [];
  let total = 0;
  const totals = {};
  for (const club of clubs) {
    await enter(club);
    const r = await clubRows(db, club, p, { take });
    total += r.total;
    addTotals(totals, r.totals);
    merged.push(...r.items);
  }
  if (clubs.length > 1) merged.sort(compare(p.kind, p.sort));
  const page = merged.slice(p.offset, take).map((x) => (all ? x : (({ club_id: _c, ...rest }) => rest)(x)));
  return {
    period: { from: p.from, to: p.to },
    items: page,
    next_cursor: take < total ? String(take) : null,
    totals,
  };
}

/** Все строки периода для CSV (до limit на клуб). */
export async function historyAll(db, { clubs, enter, p, all, max = 20_000 }) {
  return history(db, { clubs, enter, p: { ...p, offset: 0, limit: max }, all });
}

/** Сегодняшние рабочие сутки клуба. */
export function clubToday(club, now) {
  return workingDayOf(now, club.timezone, club.day_start_local);
}

