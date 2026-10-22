import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const css = readFileSync(here('../tokens.css'), 'utf8');
const designPath = here('../../docs/DESIGN.md');

// ---------- разбор tokens.css ----------

/** Блоки CSS с цепочкой обёрток: [{ chain: ['@media (...)', ':root'], decls: { '--paper': '#F3F5F8' } }] */
function parseBlocks(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = [];
  const stack = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      stack.push({ prelude: buf.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ','), body: '' });
      buf = '';
    } else if (ch === '}') {
      const top = stack.pop();
      top.body += buf;
      buf = '';
      const decls = {};
      for (const part of top.body.split(';')) {
        const i = part.indexOf(':');
        if (i === -1) continue;
        const name = part.slice(0, i).trim();
        if (name) decls[name] = part.slice(i + 1).trim();
      }
      if (Object.keys(decls).length) blocks.push({ chain: [...stack.map((s) => s.prelude), top.prelude], decls });
    } else {
      buf += ch;
    }
  }
  return blocks;
}

const blocks = parseBlocks(css);
const find = (...chain) => {
  const b = blocks.find((x) => x.chain.join(' | ') === chain.join(' | '));
  assert.ok(b, `в tokens.css нет блока ${chain.join(' → ')}`);
  return b.decls;
};

const base = find(':root');
// Редакция №127: тёмная тема по умолчанию (:root), светлая — только по выбору
const darkAttr = find(':root,[data-theme="dark"]');
const light = find('[data-theme="light"]');
const reduced = find('@media (prefers-reduced-motion: reduce)', ':root');

const themes = {
  light: { ...base, ...darkAttr, ...light },
  dark: { ...base, ...darkAttr },
};

function resolve(theme, value, depth = 0) {
  assert.ok(depth < 10, `цикл в var(): ${value}`);
  const m = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim());
  if (!m) return value.trim();
  assert.ok(m[1] in theme, `не определён ${m[1]}`);
  return resolve(theme, theme[m[1]], depth + 1);
}
const color = (theme, token) => (token.startsWith('#') ? token : resolve(themes[theme], themes[theme][token] ?? assert.fail(`нет токена ${token}`)));

