// Критерий 5: CI зелёный — lint, юнит-тесты и тесты базы на поднятом Postgres.
// Полный `npm run ci` не запускается: он пересоздаёт контейнеры. Долго (минуты), поэтому
// только по E2E_CI=1. test:db создаёт и удаляет свои временные базы bl_test_*,
// рабочую базу не меняет (README supabase/).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { REPO_ROOT } from './helpers.mjs';

const skip = process.env.E2E_CI === '1' ? false : 'включается E2E_CI=1 (минуты)';

function npm(script, t) {
  // Переменные .env уже загружены helpers.mjs. NODE_TEST_CONTEXT от этого прогона убираем:
  // иначе вложенный node --test пишет не TAP, а служебный поток родителю.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync('npm', ['run', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  const summary = out
    .split('\n')
    .filter((l) => /^(# |ℹ )(tests|pass|fail|skipped|cancelled) \d+/.test(l) || /problems?/.test(l))
    .join('; ');
  t.diagnostic(`npm run ${script}: код ${res.status}; ${summary || 'без замечаний'}`);
  return { status: res.status, out };
}

test('npm run lint', { skip }, (t) => {
  assert.equal(npm('lint', t).status, 0);
});

test('npm test', { skip }, (t) => {
  const r = npm('test', t);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /^# fail [1-9]/m);
});

test('npm run test:db (DATABASE_ADMIN_URL и DATABASE_URL из .env)', { skip }, (t) => {
  const r = npm('test:db', t);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /^# fail [1-9]/m);
});
