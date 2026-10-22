// Запросы отчёта смены (PRODUCT §4.2, decisions №71). Все — в транзакции с контекстом клуба;
// интервал смены — [from, to] (to — закрытие смены или «сейчас» у открытой).
//
// Выручка — bl.payments (money M1, касса M2): подтверждённые в смене; стол — kind start/extend,
// бар — kind bar (0410 backend-pos). Сумма платежа: одностадийный — amount_kopecks, заморозка
// «Без лимита» — списанная captured_kopecks (ещё не списанная — отдельно, holds). Возвраты —
// bl.refunds, созданные в смене (succeeded и manual).

export const METHODS = ['cash', 'card_terminal', 'sbp', 'card'];

const zero = () => Object.fromEntries(METHODS.map((m) => [m, 0]));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

function categoryOf(kind) {
  if (kind === 'start' || kind === 'extend') return 'tables';
  if (kind === 'bar') return 'bar';
  return 'other';
}

/** Платежи смены (для выручки и сверок). */
export async function shiftPayments(db, { clubId, from, to }) {
  const { rows } = await db.query(
    `select id, kind, provider, method, status, capture, amount_kopecks, captured_kopecks, provider_payment_id, confirmed_at
       from bl.payments
      where club_id = $1 and confirmed_at >= $2 and confirmed_at <= $3 and status in ('succeeded', 'waiting_for_capture')
      order by confirmed_at, id`,
    [clubId, from, to],
  );
  return rows.map((p) => {
    const amount = Number(p.amount_kopecks);
    const counted = p.status === 'succeeded' ? (p.capture ? amount : Number(p.captured_kopecks ?? 0)) : 0;
    return { ...p, amount_kopecks: amount, counted_kopecks: counted, hold_kopecks: p.status === 'waiting_for_capture' ? amount : 0, category: categoryOf(p.kind) };
  });
}

/** Возвраты смены. */
export async function shiftRefunds(db, { clubId, from, to }) {
  const { rows } = await db.query(
    `select f.id, f.payment_id, f.provider_refund_id, f.status, f.amount_kopecks, f.created_at, p.kind, p.method, p.provider
       from bl.refunds f join bl.payments p on p.id = f.payment_id
      where f.club_id = $1 and f.created_at >= $2 and f.created_at <= $3 and f.status in ('succeeded', 'manual')
      order by f.created_at, f.id`,
    [clubId, from, to],
  );
  return rows.map((f) => ({ ...f, amount_kopecks: Number(f.amount_kopecks), category: categoryOf(f.kind) }));
}

/** Выручка смены по столам и бару и способам оплаты. */
export function revenueOf(payments, refunds) {
  const out = {
    tables: { by_method: zero() },
    bar: { by_method: zero() },
    other: { by_method: zero() },
    by_method: zero(),
    refunds: { by_method: zero(), tables_kopecks: 0, bar_kopecks: 0, count: refunds.length },
    holds_kopecks: 0,
    payments_count: payments.length,
  };
  for (const p of payments) {
    if (!METHODS.includes(p.method)) continue;
    out[p.category].by_method[p.method] += p.counted_kopecks;
    out.by_method[p.method] += p.counted_kopecks;
    out.holds_kopecks += p.hold_kopecks;
  }
  for (const f of refunds) {
    if (!METHODS.includes(f.method)) continue;
    out.refunds.by_method[f.method] += f.amount_kopecks;
    if (f.category === 'tables') out.refunds.tables_kopecks += f.amount_kopecks;
    if (f.category === 'bar') out.refunds.bar_kopecks += f.amount_kopecks;
  }
  for (const k of ['tables', 'bar', 'other']) out[k].total_kopecks = sum(out[k].by_method);
  out.total_kopecks = sum(out.by_method);
  out.refunds.total_kopecks = sum(out.refunds.by_method);
  out.net_kopecks = out.total_kopecks - out.refunds.total_kopecks;
  return out;
}

