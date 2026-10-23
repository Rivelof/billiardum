// Запросы модуля light. Все функции принимают db — клиента транзакции с контекстом клуба
// (RLS отсекает чужое). Время — только из ctx.clock (параметром), не now() базы.

import { randomUUID } from 'node:crypto';
import { LightError } from './errors.mjs';

export const OPEN_STATUSES = Object.freeze(['active', 'ending', 'grace']);
export const NOTIFY_CHANNEL = 'bl_light';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const isOpen = (s) => Boolean(s) && OPEN_STATUSES.includes(s.status);

/** Клуб из контекста транзакции или null. */
export async function currentClub(db) {
  const { rows } = await db.query("select nullif(current_setting('app.club_id', true), '') as club_id");
  return rows[0].club_id;
}

/**
 * Перейти в контекст клуба объекта (set_config(..., true) — до конца транзакции).
 * Только если контекста клуба ещё нет или он тот же: чужой клуб — not_found.
 */
export async function enterClub(db, clubId) {
  if (!isUuid(clubId)) throw new LightError('not_found', 'club');
  const cur = await currentClub(db);
  if (cur === clubId) return clubId;
  if (cur !== null) throw new LightError('not_found', 'другой клуб в контексте');
  await db.query("select set_config('app.club_id', $1, true), set_config('app.club_mode', coalesce(bl.club_mode($1::uuid), ''), true)", [clubId]);
  return clubId;
}

export async function sessionClub(db, sessionId) {
  if (!isUuid(sessionId)) return null;
  const { rows } = await db.query('select bl.session_club($1) as club_id', [sessionId]);
  return rows[0].club_id;
}

export async function resourceClub(db, resourceId) {
  if (!isUuid(resourceId)) return null;
  const { rows } = await db.query('select bl.resource_club($1) as club_id', [resourceId]);
  return rows[0].club_id;
}

export async function loadClub(db, clubId) {
  const { rows } = await db.query('select id, name, timezone, settings from bl.clubs where id = $1', [clubId]);
  return rows[0] ?? null;
}

const SESSION_COLS = `s.id, s.club_id, s.resource_id, s.status, s.source, s.payer_user_id, s.unlimited,
  s.started_at, s.paid_until, s.warn_ms, s.grace_ms, s.device_paid_until, s.interrupted_at, s.unplayed_ms,
  s.ended_at, s.close_reason, s.notified, s.created_at, s.updated_at, s.booking_id, s.deposit_kopecks, s.match_id, r.number as resource_number,
  r.type as resource_type, r.title as resource_title, c.timezone as club_timezone`;
const SESSION_FROM = `bl.sessions s join bl.resources r on r.id = s.resource_id left join bl.clubs c on c.id = s.club_id`;

function mapSession(row) {
  if (!row) return null;
  return {
    ...row,
    unplayed_ms: row.unplayed_ms === null ? null : Number(row.unplayed_ms),
    deposit_kopecks: row.deposit_kopecks === null || row.deposit_kopecks === undefined ? null : Number(row.deposit_kopecks),
  };
}

export async function loadSession(db, sessionId, { lock = false } = {}) {
  if (!isUuid(sessionId)) return null;
  const { rows } = await db.query(
    `select ${SESSION_COLS} from ${SESSION_FROM}
      where s.id = $1 ${lock ? 'for update of s' : ''}`,
    [sessionId],
  );
  return mapSession(rows[0]);
}

export async function openSessionOn(db, resourceId, { lock = false } = {}) {
  const { rows } = await db.query(
    `select ${SESSION_COLS} from ${SESSION_FROM}
      where s.resource_id = $1 and s.status = any($2::text[]) ${lock ? 'for update of s' : ''}`,
    [resourceId, OPEN_STATUSES],
  );
  return mapSession(rows[0]);
}

/** Строка ресурса под блокировкой: гонку двух гостей и оплаты решает FOR UPDATE. */
export async function lockResource(db, resourceId) {
  if (!isUuid(resourceId)) return null;
  const { rows } = await db.query(
    'select id, club_id, number, type, title, code, active from bl.resources where id = $1 for update',
    [resourceId],
  );
  return rows[0] ?? null;
}

