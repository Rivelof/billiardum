// Импорт меню из CSV (PRODUCT §16.4): разделители, кавычки, русские заголовки, ошибки по строкам.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvToProducts, parseCsv, parseRub, validPhoto } from '../csv.mjs';

describe('CSV', () => {
  it('разделитель «;» или «,», кавычки с удвоением, перевод строки в поле, BOM', () => {
    const { delimiter, rows } = parseCsv('﻿a;b\r\n"x;1";"он сказал ""да"""\r\n"две\nстроки";3\r\n');
    assert.equal(delimiter, ';');
    assert.deepEqual(rows.map((r) => r.fields), [['a', 'b'], ['x;1', 'он сказал "да"'], ['две\nстроки', '3']]);
    assert.deepEqual(parseCsv('a,b\n1,2').rows[1].fields, ['1', '2']);
    assert.throws(() => parseCsv('a;"b'));
  });

  it('рубли → копейки', () => {
    assert.equal(parseRub('150'), 15000);
    assert.equal(parseRub('95,5'), 9550);
    assert.equal(parseRub('1 490,00 ₽'), 149000);
    assert.equal(parseRub('1 490'), 149000);
    assert.equal(parseRub('10.999'), null);
    assert.equal(parseRub('-5'), null);
    assert.equal(parseRub('abc'), null);
  });

  it('товары: английские и русские заголовки, умолчания, ошибки по строкам', () => {
    const r = csvToProducts('category,name,price,is_alcohol,sku\nНапитки,Морс,120,0,MORS\nПиво,Пиво,250,yes,\n,Без категории,10,,\n');
    assert.deepEqual(r.errors, []);
    assert.equal(r.items.length, 3);
    assert.equal(r.items[1].payment_subject, 'excise');
    assert.equal(r.items[2].category, null);
    assert.equal(r.items[0].unit, 'шт');
    const bad = csvToProducts('Название;Цена;Алкоголь;НДС\nЧай;;нет;1\nКофе;100;может;13\n');
    assert.deepEqual(bad.errors, [
      { line: 2, field: 'price', code: 'bad_price' },
      { line: 3, field: 'is_alcohol', code: 'bad_bool' },
      { line: 3, field: 'vat_code', code: 'bad_vat' },
    ]);
    assert.deepEqual(csvToProducts('Товар;Описание\nЧай;x').errors, [{ line: 1, field: 'price', code: 'missing_column' }]);
    assert.deepEqual(csvToProducts('').errors, [{ line: 0, field: null, code: 'empty' }]);
  });

  it('фото — путь сайта или https, без javascript: и кавычек', () => {
    assert.equal(validPhoto('/media/menu/tea.webp'), true);
    assert.equal(validPhoto('https://cdn.example.ru/a.jpg'), true);
    assert.equal(validPhoto('http://x.ru/a.jpg'), false);
    assert.equal(validPhoto('javascript:alert(1)'), false);
    assert.equal(validPhoto('//evil.example/a.jpg'), false);
    assert.equal(validPhoto('/a"onerror=1'), false);
  });
});
