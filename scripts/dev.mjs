// `npm run dev`: поднимает окружение разработки с нуля (контракты M0 §2 и M1 §11).
// Требуется только Docker (Compose v2) и Node 22.
//
// 1. Проверяет Docker и Compose.
// 2. Создаёт .env из .env.example со случайными секретами (значения не печатаются);
//    в существующий .env дописывает недостающие переменные, имеющиеся не трогает.
// 3. Ставит зависимости на хосте, если их нет (в контейнерах npm не запускается).
// 4. Создаёт dev-сертификаты брокера (scripts/dev-certs.mjs).
// 5. Поднимает db и mosquitto и ждёт готовности; роли базы — в supautils.reserved_roles.
// 6. Останавливает старые server и device-sim; db:migrate, db:seed, provision:dev — с хоста.
// 7. Собирает web/guest и web/admin на хосте (vite build): у Vite нативный esbuild
//    под платформу хоста, в Linux-контейнере на macOS и Windows он не запустится.
// 8. Заново поднимает server, device-sim (после провижининга), yookassa-emu (если
//    пакет уже есть), caddy и показывает логи.
//
//   npm run dev                  — всё по шагам выше
//   npm run dev -- --watch-web   — ещё и `vite build --watch` обоих приложений на хосте
//                                  рядом с логами (Ctrl+C останавливает и сборку)

import { spawn } from 'node:child_process';
import { createECDH, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ensureDevCerts } from './dev-certs.mjs';
import {
  capture,
  checkDocker,
  composeArgs,
  EMU_ENTRY,
  EMU_PROFILE,
  ENV_EXAMPLE,
  ENV_FILE,
  envWithFile,
  fail,
  isMain,
  makeLogger,
  missingDependencies,
  npm,
  packageScript,
  projectVolumes,
  readEnvFile,
  RESERVED_ROLES_SCRIPT,
  ROOT,
  run,
  runChecked,
  runMain,
  runNpm,
} from './dev-lib.mjs';

const log = makeLogger('dev');
const WAIT_TIMEOUT_S = '180';

const secret = () => randomBytes(24).toString('hex'); // безопасно в URL и в командной строке

/** Закрытый ключ VAPID: скаляр P-256, 32 байта в base64url (как у web-push). */
export function generateVapidPrivateKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'jwk' }).d;
}

/** Открытый ключ VAPID по закрытому: точка P-256 без сжатия, 65 байт в base64url. */
export function vapidPublicKey(privateKey) {
  const d = Buffer.from(privateKey, 'base64url');
  if (d.length !== 32) throw new Error('закрытый ключ VAPID — не 32 байта в base64url');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  return ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
}

// Значения по умолчанию для .env. Функции получают уже заполненные значения,
// поэтому адреса баз собираются из паролей того же файла, а открытый ключ VAPID —
// из закрытого. Переменные без значения по умолчанию (токены ботов, DEV_LAN_HOST)
// остаются пустыми и необязательны.
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
  // M1 §11
  NODE_ENV: () => 'development',
  PUBLIC_HOST: () => 'localhost:8443',
  ALLOW_DEV_LOGIN: () => '1',
  DEV_ALLOW_ANY_MINUTES: () => '1',
  YOOKASSA_API_URL: () => 'http://yookassa-emu:8090/v3',
  YOOKASSA_EMU_SHOP_ID: () => String(randomInt(900000, 1000000)),
  YOOKASSA_EMU_SECRET: () => `test_${randomBytes(24).toString('base64url')}`,
  VAPID_PRIVATE_KEY: generateVapidPrivateKey,
  VAPID_PUBLIC_KEY: (v) => vapidPublicKey(v.VAPID_PRIVATE_KEY),
  VAPID_SUBJECT: () => 'mailto:dev@localhost',
  TELEGRAM_WEBHOOK_SECRET: secret,
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
  added.sort((a, b) => keys.indexOf(a) - keys.indexOf(b));
  return { values, added };
}

