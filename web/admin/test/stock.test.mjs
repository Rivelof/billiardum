import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalTotal, auditLine, auditTotals, lowStock, parseQty, qtyText, unitWord } from '../src/lib/stock.js';
import { menuFromCsv, parseCsv, serverCsvError } from '../src/lib/csv.js';

test('количество со склада: до тысячных, запятая, без мусора', () => {
  assert.equal(parseQty('12'), 12);
  assert.equal(parseQty('1,5'), 1.5);
  assert.equal(parseQty('0.125'), 0.125);
  assert.equal(parseQty('1 200'), 1200);
  assert.equal(parseQty('1,2345'), null);
  assert.equal(parseQty('-3'), null);
  assert.equal(parseQty(''), null);
  assert.equal(qtyText(1.5), '1,5');
  assert.equal(unitWord('шт'), 'шт');
  assert.equal(unitWord('pcs'), 'шт', 'старый код заглушки');
});

test('ревизия: факт против расчёта, расхождение в деньгах по средней себестоимости', () => {
  assert.deepEqual(auditLine(24, 22, 2800), { counted: true, diff_qty: -2, diff_kopecks: -5600 });
  assert.deepEqual(auditLine(3, 5, 5500), { counted: true, diff_qty: 2, diff_kopecks: 11000 });
  assert.deepEqual(auditLine(0.3, 0.1 + 0.2, 1000), { counted: true, diff_qty: 0, diff_kopecks: 0 }, 'без ошибки 0,1 + 0,2');
  assert.deepEqual(auditLine(1.5, 1.25, 33), { counted: true, diff_qty: -0.25, diff_kopecks: -8 }, 'дробная себестоимость — округление до копейки');
  assert.deepEqual(auditLine(5, null, 100), { counted: false, diff_qty: 0, diff_kopecks: 0 });
  const totals = auditTotals([auditLine(24, 22, 2800), auditLine(3, 5, 5500), auditLine(4, 4, 100), auditLine(1, null, 100)]);
  assert.deepEqual(totals, { counted: 3, shortage_kopecks: 5600, surplus_kopecks: 11000, net_kopecks: 5400 });
});

test('приход: сумма строк, дробное количество', () => {
  assert.equal(arrivalTotal([{ qty: 24, cost_kopecks: 2800 }, { qty: 1.5, cost_kopecks: 12001 }, { qty: null, cost_kopecks: 100 }]), 67200 + 18002);
  assert.equal(lowStock({ qty: 3, unit: 'шт' }), true);
  assert.equal(lowStock({ qty: 30, unit: 'шт' }), false);
  assert.equal(lowStock({ qty: 2, unit: 'шт', min_qty: 1 }), false);
});

test('CSV: «;» и «,», кавычки, BOM, перевод строки внутри поля', () => {
  assert.deepEqual(parseCsv('﻿a;b\r\n1;"x;""y"""\n'), [['a', 'b'], ['1', 'x;"y"']]);
  assert.deepEqual(parseCsv('a,b\n"1\n2",3'), [['a', 'b'], ['1\n2', '3']]);
  assert.deepEqual(parseCsv('\n\n'), []);
});

test('меню из CSV: столбцы как у сервера, ошибки словами по строкам', () => {
  const { rows, errors } = menuFromCsv(
    'Категория;Название;Цена;Ед;Алкоголь;НДС\n' +
      'Кофе и чай;Раф ванильный;290;шт;нет;\n' +
      ';Тоник, 0,33 л;160,50;;;\n' +
      'Пиво и сидр;Нефильтрованное;330;порц;да;11\n' +
      'Еда;;250;шт;нет;\n' +
      'Еда;Чипсы;сто;кг;может;30\n' +
      'Кофе и чай;Раф ванильный;300;шт;нет;\n',
  );
  assert.deepEqual(rows[0], { line: 2, category: 'Кофе и чай', name: 'Раф ванильный', price_kopecks: 29000, unit: 'шт', is_alcohol: false, vat_code: null });
  assert.deepEqual(rows[1], { line: 3, category: null, name: 'Тоник, 0,33 л', price_kopecks: 16050, unit: 'шт', is_alcohol: false, vat_code: null });
  assert.equal(rows[2].is_alcohol, true);
  assert.equal(rows[2].vat_code, 11);
  assert.equal(rows.length, 3);
  assert.deepEqual(errors.map((e) => e.line), [5, 6, 7]);
  assert.match(errors[0].text, /Строка 5: нет названия/);
  assert.match(errors[1].text, /цена «сто»/);
  assert.match(errors[1].text, /единица «кг»|алкоголь «может»/);
  assert.match(errors[1].text, /НДС «30»/);
  assert.match(errors[2].text, /уже есть выше/);
  assert.match(menuFromCsv('a;b\n1;2').errors[0].text, /«название» и «цена»/);
  assert.equal(serverCsvError({ line: 4, field: 'price', code: 'bad_price' }), 'Строка 4: цена не похожа на сумму.');
  assert.equal(serverCsvError({ line: 0, code: 'empty' }), 'Файл пустой.');
});
