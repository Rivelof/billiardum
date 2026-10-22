// PIN персонала (контракт M1 §4): 4–6 цифр, хранится как scrypt-хеш с солью.
// Перед scrypt PIN проходит HMAC с «перцем» из SECRETS_ENC_KEY: по дампу базы без .env
// миллион вариантов PIN не перебрать (decisions №23).
// Формат: scrypt$N$r$p$<соль base64url>$<хеш base64url>.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { isUuid, withContext as storeWithContext } from '../lib/store.mjs';

const scrypt = promisify(scryptCb);

export const PIN = /^[0-9]{4,6}$/;
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const KEY_LEN = 32;
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

const FORMAT = /^scrypt\$([0-9]+)\$([0-9]+)\$([0-9]+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

/** Перец из ключа шифрования приложения (32 байта). */
export function pinPepper(encKey) {
  return createHmac('sha256', encKey).update('bl.pin-pepper.v1').digest();
}

function prepare(pin, pepper) {
  return createHmac('sha256', pepper).update(`bl.pin.v1:${pin}`, 'utf8').digest();
}

export async function hashPin(pin, pepper, { salt = randomBytes(16), N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P } = {}) {
  if (typeof pin !== 'string' || !PIN.test(pin)) throw new Error('PIN — 4–6 цифр');
  const key = await scrypt(prepare(pin, pepper), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** Проверка PIN за постоянное время по сохранённому хешу. Неверный формат — false. */
export async function verifyPin(pin, stored, pepper) {
  if (typeof pin !== 'string' || !PIN.test(pin) || typeof stored !== 'string') return false;
  const m = FORMAT.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(m[4], 'base64url');
  const expected = Buffer.from(m[5], 'base64url');
  if (expected.length !== KEY_LEN) return false;
  const key = await scrypt(prepare(pin, pepper), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r });
  return timingSafeEqual(key, expected);
}

/** Роли, которым можно входить по PIN на терминале (смена сотрудника). */
export const PIN_SWITCH_ROLES = ['owner', 'manager', 'reception', 'bar'];

/**
 * Проверка PIN сотрудника клуба (смена сотрудника на терминале, одобрение скидки
 * управляющим — decisions №95) без смены активного пользователя терминала.
 *
 * Работает в СВОЕЙ транзакции (контекст клуба clubId): счётчик ошибок коммитится, даже если
 * вызывающий потом откатит свою транзакцию. Блокировка общая для всех проверок PIN этого
 * сотрудника в клубе: 5 ошибок подряд — 15 минут; успех сбрасывает счётчик.
 * Порядок: нет участника или PIN не задан — unauthorized (без счёта); блок — rate_limited;
 * роль не из roles — forbidden (PIN не проверяется и не считается); неверный PIN — unauthorized.
 *
 * @param {{ pool: import('pg').Pool, clubId: string, userId: string, pin: string, roles: string[],
 *           pepper: Buffer, now?: Date, withContext?: Function }} args
 * @returns {Promise<{ ok: true, role: string }
 *   | { ok: false, code: 'bad_request'|'unauthorized'|'forbidden'|'rate_limited', retryAfterSec?: number, locked?: boolean }>}
 */
export async function checkStaffPin({ pool, clubId, userId, pin, roles, pepper, now = new Date(), withContext = storeWithContext }) {
  if (!isUuid(clubId) || !isUuid(userId) || typeof pin !== 'string' || !PIN.test(pin) || !Array.isArray(roles) || roles.length === 0) {
    return { ok: false, code: 'bad_request' };
  }
  return withContext(pool, { clubId, actorType: 'system' }, async (db) => {
    const { rows } = await db.query(
      `select id, role, pin_hash, pin_failed_count, pin_locked_until from bl.club_members
        where club_id = $1 and user_id = $2 and active for update`,
      [clubId, userId],
    );
    const m = rows[0];
    if (!m || !m.pin_hash) return { ok: false, code: 'unauthorized' };
    if (m.pin_locked_until && m.pin_locked_until > now) {
      return { ok: false, code: 'rate_limited', locked: true, retryAfterSec: Math.ceil((m.pin_locked_until.getTime() - now.getTime()) / 1000) };
    }
    if (!roles.includes(m.role)) return { ok: false, code: 'forbidden' };
    if (!(await verifyPin(pin, m.pin_hash, pepper))) {
      const failed = m.pin_failed_count + 1;
      const locked = failed >= MAX_FAILURES;
      await db.query('update bl.club_members set pin_failed_count = $2, pin_locked_until = $3 where id = $1', [
        m.id,
        locked ? 0 : failed,
        locked ? new Date(now.getTime() + LOCK_MS) : null,
      ]);
      return { ok: false, code: 'unauthorized', locked };
    }
    if (m.pin_failed_count !== 0 || m.pin_locked_until) {
      await db.query('update bl.club_members set pin_failed_count = 0, pin_locked_until = null where id = $1', [m.id]);
    }
    return { ok: true, role: m.role };
  });
}
