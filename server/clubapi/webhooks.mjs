// Исходящие вебхуки клуба (M5.7 №201): адреса владельца, события из outbox, журнал доставок.
//
// Событие клуба (outbox: session.started, session.closed → session.ended, booking.created,
// booking.canceled, shift.closed) превращается в тело по белому списку полей — без ПДн гостей
// (ни телефонов, ни имён, ни user_id; вместо id игры — псевдоним game_id) — и ставится в очередь
// bl.webhook_deliveries на каждый включённый адрес клуба с этим событием. Обработчик outbox только
// пишет строки очереди (быстро, в транзакции события); сеть — в воркере вне транзакций (deliver.mjs),
// как у уведомлений (№130): вебхуки не задерживают деньги и свет.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.mjs';
import { decryptSecret, encryptSecret } from '../lib/secrets.mjs';
import { DEFAULT_PORTS, validateWebhookUrl } from './ssrf.mjs';

export const EVENTS = Object.freeze(['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']);
/** Тема outbox → событие вебхука. */
export const TOPIC_EVENT = Object.freeze({
  'session.started': 'session.started',
  'session.closed': 'session.ended',
  'booking.created': 'booking.created',
  'booking.canceled': 'booking.canceled',
  'shift.closed': 'shift.closed',
});
export const MAX_ACTIVE_WEBHOOKS = 10;
export const SECRET_PREFIX = 'whsec_';
const DESCRIPTION_MAX = 200;
const CLOSE_REASONS = new Set(['expired', 'stopped', 'refunded', 'cancelled']);
const CANCELED_BY = new Set(['guest', 'staff']);
const SESSION_SOURCES = new Set(['qr', 'booking', 'reception', 'staff', 'tournament']);
const BOOKING_SOURCES = new Set(['app', 'site', 'phone', 'staff']);
const BOOKING_STATUSES = new Set(['pending_payment', 'confirmed', 'reserved', 'started', 'expired', 'canceled', 'completed']);