// ---------- WCAG 2.1 ----------

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  assert.match(full, /^[0-9a-f]{6}$/i, `не hex-цвет: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const ratio = (n) => `${n.toFixed(2)}:1`;

// ---------- токены совпадают с DESIGN.md ----------

const ADDED_BY_FRONTEND = []; // цвета тем вне DESIGN.md; сейчас таких нет
/** Подогнанные под AA значения (DESIGN.md §2: «frontend подгоняет их под тест контраста AA»). */
const ADJUSTED = { 'light|--ball-red': '#B03524', 'light|--free': '#1A6E43' };

test('tokens.css совпадает с таблицами DESIGN.md §2', { skip: !existsSync(designPath) && 'нет docs/DESIGN.md' }, () => {
  const md = readFileSync(designPath, 'utf8');
  const section = md.slice(md.indexOf('## 2. Цвет'), md.indexOf('## 3.'));
  const at = (re) => section.search(re);
  const darkStart = at(/Тёмная тема \(по умолчанию\):/);
  const lightStart = at(/Светлая тема \(«слоновая кость»\):/);
  const hallStart = at(/Зал \(план зала/);
  assert.ok(darkStart >= 0 && lightStart > darkStart && hallStart > lightStart, 'в DESIGN.md §2 таблицы тёмной и светлой темы и описание зала');
  const darkPart = section.slice(darkStart, lightStart);
  const lightPart = section.slice(lightStart, hallStart);
  const hallPart = section.slice(hallStart);
  const rows = (s) => Object.fromEntries([...s.matchAll(/\|\s*`(--[a-z0-9-]+)`\s*\|\s*`(#[0-9a-f]{6})`/gi)].map((m) => [m[1], m[2]]));
  const designLight = rows(lightPart);
  const designDark = rows(darkPart);
  const designHall = Object.fromEntries([...hallPart.matchAll(/`(--hall-[a-z0-9-]+)\s+(#[0-9a-f]{6})`/gi)].map((m) => [m[1], m[2]]));

  assert.ok(Object.keys(designLight).length > 0, 'в DESIGN.md найдена таблица светлой темы');
  assert.deepEqual(Object.keys(designDark).sort(), Object.keys(designLight).sort(), 'одинаковый набор токенов в темах');
  // Каждый токен темы из tokens.css описан в DESIGN.md, и наоборот
  const cssThemeColors = Object.keys(light).filter((t) => t.startsWith('--')).sort();
  assert.deepEqual(cssThemeColors, Object.keys(designLight).sort(), 'набор токенов темы совпадает с DESIGN.md');
  // Зал в редакции №127 описан словами (орех, паркет, латунь, сукно); если в DESIGN.md есть значения — сверяем
  for (const [t, v] of Object.entries(designHall)) assert.equal(base[t]?.toUpperCase(), v.toUpperCase(), `зал ${t}`);

  const want = (theme, t, v) => (ADJUSTED[`${theme}|${t}`] ?? v).toUpperCase();
  for (const [t, v] of Object.entries(designLight)) assert.equal(light[t]?.toUpperCase(), want('light', t, v), `светлая ${t}`);
  for (const [t, v] of Object.entries(designDark)) assert.equal(darkAttr[t]?.toUpperCase(), want('dark', t, v), `тёмная ${t}`);

  // Лишних цветов, которых нет в DESIGN.md, кроме согласуемых вспомогательных и токенов зала
  const hallTokens = Object.keys(base).filter((k) => k.startsWith('--hall-'));
  const known = new Set([...Object.keys(designLight), ...hallTokens, ...ADDED_BY_FRONTEND]);
  for (const theme of ['light', 'dark']) {
    for (const [t, v] of Object.entries(themes[theme])) {
      const isColor = t.startsWith('--') && /^#[0-9a-f]{3,8}$/i.test(resolve(themes[theme], v));
      if (isColor) assert.ok(known.has(t), `цвет ${t} не описан в DESIGN.md`);
    }
  }

  // Шкала шрифтов §3
  const scale = /Шкала:\s*([\d\s/]+)px/.exec(md)[1].split('/').map((s) => Number(s.trim()));
  assert.deepEqual(scale, [13, 15, 17, 20, 24, 32, 44, 64]);
  for (const n of scale) assert.equal(base[`--fs-${n}`], `${n}px`, `--fs-${n}`);
});

test('тёмная тема по умолчанию, светлая только по выбору, зал одинаков в обеих темах', () => {
  for (const t of Object.keys(base).filter((k) => k.startsWith('--hall-'))) {
    assert.ok(!(t in light) && !(t in darkAttr), `${t} не должен меняться с темой`);
  }
  assert.ok(Object.keys(base).filter((k) => k.startsWith('--hall-')).length >= 7, 'токены зала');
  assert.equal(light['color-scheme'], 'light');
  assert.equal(darkAttr['color-scheme'], 'dark');
  // Системная светлая тема не включает светлую сама: только data-theme="light" (№127)
  assert.ok(!blocks.some((b) => b.chain.some((c) => /prefers-color-scheme/.test(c))), 'нет переключения по prefers-color-scheme');
  // Все токены тёмной темы переопределены в светлой
  assert.deepEqual(Object.keys(light).sort(), Object.keys(darkAttr).sort());
});

test('скругления, шрифты, движение и prefers-reduced-motion', () => {
  assert.equal(base['--radius-sm'], '6px');
  assert.equal(base['--radius-md'], '12px');
  assert.equal(base['--radius-pill'], '999px');
  assert.equal(base['--lh-body'], '1.55');
  assert.equal(base['--lamp-duration'], '0.6s');
  assert.equal(reduced['--lamp-duration'], '0s');
  assert.equal(reduced['--motion-fast'], '0s');
  assert.match(base['--font-display'], /^'Dela Gothic One'/);
  assert.match(base['--font-text'], /^'Geologica'/);
  assert.match(base['--font-mono'], /^'JetBrains Mono'/);
  for (const f of [base['--font-display'], base['--font-text'], base['--font-mono']]) {
    assert.doesNotMatch(f, /Inter|Roboto|Space Grotesk/, 'запрещённые шрифты (DESIGN §8)');
  }
});

// ---------- контраст WCAG 2.1 AA ----------

