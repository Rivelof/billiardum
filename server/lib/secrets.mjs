// Шифрование секретов в базе (decisions №23): device_key, позже ключи ЮKassa.
// AES-256-GCM, ключ SECRETS_ENC_KEY (32 байта в base64) только в .env.
// Формат: "v1:" + base64(iv[12] || tag[16] || ciphertext).
// context (AAD) привязывает шифртекст к записи: ключ устройства A,
// переложенный в строку устройства B, не расшифруется.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';
const IV_LEN = 12;
const TAG_LEN = 16;

export class SecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretsError';
  }
}

/** Ключ из SECRETS_ENC_KEY: строго 32 байта в base64. Значение в ошибку не попадает. */
export function loadEncKey(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) {
    throw new SecretsError('SECRETS_ENC_KEY должен быть 32 байтами в base64 (44 символа)');
  }
  return Buffer.from(b64, 'base64');
}

function checkKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new SecretsError('ключ шифрования — 32 байта');
}

function aad(context) {
  if (typeof context !== 'string' || context.length === 0) throw new SecretsError('нужен контекст шифрования');
  return Buffer.from(`bl.secret/${context}`, 'utf8');
}

/** @param {Buffer|string} plaintext @param {Buffer} key @param {string} context */
export function encryptSecret(plaintext, key, context) {
  checkKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(aad(context));
  const data = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** @returns {Buffer} */
export function decryptSecret(encoded, key, context) {
  checkKey(key);
  if (typeof encoded !== 'string' || !encoded.startsWith(PREFIX)) throw new SecretsError('неизвестный формат секрета');
  const raw = Buffer.from(encoded.slice(PREFIX.length), 'base64');
  if (raw.length < IV_LEN + TAG_LEN) throw new SecretsError('секрет повреждён');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(aad(context));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SecretsError('секрет не расшифровывается: другой ключ, другая запись или подмена');
  }
}

/** Контекст для device_key: привязка к device_id. */
export function deviceKeyContext(deviceId) {
  return `device_key/${deviceId}`;
}
