import { useMemo } from 'preact/hooks';
import { tableSvg } from '@billiardum/shared/hall';

/**
 * Стол сверху из shared/hall.mjs. lit: 'true' | 'dim' | 'false' — лампа загорается плавно (0,6 с, DESIGN §6).
 * Рисунок — константная строка SVG без атрибутов style (CSP), поэтому innerHTML безопасен.
 */
export function TableArt({ kind = 'pyramid', lit = 'false', horizontal = true, class: cls = '' }) {
  const html = useMemo(() => tableSvg(kind, { horizontal }), [kind, horizontal]);
  return (
    <div class={`table-art lit-host ${cls}`} data-lit={lit} data-kind={kind}>
      <span class="table-art__glow" aria-hidden="true" />
      <div class="table-art__svg" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
