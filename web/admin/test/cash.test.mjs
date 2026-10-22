import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRubles, changeFor, quickSums, keypad, groupDigits } from '../src/lib/cash.js';

test('полученная сумма из ввода кассира — в копейках', () => {
  assert.equal(parseRubles('2000'), 200000);
  assert.equal(parseRubles('2 000'), 200000);
  assert.equal(parseRubles('2 000 ₽'), 200000);
  assert.equal(parseRubles('2000,50'), 200050);
  assert.equal(parseRubles('2000.5'), 200050);
  assert.equal(parseRubles('0'), 0);
  assert.equal(parseRubles(''), null);
  assert.equal(parseRubles('-100'), null);
  assert.equal(parseRubles('12,345'), null, 'не больше двух знаков копеек');
  assert.equal(parseRubles('1e3'), null);
  assert.equal(parseRubles('abc'), null);
  assert.equal(parseRubles('999999999'), null, 'слишком длинное число — опечатка');
  assert.equal(parseRubles(undefined), null);
});

test('сдача и нехватка, без плавающей точки', () => {
  assert.deepEqual(changeFor(160000, 200000), { enough: true, change: 40000, short: 0 });
  assert.deepEqual(changeFor(160000, 160000), { enough: true, change: 0, short: 0 });
  assert.deepEqual(changeFor(160000, 150000), { enough: false, change: 0, short: 10000 });
  assert.deepEqual(changeFor(174050, 200000), { enough: true, change: 25950, short: 0 });
  assert.deepEqual(changeFor(160000, null), { enough: false, change: 0, short: 160000 });
  assert.throws(() => changeFor(1600.5, 2000), TypeError);
});

test('быстрые суммы: без сдачи, до 500 и 1000 ₽, крупная купюра', () => {
  assert.deepEqual(quickSums(160000), [160000, 200000, 500000]);
  assert.deepEqual(quickSums(80000), [80000, 100000, 500000]);
  assert.deepEqual(quickSums(174000), [174000, 200000, 500000]);
  assert.deepEqual(quickSums(480000), [480000, 500000]);
  assert.deepEqual(quickSums(500000), [500000]);
  assert.deepEqual(quickSums(523000), [523000, 550000, 600000, 1000000]);
});

test('экранная клавиатура', () => {
  assert.equal(keypad('', '2'), '2');
  assert.equal(keypad('2', '00'), '200');
  assert.equal(keypad('200', '0'), '2000');
  assert.equal(keypad('2000', 'back'), '200');
  assert.equal(keypad('2000', 'clear'), '');
  assert.equal(keypad('', '0'), '', 'без ведущих нулей');
  assert.equal(keypad('', '00'), '');
  assert.equal(keypad('1234567', '8'), '1234567', 'не больше 7 цифр');
  assert.equal(keypad('12', 'x'), '12');
  assert.equal(groupDigits('12500'), '12 500');
  assert.equal(groupDigits('1000000'), '1 000 000');
});

test('«сгорит через N минут»: от текущего момента и не больше срока заявки', async () => {
  const { minutesLeft } = await import('../src/lib/reception.js');
  const created = Date.parse('2026-10-22T02:00:00Z');
  const r = { created_at: new Date(created).toISOString(), expires_at: new Date(created + 15 * 60_000).toISOString() };
  assert.equal(minutesLeft(r, created), 15, 'только что созданная — 15, не 16');
  assert.equal(minutesLeft(r, created - 1500), 15, 'часы планшета отстают от сервера');
  assert.equal(minutesLeft(r, created + 30_000), 15);
  assert.equal(minutesLeft(r, created + 61_000), 14);
  assert.equal(minutesLeft(r, created + 14 * 60_000 + 59_000), 1);
  assert.equal(minutesLeft(r, created + 20 * 60_000), 1, 'не меньше минуты, пока заявка на экране');
  assert.equal(minutesLeft({ created_at: r.created_at }, created - 5000), 15, 'без expires_at — 15 минут от создания');
});
