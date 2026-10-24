import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plural, formatMoney, formatTime, formatDate, formatDateShort, formatDuration } from '../format.mjs';

const NBSP = ' ';
const TZ = 'Asia/Yekaterinburg'; // UTC+5, без перехода на летнее время
const TABLES = ['стол', 'стола', 'столов'];

test('plural: целые числа по правилам русского языка', () => {
  const cases = [
    [0, 'столов'],
    [1, 'стол'],
    [2, 'стола'],
    [5, 'столов'],
    [11, 'столов'],
    [12, 'столов'],
    [14, 'столов'],
    [21, 'стол'],
    [22, 'стола'],
    [25, 'столов'],
    [101, 'стол'],
    [111, 'столов'],
    [1_000_000, 'столов'],
  ];
  for (const [n, expected] of cases) {
    assert.equal(plural(n, TABLES), expected, `plural(${n})`);
  }
});

test('plural: отрицательные и дробные', () => {
  assert.equal(plural(-1, TABLES), 'стол');
  assert.equal(plural(-22, TABLES), 'стола');
  assert.equal(plural(1.5, ['час', 'часа', 'часов']), 'часа');
  assert.equal(plural(0.5, ['час', 'часа', 'часов']), 'часа');
});

test('plural: ошибки ввода', () => {
  assert.throws(() => plural(3, ['стол', 'стола']), TypeError);
  assert.throws(() => plural(Number.NaN, TABLES), TypeError);
  assert.throws(() => plural('3', TABLES), TypeError);
});

test('formatMoney: целые рубли, копейки, ноль и миллионы', () => {
  assert.equal(formatMoney(0), `0${NBSP}₽`);
  assert.equal(formatMoney(149000), `1${NBSP}490${NBSP}₽`);
  assert.equal(formatMoney(149050), `1${NBSP}490,50${NBSP}₽`);
  assert.equal(formatMoney(149005), `1${NBSP}490,05${NBSP}₽`);
  assert.equal(formatMoney(100000000), `1${NBSP}000${NBSP}000${NBSP}₽`);
  assert.equal(formatMoney(80000), `800${NBSP}₽`);
  assert.equal(formatMoney(1), `0,01${NBSP}₽`);
});

test('formatMoney: совпадает с Intl ru-RU', () => {
  const intl = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  assert.equal(formatMoney(149000), intl.format(1490));
  assert.equal(formatMoney(100000000), intl.format(1_000_000));
});

test('formatMoney: bigint, отрицательные суммы и ошибки ввода', () => {
  assert.equal(formatMoney(149050n), `1${NBSP}490,50${NBSP}₽`);
  assert.equal(formatMoney(9_007_199_254_740_993n), `90${NBSP}071${NBSP}992${NBSP}547${NBSP}409,93${NBSP}₽`);
  assert.equal(formatMoney(-149000), `-1${NBSP}490${NBSP}₽`);
  assert.throws(() => formatMoney(1490.5), TypeError);
  assert.throws(() => formatMoney('149000'), TypeError);
  assert.throws(() => formatMoney(2 ** 53), TypeError);
});

test('formatTime: часы и минуты по поясу клуба', () => {
  assert.equal(formatTime(new Date('2026-10-21T16:30:00Z'), TZ), '21:30');
  assert.equal(formatTime(new Date('2026-10-21T04:05:00Z'), TZ), '09:05');
  assert.equal(formatTime(Date.parse('2026-10-21T16:30:00Z'), TZ), '21:30');
  assert.equal(formatTime('2026-10-21T16:30:00Z', TZ), '21:30');
  assert.equal(formatTime(new Date('2026-10-21T16:30:00Z'), 'UTC'), '16:30');
});

test('formatTime и formatDate: в UTC ещё вчера, в Екатеринбурге уже сегодня', () => {
  const moment = new Date('2026-10-20T19:30:00Z'); // UTC: 20 октября 19:30; Екатеринбург: 21 октября 00:30
  assert.equal(formatDate(moment, 'UTC'), '20 октября');
  assert.equal(formatTime(moment, 'UTC'), '19:30');
  assert.equal(formatDate(moment, TZ), '21 октября');
  assert.equal(formatTime(moment, TZ), '00:30');

  const midnight = new Date('2026-10-20T19:00:00Z'); // ровно полночь в Екатеринбурге: 00:00, не 24:00
  assert.equal(formatTime(midnight, TZ), '00:00');
  assert.equal(formatDate(midnight, TZ), '21 октября');

  const lastMinute = new Date('2026-10-20T18:59:00Z');
  assert.equal(formatTime(lastMinute, TZ), '23:59');
  assert.equal(formatDate(lastMinute, TZ), '20 октября');
});

test('formatDate: родительный падеж месяца и переход через год', () => {
  assert.equal(formatDate(new Date('2026-10-21T10:00:00Z'), TZ), '21 октября');
  assert.equal(formatDate(new Date('2026-03-08T10:00:00Z'), TZ), '8 марта');
  assert.equal(formatDate(new Date('2026-12-31T19:00:00Z'), TZ), '1 января');
  assert.equal(formatDate(new Date('2026-12-31T19:00:00Z'), 'UTC'), '31 декабря');
});

test('formatDateShort: «24.10» по поясу клуба, ведущие нули, переход через год', () => {
  assert.equal(formatDateShort(new Date('2026-10-24T16:30:00Z'), TZ), '24.10');
  assert.equal(formatDateShort('2026-03-08T10:00:00Z', TZ), '08.03');
  assert.equal(formatDateShort(new Date('2026-12-31T19:00:00Z'), TZ), '01.01');
  assert.equal(formatDateShort(new Date('2026-12-31T19:00:00Z'), 'UTC'), '31.12');
  assert.throws(() => formatDateShort(new Date()), TypeError);
  assert.throws(() => formatDateShort('нет', TZ), RangeError);
});

test('formatTime и formatDate: без часового пояса и с некорректной датой — ошибка', () => {
  assert.throws(() => formatTime(new Date()), TypeError);
  assert.throws(() => formatDate(new Date(), ''), TypeError);
  assert.throws(() => formatTime('не дата', TZ), RangeError);
  assert.throws(() => formatTime(new Date(), 'Mars/Olympus'), RangeError);
});

test('formatDuration: таймер игры', () => {
  assert.equal(formatDuration(3_900_000), '1:05:00');
  assert.equal(formatDuration(3_600_000), '1:00:00');
  assert.equal(formatDuration(3_599_999), '59:59');
  assert.equal(formatDuration(300_000), '5:00');
  assert.equal(formatDuration(42_000), '0:42');
  assert.equal(formatDuration(999), '0:00');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5_000), '0:00');
  assert.equal(formatDuration(25 * 3_600_000 + 61_000), '25:01:01');
  assert.throws(() => formatDuration(Number.NaN), RangeError);
  assert.throws(() => formatDuration(Infinity), RangeError);
});
