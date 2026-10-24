/**
 * Отчёты M5.2 (docs/contracts/m5-2.md §7–§8, №173–179): истории заказов, ревизий, списаний и приходов, список смен,
 * касса управляющего, «Кто играл за столом», ведомость ревизии. Логика без JSX — тестируется в Node (test/reports.test.mjs).
 */

import { formatMoney, plural } from '@billiardum/shared/format';
import { METHOD_LABEL } from './words.js';
import { addDays, dayLong } from './period.js';

export const REPORTS = [
  { key: 'shifts', label: 'Смены', title: 'Смены' },
  { key: 'orders', label: 'Заказы гостей', title: 'История заказов гостей' },
  { key: 'audits', label: 'Ревизии', title: 'История ревизий' },
  { key: 'writeoffs', label: 'Списания', title: 'История списаний' },
  { key: 'arrivals', label: 'Приходы', title: 'История приходов' },
  { key: 'cashbook', label: 'Касса управляющего', title: 'Касса управляющего' },
  { key: 'players', label: 'Кто играл', title: 'Кто играл за столом' },
];
export const REPORT_KEYS = new Set([...REPORTS.map((r) => r.key), 'audit-sheet']);

/** Статусы заказа сервера (server/history): new · preparing · ready · served · canceled. */
export const ORDER_STATUS = { new: 'Новый', preparing: 'Готовится', ready: 'Готов', served: 'Выдан', canceled: 'Отменён' };
export const ORDER_SOURCE = { qr: 'QR со стола', pos: 'Касса' };
export const PAY_LABEL = { ...METHOD_LABEL, tab: 'В счёт стола' };
/** Источник списания (server/history: status=program | pos | audit). */
export const WRITEOFF_SOURCE = { program: 'Программа клуба', pos: 'Касса', audit: 'Ревизия' };

/**
 * Телефон гостя — только маской (№173, 152-ФЗ). Если сервер по ошибке прислал полный номер, маскируем сами:
 * '+79120001234' → '+7 *** ***-12-34'.
 */
export function maskPhone(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (raw.includes('*')) return raw;
  const d = raw.replace(/\D/g, '');
  if (d.length < 4) return '+7 *** ***-**-**';
  return `+7 *** ***-${d.slice(-4, -2)}-${d.slice(-2)}`;
}

/** Гость в истории: ник Бильярдум+ или маска телефона; нет ни того ни другого — «Гость без входа» / «—» на кассе. */
export function guestLabel(guest, { pos = false } = {}) {
  if (guest?.nick) return guest.nick;
  const m = maskPhone(guest?.phone_masked ?? guest?.masked_phone ?? guest?.phone ?? null);
  if (m) return m;
  return pos ? '—' : 'Гость без входа';
}

/** Состояние смены словом (№176): идёт, сошлась, недостача, излишек. */
export function shiftState(s) {
  if (!s || s.state === 'open' || s.status === 'open' || !s.closed_at) return { key: 'open', word: 'Идёт' };
  const d = s.discrepancy_kopecks;
  if (!Number.isSafeInteger(d)) return { key: 'unknown', word: 'Закрыта' };
  if (d === 0) return { key: 'ok', word: 'Сошлась' };
  return d < 0 ? { key: 'short', word: `Недостача ${formatMoney(-d)}` } : { key: 'over', word: `Излишек ${formatMoney(d)}` };
}

export const SHIFT_STATUS_FILTER = [
  { value: '', label: 'Все' },
  { value: 'open', label: 'Идёт' },
  { value: 'closed', label: 'Закрыта' },
  { value: 'discrepancy', label: 'С расхождением' },
];

