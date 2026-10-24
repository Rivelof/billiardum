// Касса управляющего (M5.2 №177): управленческая денежная книга клуба — не бухгалтерия.
//
// * Инкассации — автоматически из закрытых смен: наличные при закрытии минус размен (то, что
//   уходит из кассы ресепшена управляющему), одна запись на смену (уникальный shift_id), сутки — по
//   закрытию смены. Смена, где в кассе осталось не больше размена, инкассации не даёт.
// * Прочие доходы и расходы — вручную по статьям справочника клуба (статьи правит владелец).
// * Записи не правятся и не удаляются (триггер базы): исправление — сторно (новая запись со знаком
//   минус, ссылкой на исходную и причиной), датой сторно (прошлые остатки не меняются).
// * Дата записи (№189) — не раньше чем 35 дней назад (иначе 400 bad_request, detail date) и не в
//   будущем; запись задним числом (раньше вчерашних суток) — уведомление владельцу (не тревога).
// * Остаток на начало периода = сумма записей до него; на конец = начало + доходы + инкассации − расходы.
// Журнал: cashbook.entry, cashbook.storno, cashbook.collection, cashbook.category_create, cashbook.category_update.

import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isUuid, safely } from '../lib/store.mjs';
import { formatMoney } from '@billiardum/shared/format';
import { maskPhones, sendToClubStaff } from '../notify/index.mjs';
import { addDays, dayBounds, daysBetween, isDay, ruDate, workingDayOf } from './time.mjs';

export const DEFAULT_CATEGORIES = [
  ['expense', 'Аренда', 10],
  ['expense', 'Коммунальные', 20],
  ['expense', 'Закупка', 30],
  ['expense', 'Зарплата', 40],
  ['expense', 'Ремонт столов', 50],
  ['expense', 'Прочее', 90],
  ['income', 'Прочие доходы', 10],
  ['income', 'Начальный остаток', 20],
];
const MAX_AMOUNT = 100_000_000_000;
/** Самая ранняя дата записи — столько суток назад (№189). */
export const MAX_BACKDATE_DAYS = 35;
const KINDS = ['income', 'expense'];
const iso = (d) => (d ? new Date(d).toISOString() : null);
const sign = (kind, amount) => (kind === 'expense' ? -amount : amount);

/** Статьи клуба; у нового клуба — набор по умолчанию (№177). */
export async function ensureCategories(db, clubId, now) {
  const { rowCount } = await db.query('select 1 from bl.cashbook_categories where club_id = $1 limit 1', [clubId]);
  if (rowCount > 0) return;
  for (const [kind, name, sort] of DEFAULT_CATEGORIES) {
    await db.query(
      `insert into bl.cashbook_categories (club_id, kind, name, sort, created_at, updated_at) values ($1, $2, $3, $4, $5, $5)
       on conflict do nothing`,
      [clubId, kind, name, sort, now],
    );
  }
}

/** Инкассации закрытых смен без записи книги (идемпотентно). */
export async function ensureCollections(db, club, now) {
  const { rows } = await db.query(
    `select s.id, s.number, s.closed_at, s.float_kopecks, s.actual_cash_kopecks
       from bl.shifts s
      where s.club_id = $1 and s.closed_at is not null and not s.is_test and s.actual_cash_kopecks > s.float_kopecks
        and not exists (select 1 from bl.cashbook_entries e where e.shift_id = s.id and e.reverses_id is null)
      order by s.closed_at limit 200`,
    [club.id],
  );
  let created = 0;
  for (const s of rows) {
    const amount = Number(s.actual_cash_kopecks) - Number(s.float_kopecks);
    const day = workingDayOf(new Date(s.closed_at), club.timezone, club.day_start_local);
    const ins = await db.query(
      `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, occurred_on, shift_id, comment, created_at)
       values ($1, 'collection', $2, $3, $4, $5, $6)
       on conflict (shift_id) where shift_id is not null and reverses_id is null do nothing returning id`,
      [club.id, amount, day, s.id, `Смена №${s.number}`, now],
    );
    if (ins.rowCount === 0) continue;
    created += 1;
    await appendAudit(db, {
      action: 'cashbook.collection',
      objectType: 'cashbook_entry',
      objectId: ins.rows[0].id,
      actorType: 'system',
      actorId: null,
      data: { entry_id: ins.rows[0].id, shift_id: s.id, number: s.number, amount_kopecks: amount, day },
    });
  }
  return created;
}

