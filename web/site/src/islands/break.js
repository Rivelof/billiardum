/**
 * Разбой пирамиды при прокрутке (DESIGN §6) на главной сайта. До первой прокрутки и при
 * prefers-reduced-motion видна собранная пирамида (SVG с сервера) — тот же кадр, что первый кадр canvas.
 * Симуляцию считаем только когда человек начал листать: загрузка страницы не платит за физику (TBT).
 */
import { mountBreak } from '@billiardum/shared/break';

const box = document.querySelector('[data-break]');
const canvas = box?.querySelector('canvas');
const still = box?.querySelector('.hero__still');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (canvas && !reduce) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    removeEventListener('scroll', start);
    canvas.hidden = false;
    mountBreak(canvas, {
      onReady: () => {
        if (still) still.hidden = true;
      },
    });
  };
  if (scrollY > 0) start();
  else addEventListener('scroll', start, { passive: true });
}
