import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(here(p), 'utf8');

const pkg = JSON.parse(read('../package.json'));
const fontsCss = read('../fonts.css');
const tokensCss = read('../tokens.css');
const styleguide = read('../styleguide.html');

test('package.json: без зависимостей, ESM, exports на существующие файлы', () => {
  assert.equal(pkg.name, '@billiardum/shared');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.ok(!pkg[field] || Object.keys(pkg[field]).length === 0, `${field} должен быть пуст`);
  }
  for (const key of ['./format', './tokens.css', './fonts.css']) {
    assert.ok(pkg.exports[key], `exports["${key}"]`);
    assert.ok(existsSync(here(`../${pkg.exports[key]}`)), `${pkg.exports[key]} существует`);
  }
  assert.match(pkg.scripts.test, /node --test/);
});

const faces = [...fontsCss.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => {
  const body = m[1];
  const get = (prop) => new RegExp(`${prop}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();
  return {
    family: get('font-family')?.replace(/['"]/g, ''),
    weight: get('font-weight'),
    display: get('font-display'),
    range: get('unicode-range'),
    url: /url\(['"]?([^'")]+)['"]?\)/.exec(body)?.[1],
  };
});

test('fonts.css: локальные WOFF2, font-display: swap, нужные начертания', (t) => {
  assert.ok(faces.length > 0);
  let total = 0;
  for (const f of faces) {
    assert.equal(f.display, 'swap', `${f.url}: font-display`);
    assert.match(f.url, /^\.\/fonts\/[a-z0-9-]+\.woff2$/, `${f.url}: только локальный woff2`);
    const file = here(`../${f.url}`);
    assert.ok(existsSync(file), `${f.url} существует`);
    const head = readFileSync(file).subarray(0, 4).toString('latin1');
    assert.equal(head, 'wOF2', `${f.url}: сигнатура WOFF2`);
    assert.ok(f.range, `${f.url}: unicode-range`);
    total += statSync(file).size;
  }
  const want = {
    'Dela Gothic One': ['400'],
    Geologica: ['300 700'],
    'JetBrains Mono': ['500', '700'],
  };
  assert.deepEqual([...new Set(faces.map((f) => f.family))].sort(), Object.keys(want).sort());
  for (const [family, weights] of Object.entries(want)) {
    for (const w of weights) {
      const set = faces.filter((f) => f.family === family && f.weight === w);
      assert.ok(set.some((f) => f.url.includes('-cyrillic-')), `${family} ${w}: кириллица`);
      assert.ok(set.some((f) => f.url.includes('-latin-') && !f.url.includes('latin-ext')), `${family} ${w}: латиница`);
    }
  }
  // latin-ext подключён только ради знака рубля
  for (const f of faces.filter((x) => x.url.includes('latin-ext'))) assert.equal(f.range, 'U+20BD', `${f.url}`);
  t.diagnostic(`шрифты всего: ${(total / 1024).toFixed(1)} КБ`);
});

test('лицензии OFL лежат рядом со шрифтами', () => {
  for (const name of ['OFL-DelaGothicOne.txt', 'OFL-Geologica.txt', 'OFL-JetBrainsMono.txt']) {
    const text = readFileSync(here(`../fonts/${name}`), 'utf8');
    assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1/, name);
  }
});

test('нет внешних ресурсов: ни Google Fonts, ни CDN (decisions №22)', () => {
  const external = /(?:src|href)\s*=\s*["'](?:https?:)?\/\/|url\(\s*["']?(?:https?:)?\/\/|@import/i;
  const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const [name, text] of [['fonts.css', fontsCss], ['tokens.css', tokensCss], ['styleguide.html', styleguide]]) {
    assert.doesNotMatch(code(text), external, name);
    assert.doesNotMatch(code(text), /fonts\.googleapis|fonts\.gstatic|\bcdn\.[a-z]|unpkg\.com|jsdelivr\.net/i, name);
  }
  const links = [...styleguide.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(links, ['./fonts.css', './tokens.css']);
  assert.doesNotMatch(styleguide, /<script[^>]+src=/, 'скрипты только встроенные');
});

test('styleguide.html: без эмодзи и запрещённых шрифтов (DESIGN §8)', () => {
  assert.doesNotMatch(styleguide, /\p{Extended_Pictographic}/u, 'эмодзи');
  assert.doesNotMatch(styleguide, /font-family:[^;]*(Inter|Roboto|Space Grotesk)/, 'запрещённый шрифт');
  assert.doesNotMatch(styleguide, /purple|violet|neon/i, 'фиолетовые градиенты и неон');
});

test('styleguide.html: план зала — 8 столов, кнопки с подписью для диктора', () => {
  const tables = [...styleguide.matchAll(/<button class="tbl"[^>]*>/g)].map((m) => m[0]);
  assert.equal(tables.length, 8);
  const types = tables.map((b) => /data-type="(\w+)"/.exec(b)[1]);
  assert.equal(types.filter((x) => x === 'pyramid').length, 5);
  assert.equal(types.filter((x) => x === 'pool').length, 3);
  for (const b of tables) {
    const n = /data-n="(\d)"/.exec(b)[1];
    assert.match(b, new RegExp(`aria-label="Стол ${n}, (идёт игра|свободен|бронь на \\d\\d:\\d\\d)"`));
  }
});
