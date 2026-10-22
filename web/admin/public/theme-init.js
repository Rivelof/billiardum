// Тема до первой отрисовки, чтобы экран не мигал. Отдельный файл: CSP запрещает встроенные скрипты.
// По умолчанию тёмная (DESIGN §2, №127); светлая — только если её выбрали в этом браузере.
try {
  if (localStorage.getItem('bl-theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
} catch {
  // хранилище недоступно — тёмная тема
}
