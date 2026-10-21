// Проверка входящей команды — docs/protocol.md §3.1, шаги 1–2.
// Шаг 3 (seq и id) — lib/replay.mjs, шаг 4 (тип и тело) — lib/machine.mjs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIMITS, canonicalize, parseStrict } from './canonical.mjs';

export const PROTOCOL_VERSION = 1;
export const REQUIRED_FIELDS = Object.freeze(['v', 'id', 'seq', 'type', 'body']);

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSeq(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

/**
 * Строгое base64 (стандартный алфавит, с `=`). Неканоническая запись
 * (ненулевые хвостовые биты) не принимается: иначе прошивка, сравнивающая строки,
 * и симулятор, сравнивающий байты, разошлись бы.
 * @returns {Buffer | null}
 */
export function decodeBase64Strict(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) return null;
  return bytes;
}

/**
 * Разбирает и проверяет команду.
 * @param {Buffer | Uint8Array | string} payload байты из MQTT
 * @param {Buffer} key device_key, 32 байта
 * @returns {{
 *   status: 'ok' | 'bad_format' | 'bad_sig',
 *   reason?: string,
 *   cmd?: object,
 *   canonical?: string,
 *   echo: { cmdId: string | null, seq: number | null, type: string | null }
 * }}
 * `echo` — что можно вернуть в `ack`: только значения правильного вида, иначе null.
 */
export function verifyCommand(payload, key) {
  const echo = { cmdId: null, seq: null, type: null };
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (bytes.length > LIMITS.maxBytes) return { status: 'bad_format', reason: 'too_large', echo };

  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { status: 'bad_format', reason: 'not_utf8', echo };
  }

  const parsed = parseStrict(text);
  if (!parsed.ok) return { status: 'bad_format', reason: parsed.reason, echo };
  const msg = parsed.value;
  if (!isPlainObject(msg)) return { status: 'bad_format', reason: 'not_object', echo };

  if (isUuid(msg.id)) echo.cmdId = msg.id;
  if (isSeq(msg.seq)) echo.seq = msg.seq;
  if (typeof msg.type === 'string' && msg.type !== '') echo.type = msg.type;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(msg, field)) return { status: 'bad_format', reason: `missing_${field}`, echo };
  }
  if (msg.v !== PROTOCOL_VERSION) return { status: 'bad_format', reason: 'bad_v', echo };
  if (echo.cmdId === null) return { status: 'bad_format', reason: 'bad_id', echo };
  if (echo.seq === null) return { status: 'bad_format', reason: 'bad_seq', echo };
  if (echo.type === null) return { status: 'bad_format', reason: 'bad_type', echo };
  if (!isPlainObject(msg.body)) return { status: 'bad_format', reason: 'bad_body', echo };
  if (Object.hasOwn(msg, 'issued_at') && !Number.isSafeInteger(msg.issued_at)) {
    return { status: 'bad_format', reason: 'bad_issued_at', echo };
  }

  const canonical = canonicalize(msg, { omitTopLevel: 'sig' });

  // HMAC считается всегда, даже без sig: время ответа не зависит от того, что пришло.
  const expected = createHmac('sha256', key).update(canonical, 'utf8').digest();
  if (!Object.hasOwn(msg, 'sig')) return { status: 'bad_sig', reason: 'missing_sig', canonical, echo };
  const given = decodeBase64Strict(msg.sig);
  if (given === null) return { status: 'bad_sig', reason: 'sig_not_base64', canonical, echo };
  // Длина HMAC публична; само сравнение байтов — за постоянное время.
  const match = given.length === expected.length && timingSafeEqual(given, expected);
  if (!match) return { status: 'bad_sig', reason: 'sig_mismatch', canonical, echo };

  return { status: 'ok', cmd: msg, canonical, echo };
}
