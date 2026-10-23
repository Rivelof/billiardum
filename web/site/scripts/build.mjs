/**
 * Сборка островов сайта (esbuild): src/islands/*.js → dist/assets/[имя]-[хеш].js, общий код — отдельными
 * чанками, рядом .br и .gz. dist/manifest.json — имя острова → адрес. Бюджет: ≤ 50 КБ gzip JS на страницу
 * (контракт M4 §1 п.1) — проверяется здесь (--size печатает таблицу) и в тестах.
 *
 *   node scripts/build.mjs           сборка
 *   node scripts/build.mjs --watch   пересборка при изменениях (npm run dev)
 *   node scripts/build.mjs --size    сборка и вес каждой страницы
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'dist');
export const ISLANDS = ['site', 'forms', 'hall', 'break', 'owners'];
/** Острова каждой страницы — как в src/pages (site — всегда). */
export const PAGES = {
  'главная': ['site', 'break', 'hall'],
  'город': ['site'],
  'клуб на программе': ['site', 'hall'],
  'клуб без программы': ['site'],
  'для клубов': ['site', 'owners', 'forms'],
};
export const BUDGET_GZIP = 50 * 1024;

function options(outdir) {
  return {
    entryPoints: Object.fromEntries(ISLANDS.map((n) => [n, join(ROOT, 'src/islands', `${n}.js`)])),
    bundle: true,
    splitting: true,
    format: 'esm',
    minify: true,
    target: ['es2022'],
    outdir,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunk-[hash]',
    metafile: true,
    legalComments: 'none',
    logLevel: 'warning',
  };
}

/** Собирает острова в outDir; возвращает { manifest, sizes: { остров: gzip байт с чанками } }. */
export async function build({ outDir = OUT } = {}) {
  const assets = join(outDir, 'assets');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(assets, { recursive: true });
  const result = await esbuild.build(options(assets));
  return finish(result, outDir);
}

function finish(result, outDir) {
  const assets = join(outDir, 'assets');
  const manifest = {};
  const gz = {};
  const deps = {};
  for (const [file, info] of Object.entries(result.metafile.outputs)) {
    if (!file.endsWith('.js')) continue;
    const abs = join(ROOT, file).startsWith(assets) ? join(ROOT, file) : file;
    const name = basename(file);
    const buf = readFileSync(abs);
    const g = gzipSync(buf, { level: 9 });
    writeFileSync(`${abs}.gz`, g);
    writeFileSync(`${abs}.br`, brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    gz[name] = g.length;
    deps[name] = info.imports.filter((i) => i.kind === 'import-statement').map((i) => basename(i.path));
    if (info.entryPoint) manifest[basename(info.entryPoint, '.js')] = `/assets/${name}`;
  }
  const closure = (name, seen = new Set()) => {
    if (seen.has(name)) return seen;
    seen.add(name);
    for (const d of deps[name] ?? []) closure(d, seen);
    return seen;
  };
  const pageSize = (islands) => {
    const files = new Set();
    for (const i of islands) if (manifest[i]) for (const f of closure(basename(manifest[i]))) files.add(f);
    return [...files].reduce((s, f) => s + gz[f], 0);
  };
  const sizes = Object.fromEntries(Object.entries(PAGES).map(([p, islands]) => [p, pageSize(islands)]));
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, sizes, files: gz };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--watch')) {
    const assets = join(OUT, 'assets');
    mkdirSync(assets, { recursive: true });
    const ctx = await esbuild.context({
      ...options(assets),
      plugins: [{
        name: 'manifest',
        setup(b) {
          b.onEnd((r) => {
            if (r.metafile) {
              finish(r, OUT);
              console.log('[site] острова пересобраны');
            }
          });
        },
      }],
    });
    await ctx.watch();
  } else {
    const { sizes, files } = await build();
    const kb = (n) => `${(n / 1024).toFixed(1)} КБ`;
    if (process.argv.includes('--size')) {
      for (const [f, n] of Object.entries(files)) console.log(`  ${f.padEnd(28)} ${kb(n)} gzip`);
    }
    let over = false;
    for (const [p, n] of Object.entries(sizes)) {
      console.log(`[site] ${p}: ${kb(n)} JS gzip`);
      if (n > BUDGET_GZIP) over = true;
    }
    console.log(`[site] сборка: ${relative(process.cwd(), OUT) || OUT}`);
    if (over) {
      console.error(`[site] бюджет ${kb(BUDGET_GZIP)} на страницу превышен`);
      process.exit(1);
    }
  }
}
