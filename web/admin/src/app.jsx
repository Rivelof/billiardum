import { useEffect } from 'preact/hooks';
import { useLocation, matchRoute, navigate, linkHandler } from './lib/router.js';
import { BASE } from './lib/env.js';
import { auth, can, clubMode, logout, platformRole } from './lib/auth.js';
import { useStore } from './lib/store.js';
import { ROLE_LABEL } from './lib/words.js';
import { SignIn } from './screens/SignIn.jsx';
import { Pin } from './screens/Pin.jsx';
import { Reception } from './screens/Reception.jsx';
import { Now } from './screens/Now.jsx';
import { Journal } from './screens/Journal.jsx';
import { Alarms } from './screens/Alarms.jsx';
import { More } from './screens/More.jsx';
import { Devices } from './screens/Devices.jsx';
import { Pos } from './screens/Pos.jsx';
import { BarScreen } from './screens/Bar.jsx';
import { Shift } from './screens/Shift.jsx';
import { ShiftReport } from './screens/ShiftReport.jsx';
import { Stock } from './screens/Stock.jsx';
import { MenuAdmin } from './screens/Menu.jsx';
import { Kkt } from './screens/Kkt.jsx';
import { Bookings } from './screens/Bookings.jsx';
import { Staff } from './screens/Staff.jsx';
import { Packages } from './screens/Packages.jsx';
import { Tournaments } from './screens/Tournaments.jsx';
import { TournamentTv } from './screens/TournamentTv.jsx';
import { Disputes } from './screens/Disputes.jsx';
import { Listing } from './screens/Listing.jsx';
import { Platform } from './screens/Platform.jsx';
import { api, setClub } from './lib/api.js';
import { session } from './lib/store.js';
import { SUB_RETURN_KEY } from './lib/billingBanner.js';
import { Icon } from './components/Icon.jsx';
import { Lazy } from './components/Lazy.jsx';
import { Shell } from './components/Shell.jsx';

const ROUTES = [
  ['', 'root'],
  ['signin', 'signin'],
  ['pin', 'pin'],
  // M5.1: «Подключить клуб» — создание клуба без выезда (отдельный чанк)
  ['start', 'start'],
  ['c/:club/:screen', 'club'],
  ['c/:club/:screen/:id', 'club'],
  // M5.7: журнал доставок одного адреса вебхука в клубе
  ['c/:club/api/webhooks/:id', 'clubhook'],
  // M5.7: ссылка из уведомления о сбое вебхука — /club/api/webhooks/{id} (без клуба) и /club/api
  ['api', 'apiroot'],
  ['api/webhooks/:id', 'apiroot'],
  // M4: ТВ-сетка турнира (без входа, публичные данные) и экран оператора платформы
  ['tv/tournament/:id', 'tv'],
  ['platform', 'platform'],
  ['platform/:tab', 'platform'],
  // Ссылка из уведомления о споре (№144): /club/plus/disputes → споры первого клуба, где можно решать
  ['plus/disputes', 'plusdisputes'],
  // Ссылка из уведомления о споре по счёту матча: /club/tournaments/{id} → турнир в первом клубе организатора
  ['tournaments/:id', 'clubtour'],
  // M5.3: возврат со страницы ЮKassa (PLATFORM_BILLING_RETURN_URL по умолчанию — /club/subscription) → «Подписка» клуба
  ['subscription', 'subreturn'],
];

