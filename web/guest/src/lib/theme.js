import { local } from './store.js';

/** Тема: 'auto' (как в системе), 'light', 'dark'. Выбор хранится только в этом браузере. */
export function getTheme() {
  const saved = local.get('bl-theme');
  return saved === 'light' || saved === 'dark' ? saved : 'auto';
}

export function setTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') {
    root.dataset.theme = theme;
    local.set('bl-theme', theme);
  } else {
    delete root.dataset.theme;
    local.set('bl-theme', null);
  }
}

export const THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
export const THEME_LABEL = { auto: 'как в системе', light: 'светлая', dark: 'тёмная' };