/** Сотрудники для фильтра — из открывших и закрывших смены (у управляющего нет списка персонала). */
export function shiftStaff(list) {
  const map = new Map();
  for (const s of Array.isArray(list) ? list : []) {
    if (s.opened_by && s.opened_by_name) map.set(s.opened_by, s.opened_by_name);
    if (s.closed_by && s.closed_by_name) map.set(s.closed_by, s.closed_by_name);
  }
  return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// ---------- касса управляющего (№177) ----------

/**
 * Запись кассы (server/dashboard: entries) — можно сторнировать: ручной доход или расход, не сторно сама и ещё
 * не сторнирована. Инкассации из смен — нельзя.
 */
export function canStorno(e) {
  return Boolean(e) && (e.kind === 'income' || e.kind === 'expense') && !e.reverses_id && !e.reversed_by;
}

/**
 * Итоги кассы: конец = начало + доходы + инкассации − расходы (№177). Сторно — запись с отрицательной суммой
 * той же статьи. mismatch — сервер прислал другой остаток.
 */
export function cashbookSummary(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  const opening = Number.isSafeInteger(data?.opening_kopecks) ? data.opening_kopecks : 0;
  let collections = 0;
  let otherIncome = 0;
  let expense = 0;
  const byCat = new Map();
  for (const e of entries) {
    const a = Number.isSafeInteger(e.amount_kopecks) ? e.amount_kopecks : 0;
    if (e.kind === 'collection') collections += a;
    else if (e.kind === 'income') otherIncome += a;
    else if (e.kind === 'expense') {
      expense += a;
      const k = e.category ?? 'Без статьи';
      byCat.set(k, (byCat.get(k) ?? 0) + a);
    }
  }
  const closing = opening + otherIncome + collections - expense;
  const server = Number.isSafeInteger(data?.closing_kopecks) ? data.closing_kopecks : null;
  const fromServer = Array.isArray(data?.by_category) ? data.by_category.filter((c) => c.kind === 'expense' && c.amount_kopecks) : null;
  return {
    opening,
    collections,
    otherIncome,
    income: otherIncome + collections,
    expense,
    closing,
    mismatch: server !== null && server !== closing,
    byCategory: (fromServer ? fromServer.map((c) => ({ name: c.name, amount: c.amount_kopecks })) : [...byCat].filter(([, v]) => v !== 0).map(([name, amount]) => ({ name, amount }))).sort((x, y) => y.amount - x.amount),
  };
}

/** Проверка формы записи кассы: сумма из строки рублей, статья нужного вида, дата не позже сегодня. */
/** №189: запись в кассе управляющего — не раньше чем 35 дней назад; раньше вчерашнего дня — задним числом (уведомление владельцу). */
export const CASHBOOK_MAX_BACK_DAYS = 35;

/** Самая ранняя дата записи: '2026-10-24' → '2026-09-19'. */
export function cashbookMinDate(today) {
  return addDays(today, -CASHBOOK_MAX_BACK_DAYS);
}

/** Запись задним числом: дата раньше вчерашнего дня клуба. */
export function cashbookBackdated(date, today) {
  return Boolean(date && today && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < addDays(today, -1));
}

export function cashbookFormErrors({ kind, amount, categoryId, date }, categories, today) {
  const e = {};
  if (!['income', 'expense'].includes(kind)) e.kind = 'Выберите: доход или расход.';
  if (!Number.isSafeInteger(amount) || amount <= 0) e.amount = 'Введите сумму больше нуля, например 1 500 или 1 500,50.';
  const cat = (categories ?? []).find((c) => c.category_id === categoryId);
  if (!cat || cat.active === false) e.category = 'Выберите статью.';
  else if (cat.kind !== kind) e.category = kind === 'income' ? 'Это статья расходов — выберите статью доходов.' : 'Это статья доходов — выберите статью расходов.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) e.date = 'Укажите дату.';
  else if (today && date > today) e.date = 'Дата не может быть позже сегодняшней.';
  else if (today && date < cashbookMinDate(today)) e.date = `Запись можно датировать не раньше ${dayLong(cashbookMinDate(today))} — это ${CASHBOOK_MAX_BACK_DAYS} дней назад.`;
  return e;
}

// ---------- ведомость ревизии (№174) ----------

/** Количество в ведомости: до тысячных, без лишних нулей, с запятой. */
export function qtyWords(q) {
  if (!Number.isFinite(q)) return '—';
  return String(Math.round(q * 1000) / 1000).replace('.', ',');
}

const POSITIONS = ['позиция', 'позиции', 'позиций'];
const RECORDS = ['запись', 'записи', 'записей'];
export const countWords = {
  positions: (n) => `${n} ${plural(n, POSITIONS)}`,
  records: (n) => `${n} ${plural(n, RECORDS)}`,
};

/** Длительность игры: '1 ч 30 мин'. */
export function gameMinutes(start, end) {
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 60000);
}

/** Причина для «Показать телефон»: не короче 5 знаков без пробелов по краям. */
export function revealReasonError(reason) {
  const r = String(reason ?? '').trim();
  if (r.length < 5) return 'Напишите причину: зачем нужен номер (например, «гость забыл кий, хотим вернуть»).';
  if (r.length > 300) return 'Причина — не длиннее 300 знаков.';
  return null;
}