const SCREENS = {
  reception: { allow: can.reception, render: (ctx) => <Reception ctx={ctx} />, title: 'Ресепшн' },
  now: { allow: can.manage, render: (ctx) => <Now ctx={ctx} />, title: 'Сейчас' },
  journal: { allow: can.manage, render: (ctx) => <Journal ctx={ctx} />, title: 'Журнал' },
  alarms: { allow: can.manage, render: (ctx) => <Alarms ctx={ctx} />, title: 'Тревоги' },
  devices: { allow: can.devices, render: (ctx) => <Devices ctx={ctx} />, title: 'Контроллеры' },
  more: { allow: () => true, render: (ctx) => <More ctx={ctx} />, title: 'Ещё' },
  // M2
  pos: { allow: can.pos, render: (ctx) => <Pos ctx={ctx} />, title: 'Касса' },
  bar: { allow: can.bar, render: (ctx) => <BarScreen ctx={ctx} />, title: 'Заказы бара' },
  shift: { allow: can.shift, render: (ctx) => (ctx.id ? <ShiftReport ctx={ctx} /> : <Shift ctx={ctx} />), title: 'Смена' },
  stock: { allow: can.stock, render: (ctx) => <Stock ctx={ctx} />, title: 'Склад' },
  menu: { allow: can.menu, render: (ctx) => <MenuAdmin ctx={ctx} />, title: 'Меню' },
  kkt: { allow: can.kkt, render: (ctx) => <Kkt ctx={ctx} />, title: 'Касса ККТ' },
  // M3
  bookings: { allow: can.bookings, render: (ctx) => <Bookings ctx={ctx} />, title: 'Брони' },
  staff: { allow: can.staff, render: (ctx) => <Staff ctx={ctx} />, title: 'Персонал' },
  packages: { allow: can.packages, render: (ctx) => <Packages ctx={ctx} />, title: 'Пакеты часов' },
  // M4
  tournaments: { allow: can.tournaments, render: (ctx) => <Tournaments ctx={ctx} />, title: 'Турниры' },
  disputes: { allow: can.disputes, render: (ctx) => <Disputes ctx={ctx} />, title: 'Споры по партиям' },
  listing: { allow: can.listing, render: (ctx) => <Listing ctx={ctx} />, title: 'Карточка в Бильярдуме' },
  // M5.1: мастер подключения — владелец (все шаги) и управляющий (зал, тарифы, меню, наклейки — №155–156),
  // отдельный чанк; шаг — в пути (/onboarding/{step})
  // M5.2: дашборд владельца (главный экран владельца, №166) и отчёты (№173–179) — отдельные чанки
  dashboard: {
    allow: can.dashboard,
    render: (ctx) => <Lazy key="dashboard" chunk="dashboard" label="Открываем дашборд…" fallback={<LazyShell ctx={ctx} active="dashboard" title="Дашборд" />} render={(m) => <m.Dashboard ctx={ctx} />} />,
    title: 'Дашборд',
  },
  reports: {
    allow: can.reportsView,
    render: (ctx) => <Lazy key="reports" chunk="reports" label="Открываем отчёты…" fallback={<LazyShell ctx={ctx} active="reports" title="Отчёты" />} render={(m) => <m.Reports ctx={ctx} />} />,
    title: 'Отчёты',
  },
  // M5.3 (№185): «Подписка» — владелец (всё) и управляющий (только состояние); отдельный чанк
  subscription: {
    allow: can.subscription,
    render: (ctx) => <Lazy key="billing" chunk="billing" label="Открываем подписку…" fallback={<LazyShell ctx={ctx} active="subscription" title="Подписка" />} render={(m) => <m.Subscription ctx={ctx} />} />,
    title: 'Подписка',
  },
  // M5.6: уведомление maintenance.due ведёт на /club/c/{club}/maintenance — раздел живёт в «Отчётах»
  maintenance: {
    allow: can.reportsView,
    render: (ctx) => <Redirect to={`${BASE}c/${encodeURIComponent(ctx.club.club_id)}/reports/maintenance`} />,
    title: 'Обслуживание столов',
  },
  // M5.7: «API и вебхуки» — только владелец, отдельный чанк; журнал адреса — /api/webhooks/{id}
  api: {
    allow: can.clubApi,
    render: (ctx) => <Lazy key="clubapi" chunk="clubapi" label="Открываем API и вебхуки…" fallback={<LazyShell ctx={ctx} active="api" title="API" />} render={(m) => <m.ClubApi ctx={ctx} webhookId={ctx.webhookId ?? null} />} />,
    title: 'API и вебхуки',
  },
  // M5.5: «Сеть» — владелец (состав, шаблоны, управляющие) и управляющий сети (читает); отдельный чанк; сеть — в пути (/network/{id})
  network: {
    allow: can.network,
    render: (ctx) => <Lazy key="network" chunk="network" label="Открываем сеть…" fallback={<LazyShell ctx={ctx} active="network" title="Сеть" />} render={(m) => <m.Network ctx={ctx} />} />,
    title: 'Сеть',
  },
  onboarding: {
    allow: can.setup,
    render: (ctx) => <Lazy key="onboarding" chunk="onboarding" label="Открываем мастер подключения…" render={(m) => <m.Onboarding ctx={ctx} />} />,
    title: 'Подключение клуба',
  },
};

