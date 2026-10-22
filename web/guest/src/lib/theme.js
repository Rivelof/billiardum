import { local } from './store.js';

/**
 * Тема (DESIGN §2, №127): тёмная по умолчанию, светлая («слоновая кость») — по выбору.
 * Выбор хранится только в этом браузере; theme-init.js применяет его до первой отрисовки.
 */
export function getTheme() {
  return local.get('bl-theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light') root.dataset.theme = 'light';
  else delete root.dataset.theme;
  local.set('bl-theme', theme === 'light' ? 'light' : 'dark');
}

export const THEME_NEXT = { dark: 'light', light: 'dark' };
export const THEME_LABEL = { light: 'светлая', dark: 'тёмная' };
