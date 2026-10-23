// Наклейки на корпус контроллера (M5.1 №159): PDF A4, 3 × 8 наклеек 70 × 37 мм с линиями реза.
// На наклейке: QR «BLD1:{device_id}:{claim_code}» (мастер сканирует его камерой), подпись,
// короткий номер устройства и код привязки для ручного ввода. Шрифт — тот же JetBrains Mono Bold.

import { readFileSync } from 'node:fs';
import { formatDeviceQr } from '../devices/qr.mjs';
import { createPdf, num } from './pdf.mjs';
import { FONT_FILE, PAGE, qrMatrix } from './stickers.mjs';

export const COLS = 3;
export const ROWS = 8;
export const PER_PAGE = COLS * ROWS;
const INK = '0.047 0.078 0.141';
const MUTED = '0.38 0.42 0.5';

function qrOps(matrix, x, yTop, size) {
  const n = matrix.length;
  const m = size / n;
  let ops = `${INK} rg\n`;
  for (let row = 0; row < n; row += 1) {
    let col = 0;
    while (col < n) {
      if (!matrix[row][col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < n && matrix[row][col]) col += 1;
      ops += `${num(x + start * m)} ${num(yTop - (row + 1) * m)} ${num((col - start) * m)} ${num(m)} re\n`;
    }
  }
  return `${ops}f\n`;
}

/**
 * PDF наклеек на корпус.
 * @param {{ devices: { device_id: string, claim_code: string }[], batch?: string }} input
 * @returns {Buffer}
 */
export function deviceStickersPdf({ devices, batch = null }) {
  if (!Array.isArray(devices) || devices.length === 0) throw new Error('deviceStickersPdf: нет устройств');
  const pdf = createPdf();
  const font = pdf.addFont(readFileSync(FONT_FILE), 'JetBrainsMono-Bold');
  const cellW = PAGE.width / COLS;
  const cellH = PAGE.height / ROWS;
  const text = (str, size, x, y, color = INK) => `BT ${color} rg /${font.name} ${num(size)} Tf 1 0 0 1 ${num(x)} ${num(y)} Tm ${font.encode(str)} Tj ET\n`;
  const pages = Math.ceil(devices.length / PER_PAGE);
  for (let p = 0; p < pages; p += 1) {
    let ops = `q ${MUTED} RG 0.3 w [3 3] 0 d\n`;
    for (let c = 1; c < COLS; c += 1) ops += `${num(c * cellW)} 0 m ${num(c * cellW)} ${num(PAGE.height)} l S\n`;
    for (let r = 1; r < ROWS; r += 1) ops += `0 ${num(r * cellH)} m ${num(PAGE.width)} ${num(r * cellH)} l S\n`;
    ops += 'Q\n';
    for (let i = 0; i < PER_PAGE; i += 1) {
      const d = devices[p * PER_PAGE + i];
      if (!d) break;
      const qr = formatDeviceQr(d.device_id, d.claim_code);
      const x0 = (i % COLS) * cellW;
      const yTop = PAGE.height - Math.floor(i / COLS) * cellH;
      const qrSize = cellH - 16;
      ops += qrOps(qrMatrix(qr), x0 + 8, yTop - 8, qrSize);
      const tx = x0 + 8 + qrSize + 8;
      let y = yTop - 18;
      ops += text('Бильярдум', 8, tx, y);
      y -= 10;
      ops += text('контроллер стола', 6.5, tx, y, MUTED);
      y -= 14;
      ops += text(`ID ${d.device_id.slice(0, 8)}`, 7, tx, y);
      y -= 12;
      ops += text('Код привязки:', 6, tx, y, MUTED);
      y -= 9;
      ops += text(d.claim_code, 6.5, tx, y);
      if (batch) ops += text(batch.slice(0, 20), 5.5, tx, yTop - cellH + 8, MUTED);
    }
    pdf.addPage(ops, PAGE);
  }
  return pdf.build({ title: batch ? `Наклейки контроллеров: ${batch}` : 'Наклейки контроллеров' });
}
