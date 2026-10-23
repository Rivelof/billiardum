// `npm run dev`: поднимает окружение разработки с нуля (контракты M0 §2, M1 §11, M2 §6).
// Требуется только Docker (Compose v2) и Node 22.
//
// 1. Проверяет Docker и Compose.
// 2. Создаёт .env из .env.example со случайными секретами (значения не печатаются);
//    в существующий .env дописывает недостающие переменные, имеющиеся не трогает.
// 3. Ставит зависимости на хосте, если их нет (в контейнерах npm не запускается).
// 4. Создаёт dev-сертификаты брокера (scripts/dev-certs.mjs).
// 5. Поднимает db и mosquitto и ждёт готовности; роли базы — в supautils.reserved_roles.
// 6. Решает, какие сервисы перезапустить (scripts/dev-code.mjs): процесс Node держит код,
//    загруженный при старте, поэтому перезапускаются те, чей код (файлы сервиса, .env,
//    ключи) изменился с их старта; остановленные и отсутствующие запускаются, остальные
//    работают дальше. Mosquitto и db этот шаг не трогает никогда.
// 7. Останавливает отставшие; с хоста — db:migrate (всегда, до старта server), db:seed,
//    provision:dev и регистрация моста ККТ (только когда стартует server, нет ключей или
//    --restart: они выдают новые ключи, и тогда перезапускаются device-sim и kkt-bridge).
// 8. Собирает web/guest и web/admin (vite build) и острова сайта web/site (esbuild) на хосте:
//    у esbuild нативный бинарник под платформу хоста, в Linux-контейнере на macOS и Windows
//    он не запустится.
// 9. `docker compose up` для server, device-sim, необязательных сервисов, чьи пакеты уже
//    есть (yookassa-emu, kkt-emu, kkt-bridge, site), и caddy; записывает отпечатки кода
//    запущенных контейнеров (deploy/dev/code-state.json) и показывает логи.
//
//   npm run dev                  — всё по шагам выше
//   npm run dev -- --restart     — перезапустить все сервисы Node и выдать новые ключи,
//                                  даже если код не менялся (db, mosquitto, caddy — нет)
//   npm run dev -- --check       — ничего не меняет: какие сервисы отстали от кода
//                                  (код выхода 1 — npm run dev их перезапустит)
//   npm run dev -- --watch-web   — ещё и `vite build --watch` обоих приложений и пересборка
//                                  островов сайта на хосте рядом с логами (Ctrl+C
//                                  останавливает и сборку)

