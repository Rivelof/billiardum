/**
 * «Для клубов»: живая демо-программа ресепшена (стол запускается и останавливается, лампа загорается),
 * модули как переключаемый обзор (вкладки с клавиатурой) и расчёт тарифа по числу столов.
 */
import { formatMoney, plural } from '@billiardum/shared/format';

// ---------- демо зала ----------
const demo = document.querySelector('[data-demo]');
if (demo) {
  const items = [...demo.querySelectorAll('.demo__t')];
  const free = demo.querySelector('[data-demo-free]');
  const sync = () => {
    const n = items.filter((li) => li.querySelector('[data-demo-art]').dataset.lit !== 'true').length;
    free.textContent = `Свободно ${n} из ${items.length}`;
  };
  items.forEach((li, i) => {
    const b = li.querySelector('[data-demo-btn]');
    const art = li.querySelector('[data-demo-art]');
    const word = li.querySelector('[data-demo-word]');
    b.hidden = false;
    b.addEventListener('click', () => {
      const on = art.dataset.lit !== 'true';
      art.dataset.lit = on ? 'true' : 'false';
      word.textContent = on ? 'Идёт игра' : 'Свободен';
      b.textContent = on ? 'Остановить' : 'Запустить';
      b.setAttribute('aria-label', `Стол ${i + 1}: ${on ? 'остановить' : 'запустить'}`);
      b.dataset.on = on ? 'true' : 'false';
      sync();
    });
  });
}

// ---------- модули: вкладки (WAI-ARIA tabs), без JS все описания видны списком ----------
const mods = document.querySelector('[data-modules]');
if (mods) {
  const list = mods.querySelector('[data-modules-tabs]');
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const panels = [...mods.querySelectorAll('[data-panel]')];
  list.hidden = false;
  mods.classList.add('modules--tabs');
  const select = (i, focus) => {
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', k === i ? 'true' : 'false');
      t.tabIndex = k === i ? 0 : -1;
    });
    panels.forEach((p, k) => {
      p.hidden = k !== i;
      p.setAttribute('role', 'tabpanel');
    });
    if (focus) tabs[i].focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(i, false));
    t.addEventListener('keydown', (e) => {
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (e.key in keys) {
        e.preventDefault();
        select((i + keys[e.key] + tabs.length) % tabs.length, true);
      } else if (e.key === 'Home') {
        e.preventDefault();
        select(0, true);
      } else if (e.key === 'End') {
        e.preventDefault();
        select(tabs.length - 1, true);
      }
    });
  });
  select(0, false);
}

// ---------- расчёт тарифа по числу столов ----------
const calc = document.querySelector('[data-calc]');
if (calc) {
  const range = calc.querySelector('input[type="range"]');
  const out = calc.querySelector('[data-calc-n]');
  const update = () => {
    const n = Number(range.value);
    out.textContent = String(n);
    range.setAttribute('aria-valuetext', `${n} ${plural(n, ['стол', 'стола', 'столов'])}`);
    for (const el of document.querySelectorAll('[data-calc-total]')) el.textContent = formatMoney(Number(el.dataset.calcTotal) * n * 100);
    for (const el of document.querySelectorAll('[data-calc-tables]')) el.textContent = `${n} ${plural(n, ['стол', 'стола', 'столов'])}`;
  };
  range.addEventListener('input', update);
  calc.addEventListener('submit', (e) => e.preventDefault());
  update();
}
