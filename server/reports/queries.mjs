// Запросы отчёта смены (PRODUCT §4.2, decisions №71). Все — в транзакции с контекстом клуба;
// интервал смены — [from, to] (to — закрытие смены или «сейчас» у открытой).
//
// Выручка — bl.payments (money M1, касса M2): подтверждённые в смене; стол — kind start/extend,
// бар — kind bar (0410 backend-pos). Сумма платежа: одностадийный — amount_kopecks, заморозка
// «Без лимита» — списанная captured_kopecks (ещё не списанная — отдельно, holds). Возвраты —
// bl.refunds, созданные в смене (succeeded и manual).
//
// M3 (предоплаты, decisions №52, №87, №112): выручка — только приём денег.
// * Пакеты часов — своя строка packages: покупка в приложении (kind package) и доля пакетов в
//   продаже кассы (bl.pos_sales.package_kopecks у платежа kind bar).
// * Игра балансом минут (provider/method balance) — не деньги: в выручку, столы и сверки не входит.
// * Депозит наличными «Без лимита» — приём наличных в смене (столы, наличные); возврат остатка —
//   возврат наличными (bl.refunds manual); зачёт сыгранного — чек зачёта, не платёж.
// * Бронь — предоплата ЮKassa (kind booking) и доплата при старте по брони (kind booking_start) —
//   строка tables, в смене оплаты; зачёт предоплаты при старте — чек, не платёж (дважды не считается).
// * Турниры (M4) — взносы за участие (kind tournament, ЮKassa) — строка tournaments; возврат
//   взноса — обычный возврат (refunds.kind = 'refund'), отдельной строкой не выводится.

export const METHODS = ['cash', 'card_terminal', 'sbp', 'card'];

const zero = () => Object.fromEntries(METHODS.map((m) => [m, 0]));
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

export function categoryOf(kind) {
  // Игра за столом: старт и продление, предоплата брони (зачёт идёт по сыгранному) и доплата при
  // старте по брони. Зачёт предоплаты — чек, не платёж: второй раз в выручку не входит.
  if (kind === 'start' || kind === 'extend' || kind === 'booking' || kind === 'booking_start') return 'tables';
  if (kind === 'bar') return 'bar';
  if (kind === 'package') return 'packages';
  if (kind === 'tournament') return 'tournaments';
  return 'other';
}

/** Платежи смены (для выручки и сверок). */
export async function shiftPayments(db, { clubId, from, to }) {
  const { rows } = await db.query(
    `select p.id, p.kind, p.provider, p.method, p.status, p.capture, p.amount_kopecks, p.captured_kopecks, p.provider_payment_id, p.confirmed_at,
            p.resource_id, coalesce(ps.package_kopecks, 0)::bigint as package_kopecks
       from bl.payments p
       left join bl.pos_sales ps on ps.payment_id = p.id
      where p.club_id = $1 and p.confirmed_at >= $2 and p.confirmed_at <= $3 and p.status in ('succeeded', 'waiting_for_capture')
        and p.provider <> 'balance'
      order by p.confirmed_at, p.id`,
    [clubId, from, to],
  );
  return rows.map((p) => {
    const amount = Number(p.amount_kopecks);
    const counted = p.status === 'succeeded' ? (p.capture ? amount : Number(p.captured_kopecks ?? 0)) : 0;
    return {
      ...p,
      amount_kopecks: amount,
      counted_kopecks: counted,
      // Доля пакетов часов в продаже кассы (платёж kind bar).
      package_kopecks: p.kind === 'bar' ? Math.min(Number(p.package_kopecks), counted) : 0,
      hold_kopecks: p.status === 'waiting_for_capture' ? amount : 0,
      category: categoryOf(p.kind),
    };
  });
}

/**
 * Возвраты смены — деньги гостю (refunds.kind = 'refund', 0657 money). Не входят: release
 * (несписанная часть заморозки — деньги не списывались), balance (вернулись минуты, не деньги) и late
 * (автовозврат оплаты после отмены — в выручку не входила; см. shiftLateRefunds). Наличный возврат из
 * очереди bl.cash_refunds_pending — строка manual, созданная при выдаче в новой смене: входит в неё.
 */
export async function shiftRefunds(db, { clubId, from, to }) {
  return refundsOfKind(db, { clubId, from, to, kind: 'refund' });
}

