import { useEffect, useState } from 'preact/hooks';
import { useLocation, matchRoute } from './lib/router.js';
import { BASE, MOCK } from './lib/env.js';
import { ROUTES } from './lib/routes.js';
import { Home } from './screens/Home.jsx';
import { TableScreen } from './screens/Table.jsx';
import { WaitPayment, WaitReception } from './screens/Waiting.jsx';
import { GameScreen } from './screens/Game.jsx';
import { ReceiptScreen } from './screens/Receipt.jsx';
import { Privacy } from './screens/Privacy.jsx';
import { NotFound } from './screens/NotFound.jsx';


const TITLES = {
  home: 'Бильярдум',
  table: 'Стол — Бильярдум',
  wait: 'Оплата — Бильярдум',
  reception: 'Оплата на ресепшене — Бильярдум',
  game: 'Игра — Бильярдум',
  receipt: 'Чек — Бильярдум',
  privacy: 'Политика обработки данных — Бильярдум',
  bar: 'Бар — Бильярдум',
  order: 'Заказ бара — Бильярдум',
  tabpaid: 'Счёт стола — Бильярдум',
  book: 'Бронь стола — Бильярдум',
  bookclub: 'Бронь стола — Бильярдум',
  bookings: 'Мои брони — Бильярдум',
  booking: 'Бронь — Бильярдум',
  waitlist: 'Стол освободился — Бильярдум',
  me: 'Профиль — Бильярдум',
  notify: 'Уведомления — Бильярдум',
};

// M3: бронь и профиль — отдельные чанки, как бар (бюджет первой загрузки < 200 КБ JS)
const CHUNKS = {
  book: () => import('./screens/Book.jsx'),
  profile: () => import('./screens/Profile.jsx'),
};
const loaded = {};
function Lazy({ chunk, label, render }) {
  const [mod, setMod] = useState(loaded[chunk] ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (mod) return;
    CHUNKS[chunk]()
      .then((m) => {
        loaded[chunk] = m;
        setMod(m);
      })
      .catch(() => setFailed(true));
  }, [chunk]);
  if (failed) {
    return (
      <div class="screen screen--paper">
        <main class="wrap content">
          <p class="lead">Не получилось загрузить страницу. Проверьте интернет и обновите её.</p>
          <button type="button" class="btn btn--primary btn--block" onClick={() => location.reload()}>
            Обновить страницу
          </button>
        </main>
      </div>
    );
  }
  if (!mod) {
    return (
      <div class="screen screen--paper" aria-busy="true">
        <main class="wrap content">
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            {label}
          </p>
        </main>
      </div>
    );
  }
  return render(mod);
}

// Бар — отдельный чанк: на первую загрузку (QR → стол → оплата) он не нужен, бюджет < 200 КБ JS
let barChunk = null;
function LazyBar({ name, params }) {
  const [mod, setMod] = useState(barChunk);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (mod) return;
    import('./screens/Bar.jsx')
      .then((m) => {
        barChunk = m;
        setMod(m);
      })
      .catch(() => setFailed(true));
  }, []);
  if (failed) {
    return (
      <div class="screen screen--paper">
        <main class="wrap content">
          <p class="lead">Не получилось загрузить меню бара. Проверьте интернет и обновите страницу.</p>
          <button type="button" class="btn btn--primary btn--block" onClick={() => location.reload()}>
            Обновить страницу
          </button>
        </main>
      </div>
    );
  }
  if (!mod) {
    return (
      <div class="screen screen--paper" aria-busy="true">
        <main class="wrap content">
          <p class="waiting" role="status">
            <span class="waiting__dot" aria-hidden="true" />
            Открываем бар…
          </p>
        </main>
      </div>
    );
  }
  if (name === 'order') return <mod.OrderPaid key={params.id} orderId={params.id} />;
  if (name === 'tabpaid') return <mod.TabPaid key={params.id} sessionId={params.id} />;
  return <mod.BarScreen key={params.id} sessionId={params.id} />;
}

/** Приложение гостя: маршруты под /app/. extraRoutes — только в режиме заглушки (страница «ЮKassa»). */
export function App({ extra }) {
  const { pathname, search } = useLocation();
  const routes = MOCK && extra ? [...ROUTES, ...extra.routes] : ROUTES;
  const { name, params } = matchRoute(pathname, routes, BASE);

  useEffect(() => {
    document.title = TITLES[name] ?? 'Бильярдум';
  }, [name]);

  switch (name) {
    case 'home':
      return <Home />;
    case 'table':
      return <TableScreen key={params.code} code={params.code} search={search} />;
    case 'wait':
      return <WaitPayment key={params.paymentId} paymentId={params.paymentId} />;
    case 'reception':
      return <WaitReception key={params.requestId} requestId={params.requestId} />;
    case 'game':
      return <GameScreen key={params.id} id={params.id} />;
    case 'receipt':
      return <ReceiptScreen key={params.id} id={params.id} />;
    case 'privacy':
      return <Privacy />;
    case 'bar':
    case 'order':
    case 'tabpaid':
      return <LazyBar name={name} params={params} />;
    case 'book':
      return <Lazy key="book" chunk="book" label="Открываем бронь…" render={(m) => <m.BookClubs />} />;
    case 'bookclub':
      return <Lazy key="book" chunk="book" label="Открываем бронь…" render={(m) => <m.BookScreen key={params.club} clubId={params.club} search={search} />} />;
    case 'bookings':
      return <Lazy key="book" chunk="book" label="Загружаем брони…" render={(m) => <m.MyBookings />} />;
    case 'booking':
      return <Lazy key="book" chunk="book" label="Загружаем бронь…" render={(m) => <m.BookingScreen key={params.id} id={params.id} />} />;
    case 'waitlist':
      return <Lazy key="book" chunk="book" label="Проверяем стол…" render={(m) => <m.WaitlistOffer key={params.id} id={params.id} />} />;
    case 'me':
      return <Lazy key="profile" chunk="profile" label="Открываем профиль…" render={(m) => <m.ProfileScreen search={search} />} />;
    case 'notify':
      return <Lazy key="profile" chunk="profile" label="Открываем уведомления…" render={(m) => <m.NotifyScreen />} />;
    default:
      if (MOCK && extra?.render(name, params)) return extra.render(name, params);
      return <NotFound />;
  }
}