/** Шаг планировщика дашборда (контекст клуба, system). */
export async function cashbookTick(db, { clubId, now }) {
  const { rows } = await db.query('select id, timezone, settings from bl.clubs where id = $1', [clubId]);
  if (!rows[0]) return { created: 0 };
  const club = { id: rows[0].id, timezone: rows[0].timezone, day_start_local: rows[0].settings?.day_start_local ?? '06:00' };
  return { created: await ensureCollections(db, club, now) };
}

/** Суммы периода [fromDay, toDay] для дашборда: { income_kopecks, collections_kopecks, expenses_kopecks }. */
export async function cashbookTotals(db, club, { fromDay, toDay }) {
  const { rows } = await db.query(
    `select coalesce(sum(amount_kopecks) filter (where kind = 'income'), 0)::bigint as income,
            coalesce(sum(amount_kopecks) filter (where kind = 'collection'), 0)::bigint as collections,
            coalesce(sum(amount_kopecks) filter (where kind = 'expense'), 0)::bigint as expenses
       from bl.cashbook_entries where club_id = $1 and occurred_on >= $2 and occurred_on <= $3 and not is_test`,
    [club.id, fromDay, toDay],
  );
  return { income_kopecks: Number(rows[0].income), collections_kopecks: Number(rows[0].collections), expenses_kopecks: Number(rows[0].expenses) };
}

function entryJson(e, names, cats) {
  return {
    entry_id: e.id,
    kind: e.kind,
    amount_kopecks: Number(e.amount_kopecks),
    signed_kopecks: sign(e.kind, Number(e.amount_kopecks)),
    category_id: e.category_id ?? null,
    category: e.category_id ? cats.get(e.category_id)?.name ?? null : null,
    date: e.day,
    comment: e.comment ? maskPhones(e.comment) : null,
    shift_id: e.shift_id ?? null,
    reverses_id: e.reverses_id ?? null,
    reversed_by: e.reversed_by ?? null,
    reason: e.reason ? maskPhones(e.reason) : null,
    created_by: e.created_by ?? null,
    created_by_name: e.created_by ? names.get(e.created_by) ?? null : null,
    created_at: iso(e.created_at),
  };
}

export function parsePeriod(query, today) {
  const from = query.from ?? `${today.slice(0, 8)}01`;
  const to = query.to ?? today;
  if (!isDay(from) || !isDay(to) || from > to || daysBetween(from, to) > 366) throw new HttpError(400, 'bad_request', { detail: 'period' });
  return { from, to };
}

export async function listCategories(db, clubId, now) {
  await ensureCategories(db, clubId, now);
  const { rows } = await db.query('select id, kind, name, sort, active from bl.cashbook_categories where club_id = $1 order by kind, sort, name', [clubId]);
  return rows.map((c) => ({ category_id: c.id, kind: c.kind, name: c.name, sort: c.sort, active: c.active }));
}

/** Книга за период: остатки, суммы, по статьям, записи. */
export async function cashbookView(db, club, { from, to, now }) {
  await ensureCollections(db, club, now);
  const categories = await listCategories(db, club.id, now);
  const cats = new Map(categories.map((c) => [c.category_id, c]));
  const opening = await db.query(
    `select coalesce(sum(case when kind = 'expense' then -amount_kopecks else amount_kopecks end), 0)::bigint as v
       from bl.cashbook_entries where club_id = $1 and occurred_on < $2 and not is_test`,
    [club.id, from],
  );
  const { rows } = await db.query(
    `select e.*, e.occurred_on::text as day, r.id as reversed_by
       from bl.cashbook_entries e left join bl.cashbook_entries r on r.reverses_id = e.id
      where e.club_id = $1 and e.occurred_on >= $2 and e.occurred_on <= $3 and not e.is_test
      order by e.occurred_on, e.created_at, e.id`,
    [club.id, from, to],
  );
  const names = new Map(
    (
      await db.query(
        'select u.id, u.name from bl.users u where u.id = any($1::uuid[]) and exists (select 1 from bl.club_members m where m.user_id = u.id)',
        [[...new Set(rows.map((r) => r.created_by).filter(Boolean))]],
      )
    ).rows.map((r) => [r.id, r.name]),
  );
  let income = 0;
  let collections = 0;
  let expenses = 0;
  const byCat = new Map();
  for (const e of rows) {
    const a = Number(e.amount_kopecks);
    if (e.kind === 'income') income += a;
    else if (e.kind === 'collection') collections += a;
    else expenses += a;
    const key = e.category_id ?? 'collection';
    const c = byCat.get(key) ?? { category_id: e.category_id ?? null, kind: e.kind, name: e.category_id ? cats.get(e.category_id)?.name ?? null : 'Инкассации', amount_kopecks: 0, count: 0 };
    c.amount_kopecks += a;
    c.count += 1;
    byCat.set(key, c);
  }
  const open = Number(opening.rows[0].v);
  return {
    period: { from, to },
    opening_kopecks: open,
    income_kopecks: income,
    collections_kopecks: collections,
    expenses_kopecks: expenses,
    closing_kopecks: open + income + collections - expenses,
    by_category: [...byCat.values()].sort((x, y) => (x.kind === y.kind ? y.amount_kopecks - x.amount_kopecks : x.kind < y.kind ? -1 : 1)),
    entries: rows.map((e) => entryJson(e, names, cats)),
    categories,
  };
}

