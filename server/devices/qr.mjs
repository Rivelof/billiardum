// QR на корпусе контроллера (M5.1 №159): «BLD1:{device_id}:{claim_code}».
//
// device_id — UUID (в QR строчными), claim_code — код привязки с наклейки, 8…63 символа [A-Za-z0-9-]
// (он же пароль точки доступа WPA2, protocol §7); заводской —
// 16 символов Crockford Base32 группами по 4 через дефис (80 бит), например «7K2M-Q9XD-4HTB-R1VS».
// Разбор строгий: неверный префикс, UUID или код — null (маршрут отвечает 400 qr_invalid).
// Код сверяется как есть (с учётом регистра): его хеш sha256(device_id:код) — тот же, что у №67.

import { randomBytes } from 'node:crypto';

export const DEVICE_QR_PREFIX = 'BLD1';
const QR = /^BLD1:([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}):([A-Za-z0-9-]{8,63})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Заводской код привязки: XXXX-XXXX-XXXX-XXXX. */
export const FACTORY_CLAIM_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

/** Текст QR → { deviceId, claimCode } или null. Пробелы и перевод строки по краям отбрасываются. */
export function parseDeviceQr(text) {
  if (typeof text !== 'string' || text.length > 200) return null;
  const m = QR.exec(text.trim());
  if (!m) return null;
  return { deviceId: m[1].toLowerCase(), claimCode: m[2] };
}

/** { deviceId, claimCode } → текст QR. */
export function formatDeviceQr(deviceId, claimCode) {
  if (!UUID.test(deviceId)) throw new Error('formatDeviceQr: device_id');
  if (typeof claimCode !== 'string' || !/^[A-Za-z0-9-]{8,63}$/.test(claimCode)) throw new Error('formatDeviceQr: claim_code');
  return `${DEVICE_QR_PREFIX}:${deviceId}:${claimCode}`;
}

/** Новый заводской код привязки: 16 символов Crockford Base32 (80 бит) группами по 4. */
export function generateClaimCode(random = randomBytes) {
  const bytes = random(10);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let s = '';
  for (let i = 15; i >= 0; i -= 1) s += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return s.match(/.{4}/g).join('-');
}
