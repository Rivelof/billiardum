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
  const items = [];
  if (can.manage(role)) items.push({ key: 'now', href: `${c}now`, icon: 'hall', label: 'Сейчас' });
  if (can.reception(role)) items.push({ key: 'reception', href: `${c}reception`, icon: 'reception', label: 'Ресепшн' });
  if (can.manage(role)) {
    items.push({ key: 'journal', href: `${c}journal`, icon: 'journal', label: 'Журнал' });
    items.push({ key: 'alarms', href: `${c}alarms`, icon: 'bell', label: 'Тревоги' });
  }
  items.push({ key: 'more', href: `${c}more`, icon: 'more', label: 'Ещё' });
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
            <a key={it.key} class="nav__item" href={it.href} onClick={linkHandler} aria-current={active === it.key ? 'page' : undefined}>
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