import { spawn } from 'node:child_process';
import { createECDH, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ensureDevCerts } from './dev-certs.mjs';
import { fingerprints, inspectContainers, nextState, planServices, readState, writeState } from './dev-code.mjs';
import {
  capture,
  checkDocker,
  composeArgs,
  ALL_PROFILE_ARGS,
  ENV_EXAMPLE,
  ENV_FILE,
  envWithFile,
  fail,
  isMain,
  DEVICES_FILE,
  KKT_TOKEN_FILE,
  makeLogger,
  missingDependencies,
  missingFiles,
  npm,
  OPTIONAL_SERVICES,
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
  if (env.SITE_ORIGIN && !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(env.SITE_ORIGIN)) {
    fail('SITE_ORIGIN в .env — адрес сайта со схемой, без пути и косой черты в конце, например https://billiardum.ru. Пусто — https://{PUBLIC_HOST}.');
  }
  if (env.YANDEX_METRIKA_ID && !/^\d{4,12}$/.test(env.YANDEX_METRIKA_ID)) fail('YANDEX_METRIKA_ID в .env — номер счётчика Метрики, только цифры.');
  for (const k of ['SITE_API_SUBNET', 'SITE_WEB_SUBNET']) {
    if (env[k] && !/^\d{1,3}(\.\d{1,3}){3}\/(2[4-9]|30)$/.test(env[k])) fail(`${k} в .env — подсеть IPv4 от /24 до /30, например 10.231.47.0/29.`);
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

/**
 * Регистрация моста ККТ тестового клуба (backend-kkt, контракт M2 §6) — после provision:dev.
 * Первый найденный вариант: скрипт npm `provision:dev` пакета tools/kkt-bridge или файл
 * из списка (запускается `node <файл>`, окружение — .env). Скрипт выдаёт мосту новый токен
 * (в базе — хеш, прежний токен моста разработки отзывается) и пишет только токен в файл
 * KKT_BRIDGE_TOKEN_FILE (deploy/dev/kkt-bridge.token, права 0600, вне git). Токен не печатается.
 * Настройки моста (адреса, журнал) — deploy/dev/kkt-bridge.json, без секретов, в git.
 */
export const KKT_REGISTER_SCRIPTS = [
  'server/kkt/bin/provision-dev.mjs',
  'server/kkt/bin/register-dev.mjs',
  'tools/kkt-bridge/bin/provision-dev.mjs',
  'tools/kkt-bridge/bin/register-dev.mjs',
];

/** Чем зарегистрировать мост разработки: команда npm, файл или null (скрипта ещё нет). */
export function kktRegisterCommand(root = ROOT) {
  const file = join(root, 'tools', 'kkt-bridge', 'package.json');
  if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).scripts?.['provision:dev']) {
    return { label: 'npm run provision:dev -w @billiardum/kkt-bridge', npmArgs: ['run', 'provision:dev', '-w', '@billiardum/kkt-bridge'] };
  }
  const script = KKT_REGISTER_SCRIPTS.find((p) => existsSync(join(root, p)));
  return script ? { label: `node ${script}`, script } : null;
}

async function registerKktBridge(env) {
  const cmd = kktRegisterCommand();
  if (!cmd) {
    const have = existsSync(KKT_TOKEN_FILE) ? ', мост запустится с прежним токеном deploy/dev/kkt-bridge.token' : '';
    log(`нет скрипта регистрации моста ККТ (зона backend-kkt: ${KKT_REGISTER_SCRIPTS.join(', ')})${have}`);
    return;
  }
  log(`регистрация моста ККТ тестового клуба: ${cmd.label}`);
  const regEnv = { ...env, KKT_BRIDGE_TOKEN_FILE: KKT_TOKEN_FILE };
  if (cmd.npmArgs) await runNpm(cmd.npmArgs, { env: regEnv });
  else await runChecked(process.execPath, [cmd.script], { env: regEnv }, cmd.label);
  if (!existsSync(KKT_TOKEN_FILE)) log(`${cmd.label} не создал deploy/dev/kkt-bridge.token — мост ККТ не запускаю`);
}

/**
 * Приложения, которые собираются на хосте (deploy/dev/Caddyfile): guest и admin раздаёт
 * Caddy, острова сайта (web/site/dist) — сервис site. `missing` — что будет без сборки;
 * `watch` — команда пересборки на лету от папки пакета, если в нём нет скрипта build:watch.
 */
export const WEB_APPS = [
  { dir: 'web/guest', url: '/app/', owner: 'frontend', missing: 'Caddy ответит 503' },
  { dir: 'web/admin', url: '/club/', owner: 'frontend', missing: 'Caddy ответит 503' },
  { dir: 'web/site', url: '/', owner: 'frontend-site', missing: 'сайт отдаст страницы без островов', watch: ['scripts/build.mjs', '--watch'] },
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
  const opts = { watchWeb: false, restart: false, check: false };
  for (const a of args) {
    if (a === '--watch-web') opts.watchWeb = true;
    else if (a === '--restart') opts.restart = true;
    else if (a === '--check') opts.check = true;
    else {
      fail(
        `неизвестный параметр ${a}. Есть --watch-web (пересборка фронтенда на лету), --restart (перезапустить ` +
          'сервисы Node) и --check (только показать, что отстало от кода).',
      );
    }
  }
  if (opts.check && (opts.restart || opts.watchWeb)) fail('--check только показывает план, без --restart и --watch-web.');
  return opts;
}

