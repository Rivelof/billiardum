import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseCiArgs, PIO_VERSION } from './ci.mjs';
import { ROOT } from './dev-lib.mjs';

test('этапы npm run ci: по умолчанию всё, кроме pio', () => {
  assert.deepEqual(parseCiArgs([]), ['base', 'config', 'web', 'fw', 'db']);
  assert.deepEqual(parseCiArgs(['--db']), ['db']);
  assert.deepEqual(parseCiArgs(['--fw', '--web', '--web']), ['web', 'fw']);
  assert.deepEqual(parseCiArgs(['--pio']), ['pio']);
  assert.throws(() => parseCiArgs(['--all']), /--base/);
  assert.throws(() => parseCiArgs(['db']), /неизвестный параметр/);
});

test('версия PlatformIO в CI и в scripts/ci.mjs одна', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, new RegExp(`PIO_VERSION: ${PIO_VERSION.replaceAll('.', '\\.')}\\n`));
});

test('действия GitHub закреплены по коммиту', () => {
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length > 0);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});
