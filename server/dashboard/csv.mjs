// CSV для Excel на русской Windows (№172): UTF-8 с BOM, разделитель «;», строки CRLF, даты ДД.ММ.ГГГГ,
// деньги — рубли с запятой («1490,50»), без разделителя тысяч. Ячейка, которая начинается с = + - @
// (или табуляции), получает апостроф: Excel не выполнит её как формулу. Без ПДн гостей (№171).

import { localParts, ruDate } from './time.mjs';

export const BOM = '﻿';

/** Копейки → «1490,50» (целые копейки, без плавающей точки). */
export function rub(kopecks) {
  if (kopecks === null || kopecks === undefined) return '';
  const n = BigInt(kopecks);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const r = `${a / 100n},${String(a % 100n).padStart(2, '0')}`;
  return neg ? `-${r}` : r;
}

/** Число с одним знаком и запятой: 12.5 → «12,5». */
export function dec(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace('.', ',');
}

export function cell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Отрицательное число («-5,00») — число, не формула: апостроф не нужен.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(,\d+)?$/.test(s)) s = `'${s}`;
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Таблица в CSV: заголовки и строки-массивы. */
export function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(';'), ...rows.map((r) => r.map(cell).join(';'))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Момент ISO → «ДД.ММ.ГГГГ» и «ЧЧ:ММ» в поясе клуба. */
export function ruDateTime(at, timeZone) {
  if (!at) return { date: '', time: '' };
  const p = localParts(new Date(at), timeZone);
  return { date: ruDate(p.date), time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}` };
}

export const TYPE_LABELS = { billiard_pyramid: 'Пирамида', billiard_pool: 'Пул', billiard_snooker: 'Снукер', billiard_mixed: 'Смешанный', padel_court: 'Падел-корт' };

export const ACTION_LABELS = {
  'service.start': 'Сервисный свет',
  'service.stop': 'Сервисный свет выключен',
  'manual.extend_free': 'Продление без оплаты',
  'manual.free_game': 'Бесплатная игра',
  'manual.discount': 'Скидка выше лимита',
  'manual.cancel': 'Отмена',
  'manual.refund': 'Возврат',
  'manual.tariff': 'Изменение тарифа',
  'manual.item_remove': 'Удаление из чека',
  'manual.tariff_change': 'Изменение тарифа',
  'manual.booking_cancel': 'Отмена брони',
  'manual.package_refund': 'Возврат пакета',
  'manual.payment_settings': 'Настройки оплаты',
  'manual.receipt_mark_printed': 'Чек отмечен пробитым',
  'manual.receipt_retry': 'Повтор чека',
  'manual.resource_add': 'Стол возвращён в работу',
  'manual.resource_remove': 'Стол выведен из работы',
  'manual.resource_kind': 'Смена типа стола',
  'manual.tournament_cancel': 'Отмена турнира',
  'manual.tournament_extend': 'Продление турнира',
  'manual.tournament_refund': 'Возврат взноса',
  'manual.tournament_score': 'Исправление счёта',
  'manual.waitlist_release': 'Снятие очереди',
  'payment.refunded': 'Возврат оплаты',
  'pos.refund': 'Возврат по кассе',
  'kkt.receipt_retry': 'Повтор чека',
};
