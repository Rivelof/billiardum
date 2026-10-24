// Обслуживание столов (M5.6, docs/contracts/m5-5-8.md №198).
//
// * Событие — стол, вид (KINDS), рабочие сутки события, комментарий, стоимость в копейках, кто.
//   Только добавление (триггер базы): исправление — новое событие с corrects_id и причиной
//   (одно на событие, 409 duplicate при повторе), void: true — «события не было».
// * Стоимость > 0 — расход в кассу управляющего по статье «Ремонт столов» (создаётся, если её нет)
//   со ссылкой на событие (cashbook_entries.maintenance_event_id), дата записи — сутки события
//   (правила кассы №189: не старше 35 суток, задним числом — уведомление владельцу). Исправление
//   сторнирует расход исправляемого события и вносит новый.
// * Счётчик — часы игры на столе с последнего действующего события вида: закрытые сутки — из
//   bl.stats_hourly, текущие и недосчитанные — по сессиям (та же формула, что у суток дашборда:
//   фактические минуты, без cancelled и is_test). Событие, отмеченное в свои же сутки, считается с
//   момента отметки; отмеченное задним числом — с начала следующих суток; без событий — с начала учёта.
// * Пороги по виду — clubs.settings.maintenance_thresholds (часы; null — без порога), по умолчанию
//   DEFAULT_THRESHOLDS. Порог достигнут — уведомление (не тревога) управляющему и владельцу, одно на
//   (стол, вид, событие, порог): bl.maintenance_alerts.
// Журнал: maintenance.event, maintenance.correct (с причиной), maintenance.thresholds_update,
// maintenance.threshold_reached (система); расходы — cashbook.entry, cashbook.storno.

import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { isUuid, safely } from '../lib/store.mjs';
import { maskPhones, sendToClubStaff } from '../notify/index.mjs';
import { addEntry, ensureCategories, MAX_BACKDATE_DAYS, stornoEntry } from '../dashboard/cashbook.mjs';
import { firstDayOf } from '../dashboard/store.mjs';
import { addDays, dayBounds, isDay, workingDayOf } from '../dashboard/time.mjs';

export const KINDS = ['cloth', 'balls', 'cushions', 'leveling', 'other'];
export const KIND_LABELS = Object.freeze({ cloth: 'Замена сукна', balls: 'Замена шаров', cushions: 'Замена резины бортов', leveling: 'Выравнивание', other: 'Другое' });
/** Пороги по умолчанию, часы игры (№198); null — без порога. */
export const DEFAULT_THRESHOLDS = Object.freeze({ cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null });
export const MAX_THRESHOLD_HOURS = 100_000;
/** Дата события — не раньше чем столько суток назад (без стоимости). */
export const MAX_EVENT_BACKDATE_DAYS = 366;
export const CATEGORY_NAME = 'Ремонт столов';
const MAX_COST = 100_000_000_000;
const EVENTS_LIMIT = 200;
const MINUTE = 60_000;

const r1 = (x) => Math.round(x * 10) / 10;
const iso = (d) => (d ? new Date(d).toISOString() : null);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

/** Пороги клуба из settings (неверные значения — по умолчанию). */
export function thresholdsOf(settings) {
  const raw = settings && typeof settings === 'object' && settings.maintenance_thresholds && typeof settings.maintenance_thresholds === 'object' ? settings.maintenance_thresholds : {};
  const out = {};
  for (const k of KINDS) {
    const v = raw[k];
    if (v === null) out[k] = null;
    else if (Number.isInteger(v) && v >= 1 && v <= MAX_THRESHOLD_HOURS) out[k] = v;
    else out[k] = DEFAULT_THRESHOLDS[k];
  }
  return out;
}

/** Момент, с которого считаются часы после события (мс). */
export function eventMoment(ev, club) {
  const recordedDay = workingDayOf(new Date(ev.created_at), club.timezone, club.day_start_local);
  if (recordedDay === ev.day) return new Date(ev.created_at).getTime();
  return dayBounds(addDays(ev.day, 1), club.timezone, club.day_start_local).from.getTime();
}