/** Проверки значений, которые Compose, Caddy и сервер иначе поймут не так. */
function checkEnvValues(env) {
  if (env.MQTT_ADMIN_PASSWORD.length < 12) fail('MQTT_ADMIN_PASSWORD в .env короче 12 символов (требование Dynamic Security).');
  let derived;
  try {
    derived = vapidPublicKey(env.VAPID_PRIVATE_KEY);
  } catch {
    fail('VAPID_PRIVATE_KEY в .env — не ключ P-256 (32 байта в base64url). Удалите обе строки VAPID_*_KEY, npm run dev создаст новую пару.');
  }
  if (derived !== env.VAPID_PUBLIC_KEY) {
    fail('VAPID_PUBLIC_KEY в .env не от VAPID_PRIVATE_KEY. Удалите обе строки VAPID_*_KEY, npm run dev создаст новую пару.');
  }
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(env.PUBLIC_HOST)) fail('PUBLIC_HOST в .env — хост и порт без схемы и пути, например localhost:8443.');
  const lan = env.DEV_LAN_HOST ?? '';
  if (lan && (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(lan) || ['localhost', '127.0.0.1'].includes(lan))) {
    fail('DEV_LAN_HOST в .env — IP или имя этой машины в локальной сети без порта (например 192.168.1.10), не localhost.');
  }
  if (lan && env.PUBLIC_HOST.split(':')[0] !== lan) {
    log(`DEV_LAN_HOST задан, а PUBLIC_HOST — нет: ссылки QR и оплаты ведут на ${env.PUBLIC_HOST}. Для телефона: PUBLIC_HOST=${lan}:8443`);
  }
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
  checkEnvValues(env);
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

