// Импорт меню из .xlsx (M5.1 №157): разбор zip и XML первого листа, лимиты, испорченные файлы, zip-бомба.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { listZip, openZip, ZipError } from '../../lib/unzip.mjs';
import { parseMultipart } from '../../http/multipart.mjs';
import { columnIndex, decodeXml, numberText, readXlsxRows, XLSX_MAX_ROWS, XlsxError, xlsxToProducts } from '../xlsx.mjs';
import { makeXlsx, makeZip } from './zip-fixture.mjs';

const HEAD = ['Категория', 'Название', 'Цена', 'Алкоголь', 'Артикул'];

describe('xlsx: разбор', () => {
  it('первый лист, общие строки, числа, формулы — сохранённое значение', () => {
    const buf = makeXlsx([
      HEAD,
      ['Напитки', 'Морс', 120, 'нет', 'MORS'],
      ['Еда', 'Сэндвич «Клуб» & соус', 349.5, null, null],
      ['Еда', 'Сумма', { formula: 'C2+C3', value: 469.5 }, 0, null],
      [],
      ['Напитки', 'Чай', '95,50', 'нет', null],
    ]);
    const { items, errors } = xlsxToProducts(buf);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      items.map((i) => [i.line, i.category, i.name, i.price_kopecks, i.is_alcohol, i.sku]),
      [
        [2, 'Напитки', 'Морс', 12000, false, 'MORS'],
        [3, 'Еда', 'Сэндвич «Клуб» & соус', 34950, false, null],
        [4, 'Еда', 'Сумма', 46950, false, null],
        [6, 'Напитки', 'Чай', 9550, false, null],
      ],
    );
  });

  it('строки inlineStr, пропуски столбцов, ошибки по строкам как у CSV (номер строки Excel)', () => {
    const buf = makeXlsx([['name', 'price', 'ндс'], ['Кофе', 'abc', 13], ['Сок', 100, 1]], { inline: true });
    const { items, errors } = xlsxToProducts(buf);
    assert.deepEqual(errors, [
      { line: 2, field: 'price', code: 'bad_price' },
      { line: 2, field: 'vat_code', code: 'bad_vat' },
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0].vat_code, 1);
  });

  it('XML: сущности, DOCTYPE — отказ, адрес столбца, число без двоичного хвоста', () => {
    assert.equal(decodeXml('a &lt;b&gt; &amp; &#1046;&#x416;'), 'a <b> & ЖЖ');
    assert.throws(() => decodeXml('&lol;'), XlsxError);
    assert.equal(columnIndex('A1'), 0);
    assert.equal(columnIndex('AB12'), 27);
    assert.equal(numberText('150.49999999999997'), '150.5');
    assert.equal(numberText('1490'), '1490');
    const sheet = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row></sheetData></worksheet>';
    assert.throws(() => readXlsxRows(makeXlsx([], { sheetXml: sheet })), (e) => e instanceof XlsxError && e.code === 'bad_xml');
  });

  it('макросы и внешние ссылки в архиве не распаковываются и не мешают', () => {
    const buf = makeXlsx([HEAD, ['Бар', 'Вода', 60, 'нет', null]], {
      extra: [
        { name: 'xl/vbaProject.bin', data: Buffer.alloc(1000, 7) },
        { name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' },
      ],
    });
    assert.equal(xlsxToProducts(buf).items.length, 1);
  });

  it(`больше ${XLSX_MAX_ROWS} строк — too_many_rows`, () => {
    const rows = [HEAD];
    for (let i = 0; i < XLSX_MAX_ROWS + 1; i += 1) rows.push(['К', `Товар ${i}`, 10]);
    const r = xlsxToProducts(makeXlsx(rows));
    assert.deepEqual(r, { items: [], errors: [{ line: 0, field: null, code: 'too_many_rows' }] });
    const ok = xlsxToProducts(makeXlsx(rows.slice(0, XLSX_MAX_ROWS + 1)));
    assert.equal(ok.items.length, XLSX_MAX_ROWS);
  });
});

