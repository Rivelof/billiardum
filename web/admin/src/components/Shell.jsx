import { useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { Icon } from './Icon.jsx';
import { useNow } from './hooks.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { can } from '../lib/auth.js';
import { getTheme, setTheme, THEME_NEXT, THEME_LABEL } from '../lib/theme.js';

const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };

export function navItems(role, club) {
  const c = `${BASE}c/${encodeURIComponent(club)}/`;
  const manage = can.manage(role);
  const items = [];
  const add = (key, icon, label, wideOnly = false) => items.push({ key, href: `${c}${key}`, icon, label, wideOnly });
  // На телефоне у владельца и управляющего снизу пять пунктов: Сейчас, Смены, Журнал, Тревоги, Ещё.
  // Касса, ресепшн, бар, склад, меню, ККТ и контроллеры — в «Ещё» и в боковой панели планшета
  if (manage) add('now', 'hall', 'Сейчас');
  if (can.pos(role)) add('pos', 'cart', 'Касса', manage);
  if (can.reception(role)) add('reception', 'reception', 'Ресепшн', manage);
  if (can.bar(role)) add('bar', 'cup', 'Бар', manage);
  if (can.shift(role)) add('shift', 'register', manage ? 'Смены' : 'Смена');
  if (can.bookings(role)) add('bookings', 'calendar', 'Брони', true);
  if (manage) {
    add('journal', 'journal', 'Журнал');
    add('alarms', 'bell', 'Тревоги');
  }
  if (can.stock(role)) add('stock', 'box', 'Склад', true);
  if (can.menu(role)) add('menu', 'list', 'Меню', true);
  if (can.kkt(role)) add('kkt', 'printer', 'ККТ', true);
  if (can.packages(role)) add('packages', 'ticket', 'Пакеты', true);
  if (can.staff(role)) add('staff', 'users', 'Персонал', true);
  if (can.devices(role)) add('devices', 'chip', 'Контроллеры', manage);
  add('more', 'more', 'Ещё');
  return items;
}

/**
 * Каркас программы клуба: верхняя строка (клуб, часы, тема, сотрудник), навигация разделов
 * (снизу на телефоне, слева на планшете) и содержимое.
 */
export function Shell({ club, role, active, title, user, timeZone, alarmsCount = 0, tools, children, wide = false }) {
  const now = useNow(0, true);
  const [theme, setThemeState] = useState(getTheme);
  const items = navItems(role, club.club_id);
  return (
    <div class={`shell${wide ? ' shell--wide' : ''}`}>
      <a class="skip" href="#main">
        К содержимому
      </a>
      <header class="bar">
        <div class="bar__club">
          <span class="bar__brand display">Бильярдум</span>
          <span class="bar__name">{club.name ?? 'Клуб'}</span>
        </div>
        <h1 class="bar__title">{title}</h1>
        <div class="bar__tools">
          {tools}
          <span class="bar__clock mono" aria-label={`Время клуба ${formatTime(now, timeZone)}`}>
            {formatTime(now, timeZone)}
          </span>
          <button
            type="button"
            class="icon-btn"
            aria-label={`Тема: ${THEME_LABEL[theme]}. Включить: ${THEME_LABEL[THEME_NEXT[theme]]}`}
            onClick={() => {
              const next = THEME_NEXT[theme];
              setTheme(next);
              setThemeState(next);
            }}
          >
            <Icon name={THEME_ICON[theme]} />
          </button>
          {user ? (
            <span class="bar__user">
              <Icon name="user" />
              <span class="bar__user-name">{user.name ?? user.nick ?? user.phone_masked ?? 'Сотрудник'}</span>
            </span>
          ) : null}
        </div>
      </header>
      {items.length > 1 ? (
        <nav class="nav" aria-label="Разделы">
          {items.map((it) => (
            <a key={it.key} class={`nav__item${it.wideOnly ? ' nav__item--wide' : ''}`} href={it.href} onClick={linkHandler} aria-current={active === it.key ? 'page' : undefined}>
              <span class="nav__icon">
                <Icon name={it.icon} />
                {it.key === 'alarms' && alarmsCount ? (
                  <span class="nav__badge" aria-label={`открытых тревог: ${alarmsCount}`}>
                    {alarmsCount}
                  </span>
                ) : null}
              </span>
              <span class="nav__label">{it.label}</span>
            </a>
          ))}
        </nav>
      ) : null}
      <main class="shell__main" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
