import { formatMoney } from '@billiardum/shared/format';

/**
 * Смена и касса (PRODUCT §4.2, решения №81, №83). Наличные в кассе = размен + наличные продажи − наличные возвраты.
 * Ожидаемую сумму считает сервер по всем наличным платежам клуба за смену; здесь — та же формула и расхождение.
 */

/**
 * @param {number} floatKopecks размен при открытии
 * @param {number} cashSales наличные продажи (касса и заявки стола)
 * @param {number} cashRefunds наличные возвраты
 */
export function expectedCash(floatKopecks, cashSales, cashRefunds = 0) {
  for (const v of [floatKopecks, cashSales, cashRefunds]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new TypeError('expectedCash: суммы — целые копейки, не меньше 0');
  }
  return floatKopecks + cashSales - cashRefunds;
}

/**
 * Расхождение при закрытии: факт минус ожидание.
 * @param {number} expected копейки
 * @param {number | null} actual копейки или null, пока не введено
 * @returns {{ kopecks: number, kind: 'none' | 'shortage' | 'surplus' | 'unknown', word: string, amount: string }}
 */
export function discrepancy(expected, actual) {
  if (!Number.isSafeInteger(expected)) throw new TypeError('discrepancy: ожидаемая сумма — целые копейки');
  if (actual === null || actual === undefined || !Number.isSafeInteger(actual)) {
    return { kopecks: 0, kind: 'unknown', word: 'Введите сумму', amount: '—' };
  }
  const d = actual - expected;
  if (d === 0) return { kopecks: 0, kind: 'none', word: 'Сходится', amount: formatMoney(0) };
  const amount = formatMoney(Math.abs(d));
  return d < 0 ? { kopecks: d, kind: 'shortage', word: `Недостача ${amount}`, amount } : { kopecks: d, kind: 'surplus', word: `Излишек ${amount}`, amount };
}

/** Кнопка закрытия говорит, что произойдёт. */
export function closeLabel(diff) {
  if (diff.kind === 'unknown') return 'Введите наличные в кассе';
  if (diff.kind === 'none') return 'Закрыть смену';
  return diff.kind === 'shortage' ? `Закрыть смену с недостачей ${diff.amount}` : `Закрыть смену с излишком ${diff.amount}`;
}

/** Методы оплаты в отчёте смены в постоянном порядке. */
export const REPORT_METHODS = ['cash', 'card_terminal', 'sbp', 'card'];

const byMethod = (o) => (o && typeof o === 'object' ? (o.by_method && typeof o.by_method === 'object' ? o.by_method : o) : {});

/**
 * Выручка по способам оплаты из отчёта backend-kkt: revenue.tables.by_method, revenue.bar.by_method
 * (и revenue.other — прочее, например взносы турниров). Отсутствующие поля — 0.
 * @returns {{ rows: { method: string, tables: number, bar: number, other: number, total: number }[], tables: number, bar: number, other: number, total: number }}
 */
export function revenueTable(revenue) {
  const t = byMethod(revenue?.tables);
  const b = byMethod(revenue?.bar);
  const o = byMethod(revenue?.other);
  const val = (x, m) => (Number.isSafeInteger(x[m]) ? x[m] : 0);
  const rows = REPORT_METHODS.map((m) => ({ method: m, tables: val(t, m), bar: val(b, m), other: val(o, m), total: val(t, m) + val(b, m) + val(o, m) }));
  const sum = (k) => rows.reduce((acc, r) => acc + r[k], 0);
  return { rows, tables: sum('tables'), bar: sum('bar'), other: sum('other'), total: sum('total') };
}

/**
 * Сверка до копейки (backend-kkt reconcile): { ok, diff_kopecks, status? }.
 * ok: null или status ≠ checked у онлайн-сверки — не проверено (ЮKassa не ответила, не настроена).
 * @returns {{ state: 'ok' | 'diff' | 'unchecked', diff: number }}
 */
export function reconcile(r) {
  if (!r || typeof r !== 'object') return { state: 'unchecked', diff: 0 };
  if (r.status && r.status !== 'checked') return { state: 'unchecked', diff: 0 };
  const diff = Number.isSafeInteger(r.diff_kopecks) ? r.diff_kopecks : 0;
  if (r.ok === true) return { state: 'ok', diff: 0 };
  if (r.ok === null || r.ok === undefined) return { state: 'unchecked', diff };
  return { state: 'diff', diff };
}

/** Загрузка столов в процентах от минут игры: minutes / (столы · длина смены). */
export function utilization(playMinutes, tables, shiftMinutes) {
  if (!tables || !shiftMinutes || shiftMinutes <= 0) return 0;
  return Math.min(100, Math.round((playMinutes * 100) / (tables * shiftMinutes)));
}

/** Имя сотрудника смены: backend-kkt отдаёт opened_by_name и closed_by_name (opened_by — id), старый вид — { name }. */
export function staffName(shift, who) {
  const name = shift?.[`${who}_by_name`] ?? shift?.[`${who}_by`]?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

/** Список смен: массив или { items, next_cursor } (backend-kkt). */
export function shiftList(res) {
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.items) ? res.items : [];
}

/** Открытая смена из GET /shifts/current: backend-kkt отдаёт { shift: … | null }. */
export function currentOf(res) {
  if (res && typeof res === 'object' && 'shift' in res && !('opened_at' in res)) return res.shift ?? null;
  return res ?? null;
}