describe('xlsx: испорченные файлы и zip-бомба', () => {
  const code = (fn) => {
    try {
      fn();
    } catch (e) {
      return e instanceof XlsxError || e instanceof ZipError ? e.code : `other:${e.message}`;
    }
    return 'no_error';
  };

  it('не zip, обрезанный файл, неверная CRC, нет листа', () => {
    assert.equal(code(() => readXlsxRows(Buffer.from('name;price\nЧай;10'))), 'bad_zip');
    const good = makeXlsx([HEAD, ['Бар', 'Вода', 60]]);
    assert.equal(code(() => readXlsxRows(good.subarray(0, good.length - 30))), 'bad_zip');
    assert.equal(code(() => readXlsxRows(good.subarray(0, 200))), 'bad_zip');
    const badCrc = makeZip([
      { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData/></worksheet>', crc: 12345 },
    ]);
    assert.equal(code(() => readXlsxRows(badCrc)), 'bad_zip');
    const noSheet = makeZip([{ name: 'word/document.xml', data: '<w/>' }]);
    assert.equal(code(() => readXlsxRows(noSheet)), 'no_sheet');
    // Мусор вместо deflate.
    const garbage = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('xx'), method: 0 }]);
    garbage.write('ÿÿ', 30 + 'xl/worksheets/sheet1.xml'.length, 'latin1');
    garbage.writeUInt16LE(8, 8);
    assert.notEqual(code(() => readXlsxRows(garbage)), 'no_error');
  });

  it('zip-бомба с честным размером: больше 20 МБ после распаковки — too_large без распаковки', () => {
    const bomb = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(21 * 1024 * 1024, 0x20) }]);
    assert.ok(bomb.length < 100 * 1024, 'сжатая бомба маленькая');
    assert.equal(code(() => readXlsxRows(bomb)), 'too_large');
  });

  it('zip-бомба с ложным размером: распаковка обрывается на заявленном', () => {
    const real = Buffer.alloc(5 * 1024 * 1024, 0x20);
    const liar = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: real, size: 1000 }]);
    assert.equal(code(() => readXlsxRows(liar)), 'too_large');
  });

  it('много записей, суммарно больше 20 МБ — too_large', () => {
    const files = [];
    for (let i = 0; i < 5; i += 1) files.push({ name: `xl/media/p${i}.bin`, data: Buffer.alloc(5 * 1024 * 1024, i) });
    assert.throws(() => listZip(makeZip(files), { maxTotalBytes: 20 * 1024 * 1024 }), (e) => e.code === 'too_large');
  });

  it('файл больше 2 МБ — too_large', () => {
    const big = makeZip([{ name: 'x.bin', data: Buffer.from(deflateRawSync(Buffer.alloc(10))), method: 0 }, { name: 'pad.bin', data: Buffer.alloc(2 * 1024 * 1024 + 10, 1), method: 0 }]);
    assert.equal(code(() => readXlsxRows(big)), 'too_large');
  });

  it('openZip читает только нужные записи с общим бюджетом', () => {
    const zip = makeZip([{ name: 'a.txt', data: 'abc' }, { name: 'b.txt', data: 'defg' }]);
    assert.throws(() => openZip(zip, { maxTotalBytes: 5 }), (e) => e.code === 'too_large');
    const z = openZip(zip, { maxTotalBytes: 7 });
    assert.equal(z.read('A.TXT').toString(), 'abc');
    assert.equal(z.read('b.txt').toString(), 'defg');
    assert.equal(z.read('nope'), null);
  });
});

describe('multipart', () => {
  it('файл и поле; без boundary — ошибка', () => {
    const b = 'XyZ';
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\n1\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="меню.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0x00]),
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const parts = parseMultipart(body, `multipart/form-data; boundary=${b}`);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].data.toString(), '1');
    assert.equal(parts[1].filename, 'меню.xlsx');
    assert.deepEqual([...parts[1].data], [0x50, 0x4b, 0x03, 0x04, 0x0d, 0x0a, 0x00]);
    assert.throws(() => parseMultipart(body, 'multipart/form-data'));
  });
});
