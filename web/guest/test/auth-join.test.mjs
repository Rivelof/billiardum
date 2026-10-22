import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { errorMessage } from '@billiardum/shared/errors';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};

test('вход через бота: в ответе код с экрана из 6 цифр', async () => {
  const b = createBackend({ ...memory(), now: () => Date.parse('2026-10-22T15:00:00Z') });
  const link = (await b.handle('POST', '/api/auth/bot-link', { channel: 'telegram' })).body;
  assert.match(link.code, /^\d{6}$/);
  assert.ok(link.deep_link.startsWith('https://t.me/'));
});

test('«Я играю за этим столом»: анониму стол без session_id, присоединение — с кодом стола', async () => {
  const b = createBackend({ ...memory(), now: () => Date.parse('2026-10-22T15:00:00Z') });
  const anon = (await b.handle('GET', '/api/t/7H3D2RT9QF')).body;
  assert.equal(anon.status, 'busy');
  assert.equal(anon.session_id, null);
  await b.handle('POST', '/api/auth/dev', { phone: '+79001234567' });
  await b.handle('POST', '/api/auth/consent', { version: 'x' });
  const t = (await b.handle('GET', '/api/t/7H3D2RT9QF')).body;
  assert.ok(t.session_id);
  assert.equal((await b.handle('POST', `/api/sessions/${t.session_id}/join`, {})).body.error, 'bad_request');
  assert.equal((await b.handle('POST', `/api/sessions/${t.session_id}/join`, { code: '7H3D2RT9QF' })).status, 200);
});

test('booking_start_required — текст гостю про старт по брони', () => {
  const m = errorMessage({ code: 'booking_start_required' });
  assert.match(m.title, /брони/);
  assert.equal(errorMessage({ code: 'booking_start_required' }, { audience: 'staff' }).title, 'Стол ждёт гостя по брони.');
});
