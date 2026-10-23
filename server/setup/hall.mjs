// Зал клуба: столы и план (M5.1 №155, backend-B). Владелец и управляющий.
//
//   GET   /api/clubs/{club}/resources        → { plan, resources } — все столы, и выведенные
//   POST  /api/clubs/{club}/resources        {number, kind, title?, plan_x?, plan_y?, plan_rotation?, reason?}
//   PATCH /api/clubs/{club}/resources/{id}   {number?, kind?, title?, plan_x?, plan_y?, plan_rotation?, active?, reason?}
//   PUT   /api/clubs/{club}/hall             {width, height} — размер зала в сантиметрах
//
// * Код стола (QR, №47) — по умолчанию базы bl.gen_resource_code(); наружу — только персоналу.
// * Удаления нет: стол с историей только выводится из работы (active = false). Нельзя вывести стол
//   с идущей игрой, удержанием, бронью впереди или турниром — 409 table_busy {reason, resource_id}.
// * Режим клуба test — журнал resource.*; live — добавление и вывод (и возврат в работу) стола —
//   ручное действие manual.resource_add / manual.resource_remove: причина, журнал, тревога владельцу.
//   Смена типа стола в live (№164) — тоже ручное действие manual.resource_kind: при тарифах по типам
//   столов она меняет цену стола. Позиция, номер и название — только журнал resource.update;
//   размер зала — hall.update.

import { HttpError } from '../http/errors.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { cleanReason, clubMode, isLive, manualAction } from './mode.mjs';

export const KINDS = Object.freeze({ pyramid: 'billiard_pyramid', pool: 'billiard_pool', snooker: 'billiard_snooker', mixed: 'billiard_mixed' });
export const KIND_OF_TYPE = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k])));
/** Предел координат плана и размера зала: 1 км в сантиметрах. */
export const PLAN_MAX_CM = 100_000;
export const HALL_MIN_CM = 100;
export const MAX_TABLES = 200;

const bad = (detail) => new HttpError(400, 'bad_request', { detail });
/** Тип стола в тексте уведомления владельцу. */
const KIND_LABEL = Object.freeze({ pyramid: 'пирамида', pool: 'пул', snooker: 'снукер', mixed: 'смешанный' });
const iso = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function resourceJson(r) {
  return {
    id: r.id,
    number: r.number,
    kind: KIND_OF_TYPE[r.type] ?? null,
    type: r.type,
    title: r.title,
    code: r.code ?? null,
    plan_x: r.plan_x,
    plan_y: r.plan_y,
    plan_rotation: r.plan_rotation,
    active: r.active,
    sticker_printed_at: iso(r.sticker_printed_at),
    created_at: iso(r.created_at),
  };
}

function planJson(settings) {
  const p = settings?.plan;
  return p && typeof p === 'object'
    ? { width_cm: Number.isInteger(p.width_cm) ? p.width_cm : null, height_cm: Number.isInteger(p.height_cm) ? p.height_cm : null }
    : { width_cm: null, height_cm: null };
}

/** Поля стола из тела запроса (частично при patch). */
function readFields(body, { partial }) {
  const b = body ?? {};
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('number')) {
    if (!intIn(b.number, 1, 9999)) throw bad('number');
    out.number = b.number;
  }
  if (!partial || has('kind')) {
    if (!(typeof b.kind === 'string' && b.kind in KINDS)) throw bad('kind');
    out.type = KINDS[b.kind];
  }
  if (has('title') && b.title !== null) {
    if (typeof b.title !== 'string') throw bad('title');
    const t = b.title.trim().replace(/\s+/g, ' ');
    if (t.length < 1 || t.length > 100) throw bad('title');
    out.title = t;
  }
  for (const k of ['plan_x', 'plan_y']) {
    if (has(k)) {
      if (!intIn(b[k], 0, PLAN_MAX_CM)) throw bad(k);
      out[k] = b[k];
    }
  }
  if (has('plan_rotation')) {
    if (!intIn(b.plan_rotation, 0, 359)) throw bad('plan_rotation');
    out.plan_rotation = b.plan_rotation;
  }
  if (has('active')) {
    if (typeof b.active !== 'boolean') throw bad('active');
    out.active = b.active;
  }
  return out;
}

function uniqueNumber(err) {
  if (err?.code === '23505') return new HttpError(409, 'duplicate', { detail: 'number' });
  if (err?.code === '23514') return bad('check');
  return err;
}

