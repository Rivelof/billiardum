// `npm run ci`: то же, что .github/workflows/ci.yml, локально (контракты M0 §9, M1 §11, M2 §2).
// Только синтетические данные сида (decisions №21). .env не читается.
//
// Этапы:
//   --base    все *.test.mjs кем-то запускаются (scripts/ci-test-files.mjs) → lint → test
//             (в том числе @billiardum/kkt-bridge) → test:it пакетов, где он есть (симулятор —
//             свой брокер в Docker)
//   --config  docker compose config (все профили), caddy validate, WebSocket моста ККТ через
//             Caddy (scripts/ci-caddy-ws.mjs), mosquitto --test-config — в контейнерах
//   --web     сборка web/guest и web/admin, бюджет JS гостя (npm run size -w web/guest)
//   --fw      нативные тесты прошивки: CMake + g++ (firmware/test/native), ctest
//   --db      чистый Postgres (supabase/postgres) в отдельном контейнере на свободном порту →
//             роли в supautils.reserved_roles → db:migrate → db:seed → тесты на базе
//             (scripts/ci-test-db.mjs: @billiardum/db (все миграции, и 0400–0599 M2),
//             @billiardum/server, test:db остальных пакетов, server/test/light с LIGHT_IT=1 —
//             интеграция light + свой брокер + симулятор, нужен openssl; тесты модулей M2 на
//             базе — server/test/<модуль>/ и server/<модуль>/test/db/)
//   --pio     pio run -e esp32dev и pio test -e native (нужен PlatformIO, см. PIO_VERSION);
//             в CI — отдельная задача, в «всё» не входит
//
//   npm run ci                  — base, config, web, fw, db
//   npm run ci -- --web --fw    — только эти этапы
//
// Пакеты, которых ещё нет (web/*, firmware/), пропускаются с сообщением; в GitHub — с
// пометкой ::notice в сводке. Пакет есть, а нужного скрипта или инструмента нет — ошибка.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { checkCaddyWebSocket, WS_PATH } from './ci-caddy-ws.mjs';
import { dbTestEnv, lightItProblem, runDbTests } from './ci-test-db.mjs';
import { uncoveredTests } from './ci-test-files.mjs';
import {
  ALL_PROFILE_ARGS,
  capture,
  checkDocker,
  composeArgs,
  ENV_EXAMPLE,
  fail,
  isMain,
  makeLogger,
  packageScript,
  POSTGRES_IMAGE,
  RESERVED_ROLES_SCRIPT,
  ROOT,
  run,
  runChecked,
  runMain,
  runNpm,
} from './dev-lib.mjs';

const log = makeLogger('ci');
const READY_TIMEOUT_MS = 180_000;

/** Версия PlatformIO для `--pio` и задачи CI firmware-pio (закреплена). */
export const PIO_VERSION = '6.1.19';
export const CADDY_IMAGE = 'caddy:2.11.7-alpine';
export const MOSQUITTO_IMAGE = 'eclipse-mosquitto:2.1.2-alpine';
/** Образ сервисов Node в deploy/dev/compose.yml (x-node-service). */
export const NODE_IMAGE = 'node:22.23.4-alpine';
const FW_NATIVE_DIR = join('firmware', 'test', 'native');

export const STAGES = ['base', 'config', 'web', 'fw', 'db', 'pio'];
const DEFAULT_STAGES = ['base', 'config', 'web', 'fw', 'db'];

const containers = new Set();
let interrupted = false;