/** Пока грузится чанк раздела — каркас программы с разделами, чтобы экран не мигал. */
function LazyShell({ ctx, active, title }) {
  return (
    <Shell club={ctx.club} role={ctx.role} user={ctx.user} timeZone={ctx.timeZone} active={active} title={title}>
      <div class="page" aria-busy="true">
        <p class="muted loading" role="status">
          Загружаем…
        </p>
      </div>
    </Shell>
  );
}

/**
 * Первый экран по роли: владелец — дашборд (M5.2, №166), управляющий — «Сейчас», ресепшн — касса, бармен — экран бара.
 * M5.1: владелец клуба в тестовом режиме — мастер подключения.
 */
export function homeFor(membership) {
  const r = membership.role;
  const screen = can.onboarding(r) && clubMode(membership) === 'test' ? 'onboarding' : can.owner(r) ? 'dashboard' : can.manage(r) ? 'now' : can.pos(r) ? 'pos' : can.bar(r) ? 'bar' : can.devices(r) ? 'devices' : 'more';
  return `${BASE}c/${encodeURIComponent(membership.club_id)}/${screen}`;
}

function Redirect({ to }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export function App() {
  const { pathname } = useLocation();
  const { status, user, clubs } = useStore(auth);
  const { name, params } = matchRoute(pathname, ROUTES, BASE);

  useEffect(() => {
    const t = SCREENS[params.screen]?.title;
    document.title = t ? `${t} — Бильярдум` : 'Бильярдум: программа клуба';
  }, [params.screen]);

  if (name === 'pin') return <Pin />;
  // ТВ у входа в зал: без входа сотрудника, только публичная сетка
  if (name === 'tv') return <TournamentTv key={params.id} id={params.id} />;
  if (status === 'loading') {
    return (
      <main class="signin" data-theme="dark" aria-busy="true">
        <p class="signin__brand display">Бильярдум</p>
      </main>
    );
  }
  if (status === 'anon') return name === 'signin' ? <SignIn /> : <Redirect to={`${BASE}signin`} />;

  if (name === 'platform') return <Platform tab={params.tab} />;
  // M5.1: «Подключить клуб» — и без клубов, и чтобы добавить ещё один
  if (name === 'start') return <Lazy key="start" chunk="start" label="Открываем подключение клуба…" render={(m) => <m.ClubStart />} />;
  if (!clubs.length) {
    if (platformRole(user)) return <Redirect to={`${BASE}platform`} />;
    return <Redirect to={`${BASE}start`} />;
  }

  if (name === 'clubtour') {
    const c = clubs.find((m) => can.tournaments(m.role));
    return <Redirect to={c ? `${BASE}c/${encodeURIComponent(c.club_id)}/tournaments/${encodeURIComponent(params.id)}` : BASE} />;
  }
  if (name === 'subreturn') {
    // Клуб, с которого владелец ушёл на страницу ЮKassa (sessionStorage), иначе первый клуб, где он владелец
    const back = session.get(SUB_RETURN_KEY);
    const c = clubs.find((m) => m.club_id === back?.club_id && can.subscription(m.role)) ?? clubs.find((m) => can.subscriptionManage(m.role)) ?? clubs.find((m) => can.subscription(m.role));
    return <Redirect to={c ? `${BASE}c/${encodeURIComponent(c.club_id)}/subscription` : BASE} />;
  }
  if (name === 'apiroot') {
    const owned = clubs.filter((m) => can.clubApi(m.role));
    if (!owned.length) return <Redirect to={BASE} />;
    if (params.id && owned.length > 1) return <WebhookClub clubs={owned} id={params.id} />;
    return <Redirect to={`${BASE}c/${encodeURIComponent(owned[0].club_id)}/api${params.id ? `/webhooks/${encodeURIComponent(params.id)}` : ''}`} />;
  }
  if (name === 'plusdisputes') {
    const c = clubs.find((m) => can.disputes(m.role));
    return <Redirect to={c ? `${BASE}c/${encodeURIComponent(c.club_id)}/disputes` : BASE} />;
  }

  if (name === 'root' || name === 'signin') {
    if (clubs.length === 1) return <Redirect to={homeFor(clubs[0])} />;
    return <ClubPick clubs={clubs} />;
  }

  if (name === 'club' || name === 'clubhook') {
    if (name === 'clubhook') params.screen = 'api';
    const membership = clubs.find((c) => c.club_id === params.club);
    const screen = SCREENS[params.screen];
    if (!membership || !screen) return <Redirect to={BASE} />;
    if (!screen.allow(membership.role)) return <Redirect to={homeFor(membership)} />;
    setClub(membership.club_id); // X-Club-Id для маршрутов без {club} (§14)
    // Вложенные пути: отчёт смены (/shift/{id}) — управляющему и владельцу; терминалы (/staff/terminals) — владельцу
    const nested =
      (params.screen === 'shift' && can.reports(membership.role)) || (params.screen === 'staff' && params.id === 'terminals') || params.screen === 'tournaments' || params.screen === 'onboarding' || params.screen === 'reports' || params.screen === 'network';
    if (params.id && !nested && name !== 'clubhook') return <Redirect to={homeFor(membership)} />;
    const ctx = {
      club: membership,
      role: membership.role,
      user,
      id: params.id ?? null,
      webhookId: name === 'clubhook' ? params.id : null,
      timeZone: membership.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    return screen.render(ctx);
  }

  return <Redirect to={BASE} />;
}

/**
 * Ссылка из уведомления о сбое вебхука без клуба (/club/api/webhooks/{id}) у владельца нескольких клубов:
 * ищем адрес в списках вебхуков его клубов и открываем журнал в нужном; не нашли — первый клуб.
 */
function WebhookClub({ clubs, id }) {
  useEffect(() => {
    let alive = true;
    (async () => {
      let found = null;
      for (const c of clubs) {
        try {
          const res = await api.webhooks(c.club_id);
          if ((Array.isArray(res?.items) ? res.items : []).some((h) => h.webhook_id === id)) {
            found = c;
            break;
          }
        } catch {
          // клуб недоступен — смотрим следующий
        }
      }
      if (alive) navigate(`${BASE}c/${encodeURIComponent((found ?? clubs[0]).club_id)}/api/webhooks/${encodeURIComponent(id)}`, { replace: true });
    })();
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <main class="signin" data-theme="dark" aria-busy="true">
      <p class="signin__brand display" role="status">
        Ищем адрес вебхука…
      </p>
    </main>
  );
}

function ClubPick({ clubs }) {
  return (
    <main class="signin" data-theme="dark">
      <div class="signin__card">
        <p class="signin__brand display">Бильярдум</p>
        <h1 class="signin__title">Выберите клуб</h1>
        <ul class="staff">
          {clubs.map((c) => (
            <li key={c.club_id}>
              <a class="staff__btn" href={homeFor(c)} onClick={linkHandler}>
                <Icon name="hall" />
                <span>
                  <span class="staff__name">{c.name ?? 'Клуб'}</span>
                  <span class="staff__role">
                    {c.network_id ? 'Управляющий сети' : (ROLE_LABEL[c.role] ?? c.role)}
                    {clubMode(c) === 'test' ? ' · тестовый режим' : clubMode(c) === 'suspended' ? ' · приостановлен' : ''}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
        <a class="btn btn--quiet btn--block" href={`${BASE}start`} onClick={linkHandler}>
          <Icon name="plus" />
          Подключить ещё клуб
        </a>
        <button type="button" class="btn btn--quiet btn--block" onClick={() => logout().catch(() => {})}>
          Выйти
        </button>
      </div>
    </main>
  );
}
