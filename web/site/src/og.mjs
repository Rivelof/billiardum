/**
 * OG-картинки 1200 × 630 (контракт M4 §1 п.15): SVG на сервере → PNG через @resvg/resvg-js (своя сборка
 * без сети, шрифты — свои файлы из og/fonts). Кэш в памяти (и на диске, если задан OG_CACHE_DIR).
 * Если resvg не установился (необязательная зависимость), отдаём SVG с тем же адресом и типом image/svg+xml:
 * браузеры его покажут, а соцсети — нет; это видно в логе при старте.
 *
 * resvg не понимает CSS-переменные, поэтому цвета здесь — значения токенов DESIGN.md §2 (тёмная тема, зал).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const FONT_SRC = fileURLToPath(new URL('../og/fonts/', import.meta.url));

const C = {
  paper: '#120E0B',
  card: '#1C1612',
  line: '#3A2E24',
  ink: '#F3EADB',
  ink2: '#C7B69E',
  cloth: '#3FA373',
  lamp: '#F4B860',
  brass: '#C99A55',
  rail: '#4A2F1C',
  railHi: '#8A5B34',
  clothOn: '#2F9A63',
  clothOff: '#1E4A34',
  hallBg: '#15100C',
};

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Перенос строки по словам под ширину в символах; лишнее — многоточие. */
export function wrap(text, width, maxLines) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1].replace(/[,.:;]?$/, '')}…`;
    return cut;
  }
  return lines;
}

/** Стол сверху горизонтально с горящей лампой и собранной пирамидой — рисунок карточки. */
function tableArt(x, y, w) {
  const h = Math.round(w * (2115 / 3890));
  const rail = Math.round(w * (170 / 3890));
  const fw = w - 2 * rail;
  const fh = h - 2 * rail;
  const r = Math.max(4, Math.round(fw * 0.021));
  const balls = [];
  const apex = 0.72;
  const step = r * 2 * Math.cos(Math.PI / 6) + 1;
  for (let row = 0; row < 5; row += 1) {
    for (let k = 0; k <= row; k += 1) {
      balls.push([x + rail + apex * fw + row * step, y + rail + fh / 2 + (k - row / 2) * (2 * r + 1)]);
    }
  }
  const pockets = [[0, 0], [0.5, 0], [1, 0], [0, 1], [0.5, 1], [1, 1]].map(([px, py]) => [x + rail + px * fw, y + rail + py * fh]);
  return `
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${C.lamp}" stop-opacity="0.35"/><stop offset="1" stop-color="${C.lamp}" stop-opacity="0"/></radialGradient>
    <linearGradient id="wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.railHi}"/><stop offset="0.45" stop-color="${C.rail}"/><stop offset="1" stop-color="${C.hallBg}"/></linearGradient>
    <radialGradient id="cloth" cx="0.5" cy="0.5" r="0.62"><stop offset="0" stop-color="${C.clothOn}"/><stop offset="1" stop-color="${C.clothOff}"/></radialGradient>
    <radialGradient id="ball" cx="0.33" cy="0.3" r="0.7"><stop offset="0" stop-color="#FFFDF8"/><stop offset="0.55" stop-color="#F0E6D6"/><stop offset="1" stop-color="#B3A795"/></radialGradient>
  </defs>
  <ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w * 0.75}" ry="${h * 0.95}" fill="url(#glow)"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h * 0.06)}" fill="url(#wood)"/>
  ${pockets.map(([px, py], i) => `<circle cx="${px}" cy="${py}" r="${Math.round(fw * (i % 3 === 1 ? 0.044 : 0.05))}" fill="${C.brass}"/>`).join('')}
  <rect x="${x + rail}" y="${y + rail}" width="${fw}" height="${fh}" fill="url(#cloth)"/>
  ${pockets.map(([px, py], i) => `<circle cx="${px}" cy="${py}" r="${Math.round(fw * (i % 3 === 1 ? 0.03 : 0.034))}" fill="${C.hallBg}"/>`).join('')}
  <circle cx="${x + rail + 0.22 * fw}" cy="${y + rail + fh / 2}" r="${r}" fill="url(#ball)"/>
  ${balls.map(([bx, by]) => `<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="${r}" fill="url(#ball)"/>`).join('')}`;
}

/**
 * @param {{ title: string, subtitle?: string, facts?: string[], kicker?: string }} card
 * @returns {string} SVG 1200 × 630
 */
export function ogSvg({ title, subtitle = '', facts = [], kicker = '' }) {
  const titleLines = wrap(title, title.length > 28 ? 18 : 16, 3);
  const size = titleLines.length > 2 ? 58 : 68;
  const subLines = wrap(subtitle, 38, 2);
  let y = 150;
  const t = titleLines.map((l, i) => `<text x="72" y="${y + i * (size * 1.12)}" font-family="Dela Gothic One" font-size="${size}" fill="${C.ink}">${esc(l)}</text>`).join('');
  y += titleLines.length * size * 1.12 + 18;
  const s = subLines.map((l, i) => `<text x="72" y="${y + i * 40}" font-family="Geologica" font-size="30" fill="${C.ink2}">${esc(l)}</text>`).join('');
  y += subLines.length * 40 + 30;
  const f = facts.slice(0, 2).map((l, i) => `<text x="72" y="${y + i * 42}" font-family="Geologica" font-weight="700" font-size="30" fill="${C.lamp}">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.paper}"/>
  <rect x="0" y="0" width="1200" height="8" fill="${C.brass}"/>
  ${tableArt(735, 175, 420)}
  ${kicker ? `<text x="72" y="92" font-family="Geologica" font-weight="700" font-size="26" fill="${C.brass}">${esc(kicker)}</text>` : ''}
  ${t}${s}${f}
  <circle cx="90" cy="566" r="16" fill="${C.lamp}"/><circle cx="90" cy="566" r="9" fill="#F0E6D6"/>
  <text x="120" y="577" font-family="Dela Gothic One" font-size="30" fill="${C.ink}">Бильярдум</text>
