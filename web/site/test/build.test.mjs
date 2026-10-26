import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { BUDGET_GZIP, ISLANDS, build } from '../scripts/build.mjs';

test('острова собираются, каждая страница ≤ 50 КБ JS gzip (контракт M4 §1 п.1)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'bl-site-build-'));
  const { manifest, sizes, staticSizes, files } = await build({ outDir: out });
  for (const name of ISLANDS) assert.match(manifest[name], new RegExp(`^/assets/${name}-[A-Z0-9]+\\.js$`));
  for (const [page, size] of Object.entries(sizes)) assert.ok(size <= BUDGET_GZIP, `${page}: ${size} байт`);
  assert.ok(staticSizes['главная'] < 15 * 1024, 'разбой — не больше 15 КБ (DESIGN §6)');
  // Lenis (решение №228) — только отложенным чанком: к первой отрисовке не добавляет ни байта
  for (const [page, size] of Object.entries(sizes)) {
    const lazy = size - staticSizes[page];
    assert.ok(lazy > 3 * 1024 && lazy < 9 * 1024, `${page}: отложенный чанк плавной прокрутки ${lazy} байт`);
  }
  assert.ok(staticSizes['город'] < 2 * 1024, `город: ${staticSizes['город']} байт до загрузки Lenis`);
  const loader = readFileSync(join(out, 'assets', basename(manifest.site)), 'utf8');
  assert.match(loader, /import\(/, 'остров site подгружает плавную прокрутку по import()');
  for (const f of Object.keys(files)) {
    const js = readFileSync(join(out, 'assets', f), 'utf8');
    assert.doesNotMatch(js, /https?:\/\/(?!www\.w3\.org)/, `${f}: без внешних адресов`);
  }
});
