// Протокол контроллера v1 (docs/protocol.md §2, §3): строгий JSON, канонический JSON,
// подпись HMAC-SHA256, проверка команды. Тест — все векторы docs/protocol-vectors.json.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const TOPIC_PREFIX = 'bl/v1';
export const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 − 1
/** Предельные размеры сообщений, байт (§2). */
export const MAX_CMD_BYTES = 2048;
export const MAX_STATE_BYTES = 4096;
export const MAX_EVENT_BYTES = 4096;
const INTEGER_SOURCE = /^(0|-?[1-9][0-9]*)$/; // без +, ведущих нулей, точки, экспоненты и -0
const PRINTABLE_ASCII = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/; // 0x20–0x7E без " и \
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SIG = /^[A-Za-z0-9+/]{43}=$/; // ровно 44 символа: base64 от 32 байт
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const badFormat = (message) => new ProtocolError('bad_format', message);

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Ключ устройства: 32 байта (Buffer) или base64-строка с ними.
 * @returns {Buffer}
 */
export function deviceKey(key) {
  const buf = Buffer.isBuffer(key) ? key : decodeBase64Strict(key);
  if (!buf || buf.length !== 32) throw new Error('device_key должен быть 32 байта');
  return buf;
}

/** Строгий base64 (стандартный алфавит, с =). null — если строка не base64. */
export function decodeBase64Strict(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  return Buffer.from(text, 'base64');
}

function checkString(value, where) {
  if (!PRINTABLE_ASCII.test(value)) throw badFormat(`строка ${where}: только печатный ASCII без " и \\`);
}

function checkNumber(value, source, where) {
  if (source !== undefined && !INTEGER_SOURCE.test(source)) throw badFormat(`число ${where} записано не как целое`);
  if (!Number.isInteger(value) || Object.is(value, -0)) throw badFormat(`число ${where} не целое`);
  // Значение сравнивается по исходному тексту: 9007199254740993 разбирается в 2^53.
  const exact = source !== undefined ? BigInt(source) : BigInt(value);
  if (exact > BigInt(MAX_SAFE) || exact < -BigInt(MAX_SAFE)) throw badFormat(`число ${where} вне ±(2^53−1)`);
}

/**
 * Каноническая строка значения (docs/protocol.md §3.1): ключи по возрастанию байтов,
 * без пробелов, только целые числа, строки — печатный ASCII без " и \.
 * Бросает ProtocolError('bad_format'), если значение не канонизируется.
 */
