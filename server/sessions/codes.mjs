// Код стола (decisions №47): 10 символов Crockford Base32 (50 бит), не связан с номером стола.
// Ввод нормализуется по правилам Crockford: регистр не важен, I и L читаются как 1, O как 0,
// дефисы и пробелы игнорируются. U в алфавите нет.

import { randomBytes } from 'node:crypto';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 10;
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/** Канонический код или null, если строка не код стола. */
export function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 32) return null;
  const s = input
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CODE.test(s) ? s : null;
}

export function isCode(value) {
  return typeof value === 'string' && CODE.test(value);
}

/** Случайный код (для тестов и перевыпуска; в базе — bl.gen_resource_code()). */
export function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}