/** Приложения, которые собираются на хосте и раздаются Caddy (deploy/dev/Caddyfile). */
export const WEB_APPS = [
  { dir: 'web/guest', url: '/app/' },
  { dir: 'web/admin', url: '/club/' },
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

/** Разбор параметров `npm run dev -- …`. */
export function parseDevArgs(args) {
  const opts = { watchWeb: false };
  for (const a of args) {
    if (a === '--watch-web') opts.watchWeb = true;
    else fail(`неизвестный параметр ${a}. Есть только --watch-web (пересборка фронтенда на лету).`);
  }
  return opts;
}

// Профиль Compose эмулятора ЮKassa включается, только когда пакет уже есть.
let profileArgs = [];
const dc = (...args) => composeArgs(ENV_FILE, ...profileArgs, ...args);

async function compose(args, what) {
  await runChecked('docker', dc(...args), {}, what);
}

async function showLogsOnFailure(services, err) {
  console.error('');
  log(`последние строки логов: ${services.join(', ')}`);
  await run('docker', dc('logs', '--tail', '40', ...services));
  throw err;
}

/**
 * Окружение сборки фронтенда: без .env (секреты не должны попасть в бандл)
 * и без NODE_ENV (иначе `vite build` при NODE_ENV=development соберёт отладочную версию).
 * Из .env берётся только ALLOW_DEV_LOGIN: при 1 в приложение попадает вход по телефону
 * для разработки (VITE_DEV_LOGIN=1, web/guest/vite.config.js). Сборка CI — без него.
 */
export function webBuildEnv(envFile = readEnvFile(ENV_FILE), base = process.env) {
  const env = { ...base };
  delete env.NODE_ENV;
  if (envFile.ALLOW_DEV_LOGIN === '1') env.VITE_DEV_LOGIN = '1';
  return env;
}

/**
 * vite build обоих приложений на хосте. Пакета ещё нет — шаг пропускается;
 * сборка упала — окружение поднимается дальше, Caddy отдаёт прежнюю сборку или 503.
 * Возвращает предупреждения для итоговой сводки.
 */
async function buildWeb() {
  const warnings = [];
  for (const app of WEB_APPS) {
    const r = packageScript(app.dir, 'build');
    if (!r.ok) {
      const msg = `${app.url}: ${r.reason} (зона frontend) — сборка пропущена, Caddy ответит 503`;
      log(msg);
      warnings.push(msg);
      continue;
    }
    log(`собираю ${app.dir} на хосте: npm run build -w ${app.dir}`);
    const c = npm(['run', 'build', '-w', app.dir]);
    const code = await run(c.cmd, c.args, { env: webBuildEnv(), shell: c.shell });
    if (code !== 0) {
      const msg = `${app.url}: сборка ${app.dir} упала (код ${code}) — Caddy отдаёт прежнюю сборку или 503`;
      log(msg);
      warnings.push(msg);
    }
  }
  return warnings;
}

/** Команда пересборки на лету: свой скрипт build:watch пакета или `vite build --watch`. */
function watchCommand(dir) {
  if (packageScript(dir, 'build:watch').ok) return npm(['run', 'build:watch', '-w', dir]);
  // vite из зависимостей пакета, без npm exec (тот мог бы скачать vite из сети).
  const req = createRequire(join(ROOT, dir, 'package.json'));
  const pkgFile = req.resolve('vite/package.json');
  const bin = JSON.parse(readFileSync(pkgFile, 'utf8')).bin;
  const script = join(dirname(pkgFile), typeof bin === 'string' ? bin : bin.vite);
  return { cmd: process.execPath, args: [script, 'build', '--watch'], shell: false, cwd: join(ROOT, dir) };
}

/** Запускает пересборку на лету; вывод — строками с префиксом [web/guest]. */
function startWebWatchers(apps) {
  const children = [];
  for (const app of apps) {
    let c;
    try {
      c = watchCommand(app.dir);
    } catch {
      log(`${app.dir}: не нашёл vite в зависимостях — пересборка на лету не запущена`);
      continue;
    }
    const child = spawn(c.cmd, c.args, { cwd: c.cwd ?? ROOT, env: webBuildEnv(), shell: c.shell, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split(/\r?\n/);
        rest = lines.pop();
        for (const line of lines) if (line.trim()) console.log(`[${app.dir}] ${line}`);
      });
    }
    child.once('error', (err) => log(`${app.dir}: пересборка на лету не запустилась: ${err.message}`));
    child.once('exit', (code, signal) => {
      if (!stopping) log(`${app.dir}: пересборка на лету остановилась (${signal ?? `код ${code}`})`);
    });
    children.push(child);
  }
  return children;
}

let stopping = false;

