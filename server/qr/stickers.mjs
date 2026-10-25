// QR-наклейки на столы (контракт M1 §7): PDF A4, четыре наклейки A6 на лист с линиями
// реза. На наклейке: клуб, номер стола крупно, QR https://{PUBLIC_HOST}/t/{code},
// короткий код стола и подсказка. Шрифт — JetBrains Mono Bold (OFL, fonts/OFL.txt),
// DESIGN §3: номера и коды — JetBrains Mono.

import { familyOf, noun } from '../lib/resource-kinds.mjs';
import { readFileSync } from 'node:fs';
import { encode } from 'uqr';
import { createPdf, num } from './pdf.mjs';

export const FONT_FILE = new URL('./fonts/JetBrainsMono-Bold.ttf', import.meta.url);
export const PAGE = { width: 595.28, height: 841.89 };
export const PER_PAGE = 4;
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const INK = '0.047 0.078 0.141';
const MUTED = '0.38 0.42 0.5';

let fontCache = null;
function fontBuffer() {
  fontCache ??= readFileSync(FONT_FILE);
  return fontCache;
}

/** Адрес из QR: https://{host}/t/{code}. */
export function tableUrl(publicHost, code) {
  return `https://${publicHost}/t/${code}`;
}

/** Код для глаз: TEST0 00001. */
export function formatCode(code) {
  return `${code.slice(0, 5)} ${code.slice(5)}`;
}

/** Матрица QR (true — тёмный модуль), уровень коррекции Q: наклейка может испачкаться. */
export function qrMatrix(text) {
  const qr = encode(text, { ecc: 'Q', border: 0 });
  return qr.data;
}

/** Тёмные модули прямоугольниками: подряд идущие в строке — одним «re». */
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

function wrap(font, text, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && font.width(next, size) > maxWidth) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * PDF с наклейками.
 * @param {{ clubName: string, publicHost: string, resources: { number: number, code: string, type?: string }[] }} input
 *   type — вид ресурса (M5.8): на наклейке корта — «КОРТ», стола — «СТОЛ»; сначала столы, затем корты.
 * @returns {Buffer}
 */
export function stickersPdf({ clubName, publicHost, resources }) {
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(publicHost)) throw new Error('stickers: PUBLIC_HOST');
  const pdf = createPdf();
  const font = pdf.addFont(fontBuffer(), 'JetBrainsMono-Bold');
  const cellW = PAGE.width / 2;
  const cellH = PAGE.height / 2;
  const items = [...resources].sort((a, b) => Number(familyOf(a.type) === 'court') - Number(familyOf(b.type) === 'court') || a.number - b.number);

  function text(str, size, cx, y, color = INK) {
    const w = font.width(str, size);
    return `BT ${color} rg /${font.name} ${num(size)} Tf 1 0 0 1 ${num(cx - w / 2)} ${num(y)} Tm ${font.encode(str)} Tj ET\n`;
  }

  const pageCount = Math.max(1, Math.ceil(items.length / PER_PAGE));
  for (let p = 0; p < pageCount; p += 1) {
    let ops = '';
    // Линии реза.
    ops += `q ${MUTED} RG 0.5 w [4 4] 0 d ${num(cellW)} 0 m ${num(cellW)} ${num(PAGE.height)} l S 0 ${num(cellH)} m ${num(PAGE.width)} ${num(cellH)} l S Q\n`;
    for (let i = 0; i < PER_PAGE; i += 1) {
      const r = items[p * PER_PAGE + i];
      if (!r) break;
      if (!CODE.test(r.code)) throw new Error('stickers: код стола');
      const x0 = (i % 2) * cellW;
      const y0 = PAGE.height - (Math.floor(i / 2) + 1) * cellH;
      const cx = x0 + cellW / 2;
      let y = y0 + cellH - 24;
      const club = clubName.length > 40 ? `${clubName.slice(0, 39)}…` : clubName;
      y -= 10;
      ops += text(club, 10, cx, y, MUTED);
      y -= 30;
      ops += text(noun(r.type).toUpperCase(), 14, cx, y);
      y -= 62;
      ops += text(String(r.number), 64, cx, y);
      const qrSize = 156;
      y -= 22;
      ops += qrOps(qrMatrix(tableUrl(publicHost, r.code)), cx - qrSize / 2, y, qrSize);
      y -= qrSize + 30;
      ops += text(formatCode(r.code), 18, cx, y);
      y -= 20;
      for (const line of wrap(font, 'Наведите камеру телефона на код, чтобы оплатить и включить свет', 8.5, cellW - 56)) {
        ops += text(line, 8.5, cx, y, MUTED);
        y -= 11;
      }
      ops += text(`${publicHost}/t/${r.code}`, 7, cx, y0 + 18, MUTED);
    }
    pdf.addPage(ops, PAGE);
  }
  return pdf.build({ title: `QR-наклейки: ${clubName}` });
}
