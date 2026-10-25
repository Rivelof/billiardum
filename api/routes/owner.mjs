// Маршруты владельца и управляющего (контракт M1 §7): «Сейчас», журнал с фильтрами
// и проверкой цепочки, тревоги, подписка Web Push, QR-наклейки.

import { ack, alarmJson } from '../../server/alarms/index.mjs';
import { HttpError } from '../../server/http/errors.mjs';
import { endpointAllowed } from '../../server/notify/webpush.mjs';
import { printStickers } from '../../server/setup/stickers.mjs';
import { isUuid } from '../../server/lib/store.mjs';

const OWNER = ['owner'];
const MANAGER_UP = ['owner', 'manager'];
const PAGE = 50;
const MAX_PAGE = 200;
const METHODS = ['sbp', 'card', 'cash', 'card_terminal'];

function iso(v) {
  return v instanceof Date ? v.toISOString() : v;
}

function parseTime(value) {
  if (value === undefined) return null;
  const d = new Date(value);
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_request');
  return d;
}

/** Начало рабочих суток клуба (decisions №43: day_start_local, по умолчанию 06:00) для момента now. */
export async function workingDayStart(db, clubId, now) {
  const { rows } = await db.query(
    `with c as (
       select timezone,
              coalesce(nullif(settings->>'day_start_local', ''), '06:00')::time as day_start
         from bl.clubs where id = $1
     ), l as (
       select timezone, day_start, ($2::timestamptz at time zone timezone) as local_now from c
     )
     select (case when local_now::time >= day_start then local_now::date else local_now::date - 1 end + day_start)
              at time zone timezone as start, timezone
       from l`,
    [clubId, now],
  );
  return rows[0] ?? null;
}

/** Зал: сервис модуля light (тот же, что у GET /api/clubs/{club}/hall) или столы без состояния. */
async function hall(ctx) {
  const service = ctx.modules?.light?.light?.()?.service;
  if (typeof service?.hall === 'function') return service.hall(ctx.db, { clubId: ctx.club, userId: ctx.user.id });
  const { rows } = await ctx.db.query('select id, number, type, title from bl.resources where active order by bl.resource_family(type) desc, number');
  return rows.map((r) => ({ resource: { id: r.id, number: r.number, type: r.type, title: r.title }, status: 'unknown', session: null }));
}

async function now(ctx) {
  const day = await workingDayStart(ctx.db, ctx.club, ctx.clock.now());
  const revenue = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const hasPayments = (await ctx.db.query("select to_regclass('bl.payments') is not null as ok")).rows[0].ok;
  if (hasPayments && day) {
    const { rows } = await ctx.db.query(
      `select method, coalesce(sum(coalesce(captured_kopecks, amount_kopecks)), 0)::bigint as total
         from bl.payments
        where status = 'succeeded' and confirmed_at >= $1 and confirmed_at < $2 and not is_test
        group by method`,
      [day.start, ctx.clock.now()],
    );
    for (const r of rows) if (r.method in revenue) revenue[r.method] = Number(r.total);
  }
  const alarms = await ctx.db.query(
    `select a.*, r.number as resource_number, r.type as resource_type from bl.alarms a left join bl.resources r on r.id = a.resource_id
      where a.state = 'open' order by case a.level when 'critical' then 0 when 'important' then 1 else 2 end, a.last_raised_at desc limit 50`,
  );
  return {
    status: 200,
    json: {
      hall: await hall(ctx),
      revenue_today_kopecks: revenue,
      day_started_at: day ? iso(day.start) : null,
      alarms_open: alarms.rows.map(alarmJson),
    },
  };
}

const ACTION_ITEM = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*|\*)?$/;

/**
 * Фильтр action (§14): список через запятую, «*» в конце — префикс: service.*,manual.*,payment.refunded.
 * Возвращает { exact: [], prefixes: [] } (префиксы — шаблоны LIKE).
 */
export function parseActionFilter(text) {
  if (text === undefined) return null;
  if (typeof text !== 'string' || text.length > 500) throw new HttpError(400, 'bad_request');
  const items = text.split(',').map((x) => x.trim()).filter(Boolean);
  if (items.length === 0 || items.length > 20) throw new HttpError(400, 'bad_request');
  const exact = [];
  const prefixes = [];
  for (const item of items) {
    if (!ACTION_ITEM.test(item) || item.length > 100) throw new HttpError(400, 'bad_request');
    if (item.endsWith('*')) prefixes.push(`${item.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`);
    else exact.push(item);
  }
  return { exact, prefixes };
}

