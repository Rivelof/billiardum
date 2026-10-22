// Проверка initData мини-приложения Telegram (контракт M1 §4, PRODUCT §11).
//
// Алгоритм Telegram (Mini Apps, «Validating data received via the Mini App»):
//   data_check_string = все поля, кроме hash, по алфавиту, «ключ=значение» через \n;
//   secret_key = HMAC-SHA256(key = "WebAppData", data = токен бота);
//   hash = hex(HMAC-SHA256(key = secret_key, data = data_check_string)).
// hash сравнивается за постоянное время; auth_date не старше 24 часов.

import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_AGE_SEC = 24 * 3600;
export const MAX_FUTURE_SEC = 300;
export const MAX_INIT_DATA = 4096;

export class InitDataError extends Error {
  constructor(reason) {
    super(`initData: ${reason}`);
    this.name = 'InitDataError';
    this.reason = reason;
  }
}

export function webAppSecret(botToken) {
  return createHmac('sha256', 'WebAppData').update(botToken, 'utf8').digest();
}

/** data_check_string и hash из строки initData; повторяющиеся ключи — ошибка. */
export function dataCheckString(initData) {
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > MAX_INIT_DATA) throw new InitDataError('format');
  const params = new URLSearchParams(initData);
  const seen = new Map();
  for (const [key, value] of params) {
    if (seen.has(key)) throw new InitDataError('duplicate_key');
    seen.set(key, value);
  }
  const hash = seen.get('hash');
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataError('hash');
  seen.delete('hash');
  const keys = [...seen.keys()].sort();
  return { hash, fields: seen, text: keys.map((k) => `${k}=${seen.get(k)}`).join('\n') };
}

/** Подпись initData (для тестовых векторов и заглушек разработки). */
export function signInitData(fields, botToken) {
  const keys = Object.keys(fields).sort();
  const text = keys.map((k) => `${k}=${fields[k]}`).join('\n');
  const hash = createHmac('sha256', webAppSecret(botToken)).update(text, 'utf8').digest('hex');
  const params = new URLSearchParams();
  for (const k of Object.keys(fields)) params.set(k, fields[k]);
  params.set('hash', hash);
  return params.toString();
}

/**
 * Проверяет initData. Возвращает { user: { id, ... }, authDate } или бросает InitDataError.
 * @param {string} initData
 * @param {string} botToken
 * @param {{ now?: Date, maxAgeSec?: number }} [options]
 */
export function verifyInitData(initData, botToken, { now = new Date(), maxAgeSec = MAX_AGE_SEC } = {}) {
  if (!botToken) throw new InitDataError('not_configured');
  const { hash, fields, text } = dataCheckString(initData);
  const expected = createHmac('sha256', webAppSecret(botToken)).update(text, 'utf8').digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new InitDataError('signature');
  const authDate = Number(fields.get('auth_date'));
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new InitDataError('auth_date');
  const nowSec = Math.floor(now.getTime() / 1000);
  if (authDate > nowSec + MAX_FUTURE_SEC) throw new InitDataError('auth_date_future');
  if (nowSec - authDate > maxAgeSec) throw new InitDataError('expired');
  let user;
  try {
    user = JSON.parse(fields.get('user') ?? 'null');
  } catch {
    throw new InitDataError('user');
  }
  if (!user || typeof user !== 'object' || !Number.isSafeInteger(user.id) || user.id <= 0) throw new InitDataError('user');
  return { user, authDate };
}