export function canonicalize(value, where = '$') {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      checkNumber(value, undefined, where);
      return String(value);
    case 'string':
      checkString(value, where);
      return `"${value}"`;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => canonicalize(v, `${where}[${i}]`)).join(',')}]`;
      }
      const keys = Object.keys(value);
      for (const k of keys) checkString(k, `ключ ${where}.${k}`);
      // Ключи — ASCII, поэтому порядок кодовых единиц UTF-16 совпадает с порядком байтов.
      keys.sort();
      return `{${keys.map((k) => `"${k}":${canonicalize(value[k], `${where}.${k}`)}`).join(',')}}`;
    }
    default:
      throw badFormat(`значение ${where} типа ${typeof value} недопустимо`);
  }
}

/**
 * Повторяющиеся ключи. Вызывается после JSON.parse и проверки на обратную косую черту:
 * текст — корректный JSON, а каждая строка — от кавычки до следующей кавычки.
 */
function assertNoDuplicateKeys(raw) {
  const stack = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      const end = raw.indexOf('"', i + 1);
      let j = end + 1;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\t' || raw[j] === '\n' || raw[j] === '\r')) j += 1;
      if (raw[j] === ':') {
        const keys = stack.at(-1);
        const key = raw.slice(i + 1, end);
        if (keys.has(key)) throw badFormat(`повторяющийся ключ ${key}`);
        keys.add(key);
      }
      i = end;
    } else if (ch === '{') {
      stack.push(new Set());
    } else if (ch === '[') {
      stack.push(null);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }
}

/**
 * Строгий разбор (§3.1): JSON по RFC 8259 без обратной косой черты где угодно,
 * без повторяющихся ключей, числа проверяются по исходному тексту (reviver, context.source):
 * только целые в ±(2^53−1), без точки, экспоненты, ведущих нулей и -0.
 * Бросает ProtocolError('bad_format').
 */
export function parseStrict(text) {
  const raw = Buffer.isBuffer(text) ? text.toString('utf8') : text;
  if (typeof raw !== 'string') throw badFormat('сообщение не строка');
  if (raw.includes('\\')) throw badFormat('экранирование запрещено');
  let value;
  try {
    value = JSON.parse(raw, function reviver(key, v, context) {
      if (typeof v === 'number') checkNumber(v, context?.source, key || '$');
      return v;
    });
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw badFormat('JSON не разбирается');
  }
  assertNoDuplicateKeys(raw);
  return value;
}

function assertNoNestedSig(value, depth) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) assertNoNestedSig(v, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (depth > 0 && k === 'sig') throw badFormat('поле sig допустимо только на верхнем уровне');
    assertNoNestedSig(v, depth + 1);
  }
}

/** Каноническая строка команды: объект без sig верхнего уровня. */
export function canonicalCommand(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) throw badFormat('команда не объект');
  assertNoNestedSig(cmd, 0);
  const { sig: _sig, ...rest } = cmd;
  return canonicalize(rest);
}

export function signCanonical(canonical, key) {
  return createHmac('sha256', deviceKey(key)).update(canonical, 'utf8').digest('base64');
}

/** Обязательные поля и форматы (§3): иначе bad_format. */
function checkRequired(cmd) {
  if (cmd === null || typeof cmd !== 'object' || Array.isArray(cmd)) throw badFormat('команда не объект');
  if (cmd.v !== PROTOCOL_VERSION) throw badFormat('v не 1');
  if (!isUuid(cmd.id)) throw badFormat('id — UUID в нижнем регистре');
  if (!Number.isSafeInteger(cmd.seq) || cmd.seq < 1) throw badFormat('seq — целое ≥ 1');
  if (typeof cmd.type !== 'string' || cmd.type.length === 0) throw badFormat('type — непустая строка');
  if (!Number.isSafeInteger(cmd.issued_at) || cmd.issued_at < 0) throw badFormat('issued_at — целое ≥ 0');
  if (cmd.body === null || typeof cmd.body !== 'object' || Array.isArray(cmd.body)) throw badFormat('body — объект');
}

/** sig: ровно 44 символа канонического base64 от 32 байт. null — иначе (bad_sig). */
function decodeSig(sig) {
  if (typeof sig !== 'string' || !SIG.test(sig)) return null;
  const buf = Buffer.from(sig, 'base64');
  return buf.length === 32 && buf.toString('base64') === sig ? buf : null;
}

/**
 * Проверка входящей команды в порядке контроллера (§3.1): bad_format → bad_sig.
 * seq и тип здесь не проверяются (это состояние устройства).
 * @returns {{ result: 'ok' | 'bad_format' | 'bad_sig', cmd?: object, canonical?: string }}
 */
export function verifyCommand(raw, key) {
  let cmd;
  let canonical;
  try {
    const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw), 'utf8');
    if (bytes > MAX_CMD_BYTES) throw badFormat(`команда длиннее ${MAX_CMD_BYTES} байт`);
    cmd = parseStrict(raw);
    checkRequired(cmd);
    canonical = canonicalCommand(cmd);
  } catch (err) {
    if (err instanceof ProtocolError) return { result: err.code };
    throw err;
  }
  const expected = createHmac('sha256', deviceKey(key)).update(canonical, 'utf8').digest();
  const got = decodeSig(cmd.sig);
  if (!got || !timingSafeEqual(got, expected)) {
    return { result: 'bad_sig', cmd, canonical };
  }
  return { result: 'ok', cmd, canonical };
}

/**
 * Собирает и подписывает команду. Возвращает объект и JSON для публикации
 * (поля в каноническом порядке, sig последним).
 */
export function buildCommand({ id = randomUUID(), seq, type, body = {}, issuedAt = Math.floor(Date.now() / 1000) }, key) {
  const cmd = { v: PROTOCOL_VERSION, id, seq, type, issued_at: issuedAt, body };
  checkRequired(cmd);
  const canonical = canonicalCommand(cmd);
  const sig = signCanonical(canonical, key);
  const payload = `${canonical.slice(0, -1)},"sig":"${sig}"}`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_CMD_BYTES) throw badFormat(`команда длиннее ${MAX_CMD_BYTES} байт`);
  return { cmd: { ...cmd, sig }, canonical, payload };
}

/** Топик устройства: bl/v1/{club_id}/{device_id}/{kind}. */
export function deviceTopic(clubId, deviceId, kind) {
  return `${TOPIC_PREFIX}/${clubId}/${deviceId}/${kind}`;
}

/** Разбор топика устройства; null — если топик не наш. */
export function parseDeviceTopic(topic) {
  const parts = topic.split('/');
  if (parts.length !== 5 || `${parts[0]}/${parts[1]}` !== TOPIC_PREFIX) return null;
  const [, , clubId, deviceId, kind] = parts;
  if (!isUuid(clubId) || !isUuid(deviceId)) return null;
  if (!['cmd', 'ack', 'state', 'event', 'status'].includes(kind)) return null;
  return { clubId, deviceId, kind };
}
