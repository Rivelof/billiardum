import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minutesWords, durationWords, optionLabel, optionMinutes, perHour, tableName } from '../src/lib/words.js';

test('минуты словами со склонением', () => {
  assert.equal(minutesWords(30), '30 минут');
  assert.equal(minutesWords(1), '1 минута');
  assert.equal(minutesWords(1, { accusative: true }), '1 минуту');
  assert.equal(minutesWords(21, { accusative: true }), '21 минуту');
  assert.equal(minutesWords(60), '1 час');
  assert.equal(minutesWords(120), '2 часа');
  assert.equal(minutesWords(300), '5 часов');
  assert.equal(minutesWords(90), '1 час 30 минут');
  assert.equal(minutesWords(0), '0 минут');
});

test('остаток для диктора', () => {
  assert.equal(durationWords(3_900_000), '1 час 5 минут');
  assert.equal(durationWords(7_200_000), '2 часа');
  assert.equal(durationWords(299_000), '4 минуты 59 секунд');
  assert.equal(durationWords(42 * 60_000 + 10_000), '42 минуты');
  assert.equal(durationWords(42_000), '42 секунды');
  assert.equal(durationWords(-5), '0 секунд');
});

test('варианты времени и цены', () => {
  assert.equal(optionLabel(60), '1 час');
  assert.equal(optionLabel(180), '3 часа');
  assert.equal(optionLabel('unlimited'), 'Без лимита');
  assert.equal(optionMinutes('unlimited'), null);
  assert.equal(optionMinutes(120), 120);
  assert.equal(perHour(80000), '800 ₽/ч');
  assert.equal(tableName(4), 'Стол 4');
  assert.equal(tableName(undefined), 'Стол');
});
