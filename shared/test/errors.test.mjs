import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage, errorCode, KNOWN_CODES } from '../errors.mjs';
import { ApiError } from '../api.mjs';

// Общий словарь контракта M1 §3 — у каждого кода есть текст
const CONTRACT = [
  'bad_request', 'unauthorized', 'forbidden', 'not_found', 'rate_limited', 'table_busy', 'table_pending', 'table_offline',
  'table_service', 'quote_expired', 'quote_used', 'payment_failed', 'payment_pending', 'session_not_active', 'not_payer',
  'reason_required', 'limit_exceeded', 'consent_required', 'phone_required', 'idempotency_conflict',
  'no_tariff', // дополнение backend-money
  'phone_conflict', 'not_configured', 'internal', 'method_not_allowed', // №63–64
];

test('у каждого кода контракта есть текст: что случилось и что делать', () => {
  for (const code of CONTRACT) {
    assert.ok(KNOWN_CODES.includes(code), code);
    for (const audience of ['guest', 'staff']) {
      const m = errorMessage(code, { audience });
      assert.equal(m.code, code);
      assert.match(m.title, /[А-ЯЁ].*\.$/u, `${code}: заголовок — предложение`);
      assert.match(m.action, /[А-ЯЁ].*[.!]$/u, `${code}: действие — предложение`);
      assert.equal(m.text, `${m.title} ${m.action}`);
      assert.doesNotMatch(m.text, /\b[a-z_]{4,}\b/, `${code}: без кодов и английских слов в тексте`);
    }
  }
});

test('неизвестный код, сеть и обычная ошибка', () => {
  assert.equal(errorMessage('something_new').code, 'something_new');
  assert.match(errorMessage('something_new').title, /Не получилось/);
  assert.equal(errorCode(new TypeError('Failed to fetch')), 'network');
  assert.equal(errorCode(new Error('x')), 'unknown');
  assert.equal(errorCode(new ApiError('table_busy', { status: 409 })), 'table_busy');
  assert.match(errorMessage(new ApiError('network')).text, /интернет/);
});

test('гостю и персоналу — разные тексты, где это важно', () => {
  assert.notEqual(errorMessage('forbidden', { audience: 'guest' }).text, errorMessage('forbidden', { audience: 'staff' }).text);
  assert.match(errorMessage('unauthorized', { audience: 'guest' }).action, /MAX или Telegram/);
});

test('«Стол занят до 21:40» — время подставляется (DESIGN §7)', () => {
  assert.equal(errorMessage('table_busy', { busyUntil: '21:40' }).title, 'Стол занят до 21:40.');
  assert.equal(errorMessage('table_busy').title, 'Стол уже занят.');
});