/** Поздняя оплата возвращена (refunds.kind = 'late'): отдельной строкой, вне чистой выручки. */
export async function shiftLateRefunds(db, { clubId, from, to }) {
  return refundsOfKind(db, { clubId, from, to, kind: 'late' });
}

async function refundsOfKind(db, { clubId, from, to, kind }) {
  const { rows } = await db.query(
    `select f.id, f.payment_id, f.provider_refund_id, f.status, f.amount_kopecks, f.created_at, p.kind, p.method, p.provider, p.resource_id
       from bl.refunds f join bl.payments p on p.id = f.payment_id
      where f.club_id = $1 and f.created_at >= $2 and f.created_at <= $3 and f.status in ('succeeded', 'manual') and f.kind = $4
      order by f.created_at, f.id`,
    [clubId, from, to, kind],
  );
  return rows.map((f) => ({ ...f, amount_kopecks: Number(f.amount_kopecks), category: categoryOf(f.kind) }));
}

/**
 * Выручка смены по столам и бару и способам оплаты. lateRefunds — поздняя оплата возвращена
 * (late_returned: отдельной строкой, в выручку и чистую выручку не входит).
 */
export function revenueOf(payments, refunds, lateRefunds = []) {
  const out = {
    tables: { by_method: zero() },
    bar: { by_method: zero() },
    packages: { by_method: zero() },
    tournaments: { by_method: zero() },
    other: { by_method: zero() },
    by_method: zero(),
    refunds: { by_method: zero(), tables_kopecks: 0, bar_kopecks: 0, count: refunds.length },
    holds_kopecks: 0,
    payments_count: payments.length,
  };
  for (const p of payments) {
    if (!METHODS.includes(p.method)) continue;
    const pkg = p.package_kopecks ?? 0;
    out[p.category].by_method[p.method] += p.counted_kopecks - pkg;
    out.packages.by_method[p.method] += pkg;
    out.by_method[p.method] += p.counted_kopecks;
    out.holds_kopecks += p.hold_kopecks;
  }
  for (const f of refunds) {
    if (!METHODS.includes(f.method)) continue;
    out.refunds.by_method[f.method] += f.amount_kopecks;
    if (f.category === 'tables') out.refunds.tables_kopecks += f.amount_kopecks;
    if (f.category === 'bar') out.refunds.bar_kopecks += f.amount_kopecks;
  }
  for (const k of ['tables', 'bar', 'packages', 'tournaments', 'other']) out[k].total_kopecks = sum(out[k].by_method);
  out.total_kopecks = sum(out.by_method);
  out.refunds.total_kopecks = sum(out.refunds.by_method);
  out.net_kopecks = out.total_kopecks - out.refunds.total_kopecks;
  out.late_returned = { by_method: zero(), count: lateRefunds.length };
  for (const f of lateRefunds) if (METHODS.includes(f.method)) out.late_returned.by_method[f.method] += f.amount_kopecks;
  out.late_returned.total_kopecks = sum(out.late_returned.by_method);
  return out;
}

/**
 * Часы игры и загрузка: сессии, пересекающие смену; по столам — минуты игры и выручка столов
 * (платежи смены за стол и возвраты по ним).
 * @param {{ clubId: string, from: Date, to: Date, payments?: object[], refunds?: object[] }} args
 */
