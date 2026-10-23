/**
 * Остров на каждой странице: переключатель темы и фильтры без перезагрузки.
 * Без JS всё работает: тема тёмная, фильтры — обычная форма GET с кнопкой.
 */

// ---------- тема (DESIGN §2: тёмная по умолчанию, выбор запоминается; ключ общий с приложением гостя) ----------
const btn = document.querySelector('[data-theme-toggle]');
if (btn) {
  const root = document.documentElement;
  const sync = () => {
    const light = root.getAttribute('data-theme') === 'light';
    btn.setAttribute('aria-label', light ? 'Включить тёмную тему' : 'Включить светлую тему');
    btn.setAttribute('aria-pressed', light ? 'true' : 'false');
  };
  btn.hidden = false;
  sync();
  btn.addEventListener('click', () => {
    const light = root.getAttribute('data-theme') !== 'light';
    if (light) root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    try {
      localStorage.setItem('bl-theme', light ? 'light' : 'dark');
    } catch {
      // хранилище недоступно — тема до перезагрузки
    }
    sync();
  });
}

// ---------- фильтры каталога и рейтинга: меняем только результаты, фокус остаётся на фильтре ----------
for (const form of document.querySelectorAll('form[data-autosubmit]')) {
  let ctrl = null;
  for (const b of form.querySelectorAll('[data-autosubmit-hide]')) b.hidden = true;
  form.addEventListener('change', async () => {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v !== '') params.append(k, String(v));
    const qs = params.toString();
    const href = form.getAttribute('action').split('#')[0] + (qs ? `?${qs}` : '');
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await fetch(href, { signal: ctrl.signal, headers: { accept: 'text/html' } });
      if (!res.ok) throw new Error(String(res.status));
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      // обновляем всё, что зависит от фильтров: список, счётчик, «Сбросить», зависимые поля (клубы города)
      for (const sel of ['.catalog__list', '.filters__reset']) {
        const fresh = doc.querySelector(sel);
        const cur = document.querySelector(sel);
        if (fresh && cur) cur.replaceWith(fresh);
        else if (cur && !fresh) cur.remove();
        else if (fresh && !cur && sel === '.filters__reset') form.append(fresh);
      }
      history.replaceState(null, '', href);
      document.title = doc.title;
    } catch (err) {
      if (err?.name !== 'AbortError') location.href = href;
    }
  });
}
