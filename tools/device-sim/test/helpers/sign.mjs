// Тестовая подпись команд — отдельная от lib/ реализация канонизации
// (через JSON.stringify с отсортированными ключами), чтобы тесты не проверяли
// код симулятора им же самим. Годится только для команд из печатного ASCII.

import { createHmac, randomUUID } from 'node:crypto';

export const TEST_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => 0xa0 ^ i)).toString('base64');

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

export function testCanonical(cmd) {
  const { sig: _omit, ...rest } = cmd;
  return JSON.stringify(sortDeep(rest));
}

export function testSig(cmd, keyB64 = TEST_KEY_B64) {
  return createHmac('sha256', Buffer.from(keyB64, 'base64')).update(testCanonical(cmd), 'utf8').digest('base64');
}

/** Команда протокола v1 без подписи. */
export function makeCommand({ seq, type = 'ping', body = {}, id = randomUUID() }) {
  return { v: 1, id, seq, type, issued_at: 1792598400 + seq, body };
}

/** Подписанная команда как строка JSON (поля в произвольном порядке — как у сервера). */
export function signed(cmd, keyB64 = TEST_KEY_B64) {
  return JSON.stringify({ ...cmd, sig: testSig(cmd, keyB64) });
}
