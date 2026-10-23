import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { isTestClub } from '../src/lib/testmode.js';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const SESSION = '6f1c2a9e-0d4b-4c7e-9a51-3b2f8e7d4c10';

test('M5.1: тестовый режим клуба — по club.mode, mode или is_test; иначе плашки нет', () => {
  assert.equal(isTestClub({ club: { mode: 'test' } }), true);
  assert.equal(isTestClub({ mode: 'test' }), true);
  assert.equal(isTestClub({ is_test: true }), true);
  assert.equal(isTestClub({ club: { mode: 'live' } }), false);
  assert.equal(isTestClub({ club: {} }), false);
  assert.equal(isTestClub(null), false);
  assert.equal(isTestClub('test'), false);
});

test('M5.1: заглушка — testclub отдаёт club.mode = test на столе, testgame — и в игре; обычный клуб — live', async () => {
  const b = createBackend({ ...memory(), now: () => Date.parse('2026-10-23T15:00:00Z') });
  b.scenario('testclub');
  assert.equal((await b.handle('GET', '/api/t/4K7P9QW2XM')).body.club.mode, 'test');
  b.scenario('testgame');
  const s = (await b.handle('GET', `/api/sessions/${SESSION}`)).body;
  assert.equal(isTestClub(s), true);
  b.scenario('game');
  assert.equal(isTestClub((await b.handle('GET', '/api/t/4K7P9QW2XM')).body), false);
});