/**
 * Отрезки подсчёта по сессиям и первые сутки подсчёта по агрегатам для момента t0 (мс, null — с начала
 * учёта): { statsFrom: 'YYYY-MM-DD', intervals: [{lo, hi}] }. stored — Set закрытых суток с агрегатом.
 * Сутки ≥ statsFrom с агрегатом — из bl.stats_hourly, остальные (и сутки самого t0) — по сессиям.
 */
export function countPlan(club, t0, { stored, now, firstDay }) {
  const tz = club.timezone;
  const ds = club.day_start_local;
  const today = workingDayOf(now, tz, ds);
  const nowMs = now.getTime();
  const intervals = [];
  let startDay;
  if (t0 === null) {
    startDay = firstDay;
  } else {
    const d0 = workingDayOf(new Date(t0), tz, ds);
    const b = dayBounds(d0, tz, ds);
    if (t0 > b.from.getTime()) {
      // Сутки события — с момента отметки, по сессиям.
      intervals.push({ lo: t0, hi: Math.min(b.to.getTime(), nowMs) });
      startDay = addDays(d0, 1);
    } else {
      startDay = d0;
    }
  }
  for (let d = startDay; d <= today; d = addDays(d, 1)) {
    if (d < today && stored.has(d)) continue;
    const b = dayBounds(d, tz, ds);
    const lo = b.from.getTime();
    const hi = Math.min(b.to.getTime(), nowMs);
    if (hi <= lo) continue;
    const last = intervals.at(-1);
    if (last && last.hi === lo) last.hi = hi;
    else intervals.push({ lo, hi });
  }
  return { statsFrom: startDay, intervals: intervals.filter((x) => x.hi > x.lo) };
}

/** Действующие события: последнее по (стол, вид) без исправления и не «события не было». */
async function lastEvents(db, clubId) {
  const { rows } = await db.query(
    `select distinct on (e.resource_id, e.kind) e.id, e.resource_id, e.kind, e.occurred_on::text as day, e.created_at
       from bl.maintenance_events e
      where e.club_id = $1 and not e.voided
        and not exists (select 1 from bl.maintenance_events c where c.club_id = e.club_id and c.corrects_id = e.id)
      order by e.resource_id, e.kind, e.occurred_on desc, e.created_at desc`,
    [clubId],
  );
  return rows;
}

/**
 * Счётчики клуба (в контексте клуба): [{ resource_id, number, title, type, active, kinds: { [kind]:
 * { hours, minutes, since, event_id, threshold_hours, due } } }]. kinds — только виды из list.
 */