async function audit(ctx, req) {
  const q = req.query;
  const from = parseTime(q.from);
  const to = parseTime(q.to);
  if (q.actor !== undefined && !isUuid(q.actor)) throw new HttpError(400, 'bad_request');
  if (q.resource !== undefined && !isUuid(q.resource)) throw new HttpError(400, 'bad_request');
  const actions = parseActionFilter(q.action);
  let cursor = null;
  if (q.cursor !== undefined) {
    if (!/^[1-9][0-9]{0,15}$/.test(q.cursor)) throw new HttpError(400, 'bad_request');
    cursor = Number(q.cursor);
  }
  let limit = PAGE;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, 'bad_request');
  }
  // Стол записи: объект-ресурс, data.resource_id или стол устройства (команды контроллеру).
  // Имя исполнителя — только у участников клуба (гостей журнал не называет).
  const { rows } = await ctx.db.query(
    `select a.seq, a.created_at, a.actor_type, a.actor_id, a.action, a.object_type, a.object_id, a.reason, a.data, a.hash,
            m.role as actor_role, u.name as actor_name, r.id as resource_id, r.number as resource_number
       from bl.audit_log a
       left join bl.club_members m on m.club_id = a.club_id and m.user_id = a.actor_id
       left join bl.users u on u.id = m.user_id
       left join bl.devices d on a.object_type = 'device' and d.id = a.object_id
       left join bl.resources r on r.id = coalesce(
              case when a.object_type = 'resource' then a.object_id end,
              case when a.data->>'resource_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (a.data->>'resource_id')::uuid end,
              d.resource_id)
      where a.club_id = $1
        and ($2::bigint is null or a.seq < $2)
        and ($3::timestamptz is null or a.created_at >= $3)
        and ($4::timestamptz is null or a.created_at < $4)
        and ($5::uuid is null or a.actor_id = $5)
        and ($6::boolean or a.action = any($7::text[]) or a.action like any($8::text[]))
        and ($9::uuid is null or r.id = $9)
      order by a.seq desc
      limit $10`,
    [ctx.club, cursor, from, to, q.actor ?? null, actions === null, actions?.exact ?? [], actions?.prefixes ?? [], q.resource ?? null, limit + 1],
  );
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    seq: Number(r.seq),
    created_at: iso(r.created_at),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    actor_name: r.actor_name ?? null,
    actor_role: r.actor_role ?? null,
    action: r.action,
    object_type: r.object_type,
    object_id: r.object_id,
    resource_id: r.resource_id ?? null,
    resource_number: r.resource_number ?? null,
    reason: r.reason,
    data: r.data,
    hash: r.hash,
  }));
  return { status: 200, json: { items, next_cursor: more ? String(items[items.length - 1].seq) : null } };
}

async function auditVerify(ctx) {
  const { rows } = await ctx.db.query('select * from bl.audit_verify($1)', [ctx.club]);
  const r = rows[0];
  return {
    status: 200,
    json: { ok: r.ok, broken_seq: r.first_bad_seq === null ? null : Number(r.first_bad_seq), head_hash: r.head_hash, count: Number(r.checked) },
  };
}

async function alarmsList(ctx, req) {
  const state = req.query.state ?? 'open';
  if (!['open', 'acked', 'all'].includes(state)) throw new HttpError(400, 'bad_request');
  const { rows } = await ctx.db.query(
    `select a.*, r.number as resource_number, r.type as resource_type from bl.alarms a left join bl.resources r on r.id = a.resource_id
      where ($1::text = 'all' or a.state = $1)
      order by a.last_raised_at desc limit 200`,
    [state],
  );
  return { status: 200, json: rows.map(alarmJson) };
}

// Клуб тревоги: из запроса (X-Club-Id), единственный клуб пользователя или поиск по клубам,
// где пользователь владелец или управляющий (findClub; RLS — в каждом только свои тревоги).
async function alarmInClub(db, req) {
  return (await db.query('select 1 from bl.alarms where id = $1', [req.params.id])).rowCount > 0;
}

async function alarmAck(ctx, req) {
  const json = await ack(ctx.db, req.params.id, ctx.user.id);
  if (json) return { status: 200, json: { ok: true, alarm: json } };
  // Уже подтверждена — тот же ответ (повтор нажатия); чужая или нет — 404.
  if (await alarmInClub(ctx.db, req)) return { status: 200, json: { ok: true } };
  throw new HttpError(404, 'not_found');
}

