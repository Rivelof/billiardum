// Web Push на node:crypto без внешних пакетов.
// * Шифрование тела — RFC 8291 (Message Encryption for Web Push) поверх RFC 8188
//   (aes128gcm): одна запись, rs = 4096, keyid — открытый ключ отправителя (65 байт).
// * Авторизация — VAPID, RFC 8292: JWT ES256 {aud, exp, sub}, заголовок
//   Authorization: vapid t=<jwt>, k=<открытый ключ>.
// В теле нет персональных данных (decisions №53): только стол и время.

import { createCipheriv, createDecipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { httpRequest } from '../lib/http-client.mjs';

export const RECORD_SIZE = 4096;
export const VAPID_TTL_SEC = 12 * 3600;
/** Push-сервисы браузеров (Chrome и Яндекс Браузер — FCM, Firefox — Mozilla, Safari — Apple, Edge — WNS). */
export const DEFAULT_PUSH_HOSTS = ['fcm.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (text) => Buffer.from(text, 'base64url');

/**
 * Зашифровать тело push-сообщения (RFC 8291 §3.4, RFC 8188 §2).
 * @param {Buffer} plaintext
 * @param {{ p256dh: string, auth: string }} keys ключи подписки (base64url)
 * @param {{ salt?: Buffer, asPrivateKey?: Buffer, padding?: number }} [options] для тестового вектора RFC 8291
 * @returns {Buffer} заголовок (salt ‖ rs ‖ idlen ‖ keyid) ‖ шифртекст
 */
export function encryptPayload(plaintext, { p256dh, auth }, { salt = randomBytes(16), asPrivateKey = null, padding = 0 } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('webpush: p256dh — точка P-256 без сжатия');
  if (authSecret.length !== 16) throw new Error('webpush: auth — 16 байт');
  if (salt.length !== 16) throw new Error('webpush: salt — 16 байт');
  const ecdh = createECDH('prime256v1');
  if (asPrivateKey) ecdh.setPrivateKey(asPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // RFC 8291 §3.3: IKM из общего секрета ECDH и auth.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  // RFC 8188 §2.2: ключ и nonce записи.
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);

  // Одна (последняя) запись: данные ‖ 0x02 ‖ нули дополнения.
  const record = Buffer.concat([plaintext, Buffer.from([2]), Buffer.alloc(padding)]);
  if (record.length + 16 > RECORD_SIZE) throw new Error('webpush: тело больше одной записи');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * Расшифровать (сторона браузера; для тестов): нужен закрытый ключ подписки.
 * @param {Buffer} body
 * @param {{ uaPrivateKey: Buffer, auth: string }} keys
 */
export function decryptPayload(body, { uaPrivateKey, auth }) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  if (ciphertext.length > rs) throw new Error('webpush: больше одной записи');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const uaPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(asPublic);
  const prkKey = hmac(fromB64u(auth), ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  if (end < 0 || record[end] !== 2) throw new Error('webpush: нет разделителя последней записи');
  return record.subarray(0, end);
}

/**
 * Ключи VAPID из .env: открытый — 65 байт (base64url), закрытый — 32 байта (base64url).
 * @returns {{ publicKey: string, key: import('node:crypto').KeyObject, subject: string }}
 */
export function loadVapid({ publicKey, privateKey, subject }) {
  const pub = fromB64u(publicKey ?? '');
  const priv = fromB64u(privateKey ?? '');
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID_PUBLIC_KEY — точка P-256 без сжатия, 65 байт base64url');
  if (priv.length !== 32) throw new Error('VAPID_PRIVATE_KEY — 32 байта base64url');
  const check = createECDH('prime256v1');
  check.setPrivateKey(priv);
  if (!check.getPublicKey().equals(pub)) throw new Error('VAPID: открытый ключ не от этого закрытого');
  if (typeof subject !== 'string' || !/^(mailto:|https:\/\/)/.test(subject)) throw new Error('VAPID_SUBJECT — mailto: или https://');
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return { publicKey: b64u(pub), key, subject };
}

/** JWT VAPID (RFC 8292 §2): ES256, aud — origin push-сервиса, exp ≤ 24 ч. */
export function vapidJwt(vapid, endpoint, { now = new Date(), ttlSec = VAPID_TTL_SEC } = {}) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(now.getTime() / 1000) + ttlSec, sub: vapid.subject }));
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(sig)}`;
}

/** Адрес подписки разрешён: https, известный push-сервис, без IP и нестандартного порта (SSRF). */
export function endpointAllowed(endpoint, hosts = DEFAULT_PUSH_HOSTS) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => (h.startsWith('.') ? host.endsWith(h) && host.length > h.length : host === h));
}

/**
 * Отправить push. Возвращает { status: 'sent' | 'gone' | 'failed', code }.
 * gone — подписка больше не действует (404, 410): её нужно отозвать.
 */
export async function sendPush(subscription, payload, { vapid, ttlSec = 3600, urgency = 'normal', request = httpRequest, now = new Date(), hosts = DEFAULT_PUSH_HOSTS }) {
  if (!endpointAllowed(subscription.endpoint, hosts)) return { status: 'failed', code: 'endpoint_not_allowed' };
  const body = encryptPayload(Buffer.from(JSON.stringify(payload), 'utf8'), subscription);
  let res;
  try {
    res = await request(subscription.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(ttlSec),
        urgency,
        authorization: `vapid t=${vapidJwt(vapid, subscription.endpoint, { now })}, k=${vapid.publicKey}`,
      },
      body,
      timeoutMs: 10_000,
      maxBytes: 64 * 1024,
    });
  } catch (err) {
    return { status: 'failed', code: err?.code ?? 'network' };
  }
  if (res.status >= 200 && res.status < 300) return { status: 'sent', code: `http_${res.status}` };
  if (res.status === 404 || res.status === 410) return { status: 'gone', code: `http_${res.status}` };
  return { status: 'failed', code: `http_${res.status}` };
}
