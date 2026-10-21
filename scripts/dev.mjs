// `npm run dev`: поднимает окружение разработки с нуля (контракт M0 §2).
// Требуется только Docker (Compose v2) и Node 22.
//
// 1. Проверяет Docker и Compose.
// 2. Создаёт .env из .env.example со случайными секретами (значения не печатаются).
// 3. Ставит зависимости на хосте, если их нет (в контейнерах npm не запускается).
// 4. Создаёт dev-сертификаты брокера (scripts/dev-certs.mjs).
// 5. Поднимает db и mosquitto и ждёт готовности.
// 6. db:migrate, db:seed, provision:dev — с хоста.
// 7. Поднимает server, device-sim, caddy и показывает логи server и device-sim.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { ensureDevCerts } from './dev-certs.mjs';
import {
  capture,
  checkDocker,
  composeArgs,
  ENV_EXAMPLE,
  ENV_FILE,
  envWithFile,
  fail,
  isMain,
  makeLogger,
  missingDependencies,
  packageScript,
  projectVolumes,
  readEnvFile,
  ROOT,
  run,
  runChecked,
  runMain,
  runNpm,
} from './dev-lib.mjs';

const log = makeLogger('dev');
const WAIT_TIMEOUT_S = '180';

const secret = () => randomBytes(24).toString('hex'); // безопасно в URL и в командной строке

// Значения по умолчанию для .env. Функции получают уже заполненные значения,
// поэтому адреса баз собираются из паролей того же файла.
const ENV_DEFAULTS = {
  POSTGRES_PASSWORD: secret,
  DB_APP_PASSWORD: secret,
  MQTT_ADMIN_USER: () => 'bl-admin',
  MQTT_ADMIN_PASSWORD: secret,
  MQTT_SERVER_USER: () => 'bl-server',
  MQTT_SERVER_PASSWORD: secret,
  SECRETS_ENC_KEY: () => randomBytes(32).toString('base64'),
  MQTT_URL: () => 'mqtts://localhost:8883',
  MQTT_CA_FILE: () => 'deploy/dev/certs/ca.crt',
  SIM_DEVICES_FILE: () => 'deploy/dev/devices.json',
  PORT: () => '3000',
  LOG_LEVEL: () => 'info',
  DATABASE_ADMIN_URL: (v) => `postgres://supabase_admin:${v.POSTGRES_PASSWORD}@localhost:54322/postgres`,
  DATABASE_URL: (v) => `postgres://app_api:${v.DB_APP_PASSWORD}@localhost:54322/postgres`,
};

/** Имена переменных из .env.example в порядке появления. */
function exampleKeys(text) {
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
}

function fillValues(keys, existing) {
  const values = { ...existing };
  const added = [];
  // Сначала независимые значения, затем собранные из них адреса.
  const order = Object.keys(ENV_DEFAULTS).filter((k) => keys.includes(k));
  for (const key of [...order, ...keys.filter((k) => !order.includes(k))]) {
    if (key in values) continue;
    values[key] = ENV_DEFAULTS[key] ? ENV_DEFAULTS[key](values) : '';
    added.push(key);
  }
  return { values, added };
}

