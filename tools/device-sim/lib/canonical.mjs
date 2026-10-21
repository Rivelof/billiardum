// Строгий разбор JSON и каноническая строка — docs/protocol.md §3.1.
// Независимая реализация: код server/ сюда не импортируется, чтобы общие векторы
// docs/protocol-vectors.json ловили расхождения между сервером и контроллером.

const MAX_SAFE = (1n << 53n) - 1n;

// Целое без знака «+», ведущих нулей, точки и экспоненты.
const INTEGER_SOURCE = /^-?(?:0|[1-9][0-9]*)$/;

// Печатный ASCII 0x20–0x7E без «"» (0x22) и «\» (0x5C).
const PRINTABLE = /^[\x20\x21\x23-\x5B\x5D-\x7E]*$/;

// Пределы симулятора (в протоколе не заданы, предложены в ревью M0).
// Буфер MQTT на ESP32 конечен, а у ArduinoJson есть предел вложенности.
export const LIMITS = Object.freeze({ maxBytes: 4096, maxDepth: 8 });

if (!supportsSourceText()) {
  throw new Error('JSON.parse без context.source: нужен Node 22 и новее');
}

function supportsSourceText() {
  let seen = false;
  JSON.parse('1', (key, value, context) => {
    seen = context?.source === '1';
    return value;
  });
  return seen;
}

export class FormatError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'FormatError';
    this.reason = reason;
  }
}

/**
 * Разбирает текст как JSON по правилам §3.1.
 * Числа проверяются по исходному тексту (третий аргумент reviver, context.source):
 * `1.0`, `9e5`, числа вне ±(2^53−1) — ошибка, даже если значение целое.
 * Строки и ключи — печатный ASCII без `"` и `\`; поле `sig` разрешено только на верхнем уровне.
 * @param {string} text
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function parseStrict(text) {
  let numberError = null;
  let value;
  try {
    value = JSON.parse(text, (key, val, context) => {
      if (typeof val === 'number' && numberError === null) {
        numberError = checkNumberSource(context?.source);
      }
      return val;
    });
  } catch {
    return { ok: false, reason: 'json_syntax' };
  }
  if (numberError) return { ok: false, reason: numberError };
  try {
    checkTree(value, 0);
  } catch (err) {
    if (err instanceof FormatError) return { ok: false, reason: err.reason };
    throw err;
  }
  return { ok: true, value };
}

function checkNumberSource(source) {
  if (typeof source !== 'string' || !INTEGER_SOURCE.test(source)) return 'number_not_integer';
  const n = BigInt(source);
  if (n > MAX_SAFE || n < -MAX_SAFE) return 'number_out_of_range';
  return null;
}

function checkTree(node, depth) {
  if (node === null || typeof node === 'boolean' || typeof node === 'number') return;
  if (typeof node === 'string') {
    if (!PRINTABLE.test(node)) throw new FormatError('string_charset');
    return;
  }
  if (depth >= LIMITS.maxDepth) throw new FormatError('too_deep');
  if (Array.isArray(node)) {
    for (const item of node) checkTree(item, depth + 1);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!PRINTABLE.test(key)) throw new FormatError('key_charset');
    if (depth > 0 && key === 'sig') throw new FormatError('nested_sig');
    checkTree(node[key], depth + 1);
  }
}

/**
 * Каноническая строка значения: ключи по возрастанию байтов на всех уровнях,
 * разделители `,` и `:`, без пробелов; строки без экранирования; только безопасные целые.
 * @param {unknown} node
 * @param {{ omitTopLevel?: string }} [options] ключ верхнего уровня, который не входит в строку (`sig`)
 * @returns {string}
 */
export function canonicalize(node, options = {}) {
  return emit(node, options.omitTopLevel ?? null);
}

function emit(node, omit) {
  if (node === null) return 'null';
  if (node === true) return 'true';
  if (node === false) return 'false';
  if (typeof node === 'number') {
    if (!Number.isSafeInteger(node)) throw new FormatError('number_not_integer');
    return Object.is(node, -0) ? '0' : String(node);
  }
  if (typeof node === 'string') {
    if (!PRINTABLE.test(node)) throw new FormatError('string_charset');
    return `"${node}"`;
  }
  if (Array.isArray(node)) {
    return `[${node.map((item) => emit(item, null)).join(',')}]`;
  }
  if (typeof node === 'object') {
    const keys = Object.keys(node).filter((key) => key !== omit).sort(compareBytes);
    const parts = keys.map((key) => {
      if (!PRINTABLE.test(key)) throw new FormatError('key_charset');
      return `"${key}":${emit(node[key], null)}`;
    });
    return `{${parts.join(',')}}`;
  }
  throw new FormatError('unsupported_value');
}

// Ключи уже проверены на ASCII: сравнение кодов UTF-16 совпадает со сравнением байтов.
function compareBytes(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function isPrintableAscii(value) {
  return typeof value === 'string' && PRINTABLE.test(value);
}