</svg>`;
}

// ---------- WOFF → TTF для resvg (resvg читает только TrueType/OpenType) ----------

/** Распаковка WOFF 1.0: таблицы сжаты zlib по отдельности. */
export function woffToSfnt(buf) {
  if (buf.toString('ascii', 0, 4) !== 'wOFF') throw new Error('not a WOFF file');
  const flavor = buf.readUInt32BE(4);
  const numTables = buf.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const o = 44 + i * 20;
    const tag = buf.readUInt32BE(o);
    const offset = buf.readUInt32BE(o + 4);
    const compLength = buf.readUInt32BE(o + 8);
    const origLength = buf.readUInt32BE(o + 12);
    const checksum = buf.readUInt32BE(o + 16);
    const raw = buf.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : raw;
    tables.push({ tag, checksum, data });
  }
  let pow = 1;
  let log = 0;
  while (pow * 2 <= numTables) {
    pow *= 2;
    log += 1;
  }
  const headerLen = 12 + numTables * 16;
  let size = headerLen;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = Buffer.alloc(size);
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(numTables * 16 - pow * 16, 10);
  let offset = headerLen;
  tables.forEach((t, i) => {
    const o = 12 + i * 16;
    out.writeUInt32BE(t.tag, o);
    out.writeUInt32BE(t.checksum, o + 4);
    out.writeUInt32BE(offset, o + 8);
    out.writeUInt32BE(t.data.length, o + 12);
    t.data.copy(out, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

let fontFiles = null;
function ensureFonts() {
  if (fontFiles) return fontFiles;
  const dir = join(tmpdir(), 'billiardum-site-og-fonts');
  mkdirSync(dir, { recursive: true });
  // Порядок важен: шрифты — подмножества, и resvg берёт недостающий знак из первого подходящего файла.
  // Geologica: сначала латиница (цифры, знаки), потом кириллица; Dela Gothic One: сначала кириллица.
  const rank = (f) => ['geologica-latin-4', 'geologica-latin-7', 'geologica-cyrillic', 'geologica-latin-ext', 'dela-gothic-one-cyrillic', 'dela-gothic-one-latin']
    .findIndex((p) => f.startsWith(p));
  fontFiles = readdirSync(FONT_SRC)
    .filter((f) => f.endsWith('.woff'))
    .sort((a, b) => rank(a) - rank(b))
    .map((f) => {
      const target = join(dir, f.replace(/\.woff$/, '.ttf'));
      if (!existsSync(target)) writeFileSync(target, woffToSfnt(readFileSync(FONT_SRC + f)));
      return target;
    });
  return fontFiles;
}

let resvg;
async function loadResvg() {
  if (resvg !== undefined) return resvg;
  try {
    resvg = (await import('@resvg/resvg-js')).Resvg;
  } catch {
    resvg = null;
  }
  return resvg;
}

const memory = new Map();
const MAX = 300;

/**
 * Картинка по описанию карточки: { type: 'image/png' | 'image/svg+xml', body: Buffer }.
 * Ключ кэша — хеш содержимого карточки: поменялись данные клуба — новая картинка.
 */
export async function ogImage(card, { cacheDir = process.env.OG_CACHE_DIR } = {}) {
  const svg = ogSvg(card);
  const key = createHash('sha256').update(svg).digest('hex').slice(0, 32);
  const hit = memory.get(key);
  if (hit) return hit;
  const Resvg = await loadResvg();
  let result;
  if (!Resvg) {
    result = { type: 'image/svg+xml', body: Buffer.from(svg) };
  } else {
    const file = cacheDir ? join(cacheDir, `${key}.png`) : null;
    if (file && existsSync(file)) {
      result = { type: 'image/png', body: readFileSync(file) };
    } else {
      const png = new Resvg(svg, {
        fitTo: { mode: 'width', value: 1200 },
        font: { fontFiles: ensureFonts(), loadSystemFonts: false, defaultFontFamily: 'Geologica' },
      }).render().asPng();
      result = { type: 'image/png', body: Buffer.from(png) };
      if (file) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(file, result.body);
        } catch {
          // диск кэша недоступен — хватит памяти
        }
      }
    }
  }
  memory.set(key, result);
  if (memory.size > MAX) memory.delete(memory.keys().next().value);
  return result;
}

export async function ogAvailable() {
  return Boolean(await loadResvg());
}