function parseAmount(v) {
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_AMOUNT) throw new HttpError(400, 'bad_request', { detail: 'amount_kopecks' });
  return v;
}

/** POST …/cashbook {kind, amount_kopecks, category_id, date?, comment?} — владелец и управляющий. */
export async function addEntry(db, { club, userId, body, now }) {
  const b = body ?? {};
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  const amount = parseAmount(b.amount_kopecks);
  if (!isUuid(b.category_id)) throw new HttpError(400, 'bad_request', { detail: 'category_id' });
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  const day = b.date ?? today;
  if (!isDay(day) || day > today || day < addDays(today, -MAX_BACKDATE_DAYS)) throw new HttpError(400, 'bad_request', { detail: 'date' });
  let comment = null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string' || b.comment.trim().length > 500) throw new HttpError(400, 'bad_request', { detail: 'comment' });
    comment = b.comment.trim() || null;
  }
  await ensureCategories(db, club.id, now);
  const cat = await db.query('select id, kind, name, active from bl.cashbook_categories where id = $1 and club_id = $2', [b.category_id, club.id]);
  const c = cat.rows[0];
  if (!c) throw new HttpError(404, 'not_found');
  if (c.kind !== b.kind || !c.active) throw new HttpError(400, 'bad_request', { detail: 'category' });
  const { rows } = await db.query(
    `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, category_id, occurred_on, comment, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *, occurred_on::text as day`,
    [club.id, b.kind, amount, c.id, day, comment, userId, now],
  );
  const e = rows[0];
  await appendAudit(db, {
    action: 'cashbook.entry',
    objectType: 'cashbook_entry',
    objectId: e.id,
    actorType: 'user',
    actorId: userId,
    data: { entry_id: e.id, kind: e.kind, amount_kopecks: amount, category_id: c.id, day },
  });
  // Задним числом — раньше вчерашних суток (№189): меняет прошлые остатки и прибыль, владельцу — уведомление.
  if (day < addDays(today, -1)) {
    const who = (await db.query('select name from bl.users where id = $1', [userId])).rows[0]?.name ?? null;
    const word = b.kind === 'expense' ? 'расход' : 'доход';
    await sendToClubStaff(db, club.id, ['owner'], {
      kind: 'cashbook.backdated',
      level: 'important',
      text: `Касса: запись задним числом — ${word} ${formatMoney(amount)}, статья «${c.name}», дата ${ruDate(day)}${who ? `, внёс ${who}` : ''}.`,
      data: { club_id: club.id, entry_id: e.id, day, url: `/club/c/${encodeURIComponent(club.id)}/reports/cashbook` },
    });
  }
  return entryJson(e, new Map(), new Map([[c.id, c]]));
}

