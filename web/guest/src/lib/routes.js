// Маршруты приложения гостя под /app/ (отдельно от app.jsx, чтобы проверять их в Node)
export const ROUTES = [
  ['', 'home'],
  ['t/:code', 'table'],
  ['wait/:paymentId', 'wait'],
  ['r/:requestId', 'reception'],
  ['s/:id', 'game'],
  ['s/:id/receipt', 'receipt'],
  ['privacy', 'privacy'],
];
