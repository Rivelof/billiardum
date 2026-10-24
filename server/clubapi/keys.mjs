// Ключи API клуба (M5.7 №199): выпуск, список, отзыв и проверка.
//
// Ключ — «blk_» + 32 случайных байта base64url (47 символов). В базе — HMAC-SHA256 ключа с перцем
// из SECRETS_ENC_KEY (key_hash) и префикс «blk_» + 8 символов для показа. Ключ отдаётся владельцу
// один раз в ответе на выпуск и больше нигде не появляется: ни в базе, ни в журнале, ни в логе.
// Смена SECRETS_ENC_KEY делает все ключи недействительными (перевыпуск владельцем).

import { createHmac, randomBytes } from 'node:crypto';
import { HttpError } from '../http/errors.mjs';

export const KEY_PREFIX = 'blk_';
export const KEY_RE = /^blk_[A-Za-z0-9_-]{43}$/;
export const MAX_ACTIVE_KEYS = 5;
export const SCOPES = Object.freeze(['tables:read', 'tariffs:read', 'availability:read', 'sales:read', 'bookings:read']);
const NAME_MAX = 100;

/** Перец ключей API из ключа шифрования секретов (32 байта). */
export function keyPepper(encKey) {
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32) throw new Error('clubapi: нужен config.encKey (32 байта)');
  return createHmac('sha256', encKey).update('bl.api-key-pepper.v1').digest();
}

/** HMAC-SHA256 ключа (hex) — то, что лежит в bl.api_keys.key_hash. */
export function keyHash(pepper, key) {
  return createHmac('sha256', pepper).update(key, 'utf8').digest('hex');
}

export function newKey() {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Ключ из заголовка Authorization: Bearer blk_… или null. */
export function keyFromHeader(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer (\S+)$/.exec(header.trim());
  if (!m || !KEY_RE.test(m[1])) return null;
  return m[1];
}

/**
 * Действующий ключ: { keyId, clubId, scopes, clubMode } или null (нет, отозван, не тот вид).
 * Запрос вне транзакции запроса (узкая функция обновляет last_used_at).
 */
export async function resolveKey(pool, pepper, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  const { rows } = await pool.query('select key_id, club_id, scopes, club_mode from bl.clubapi_key_auth($1)', [keyHash(pepper, key)]);
  if (rows.length !== 1) return null;
  return { keyId: rows[0].key_id, clubId: rows[0].club_id, scopes: rows[0].scopes ?? [], clubMode: rows[0].club_mode };
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_request', { detail: 'name' });
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > NAME_MAX) throw new HttpError(400, 'bad_request', { detail: 'name' });
  return name;
}

function cleanScopes(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > SCOPES.length) throw new HttpError(400, 'bad_request', { detail: 'scopes' });
  const set = new Set();
  for (const s of raw) {
    if (typeof s !== 'string' || !SCOPES.includes(s)) throw new HttpError(400, 'bad_request', { detail: 'scopes' });
    set.add(s);
  }
  return SCOPES.filter((s) => set.has(s));
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function keyJson(r) {
  return {
    key_id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    created_at: iso(r.created_at),
    created_by: r.created_by,
    created_by_name: r.created_by_name ?? null,
    last_used_at: iso(r.last_used_at),
    revoked_at: iso(r.revoked_at),
    active: r.revoked_at === null,
  };
}

const KEY_COLS = `k.id, k.name, k.prefix, k.scopes, k.created_at, k.created_by, k.last_used_at, k.revoked_at,
                  (select u.name from bl.users u where u.id = k.created_by) as created_by_name`;

/** Список ключей клуба из контекста (новые сверху). */
export async function listKeys(db, clubId) {
  const { rows } = await db.query(`select ${KEY_COLS} from bl.api_keys k where k.club_id = $1 order by k.created_at desc, k.id`, [clubId]);
  const items = rows.map(keyJson);
  return { items, active: items.filter((k) => k.active).length, limit: MAX_ACTIVE_KEYS, scopes: [...SCOPES] };
}

/**
 * Выпустить ключ. Возвращает строку ключа (key) — один раз.
 * @param {{ appendAudit: Function }} audit
 */
export async function createKey(db, { clubId, userId, body, pepper, audit, now }) {
  const name = cleanName(body?.name);
  const scopes = cleanScopes(body?.scopes);
  // Тот же замок, что у триггера bl.api_keys_guard: параллельные выпуски не превысят лимит.
  await db.query("select pg_advisory_xact_lock(hashtextextended('bl.api_keys:' || $1::text, 0))", [clubId]);
  const { rows: cnt } = await db.query('select count(*)::int as n from bl.api_keys where club_id = $1 and revoked_at is null', [clubId]);
  if (cnt[0].n >= MAX_ACTIVE_KEYS) throw new HttpError(409, 'api_keys_limit');
  const key = newKey();
  const prefix = key.slice(0, KEY_PREFIX.length + 8);
  let row;
  try {
    const { rows } = await db.query(
      `insert into bl.api_keys (club_id, name, prefix, key_hash, scopes, created_by, created_at)
       values ($1, $2, $3, $4, $5::text[], $6, $7)
       returning id, name, prefix, scopes, created_at, created_by, last_used_at, revoked_at`,
      [clubId, name, prefix, keyHash(pepper, key), scopes, userId, now],
    );
    row = rows[0];
  } catch (err) {
    if (err?.constraint === 'api_keys_active_limit') throw new HttpError(409, 'api_keys_limit', { cause: err });
    throw err;
  }
  await audit.appendAudit(db, { action: 'api_key.create', objectType: 'api_key', objectId: row.id, data: { key_id: row.id, name, prefix, scopes } });
  return { ...keyJson(row), key };
}

/** Отозвать ключ (повтор — тот же ответ, время первого отзыва). */
export async function revokeKey(db, { clubId, userId, keyId, audit, now }) {
  const { rows } = await db.query(`select ${KEY_COLS} from bl.api_keys k where k.id = $1 and k.club_id = $2 for update`, [keyId, clubId]);
  const k = rows[0];
  if (!k) throw new HttpError(404, 'not_found', { detail: 'api key' });
  if (k.revoked_at) return keyJson(k);
  const upd = await db.query(
    `update bl.api_keys k set revoked_at = $2, revoked_by = $3 where k.id = $1
     returning ${KEY_COLS}`,
    [keyId, now, userId],
  );
  await audit.appendAudit(db, { action: 'api_key.revoke', objectType: 'api_key', objectId: keyId, data: { key_id: keyId, name: k.name, prefix: k.prefix } });
  return keyJson(upd.rows[0]);
}