/** POST …/cashbook/{id}/storno {reason} — сторно с причиной; повторное сторно — 409 duplicate. */
export async function stornoEntry(db, { club, userId, entryId, reason, now }) {
  if (typeof reason !== 'string' || reason.trim() === '') throw new HttpError(400, 'reason_required');
  const why = reason.trim();
  if (why.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'reason' });
  const { rows } = await db.query('select * from bl.cashbook_entries where id = $1 and club_id = $2', [entryId, club.id]);
  const o = rows[0];
  if (!o || o.club_id !== club.id) throw new HttpError(404, 'not_found');
  if (o.reverses_id) throw new HttpError(400, 'bad_request', { detail: 'storno of storno' });
  const done = await db.query('select 1 from bl.cashbook_entries where reverses_id = $1 and club_id = $2', [o.id, club.id]);
  if (done.rowCount > 0) throw new HttpError(409, 'duplicate');
  const day = workingDayOf(now, club.timezone, club.day_start_local);
  // Параллельное второе сторно упирается в уникальный индекс reverses_id — тоже 409.
  let ins;
  try {
    ins = await safely(db, (x) =>
      x.query(
        `insert into bl.cashbook_entries (club_id, kind, amount_kopecks, category_id, occurred_on, comment, reverses_id, reason, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *, occurred_on::text as day`,
        [club.id, o.kind, -Number(o.amount_kopecks), o.category_id, day, null, o.id, why, userId, now],
      ),
    );
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'duplicate');
    throw err;
  }
  const e = ins.rows[0];
  await appendAudit(db, {
    action: 'cashbook.storno',
    objectType: 'cashbook_entry',
    objectId: e.id,
    reason: why,
    actorType: 'user',
    actorId: userId,
    data: { entry_id: e.id, reverses_id: o.id, kind: o.kind, amount_kopecks: -Number(o.amount_kopecks), day },
  });
  return entryJson(e, new Map(), new Map());
}

/** POST …/cashbook/categories {kind, name, sort?} — владелец. */
export async function createCategory(db, { clubId, userId, body, now }) {
  const b = body ?? {};
  if (!KINDS.includes(b.kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.trim().length > 60) throw new HttpError(400, 'bad_request', { detail: 'name' });
  const sort = b.sort === undefined ? 100 : b.sort;
  if (!Number.isInteger(sort) || sort < 0 || sort > 1000) throw new HttpError(400, 'bad_request', { detail: 'sort' });
  await ensureCategories(db, clubId, now);
  const { rows } = await db.query(
    `insert into bl.cashbook_categories (club_id, kind, name, sort, created_by, created_at, updated_at) values ($1, $2, $3, $4, $5, $6, $6)
     on conflict do nothing returning id, kind, name, sort, active`,
    [clubId, b.kind, b.name.trim(), sort, userId, now],
  );
  if (rows.length === 0) throw new HttpError(409, 'duplicate');
  const c = rows[0];
  await appendAudit(db, { action: 'cashbook.category_create', objectType: 'cashbook_category', objectId: c.id, actorType: 'user', actorId: userId, data: { category_id: c.id, kind: c.kind, name: c.name } });
  return { category_id: c.id, kind: c.kind, name: c.name, sort: c.sort, active: c.active };
}

/** PATCH …/cashbook/categories/{id} {name?, sort?, active?} — владелец. */
export async function updateCategory(db, { clubId, userId, categoryId, body, now }) {
  const b = body ?? {};
  const cur = (await db.query('select * from bl.cashbook_categories where id = $1 and club_id = $2', [categoryId, clubId])).rows[0];
  if (!cur || cur.club_id !== clubId) throw new HttpError(404, 'not_found');
  const next = { name: cur.name, sort: cur.sort, active: cur.active };
  if (b.name !== undefined) {
    if (typeof b.name !== 'string' || b.name.trim().length < 1 || b.name.trim().length > 60) throw new HttpError(400, 'bad_request', { detail: 'name' });
    next.name = b.name.trim();
  }
  if (b.sort !== undefined) {
    if (!Number.isInteger(b.sort) || b.sort < 0 || b.sort > 1000) throw new HttpError(400, 'bad_request', { detail: 'sort' });
    next.sort = b.sort;
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') throw new HttpError(400, 'bad_request', { detail: 'active' });
    next.active = b.active;
  }
  try {
    await safely(db, (x) => x.query('update bl.cashbook_categories set name = $2, sort = $3, active = $4, updated_at = $5 where id = $1 and club_id = $6', [categoryId, next.name, next.sort, next.active, now, clubId]));
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'duplicate');
    throw err;
  }
  await appendAudit(db, {
    action: 'cashbook.category_update',
    objectType: 'cashbook_category',
    objectId: categoryId,
    actorType: 'user',
    actorId: userId,
    data: { category_id: categoryId, before: { name: cur.name, sort: cur.sort, active: cur.active }, after: next },
  });
  return { category_id: categoryId, kind: cur.kind, ...next };
}

/** Начало и конец периода в UTC (для подписей). */
export function periodBounds(club, from, to) {
  return { from: dayBounds(from, club.timezone, club.day_start_local).from, to: dayBounds(to, club.timezone, club.day_start_local).to };
}
