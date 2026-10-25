/**
 * «Сейчас»: выручка за сегодня из GET /api/clubs/{club}/now. Управляющему сети (M5.5 №192) сервер не отдаёт разбивку по
 * способам оплаты: `revenue_today_kopecks: null`, итог — `revenue_today_total_kopecks`. Без JSX и DOM — тестируется в Node.
 */

export const NOW_METHODS = Object.freeze(['sbp', 'card', 'cash', 'card_terminal']);

const isSum = (v) => Number.isSafeInteger(v);

/**
 * @param {{ revenue_today_kopecks?: Record<string, number> | null, revenue_today_total_kopecks?: number } | null} data
 * @param {{ networkManager?: boolean }} [opts] членство выдано сетью: разбивки нет, даже если поле пришло не так
 * @returns {{ hidden: boolean, total: number, rows: { method: string, kopecks: number }[] }} hidden — способы оплаты скрыты
 */
export function revenueToday(data, { networkManager = false } = {}) {
  const raw = data?.revenue_today_kopecks;
  const byMethod = raw && typeof raw === 'object' ? raw : null;
  const hidden = raw === null || (networkManager && !byMethod);
  const rows = hidden ? [] : NOW_METHODS.map((method) => ({ method, kopecks: isSum(byMethod?.[method]) ? byMethod[method] : 0 }));
  const sum = rows.reduce((s, r) => s + r.kopecks, 0);
  return { hidden, total: isSum(data?.revenue_today_total_kopecks) ? data.revenue_today_total_kopecks : sum, rows };
}
