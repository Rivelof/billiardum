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
  // M3: бронь (отдельный чанк), лист ожидания, профиль: баланс часов и каналы уведомлений
  ['book', 'book'],
  ['book/:club', 'bookclub'],
  ['bookings', 'bookings'],
  ['bookings/:id', 'booking'],
  ['waitlist/:id', 'waitlist'],
  ['me', 'me'],
  ['me/notify', 'notify'],
  // M4: Бильярдум+ (чанк plus), турниры (чанк tour), отзыв и заявка в клуб без программы (чанк club)
  ['plus', 'plus'],
  ['plus/settings', 'plussettings'],
  ['plus/rating', 'rating'],
  ['plus/rivals', 'rivals'],
  // Ссылка из уведомления о приглашении «Сыграем?» (№144) — тот же экран соперников
  ['plus/invites', 'rivals'],
  ['plus/friends', 'friends'],
  ['plus/matches/:id', 'match'],
  ['players/:nick', 'player'],
  ['tournaments', 'tournaments'],
  ['tournaments/:id', 'tournament'],
  ['review/:club', 'review'],
  ['request/:club', 'request'],
  ['requests/:id', 'requeststatus'],
  // С сайта: «Добавить клуб» и «Подтвердить клуб» (заявки оператору платформы)
  ['directory/add', 'diradd'],
  ['directory/claim/:listing', 'dirclaim'],
];
