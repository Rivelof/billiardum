// Проверка входящей команды — docs/protocol.md §3 и §3.1, шаги 1–2.
// Шаг 3 (seq и id) — lib/replay.mjs, шаг 4 (тип и тело) — lib/body.mjs и lib/machine.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIMITS, canonicalize, parseStrict } from './canonical.mjs';

export const PROTOCOL_VERSION = 1;
export const REQUIRED_FIELDS = Object.freeze(['v', 'id', 'seq', 'type', 'issued_at', 'body']);

// UUID в нижнем регистре (§3, таблица полей).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Ровно 44 символа: base64 от 32 байт, один `=` в конце. Последний значащий символ
// несёт 2 лишних бита — они нулевые, иначе запись неканоническая.
const SIG = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Строгое base64 (стандартный алфавит, с `=`, канонические хвостовые биты) — для device_key в конфиге.
 * @returns {Buffer | null}
 */
export function decodeBase64Strict(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  return bytes;
}

/** `sig` по §3: ровно 44 символа base64 от 32 байт, иначе null. */
export function decodeSig(value) {
  if (typeof value !== 'string' || !SIG.test(value)) return null;
  return Buffer.from(value, 'base64');
}

const badFormat = (reason) => ({ status: 'bad_format', reason, echo: { cmdId: null, seq: null, type: null } });

/**
 * Разбирает и проверяет команду: шаг 1 (`bad_format`) и шаг 2 (`bad_sig`).
 * @param {Buffer | Uint8Array | string} payload байты из MQTT
 * @param {Buffer} key device_key, 32 байта
 * @returns {{
 *   status: 'ok' | 'bad_format' | 'bad_sig',
 *   reason?: string,
 *   cmd?: object,
 *   canonical?: string,
 *   echo: { cmdId: string | null, seq: number | null, type: string | null }
 * }}
 * `echo` — что вернуть в `ack`. После `bad_format` там всегда null (§4).
 */
export function verifyCommand(payload, key) {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (bytes.length > LIMITS.maxBytes) return badFormat('too_large');

  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return badFormat('not_utf8');
  }

  const parsed = parseStrict(text);
  if (!parsed.ok) return badFormat(parsed.reason);
  const msg = parsed.value;
  if (!isPlainObject(msg)) return badFormat('not_object');

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(msg, field)) return badFormat(`missing_${field}`);
  }
  if (msg.v !== PROTOCOL_VERSION) return badFormat('bad_v');
  if (!isUuid(msg.id)) return badFormat('bad_id');
  if (!Number.isSafeInteger(msg.seq) || msg.seq < 1) return badFormat('bad_seq');
  if (typeof msg.type !== 'string' || msg.type === '') return badFormat('bad_type');
  if (!Number.isSafeInteger(msg.issued_at) || msg.issued_at < 0) return badFormat('bad_issued_at');
  if (!isPlainObject(msg.body)) return badFormat('bad_body_not_object');

  const echo = { cmdId: msg.id, seq: msg.seq, type: msg.type };
  const canonical = canonicalize(msg, { omitTopLevel: 'sig' });

  // HMAC считается всегда, даже без sig: время ответа не зависит от того, что пришло.
  const expected = createHmac('sha256', key).update(canonical, 'utf8').digest();
  if (!Object.hasOwn(msg, 'sig')) return { status: 'bad_sig', reason: 'missing_sig', canonical, echo };
  const given = decodeSig(msg.sig);
  if (given === null) return { status: 'bad_sig', reason: 'sig_format', canonical, echo };
  // Обе стороны — 32 байта; само сравнение — за постоянное время.
  if (!timingSafeEqual(given, expected)) return { status: 'bad_sig', reason: 'sig_mismatch', canonical, echo };

  return { status: 'ok', cmd: msg, canonical, echo };
}
