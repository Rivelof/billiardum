// Импорт меню из CSV (PRODUCT §16.4): простой CSV с заголовками, разделитель «,» или «;»
// (Excel в русской локали сохраняет с «;»), поля в кавычках с удвоением «""», UTF-8 (BOM
// допускается). Заголовки — английские или русские:
//
//   category | категория        — категория (создаётся, если её нет)
//   name | название             — название товара (обязательно)
//   price | цена                — цена в рублях: 150, 150.50, 150,50, «1 490» (обязательно)
//   unit | ед                   — шт, порц, л, мл, кг, г (по умолчанию шт)
//   is_alcohol | алкоголь       — да/нет, 1/0, true/false
//   vat_code | ндс              — код ставки НДС ЮKassa 1–12 (пусто — ставка клуба)
//   payment_subject | предмет   — commodity, excise, service, job, composite, another
//   sku | артикул               — ключ обновления (иначе — категория и название)
//   description | описание, photo | фото, stop_list | стоп, track_stock | склад
//
// Ошибки — по строкам кодами, без текста: [{ line, field, code }].

export const MAX_ROWS = 1000;

const ALIASES = {
  category: ['category', 'категория'],
  name: ['name', 'название', 'наименование', 'товар'],
  price: ['price', 'цена', 'price_rub'],
  unit: ['unit', 'ед', 'единица', 'ед. изм.', 'ед.изм.'],
  is_alcohol: ['is_alcohol', 'алкоголь'],
  vat_code: ['vat_code', 'ндс'],
  payment_subject: ['payment_subject', 'предмет', 'предмет расчёта', 'предмет расчета'],
  sku: ['sku', 'артикул', 'код'],
  description: ['description', 'описание'],
  photo: ['photo', 'фото'],
  stop_list: ['stop_list', 'стоп', 'стоп-лист'],
  track_stock: ['track_stock', 'склад'],
};

const UNITS = ['шт', 'порц', 'л', 'мл', 'кг', 'г'];
const SUBJECTS = ['commodity', 'excise', 'service', 'job', 'composite', 'another'];

/** Разбор CSV в массив строк (массив полей). Номер строки файла — у каждой строки. */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new RangeError('csv');
  const s = text.replace(/^\uFEFF/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((f) => f.trim() !== '')) rows.push({ line: rowLine, fields: row });
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r' && s[i + 1] === '\n') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      line += 1;
      rowLine = line;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (quoted) throw new RangeError('csv: незакрытая кавычка');
  if (field !== '' || row.length > 0) pushRow();
  return { delimiter: delim, rows };
}

/** Рубли из строки → копейки; неверно — null. */
export function parseRub(value) {
  const v = String(value ?? '').replace(/[\s\u00a0\u20bd]/g, '').replace(/руб\.?$/i, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  const [r, k = ''] = v.split('.');
  return Number(r) * 100 + Number(k.padEnd(2, '0'));
}

function parseBool(value, dflt) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '') return dflt;
  if (['1', 'да', 'yes', 'true', 'y', 'д', '+'].includes(v)) return true;
  if (['0', 'нет', 'no', 'false', 'n', 'н', '-'].includes(v)) return false;
  return null;
}

/**
 * CSV → товары для импорта.
 * @returns {{ items: object[], errors: { line: number, field: string|null, code: string }[] }}
 */
export function csvToProducts(text) {
  const errors = [];
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch {
    return { items: [], errors: [{ line: 0, field: null, code: 'bad_csv' }] };
  }
  const [head, ...body] = parsed.rows;
  if (!head) return { items: [], errors: [{ line: 0, field: null, code: 'empty' }] };
  const cols = {};
  head.fields.forEach((h, idx) => {
    const key = h.trim().toLowerCase();
    for (const [field, names] of Object.entries(ALIASES)) if (names.includes(key) && cols[field] === undefined) cols[field] = idx;
  });
  if (cols.name === undefined || cols.price === undefined) {
    return { items: [], errors: [{ line: head.line, field: cols.name === undefined ? 'name' : 'price', code: 'missing_column' }] };
  }
  if (body.length > MAX_ROWS) return { items: [], errors: [{ line: 0, field: null, code: 'too_many_rows' }] };
  const items = [];
  for (const r of body) {
    const get = (f) => (cols[f] === undefined ? '' : String(r.fields[cols[f]] ?? '').trim());
    const err = (field, code) => errors.push({ line: r.line, field, code });
    const before = errors.length;
    const name = get('name').replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 128) err('name', 'bad_name');
    const price = parseRub(get('price'));
    if (price === null || price < 1 || price > 100_000_000) err('price', 'bad_price');
    const category = get('category').replace(/\s+/g, ' ');
    if (category.length > 100) err('category', 'bad_category');
    const unit = get('unit') || 'шт';
    if (!UNITS.includes(unit)) err('unit', 'bad_unit');
    const isAlcohol = parseBool(get('is_alcohol'), false);
    if (isAlcohol === null) err('is_alcohol', 'bad_bool');
    const vatRaw = get('vat_code');
    const vat = vatRaw === '' ? null : Number(vatRaw);
    if (vat !== null && (!Number.isInteger(vat) || vat < 1 || vat > 12)) err('vat_code', 'bad_vat');
    const subject = get('payment_subject') || (isAlcohol ? 'excise' : 'commodity');
    if (!SUBJECTS.includes(subject)) err('payment_subject', 'bad_subject');
    const sku = get('sku') || null;
    if (sku !== null && !/^[0-9A-Za-z._/-]{1,64}$/.test(sku)) err('sku', 'bad_sku');
    const description = get('description') || null;
    if (description !== null && description.length > 500) err('description', 'too_long');
    const photo = get('photo') || null;
    if (photo !== null && !validPhoto(photo)) err('photo', 'bad_photo');
    const stop = parseBool(get('stop_list'), false);
    if (stop === null) err('stop_list', 'bad_bool');
    const track = parseBool(get('track_stock'), true);
    if (track === null) err('track_stock', 'bad_bool');
    if (errors.length > before) continue;
    items.push({
      line: r.line,
      category: category || null,
      name,
      price_kopecks: price,
      unit,
      is_alcohol: isAlcohol,
      vat_code: vat,
      payment_subject: subject,
      sku,
      description,
      photo,
      stop_list: stop,
      track_stock: track,
    });
  }
  return { items, errors };
}

/** Фото — путь от корня сайта (/media/…) или https-адрес, без кавычек и пробелов. */
export function validPhoto(v) {
  if (typeof v !== 'string' || v.length < 2 || v.length > 500 || /[\s"'<>\\]/.test(v)) return false;
  if (v.startsWith('/') && !v.startsWith('//')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}
