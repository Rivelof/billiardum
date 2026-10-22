// Бюджет приложения гостя: меньше 200 КБ JS (gzip) на первую загрузку (контракт M1 §10).
// Считает скрипты, которые браузер грузит при открытии: <script type="module"> и <link rel="modulepreload">
// из dist/index.html, плюс их статические импорты. Ленивые чанки (import()) не входят.
// Заодно проверяет, что в обычной сборке нет заглушки API (метка BL_MOCK_MARKER) и внешних адресов.
//
//   npm run size -w web/guest

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET = 200 * 1024;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const base = '/app/';

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const refs = [
  ...[...html.matchAll(/<script[^>]+type="module"[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]),
];
const classic = [...html.matchAll(/<script(?![^>]*type="module")[^>]+src="([^"]+)"/g)].map((m) => m[1]);

const toFile = (url) => join(dist, url.startsWith(base) ? url.slice(base.length) : url.replace(/^\//, ''));
const seen = new Set();
const queue = [...refs, ...classic].map(toFile);
while (queue.length) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, 'utf8');
  // статические импорты между чанками: import … from "./x.js" и import "./x.js"
  for (const m of code.matchAll(/(?:^|[;\n}])\s*import\s*(?:[^'"()]*?from\s*)?["']([^"']+\.js)["']/g)) {
    queue.push(join(dirname(file), m[1]));
  }
}

let total = 0;
const rows = [];
for (const file of seen) {
  const raw = readFileSync(file);
  const gz = gzipSync(raw, { level: 9 }).length;
  total += gz;
  rows.push([file.slice(dist.length + 1), raw.length, gz]);
}
const kb = (n) => `${(n / 1024).toFixed(1)} КБ`;
for (const [name, raw, gz] of rows) console.log(`${name.padEnd(44)} ${kb(raw).padStart(10)} → ${kb(gz).padStart(9)} gzip`);
console.log(`Итого JS на первую загрузку: ${kb(total)} gzip из ${kb(BUDGET)}`);

let failed = false;
if (total > BUDGET) {
  console.error(`Бюджет превышен на ${kb(total - BUDGET)}.`);
  failed = true;
}

// Заглушка API и внешние адреса в сборке — ошибка
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
for (const file of walk(dist).filter((f) => /\.(js|css|html|webmanifest)$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  if (text.includes('BL_MOCK_MARKER')) {
    console.error(`В сборке заглушка API: ${file}. Соберите без --mode mock и VITE_MOCK.`);
    failed = true;
  }
  if (/(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|fonts\.googleapis|fonts\.gstatic/i.test(text)) {
    console.error(`Внешний ресурс в ${file} (decisions №22).`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
