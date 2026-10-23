import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BUDGET_GZIP, ISLANDS, build } from '../scripts/build.mjs';

test('острова собираются, каждая страница ≤ 50 КБ JS gzip (контракт M4 §1 п.1)', async () => {
  const out = mkdtempSync(join(tmpdir(), 'bl-site-build-'));
  const { manifest, sizes, files } = await build({ outDir: out });
  for (const name of ISLANDS) assert.match(manifest[name], new RegExp(`^/assets/${name}-[A-Z0-9]+\\.js$`));
  for (const [page, size] of Object.entries(sizes)) assert.ok(size <= BUDGET_GZIP, `${page}: ${size} байт`);
  assert.ok(sizes['главная'] < 15 * 1024, 'разбой — не больше 15 КБ (DESIGN §6)');
  for (const f of Object.keys(files)) {
    const js = readFileSync(join(out, 'assets', f), 'utf8');
    assert.doesNotMatch(js, /https?:\/\/(?!www\.w3\.org)/, `${f}: без внешних адресов`);
  }
});
