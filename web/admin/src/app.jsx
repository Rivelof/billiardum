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
import { setClub } from './lib/api.js';
import { Icon } from './components/Icon.jsx';

const ROUTES = [
  ['', 'root'],
  ['signin', 'signin'],
  ['pin', 'pin'],
  ['c/:club/:screen', 'club'],
];

const SCREENS = {
  reception: { allow: can.reception, render: (ctx) => <Reception ctx={ctx} />, title: 'Ресепшн' },
  now: { allow: can.manage, render: (ctx) => <Now ctx={ctx} />, title: 'Сейчас' },
  journal: { allow: can.manage, render: (ctx) => <Journal ctx={ctx} />, title: 'Журнал' },
  alarms: { allow: can.manage, render: (ctx) => <Alarms ctx={ctx} />, title: 'Тревоги' },
  devices: { allow: can.devices, render: (ctx) => <Devices ctx={ctx} />, title: 'Контроллеры' },
  more: { allow: () => true, render: (ctx) => <More ctx={ctx} />, title: 'Ещё' },
};

/** Первый экран по роли: владелец и управляющий — «Сейчас», ресепшн — очередь заявок. */
export function homeFor(membership) {
  const screen = can.manage(membership.role) ? 'now' : can.reception(membership.role) ? 'reception' : can.devices(membership.role) ? 'devices' : 'more';
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
    const ctx = {
      club: membership,
      role: membership.role,
      user,
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