/** Выполнить запрос в savepoint: нарушение уникальности номера не обрывает транзакцию запроса. */
async function guarded(db, fn) {
  await db.query('savepoint setup_hall');
  try {
    const r = await fn();
    await db.query('release savepoint setup_hall');
    return r;
  } catch (err) {
    await db.query('rollback to savepoint setup_hall');
    throw uniqueNumber(err);
  }
}

/** Все столы клуба (и выведенные) и размер зала. */
export async function listResources(db, { clubId }) {
  const club = await db.query('select settings from bl.clubs where id = $1', [clubId]);
  if (club.rowCount === 0) throw new HttpError(404, 'not_found');
  const { rows } = await db.query(
    `select id, number, type, title, code, plan_x, plan_y, plan_rotation, active, sticker_printed_at, created_at
       from bl.resources where club_id = $1 order by active desc, number`,
    [clubId],
  );
  return { plan: planJson(club.rows[0].settings), resources: rows.map(resourceJson) };
}

/**
 * Почему стол нельзя вывести из работы: идёт игра, удержание (оплата, бронь у стола, сервисный свет),
 * бронь впереди, турнир. null — можно.
 */
export async function busyReason(db, resourceId, now) {
  const s = await db.query(
    "select 1 from bl.sessions where resource_id = $1 and status in ('active', 'ending', 'grace', 'interrupted') limit 1",
    [resourceId],
  );
  if (s.rowCount) return 'session';
  const h = await db.query('select kind from bl.resource_holds where resource_id = $1 and released_at is null and until > $2 limit 1', [resourceId, now]);
  if (h.rowCount) return h.rows[0].kind === 'service' ? 'service' : h.rows[0].kind === 'reserved' ? 'reserved' : 'pending';
  const b = await db.query(
    "select 1 from bl.bookings where resource_id = $1 and status in ('pending_payment', 'confirmed', 'reserved', 'started') and ends_at > $2 limit 1",
    [resourceId, now],
  );
  if (b.rowCount) return 'booking';
  const t = await db.query(
    `select 1 from bl.tournament_resources tr join bl.tournaments t on t.id = tr.tournament_id
      where tr.resource_id = $1 and t.status in ('draft', 'registration', 'closed', 'running') and t.ends_at > $2 limit 1`,
    [resourceId, now],
  );
  if (t.rowCount) return 'tournament';
  return null;
}

/** Число столов в работе (чек-лист №160 п. 1). db — в контексте клуба. */
export async function activeCount(db, clubId) {
  const { rows } = await db.query('select count(*)::int as n from bl.resources where club_id = $1 and active', [clubId]);
  return rows[0].n;
}

/**
 * POST …/resources.
 * @param {{ clubId: string, userId: string, body: object, now: Date, ctx?: object, log?: object }} p
 */
export async function createResource(db, { clubId, userId, body, now, ctx = null, log }) {
  const f = readFields(body, { partial: false });
  if ((body ?? {}).active !== undefined) throw bad('active');
  const mode = await clubMode(db, clubId, ctx);
  const reason = isLive(mode) ? cleanReason(body?.reason) : null;
  const count = (await db.query('select count(*)::int as n from bl.resources where club_id = $1', [clubId])).rows[0].n;
  if (count >= MAX_TABLES) throw new HttpError(409, 'limit_exceeded', { detail: 'tables' });
  const row = await guarded(db, async () =>
    (
      await db.query(
        `insert into bl.resources (club_id, type, number, title, plan_x, plan_y, plan_rotation, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning id, number, type, title, code, plan_x, plan_y, plan_rotation, active, sticker_printed_at, created_at`,
        [clubId, f.type, f.number, f.title ?? `Стол ${f.number}`, f.plan_x ?? 0, f.plan_y ?? 0, f.plan_rotation ?? 0, now],
      )
    ).rows[0],
  );
  const data = { resource_id: row.id, number: row.number, kind: KIND_OF_TYPE[row.type], plan_x: row.plan_x, plan_y: row.plan_y, plan_rotation: row.plan_rotation, mode };
  if (isLive(mode)) {
    await manualAction(db, {
      clubId,
      userId,
      action: 'manual.resource_add',
      reason,
      objectType: 'resource',
      objectId: row.id,
      resourceId: row.id,
      data,
      text: `Добавлен стол ${row.number}`,
      log,
      ctx,
    });
  } else {
    await appendAudit(db, { action: 'resource.create', objectType: 'resource', objectId: row.id, actorType: 'user', actorId: userId, data });
  }
  return resourceJson(row);
}

