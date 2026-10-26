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

// ---------- плавная прокрутка колесом на всех страницах (Lenis, DESIGN §6, решение №228) ----------
// Грузится отдельным чанком после загрузки страницы, когда браузер свободен; не нужна при reduce-motion и там,
// где нет мыши или тачпада (телефон: нативная прокрутка остаётся как есть) — тогда чанк даже не скачивается.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(any-pointer: fine)').matches) {
  const later = () => {
    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
    idle(() => {
      import('@billiardum/shared/smooth-scroll').then((m) => m.startSmoothScroll({ load: () => import('lenis') })).catch(() => {});
    });
  };
  if (document.readyState === 'complete') later();
  else addEventListener('load', later, { once: true });
}
