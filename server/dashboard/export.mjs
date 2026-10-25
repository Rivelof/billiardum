// Экспорт таблиц дашборда в CSV (№172): revenue_daily | tables | hourly | manual | shifts | bookings.
// Только агрегаты; имена — только сотрудников (таблицы manual и shifts, блок «Контроль», №171).

import { HttpError } from '../http/errors.mjs';
import { ACTION_LABELS, dec, rub, ruDateTime, toCsv, TYPE_LABELS } from './csv.mjs';
import { matchKind, METHODS } from './day.mjs';
import { bookingsDaily, collect, dailyRows, namesFor, shiftRow } from './service.mjs';
import { ruDate } from './time.mjs';

export const EXPORT_TABLES = ['revenue_daily', 'tables', 'hourly', 'manual', 'shifts', 'bookings'];
const METHOD_LABELS = { cash: 'Наличные', card_terminal: 'Карта на кассе', sbp: 'СБП', card: 'Карта онлайн' };
const STATUS_LABELS = { open: 'идёт', closed: 'закрыта', discrepancy: 'с расхождением' };
const pctOf = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/**
 * @returns {Promise<{ filename: string, body: string, rows: number }>}
 */
export async function buildExport(db, { clubs, enter, q, table, now, all }) {
  if (!EXPORT_TABLES.includes(table)) throw new HttpError(400, 'bad_request', { detail: 'table' });
  const res = await collect(db, clubs, { fromDay: q.from, toDay: q.to, now, kind: q.kind, enter, wantHourly: table === 'hourly', light: table !== 'manual' });
  const a = res.agg;
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));
  const tzOf = new Map(clubs.map((c) => [c.id, c.timezone]));
  const head = (cols) => (all ? ['Клуб', ...cols] : cols);
  const row = (clubId, cells) => (all ? [clubName.get(clubId) ?? '', ...cells] : cells);
  let headers;
  let rows;

  if (table === 'revenue_daily') {
    headers = head(['Дата', 'Выручка, ₽', 'Возвраты, ₽', 'Чистая выручка, ₽', 'Столы, ₽', 'Бар, ₽', 'Прочее, ₽', ...METHODS.map((m) => `${METHOD_LABELS[m]}, ₽`), 'Игр', 'Средний чек игры, ₽', 'Средний чек бара, ₽', 'Загрузка, %']);
    const perClub = all ? res.perClub : [{ club: clubs[0], agg: a }];
    rows = [];
    for (const { club, agg } of perClub) {
      const byDay = new Map(agg.days.map((d) => [d.day, d]));
      for (const d of dailyRows(agg, { kind: q.kind, today: null })) {
        const raw = byDay.get(d.date);
        rows.push(row(club.id, [ruDate(d.date), rub(d.total_kopecks), rub(d.refunds_kopecks), rub(d.net_kopecks), rub(d.tables_kopecks), rub(d.bar_kopecks), rub(d.other_kopecks), ...METHODS.map((m) => rub(raw.revenue.by_method[m])), d.games, rub(d.avg_check_game_kopecks), rub(d.avg_check_bar_kopecks), dec(d.utilization_pct)]));
      }
    }
  } else if (table === 'tables') {
    headers = head(['Стол', 'Название', 'Тип', 'Игр', 'Часов игры', 'Часов сервиса', 'Выручка, ₽', 'Загрузка, %']);
    rows = [...a.resources.values()]
      .filter((r) => matchKind(r.type, q.kind) && (r.capacity_minutes > 0 || r.games > 0 || r.revenue_kopecks > 0))
      .sort((x, y) => (x.club_id === y.club_id ? x.number - y.number : x.club_id < y.club_id ? -1 : 1))
      .map((r) => row(r.club_id, [r.number, r.title ?? '', TYPE_LABELS[r.type] ?? r.type, r.games, dec(Math.round((r.play_minutes / 60) * 10) / 10), dec(Math.round((r.service_minutes / 60) * 10) / 10), rub(r.revenue_kopecks - r.refunds_kopecks), dec(pctOf(r.play_minutes, r.capacity_minutes))]));
  } else if (table === 'hourly') {
    headers = head(['Дата', 'Час', 'Минут игры', 'Минут сервиса', 'Минут брони', 'Ёмкость, мин', 'Начато игр', 'Загрузка, %']);
    rows = res.hourlyRows
      .sort((x, y) => (x.club_id !== y.club_id ? (x.club_id < y.club_id ? -1 : 1) : x.day !== y.day ? (x.day < y.day ? -1 : 1) : x.hour - y.hour))
      .map((h) => row(h.club_id, [ruDate(h.day), `${String(h.hour).padStart(2, '0')}:00`, h.play_minutes, h.service_minutes, h.booking_minutes, h.capacity_minutes, h.games, dec(pctOf(h.play_minutes, h.capacity_minutes))]));
  } else if (table === 'manual') {
    headers = head(['Дата', 'Время', 'Действие', 'Код', 'Вид', 'Сотрудник', 'Стол', 'Сумма, ₽', 'Причина']);
    const names = await namesFor(db, clubs, enter, a.manual.items.map((i) => `${i.club_id}|${i.actor_id}`));
    rows = a.manual.items
      .sort((x, y) => (x.at < y.at ? -1 : 1))
      .map((i) => {
        const t = ruDateTime(i.at, tzOf.get(i.club_id));
        return row(i.club_id, [t.date, t.time, ACTION_LABELS[i.action] ?? i.action, i.action, i.kind === 'staff' ? 'персонал' : 'ручное', names.get(`${i.club_id}|${i.actor_id}`) ?? '', i.resource_number ?? '', rub(i.amount_kopecks), i.reason ?? '']);
      });
  } else if (table === 'shifts') {
    headers = head(['Смена', 'Открыта', 'Закрыта', 'Открыл', 'Закрыл', 'Размен, ₽', 'Ожидалось, ₽', 'Факт, ₽', 'Расхождение, ₽', 'Статус']);
    const names = await namesFor(db, clubs, enter, a.shifts.flatMap((s) => [`${s.club_id}|${s.opened_by}`, `${s.club_id}|${s.closed_by}`]));
    rows = a.shifts.map((s) => {
      const r = shiftRow(s, names);
      const o = ruDateTime(r.opened_at, tzOf.get(s.club_id));
      const c = ruDateTime(r.closed_at, tzOf.get(s.club_id));
      return row(s.club_id, [r.number, `${o.date} ${o.time}`, r.closed_at ? `${c.date} ${c.time}` : '', r.opened_by_name ?? '', r.closed_by_name ?? '', rub(r.float_kopecks), rub(r.expected_cash_kopecks), rub(r.actual_cash_kopecks), rub(r.discrepancy_kopecks), STATUS_LABELS[r.status]]);
    });
  } else {
    headers = head(['Дата', 'Броней', 'Пришли', 'Не пришли', 'Отменены']);
    const perClub = all ? res.perClub : [{ club: clubs[0], agg: a }];
    rows = [];
    for (const { club, agg } of perClub) for (const b of bookingsDaily(agg)) rows.push(row(club.id, [ruDate(b.date), b.total, b.came, b.no_show, b.canceled]));
  }
  return { filename: `dashboard-${table}-${q.from}-${q.to}.csv`, body: toCsv(headers, rows), rows: rows.length };
}