/** PATCH …/resources/{id}. */
export async function updateResource(db, { clubId, userId, resourceId, body, now, ctx = null, log }) {
  const f = readFields(body, { partial: true });
  if (Object.keys(f).length === 0) throw bad('nothing to change');
  const cur = (
    await db.query(
      `select id, club_id, number, type, title, code, plan_x, plan_y, plan_rotation, active, sticker_printed_at, created_at
         from bl.resources where id = $1 for update`,
      [resourceId],
    )
  ).rows[0];
  if (!cur || cur.club_id !== clubId) throw new HttpError(404, 'not_found');
  const mode = await clubMode(db, clubId, ctx);
  const live = isLive(mode);
  const activeChange = f.active !== undefined && f.active !== cur.active;
  // №164: смена типа стола в live меняет его тариф (правила по типам) — ручное действие.
  const kindChange = f.type !== undefined && f.type !== cur.type;
  const reason = (activeChange || kindChange) && live ? cleanReason(body?.reason) : null;
  if (activeChange && f.active === false) {
    const why = await busyReason(db, cur.id, now);
    if (why) throw new HttpError(409, 'table_busy', { detail: `deactivate: ${why}`, data: { reason: why, resource_id: cur.id } });
  }
  const next = { ...cur, ...f };
  const changed = {};
  for (const k of ['number', 'type', 'title', 'plan_x', 'plan_y', 'plan_rotation', 'active']) if (next[k] !== cur[k]) changed[k] = { from: cur[k], to: next[k] };
  if (Object.keys(changed).length === 0) return resourceJson(cur);
  const row = await guarded(db, async () =>
    (
      await db.query(
        `update bl.resources set number = $2, type = $3, title = $4, plan_x = $5, plan_y = $6, plan_rotation = $7, active = $8
          where id = $1
          returning id, number, type, title, code, plan_x, plan_y, plan_rotation, active, sticker_printed_at, created_at`,
        [cur.id, next.number, next.type, next.title, next.plan_x, next.plan_y, next.plan_rotation, next.active],
      )
    ).rows[0],
  );
  // Тип в журнале — кодом мастера (pyramid, pool…), а не столбцом базы.
  if (changed.type) changed.kind = { from: KIND_OF_TYPE[changed.type.from], to: KIND_OF_TYPE[changed.type.to] };
  delete changed.type;
  const data = { resource_id: row.id, number: row.number, changed, mode };
  const manual = [];
  if (live && kindChange) {
    const { from, to } = changed.kind;
    manual.push({ action: 'manual.resource_kind', text: `Стол ${row.number}: тип изменён — ${KIND_LABEL[from] ?? from} → ${KIND_LABEL[to] ?? to}` });
  }
  if (live && activeChange) {
    manual.push({
      action: f.active ? 'manual.resource_add' : 'manual.resource_remove',
      text: f.active ? `Стол ${row.number} возвращён в работу` : `Стол ${row.number} выведен из работы`,
    });
  }
  if (manual.length > 0) {
    for (const m of manual) {
      await manualAction(db, { clubId, userId, action: m.action, reason, objectType: 'resource', objectId: row.id, resourceId: row.id, data, text: m.text, log, ctx });
    }
  } else {
    const action = activeChange ? (f.active ? 'resource.activate' : 'resource.deactivate') : 'resource.update';
    await appendAudit(db, { action, objectType: 'resource', objectId: row.id, actorType: 'user', actorId: userId, data });
  }
  return resourceJson(row);
}

/** PUT …/hall {width, height} (или width_cm, height_cm) — сантиметры. */
export async function setHallSize(db, { clubId, userId, body }) {
  const b = body ?? {};
  const width = b.width ?? b.width_cm;
  const height = b.height ?? b.height_cm;
  if (!intIn(width, HALL_MIN_CM, PLAN_MAX_CM)) throw bad('width');
  if (!intIn(height, HALL_MIN_CM, PLAN_MAX_CM)) throw bad('height');
  const cur = await db.query('select settings from bl.clubs where id = $1 for update', [clubId]);
  if (cur.rowCount === 0) throw new HttpError(404, 'not_found');
  const before = planJson(cur.rows[0].settings);
  await db.query(
    `update bl.clubs set settings = jsonb_set(settings, '{plan}', coalesce(settings->'plan', '{}'::jsonb) || jsonb_build_object('width_cm', $2::int, 'height_cm', $3::int))
      where id = $1`,
    [clubId, width, height],
  );
  const plan = { width_cm: width, height_cm: height };
  if (before.width_cm !== width || before.height_cm !== height) {
    await appendAudit(db, { action: 'hall.update', objectType: 'club', objectId: clubId, actorType: 'user', actorId: userId, data: { before, after: plan } });
  }
  return { plan };
}
