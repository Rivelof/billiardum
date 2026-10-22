// `npm run test:db`: все тесты на настоящем Postgres (контракт M1 §11).
//
//   1. npm run test:db -w @billiardum/db       — миграции, RLS, журнал (supabase/tests)
//   2. npm run test:db -w @billiardum/server   — вход, outbox, маршруты core (server/test/db)
//   3. LIGHT_IT=1 node --test --test-concurrency=1 "server/test/light/*.test.mjs"
//      — сессии и контроллер (backend-light) на том же DATABASE_ADMIN_URL; интеграция
//      light + брокер + симулятор (it-sim) сама поднимает и удаляет свой брокер
//      bl-light-it-* (TLS, Dynamic Security; нужны docker и openssl).
//
// Каждый тест создаёт свою временную базу и удаляет её; рабочую базу и брокер
// `npm run dev` не трогает. DATABASE_ADMIN_URL — из окружения, иначе из .env
// (как у supabase/lib/db.mjs).

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { capture, ENV_FILE, fail, isMain, makeLogger, readEnvFile, ROOT, runChecked, runMain, runNpm } from './dev-lib.mjs';

const log = makeLogger('test:db');

export const LIGHT_TESTS = 'server/test/light/*.test.mjs';

/** Окружение тестов: DATABASE_ADMIN_URL (и DATABASE_URL, если есть); окружение главнее .env. */
export function dbTestEnv(base = process.env, file = existsSync(ENV_FILE) ? readEnvFile(ENV_FILE) : {}) {
  const env = { ...base };
  for (const key of ['DATABASE_ADMIN_URL', 'DATABASE_URL']) {
    if (!env[key] && file[key]) env[key] = file[key];
  }
  if (!env.DATABASE_ADMIN_URL) fail('нет DATABASE_ADMIN_URL ни в окружении, ни в .env. Поднимите окружение: npm run dev (или npm run ci -- --db).');
  // Интеграция light со своим брокером; LIGHT_IT=0 — без неё.
  env.LIGHT_IT ??= '1';
  return env;
}

/** Нужное для it-sim со своим брокером; возвращает текст проблемы или null. */
export function lightItProblem() {
  if (capture('docker', ['version', '--format', '{{.Server.Version}}']).code !== 0) return 'нет Docker';
  if (capture('openssl', ['version']).code !== 0) return 'нет openssl (одноразовый CA брокера)';
  return null;
}

/** Все тесты на базе по порядку. strict — нехватка docker/openssl для it-sim — ошибка, а не пропуск. */
export async function runDbTests(env, { strict = false } = {}) {
  log('npm run test:db -w @billiardum/db');
  await runNpm(['run', 'test:db', '-w', '@billiardum/db'], { env });
  log('npm run test:db -w @billiardum/server');
  await runNpm(['run', 'test:db', '-w', '@billiardum/server'], { env });

  if (!existsSync(join(ROOT, 'server', 'test', 'light'))) {
    log('пропуск: нет server/test/light (зона backend-light)');
    return;
  }
  if (env.LIGHT_IT === '1') {
    const problem = lightItProblem();
    if (problem && strict) fail(`интеграция light (it-sim) не запустится: ${problem}`);
    if (problem) log(`внимание: ${problem} — it-sim будет пропущен`);
  }
  log(`LIGHT_IT=${env.LIGHT_IT} node --test --test-concurrency=1 "${LIGHT_TESTS}"`);
  // По одному файлу: интеграция меряет p95 в реальном времени, соседи не должны её грузить.
  await runChecked(process.execPath, ['--test', '--test-concurrency=1', LIGHT_TESTS], { env }, 'тесты light');
}

async function main() {
  if (process.argv.length > 2) fail(`параметров нет, получено: ${process.argv.slice(2).join(' ')}`);
  await runDbTests(dbTestEnv());
  log('всё зелёное');
  return 0;
}

if (isMain(import.meta.url)) runMain('test:db', main);
