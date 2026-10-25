/**
 * План зала вживую: каждые 30 с (пока вкладка видна) берём статусы столов из публичного API и
 * обновляем свет, подпись и подпись для экранного диктора. Без JS план показывает состояние на момент загрузки.
 */
import { plural } from '@billiardum/shared/format';
import { courtsWord, freeWord, hallKey, hallLabel, publicTableState } from '../lib.mjs';

const PERIOD = 30_000;

for (const hall of document.querySelectorAll('[data-hall]')) {
  const src = hall.dataset.src;
  const tz = hall.dataset.tz;
  let timer = 0;
  const tick = async () => {
    if (document.hidden) return;
    try {
      const res = await fetch(src, { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const json = await res.json();
      // Форма ответа — GET /api/public/clubs/{city}/{slug}: live.tables (server/directory/README.md)
      // M5.8: у корта своя нумерация — ключ «court-1», счётчик свободных кортов отдельный
      const resources = (json.live?.tables ?? []).map((t) => ({
        number: t.number, status: t.status, until: t.busy_until ?? null, family: t.family === 'court' || t.discipline === 'padel' ? 'court' : 'table',
      }));
      let free = 0;
      let freeCourts = 0;
      for (const r of resources) {
        const st = publicTableState(r, tz);
        if (st.tone === 'free' || st.tone === 'booked') {
          if (r.family === 'court') freeCourts += 1;
          else free += 1;
        }
        const el = hall.querySelector(`.tbl[data-n="${hallKey(r)}"]`);
        if (!el) continue;
        el.dataset.tone = st.tone;
        el.querySelector('.lit-host')?.setAttribute('data-lit', st.lit ? 'true' : 'false');
        const s = el.querySelector('[data-status]');
        if (s && s.textContent !== st.word) s.textContent = st.word;
        const label = hallLabel(r, st);
        el.setAttribute('aria-label', el.tagName === 'A' ? `${label}. Забронировать` : label);
      }
      const n = hall.querySelector('[data-hall-free]');
      const w = hall.querySelector('[data-hall-word]');
      if (n && String(free) !== n.textContent) n.textContent = String(free);
      if (w) w.textContent = `${plural(free, ['стол', 'стола', 'столов'])} ${freeWord(free)}`;
      const nc = hall.querySelector('[data-hall-free-court]');
      const wc = hall.querySelector('[data-hall-word-court]');
      if (nc && String(freeCourts) !== nc.textContent) nc.textContent = String(freeCourts);
      if (wc) wc.textContent = `${courtsWord(freeCourts)} ${freeWord(freeCourts)}`;
    } catch {
      // нет связи — попробуем в следующий раз
    }
  };
  const start = () => {
    clearInterval(timer);
    timer = setInterval(tick, PERIOD);
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      tick();
      start();
    }
  });
  start();
}