// Профили необязательных сервисов (OPTIONAL_SERVICES) включаются, только когда их файлы уже есть.
let profileArgs = [];
const dc = (...args) => composeArgs(ENV_FILE, ...profileArgs, ...args);

/**
 * Необязательные сервисы, которые запустятся после регистрации моста: все файлы есть,
 * токена моста может ещё не быть, если его выдаст регистрация (canRegister).
 */
function candidateOptionalServices(canRegister) {
  return OPTIONAL_SERVICES.filter((svc) =>
    missingFiles(svc).every((p) => canRegister && join(ROOT, p) === KKT_TOKEN_FILE),
  ).map((svc) => svc.service);
}

/** Строки в лог: что перезапускается и почему. Возвращает, нужно ли что-то (пере)запускать. */
function logPlan(plan, dry = false) {
  const groups = { start: [], restart: [], keep: [] };
  for (const [s, a] of Object.entries(plan.actions)) groups[a.action].push(a.reason ? `${s} (${a.reason})` : s);
  const will = dry ? 'npm run dev перезапустит' : 'перезапускаю';
  if (groups.restart.length > 0) log(`${will}: ${groups.restart.join(', ')}`);
  if (groups.start.length > 0) log(`${dry ? 'npm run dev запустит' : 'запускаю'}: ${groups.start.join(', ')}`);
  if (groups.keep.length > 0) log(`на текущем коде${dry ? '' : ', не перезапускаю'}: ${groups.keep.join(', ')}`);
  if (plan.provision) log(`provision:dev${plan.registerKkt ? ' и регистрация моста ККТ' : ''}: ${dry ? 'понадобятся' : 'да'} (новые ключи)`);
  else if (plan.registerKkt) log(`регистрация моста ККТ: ${dry ? 'понадобится' : 'да'} (нет токена)`);
  else log(`provision:dev ${dry ? 'не понадобится' : 'пропускаю'}: server не перезапускается, ключи устройств прежние`);
  return groups.restart.length + groups.start.length > 0 || plan.provision || plan.registerKkt;
}

/** План перезапуска по текущему коду и контейнерам (scripts/dev-code.mjs). */
function makePlan(opts, kktCmd) {
  const candidates = ['server', 'device-sim', ...candidateOptionalServices(kktCmd !== null), 'caddy'];
  const containers = inspectContainers();
  const codes = fingerprints(candidates);
  const plan = planServices({
    services: candidates,
    containers,
    state: readState(),
    codes,
    force: opts.restart,
    devicesFile: existsSync(DEVICES_FILE),
    kktToken: existsSync(KKT_TOKEN_FILE),
    kktRegister: kktCmd !== null,
  });
  return { plan, containers, codes };
}

/**
 * `npm run dev -- --check`: ничего не меняет, только показывает, какие сервисы отстали от
 * кода. Код выхода 1 — npm run dev что-то перезапустит или запустит.
 */
function checkOnly() {
  checkDocker();
  const { plan } = makePlan({ restart: false }, kktRegisterCommand());
  const pending = logPlan(plan, true);
  log(pending ? 'окружение отстало от кода: npm run dev' : 'все сервисы работают на текущем коде');
  return pending ? 1 : 0;
}

/** Необязательные сервисы, которые можно запускать; про остальные — строка в лог. */
function pickOptionalServices() {
  const on = [];
  for (const svc of OPTIONAL_SERVICES) {
    const missing = missingFiles(svc);
    if (missing.length === 0) on.push(svc.service);
    else log(`нет ${missing.join(', ')} (зона ${svc.owner}) — ${svc.without}`);
  }
  return on;
}

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
      const msg = `${app.url}: ${r.reason} (зона ${app.owner}) — сборка пропущена, ${app.missing}`;
      log(msg);
      warnings.push(msg);
      continue;
    }
    log(`собираю ${app.dir} на хосте: npm run build -w ${app.dir}`);
    const c = npm(['run', 'build', '-w', app.dir]);
    const code = await run(c.cmd, c.args, { env: webBuildEnv(), shell: c.shell });
    if (code !== 0) {
      const msg = `${app.url}: сборка ${app.dir} упала (код ${code}) — работает прежняя сборка, без неё ${app.missing}`;
      log(msg);
      warnings.push(msg);
    }
  }
  return warnings;
}

