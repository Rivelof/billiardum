import { useEffect } from 'preact/hooks';
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
};

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
    default:
      if (MOCK && extra?.render(name, params)) return extra.render(name, params);
      return <NotFound />;
  }
}
