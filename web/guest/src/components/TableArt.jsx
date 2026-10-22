import { useEffect, useMemo, useState } from 'preact/hooks';
import { tableSvg } from '@billiardum/shared/hall';

/**
 * Стол сверху из shared/hall.mjs. lit: 'true' | 'dim' | 'false' — лампа загорается плавно (0,6 с, DESIGN §6):
 * на первом кадре стол тёмный, затем свет включается переходом (при prefers-reduced-motion — сразу).
 * pulse — за 10 минут до конца игры лампа мягко пульсирует. ring (0…1) — кольцо оставшегося времени на сукне.
 * Рисунок — константная строка SVG без атрибутов style (CSP), поэтому innerHTML безопасен.
 */
export function TableArt({ kind = 'pyramid', lit = 'false', horizontal = true, pulse = false, ring = null, class: cls = '' }) {
  const html = useMemo(() => tableSvg(kind, { horizontal }), [kind, horizontal]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div class={`table-art lit-host ${cls}`} data-lit={ready ? lit : 'false'} data-pulse={pulse ? 'true' : undefined} data-kind={kind}>
      <span class="table-art__glow" aria-hidden="true" />
      <div class="table-art__svg" dangerouslySetInnerHTML={{ __html: html }} />
      {ring !== null ? <TimeRing value={ring} /> : null}
    </div>
  );
}

/** Кольцо оставшегося времени: тает по часовой стрелке от верха (DESIGN §6). */
function TimeRing({ value }) {
  const v = Math.min(1, Math.max(0, value));
  const C = 2 * Math.PI * 44;
  return (
    <svg class="time-ring" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle class="time-ring__track" cx="50" cy="50" r="44" />
      <circle class="time-ring__arc" cx="50" cy="50" r="44" stroke-dasharray={`${(C * v).toFixed(2)} ${C.toFixed(2)}`} transform="rotate(-90 50 50)" />
    </svg>
  );
}
