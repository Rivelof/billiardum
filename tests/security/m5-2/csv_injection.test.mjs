// PoC (pentester, M5.2): экспорт CSV нейтрализует формулы Excel (№172).
// Ячейка, начинающаяся с = + - @ или таб/CR, получает апостроф, кроме настоящего
// отрицательного числа. Проверяем узел cell()/toCsv() продуктового кода напрямую.
//
// Запуск: node --test tests/security/m5-2/csv_injection.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cell, toCsv } from '../../../server/dashboard/csv.mjs';

test('формульные префиксы нейтрализуются апострофом', () => {
  assert.equal(cell('=cmd|0'), "'=cmd|0");
  assert.equal(cell('+1+2'), "'+1+2");
  assert.equal(cell('@SUM(1)'), "'@SUM(1)");
  assert.equal(cell('\t=HYPERLINK()'), "'\t=HYPERLINK()");
  assert.equal(cell('-1+cmd'), "'-1+cmd"); // минус, но не число → апостроф
});

test('настоящее отрицательное число не трогается', () => {
  assert.equal(cell('-5,00'), '-5,00');
  assert.equal(cell('-1234'), '-1234');
});

test('разделитель и перевод строки экранируются кавычками', () => {
  assert.equal(cell('ok;x'), '"ok;x"');
  assert.equal(cell('line\nbreak'), '"line\nbreak"');
  assert.equal(cell('"q"'), '"""q"""');
  // формула со спецсимволом: сперва апостроф, затем кавычки
  assert.equal(cell('=1;=2'), '"\'=1;=2"');
});

test('toCsv: BOM, ; и нейтрализация в теле', () => {
  const body = toCsv(['a', 'b'], [['=evil', '+plus'], ['-5,00', 'ok;x']]);
  assert.ok(body.startsWith('﻿'), 'есть BOM');
  assert.ok(body.includes("'=evil;'+plus"), 'формулы с апострофом');
  assert.ok(body.includes('-5,00;"ok;x"'), 'число без апострофа, разделитель в кавычках');
});
