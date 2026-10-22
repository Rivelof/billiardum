// `npm run test:db`: все тесты на настоящем Postgres (контракт M1 §11).
//
//   1. npm run test:db -w @billiardum/db       — миграции (все, и 0400–0599 M2), RLS, журнал
//                                               (supabase/tests)
//   2. npm run test:db -w @billiardum/server   — вход, outbox, маршруты core (server/test/db)
//   3. npm run test:db остальных пакетов, где этот скрипт есть (например @billiardum/kkt-bridge)
//   4. LIGHT_IT=1 node --test --test-concurrency=1 --test-timeout=600000 "server/test/light/*.test.mjs"
//      — сессии и контроллер (backend-light) на том же DATABASE_ADMIN_URL, 10 минут на тест,
//      сторож всего прогона — 20 минут (зависший it-sim не держит CI бесконечно); интеграция
//      light + брокер + симулятор (it-sim) сама поднимает и удаляет свой брокер
//      bl-light-it-* (TLS, Dynamic Security; нужны docker и openssl).
//   5. Тесты модулей на базе (M2: касса backend-pos, ККТ и смены backend-kkt) — каждый каталог
//      server/test/<модуль>/ (кроме db и light) и server/<модуль>/test/db/ с *.test.mjs,
//      по одному файлу, тот же предел и сторож, что у light.
//
// Каждый тест создаёт свою временную базу и удаляет её; рабочую базу и брокер
// `npm run dev` не трогает. DATABASE_ADMIN_URL — из окружения, иначе из .env
// (как у supabase/lib/db.mjs).

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { capture, ENV_FILE, fail, isMain, makeLogger, readEnvFile, ROOT, runMain, runNpm, UserError } from './dev-lib.mjs';

const log = makeLogger('test:db');

export const LIGHT_TESTS = 'server/test/light/*.test.mjs';
/** Предел на один тест light (--test-timeout) и сторож всего прогона light. */
export const LIGHT_TEST_TIMEOUT_MS = 10 * 60_000;
export const LIGHT_WATCHDOG_MS = 20 * 60_000;

/** Аргументы node для тестов light (или другого каталога тестов на базе). */
export function lightTestArgs(pattern = LIGHT_TESTS) {
  return ['--test', '--test-concurrency=1', `--test-timeout=${LIGHT_TEST_TIMEOUT_MS}`, pattern];
}

/** Тесты модулей M2 на базе, которых ждём (для подсказки в логе, пока каталога нет). */
export const EXPECTED_MODULE_TESTS = [
  { dir: 'server/test/pos', owner: 'backend-pos' },
  { dir: 'server/test/kkt', owner: 'backend-kkt' },
];

const hasTests = (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.test.mjs'));
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

/**
 * Каталоги тестов модулей на базе: server/test/<модуль>/ (кроме db — это test:db сервера —
 * и light — свой запуск) и server/<модуль>/test/db/, где есть *.test.mjs. Пути от корня, по порядку.
 */
export function moduleDbTestDirs(root = ROOT) {
  const dirs = [
    ...subdirs(join(root, 'server', 'test')).filter((d) => !['db', 'light'].includes(d)).map((d) => `server/test/${d}`),
    ...subdirs(join(root, 'server')).filter((d) => d !== 'test').map((d) => `server/${d}/test/db`),
  ];
  return dirs.filter((d) => hasTests(join(root, d))).sort();
}

/** Пакеты (кроме db и server), у которых есть скрипт test:db. */
export function extraDbTestPackages(root = ROOT) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  return workspaces.filter((dir) => {
    if (['supabase', 'server'].includes(dir)) return false;
    const file = join(root, dir, 'package.json');
    return existsSync(file) && Boolean(JSON.parse(readFileSync(file, 'utf8')).scripts?.['test:db']);
  });
}

/**
 * Запуск со сторожем: процесс не уложился в limitMs — SIGTERM, через 10 с SIGKILL и ошибка.
 * Возвращает код выхода.
 */
export function runWithWatchdog(cmd, args, { env, cwd = ROOT, limitMs, what }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: 'inherit' });
    let expired = false;
    let killer = null;
    const timer = setTimeout(() => {
      expired = true;
      log(`${what}: не уложились в ${Math.round(limitMs / 60_000)} мин — останавливаю`);
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    }, limitMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      if (expired) {
        reject(
          new UserError(
            `${what} зависли: прогон дольше ${Math.round(limitMs / 60_000)} мин остановлен сторожем. ` +
              'Обычно виснет интеграция it-sim (брокер не отвечает); смотрите последний Subtest в выводе выше.',
          ),
        );
        return;
      }
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

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
  for (const dir of extraDbTestPackages()) {
    log(`npm run test:db -w ${dir}`);
    await runNpm(['run', 'test:db', '-w', dir], { env });
  }

  if (!existsSync(join(ROOT, 'server', 'test', 'light'))) {
    log('пропуск: нет server/test/light (зона backend-light)');
  } else {
    if (env.LIGHT_IT === '1') {
      const problem = lightItProblem();
      if (problem && strict) fail(`интеграция light (it-sim) не запустится: ${problem}`);
      if (problem) log(`внимание: ${problem} — it-sim будет пропущен`);
    }
    log(`LIGHT_IT=${env.LIGHT_IT} node ${lightTestArgs().join(' ')} (сторож ${LIGHT_WATCHDOG_MS / 60_000} мин)`);
    // По одному файлу: интеграция меряет p95 в реальном времени, соседи не должны её грузить.
    const code = await runWithWatchdog(process.execPath, lightTestArgs(), { env, limitMs: LIGHT_WATCHDOG_MS, what: 'тесты light' });
    if (code !== 0) fail(`тесты light: код выхода ${code}`);
  }

  const dirs = moduleDbTestDirs();
  if (dirs.length === 0) {
    const expected = EXPECTED_MODULE_TESTS.map((m) => `${m.dir} — ${m.owner}`).join(', ');
    log(`пропуск: тестов модулей на базе ещё нет (${expected} или server/<модуль>/test/db)`);
  }
  for (const dir of dirs) {
    const args = lightTestArgs(`${dir}/*.test.mjs`);
    log(`node ${args.join(' ')} (сторож ${LIGHT_WATCHDOG_MS / 60_000} мин)`);
    const code = await runWithWatchdog(process.execPath, args, { env, limitMs: LIGHT_WATCHDOG_MS, what: `тесты ${dir}` });
    if (code !== 0) fail(`тесты ${dir}: код выхода ${code}`);
  }
}

async function main() {
  if (process.argv.length > 2) fail(`параметров нет, получено: ${process.argv.slice(2).join(' ')}`);
  await runDbTests(dbTestEnv());
  log('всё зелёное');
  return 0;
}

if (isMain(import.meta.url)) runMain('test:db', main);
