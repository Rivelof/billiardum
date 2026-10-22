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

test('test:db: база из окружения главнее .env, LIGHT_IT=1 по умолчанию, LIGHT_IT_* из .env не берутся', async () => {
  const { dbTestEnv } = await import('./ci-test-db.mjs');
  const file = { DATABASE_ADMIN_URL: 'postgres://file', DATABASE_URL: 'postgres://app', LIGHT_IT_MQTT_URL: 'mqtts://dev:8883' };
  const env = dbTestEnv({ DATABASE_ADMIN_URL: 'postgres://env' }, file);
  assert.equal(env.DATABASE_ADMIN_URL, 'postgres://env');
  assert.equal(env.DATABASE_URL, 'postgres://app');
  assert.equal(env.LIGHT_IT, '1');
  assert.equal(env.LIGHT_IT_MQTT_URL, undefined);
  assert.equal(dbTestEnv({ DATABASE_ADMIN_URL: 'x', LIGHT_IT: '0' }, {}).LIGHT_IT, '0');
  assert.throws(() => dbTestEnv({}, {}), /DATABASE_ADMIN_URL/);
});

test('сторож тестов light: зависший процесс останавливается с понятной ошибкой', async () => {
  const { lightTestArgs, runWithWatchdog } = await import('./ci-test-db.mjs');
  assert.ok(lightTestArgs().includes('--test-timeout=600000'));
  const orig = console.log;
  console.log = () => {};
  try {
    await assert.rejects(
      runWithWatchdog(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, limitMs: 200, what: 'тесты light' }),
      /зависли.*сторожем/,
    );
    assert.equal(await runWithWatchdog(process.execPath, ['-e', 'process.exit(3)'], { env: process.env, limitMs: 5000, what: 'x' }), 3);
  } finally {
    console.log = orig;
  }
});