export async function counters(db, club, { now, kinds = KINDS }) {
  const res = await db.query('select id, number, title, type, active, created_at from bl.resources where club_id = $1 order by number', [club.id]);
  if (res.rows.length === 0) return [];
  const events = await lastEvents(db, club.id);
  const evBy = new Map(events.map((e) => [`${e.resource_id}|${e.kind}`, e]));
  const stored = new Set((await db.query('select day::text as day from bl.stats_daily where club_id = $1', [club.id])).rows.map((r) => r.day));
  const firstDay = firstDayOf(club);
  const thresholds = thresholdsOf(club.settings);
  // Задания подсчёта: одно на (стол, момент начала).
  const jobs = new Map();
  const pairs = [];
  for (const r of res.rows) {
    for (const k of kinds) {
      const ev = evBy.get(`${r.id}|${k}`) ?? null;
      const t0 = ev ? eventMoment(ev, club) : null;
      const key = `${r.id}|${t0 ?? ''}`;
      if (!jobs.has(key)) jobs.set(key, { idx: jobs.size, resource_id: r.id, t0, minutes: 0, ms: 0 });
      pairs.push({ r, k, ev, job: jobs.get(key) });
    }
  }
  const list = [...jobs.values()];
  const sIdx = [];
  const sRes = [];
  const sFrom = [];
  const iIdx = [];
  const iRes = [];
  const iLo = [];
  const iHi = [];
  for (const j of list) {
    const p = countPlan(club, j.t0, { stored, now, firstDay });
    sIdx.push(j.idx);
    sRes.push(j.resource_id);
    sFrom.push(p.statsFrom);
    for (const x of p.intervals) {
      iIdx.push(j.idx);
      iRes.push(j.resource_id);
      iLo.push(new Date(x.lo));
      iHi.push(new Date(x.hi));
    }
  }
  const st = await db.query(
    `select x.idx, coalesce(sum(h.play_minutes), 0)::bigint as minutes
       from unnest($2::int[], $3::uuid[], $4::date[]) as x(idx, rid, d)
       left join bl.stats_hourly h on h.club_id = $1 and h.resource_id = x.rid and h.day >= x.d
      group by x.idx`,
    [club.id, sIdx, sRes, sFrom],
  );
  for (const r of st.rows) list[r.idx].minutes += Number(r.minutes);
  if (iIdx.length) {
    const ss = await db.query(
      `select x.idx, coalesce(sum(extract(epoch from (least(coalesce(s.ended_at, s.interrupted_at, $6), $6, x.hi) - greatest(s.started_at, x.lo)))), 0)::float8 as sec
         from unnest($2::int[], $3::uuid[], $4::timestamptz[], $5::timestamptz[]) as x(idx, rid, lo, hi)
         join bl.sessions s on s.club_id = $1 and s.resource_id = x.rid and s.started_at < x.hi
                           and coalesce(s.ended_at, s.interrupted_at, $6) > x.lo and s.status <> 'cancelled' and not s.is_test
        where least(coalesce(s.ended_at, s.interrupted_at, $6), $6, x.hi) > greatest(s.started_at, x.lo)
        group by x.idx`,
      [club.id, iIdx, iRes, iLo, iHi, now],
    );
    for (const r of ss.rows) list[r.idx].ms += Number(r.sec) * 1000;
  }
  const out = new Map();
  for (const { r, k, ev, job } of pairs) {
    let row = out.get(r.id);
    if (!row) {
      row = { resource_id: r.id, number: r.number, title: r.title, type: r.type, active: r.active, kinds: {} };
      out.set(r.id, row);
    }
    const minutes = job.minutes + Math.round(job.ms / MINUTE);
    const hours = r1(minutes / 60);
    const t = thresholds[k];
    row.kinds[k] = { hours, minutes, since: ev?.day ?? null, event_id: ev?.id ?? null, threshold_hours: t, due: t !== null && hours >= t };
  }
  return [...out.values()];
}

function eventJson(e, names) {
  return {
    event_id: e.id,
    resource_id: e.resource_id,
    resource_number: e.resource_number ?? null,
    kind: e.kind,
    date: e.day,
    comment: e.comment ? maskPhones(e.comment) : null,
    cost_kopecks: Number(e.cost_kopecks),
    corrects_id: e.corrects_id ?? null,
    corrected_by: e.corrected_by ?? null,
    voided: e.voided,
    reason: e.reason ? maskPhones(e.reason) : null,
    cashbook_entry_id: e.cashbook_entry_id ?? null,
    created_by: e.created_by ?? null,
    created_by_name: e.created_by ? names.get(e.created_by) ?? null : null,
    created_at: iso(e.created_at),
  };
}

async function staffNames(db, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Map();
  const { rows } = await db.query('select u.id, u.name from bl.users u where u.id = any($1::uuid[]) and exists (select 1 from bl.club_members m where m.user_id = u.id)', [list]);
  return new Map(rows.map((r) => [r.id, r.name]));
}

const EVENT_SELECT = `select e.*, e.occurred_on::text as day, r.number as resource_number,
       (select c.id from bl.maintenance_events c where c.club_id = e.club_id and c.corrects_id = e.id) as corrected_by,
       (select x.id from bl.cashbook_entries x where x.club_id = e.club_id and x.maintenance_event_id = e.id and x.reverses_id is null) as cashbook_entry_id
  from bl.maintenance_events e join bl.resources r on r.id = e.resource_id and r.club_id = e.club_id`;

