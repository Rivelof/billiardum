import { useEffect } from 'preact/hooks';
import { useLocation, matchRoute, navigate, linkHandler } from './lib/router.js';
import { BASE } from './lib/env.js';
import { auth, can, logout } from './lib/auth.js';
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
import { setClub } from './lib/api.js';
import { Icon } from './components/Icon.jsx';

const ROUTES = [
  ['', 'root'],
  ['signin', 'signin'],
  ['pin', 'pin'],
  ['c/:club/:screen', 'club'],
  ['c/:club/:screen/:id', 'club'],
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
};

/** Первый экран по роли: владелец и управляющий — «Сейчас», ресепшн — касса, бармен — экран бара. */
export function homeFor(membership) {
  const r = membership.role;
  const screen = can.manage(r) ? 'now' : can.pos(r) ? 'pos' : can.bar(r) ? 'bar' : can.devices(r) ? 'devices' : 'more';
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
  if (status === 'loading') {
    return (
      <div class="signin" data-theme="dark" aria-busy="true">
        <p class="signin__brand display">Бильярдум</p>
      </div>
    );
  }
  if (status === 'anon') return name === 'signin' ? <SignIn /> : <Redirect to={`${BASE}signin`} />;

  if (!clubs.length) {
    return (
      <Message title="Вас ещё нет в персонале клуба">
        Попросите владельца клуба добавить ваш номер телефона{user?.phone_masked ? ` (${user.phone_masked})` : ''} в персонал, затем войдите снова.
      </Message>
    );
  }

  if (name === 'root' || name === 'signin') {
    if (clubs.length === 1) return <Redirect to={homeFor(clubs[0])} />;
    return <ClubPick clubs={clubs} />;
  }

  if (name === 'club') {
    const membership = clubs.find((c) => c.club_id === params.club);
    const screen = SCREENS[params.screen];
    if (!membership || !screen) return <Redirect to={BASE} />;
    if (!screen.allow(membership.role)) return <Redirect to={homeFor(membership)} />;
    setClub(membership.club_id); // X-Club-Id для маршрутов без {club} (§14)
    // Отчёт смены (/shift/{id}) — только управляющему и владельцу; у других экранов вложенных путей нет
    if (params.id && !(params.screen === 'shift' && can.reports(membership.role))) return <Redirect to={homeFor(membership)} />;
    const ctx = {
      club: membership,
      role: membership.role,
      user,
      id: params.id ?? null,
      timeZone: membership.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    return screen.render(ctx);
  }

  return <Redirect to={BASE} />;
}

function ClubPick({ clubs }) {
  return (
    <div class="signin" data-theme="dark">
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
                  <span class="staff__role">{ROLE_LABEL[c.role] ?? c.role}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Message({ title, children }) {
  return (
    <div class="signin" data-theme="dark">
      <div class="signin__card">
        <p class="signin__brand display">Бильярдум</p>
        <h1 class="signin__title">{title}</h1>
        <p class="hint">{children}</p>
        <button type="button" class="btn btn--quiet btn--block" onClick={() => logout().catch(() => {})}>
          Выйти
        </button>
      </div>
    </div>
  );
}
