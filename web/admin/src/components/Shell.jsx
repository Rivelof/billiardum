import { useState } from 'preact/hooks';
import { formatTime } from '@billiardum/shared/format';
import { Icon } from './Icon.jsx';
import { useNow } from './hooks.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';
import { can, clubMode } from '../lib/auth.js';
import { navItems } from '../lib/nav.js';
import { getTheme, setTheme, THEME_NEXT, THEME_LABEL } from '../lib/theme.js';
import { SubBanner } from './SubBanner.jsx';

const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };

export { navItems };

/**
 * Плашка режима клуба (M5.1, №153): заметная, но не мешает работе — одна строка над экраном, прокручивается вместе с ним.
 * Тестовый режим: свет настоящий, денег нет. Владельцу — переход к чек-листу запуска.
 */
export function ModeNote({ club, role, active }) {
  const mode = clubMode(club);
  if (mode !== 'test' && mode !== 'suspended') return null;
  const href = `${BASE}c/${encodeURIComponent(club.club_id)}/onboarding/go_live`;
  if (mode === 'suspended') {
    return (
      <p class="modenote modenote--stop" role="note">
        <Icon name="alert" />
        <span>
          <b>Клуб приостановлен платформой.</b> Гости не могут оплатить игру через Бильярдум. Причина — у поддержки Бильярдума.
        </span>
      </p>
    );
  }
  return (
    <p class="modenote" role="note">
      <Icon name="flask" />
      <span>
        <b>Тестовый режим.</b> Свет включается по-настоящему, а оплаты тестовые: деньги не списываются, чеки не пробиваются.
      </span>
      {can.onboarding(role) && active !== 'onboarding' ? (
        <a class="modenote__link" href={href} onClick={linkHandler}>
          Чек-лист запуска
        </a>
      ) : null}
    </p>
  );
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
          <span class="bar__name" title={club.name ?? 'Клуб'}>
            {club.name ?? 'Клуб'}
          </span>
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
        <ModeNote club={club} role={role} active={active} />
        {/* M5.3: плашка подписки — на кассе, ресепшене и в бронях (широкие рабочие экраны) компактная */}
        <SubBanner club={club} role={role} active={active} timeZone={timeZone} compact={wide} />
        {children}
      </main>
    </div>
  );
}