async function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) fail(`нужен Node 22 или новее, сейчас ${process.versions.node}.`);
  const opts = parseDevArgs(process.argv.slice(2));

  checkDocker();
  ensureEnvFile();
  await ensureDependencies();
  checkPackages();

  const emu = existsSync(join(ROOT, EMU_ENTRY));
  if (emu) profileArgs = ['--profile', EMU_PROFILE];
  else log(`нет ${EMU_ENTRY} (зона backend-money) — эмулятор ЮKassa не запускаю, /pay/ ответит 502`);

  // DEV_LAN_HOST — в SAN брокера (контроллер в локальной сети); нет имени — перевыпуск тем же CA.
  const { changed } = ensureDevCerts({ log: makeLogger('certs'), extraHosts: [readEnvFile(ENV_FILE).DEV_LAN_HOST] });
  const brokerWasRunning = capture('docker', dc('ps', '-q', '--status', 'running', 'mosquitto')).stdout.trim() !== '';

  log('поднимаю db и mosquitto');
  await compose(['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, 'db', 'mosquitto'], 'запуск db и mosquitto').catch((e) =>
    showLogsOnFailure(['db', 'mosquitto'], e),
  );
  if (changed && brokerWasRunning) {
    // Брокер читает сертификаты при старте.
    log('сертификаты обновились — перезапускаю mosquitto');
    await compose(['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, '--force-recreate', '--no-deps', 'mosquitto']);
  }

  log('закрываю роли базы от привилегированной роли Supabase (supautils.reserved_roles)');
  await runChecked('docker', dc('exec', '-T', '-u', 'postgres', 'db', 'sh', '-s'), { stdinFile: RESERVED_ROLES_SCRIPT }, 'reserved-roles.sh');

  // provision:dev меняет пароли и ключи устройств, миграции — схему. Старые server
  // и device-sim останавливаем до этих шагов и запускаем заново только после них,
  // чтобы оба прочитали актуальные ключи (из базы и deploy/dev/devices.json).
  await compose(['stop', 'device-sim', 'server'], 'остановка server и device-sim');

  const env = envWithFile(ENV_FILE);
  for (const step of HOST_STEPS) {
    log(`npm run ${step.script}`);
    await runNpm(['run', step.script], { env });
  }

  // Фронтенд — до caddy: он раздаёт готовые web/*/dist.
  const webWarnings = await buildWeb();

  // Пересоздаём контейнеры, даже если их конфигурация не менялась: новый процесс
  // читает свежие ключи. device-sim стартует после healthy server (depends_on).
  const services = ['server', 'device-sim', ...(emu ? ['yookassa-emu'] : []), 'caddy'];
  log(`поднимаю ${services.join(', ')}`);
  await compose(
    ['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, '--force-recreate', '--no-deps', ...services],
    `запуск ${services.join(', ')}`,
  ).catch((e) => showLogsOnFailure(services, e));

  const files = readEnvFile(ENV_FILE);
  const pub = `https://${files.PUBLIC_HOST || 'localhost:8443'}`;
  const lan = files.DEV_LAN_HOST ? `\n    https://${files.DEV_LAN_HOST}:8443/app/   с телефона в локальной сети (README)` : '';
  const devLogin = files.ALLOW_DEV_LOGIN === '1' ? 'вход для разработки по телефону включён (ALLOW_DEV_LOGIN=1)' : 'вход для разработки выключен';
  const anyMinutes = files.DEV_ALLOW_ANY_MINUTES === '1' ? ', ускоренное время включено (DEV_ALLOW_ANY_MINUTES=1)' : '';
  const warn = webWarnings.length > 0 ? `\n  Внимание:\n${webWarnings.map((w) => `    - ${w}`).join('\n')}\n` : '';
  const logServices = ['server', 'device-sim', ...(emu ? ['yookassa-emu'] : [])];

  console.log(`
  Окружение запущено (проект Compose: billiardum)
    ${pub}/app/     приложение гостя (Caddy, tls internal)
    ${pub}/club/    программа клуба
    ${pub}/pay/     страница оплаты эмулятора ЮKassa${emu ? '' : ' (эмулятора ещё нет)'}
    ${pub}/api/     API сервера${lan}
    http://localhost:3000/health   сервер напрямую
    http://127.0.0.1:18080         управление симулятором (README)
    mqtts://localhost:8883         брокер, CA: deploy/dev/certs/ca.crt
    localhost:54322                Postgres (пароли в .env)
  ${devLogin}${anyMinutes}
${warn}
  Ниже логи ${logServices.join(', ')}${opts.watchWeb ? ' и пересборки фронтенда' : ''}.
  Ctrl+C — выйти из логов${opts.watchWeb ? ' и остановить пересборку' : ''}, окружение продолжит работать.
  Остановить: npm run down   Стереть данные: npm run down -- --volumes
`);

  // Пересборка на лету — для всех приложений с пакетом, даже если первая сборка упала.
  const watchers = opts.watchWeb ? startWebWatchers(WEB_APPS.filter((a) => packageScript(a.dir, 'build').ok)) : [];

  // Ctrl+C получает и docker compose logs (и пересборка); сами выходим после него.
  process.on('SIGINT', () => {
    stopping = true;
  });
  await run('docker', dc('logs', '-f', '--tail', 'all', ...logServices));
  stopping = true;
  for (const w of watchers) if (w.exitCode === null) w.kill();
  log('логи закрыты. Состояние: docker compose -p billiardum ps   Остановить: npm run down');
  return 0;
}

if (isMain(import.meta.url)) runMain('dev', main);
