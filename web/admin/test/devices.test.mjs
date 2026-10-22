import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceId, parseClaimCode, signalWord, capsWords, noCurrentSensor } from '../src/lib/devices.js';

test('ввод с наклейки контроллера', () => {
  assert.equal(parseDeviceId(' D1000000-0000-4000-8000-000000000009 '), 'd1000000-0000-4000-8000-000000000009');
  assert.equal(parseDeviceId('d1000000-0000-4000-8000-00000000000'), null);
  assert.equal(parseDeviceId(''), null);
  assert.equal(parseClaimCode('AB12 CD34'), 'AB12CD34');
  assert.equal(parseClaimCode('abc-123'), 'abc-123');
  assert.equal(parseClaimCode('12345'), null, 'короче 6 знаков');
  assert.equal(parseClaimCode('код123'), null, 'только латиница');
  assert.equal(parseClaimCode('x'.repeat(65)), null);
});

test('сигнал и возможности словами', () => {
  assert.equal(signalWord(-55), 'отличный');
  assert.equal(signalWord(-65), 'хороший');
  assert.equal(signalWord(-75), 'слабый');
  assert.equal(signalWord(-90), 'очень слабый');
  assert.equal(signalWord(null), null);
  assert.deepEqual(capsWords(['buzzer', 'current', 'led', 'relay']), ['реле', 'датчик тока', 'индикатор', 'пищалка']);
  assert.deepEqual(capsWords(undefined), []);
  assert.equal(noCurrentSensor({ id: 'd', caps: ['relay', 'led'] }), true);
  assert.equal(noCurrentSensor({ id: 'd', caps: ['relay', 'current'] }), false);
  assert.equal(noCurrentSensor({ id: null, caps: [] }), false);
});
