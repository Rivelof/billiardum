// Маршруты приложения гостя под /app/ (отдельно от app.jsx, чтобы проверять их в Node)
export const ROUTES = [
  ['', 'home'],
  ['t/:code', 'table'],
  ['wait/:paymentId', 'wait'],
  ['r/:requestId', 'reception'],
  ['s/:id', 'game'],
  ['s/:id/receipt', 'receipt'],
  // M2: бар со стола; адреса возврата после онлайн-оплаты — как return_url backend-pos
  ['s/:id/bar', 'bar'],
  ['orders/:id', 'order'],
  ['sessions/:id/tab', 'tabpaid'],
  ['privacy', 'privacy'],
];
