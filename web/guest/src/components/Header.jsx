import { useState } from 'preact/hooks';
import { Icon } from './Icon.jsx';
import { getTheme, setTheme, THEME_NEXT, THEME_LABEL } from '../lib/theme.js';
import { linkHandler } from '../lib/router.js';
import { BASE } from '../lib/env.js';

const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };

/** Шапка: знак «Бильярдум» ведёт на главную, справа переключатель темы (тёмная ↔ светлая, №127). */
export function Header({ children, back }) {
  const [theme, setThemeState] = useState(getTheme);
  const next = THEME_NEXT[theme];
  return (
    <header class="top">
      {back ? (
        <a class="icon-btn top__back" href={back.href} onClick={linkHandler} aria-label={back.label}>
          <Icon name="back" />
        </a>
      ) : null}
      <a class="top__brand display" href={BASE} onClick={linkHandler}>
        Бильярдум
      </a>
      <div class="top__extra">{children}</div>
      <button
        type="button"
        class="icon-btn"
        aria-label={`Тема: ${THEME_LABEL[theme]}. Включить: ${THEME_LABEL[next]}`}
        onClick={() => {
          setTheme(next);
          setThemeState(next);
        }}
      >
        <Icon name={THEME_ICON[theme]} />
      </button>
    </header>
  );
}