const AA = 4.5;       // текст (1.4.3)
const NON_TEXT = 3;   // границы элементов управления (1.4.11)
const SURFACES = ['--paper', '--card', '--card-2'];

// Пары, которые требует контракт (задача 6). Кнопка — текст --on-cloth (DESIGN §2, decisions №36)
const REQUIRED = [
  ...['--ink', '--ink-2', '--ink-3'].flatMap((fg) => SURFACES.map((bg) => [fg, bg, 'текст и подписи', AA])),
  ['--cloth', '--card', 'ссылка', AA],
  ['--on-cloth', '--cloth', 'текст кнопки', AA],
  ['--hall-text', '--hall-bg', 'текст в зале', AA],
];

// Пары, на которых держатся компоненты styleguide.html
const COMPONENTS = [
  ['--cloth', '--paper', 'ссылка на фоне страницы', AA],
  ['--cloth', '--card-2', 'ссылка на вторичной поверхности', AA],
  ['--on-cloth', '--cloth-deep', 'текст кнопки при наведении', AA],
  ['--on-lamp', '--lamp', 'текст на янтаре', AA],
  ['--ink', '--lamp-tint', 'фон подсветки', AA],
  ['--ink', '--cloth-tint', 'фон выбранного', AA],
  ['--hall-text-2', '--hall-bg', 'подписи в зале', AA],
  ['--lamp', '--hall-bg', '«Идёт игра» в зале', AA],
  ...SURFACES.map((bg) => ['--free', bg, '«свободно» текстом', AA]),
  ...SURFACES.map((bg) => ['--ball-red', bg, 'тревога, ошибка, льгота', AA]),
  ...SURFACES.map((bg) => ['--line-strong', bg, 'граница поля ввода', NON_TEXT]),
  ...SURFACES.map((bg) => ['--brass', bg, 'латунь: рамки и значки', NON_TEXT]),
  ['--hall-brass', '--hall-bg', 'латунные уголки в зале', NON_TEXT],
];

/**
 * Известные провалы AA в значениях DESIGN.md. Тест не падает (todo), но печатает фактические числа.
 * DESIGN.md меняет только Андрей; предложения — в отчёте оркестратору.
 * После правок decisions №36 список пуст. Если значение исправят, тест «список провалов актуален» потребует убрать строку.
 */
const KNOWN_GAPS = {};

const ALL = [...REQUIRED, ...COMPONENTS];
const themeName = (theme) => (theme === 'light' ? 'светлая' : 'тёмная');

for (const theme of ['light', 'dark']) {
  for (const [fg, bg, why, min] of ALL) {
    const key = `${theme}|${fg}|${bg}`;
    const value = contrast(color(theme, fg), color(theme, bg));
    const gap = KNOWN_GAPS[key];
    const name = `контраст ${themeName(theme)}: ${fg} на ${bg} (${why}) = ${ratio(value)}, нужно ${min}:1`;
    const options = gap ? { todo: `ниже ${min}:1, фактически ${ratio(value)}; ${gap}` } : {};
    test(name, options, () => {
      assert.ok(value >= min, `${ratio(value)} < ${min}:1`);
    });
  }
}

test('список известных провалов актуален', () => {
  for (const key of Object.keys(KNOWN_GAPS)) {
    const [theme, fg, bg] = key.split('|');
    const pair = ALL.find(([f, b]) => f === fg && b === bg);
    const value = contrast(color(theme, fg), color(theme, bg));
    assert.ok(value < pair[3], `${key} уже ${ratio(value)} — уберите из KNOWN_GAPS`);
  }
});

test('сводка контраста по темам', (t) => {
  for (const theme of ['light', 'dark']) {
    for (const [fg, bg, , min] of ALL) {
      const value = contrast(color(theme, fg), color(theme, bg));
      t.diagnostic(`${theme.padEnd(5)} ${fg.padEnd(13)} на ${bg.padEnd(13)} ${ratio(value).padStart(8)}  (нужно ${min}:1)`);
    }
  }
  // Почему в тёмной теме текст кнопки тёмный: белый на --cloth не набирает AA
  t.diagnostic(`dark  #FFFFFF       на --cloth       ${ratio(contrast('#FFFFFF', color('dark', '--cloth'))).padStart(8)}  (не используется, DESIGN §2)`);
});
