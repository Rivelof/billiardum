/**
 * Склад (решение №80): остаток — сумма движений, себестоимость — средняя по приходам.
 * Единицы — как у backend-pos: шт, порц, л, мл, кг, г; количество — до тысячных (сервер хранит в тысячных долях),
 * деньги — целые копейки.
 */

/** Старые коды единиц заглушки M2 — на случай сохранённого состояния; сервер хранит русские коды. */
const LEGACY_UNITS = { pcs: 'шт', ml: 'мл', g: 'г', portion: 'порц' };

export function unitWord(unit) {
  return LEGACY_UNITS[unit] ?? unit ?? 'шт';
}

/**
 * Количество из поля: ≥ 0, до трёх знаков после запятой («1,5» л), пробелы по разрядам допускаются.
 * @param {string} input
 * @returns {number | null}
 */
export function parseQty(input) {
  const s = String(input ?? '').replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(s)) return null;
  return Math.round(Number(s) * 1000) / 1000;
}

const milli = (q) => Math.round(q * 1000);

/** Количество для подписи: «1,5», «12». */
export function qtyText(q) {
  return Number.isFinite(q) ? String(Math.round(q * 1000) / 1000).replace('.', ',') : '—';
}

/**
 * Строка ревизии: факт против расчёта. Расхождение в деньгах — по средней себестоимости, округление до копейки.
 * @param {number} expectedQty расчётный остаток
 * @param {number | null} actualQty факт, null — ещё не посчитали
 * @param {number} costKopecks средняя себестоимость единицы (может быть дробной для мл и г)
 * @returns {{ counted: boolean, diff_qty: number, diff_kopecks: number }}
 */
export function auditLine(expectedQty, actualQty, costKopecks) {
  if (actualQty === null || actualQty === undefined) return { counted: false, diff_qty: 0, diff_kopecks: 0 };
  // В тысячных долях единицы — без ошибок плавающей точки (0,1 + 0,2)
  const diffMilli = milli(actualQty) - milli(expectedQty);
  const cost = Number.isFinite(costKopecks) ? costKopecks : 0;
  return { counted: true, diff_qty: diffMilli / 1000, diff_kopecks: Math.round((diffMilli * cost) / 1000) };
}

/**
 * Итог ревизии: недостача и излишек отдельно (их не взаимозачитываем при показе) и чистое расхождение.
 * @param {{ diff_kopecks: number, counted: boolean }[]} lines
 */
export function auditTotals(lines) {
  let shortage = 0;
  let surplus = 0;
  let counted = 0;
  for (const l of lines) {
    if (!l.counted) continue;
    counted += 1;
    if (l.diff_kopecks < 0) shortage += -l.diff_kopecks;
    else surplus += l.diff_kopecks;
  }
  return { counted, shortage_kopecks: shortage, surplus_kopecks: surplus, net_kopecks: surplus - shortage };
}

/**
 * Сумма прихода: количество × цена закупки за единицу.
 * @param {{ qty: number | null, cost_kopecks: number | null }[]} lines
 */
export function arrivalTotal(lines) {
  return lines.reduce((s, l) => (Number.isFinite(l.qty) && l.qty > 0 && Number.isSafeInteger(l.cost_kopecks) ? s + Math.round((milli(l.qty) * l.cost_kopecks) / 1000) : s), 0);
}

/** Мало осталось: меньше порога товара (min_qty), иначе меньше 5 штук. Для подсветки словом «Мало». */
export function lowStock(item) {
  if (!Number.isFinite(item?.qty)) return false;
  const min = Number.isFinite(item.min_qty) ? item.min_qty : ['шт', 'pcs'].includes(item.unit ?? 'шт') ? 5 : 0;
  return item.qty <= min;
}
