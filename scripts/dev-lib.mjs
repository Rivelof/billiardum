// Общие помощники scripts/dev.mjs, scripts/dev-down.mjs и scripts/ci.mjs.
// Только встроенные модули Node: скрипты работают до `npm install`.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COMPOSE_FILE = join(ROOT, 'deploy', 'dev', 'compose.yml');
export const COMPOSE_PROJECT = 'billiardum';
export const ENV_FILE = join(ROOT, '.env');
export const ENV_EXAMPLE = join(ROOT, '.env.example');
export const DEVICES_FILE = join(ROOT, 'deploy', 'dev', 'devices.json');
export const POSTGRES_IMAGE = 'supabase/postgres:15.8.1.085';
/** Наши роли в supautils.reserved_roles; выполняется внутри контейнера базы. */
export const RESERVED_ROLES_SCRIPT = join(ROOT, 'deploy', 'postgres', 'reserved-roles.sh');
/**
 * Токен моста ККТ тестового клуба (пишет регистрация моста в npm run dev, права 0600, вне git).
 * Настройки моста без секретов — deploy/dev/kkt-bridge.json (в контейнере) и
 * kkt-bridge.host.json (мост с хоста через Caddy); оба ссылаются на этот файл (token_file).
 */
export const KKT_TOKEN_FILE = join(ROOT, 'deploy', 'dev', 'kkt-bridge.token');

/**
 * Необязательные сервисы Compose: каждый в своём профиле и стартует, только когда есть
 * все его файлы (пакеты пишут соседи параллельно). `needs` — пути от корня репозитория.
 */
export const OPTIONAL_SERVICES = [
  {
    service: 'yookassa-emu',
    needs: ['tools/yookassa-emu/index.mjs'],
    owner: 'backend-money',
    without: 'эмулятор ЮKassa не запускаю, /pay/ ответит 502',
  },
  {
    service: 'kkt-emu',
    needs: ['tools/kkt-bridge/emu/index.mjs'],
    owner: 'backend-kkt',
    without: 'эмулятор ККТ АТОЛ не запускаю',
  },
  {
    service: 'kkt-bridge',
    needs: ['tools/kkt-bridge/index.mjs', 'deploy/dev/kkt-bridge.token'],
    owner: 'backend-kkt',
    without: 'мост ККТ не запускаю, чеки ККТ останутся receipt_pending',
  },
];
/** Профиль сервиса совпадает с его именем. */
export const ALL_PROFILE_ARGS = OPTIONAL_SERVICES.flatMap((s) => ['--profile', s.service]);

/** Чего не хватает необязательному сервису (пути от корня); пусто — можно запускать. */
export function missingFiles(svc, root = ROOT) {
  return svc.needs.filter((p) => !existsSync(join(root, p)));
}

/** Ошибка, понятная человеку: печатается без стека. */
export class UserError extends Error {}

export function fail(message) {
  throw new UserError(message);
}

export function makeLogger(tag) {
  return (message) => console.log(`[${tag}] ${message}`);
}

export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

/** Запускает main(), печатает UserError без стека и выходит с кодом 1. */
export function runMain(tag, main) {
  main().then(
    (code) => process.exit(typeof code === 'number' ? code : 0),
    (err) => {
      if (err instanceof UserError) console.error(`[${tag}] Ошибка: ${err.message}`);
      else console.error(err);
      process.exit(1);
    },
  );
}

