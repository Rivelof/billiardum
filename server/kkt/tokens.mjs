// Токен моста ККТ (decisions №77): base64url(16 байт club_id ‖ 32 случайных байта) — 64 символа.
// Клуб читается из токена, строка моста ищется по sha256 токена в контексте этого клуба (RLS):
// узкая функция SECURITY DEFINER не нужна. Подделанный клуб в токене — строки нет, отказ.
// В базе только sha256 (hex); токен показывается владельцу один раз.

import { createHash, randomBytes } from 'node:crypto';

const TOKEN = /^[A-Za-z0-9_-]{64}$/;

function uuidToBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Новый токен моста клуба: { token, hash }. */
export function newBridgeToken(clubId) {
  const token = Buffer.concat([uuidToBytes(clubId), randomBytes(32)]).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Клуб из токена или null (неверный вид). */
export function clubOfToken(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 48) return null;
  const uuid = bytesToUuid(raw.subarray(0, 16));
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) ? uuid : null;
}

/** Токен из заголовка Authorization: Bearer … */
export function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  return m ? m[1] : null;
}