/** Создаёт .env по .env.example или дописывает в него недостающие переменные. */
export function ensureEnvFile({ envFile = ENV_FILE, example = ENV_EXAMPLE, volumes = projectVolumes } = {}) {
  if (!existsSync(example)) fail('Нет .env.example в корне репозитория.');
  const template = readFileSync(example, 'utf8');
  const keys = exampleKeys(template);

  if (!existsSync(envFile)) {
    const stale = volumes();
    if (stale.length > 0) {
      fail(
        'Нашлись данные прошлого запуска (тома Docker проекта billiardum), а файла .env нет — ' +
          'пароли от базы и брокера потеряны. Сотрите данные: npm run down -- --volumes, затем снова npm run dev.',
      );
    }
    const { values } = fillValues(keys, {});
    const text = template.replace(/^([A-Z][A-Z0-9_]*)=.*$/gm, (_, key) => `${key}=${values[key]}`);
    writeFileSync(envFile, text, { mode: 0o600 });
    log(`создан .env: ${keys.length} переменных, секреты случайные (значения не выводятся)`);
  } else {
    const { values, added } = fillValues(keys, readEnvFile(envFile));
    if (added.length > 0) {
      const lines = added.map((k) => `${k}=${values[k]}`).join('\n');
      appendFileSync(envFile, `\n# Добавлено npm run dev ${new Date().toISOString().slice(0, 10)}\n${lines}\n`);
      log(`в .env добавлены переменные: ${added.join(', ')}`);
    }
  }

  const env = readEnvFile(envFile);
  const empty = keys.filter((k) => !env[k]);
  const required = empty.filter((k) => k in ENV_DEFAULTS);
  if (required.length > 0) {
    fail(`в .env пустые переменные: ${required.join(', ')}. Заполните их или удалите строки, чтобы npm run dev создал значения.`);
  }
  if (empty.length > 0) log(`в .env не заполнены необязательные переменные: ${empty.join(', ')}`);
  for (const [k, v] of Object.entries(env)) {
    if (/[\s"'$`\\]/.test(v)) fail(`значение ${k} в .env содержит пробел, кавычку, $ или \\ — Compose прочитает его не так. Замените значение.`);
  }
  if (env.MQTT_ADMIN_PASSWORD.length < 12) fail('MQTT_ADMIN_PASSWORD в .env короче 12 символов (требование Dynamic Security).');
}

async function ensureDependencies() {
  const missing = missingDependencies();
  if (missing.length === 0) return;
  const fresh = missing[0] === 'node_modules' && existsSync(join(ROOT, 'package-lock.json'));
  log(fresh ? 'ставлю зависимости: npm ci' : `не хватает зависимостей (${missing.length}), ставлю: npm install`);
  await runNpm(fresh ? ['ci'] : ['install']);
}

const HOST_STEPS = [
  { script: 'db:migrate', pkg: 'supabase', pkgScript: 'migrate', owner: 'backend' },
  { script: 'db:seed', pkg: 'supabase', pkgScript: 'seed', owner: 'backend' },
  { script: 'provision:dev', pkg: 'server', pkgScript: 'provision:dev', owner: 'backend' },
];

function checkPackages() {
  const problems = [];
  for (const s of HOST_STEPS) {
    const r = packageScript(s.pkg, s.pkgScript);
    if (!r.ok) problems.push(`npm run ${s.script}: ${r.reason} (зона ${s.owner})`);
  }
  for (const [file, owner] of [['server/index.mjs', 'backend'], ['tools/device-sim/index.mjs', 'firmware']]) {
    if (!existsSync(join(ROOT, file))) problems.push(`нет ${file} (зона ${owner})`);
  }
  if (problems.length > 0) fail(`окружение не собрать, пока нет частей других пакетов:\n  - ${problems.join('\n  - ')}`);
}

async function compose(args, what) {
  await runChecked('docker', composeArgs(ENV_FILE, ...args), {}, what);
}

async function showLogsOnFailure(services, err) {
  console.error('');
  log(`последние строки логов: ${services.join(', ')}`);
  await run('docker', composeArgs(ENV_FILE, 'logs', '--tail', '40', ...services));
  throw err;
}

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) fail(`нужен Node 22 или новее, сейчас ${process.versions.node}.`);

  checkDocker();
  ensureEnvFile();
  await ensureDependencies();
  checkPackages();

  const { changed } = ensureDevCerts({ log: makeLogger('certs') });
  const brokerWasRunning =
    capture('docker', composeArgs(ENV_FILE, 'ps', '-q', '--status', 'running', 'mosquitto')).stdout.trim() !== '';

  log('поднимаю db и mosquitto');
  await compose(['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, 'db', 'mosquitto'], 'запуск db и mosquitto').catch((e) =>
    showLogsOnFailure(['db', 'mosquitto'], e),
  );
  if (changed && brokerWasRunning) {
    // Брокер читает сертификаты при старте.
    log('сертификаты обновились — перезапускаю mosquitto');
    await compose(['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, '--force-recreate', '--no-deps', 'mosquitto']);
  }

  const env = envWithFile(ENV_FILE);
  for (const step of HOST_STEPS) {
    log(`npm run ${step.script}`);
    await runNpm(['run', step.script], { env });
  }

  log('поднимаю server, device-sim, caddy');
  await compose(
    ['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, '--force-recreate', '--no-deps', 'server', 'device-sim', 'caddy'],
    'запуск server, device-sim, caddy',
  ).catch((e) => showLogsOnFailure(['server', 'device-sim', 'caddy'], e));

  console.log(`
  Окружение запущено (проект Compose: billiardum)
    https://localhost:8443         сервер через Caddy (tls internal)
    http://localhost:3000/health   сервер напрямую
    mqtts://localhost:8883         брокер, CA: deploy/dev/certs/ca.crt
    localhost:54322                Postgres (пароли в .env)

  Ниже логи server и device-sim. Ctrl+C — выйти из логов, окружение продолжит работать.
  Остановить: npm run down   Стереть данные: npm run down -- --volumes
`);

  // Ctrl+C получает и docker compose logs; сами выходим после него.
  process.on('SIGINT', () => {});
  await run('docker', composeArgs(ENV_FILE, 'logs', '-f', '--tail', 'all', 'server', 'device-sim'));
  log('логи закрыты. Состояние: docker compose -p billiardum ps   Остановить: npm run down');
  return 0;
}

if (isMain(import.meta.url)) runMain('dev', main);