/** Часы игры и загрузка: сессии, пересекающие смену. */
export async function playStats(db, { clubId, from, to }) {
  const { rows } = await db.query(
    `select count(*)::int as sessions,
            coalesce(sum(greatest(0, extract(epoch from (least(coalesce(s.ended_at, s.interrupted_at, $3), $3) - greatest(s.started_at, $2))))), 0)::float8 as secs
       from bl.sessions s
      where s.club_id = $1 and s.started_at <= $3 and coalesce(s.ended_at, s.interrupted_at, $3) >= $2
        and s.status <> 'cancelled'`,
    [clubId, from, to],
  );
  const res = await db.query('select count(*)::int as n from bl.resources where club_id = $1 and active', [clubId]);
  const minutes = Math.round(rows[0].secs / 60);
  const shiftMinutes = Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  const capacity = res.rows[0].n * shiftMinutes;
  return {
    sessions: rows[0].sessions,
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10,
    resources: res.rows[0].n,
    shift_minutes: Math.round(shiftMinutes),
    utilization_percent: capacity > 0 ? Math.round((rows[0].secs / 60 / capacity) * 1000) / 10 : 0,
  };
}

/** Минуты сервисного света по сотрудникам и столам (№71). */
export async function serviceLight(db, { clubId, from, to }) {
  const { rows } = await db.query(
    `select h.user_id, h.resource_id, r.number as resource_number, u.name as user_name,
            greatest(0, extract(epoch from (least(coalesce(h.released_at, h.until), $3) - greatest(h.created_at, $2))))::float8 as secs
       from bl.resource_holds h
       join bl.resources r on r.id = h.resource_id
       left join bl.users u on u.id = h.user_id
      where h.club_id = $1 and h.kind = 'service' and h.created_at <= $3 and coalesce(h.released_at, h.until) >= $2`,
    [clubId, from, to],
  );
  const byStaff = new Map();
  const byResource = new Map();
  let total = 0;
  for (const r of rows) {
    total += r.secs;
    const s = byStaff.get(r.user_id) ?? { user_id: r.user_id, name: r.user_name ?? null, secs: 0, count: 0 };
    s.secs += r.secs;
    s.count += 1;
    byStaff.set(r.user_id, s);
    const t = byResource.get(r.resource_id) ?? { resource_id: r.resource_id, number: r.resource_number, secs: 0, count: 0 };
    t.secs += r.secs;
    t.count += 1;
    byResource.set(r.resource_id, t);
  }
  const fin = ({ secs, ...x }) => ({ ...x, minutes: Math.round(secs / 60) });
  return {
    totalMinutes: Math.round(total / 60),
    count: rows.length,
    byStaff: [...byStaff.values()].sort((a, b) => b.secs - a.secs).map(fin),
    byResource: [...byResource.values()].sort((a, b) => a.number - b.number).map(fin),
  };
}

/** Ручные действия смены (инвариант 8): журнал с причиной и действия service.*, manual.*. */
export async function manualActions(db, { clubId, from, to, limit = 100 }) {
  const { rows } = await db.query(
    `select a.created_at, a.action, a.reason, a.actor_id, a.object_id, a.data, u.name as actor_name
       from bl.audit_log a left join bl.users u on u.id = a.actor_id
      where a.club_id = $1 and a.created_at >= $2 and a.created_at <= $3
        and (a.action like 'service.%' or a.action like 'manual.%' or a.action in ('payment.refunded', 'pos.refund', 'kkt.receipt_retry')
             or (a.reason is not null and a.action <> 'shift.close') or (a.action = 'pos.sale' and (a.data ->> 'discount_over_limit') = 'true'))
      order by a.seq`,
    [clubId, from, to],
  );
  const byAction = {};
  for (const r of rows) byAction[r.action] = (byAction[r.action] ?? 0) + 1;
  return {
    count: rows.length,
    by_action: byAction,
    items: rows.slice(0, limit).map((r) => ({
      at: new Date(r.created_at).toISOString(),
      action: r.action,
      actor_id: r.actor_id ?? null,
      actor_name: r.actor_name ?? null,
      reason: r.reason ?? null,
      resource_id: typeof r.data?.resource_id === 'string' ? r.data.resource_id : null,
      amount_kopecks: Number.isSafeInteger(r.data?.amount_kopecks) ? r.data.amount_kopecks : null,
    })),
  };
}