export async function playStats(db, { clubId, from, to, payments = [], refunds = [] }) {
  const { rows } = await db.query(
    `select s.resource_id, count(*)::int as sessions,
            coalesce(sum(greatest(0, extract(epoch from (least(coalesce(s.ended_at, s.interrupted_at, $3), $3) - greatest(s.started_at, $2))))), 0)::float8 as secs
       from bl.sessions s
      where s.club_id = $1 and s.started_at <= $3 and coalesce(s.ended_at, s.interrupted_at, $3) >= $2
        and s.status <> 'cancelled'
      group by s.resource_id`,
    [clubId, from, to],
  );
  const res = await db.query('select id, number, title, active from bl.resources where club_id = $1 order by number', [clubId]);
  const byId = new Map(
    res.rows.map((r) => [r.id, { resource_id: r.id, number: r.number, title: r.title ?? null, sessions: 0, secs: 0, revenue_kopecks: 0, refunds_kopecks: 0, active: r.active }]),
  );
  let secs = 0;
  let sessions = 0;
  for (const r of rows) {
    secs += r.secs;
    sessions += r.sessions;
    const t = byId.get(r.resource_id);
    if (t) {
      t.sessions += r.sessions;
      t.secs += r.secs;
    }
  }
  for (const p of payments) if (p.resource_id && byId.has(p.resource_id)) byId.get(p.resource_id).revenue_kopecks += p.counted_kopecks;
  for (const f of refunds) if (f.resource_id && byId.has(f.resource_id)) byId.get(f.resource_id).refunds_kopecks += f.amount_kopecks;
  const active = res.rows.filter((r) => r.active).length;
  const minutes = Math.round(secs / 60);
  const shiftMinutes = Math.max(0, (new Date(to).getTime() - new Date(from).getTime()) / 60_000);
  const capacity = active * shiftMinutes;
  return {
    sessions,
    minutes,
    hours: Math.round((minutes / 60) * 10) / 10,
    resources: active,
    shift_minutes: Math.round(shiftMinutes),
    utilization_percent: capacity > 0 ? Math.round((secs / 60 / capacity) * 1000) / 10 : 0,
    by_resource: [...byId.values()]
      .filter((t) => t.active || t.sessions > 0 || t.revenue_kopecks > 0 || t.refunds_kopecks > 0)
      .map(({ secs: tSecs, active: _active, ...t }) => {
        const m = Math.round(tSecs / 60);
        return {
          ...t,
          minutes: m,
          hours: Math.round((m / 60) * 10) / 10,
          utilization_percent: shiftMinutes > 0 ? Math.round((tSecs / 60 / shiftMinutes) * 1000) / 10 : 0,
        };
      }),
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

/** Действия системы, которые раньше попадали в «ручные» (сгорания, автовозвраты, отмены, оплаты после отмены). */
export const AUTOMATIC_ACTIONS = Object.freeze(['payment.forfeited', 'payment.refunded', 'payment.canceled', 'pos.refund', 'pos.sale_canceled', 'booking.late_payment', 'reception.deposit_settled']);
/** Действия персонала, которые журнал пишет не как manual.* (сервисный свет, возвраты, повтор чека). */
const STAFF_ACTIONS = ['payment.refunded', 'pos.refund', 'kkt.receipt_retry'];
/** Денежные записи, которые порождает другое действие (возврат пакета, возврат кассы): склеиваются с ним. */
const DERIVED_ACTIONS = new Set(['payment.refunded', 'pos.refund']);
/** Связь по общему платежу — только у записей одного актора в пределах этого окна (одна операция). */
const LINK_WINDOW_MS = 60_000;
const STAFF_ROLES = ['owner', 'manager', 'reception', 'bar', 'installer'];

/** Ключи связи записи журнала: сильные (возврат, возврат кассы, партия минут) и слабый (платёж). */
function linkKeys(r) {
  const d = r.data ?? {};
  const strong = new Set();
  const add = (prefix, v) => {
    if (typeof v === 'string' && v) strong.add(`${prefix}:${v}`);
  };
  add('refund', d.refund_id);
  add('pos_refund', d.pos_refund_id);
  add('lot', d.lot_id);
  if (Array.isArray(d.packages)) for (const p of d.packages) add('lot', p?.lot_id);
  const payment = typeof d.payment_id === 'string' ? d.payment_id : r.object_type === 'payment' ? r.object_id : null;
  return { strong, payment };
}

/**
 * Склеить записи одной операции: денежная запись (payment.refunded, pos.refund), порождённая уже
 * учтённым действием той же группы (общий возврат, возврат кассы или партия минут; либо общий платёж
 * у того же актора в пределах минуты), отдельно не считается — она прикрепляется к нему (linked).
 */
function mergeDerived(list) {
  const kept = [];
  for (const r of list) {
    const k = linkKeys(r);
    const t = new Date(r.created_at).getTime();
    const parent = DERIVED_ACTIONS.has(r.action)
      ? kept.find((p) => {
          if ([...k.strong].some((x) => p.keys.strong.has(x))) return true;
          return k.payment && p.keys.payment === k.payment && (p.row.actor_id ?? null) === (r.actor_id ?? null) && Math.abs(t - p.t) <= LINK_WINDOW_MS;
        })
      : null;
    if (parent) {
      parent.linked.push(r.action);
      for (const x of k.strong) parent.keys.strong.add(x);
      continue;
    }
    kept.push({ row: r, keys: k, t, linked: [] });
  }
  return kept;
}

const score = (x) => (x && Number.isInteger(x.score_a) && Number.isInteger(x.score_b) ? `${x.score_a}:${x.score_b}` : null);
const uuidOr = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : null);
/** Окно турнира в журнале extend: { ends_at, match_minutes, light_until } без лишнего. */
const windowOf = (w) => (w && typeof w === 'object' ? { ends_at: w.ends_at ?? null, match_minutes: Number.isInteger(w.match_minutes) ? w.match_minutes : null, light_until: w.light_until ?? null } : null);

/**
 * Суть ручных действий турниров и споров для строки отчёта (frontend): что было → что стало.
 * Только идентификаторы, счёт, время и коды — без персональных данных.
 */
const DETAIL_ACTIONS = {
  'manual.tournament_score': (d) => ({
    tournament_id: uuidOr(d.tournament_id),
    match_id: uuidOr(d.match_id),
    before: d.before?.status === 'done' ? score(d.before) : d.before?.status === 'disputed' ? 'спор' : 'без счёта',
    after: score(d.after),
  }),
  'plus.match_resolve': (d) => ({
    match_id: uuidOr(d.match_id),
    result: ['a', 'b', 'annul'].includes(d.result) ? d.result : null,
    before: score(d.before),
    after: d.result === 'annul' ? 'отменён' : score(d),
  }),
  'manual.tournament_extend': (d) => ({ tournament_id: uuidOr(d.tournament_id), before: windowOf(d.before), after: windowOf(d.after) }),
  'manual.tournament_refund': (d) => ({
    tournament_id: uuidOr(d.tournament_id),
    entry_id: uuidOr(d.entry_id),
    scope: d.scope === 'all' ? 'all' : 'entry',
    reason_code: ['health', 'equipment', 'venue'].includes(d.reason_code) ? d.reason_code : null,
    refunds: Number.isInteger(d.refunds) ? d.refunds : null,
  }),
};
const detailOf = (r) => DETAIL_ACTIONS[r.action](r.data ?? {});

/**
 * Действия смены или суток из журнала (инвариант 8; decisions №125 с уточнением, дефекты tester Д4 и frontend).
 * * «ручные» (count, by_action, items) — записи журнала manual.* и действия персонала (staff: актор —
 *   сотрудник этого клуба по членству, в т. ч. отозванный, или роль в самой записи); у записи items
 *   поле kind: 'manual' | 'staff'.
 * * automatic — действия системы (actor_type не user): сгорание предоплаты, автоматические возвраты
 *   (двойная и поздняя оплата, оплата после отмены), отмены платежей с причиной (в т. ч. по 404
 *   ЮKassa), расчёт депозита; отдельной строкой «автоматические».
 * * guests — действия гостей (отмена брони гостем с возвратом и т. п.): не ручные и не автоматические.
 * * staff — разбивка: действия персонала, которые журнал пишет не как manual.* (сервисный свет
 *   service.*, возвраты сотрудником, повтор чека ККТ, записи с причиной); входят в «ручные».
 * Денежная запись, порождённая учтённым действием (возврат денег при возврате пакета, запись money
 * рядом с возвратом кассы), склеивается с ним: одна строка, у неё linked — действия-спутники.
 * @returns {Promise<{ count, by_action, items, automatic, guests, staff }>}
 */
export async function manualActions(db, { clubId, from, to, limit = 100 }) {
  const { rows } = await db.query(
    `select a.created_at, a.action, a.actor_type, a.reason, a.actor_id, a.object_type, a.object_id, a.data, u.name as actor_name,
            r.id as res_id, r.number as resource_number,
            case when a.action like 'manual.%' then 'manual'
                 when a.actor_type <> 'user' then 'automatic'
                 when (a.data ->> 'actor_role') = any($6::text[])
                      or exists (select 1 from bl.club_members m where m.club_id = a.club_id and m.user_id = a.actor_id and m.role = any($6::text[]))
                   then 'staff'
                 else 'guest' end as bucket
       from bl.audit_log a
       left join bl.users u on u.id = a.actor_id
       left join bl.resources r on r.club_id = a.club_id
             and r.id = case when a.object_type = 'resource' then a.object_id
                             when (a.data ->> 'resource_id') ~ '^[0-9a-f-]{36}$' then (a.data ->> 'resource_id')::uuid end
      where a.club_id = $1 and a.created_at >= $2 and a.created_at <= $3
        and (a.action like 'manual.%'
             or (a.actor_type = 'user' and (a.action like 'service.%' or a.action = any($4::text[])
                                            or (a.reason is not null and a.action <> 'shift.close')))
             or (a.actor_type <> 'user' and (a.action = 'payment.forfeited'
                                             or (a.action = any($5::text[]) and (a.reason is not null or a.action <> 'payment.canceled')))))
      order by a.seq`,
    [clubId, from, to, STAFF_ACTIONS, AUTOMATIC_ACTIONS, STAFF_ROLES],
  );
  const group = (list) => fromMerged(mergeDerived(list));
  const fromMerged = (merged) => {
    const byAction = {};
    for (const { row } of merged) byAction[row.action] = (byAction[row.action] ?? 0) + 1;
    return {
      count: merged.length,
      by_action: byAction,
      items: merged.slice(0, limit).map(({ row: r, linked }) => ({
        at: new Date(r.created_at).toISOString(),
        action: r.action,
        kind: r.bucket,
        actor_id: r.actor_id ?? null,
        actor_name: r.actor_name ?? null,
        reason: r.reason ?? null,
        resource_id: r.res_id ?? null,
        resource_number: r.resource_number ?? null,
        amount_kopecks: Number.isSafeInteger(r.data?.amount_kopecks) ? r.data.amount_kopecks : null,
        linked,
        ...(DETAIL_ACTIONS[r.action] ? { data: detailOf(r) } : {}),
      })),
    };
  };
  // Ручные: manual.* и персонал склеиваются вместе (возврат пакета manual.* + возврат денег сотрудником).
  const manualMerged = mergeDerived(rows.filter((r) => r.bucket === 'manual' || r.bucket === 'staff'));
  return {
    ...fromMerged(manualMerged),
    automatic: group(rows.filter((r) => r.bucket === 'automatic')),
    guests: group(rows.filter((r) => r.bucket === 'guest')),
    staff: fromMerged(manualMerged.filter((m) => m.row.bucket === 'staff')),
  };
}

/**
 * Ссылки кассы на смену (decisions №92: pos_sales.shift_id и pos_refunds.shift_id — мягкие, без
 * внешнего ключа): продажи и возвраты кассы за смену, чья ссылка не ведёт на смену клуба.
 * Таблиц кассы нет — status skipped.
 */
export async function shiftLinks(db, { clubId, shiftId, from, to }) {
  const { rows: t } = await db.query("select to_regclass('bl.pos_sales') is not null as sales, to_regclass('bl.pos_refunds') is not null as refunds");
  if (!t[0].sales && !t[0].refunds) return { ok: null, status: 'skipped' };
  const out = { ok: true, status: 'checked', linked: 0, dangling: [], unlinked: 0 };
  for (const [table, kind] of [['pos_sales', 'sale'], ['pos_refunds', 'refund']]) {
    if (!t[0][kind === 'sale' ? 'sales' : 'refunds']) continue;
    const { rows } = await db.query(
      `select x.id, x.shift_id, (x.shift_id = $2) as mine, exists (select 1 from bl.shifts s where s.club_id = x.club_id and s.id = x.shift_id) as found
         from bl.${table} x
        where x.club_id = $1 and (x.shift_id = $2 or (x.created_at >= $3 and x.created_at <= $4))`,
      [clubId, shiftId, from, to],
    );
    for (const r of rows) {
      if (r.mine) out.linked += 1;
      if (r.shift_id === null) out.unlinked += 1;
      else if (!r.found) out.dangling.push({ kind, id: r.id, shift_id: r.shift_id });
    }
  }
  out.ok = out.dangling.length === 0;
  out.dangling = out.dangling.slice(0, 100);
  return out;
}

/** Выручка смены одним числом (список смен): платежи, подтверждённые в смене, как revenue.total_kopecks. */
export const REVENUE_TOTAL_SQL = `(select coalesce(sum(case when p.status = 'succeeded'
                     then case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end else 0 end), 0)::bigint
          from bl.payments p
         where p.club_id = s.club_id and p.status in ('succeeded', 'waiting_for_capture') and p.provider <> 'balance'
           and p.confirmed_at >= s.opened_at and p.confirmed_at <= coalesce(s.closed_at, $NOW))`;
