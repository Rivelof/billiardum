// Тема до первой отрисовки, чтобы экран не мигал. Отдельный файл: CSP запрещает встроенные скрипты.
// Выбор живёт только в этом браузере: 'light', 'dark' или нет записи — как в системе.
try {
  const saved = localStorage.getItem('bl-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
} catch {
  // хранилище недоступно — тема по системе
}
