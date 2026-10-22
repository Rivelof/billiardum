// PIN персонала (контракт M1 §4): 4–6 цифр, хранится как scrypt-хеш с солью.
// Перед scrypt PIN проходит HMAC с «перцем» из SECRETS_ENC_KEY: по дампу базы без .env
// миллион вариантов PIN не перебрать (decisions №23).
// Формат: scrypt$N$r$p$<соль base64url>$<хеш base64url>.

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

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
