import { useMemo } from 'preact/hooks';
import { encode } from 'uqr';

/**
 * QR для оплаты по СБП на экране ресепшена (контракт m2 §5: confirmation.type = qr, confirmation_data от ЮKassa).
 * Рисуется SVG одним путём: тёмные модули на светлом поле в обеих темах (иначе банковское приложение не прочтёт),
 * поэтому блок всегда в светлой теме. Без атрибутов style — работает при строгой CSP.
 */
export function QrCode({ data, label }) {
  const path = useMemo(() => {
    if (!data) return null;
    const qr = encode(data, { ecc: 'M', border: 0 });
    let d = '';
    qr.data.forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        if (!row[x]) {
          x += 1;
          continue;
        }
        const start = x;
        while (x < row.length && row[x]) x += 1;
        d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
      }
    });
    return { d, size: qr.size };
  }, [data]);

  if (!path) return null;
  const q = 4; // тихая зона — 4 модуля по стандарту QR
  return (
    <div class="qr" data-theme="light">
      <svg class="qr__svg" viewBox={`${-q} ${-q} ${path.size + 2 * q} ${path.size + 2 * q}`} role="img" aria-label={label} shape-rendering="crispEdges">
        <rect class="qr__bg" x={-q} y={-q} width={path.size + 2 * q} height={path.size + 2 * q} />
        <path class="qr__dots" d={path.d} />
      </svg>
    </div>
  );
}