/** События клуба, новые сверху: resourceId, kind, limit (до 200). */
export async function listEvents(db, clubId, { resourceId = null, kind = null, limit = 100 } = {}) {
  const { rows } = await db.query(
    `${EVENT_SELECT}
      where e.club_id = $1 and ($2::uuid is null or e.resource_id = $2) and ($3::text is null or e.kind = $3)
      order by e.created_at desc, e.id desc limit $4`,
    [clubId, resourceId, kind, limit],
  );
  const names = await staffNames(db, rows.map((r) => r.created_by));
  return rows.map((e) => eventJson(e, names));
}

/** GET …/maintenance → { thresholds, defaults, kinds, counters, events }. */
export async function maintenanceView(db, club, { query = {}, now }) {
  const resourceId = query.resource_id ?? null;
  if (resourceId !== null && !isUuid(resourceId)) throw new HttpError(400, 'bad_request', { detail: 'resource_id' });
  const kind = query.kind ?? null;
  if (kind !== null && !KINDS.includes(kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  let limit = 100;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EVENTS_LIMIT) throw new HttpError(400, 'bad_request', { detail: 'limit' });
  }
  const all = await counters(db, club, { now });
  return {
    thresholds: thresholdsOf(club.settings),
    defaults: { ...DEFAULT_THRESHOLDS },
    kinds: KINDS.map((k) => ({ kind: k, label: KIND_LABELS[k] })),
    counters: resourceId ? all.filter((c) => c.resource_id === resourceId) : all,
    events: await listEvents(db, club.id, { resourceId, kind, limit }),
  };
}