export async function loadResource(db, resourceId) {
  if (!isUuid(resourceId)) return null;
  const { rows } = await db.query(
    'select id, club_id, number, type, title, code, active, plan_x, plan_y, plan_rotation from bl.resources where id = $1',
    [resourceId],
  );
  return rows[0] ?? null;
}

/**
 * Главное действующее удержание стола (service, затем pending, затем reserved). Под сервисом
 * может лежать удержание брони: оно ждёт, пока стол освободится.
 */
export async function activeHold(db, resourceId, now) {
  const { rows } = await db.query(
    `select id, kind, user_id, until, reason_code, reason_text, source, ref_id, created_at from bl.resource_holds
      where resource_id = $1 and released_at is null and until > $2
      -- Сервис главнее брони и очереди: удержание reserved, записанное во время сервиса, не
      -- перекрывает его (иначе сверка гасила бы сервисный свет, регресс R2). Затем pending.
      order by case kind when 'service' then 0 when 'pending' then 1 else 2 end, created_at desc limit 1`,
    [resourceId, now],
  );
  return rows[0] ?? null;
}

/** Действующее удержание reserved (бронь, очередь), даже если сверху идёт сервис. */
export async function activeReserved(db, resourceId, now) {
  const { rows } = await db.query(
    `select id, kind, user_id, until, source, ref_id, created_at from bl.resource_holds
      where resource_id = $1 and kind = 'reserved' and released_at is null and until > $2
      order by created_at desc limit 1`,
    [resourceId, now],
  );
  return rows[0] ?? null;
}

export async function releaseHold(db, holdId, now, reason) {
  await db.query('update bl.resource_holds set released_at = $2, release_reason = $3 where id = $1 and released_at is null', [
    holdId,
    now,
    reason,
  ]);
}

export async function deviceOfResource(db, resourceId) {
  const { rows } = await db.query(
    'select id, club_id, resource_id, fw, caps, last_seen_at, (device_key_enc is not null) as has_key from bl.devices where resource_id = $1',
    [resourceId],
  );
  return rows[0] ?? null;
}

export async function loadDevice(db, deviceId) {
  const { rows } = await db.query(
    'select id, club_id, resource_id, fw, caps, last_seen_at, (device_key_enc is not null) as has_key from bl.devices where id = $1',
    [deviceId],
  );
  return rows[0] ?? null;
}

export async function participants(db, sessionId) {
  const { rows } = await db.query(
    'select user_id, role, ordinal, joined_at from bl.session_participants where session_id = $1 order by ordinal',
    [sessionId],
  );
  return rows;
}

export async function addParticipant(db, { session, userId, role, now }) {
  const { rows } = await db.query(
    `insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at)
     select $1, $2, $3, $4, coalesce(max(ordinal), 0) + 1, $5 from bl.session_participants where session_id = $1
     on conflict (session_id, user_id) do nothing
     returning ordinal`,
    [session.id, session.club_id, userId, role, now],
  );
  return rows.length > 0;
}

/** Роли пользователя в клубе из контекста (club_members, только активные). */
export async function rolesIn(db, clubId, userId) {
  if (!isUuid(userId)) return [];
  const { rows } = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [clubId, userId]);
  return rows.map((r) => r.role);
}

/**
 * Команда контроллеру в очередь (status = queued) в транзакции вызывающего и сигнал мосту
 * после коммита (pg_notify доставляется только при COMMIT). seq и журнал — в мосте.
 */
export async function queueCommand(db, { clubId, deviceId, type, body = {}, cause, sessionId = null, paymentId = null, now }) {
  const id = randomUUID();
  await db.query(
    `insert into bl.device_commands (id, club_id, device_id, type, body, status, cause, session_id, payment_id, created_at)
     values ($1, $2, $3, $4, $5::jsonb, 'queued', $6, $7, $8, $9)`,
    [id, clubId, deviceId, type, JSON.stringify(body), cause, sessionId, paymentId, now],
  );
  await notifyLight(db, { k: 'cmd', c: clubId, d: deviceId });
  return id;
}

/** Сигнал после коммита: мосту (k=cmd), планировщику и SSE (k=session, k=hall). */
export async function notifyLight(db, payload) {
  await db.query('select pg_notify($1, $2)', [NOTIFY_CHANNEL, JSON.stringify(payload)]);
}