/** Команда пересборки на лету: свой скрипт build:watch пакета, app.watch или `vite build --watch`. */
function watchCommand(app) {
  const { dir } = app;
  if (packageScript(dir, 'build:watch').ok) return npm(['run', 'build:watch', '-w', dir]);
  if (app.watch) return { cmd: process.execPath, args: app.watch, shell: false, cwd: join(ROOT, dir) };
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
      c = watchCommand(app);
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
  if (opts.check) return checkOnly();

  checkDocker();
  ensureEnvFile();
  await ensureDependencies();
  checkPackages();

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

  // Что перезапускать (scripts/dev-code.mjs): только сервисы, чей код изменился с их старта,
  // остановленные и отсутствующие — запустить. Mosquitto и db этот шаг не трогает.
  const since = new Date(Date.now() - 5000).toISOString(); // логи этого запуска (с запасом на часы Docker)
  const kktCmd = kktRegisterCommand();
  const { plan, containers: before, codes: planCodes } = makePlan(opts, kktCmd);
  logPlan(plan);

  // Отставшие останавливаем до миграций, provision:dev и регистрации моста: новый процесс
  // читает актуальную схему и ключи (из базы, deploy/dev/devices.json и
  // deploy/dev/kkt-bridge.token). Все профили: иначе Compose не остановил бы мост, если его
  // пакет пропал. Мост с новым токеном — с новым контейнером (журнал — от прежнего моста).
  const toStop = Object.entries(plan.actions)
    .filter(([s, a]) => a.action === 'restart' && !plan.recreate.includes(s))
    .map(([s]) => s);
  if (toStop.length > 0) {
    await runChecked('docker', composeArgs(ENV_FILE, ...ALL_PROFILE_ARGS, 'stop', ...toStop), {}, `остановка ${toStop.join(', ')}`);
  }
  if (plan.recreate.length > 0) {
    await runChecked('docker', composeArgs(ENV_FILE, ...ALL_PROFILE_ARGS, 'rm', '-f', '-s', ...plan.recreate), {}, `удаление ${plan.recreate.join(', ')}`);
  }

  // Миграции — всегда и до старта server: сервер не обгоняет схему.
  const env = envWithFile(ENV_FILE);
  for (const step of HOST_STEPS) {
    if (step.script === 'provision:dev' && !plan.provision) continue;
    log(`npm run ${step.script}`);
    await runNpm(['run', step.script], { env });
  }
  // Без скрипта регистрации registerKktBridge только пишет об этом в лог.
  if (plan.registerKkt || !kktCmd) await registerKktBridge(env);

  // Необязательные сервисы — после регистрации моста: ему нужен её токен.
  const optional = pickOptionalServices();
  profileArgs = optional.flatMap((s) => ['--profile', s]);
  const emu = optional.includes('yookassa-emu');

  // Фронтенд — до caddy: он раздаёт готовые web/*/dist.
  const webWarnings = await buildWeb();

  // `up` запускает остановленные и отсутствующие, пересоздаёт те, у кого изменилась
  // конфигурация Compose (compose.yml, .env), работающие на текущем коде не трогает.
  // device-sim и kkt-bridge стартуют после healthy server, мост — ещё и после healthy
  // kkt-emu (depends_on).
  const services = ['server', 'device-sim', ...optional, 'caddy'];
  const upCodes = fingerprints(services);
  log(`поднимаю ${services.join(', ')}`);
  await compose(['up', '-d', '--wait', '--wait-timeout', WAIT_TIMEOUT_S, '--no-deps', ...services], `запуск ${services.join(', ')}`).catch((e) =>
    showLogsOnFailure(services, e),
  );
  const after = inspectContainers();
  writeState(nextState({ services, before, after, planCodes, upCodes }));
  const restarted = services.filter((s) => !(before[s] && after[s] && before[s].id === after[s].id && before[s].startedAt === after[s].startedAt));
  const fresh = restarted.length > 0 ? `запущены заново: ${restarted.join(', ')}` : 'ничего не перезапускалось: код сервисов не менялся';

  const files = readEnvFile(ENV_FILE);
  const pub = `https://${files.PUBLIC_HOST || 'localhost:8443'}`;
  const lan = files.DEV_LAN_HOST ? `\n    https://${files.DEV_LAN_HOST}:8443/app/   с телефона в локальной сети (README)` : '';
  const devLogin = files.ALLOW_DEV_LOGIN === '1' ? 'вход для разработки по телефону включён (ALLOW_DEV_LOGIN=1)' : 'вход для разработки выключен';
  const anyMinutes = files.DEV_ALLOW_ANY_MINUTES === '1' ? ', ускоренное время включено (DEV_ALLOW_ANY_MINUTES=1)' : '';
  const warn = webWarnings.length > 0 ? `\n  Внимание:\n${webWarnings.map((w) => `    - ${w}`).join('\n')}\n` : '';
  const logServices = ['server', 'device-sim', ...optional];
  const kkt = optional.includes('kkt-emu')
    ? `\n    kkt-emu:16732                  эмулятор ККТ АТОЛ, только внутри Compose; мост ККТ ${optional.includes('kkt-bridge') ? 'запущен' : 'не запущен'} (README)`
    : '';

  console.log(`
  Окружение запущено (проект Compose: billiardum)
    ${pub}/         публичный сайт${optional.includes('site') ? '' : ' (сервиса site ещё нет)'}; напрямую — http://localhost:3101
    ${pub}/app/     приложение гостя (Caddy, tls internal)
    ${pub}/club/    программа клуба
    ${pub}/pay/     страница оплаты эмулятора ЮKassa${emu ? '' : ' (эмулятора ещё нет)'}
    ${pub}/api/     API сервера; мост ККТ — wss://${files.PUBLIC_HOST || 'localhost:8443'}/api/kkt/ws${lan}
    http://localhost:3000/health   сервер напрямую
    http://127.0.0.1:18080         управление симулятором (README)
    mqtts://localhost:8883         брокер, CA: deploy/dev/certs/ca.crt
    localhost:54322                Postgres (пароли в .env)${kkt}
  ${devLogin}${anyMinutes}
  ${fresh} (перезапустить все сервисы Node: npm run dev -- --restart)
${warn}
  Ниже логи ${logServices.join(', ')} с начала этого запуска${opts.watchWeb ? ' и пересборки фронтенда' : ''}.
  Ctrl+C — выйти из логов${opts.watchWeb ? ' и остановить пересборку' : ''}, окружение продолжит работать.
  Остановить: npm run down   Стереть данные: npm run down -- --volumes
`);

  // Пересборка на лету — для всех приложений с пакетом, даже если первая сборка упала.
  const watchers = opts.watchWeb ? startWebWatchers(WEB_APPS.filter((a) => packageScript(a.dir, 'build').ok)) : [];

  // Ctrl+C получает и docker compose logs (и пересборка); сами выходим после него.
  process.on('SIGINT', () => {
    stopping = true;
  });
  await run('docker', dc('logs', '-f', '--since', since, ...logServices));
  stopping = true;
  for (const w of watchers) if (w.exitCode === null) w.kill();
  log('логи закрыты. Состояние: docker compose -p billiardum ps   Остановить: npm run down');
  return 0;
}

if (isMain(import.meta.url)) runMain('dev', main);
