// Вход по ключу API клуба (M5.7 №199, №202): отдельный путь роутера для маршрутов auth 'api_key'
// (/api/v1/club/…). Ключ даёт только контекст своего клуба — без пользователя и прав сотрудника:
// транзакция READ ONLY, app.actor_type = 'api', app.user_id пуст. Права — по scopes ключа.
// Лимиты: 600 запросов в минуту на ключ, у маршрута с keyRateLimit (продажи) — ещё свой (60).

import { HttpError } from '../http/errors.mjs';
import { keyFromHeader, keyPepper, resolveKey } from './keys.mjs';

export const API_PREFIX = '/api/v1/club/';
export const KEY_LIMIT = Object.freeze({ max: 600, windowMs: 60_000 });
export const SALES_LIMIT = Object.freeze({ max: 60, windowMs: 60_000 });
export const ACTOR_TYPE = 'api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const pepperCache = new WeakMap();

function pepperOf(config) {
  const encKey = config?.encKey;
  if (!encKey) throw new Error('clubapi: нет config.encKey');
  let p = pepperCache.get(encKey);
  if (!p) {
    p = keyPepper(encKey);
    pepperCache.set(encKey, p);
  }
  return p;
}

/** Перец ключей API из конфигурации сервера. */
export function pepperFrom(config) {
  return pepperOf(config);
}

/**
 * Транзакция только для чтения в контексте клуба ключа (снимок repeatable read).
 * Запись в любой таблице (и в журнале) база отклонит: 25006 read-only transaction.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {string} clubId
 * @param {(db: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withApiContext(pool, clubId, fn) {
  if (!UUID.test(clubId)) throw new Error('withApiContext: clubId');
  const client = await pool.connect();
  let broken;
  try {
    await client.query('begin isolation level repeatable read read only');
    await client.query(
      `select set_config('app.club_id', $1, true), set_config('app.user_id', '', true), set_config('app.actor_type', $2, true),
              set_config('app.club_mode', coalesce(bl.club_mode($1::uuid), ''), true)`,
      [clubId, ACTOR_TYPE],
    );
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (e) {
      broken = e;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/**
 * Запрос маршрута auth 'api_key' (вызывает api/router.mjs). Ответ — { status, json, headers, principal }.
 * Ошибки — HttpError: 401 unauthorized (нет ключа, не тот, отозван), 403 club_suspended,
 * 429 rate_limited (Retry-After), 403 scope_required.
 * @param {object} app общий контекст сервера
 * @param {object} route маршрут: { scope, keyRateLimit?, handler }
 * @param {object} reqInfo { method, path, params, query, headers, ip }
 * @param {{ rateLimiter: { hit(key: string, limit: object): { ok: boolean, retryAfterSec: number } } }} options
 */
export async function handleApiKeyRoute(app, route, reqInfo, { rateLimiter }) {
  const key = keyFromHeader(reqInfo.headers.authorization);
  if (!key) throw new HttpError(401, 'unauthorized', { detail: 'api key required' });
  const found = await resolveKey(app.pool, pepperOf(app.config), key);
  if (!found) throw new HttpError(401, 'unauthorized', { detail: 'api key' });
  const principal = { kind: 'api_key', keyId: found.keyId, clubId: found.clubId, scopes: found.scopes, userId: null };
  const limited = (hit) => new HttpError(429, 'rate_limited', { headers: { 'retry-after': String(hit.retryAfterSec) } });
  const all = rateLimiter.hit(`api_key|${found.keyId}`, KEY_LIMIT);
  if (!all.ok) throw limited(all);
  if (route.keyRateLimit) {
    const one = rateLimiter.hit(`api_key|${found.keyId}|${route.path}`, route.keyRateLimit);
    if (!one.ok) throw limited(one);
  }
  if (found.clubMode === 'suspended') throw new HttpError(403, 'club_suspended');
  if (!found.scopes.includes(route.scope)) throw new HttpError(403, 'scope_required');
  const result = await withApiContext(app.pool, found.clubId, async (db) => {
    const ctx = { ...app, db, club: found.clubId, clubMode: found.clubMode, apiKey: { id: found.keyId, scopes: found.scopes }, user: null, roles: [], principal };
    return (await route.handler(ctx, { ...reqInfo, club: found.clubId, user: null, roles: [], principal })) ?? { status: 204 };
  });
  return { status: result.status ?? 200, json: result.json, headers: result.headers ?? {}, principal };
}