const iso = (d) => (d ? new Date(d).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function secretContext(webhookId) {
  return `webhook_secret/${webhookId}`;
}

export function newSecret() {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Расшифровать секрет подписи адреса. */
export function webhookSecret(encKey, webhookId, secretEnc) {
  return decryptSecret(secretEnc, encKey, secretContext(webhookId)).toString('utf8');
}

/** Перец псевдонимов игр (game_id) из ключа шифрования секретов. */
export function gamePepper(encKey) {
  return createHmac('sha256', encKey).update('bl.clubapi-game.v1').digest();
}

/**
 * Псевдоним игры для вебхуков: стабильный для пары «начало — конец» одной игры, но не id сессии
 * (по нему нельзя выйти на плательщика в других API). Вид — UUID (версия 8, RFC 9562).
 */
export function gameId(pepper, clubId, sessionId) {
  const h = createHmac('sha256', pepper).update(`${clubId}:${sessionId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Данные события по белому списку (только поля ниже). null — объекта уже нет (событие не шлётся).
 * @param {import('pg').ClientBase} db транзакция в контексте клуба события
 */
export async function eventData(db, event, payload, { pepper, clubId }) {
  if (event === 'session.started' || event === 'session.ended') {
    if (!UUID.test(String(payload?.session_id))) return null;
    const { rows } = await db.query(
      `select s.id, s.resource_id, r.number, s.source, s.started_at, s.paid_until, s.ended_at, s.close_reason, s.unlimited, s.booking_id
         from bl.sessions s join bl.resources r on r.id = s.resource_id
        where s.id = $1 and s.club_id = $2`,
      [payload.session_id, clubId],
    );
    const s = rows[0];
    if (!s) return null;
    const base = {
      game_id: gameId(pepper, clubId, s.id),
      resource_id: s.resource_id,
      resource_number: s.number,
      source: SESSION_SOURCES.has(s.source) ? s.source : null,
      booking_id: s.booking_id ?? null,
      started_at: iso(s.started_at),
      unlimited: Boolean(s.unlimited),
    };
    if (event === 'session.started') {
      const paidUntil = typeof payload.paid_until === 'string' && !Number.isNaN(Date.parse(payload.paid_until)) ? payload.paid_until : s.paid_until;
      return { ...base, paid_until: iso(paidUntil), resumed: payload.resumed === true };
    }
    const endedAt = typeof payload.ended_at === 'string' && !Number.isNaN(Date.parse(payload.ended_at)) ? payload.ended_at : s.ended_at;
    const reason = CLOSE_REASONS.has(payload.reason) ? payload.reason : CLOSE_REASONS.has(s.close_reason) ? s.close_reason : null;
    const minutes = endedAt && s.started_at ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(s.started_at).getTime()) / 60_000)) : null;
    return { ...base, ended_at: iso(endedAt), reason, played_minutes: minutes };
  }
  if (event === 'booking.created' || event === 'booking.canceled') {
    if (!UUID.test(String(payload?.booking_id))) return null;
    const { rows } = await db.query(
      `select b.id, b.resource_id, r.number, b.starts_at, b.ends_at, b.status, b.source, b.created_at, b.canceled_at
         from bl.bookings b join bl.resources r on r.id = b.resource_id
        where b.id = $1 and b.club_id = $2`,
      [payload.booking_id, clubId],
    );
    const b = rows[0];
    if (!b) return null;
    const out = {
      booking_id: b.id,
      resource_id: b.resource_id,
      resource_number: b.number,
      starts_at: iso(b.starts_at),
      ends_at: iso(b.ends_at),
      status: BOOKING_STATUSES.has(b.status) ? b.status : null,
      source: BOOKING_SOURCES.has(b.source) ? b.source : null,
      created_at: iso(b.created_at),
    };
    if (event === 'booking.canceled') {
      out.canceled_at = iso(b.canceled_at);
      out.canceled_by = CANCELED_BY.has(payload.by) ? payload.by : null;
    }
    return out;
  }
  if (event === 'shift.closed') {
    if (!UUID.test(String(payload?.shift_id))) return null;
    const { rows } = await db.query('select id, number, opened_at, closed_at, discrepancy_kopecks from bl.shifts where id = $1 and club_id = $2', [payload.shift_id, clubId]);
    const s = rows[0];
    if (!s) return null;
    return {
      shift_id: s.id,
      number: s.number,
      opened_at: iso(s.opened_at),
      closed_at: iso(s.closed_at),
      discrepancy_kopecks: s.discrepancy_kopecks === null ? null : Number(s.discrepancy_kopecks),
    };
  }
  return null;
}

/**
 * Обработчик outbox: событие клуба → строки очереди доставки (в транзакции события).
 * @returns {Promise<number>} сколько доставок поставлено
 */
export async function enqueueEvent(db, { topic, payload, clubId, eventId, now, pepper }) {
  const event = TOPIC_EVENT[topic];
  if (!event || !clubId) return 0;
  // Событие старше суток (накопилось до подписки) не шлётся; адрес получает только события,
  // случившиеся после его регистрации (время базы у обоих).
  const { rows: ev } = await db.query("select created_at, created_at < now() - interval '24 hours' as stale from bl.outbox where id = $1", [eventId]);
  if (ev[0]?.stale) return 0;
  const { rows: hooks } = await db.query(
    'select id from bl.webhooks where club_id = $1 and disabled_at is null and $2 = any(events) and ($3::timestamptz is null or created_at <= $3)',
    [clubId, event, ev[0]?.created_at ?? null],
  );
  if (hooks.length === 0) return 0;
  const data = await eventData(db, event, payload, { pepper, clubId });
  if (!data) return 0;
  const { rows: m } = await db.query("select nullif(current_setting('app.club_mode', true), '') as mode");
  const body = { id: randomUUID(), type: event, created_at: iso(now), club_id: clubId, test: m[0]?.mode !== 'live', data };
  let n = 0;
  for (const h of hooks) {
    const ins = await db.query(
      `insert into bl.webhook_deliveries (club_id, webhook_id, event_id, event, source, payload, next_attempt_at, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
       on conflict (webhook_id, source) do nothing`,
      [clubId, h.id, body.id, event, `outbox:${eventId}`, JSON.stringify(body), now],
    );
    n += ins.rowCount;
  }
  return n;
}

// Маршруты владельца ----------------------------------------------------------------------------

function cleanEvents(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > EVENTS.length) throw new HttpError(400, 'bad_request', { detail: 'events' });
  const set = new Set();
  for (const e of raw) {
    if (typeof e !== 'string' || !EVENTS.includes(e)) throw new HttpError(400, 'bad_request', { detail: 'events' });
    set.add(e);
  }
  return EVENTS.filter((e) => set.has(e));
}

function cleanDescription(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_request', { detail: 'description' });
  const d = raw.replace(/\s+/g, ' ').trim();
  if (d.length === 0) return null;
  if (d.length > DESCRIPTION_MAX) throw new HttpError(400, 'bad_request', { detail: 'description' });
  return d;
}

const HOOK_SELECT = `select w.id, w.url, w.events, w.description, w.created_at, w.created_by, w.disabled_at,
       (select u.name from bl.users u where u.id = w.created_by) as created_by_name,
       ld.status as last_status, ld.last_http_status, ld.last_error, ld.at as last_at,
       (select count(*)::int from bl.webhook_deliveries d where d.webhook_id = w.id and d.status = 'pending') as pending,
       (select count(*)::int from bl.webhook_deliveries d where d.webhook_id = w.id and d.status = 'failed') as failed
  from bl.webhooks w
  left join lateral (
    select d.status, d.last_http_status, d.last_error, coalesce(d.last_attempt_at, d.created_at) as at
      from bl.webhook_deliveries d where d.webhook_id = w.id order by d.created_at desc limit 1
  ) ld on true`;

function hookJson(w) {
  return {
    webhook_id: w.id,
    url: w.url,
    host: new URL(w.url).host,
    events: w.events,
    description: w.description ?? null,
    created_at: iso(w.created_at),
    created_by: w.created_by,
    created_by_name: w.created_by_name ?? null,
    active: w.disabled_at === null,
    disabled_at: iso(w.disabled_at),
    last_delivery: w.last_status
      ? { status: w.last_status, http_status: w.last_http_status ?? null, error: w.last_error ?? null, at: iso(w.last_at) }
      : null,
    pending: w.pending ?? 0,
    failed: w.failed ?? 0,
  };
}

async function loadHook(db, clubId, id, { lock = false } = {}) {
  const { rows } = await db.query(`${HOOK_SELECT} where w.id = $1 and w.club_id = $2${lock ? ' for update of w' : ''}`, [id, clubId]);
  if (!rows[0]) throw new HttpError(404, 'not_found', { detail: 'webhook' });
  return rows[0];
}

export async function listWebhooks(db, clubId) {
  const { rows } = await db.query(`${HOOK_SELECT} where w.club_id = $1 order by w.created_at desc, w.id`, [clubId]);
  const items = rows.map(hookJson);
  return { items, active: items.filter((w) => w.active).length, limit: MAX_ACTIVE_WEBHOOKS, events: [...EVENTS] };
}

/**
 * Зарегистрировать адрес: проверка SSRF (адрес резолвится в публичные IP), секрет подписи
 * показывается один раз (secret).
 */
export async function createWebhook(db, { clubId, userId, body, encKey, audit, lookup, ports = DEFAULT_PORTS }) {
  const events = cleanEvents(body?.events);
  const description = cleanDescription(body?.description);
  const url = await validateWebhookUrl(body?.url, { lookup, ports });
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.webhooks:' || $1::text, 0))", [clubId]);
  const { rows: cnt } = await db.query('select count(*)::int as n from bl.webhooks where club_id = $1 and disabled_at is null', [clubId]);
  if (cnt[0].n >= MAX_ACTIVE_WEBHOOKS) throw new HttpError(409, 'webhooks_limit');
  const id = randomUUID();
  const secret = newSecret();
  await db.query(
    `insert into bl.webhooks (id, club_id, url, events, description, secret_enc, created_by)
     values ($1, $2, $3, $4::text[], $5, $6, $7)`,
    [id, clubId, url, events, description, encryptSecret(secret, encKey, secretContext(id)), userId],
  );
  const host = new URL(url).host;
  await audit.appendAudit(db, { action: 'webhook.create', objectType: 'webhook', objectId: id, data: { webhook_id: id, host, events } });
  return { ...hookJson(await loadHook(db, clubId, id)), secret };
}

/** Выключить адрес: доставки в очереди отменяются. Повтор — тот же ответ. */
export async function disableWebhook(db, { clubId, userId, webhookId, audit, now }) {
  const w = await loadHook(db, clubId, webhookId, { lock: true });
  if (w.disabled_at) return hookJson(w);
  await db.query('update bl.webhooks set disabled_at = $2, disabled_by = $3 where id = $1', [webhookId, now, userId]);
  const c = await db.query("update bl.webhook_deliveries set status = 'canceled', claimed_until = null where webhook_id = $1 and status = 'pending'", [webhookId]);
  await audit.appendAudit(db, { action: 'webhook.disable', objectType: 'webhook', objectId: webhookId, data: { webhook_id: webhookId, host: new URL(w.url).host, canceled: c.rowCount } });
  return hookJson(await loadHook(db, clubId, webhookId));
}

/** Тестовое событие ping на адрес (через ту же очередь и подпись). */
export async function testWebhook(db, { clubId, webhookId, now }) {
  const w = await loadHook(db, clubId, webhookId);
  if (w.disabled_at) throw new HttpError(409, 'webhook_disabled');
  const { rows: m } = await db.query("select nullif(current_setting('app.club_mode', true), '') as mode");
  const body = { id: randomUUID(), type: 'ping', created_at: iso(now), club_id: clubId, test: m[0]?.mode !== 'live', data: { webhook_id: webhookId } };
  const { rows } = await db.query(
    `insert into bl.webhook_deliveries (club_id, webhook_id, event_id, event, source, payload, next_attempt_at, created_at)
     values ($1, $2, $3, 'ping', $4, $5::jsonb, $6, $6) returning id`,
    [clubId, webhookId, body.id, `test:${randomUUID()}`, JSON.stringify(body), now],
  );
  return { delivery_id: rows[0].id, event_id: body.id, event: 'ping', status: 'pending' };
}

function deliveryJson(d, attempts) {
  return {
    delivery_id: d.id,
    event_id: d.event_id,
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    created_at: iso(d.created_at),
    last_attempt_at: iso(d.last_attempt_at),
    next_attempt_at: d.status === 'pending' ? iso(d.next_attempt_at) : null,
    delivered_at: iso(d.delivered_at),
    http_status: d.last_http_status ?? null,
    error: d.last_error ?? null,
    log: attempts.map((a) => ({ attempt: a.attempt, at: iso(a.at), http_status: a.http_status ?? null, error: a.error ?? null, duration_ms: a.duration_ms })),
  };
}

/** Журнал доставок адреса: новые сверху, ?status, ?limit (до 200), ?cursor. */
export async function listDeliveries(db, { clubId, webhookId, query }) {
  await loadHook(db, clubId, webhookId);
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'bad_request', { detail: 'limit' });
  const status = query.status === undefined || query.status === '' ? null : query.status;
  if (status !== null && !['pending', 'delivered', 'failed', 'canceled'].includes(status)) throw new HttpError(400, 'bad_request', { detail: 'status' });
  let cursor = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    try {
      cursor = JSON.parse(Buffer.from(String(query.cursor), 'base64url').toString('utf8'));
    } catch {
      cursor = null;
    }
    if (!Array.isArray(cursor) || cursor.length !== 2 || Number.isNaN(Date.parse(cursor[0])) || !UUID.test(String(cursor[1]))) throw new HttpError(400, 'bad_request', { detail: 'cursor' });
  }
  const { rows } = await db.query(
    `select d.id, d.event_id, d.event, d.status, d.attempts, d.created_at, d.last_attempt_at, d.next_attempt_at, d.delivered_at, d.last_http_status, d.last_error
       from bl.webhook_deliveries d
      where d.webhook_id = $1 and d.club_id = $2 and ($3::text is null or d.status = $3)
        and ($4::timestamptz is null or (d.created_at, d.id) < ($4::timestamptz, $5::uuid))
      order by d.created_at desc, d.id desc
      limit $6`,
    [webhookId, clubId, status, cursor ? cursor[0] : null, cursor ? cursor[1] : null, limit + 1],
  );
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const { rows: attempts } = page.length
    ? await db.query('select delivery_id, attempt, at, http_status, error, duration_ms from bl.webhook_attempts where delivery_id = any($1::uuid[]) order by delivery_id, attempt', [page.map((d) => d.id)])
    : { rows: [] };
  const by = new Map();
  for (const a of attempts) by.set(a.delivery_id, [...(by.get(a.delivery_id) ?? []), a]);
  const last = page[page.length - 1];
  return {
    webhook_id: webhookId,
    items: page.map((d) => deliveryJson(d, by.get(d.id) ?? [])),
    next_cursor: more ? Buffer.from(JSON.stringify([iso(last.created_at), last.id])).toString('base64url') : null,
  };
}

