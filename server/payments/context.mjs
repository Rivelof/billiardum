// Контекст запроса денежных маршрутов: клуб объекта, пользователь, роли.
//
// Гость приходит без клуба в контексте (роутер не знает клуб котировки или платежа):
// клуб находится узкой функцией по UUID объекта, затем транзакция переходит в контекст
// этого клуба (set_config(..., true)) — дальше работает RLS. Если клуб в контексте уже есть
// (маршрут персонала с {club}), чужой объект — not_found.

import { MoneyError } from './errors.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

export async function currentClub(db) {
  const { rows } = await db.query("select nullif(current_setting('app.club_id', true), '') as club_id");
  return rows[0].club_id;
}

/** Перейти в контекст клуба: только если клуба в контексте нет или он тот же. */
export async function enterClub(db, clubId) {
  if (!isUuid(clubId)) throw new MoneyError('not_found', 'club');
  const cur = await currentClub(db);
  if (cur === clubId) return clubId;
  if (cur !== null) throw new MoneyError('not_found', 'объект другого клуба');
  await db.query("select set_config('app.club_id', $1, true), set_config('app.club_mode', coalesce(bl.club_mode($1::uuid), ''), true)", [clubId]);
  return clubId;
}

/** Клуб объекта по UUID: resource (bl.resource_club, light) или quote/payment/reception_request. */
export async function objectClub(db, kind, id) {
  if (!isUuid(id)) return null;
  if (kind === 'resource') {
    const { rows } = await db.query('select bl.resource_club($1) as club_id', [id]);
    return rows[0].club_id;
  }
  const { rows } = await db.query('select bl.money_object_club($1, $2) as club_id', [kind, id]);
  return rows[0].club_id;
}

/** Найти клуб объекта и войти в его контекст; нет объекта — not_found. */
export async function enterObjectClub(db, kind, id) {
  const clubId = await objectClub(db, kind, id);
  if (!clubId) throw new MoneyError('not_found', `${kind} ${id}`);
  return enterClub(db, clubId);
}

/** Поля запроса из req (контракт §2.1) или ctx (§3). */
export function requestInfo(ctx, req = {}) {
  const user = req.user ?? ctx.user ?? null;
  const club = req.club ?? ctx.club ?? null;
  const roles = req.roles ?? ctx.roles ?? null;
  const headers = req.headers ?? {};
  const idempotencyKey = req.idempotencyKey ?? ctx.idempotencyKey ?? headers['idempotency-key'] ?? null;
  return {
    user,
    userId: user?.id ?? null,
    clubId: typeof club === 'string' ? club : club?.id ?? null,
    roles: Array.isArray(roles) ? roles : null,
    idempotencyKey,
    params: req.params ?? {},
    query: req.query ?? {},
    body: req.body ?? null,
    ip: req.ip ?? null,
  };
}

/** Idempotency-Key обязателен у денежной операции и должен быть UUID. */
export function requireIdempotencyKey(info) {
  const key = typeof info.idempotencyKey === 'string' ? info.idempotencyKey.toLowerCase() : null;
  if (!isUuid(key)) throw new MoneyError('bad_request', 'нужен Idempotency-Key (UUID)');
  return key;
}

export function requireUser(info) {
  if (!isUuid(info.userId)) throw new MoneyError('unauthorized', 'нет пользователя');
  return info.userId;
}

/**
 * Роль пользователя в клубе контекста. Если роутер уже проверил роли для этого клуба
 * (info.roles при info.clubId === clubId) — доверяем ему, иначе читаем club_members.
 */
export async function requireStaff(db, info, clubId, allowed) {
  const userId = requireUser(info);
  let roles = info.clubId === clubId && info.roles ? info.roles : null;
  if (!roles) {
    const { rows } = await db.query('select role from bl.club_members where club_id = $1 and user_id = $2 and active', [clubId, userId]);
    roles = rows.map((r) => r.role);
  }
  if (!roles.some((r) => allowed.includes(r))) throw new MoneyError('forbidden', 'нет роли в клубе');
  return roles;
}

/**
 * Телефон и согласие гостя перед денежной операцией (контракт §4, decisions №41).
 * Телефон — из bl.users (свою строку пользователь видит), согласие — bl.consents (core).
 */
export async function requireGuestReady(db, info) {
  const userId = requireUser(info);
  const { rows } = await db.query('select phone from bl.users where id = $1', [userId]);
  const phone = rows[0]?.phone ?? info.user?.phone ?? null;
  if (!phone) throw new MoneyError('phone_required');
  if (info.user && (info.user.needs_consent === true || info.user.consent === false)) throw new MoneyError('consent_required');
  const reg = await db.query("select to_regclass('bl.consents') is not null as present");
  if (reg.rows[0].present) {
    const c = await db.query('select 1 from bl.consents where user_id = $1 limit 1', [userId]);
    if (c.rowCount === 0) throw new MoneyError('consent_required');
  }
  return { userId, phone };
}
