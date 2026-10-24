/**
 * Экспорт таблиц в CSV для Excel на русской Windows (№172): UTF-8 с BOM, разделитель «;», даты ДД.ММ.ГГГГ,
 * деньги — рубли с запятой без знака валюты (Excel считает их числами), переводы строк CRLF.
 * Основной экспорт дашборда и историй делает сервер (журнал owner.export); этот модуль — для таблиц,
 * которые собираются на клиенте (список смен, касса управляющего), и для заглушки.
 */

import { dayDots, isYmd } from './period.js';

const BOM = '\uFEFF';

/** Ячейка: кавычки, если есть «;», кавычка или перевод строки; формулы Excel (=, +, -, @) экранируются апострофом. */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^-\d+(,\d+)?$/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Копейки → «1490,50» (без пробелов и ₽, чтобы Excel видел число). */
export function csvMoney(kopecks) {
  if (!Number.isSafeInteger(kopecks)) return '';
  const sign = kopecks < 0 ? '-' : '';
  const abs = Math.abs(kopecks);
  const rest = abs % 100;
  return `${sign}${Math.floor(abs / 100)}${rest ? `,${String(rest).padStart(2, '0')}` : ''}`;
}

/** Дата 'YYYY-MM-DD' или ISO-момент (по поясу клуба) → ДД.ММ.ГГГГ; с временем — «ДД.ММ.ГГГГ ЧЧ:ММ». */
export function csvDate(value, timeZone, withTime = false) {
  if (!value) return '';
  if (isYmd(value)) return dayDots(value);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.day}.${p.month}.${p.year}${withTime ? ` ${p.hour}:${p.minute}` : ''}`;
}

/**
 * Текст CSV: заголовок и строки.
 * @param {string[]} headers
 * @param {Array<Array<unknown>>} rows
 */
export function toCsv(headers, rows) {
  return BOM + [headers, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** Имя файла: «dashboard-revenue_daily-2026-10-01-2026-10-24.csv». */
export function csvName(...parts) {
  return `${parts.filter(Boolean).join('-').replace(/[^\p{L}\p{N}_.-]+/gu, '_')}.csv`;
}

/** Сохранить файл в браузере. */
export function saveFile(name, data, type = 'text/csv;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Имя файла из Content-Disposition сервера или запасное. */
export function fileNameFrom(res, fallback) {
  const cd = res?.headers?.get?.('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // запасное имя
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1] : fallback;
}
