// Импорт меню из Excel (.xlsx, M5.1 №157): на сервере без тяжёлых зависимостей.
//
// .xlsx — zip (server/lib/unzip.mjs) с XML. Читаются только:
//   xl/workbook.xml и xl/_rels/workbook.xml.rels — какой файл у первого листа;
//   первый лист (xl/worksheets/…) и xl/sharedStrings.xml (общие строки).
// Формулы не вычисляются (<f> пропускается, берётся сохранённое значение <v>, если оно есть),
// макросы (vbaProject.bin), внешние ссылки, стили, картинки — не распаковываются вовсе.
// DOCTYPE и объявления сущностей — отказ (защита от «миллиарда смехов»), ссылки на внешние
// сущности не раскрываются: знаем только пять стандартных и числовые.
//
// Лимиты (№157): файл до 2 МБ (тело запроса), распакованное — до 20 МБ (zip-бомба), строк до 5 000.
// Дальше строки листа идут в тот же разбор, что CSV (csv.mjs rowsToProducts): те же заголовки,
// проверки и ошибки по строкам; номер строки — номер строки листа Excel.

import { openZip, ZipError } from '../lib/unzip.mjs';
import { rowsToProducts } from './csv.mjs';

export const XLSX_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const XLSX_MAX_UNZIPPED_BYTES = 20 * 1024 * 1024;
export const XLSX_MAX_ROWS = 5_000;
export const XLSX_MAX_COLUMNS = 64;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export class XlsxError extends Error {
  /** code: bad_zip, too_large, too_many_entries, unsupported, bad_xml, no_sheet. */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'XlsxError';
    this.code = code;
  }
}

/** Похоже на zip (локальный заголовок PK\3\4). */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

// XML ----------------------------------------------------------------------------------------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Сущности XML: пять стандартных и числовые; прочие — ошибка. */
export function decodeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isInteger(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new XlsxError('bad_xml', 'символ');
      return String.fromCodePoint(cp);
    }
    if (!(e in ENTITIES)) throw new XlsxError('bad_xml', 'сущность');
    return ENTITIES[e];
  });
}

const ATTR = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const localName = (name) => {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
};

/**
 * Разбор XML в поток событий: onOpen(name, attrs, selfClosing), onClose(name), onText(text).
 * Имена — локальные (без префикса пространства имён). Без DOCTYPE.
 */
export function scanXml(xml, { onOpen, onClose, onText }) {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (onText && i < n) onText(decodeXml(xml.slice(i)));
      break;
    }
    if (lt > i && onText) onText(decodeXml(xml.slice(i, lt)));
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) throw new XlsxError('bad_xml', 'инструкция');
      i = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new XlsxError('bad_xml', 'комментарий');
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) throw new XlsxError('bad_xml', 'CDATA');
      if (onText) onText(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new XlsxError('bad_xml', 'DOCTYPE');
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) throw new XlsxError('bad_xml', 'тег');
    const raw = xml.slice(lt + 1, gt);
    if (raw[0] === '/') {
      if (onClose) onClose(localName(raw.slice(1).trim()));
    } else {
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^([A-Za-z_][\w:.-]*)/.exec(body);
      if (!m) throw new XlsxError('bad_xml', 'имя тега');
      const attrs = {};
      if (body.length > m[1].length) {
        ATTR.lastIndex = 0;
        for (let a = ATTR.exec(body); a; a = ATTR.exec(body)) attrs[localName(a[1])] = decodeXml(a[2] ?? a[3] ?? '');
      }
      const name = localName(m[1]);
      if (onOpen) onOpen(name, attrs, selfClosing);
      if (selfClosing && onClose) onClose(name);
    }
    i = gt + 1;
  }
}

// Книга ---------------------------------------------------------------------------------------

function utf8(buf) {
  if (!buf) return null;
  return buf.toString('utf8').replace(/^\uFEFF/, '');
}

/** Путь первого листа книги (по workbook.xml и связям); нет книги — sheet1.xml. */
export function firstSheetPath(zip) {
  const wb = utf8(zip.read('xl/workbook.xml'));
  if (!wb) return zip.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
  let rid = null;
  scanXml(wb, {
    onOpen(name, attrs) {
      if (name === 'sheet' && rid === null) rid = attrs.id ?? null;
    },
  });
  if (!rid) throw new XlsxError('no_sheet', 'в книге нет листов');
  const rels = utf8(zip.read('xl/_rels/workbook.xml.rels'));
  let target = null;
  if (rels) {
    scanXml(rels, {
      onOpen(name, attrs) {
        if (name === 'Relationship' && attrs.Id === rid && target === null) target = attrs.Target ?? null;
      },
    });
  }
  if (!target) return zip.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : null;
  if (/^[a-z]+:/i.test(target)) throw new XlsxError('unsupported', 'внешний лист');
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  // Нормализация ../ и ./ (без выхода за корень архива).
  const parts = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) throw new XlsxError('bad_zip', 'путь листа');
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Общие строки: массив текстов <si> (rich text склеивается, фонетика <rPh> пропускается). */
export function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  let inSi = false;
  let inT = 0;
  let inPh = 0;
  let cur = '';
  scanXml(xml, {
    onOpen(name, _attrs, selfClosing) {
      if (name === 'si') {
        inSi = true;
        cur = '';
        if (selfClosing) {
          out.push('');
          inSi = false;
        }
      } else if (name === 'rPh') inPh += selfClosing ? 0 : 1;
      else if (name === 't' && !selfClosing) inT += 1;
    },
    onClose(name) {
      if (name === 'si' && inSi) {
        out.push(cur);
        inSi = false;
      } else if (name === 'rPh') inPh = Math.max(0, inPh - 1);
      else if (name === 't') inT = Math.max(0, inT - 1);
    },
    onText(text) {
      if (inSi && inT > 0 && inPh === 0) cur += text;
    },
  });
  return out;
}