/** Статья расходов «Ремонт столов»: по имени (без регистра); нет — создаётся. */
async function repairCategory(db, club, userId, now) {
  await ensureCategories(db, club.id, now);
  const found = await db.query(
    `select id from bl.cashbook_categories where club_id = $1 and kind = 'expense' and lower(btrim(name)) = lower($2) limit 1`,
    [club.id, CATEGORY_NAME],
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await db.query(
    `insert into bl.cashbook_categories (club_id, kind, name, sort, created_by, created_at, updated_at) values ($1, 'expense', $2, 50, $3, $4, $4)
     on conflict do nothing returning id`,
    [club.id, CATEGORY_NAME, userId, now],
  );
  if (ins.rows[0]) {
    await appendAudit(db, { action: 'cashbook.category_create', objectType: 'cashbook_category', objectId: ins.rows[0].id, actorType: 'user', actorId: userId, data: { category_id: ins.rows[0].id, kind: 'expense', name: CATEGORY_NAME, source: 'maintenance' } });
    return ins.rows[0].id;
  }
  return (await db.query(`select id from bl.cashbook_categories where club_id = $1 and kind = 'expense' and lower(btrim(name)) = lower($2)`, [club.id, CATEGORY_NAME])).rows[0].id;
}

function resourceName(r) {
  return r.title || `Стол ${r.number}`;
}

/**
 * POST …/maintenance {resource_id, kind, date?, comment?, cost_kopecks?, corrects_id?, reason?, void?}.
 * Исправление (corrects_id): поля по умолчанию — из исправляемого события, причина обязательна.
 */
export async function addEvent(db, { club, userId, body, now }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const today = workingDayOf(now, club.timezone, club.day_start_local);
  let orig = null;
  let reason = null;
  if (b.corrects_id !== undefined && b.corrects_id !== null) {
    if (!isUuid(b.corrects_id)) throw new HttpError(400, 'bad_request', { detail: 'corrects_id' });
    if (typeof b.reason !== 'string' || b.reason.trim() === '') throw new HttpError(400, 'reason_required');
    reason = b.reason.trim();
    if (reason.length > 2000) throw new HttpError(400, 'bad_request', { detail: 'reason' });
    orig = (await db.query('select *, occurred_on::text as day from bl.maintenance_events where id = $1 and club_id = $2', [b.corrects_id, club.id])).rows[0] ?? null;
    if (!orig) throw new HttpError(404, 'not_found');
    const done = await db.query('select 1 from bl.maintenance_events where club_id = $1 and corrects_id = $2', [club.id, orig.id]);
    if (done.rowCount > 0) throw new HttpError(409, 'duplicate');
  } else if (b.reason !== undefined && b.reason !== null) {
    throw new HttpError(400, 'bad_request', { detail: 'reason without corrects_id' });
  }
  const voided = b.void === undefined ? false : b.void;
  if (typeof voided !== 'boolean' || (voided && !orig)) throw new HttpError(400, 'bad_request', { detail: 'void' });

  const resourceId = b.resource_id ?? orig?.resource_id;
  if (!isUuid(resourceId)) throw new HttpError(400, 'bad_request', { detail: 'resource_id' });
  const kind = b.kind ?? orig?.kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'bad_request', { detail: 'kind' });
  const day = b.date ?? orig?.day ?? today;
  if (!isDay(day) || day > today || day < addDays(today, -MAX_EVENT_BACKDATE_DAYS)) throw new HttpError(400, 'bad_request', { detail: 'date' });
  let comment = orig && b.comment === undefined ? orig.comment : null;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string' || b.comment.trim().length > 500) throw new HttpError(400, 'bad_request', { detail: 'comment' });
    comment = b.comment.trim() || null;
  }
  let cost = b.cost_kopecks ?? (orig && !voided ? Number(orig.cost_kopecks) : 0);
  if (!Number.isSafeInteger(cost) || cost < 0 || cost > MAX_COST) throw new HttpError(400, 'bad_request', { detail: 'cost_kopecks' });
  if (voided) {
    if (b.cost_kopecks) throw new HttpError(400, 'bad_request', { detail: 'cost_kopecks' });
    cost = 0;
  }
  // Расход в кассу — по правилам даты кассы (№189).
  if (cost > 0 && day < addDays(today, -MAX_BACKDATE_DAYS)) throw new HttpError(400, 'bad_request', { detail: 'date' });
  const res = (await db.query('select id, number, title from bl.resources where id = $1 and club_id = $2', [resourceId, club.id])).rows[0];
  if (!res) throw new HttpError(404, 'not_found');

  let ins;
  try {
    ins = await safely(db, (x) =>
      x.query(
        `insert into bl.maintenance_events (club_id, resource_id, kind, occurred_on, comment, cost_kopecks, corrects_id, reason, voided, created_by, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [club.id, res.id, kind, day, comment, cost, orig?.id ?? null, reason, voided, userId, now],
      ),
    );
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'duplicate');
    throw err;
  }
  const eventId = ins.rows[0].id;

  // Касса: сторно расхода исправляемого события, новый расход по стоимости.
  let stornoId = null;
  if (orig) {
    const prev = await db.query(
      `select e.id from bl.cashbook_entries e
        where e.club_id = $1 and e.maintenance_event_id = $2 and e.reverses_id is null
          and not exists (select 1 from bl.cashbook_entries r where r.club_id = e.club_id and r.reverses_id = e.id)`,
      [club.id, orig.id],
    );
    if (prev.rows[0]) stornoId = (await stornoEntry(db, { club, userId, entryId: prev.rows[0].id, reason: `Исправление обслуживания: ${reason}`.slice(0, 2000), now })).entry_id;
  }
  let entryId = null;
  if (cost > 0) {
    const categoryId = await repairCategory(db, club, userId, now);
    const text = `${resourceName(res)} — ${KIND_LABELS[kind].toLowerCase()}${comment ? `: ${comment}` : ''}`;
    const entry = await addEntry(db, {
      club,
      userId,
      body: { kind: 'expense', amount_kopecks: cost, category_id: categoryId, date: day, comment: text.length > 500 ? `${text.slice(0, 499)}…` : text },
      now,
      maintenanceEventId: eventId,
    });
    entryId = entry.entry_id;
  }

  await appendAudit(db, {
    action: orig ? 'maintenance.correct' : 'maintenance.event',
    objectType: 'maintenance_event',
    objectId: eventId,
    reason,
    actorType: 'user',
    actorId: userId,
    data: {
      event_id: eventId,
      resource_id: res.id,
      number: res.number,
      kind,
      day,
      cost_kopecks: cost,
      ...(orig ? { corrects_id: orig.id, voided, storno_entry_id: stornoId } : {}),
      cashbook_entry_id: entryId,
    },
  });
  const row = (await db.query(`${EVENT_SELECT} where e.id = $1 and e.club_id = $2`, [eventId, club.id])).rows[0];
  return eventJson(row, await staffNames(db, [row.created_by]));
}

/** PUT …/maintenance/thresholds {cloth?, balls?, cushions?, leveling?, other?} — часы или null. */
export async function setThresholds(db, { club, userId, body }) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!b || Object.keys(b).length === 0) throw new HttpError(400, 'bad_request', { detail: 'body' });
  const before = thresholdsOf(club.settings);
  const after = { ...before };
  for (const [k, v] of Object.entries(b)) {
    if (!KINDS.includes(k)) throw new HttpError(400, 'bad_request', { detail: k });
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= MAX_THRESHOLD_HOURS)) throw new HttpError(400, 'bad_request', { detail: k });
    after[k] = v;
  }
  await db.query(`update bl.clubs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{maintenance_thresholds}', $2::jsonb) where id = $1`, [club.id, JSON.stringify(after)]);
  await appendAudit(db, { action: 'maintenance.thresholds_update', objectType: 'club', objectId: club.id, actorType: 'user', actorId: userId, data: { before, after } });
  return { thresholds: after, defaults: { ...DEFAULT_THRESHOLDS } };
}

/**
 * Проверка порогов клуба (планировщик, контекст клуба, system): достигнутый порог — отметка
 * bl.maintenance_alerts (одна на стол, вид, событие, порог), журнал и уведомление управляющему и владельцу.
 * @returns {Promise<{ notified: { resource_id: string, kind: string, hours: number, threshold_hours: number }[] }>}
 */
export async function checkThresholds(db, club, { now }) {
  const thresholds = thresholdsOf(club.settings);
  const kinds = KINDS.filter((k) => thresholds[k] !== null);
  if (!kinds.length) return { notified: [] };
  const notified = [];
  for (const row of await counters(db, club, { now, kinds })) {
    if (!row.active) continue;
    for (const k of kinds) {
      const c = row.kinds[k];
      if (!c.due) continue;
      const ins = await db.query(
        `insert into bl.maintenance_alerts (club_id, resource_id, kind, event_id, threshold_hours, hours_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7) on conflict on constraint maintenance_alerts_once do nothing returning id`,
        [club.id, row.resource_id, k, c.event_id, c.threshold_hours, c.hours, now],
      );
      if (ins.rowCount === 0) continue;
      const name = resourceName(row);
      const since = c.event_id ? 'с прошлого раза' : 'с начала учёта';
      await appendAudit(db, {
        action: 'maintenance.threshold_reached',
        objectType: 'resource',
        objectId: row.resource_id,
        actorType: 'system',
        actorId: null,
        data: { alert_id: ins.rows[0].id, resource_id: row.resource_id, number: row.number, kind: k, hours: c.hours, threshold_hours: c.threshold_hours, event_id: c.event_id },
      });
      await sendToClubStaff(db, club.id, ['owner', 'manager'], {
        kind: 'maintenance.due',
        level: 'info',
        text: `${name}: пора — ${KIND_LABELS[k].toLowerCase()}. Сыграно ${nf.format(Math.floor(c.hours))} ч ${since}, порог ${nf.format(c.threshold_hours)} ч.`,
        data: { club_id: club.id, resource_id: row.resource_id, kind: k, hours: c.hours, threshold_hours: c.threshold_hours, url: `/club/c/${encodeURIComponent(club.id)}/maintenance` },
      });
      notified.push({ resource_id: row.resource_id, kind: k, hours: c.hours, threshold_hours: c.threshold_hours });
    }
  }
  return { notified };
}
