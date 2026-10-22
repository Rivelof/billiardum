// Запросы брони и листа ожидания. db — клиент транзакции; RLS отсекает чужой клуб.
// Время — только из ctx.clock (параметром), не now() базы.

import { setContext } from '../lib/store.mjs';
import { BookingError } from './errors.mjs';

export const LIVE = Object.freeze(['pending_payment', 'confirmed', 'reserved', 'started']);
export const OPEN = Object.freeze(['pending_payment', 'confirmed', 'reserved']);
export const SESSION_OPEN = Object.freeze(['active', 'ending', 'grace']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export async function currentClub(db) {
  const { rows } = await db.query("select nullif(current_setting('app.club_id', true), '') as club_id");
  return rows[0].club_id;
}

/** Перейти в контекст клуба объекта (до конца транзакции). Вызывается после проверки прав на объект. */
export async function useClub(db, clubId) {
  if (!isUuid(clubId)) throw new BookingError('not_found', 'club');
  if ((await currentClub(db)) !== clubId) await setContext(db, { clubId });
  return clubId;
}

/** Клуб стола (bl.resource_club, light) — до того, как известен контекст. */
export async function resourceClub(db, resourceId) {
  if (!isUuid(resourceId)) return null;
  const { rows } = await db.query('select bl.resource_club($1) as club_id', [resourceId]);
  return rows[0].club_id;
}

export async function loadClub(db, clubId) {
  const { rows } = await db.query('select id, name, timezone, settings from bl.clubs where id = $1', [clubId]);
  return rows[0] ?? null;
}

/** Процент удержания при сгорании — настройка money (0650: club_payment_settings), иначе clubs.settings, иначе 100. */
export async function forfeitPercentOf(db, club) {
  await db.query('savepoint bl_booking_forfeit');
  try {
    const { rows } = await db.query('select booking_forfeit_percent as p from bl.club_payment_settings where club_id = $1', [club.id]);
    await db.query('release savepoint bl_booking_forfeit');
    if (rows.length > 0 && Number.isInteger(rows[0].p)) return rows[0].p;
  } catch {
    await db.query('rollback to savepoint bl_booking_forfeit');
  }
  const v = club.settings?.booking_forfeit_percent;
  return Number.isInteger(v) && v >= 0 && v <= 100 ? v : 100;
}

export async function lockResource(db, resourceId) {
  if (!isUuid(resourceId)) return null;
  const { rows } = await db.query(
    'select id, club_id, number, type, title, code, active from bl.resources where id = $1 for update',
    [resourceId],
  );
  return rows[0] ?? null;
}

const BOOKING_COLS = `b.*, r.number as resource_number, r.title as resource_title, r.type as resource_type,
  c.name as club_name, c.timezone as club_timezone`;

export async function loadBooking(db, bookingId, { lock = false } = {}) {
  if (!isUuid(bookingId)) return null;
  const { rows } = await db.query(
    `select ${BOOKING_COLS} from bl.bookings b
       join bl.resources r on r.id = b.resource_id
       join bl.clubs c on c.id = b.club_id
      where b.id = $1 ${lock ? 'for update of b' : ''}`,
    [bookingId],
  );
  return mapBooking(rows[0]);
}

export function mapBooking(row) {
  if (!row) return null;
  for (const k of ['amount_kopecks', 'prepayment_kopecks', 'prepaid_kopecks']) row[k] = Number(row[k]);
  return row;
}

/** Своя бронь гостя в любом клубе (политика bookings_self): club_id или null. */
export async function ownBookingClub(db, bookingId, userId) {
  if (!isUuid(bookingId) || !isUuid(userId)) return null;
  const { rows } = await db.query('select club_id from bl.bookings where id = $1 and user_id = $2', [bookingId, userId]);
  return rows[0]?.club_id ?? null;
}

/** Идущая сессия стола: { id, paid_until, grace_ms, payer_user_id } или null. */
export async function openSession(db, resourceId) {
  const { rows } = await db.query(
    `select id, started_at, paid_until, grace_ms, payer_user_id from bl.sessions
      where resource_id = $1 and status = any($2::text[]) limit 1`,
    [resourceId, SESSION_OPEN],
  );
  return rows[0] ?? null;
}

/** Действующие удержания стола (light): pending, reserved, service. */
export async function activeHolds(db, resourceId, now) {
  const { rows } = await db.query(
    `select id, kind, user_id, until, created_at from bl.resource_holds
      where resource_id = $1 and released_at is null and until > $2 order by created_at desc`,
    [resourceId, now],
  );
  return rows;
}

/** Стол свободен прямо сейчас: нет игры и удержаний. */
export async function tableFree(db, resourceId, now) {
  if (await openSession(db, resourceId)) return false;
  return (await activeHolds(db, resourceId, now)).length === 0;
}

/** Живые брони стола, пересекающие [from, to), кроме exceptId. */
export async function overlapping(db, resourceId, from, to, exceptId = null) {
  const { rows } = await db.query(
    `select id, starts_at, ends_at, status from bl.bookings
      where resource_id = $1 and status = any($2::text[]) and period && tstzrange($3, $4, '[)')
        and ($5::uuid is null or id <> $5)
      order by starts_at`,
    [resourceId, LIVE, from, to, exceptId],
  );
  return rows;
}

/**
 * Рабочие сутки клуба (№43) для местной даты: { from, to } — [date day_start, date+1 day_start).
 */
export async function workdayWindow(db, clubId, date) {
  const { rows } = await db.query(
    `select ($2::date + coalesce(nullif(settings->>'day_start_local', ''), '06:00')::time) at time zone timezone as from_at,
            ($2::date + 1 + coalesce(nullif(settings->>'day_start_local', ''), '06:00')::time) at time zone timezone as to_at
       from bl.clubs where id = $1`,
    [clubId, date],
  );
  return rows[0] ? { from: rows[0].from_at, to: rows[0].to_at } : null;
}

/** Местная дата рабочих суток клуба, в которые попадает момент at ('YYYY-MM-DD') и их начало. */
export async function workdayAt(db, clubId, at) {
  const { rows } = await db.query(
    `with c as (
       select timezone, coalesce(nullif(settings->>'day_start_local', ''), '06:00')::time as day_start from bl.clubs where id = $1
     ), l as (select timezone, day_start, ($2::timestamptz at time zone timezone) as local_at from c)
     select to_char(d, 'YYYY-MM-DD') as date, (d + day_start) at time zone timezone as start
       from (select timezone, day_start, case when local_at::time >= day_start then local_at::date else local_at::date - 1 end as d from l) x`,
    [clubId, at],
  );
  return rows[0] ?? null;
}

/** Маска телефона без учётки (бронь по телефону): +7912***6789. */
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 9) return null;
  return `${phone.slice(0, 5)}***${phone.slice(-4)}`;
}

/** Код стола как у light (Crockford Base32): регистр, пробелы и дефисы, I/L → 1, O → 0. */
export function normalizeCode(code) {
  if (typeof code !== 'string' || code.length > 40) return null;
  const c = code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(c) ? c : null;
}
