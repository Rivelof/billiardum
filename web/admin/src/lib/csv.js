import { parseRubles } from './cash.js';

/**
 * Импорт меню из CSV (Excel сохраняет с «;», Google Таблицы — с «,»). Разбор на клиенте — превью и ошибки
 * словами по строкам до отправки; на сервер уходит сам файл, сервер проверяет его ещё раз (server/catalog/csv.mjs).
 *
 * Столбцы — как у сервера (заголовок по-русски или по-английски, порядок любой):
 *   название | name и цена | price — обязательно; категория | category, ед | unit (шт, порц, л, мл, кг, г),
 *   алкоголь | is_alcohol (да или нет), ндс | vat_code (код ЮKassa 1–12, пусто — ставка клуба)
 */

/**
 * Разбор CSV: кавычки, «""» внутри кавычек, переводы строк внутри кавычек, CRLF, BOM. Разделитель — ; , или табуляция
 * (определяется по первой строке).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  // Разделитель — тот, что чаще встречается в заголовке; по умолчанию «;» (Excel в русской локали)
  const [best] = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1]);
  const delim = best[1] > 1 ? best[0] : ';';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADERS = {
  category: ['категория', 'category'],
  name: ['название', 'name', 'товар', 'наименование'],
  price: ['цена', 'price', 'price_rub'],
  unit: ['единица', 'unit', 'ед', 'ед. изм.', 'ед.изм.'],
  alcohol: ['алкоголь', 'is_alcohol'],
  vat: ['ндс', 'vat_code'],
};

const UNITS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'];
const YES = new Set(['да', 'yes', '1', 'true']);
const NO = new Set(['', 'нет', 'no', '0', 'false']);

/**
 * Строки меню из CSV.
 * @param {string} text
 * @returns {{ rows: { line: number, category: string, name: string, price_kopecks: number, unit: string, is_alcohol: boolean, vat_code: string | null }[], errors: { line: number, text: string }[] }}
 */
export function menuFromCsv(text) {
  const table = parseCsv(text);
  const errors = [];
  if (!table.length) return { rows: [], errors: [{ line: 1, text: 'Файл пустой.' }] };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) col[key] = head.findIndex((h) => names.includes(h));
  const missing = ['name', 'price'].filter((k) => col[k] < 0);
  if (missing.length) {
    return { rows: [], errors: [{ line: 1, text: 'В первой строке нужны столбцы «название» и «цена».' }] };
  }
  const rows = [];
  const seen = new Set();
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    const category = get('category');
    const name = get('name');
    const price = parseRubles(get('price'));
    const unitRaw = get('unit').toLowerCase();
    const unit = unitRaw || 'шт';
    const alcRaw = get('alcohol').toLowerCase();
    const vatRaw = get('vat');
    const vat = vatRaw === '' ? null : Number(vatRaw);
    const problems = [];
    if (!name) problems.push('нет названия');
    if (name.length > 128) problems.push('название длиннее 128 символов');
    if (category.length > 100) problems.push('категория длиннее 100 символов');
    if (price === null || price < 100) problems.push(`цена «${get('price')}» не похожа на сумму`);
    if (!UNITS.includes(unit)) problems.push(`единица «${unitRaw}» — нужна шт, порц, л, мл, кг или г`);
    if (!YES.has(alcRaw) && !NO.has(alcRaw)) problems.push(`алкоголь «${alcRaw}» — нужно «да» или «нет»`);
    if (vat !== null && (!Number.isInteger(vat) || vat < 1 || vat > 12)) problems.push(`НДС «${vatRaw}» — нужен код ЮKassa от 1 до 12 или пусто`);
    const dup = `${category.toLowerCase()}|${name.toLowerCase()}`;
    if (name && seen.has(dup)) problems.push('такой товар уже есть выше');
    seen.add(dup);
    if (problems.length) {
      errors.push({ line, text: `Строка ${line}: ${problems.join(', ')}.` });
      return;
    }
    rows.push({ line, category: category || null, name, price_kopecks: price, unit, is_alcohol: YES.has(alcRaw), vat_code: vat });
  });
  return { rows, errors };
}

/** Образец файла для кнопки «Скачать образец». */
export const CSV_SAMPLE = 'категория;название;цена;ед;алкоголь;ндс\nКофе и чай;Американо;180;шт;нет;\nНапитки;Вода без газа, 0,5 л;90;шт;нет;\nПиво и сидр;Светлое разливное, 0,5 л;290;шт;да;11\n';

/** Ошибки разбора CSV сервером ({ line, field, code }) словами — сервер отдаёт только коды. */
const SERVER_CSV = {
  bad_name: 'название пустое или длиннее 128 символов',
  bad_price: 'цена не похожа на сумму',
  bad_category: 'категория длиннее 100 символов',
  bad_unit: 'единица — нужна шт, порц, л, мл, кг или г',
  bad_bool: 'нужно «да» или «нет»',
  bad_vat: 'НДС — код ЮKassa от 1 до 12',
  bad_subject: 'неизвестный предмет расчёта',
  bad_sku: 'артикул — латиница, цифры, точка, дефис',
  bad_photo: 'фото — адрес https или путь от корня сайта',
  too_long: 'слишком длинный текст',
  duplicate_row: 'такой товар уже есть выше в файле',
  missing_column: 'нет обязательного столбца «название» или «цена»',
  bad_csv: 'файл не читается как CSV',
  empty: 'файл пустой',
  too_many_rows: 'больше 1000 строк — разбейте файл на части',
  // M5.5 (№191): товар задан шаблоном меню сети — жёсткий шаблон, или снимается признак алкоголя сети
  network_template: 'товар задан шаблоном меню сети — его поля меняет владелец сети, строку уберите из файла',
};

export function serverCsvError(e) {
  const what = SERVER_CSV[e?.code] ?? 'строка не принята';
  return e?.line ? `Строка ${e.line}: ${what}.` : `${what[0].toUpperCase()}${what.slice(1)}.`;
}