/** 'BC12' → индекс столбца (A = 0); не адрес — -1. */
export function columnIndex(ref) {
  const m = /^([A-Z]{1,3})\d*$/.exec(String(ref ?? '').toUpperCase());
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Число из ячейки как строка: целые как есть, дроби — без хвоста двоичной погрешности (150.5, а не 150.49999999). */
export function numberText(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return String(v).trim();
  if (Number.isInteger(x)) return String(x);
  const cents = Math.round(x * 100);
  if (Math.abs(x * 100 - cents) < 1e-6) return String(cents / 100);
  return String(x);
}

/**
 * Строки листа: [{ line, fields }] (line — номер строки Excel), пустые строки пропускаются.
 * maxRows — сколько непустых строк допускается (с заголовком); больше — { tooMany: true }.
 */
export function parseSheet(xml, shared, { maxRows = XLSX_MAX_ROWS + 1, maxColumns = XLSX_MAX_COLUMNS } = {}) {
  const rows = [];
  let tooMany = false;
  let row = null;
  let lastRow = 0;
  let cell = null;
  let lastCol = -1;
  let inV = false;
  let inT = 0;
  let inPh = 0;
  let inIs = false;
  const finishRow = () => {
    if (!row) return;
    if (row.fields.some((f) => f !== undefined && String(f).trim() !== '')) {
      if (rows.length >= maxRows) tooMany = true;
      else rows.push({ line: row.line, fields: Array.from(row.fields, (f) => f ?? '') });
    }
    row = null;
  };
  const finishCell = () => {
    if (!cell || !row) return;
    let value;
    const t = cell.t;
    if (t === 's') {
      const idx = Number(cell.v);
      value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
    } else if (t === 'inlineStr') value = cell.is;
    else if (t === 'str' || t === 'd') value = cell.v;
    else if (t === 'b') value = cell.v.trim() === '1' ? '1' : '0';
    else if (t === 'e') value = '';
    else value = cell.v.trim() === '' ? '' : numberText(cell.v);
    if (cell.col >= 0 && cell.col < maxColumns) row.fields[cell.col] = value;
    cell = null;
  };
  scanXml(xml, {
    onOpen(name, attrs, selfClosing) {
      if (tooMany) return;
      if (name === 'row') {
        finishRow();
        const r = Number(attrs.r);
        const line = Number.isInteger(r) && r > 0 ? r : lastRow + 1;
        lastRow = line;
        lastCol = -1;
        row = { line, fields: [] };
        if (selfClosing) finishRow();
      } else if (name === 'c' && row) {
        const col = attrs.r ? columnIndex(attrs.r) : lastCol + 1;
        lastCol = col;
        cell = { col, t: attrs.t ?? 'n', v: '', is: '' };
        if (selfClosing) finishCell();
      } else if (cell) {
        if (name === 'v' && !selfClosing) inV = true;
        else if (name === 'is') inIs = !selfClosing;
        else if (name === 'rPh') inPh += selfClosing ? 0 : 1;
        else if (name === 't' && !selfClosing) inT += 1;
      }
    },
    onClose(name) {
      if (tooMany) return;
      if (name === 'v') inV = false;
      else if (name === 'is') inIs = false;
      else if (name === 'rPh') inPh = Math.max(0, inPh - 1);
      else if (name === 't') inT = Math.max(0, inT - 1);
      else if (name === 'c') finishCell();
      else if (name === 'row') finishRow();
    },
    onText(text) {
      if (!cell) return;
      if (inV) cell.v += text;
      else if (inIs && inT > 0 && inPh === 0) cell.is += text;
    },
  });
  finishRow();
  return { rows, tooMany };
}

/**
 * Строки первого листа книги .xlsx.
 * @param {Buffer} buf файл целиком
 * @returns {{ rows: { line: number, fields: string[] }[], tooMany: boolean }}
 */
export function readXlsxRows(buf, { maxRows = XLSX_MAX_ROWS + 1 } = {}) {
  if (!looksLikeZip(buf)) throw new XlsxError('bad_zip', 'не zip');
  if (buf.length > XLSX_MAX_FILE_BYTES) throw new XlsxError('too_large', 'файл больше 2 МБ');
  let zip;
  try {
    zip = openZip(buf, { maxTotalBytes: XLSX_MAX_UNZIPPED_BYTES, maxEntries: 2_000 });
    const sheetPath = firstSheetPath(zip);
    if (!sheetPath) throw new XlsxError('no_sheet', 'нет листа');
    const sheet = zip.read(sheetPath);
    if (!sheet) throw new XlsxError('no_sheet', 'нет файла листа');
    const shared = parseSharedStrings(utf8(zip.read('xl/sharedStrings.xml')));
    return parseSheet(utf8(sheet), shared, { maxRows });
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    if (err instanceof ZipError) throw new XlsxError(err.code, err.message);
    throw new XlsxError('bad_xml', err?.message);
  }
}

/**
 * .xlsx → товары, как csvToProducts: { items, errors }. Файл не разобран — XlsxError.
 * Больше 5 000 строк — ошибка too_many_rows (как у CSV), без товаров.
 */
export function xlsxToProducts(buf) {
  const { rows, tooMany } = readXlsxRows(buf);
  if (tooMany) return { items: [], errors: [{ line: 0, field: null, code: 'too_many_rows' }] };
  return rowsToProducts(rows, { maxRows: XLSX_MAX_ROWS });
}
