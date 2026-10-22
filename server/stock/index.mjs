// Модуль склада бара (backend-pos, decisions №80): init(ctx) и stop() по образцу M1.
// Таймеров и подписок нет: движения пишут заказы и касса (./api.mjs), управляющий — маршруты
// api/routes/stock.mjs.

export { balances, recordSales, recordReturns } from './api.mjs';

export async function init(ctx) {
  ctx?.log?.info?.('stock_started', {});
}

export async function stop() {}
