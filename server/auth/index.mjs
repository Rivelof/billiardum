// Вход (контракт M1 §3, §4): токены, cookie, кто делает запрос, пользователь для ответа.
// Токен — 32 случайных байта (base64url, 43 символа); в базе только sha256.
// Проверка токена — узкая функция bl.auth_resolve (SECURITY DEFINER, миграция 0103).

import { createHash, randomBytes } from 'node:crypto';
import { appendAudit } from '../lib/audit.mjs';
import { setContext } from '../lib/store.mjs';
import { serializeCookie } from '../http/request.mjs';

export const SESSION_COOKIE = 'bl_session';
export const LINK_COOKIE = 'bl_link';
export const COOKIE_PATH = '/api';
export const LINK_COOKIE_PATH = '/api/auth/bot-link';
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const PIN_TTL_MS = 12 * 3600_000;
export const TERMINAL_TTL_MS = 365 * 24 * 3600_000;
/** Версия текста согласия (docs/legal/consent.md); меняется вместе с текстом. */
export const DEFAULT_CONSENT_VERSION = '2026-10-21';
// Проверка PIN сотрудника без смены пользователя терминала (одобрение скидки, №95).
export { checkStaffPin, PIN_SWITCH_ROLES } from './pin.mjs';

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const STAFF_ROLES = ['owner', 'manager', 'reception', 'installer', 'bar'];

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** +79991234567 → +7999***4567 (как maskPhone в логах). */
export function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 8) return null;
  return `${phone.slice(0, 5)}***${phone.slice(-4)}`;
}

/** Телефон из контакта мессенджера → E.164 или null. */
export function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s()-]/g, '');
  if (!s.startsWith('+')) s = `+${s}`;
  return /^\+[1-9][0-9]{7,14}$/.test(s) ? s : null;
}

/**
 * Кто делает запрос: токен из Authorization: Bearer (мини-приложения, терминал) или cookie.
 * @returns {Promise<null | { tokenId: string, kind: 'session'|'pin'|'terminal', userId: string|null,
 *   clubId: string|null, terminalId: string|null, expiresAt: Date, hasPhone: boolean, consents: string[] }>}
 */
export async function resolveToken(pool, token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const { rows } = await pool.query('select * from bl.auth_resolve($1)', [tokenHash(token)]);
  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    tokenId: r.token_id,
    kind: r.kind,
    userId: r.user_id,
    clubId: r.club_id,
    terminalId: r.terminal_id,
    expiresAt: r.expires_at,
    hasPhone: r.has_phone,
    consents: r.consents ?? [],
  };
}

/**
 * Новый токен пользователя. db — транзакция, где app.user_id = userId
 * (или app.club_id = clubId для токена PIN).
 */
export async function issueToken(db, { userId, kind = 'session', clubId = null, terminalId = null, now = new Date(), ttlMs }) {
  const token = newToken();
  const ttl = ttlMs ?? (kind === 'pin' ? PIN_TTL_MS : SESSION_TTL_MS);
  const expiresAt = new Date(now.getTime() + ttl);
  const { rows } = await db.query(
    `insert into bl.auth_tokens (user_id, token_hash, kind, club_id, terminal_id, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [userId, tokenHash(token), kind, clubId, terminalId, now, expiresAt],
  );
  return { token, tokenId: rows[0].id, expiresAt };
}

export function sessionCookie(token, expiresAt, now = new Date()) {
  return serializeCookie(SESSION_COOKIE, token, { path: COOKIE_PATH, maxAgeSec: (expiresAt.getTime() - now.getTime()) / 1000 });
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { path: COOKIE_PATH, maxAgeSec: 0 });
}

/**
 * Пользователь для ответа: без телефона целиком — только маска.
 * db — транзакция, где app.user_id = userId (своя строка users видна по RLS).
 */
export async function userJson(db, userId, { consentVersion = DEFAULT_CONSENT_VERSION } = {}) {
  const { rows } = await db.query(
    `select u.id, u.phone, u.name, u.notify_channel, u.channels_order, u.telegram_user_id is not null as telegram, u.max_user_id is not null as max,
            exists (select 1 from bl.consents c where c.user_id = u.id and c.version = $2) as consent,
            exists (select 1 from bl.push_subscriptions ps where ps.user_id = u.id and ps.revoked_at is null) as webpush
       from bl.users u where u.id = $1`,
    [userId, consentVersion],
  );
  const u = rows[0];
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    phone_masked: maskPhone(u.phone),
    needs_phone: u.phone === null,
    // §14: принятая текущая версия согласия или null; требуемая версия — consent.version.
    consent_version: u.consent ? consentVersion : null,
    consent: { version: consentVersion, accepted: u.consent },
    notify_channel: u.notify_channel,
    channels_order: u.channels_order,
    // Какие каналы реально подключены (№120): мессенджер привязан, у Web Push — хотя бы одна подписка.
    channels: { max: u.max, telegram: u.telegram, webpush: u.webpush },
  };
}

/** Членства пользователя во всех клубах (личный контекст: app.club_id пуст). */
export async function myMemberships(db, userId) {
  const { rows } = await db.query(
    `select m.club_id, m.role, c.name as club_name, c.timezone
       from bl.club_members m
       left join bl.clubs c on c.id = m.club_id
      where m.user_id = $1 and m.active
      order by c.name, m.club_id`,
    [userId],
  );
  return rows;
}

/**
 * Запись auth.staff_login в журнал каждого клуба, где пользователь — персонал.
 * Контекст транзакции переключается по клубам и возвращается в личный.
 */
export async function auditStaffLogin(db, userId, { via, terminalId = null } = {}) {
  await setContext(db, { clubId: null, userId });
  const clubs = await myMemberships(db, userId);
  for (const m of clubs) {
    if (!STAFF_ROLES.includes(m.role)) continue;
    await setContext(db, { clubId: m.club_id });
    await appendAudit(db, {
      action: 'auth.staff_login',
      objectType: 'user',
      objectId: userId,
      actorType: 'user',
      actorId: userId,
      data: terminalId ? { terminal_id: terminalId, via } : { via },
    });
  }
  await setContext(db, { clubId: null });
  return clubs;
}

/**
 * Выдать личный токен после входа и ответ { token, user, needs_phone } с cookie.
 * db — транзакция запроса; контекст переключается на пользователя.
 */
export async function completeLogin(ctx, userId, { via }) {
  const { db } = ctx;
  const now = ctx.clock.now();
  await setContext(db, { clubId: null, userId, actorType: 'user' });
  const issued = await issueToken(db, { userId, kind: 'session', now });
  // Приглашения персонала на этот номер (M3 §1 п. 9) — до записи о входе персонала.
  const { acceptInvites } = await import('../staff/index.mjs');
  await acceptInvites(db, userId);
  await auditStaffLogin(db, userId, { via });
  const user = await userJson(db, userId, { consentVersion: ctx.config.consentVersion });
  ctx.setCookie(sessionCookie(issued.token, issued.expiresAt, now));
  ctx.log.info('auth_login', { via, user_id: userId });
  return { token: issued.token, expires_at: issued.expiresAt.toISOString(), user, needs_phone: user.needs_phone };
}