/** Пропуск шага: в лог и, в GitHub Actions, в сводку задачи. */
function notice(message) {
  log(`пропуск: ${message}`);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=CI: шаг пропущен::${message}`);
}

export function parseCiArgs(args) {
  const picked = [];
  for (const a of args) {
    const stage = a.replace(/^--/, '');
    if (!a.startsWith('--') || !STAGES.includes(stage)) {
      fail(`неизвестный параметр ${a}. Этапы: ${STAGES.map((s) => `--${s}`).join(' ')}; без параметров — ${DEFAULT_STAGES.join(', ')}.`);
    }
    if (!picked.includes(stage)) picked.push(stage);
  }
  return picked.length > 0 ? STAGES.filter((s) => picked.includes(s)) : DEFAULT_STAGES;
}

function removeContainers() {
  for (const name of containers) {
    capture('docker', ['rm', '-f', '-v', name]);
    log(`контейнер ${name} удалён`);
  }
  containers.clear();
}

/** Ждёт healthy у контейнера с --health-cmd; при сбое печатает его лог. */
async function waitHealthy(name, what) {
  const started = Date.now();
  for (;;) {
    if (interrupted) fail('прервано');
    const s = capture('docker', ['inspect', '-f', '{{.State.Status}} {{.State.Health.Status}}', name]).stdout.trim();
    if (s === 'running healthy') break;
    if (!s.startsWith('running') || Date.now() - started > READY_TIMEOUT_MS) {
      await run('docker', ['logs', '--tail', '40', name]);
      fail(`${what} не поднялся (${s || 'нет контейнера'})`);
    }
    await sleep(1000);
  }
  return Math.round((Date.now() - started) / 1000);
}

function hostPort(name, port) {
  const p = capture('docker', ['port', name, `${port}/tcp`]).stdout.trim().split('\n')[0].split(':').at(-1);
  if (!/^\d+$/.test(p)) fail(`не удалось узнать порт ${port} контейнера ${name}`);
  return p;
}

async function startPostgres() {
  const name = `bl-ci-pg-${randomBytes(4).toString('hex')}`;
  const password = randomBytes(24).toString('hex');
  // Пароль уходит в docker через окружение, а не аргументом командной строки.
  const r = capture(
    'docker',
    [
      'run', '-d', '--name', name,
      '--label', 'com.billiardum.ci=1',
      '-e', 'POSTGRES_PASSWORD',
      '-p', '127.0.0.1::5432',
      '--health-cmd', 'pg_isready -U supabase_admin -d postgres -h 127.0.0.1',
      '--health-interval', '2s', '--health-timeout', '5s', '--health-retries', '90',
      POSTGRES_IMAGE,
    ],
    { env: { ...process.env, POSTGRES_PASSWORD: password } },
  );
  if (r.code !== 0) fail(`не удалось запустить Postgres: ${r.stderr.trim()}`);
  containers.add(name);
  log(`Postgres ${POSTGRES_IMAGE}: контейнер ${name}`);
  const secs = await waitHealthy(name, 'Postgres');
  const port = hostPort(name, 5432);
  log(`Postgres готов за ${secs} с, порт ${port}`);
  await runChecked('docker', ['exec', '-i', '-u', 'postgres', name, 'sh', '-s'], { stdinFile: RESERVED_ROLES_SCRIPT }, 'reserved-roles.sh');
  return { port, password };
}

/** Пакеты workspaces, у которых есть скрипт test:it (интеграция без базы, например симулятор). */
export function itPackages(root = ROOT) {
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  return workspaces.filter((dir) => packageScript(dir, 'test:it').ok);
}

async function stageBase() {
  log('все *.test.mjs запускает какой-то скрипт CI (scripts/ci-test-files.mjs)');
  const orphans = uncoveredTests();
  if (orphans.length > 0) {
    fail(
      `эти тесты не запускает ни один скрипт CI:\n  - ${orphans.join('\n  - ')}\n` +
        'Добавьте их шаблон в скрипт test (или test:db) пакета — зона владельца пакета — или перенесите файлы.',
    );
  }
  log('lint');
  await runNpm(['run', 'lint']);
  log('test');
  await runNpm(['test']);
  for (const dir of itPackages()) {
    log(`test:it ${dir}`);
    await runNpm(['run', 'test:it', '-w', dir]);
  }
}

/** Конфиги окружения разработки: Compose, Caddy, Mosquitto — их же образами. */
async function stageConfig() {
  log('docker compose config (все профили: yookassa-emu, kkt-emu, kkt-bridge; переменные из .env.example)');
  await runChecked('docker', composeArgs(ENV_EXAMPLE, ...ALL_PROFILE_ARGS, 'config', '--quiet'), {}, 'docker compose config');

  log(`caddy validate (${CADDY_IMAGE})`);
  const caddyfile = join(ROOT, 'deploy', 'dev', 'Caddyfile');
  await runChecked(
    'docker',
    ['run', '--rm', '-e', 'DEV_LAN_HOST=192.168.1.10', '-v', `${caddyfile}:/etc/caddy/Caddyfile:ro`, CADDY_IMAGE,
      'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
    {},
    'caddy validate',
  );

  log(`WebSocket ${WS_PATH} через Caddy (мост ККТ): временная сеть, заглушка сервера, ${NODE_IMAGE}`);
  await checkCaddyWebSocket({ caddyImage: CADDY_IMAGE, nodeImage: NODE_IMAGE });

  log(`mosquitto --test-config (${MOSQUITTO_IMAGE})`);
  const conf = join(ROOT, 'deploy', 'dev', 'mosquitto', 'mosquitto.conf');
  await runChecked(
    'docker',
    ['run', '--rm', '-v', `${conf}:/mosquitto/config/mosquitto.conf:ro`, MOSQUITTO_IMAGE,
      'mosquitto', '-c', '/mosquitto/config/mosquitto.conf', '--test-config'],
    {},
    'mosquitto --test-config',
  );
}

/** Сборка обоих приложений и бюджет JS гостя (< 200 КБ gzip, PRODUCT §20). */
async function stageWeb() {
  for (const dir of ['web/guest', 'web/admin']) {
    const r = packageScript(dir, 'build');
    if (!r.ok && !existsSync(join(ROOT, dir, 'package.json'))) {
      notice(`${dir}: пакета ещё нет, сборка пропущена`);
      continue;
    }
    if (!r.ok) fail(`${dir}: ${r.reason}`);
    log(`сборка ${dir}`);
    await runNpm(['run', 'build', '-w', dir], { env: buildEnv() });
    if (dir === 'web/guest') {
      const size = packageScript(dir, 'size');
      if (!size.ok) fail(`${dir}: ${size.reason} — бюджет JS гостя (200 КБ gzip) не проверить`);
      log('бюджет JS гостя: npm run size -w web/guest');
      await runNpm(['run', 'size', '-w', dir], { env: buildEnv() });
    }
  }
}

function buildEnv() {
  const env = { ...process.env };
  delete env.NODE_ENV; // vite build при NODE_ENV=development собрал бы отладочную версию
  return env;
}

function need(tool, args, hint) {
  const r = capture(tool, args);
  if (r.error?.code === 'ENOENT' || r.code !== 0) fail(`${tool} не найден. ${hint}`);
  return r.stdout.split('\n')[0].trim();
}

/** Нативные тесты логики прошивки: CMake + g++ в отдельной папке сборки, ctest. */
async function stageFirmwareNative() {
  if (!existsSync(join(ROOT, FW_NATIVE_DIR, 'CMakeLists.txt'))) {
    notice(`${FW_NATIVE_DIR.replaceAll('\\', '/')}/CMakeLists.txt ещё нет, нативные тесты прошивки пропущены`);
    return;
  }
  const hint = 'Нужны CMake 3.20+ и компилятор C++ (Linux: apt install cmake g++; macOS: brew install cmake). Без этапа: npm run ci -- --base --config --web --db';
  log(`${need('cmake', ['--version'], hint)}; ${need('c++', ['--version'], hint)}`);
  const build = mkdtempSync(join(tmpdir(), 'bl-fw-native-'));
  try {
    await runChecked('cmake', ['-S', join(ROOT, FW_NATIVE_DIR), '-B', build, '-DCMAKE_BUILD_TYPE=Debug'], {}, 'cmake configure');
    await runChecked('cmake', ['--build', build, '--parallel'], {}, 'cmake --build');
    // --no-tests=error: CMakeLists без add_test не должен «проходить» молча.
    await runChecked('ctest', ['--test-dir', build, '--output-on-failure', '--no-tests=error'], {}, 'ctest');
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}

/** Сборка прошивки под ESP32 и тесты PlatformIO (реестр PlatformIO нужен в сети). */
async function stagePio() {
  if (!existsSync(join(ROOT, 'firmware', 'platformio.ini'))) {
    notice('firmware/platformio.ini ещё нет, pio run и pio test пропущены');
    return;
  }
  const version = need('pio', ['--version'], `Установите PlatformIO ${PIO_VERSION}: python3 -m pip install platformio==${PIO_VERSION}`);
  if (!version.includes(PIO_VERSION)) log(`внимание: ${version}, в CI закреплена ${PIO_VERSION}`);
  const dir = join(ROOT, 'firmware');
  log('pio run -e esp32dev');
  await runChecked('pio', ['run', '-d', dir, '-e', 'esp32dev'], {}, 'pio run -e esp32dev');
  log('pio test -e native');
  await runChecked('pio', ['test', '-d', dir, '-e', 'native'], {}, 'pio test -e native');
}

async function stageDb() {
  // CI честный: it-sim не должен молча пропуститься из-за нехватки openssl.
  const problem = lightItProblem();
  if (problem) fail(`интеграции light нужен свой брокер: ${problem}. Linux: apt install openssl; macOS: есть в системе.`);
  try {
    const { port, password } = await startPostgres();
    const appPassword = randomBytes(24).toString('hex');
    // Окружение целиком задаётся здесь: .env разработки не читается (dbTestEnv получает {}).
    const env = dbTestEnv(
      {
        ...process.env,
        DATABASE_ADMIN_URL: `postgres://supabase_admin:${password}@127.0.0.1:${port}/postgres`,
        DB_APP_PASSWORD: appPassword,
        DATABASE_URL: `postgres://app_api:${appPassword}@127.0.0.1:${port}/postgres`,
        LIGHT_IT: '1',
      },
      {},
    );
    for (const script of ['db:migrate', 'db:seed']) {
      log(script);
      await runNpm(['run', script], { env });
    }
    await runDbTests(env, { strict: true });
  } finally {
    removeContainers();
  }
}

const RUNNERS = { base: stageBase, config: stageConfig, web: stageWeb, fw: stageFirmwareNative, db: stageDb, pio: stagePio };
const NEEDS_DOCKER = new Set(['base', 'config', 'db']);

async function main() {
  process.on('SIGINT', () => {
    interrupted = true;
  });
  process.on('exit', removeContainers);

  const stages = parseCiArgs(process.argv.slice(2));
  if (stages.some((s) => NEEDS_DOCKER.has(s))) checkDocker();
  for (const stage of stages) {
    log(`этап ${stage}`);
    await RUNNERS[stage]();
  }
  if (!stages.includes('pio')) log(`pio run и pio test — отдельно: npm run ci -- --pio (PlatformIO ${PIO_VERSION}), в GitHub — задача firmware-pio`);
  log(`всё зелёное: ${stages.join(', ')}`);
  return 0;
}

if (isMain(import.meta.url)) runMain('ci', main);
