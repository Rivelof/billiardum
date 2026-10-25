// Ответы управляющему сети без денег по способам оплаты (M5.5 №192, как №166; находка pentester Н-3).
//
// Управляющему сети (членство в клубе выдано сетью, ctx.networkManager) нельзя разбивку денег по способам
// оплаты: ни «Сейчас», ни смена, ни продажи кассы, ни журнал. Все JSON-ответы маршрутов, где в запросе
// участвовал клуб, в котором он управляющий сети, и события SSE канала клуба проходят hideMoneyMethods:
// поля из MONEY_METHOD_KEYS на любой глубине становятся null (форма ответа не меняется — экран не падает).
// Итоги без разбивки (выручка, сумма продажи, ожидалось/факт/расхождение кассы смены — сверка наличных,
// как у управляющего клуба, №94) остаются. Новые маршруты и поля фильтр закрывает сам: он по именам, а не
// по списку маршрутов.

/** Поля, раскрывающие способ оплаты или сумму по способу. */
export const MONEY_METHOD_KEYS = Object.freeze([
  'method', // способ платежа, продажи, заказа, записи журнала
  'methods', // способы оплаты игр («Кто играл»)
  'payment_method',
  'by_method', // выручка и возвраты по способам
  'cash_sales_kopecks', // наличные продажи смены
  'cash_refunds_kopecks', // наличные возвраты смены
  'received_kopecks', // принято наличными (есть только у оплаты наличными)
  'change_kopecks', // сдача (только наличные)
]);
const HIDDEN = new Set(MONEY_METHOD_KEYS);

const isPlain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Копия значения, где поля MONEY_METHOD_KEYS — null (на любой глубине); исходное значение не меняется. */
export function hideMoneyMethods(value) {
  if (Array.isArray(value)) return value.map(hideMoneyMethods);
  if (!isPlain(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = HIDDEN.has(k) ? null : hideMoneyMethods(v);
  return out;
}