async function pushSubscribe(ctx, req) {
  const { endpoint, keys } = req.body;
  if (typeof endpoint !== 'string' || endpoint.length > 1000 || !endpointAllowed(endpoint, ctx.config.pushHosts)) throw new HttpError(400, 'bad_request');
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(p256dh)) throw new HttpError(400, 'bad_request');
  if (typeof auth !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth)) throw new HttpError(400, 'bad_request');
  const point = Buffer.from(p256dh, 'base64url');
  if (point.length !== 65 || point[0] !== 4) throw new HttpError(400, 'bad_request');
  await ctx.useClub(null);
  const now = ctx.clock.now();
  await ctx.db.query(
    `insert into bl.push_subscriptions (user_id, endpoint, p256dh, auth, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $5)
     on conflict (user_id, endpoint) do update
       set p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at, revoked_at = null, failed_count = 0`,
    [ctx.user.id, endpoint, p256dh, auth, now],
  );
  return { status: 200, json: { ok: true } };
}

/** Открытый ключ VAPID для PushManager.subscribe({ applicationServerKey }). */
async function vapidKey(ctx) {
  const key = ctx.notify?.vapidPublicKey ?? null;
  if (!key) throw new HttpError(501, 'not_configured');
  return { status: 200, json: { public_key: key } };
}

/**
 * QR-наклейки столов: все столы в работе или выбранные (?resources=id,id, M5.1 №159);
 * выгрузка отмечается (resources.sticker_printed_at, журнал qr.stickers_printed) — server/setup/stickers.mjs.
 */
async function qrStickers(ctx, req) {
  const pdf = await printStickers(ctx.db, {
    clubId: req.params.club,
    userId: ctx.user?.id ?? null,
    publicHost: ctx.config.publicHost,
    resources: req.query.resources,
    now: ctx.clock.now(),
  });
  return {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': 'attachment; filename="qr-stickers.pdf"',
    },
    body: pdf,
  };
}

/** Код стола: ровно 10 символов Crockford Base32 (decisions №47), без I, L, O, U. */
export const TABLE_CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * Короткая ссылка с QR-наклейки (decisions №72): GET /t/{code} → 302 /app/t/{CODE}.
 * Адрес перенаправления собирается только из проверенного кода (никаких параметров запроса,
 * Host или Referer): открытого перенаправления нет. Иначе — 404.
 */
async function shortLink(_ctx, req) {
  const code = typeof req.params.code === 'string' ? req.params.code.toUpperCase() : '';
  if (!TABLE_CODE.test(code)) throw new HttpError(404, 'not_found');
  return { status: 302, headers: { location: `/app/t/${code}` } };
}

/** GET /api/clubs — публичный список активных клубов (№120): без входа и без персональных данных. */
async function publicClubs(ctx) {
  const { rows } = await ctx.db.query('select * from bl.public_clubs()');
  return {
    status: 200,
    headers: { 'cache-control': 'public, max-age=60' },
    json: rows.map((r) => ({ id: r.id, name: r.name, city: r.city, address: r.address, timezone: r.timezone, plan: r.plan })),
  };
}

export const routes = [
  { method: 'GET', path: '/api/clubs', auth: 'none', rateLimit: { max: 120, windowMs: 60_000 }, handler: publicClubs },
  { method: 'GET', path: '/t/{code}', auth: 'none', db: false, rateLimit: { max: 120, windowMs: 60_000 }, handler: shortLink },
  { method: 'GET', path: '/api/clubs/{club}/now', auth: 'staff', roles: MANAGER_UP, handler: now },
  { method: 'GET', path: '/api/clubs/{club}/audit', auth: 'staff', roles: MANAGER_UP, handler: audit },
  { method: 'GET', path: '/api/clubs/{club}/audit/verify', auth: 'staff', roles: OWNER, rateLimit: { max: 10, windowMs: 60_000 }, handler: auditVerify },
  { method: 'GET', path: '/api/clubs/{club}/alarms', auth: 'staff', roles: MANAGER_UP, handler: alarmsList },
  { method: 'POST', path: '/api/alarms/{id}/ack', auth: 'staff', roles: MANAGER_UP, findClub: alarmInClub, handler: alarmAck },
  { method: 'POST', path: '/api/push/subscribe', auth: 'guest', rateLimit: { max: 30, windowMs: 60_000 }, handler: pushSubscribe },
  { method: 'GET', path: '/api/push/vapid-public-key', auth: 'none', handler: vapidKey },
  { method: 'GET', path: '/api/clubs/{club}/qr-stickers.pdf', auth: 'staff', roles: MANAGER_UP, rateLimit: { max: 10, windowMs: 60_000 }, handler: qrStickers },
];
