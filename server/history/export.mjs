// CSV историй (№172, №173): UTF-8 с BOM, «;», ДД.ММ.ГГГГ, рубли с запятой. Гость — только маска
// телефона или ник; имена — только сотрудников. Ревизии — строка на позицию ревизии.

import { dec, rub, ruDateTime, toCsv } from '../dashboard/csv.mjs';

const STATUS = { new: 'новый', preparing: 'готовится', ready: 'готов', served: 'выдан', canceled: 'отменён' };
const SOURCE = { qr: 'QR гостя', pos: 'касса' };
const WSOURCE = { pos: 'касса', program: 'программа клуба', audit: 'ревизия' };
const METHOD = { cash: 'наличные', card_terminal: 'карта на кассе', sbp: 'СБП', card: 'карта онлайн' };

const guest = (g) => (g ? g.nick ?? g.phone_masked ?? '' : '');

/** @returns {{ filename: string, body: string, rows: number }} */
export function historyCsv(kind, page, { clubs, all, from, to }) {
  const tz = new Map(clubs.map((c) => [c.id, c.timezone]));
  const name = new Map(clubs.map((c) => [c.id, c.name]));
  const clubOf = (x) => x.club_id ?? clubs[0].id;
  const head = (cols) => (all ? ['Клуб', ...cols] : cols);
  const row = (x, cells) => (all ? [name.get(clubOf(x)) ?? '', ...cells] : cells);
  const dt = (x, at) => ruDateTime(at, tz.get(clubOf(x)));
  let headers;
  const rows = [];
  if (kind === 'orders') {
    headers = head(['Номер', 'Дата', 'Время', 'Отменён', 'Источник', 'Гость', 'Стол', 'Сумма, ₽', 'Способ оплаты', 'Статус', 'Состав']);
    for (const o of page.items) {
      const t = dt(o, o.created_at);
      const c = dt(o, o.canceled_at);
      rows.push(row(o, [o.number, t.date, t.time, o.canceled_at ? `${c.date} ${c.time}` : '', SOURCE[o.source] ?? o.source, guest(o.guest), o.resource_number ?? '', rub(o.amount_kopecks), METHOD[o.method] ?? '', STATUS[o.status] ?? o.status, o.lines.map((l) => `${l.name} × ${l.qty}`).join(', ')]));
    }
  } else if (kind === 'audits') {
    headers = head(['Дата', 'Время', 'Провёл', 'Товар', 'Ед.', 'По системе', 'Факт', 'Расхождение', 'Себестоимость, ₽', 'Расхождение, ₽', 'Комментарий']);
    for (const a of page.items) {
      const t = dt(a, a.created_at);
      for (const l of a.lines) rows.push(row(a, [t.date, t.time, a.created_by_name ?? '', l.name, l.unit ?? '', dec(l.expected_qty), dec(l.actual_qty), dec(l.diff_qty), rub(l.unit_cost_kopecks), rub(l.diff_kopecks), a.note ?? '']));
    }
  } else if (kind === 'writeoffs') {
    headers = head(['Дата', 'Время', 'Кто', 'Источник', 'Товар', 'Количество', 'Ед.', 'Причина', 'Сумма по себестоимости, ₽']);
    for (const w of page.items) {
      const t = dt(w, w.created_at);
      rows.push(row(w, [t.date, t.time, w.created_by_name ?? '', WSOURCE[w.source] ?? w.source, w.product, dec(w.qty), w.unit ?? '', w.reason ?? '', rub(w.cost_kopecks)]));
    }
  } else {
    headers = head(['Дата', 'Время', 'Кто', 'Поставщик', 'Товар', 'Количество', 'Ед.', 'Цена закупки, ₽', 'Сумма, ₽', 'Комментарий']);
    for (const m of page.items) {
      const t = dt(m, m.created_at);
      rows.push(row(m, [t.date, t.time, m.created_by_name ?? '', m.supplier ?? '', m.product, dec(m.qty), m.unit ?? '', rub(m.unit_cost_kopecks), rub(m.cost_kopecks), m.note ?? '']));
    }
  }
  return { filename: `history-${kind}-${from}-${to}.csv`, body: toCsv(headers, rows), rows: rows.length };
}
