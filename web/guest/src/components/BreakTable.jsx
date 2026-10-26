import { useEffect, useRef } from 'preact/hooks';
import { mountBreak } from '@billiardum/shared/break';

/**
 * «Разбой при прокрутке» (DESIGN §6) — главная гостя, отдельный чанк. Рисунок и поведение — общие с сайтом:
 * shared/break.mjs. Стол сверху на canvas: ореховый борт, латунные накладки, сукно под лампой, 15 шаров русской
 * пирамиды (слоновая кость с номерами) и биток. Кадр берётся из предрасчёта по прогрессу прокрутки, который
 * догоняет цель плавно (не зависит от частоты кадров), положения между кадрами интерполируются. Короткая
 * страница без прокрутки — разбой проигрывается один раз сам. prefers-reduced-motion — стоит собранная пирамида.
 */
export function BreakTable({ class: cls = '' }) {
  const ref = useRef(null);
  useEffect(() => (ref.current ? mountBreak(ref.current) : undefined), []);
  return <canvas ref={ref} class={`break ${cls}`} role="img" aria-label="Стол сверху: пирамида из 15 шаров, при прокрутке биток разбивает её" />;
}