/** Запуск с выводом в терминал; stdinFile — файл на вход процессу. Возвращает код выхода. */
export function run(cmd, args, { env, cwd = ROOT, shell = false, stdinFile } = {}) {
  return new Promise((resolvePromise, reject) => {
    const input = stdinFile ? openSync(stdinFile, 'r') : 'inherit';
    const done = () => typeof input === 'number' && closeSync(input);
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: [input, 'inherit', 'inherit'], shell });
    child.once('error', (err) => {
      done();
      reject(err);
    });
    child.once('exit', (code, signal) => {
      done();
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

export async function runChecked(cmd, args, opts, what) {
  const code = await run(cmd, args, opts);
  if (code !== 0) fail(`${what ?? [cmd, ...args].join(' ')}: код выхода ${code}`);
}

/** Запуск с перехватом вывода. */
export function capture(cmd, args, { env, cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: env ?? process.env, encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/**
 * Команда npm для дочернего процесса. Внутри `npm run` берём тот же npm-cli.js
 * (работает и на Windows без shell); иначе — `npm` из PATH.
 */
export function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /\.(c?js)$/.test(cli)) return { cmd: process.execPath, args: [cli, ...args], shell: false };
  return { cmd: 'npm', args, shell: process.platform === 'win32' };
}

export async function runNpm(args, opts = {}) {
  const c = npm(args);
  return runChecked(c.cmd, c.args, { ...opts, shell: c.shell }, `npm ${args.join(' ')}`);
}

/** Проверяет Docker и Compose v2. */
export function checkDocker() {
  const v = capture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (v.error?.code === 'ENOENT') {
    fail('Docker не найден. Установите Docker Desktop (macOS, Windows) или Docker Engine с плагином Compose (Linux).');
  }
  if (v.code !== 0) {
    const detail = (v.stderr || v.stdout).trim().split('\n').at(-1);
    fail(`Docker установлен, но демон не отвечает. Запустите Docker Desktop или службу docker.\n  ${detail}`);
  }
  // start_interval в healthcheck появился в Docker Engine 25.
  const engineMajor = Number(v.stdout.trim().split('.')[0]);
  if (Number.isFinite(engineMajor) && engineMajor > 0 && engineMajor < 25) {
    fail(`Нужен Docker Engine 25 или новее, сейчас ${v.stdout.trim()}. Обновите Docker.`);
  }
  const c = capture('docker', ['compose', 'version', '--short']);
  const [major, minor] = c.stdout.trim().replace(/^v/, '').split('.').map(Number);
  if (c.code !== 0 || !(major > 2 || (major === 2 && minor >= 20))) {
    fail('Нужен Docker Compose v2.20 или новее (команда `docker compose`). Обновите Docker.');
  }
}

export function composeArgs(envFile, ...rest) {
  return ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE, '--env-file', envFile, ...rest];
}

export function readEnvFile(path) {
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Значения .env для дочерних процессов; переменные окружения оболочки главнее, как в Compose. */
export function envWithFile(path) {
  return { ...readEnvFile(path), ...process.env };
}

/** Тома Docker нашего проекта Compose. */
export function projectVolumes() {
  const r = capture('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`]);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** Скрипт npm в пакете: есть ли package.json и сам скрипт. */
export function packageScript(pkgDir, script) {
  const file = join(ROOT, pkgDir, 'package.json');
  if (!existsSync(file)) return { ok: false, reason: `нет ${pkgDir}/package.json` };
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  if (!pkg.scripts?.[script]) return { ok: false, reason: `в ${pkgDir}/package.json нет скрипта "${script}"` };
  return { ok: true };
}

/**
 * Зависимости на хосте не совпадают с package-lock.json: не хватает пакета
 * или ссылки на workspace. Необязательные пакеты (под другую ОС) не учитываются.
 * Ещё — workspace, чей package.json появился после package-lock.json (пакет пишет сосед):
 * его нет в package-lock.json, и `npm ci` в CI отказался бы; `npm install` допишет.
 */
export function missingDependencies(root = ROOT) {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(join(root, 'node_modules'))) return ['node_modules'];
  if (!existsSync(lockFile)) return [];
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  const packages = lock.packages ?? {};
  const workspaces = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  const newWorkspaces = workspaces.filter((dir) => existsSync(join(root, dir, 'package.json')) && !(dir in packages));
  const missing = Object.entries(packages)
    .filter(([path, meta]) => path.startsWith('node_modules/') && !meta.optional)
    .map(([path]) => path)
    .filter((path) => !existsSync(join(root, path)));
  return [...missing, ...newWorkspaces];
}
