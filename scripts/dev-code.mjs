// Свежесть кода в контейнерах окружения разработки (дефект Д2 приёмки M3).
//
// Сервисы Node работают из смонтированного /repo, но процесс держит код, загруженный при
// старте. npm run dev сравнивает отпечаток кода каждого сервиса (sha256 содержимого его
// файлов, scripts/dev-code.mjs → codeFingerprint) с тем, с которым запущен контейнер, и
// перезапускает только отставшие. Отпечатки запущенных контейнеров — в STATE_FILE
// (вне git), по id контейнера и времени его старта.
//
// Контейнер, о котором записи нет или который с тех пор перезапускался не через npm run dev
// (Docker после перезагрузки, `docker compose restart`), сверяется по времени: файл
// сервиса новее старта контейнера — перезапуск. Mosquitto и db здесь не участвуют никогда
// (CLAUDE.md: брокер не перезапускать в часы работы клубов).
//
// Только встроенные модули Node.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { capture, COMPOSE_PROJECT, ROOT } from './dev-lib.mjs';

export const STATE_FILE = join(ROOT, 'deploy', 'dev', 'code-state.json');

/** Общие для сервисов Node входы: зависимости из node_modules хоста. */
const DEPS = ['package-lock.json'];

/**
 * Что читает процесс каждого сервиса при старте (пути от корня). Папки — все файлы, кроме
 * игнорируемых git, тестов и *.md; файлы — как есть, даже вне git (.env, сертификаты,
 * ключи от provision:dev). Изменения compose.yml и переменных Compose ловит сам Compose
 * (`up` пересоздаёт контейнер); .env у server — ещё и чтобы заново прошёл provision:dev
 * (пароли брокера).
 */
export const SERVICE_CODE = {
  server: ['server', 'api', 'shared', 'supabase', '.env', 'deploy/dev/certs/ca.crt', ...DEPS],
  'device-sim': ['tools/device-sim', 'deploy/dev/devices.json', 'deploy/dev/certs/ca.crt', ...DEPS],
  'yookassa-emu': ['tools/yookassa-emu', 'scripts/dev-yookassa-emu.mjs', ...DEPS],
  'kkt-emu': ['tools/kkt-bridge/emu', 'tools/kkt-bridge/lib', ...DEPS],
  'kkt-bridge': ['tools/kkt-bridge', 'deploy/dev/kkt-bridge.json', 'deploy/dev/kkt-bridge.token', ...DEPS],
  // Сайт: свой код и shared. Сборку островов (dist/manifest.json) с BL_SITE_DEV=1 и статьи
  // content/zhurnal/*.md сайт перечитывает сам, перезапуск для них не нужен.
  site: ['web/site', 'shared', ...DEPS],
  // Не Node, но конфиг читает только при старте.
  caddy: ['deploy/dev/Caddyfile'],
};

/** Сервисы, которые перезапускает `npm run dev -- --restart`. */
export const NODE_SERVICES = ['server', 'device-sim', 'yookassa-emu', 'kkt-emu', 'kkt-bridge', 'site'];

/** Запас на расхождение часов хоста и Docker (Docker Desktop — в своей ВМ). */
export const CLOCK_SKEW_MS = 5000;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', '.pio', 'test', 'tests']);
const skipFile = (rel) => {
  const parts = rel.split('/');
  return parts.slice(0, -1).some((p) => SKIP_DIRS.has(p)) || /\.test\.[cm]?js$/.test(rel) || /\.md$/i.test(rel);
};

/** Файлы папок через git (отслеживаемые и новые, без игнорируемых); null — не репозиторий git. */
function gitFiles(root, dirs) {
  if (dirs.length === 0) return [];
  const r = capture('git', ['-C', root, 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...dirs]);
  if (r.code !== 0 || r.error) return null;
  return [...new Set(r.stdout.split('\0').filter(Boolean))];
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, rel, out);
    } else if (e.isFile()) out.push(rel);
  }
}

/**
 * Отпечаток кода: sha256 по путям и содержимому файлов; newest — самое позднее mtime
 * среди файлов и их папок (удалённый файл меняет mtime папки). Без git — обход папок.
 * @returns {{ hash: string, newest: number, files: number }}
 */
export function codeFingerprint(paths, root = ROOT) {
  const dirs = [];
  const files = [];
  for (const p of paths) {
    let st;
    try {
      st = statSync(join(root, p));
    } catch {
      continue;
    }
    if (st.isDirectory()) dirs.push(p);
    else files.push(p);
  }
  let listed = gitFiles(root, dirs);
  if (listed === null) {
    listed = [];
    for (const d of dirs) walk(root, d, listed);
  }
  const inDirs = listed.map((f) => f.split(sep).join('/')).filter((f) => !skipFile(f));
  const hash = createHash('sha256');
  let newest = 0;
  let count = 0;
  const seenDirs = new Set();
  for (const rel of [...new Set([...inDirs, ...files])].sort()) {
    let body;
    let st;
    try {
      st = statSync(join(root, rel));
      if (!st.isFile()) continue;
      body = readFileSync(join(root, rel));
    } catch {
      continue; // удалён, но ещё в индексе git
    }
    hash.update(`${rel}\0${createHash('sha256').update(body).digest('hex')}\n`);
    newest = Math.max(newest, st.mtimeMs);
    count += 1;
    if (!files.includes(rel)) {
      for (let d = dirname(rel); d !== '.' && !seenDirs.has(d); d = dirname(d)) seenDirs.add(d);
    }
  }
  for (const d of seenDirs) {
    try {
      newest = Math.max(newest, statSync(join(root, d)).mtimeMs);
    } catch {
      // папку удалили между шагами
    }
  }
  return { hash: hash.digest('hex'), newest, files: count };
}

/** Отпечатки сервисов: { service: { hash, newest, files } }. */
export function fingerprints(services, root = ROOT) {
  return Object.fromEntries(services.map((s) => [s, codeFingerprint(SERVICE_CODE[s] ?? [], root)]));
}

/**
 * Контейнеры проекта Compose по сервисам: { service: { id, running, startedAt } }.
 * Одноразовые (`docker compose run`) не учитываются.
 */
export function inspectContainers(project = COMPOSE_PROJECT) {
  const ids = capture('docker', ['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`]);
  const list = ids.stdout.split('\n').filter(Boolean);
  if (ids.code !== 0 || list.length === 0) return {};
  const fmt = '{{.Id}} {{.State.Running}} {{.State.StartedAt}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.oneoff"}}';
  const r = capture('docker', ['inspect', '--format', fmt, ...list]);
  return parseInspect(r.stdout);
}

export function parseInspect(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const [id, running, startedAt, service, oneoff] = line.trim().split(' ');
    if (!service || oneoff === 'True') continue;
    out[service] = { id, running: running === 'true', startedAt };
  }
  return out;
}

export function readState(file = STATE_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && s.services && typeof s.services === 'object' ? s.services : {};
  } catch {
    return {};
  }
}

export function writeState(services, file = STATE_FILE) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ note: 'npm run dev: код, с которым запущены контейнеры (scripts/dev-code.mjs)', services }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Почему сервис отстал от кода; null — работает на текущем коде. */
export function staleReason(container, record, code, skewMs = CLOCK_SKEW_MS) {
  if (record && record.container === container.id && record.started === container.startedAt) {
    return record.code === code.hash ? null : 'код изменился';
  }
  const started = Date.parse(container.startedAt);
  if (!Number.isFinite(started)) return 'неизвестно время старта';
  return code.newest > started - skewMs ? 'файлы новее старта контейнера' : null;
}

/**
 * План npm run dev для сервисов, которые сейчас можно запускать.
 *
 * - нет контейнера или он остановлен — start (поднимет `up`);
 * - --restart (force) — restart всех сервисов Node;
 * - код отстал — restart;
 * - server стартует или перезапускается, нет devices.json или --restart — заново provision:dev
 *   (новые ключи устройств): тогда перезапускаются и device-sim, и kkt-bridge;
 * - provision:dev или нет токена моста — регистрация моста ККТ (новый токен), если есть её
 *   скрипт (kktRegister): kkt-bridge пересоздаётся (журнал в контейнере — от прежнего моста).
 *
 * @returns {{ actions: Record<string, {action: 'start'|'restart'|'keep', reason?: string}>,
 *   provision: boolean, registerKkt: boolean, recreate: string[] }}
 */
export function planServices({ services, containers, state, codes, force = false, devicesFile = true, kktToken = true, kktRegister = true }) {
  const actions = {};
  for (const s of services) {
    const c = containers[s];
    if (!c) actions[s] = { action: 'start', reason: 'нет контейнера' };
    else if (!c.running) actions[s] = { action: 'start', reason: 'остановлен' };
    else if (force && NODE_SERVICES.includes(s)) actions[s] = { action: 'restart', reason: 'npm run dev -- --restart' };
    else {
      const reason = staleReason(c, state[s], codes[s]);
      actions[s] = reason ? { action: 'restart', reason } : { action: 'keep' };
    }
  }
  const touch = (s, reason) => {
    if (actions[s]?.action === 'keep') actions[s] = { action: 'restart', reason };
  };
  const provision = force || !devicesFile || ['start', 'restart'].includes(actions.server?.action);
  if (provision) for (const s of ['server', 'device-sim']) touch(s, 'новые ключи provision:dev');
  const registerKkt = kktRegister && (provision || !kktToken);
  const recreate = [];
  if (registerKkt) {
    touch('kkt-bridge', 'новый токен моста ККТ');
    if (actions['kkt-bridge'] && containers['kkt-bridge']) recreate.push('kkt-bridge');
  }
  return { actions, provision, registerKkt, recreate };
}

/** Запись состояния после `up`: у пересозданного или перезапущенного — отпечаток перед `up`. */
export function nextState({ services, before, after, planCodes, upCodes }) {
  const out = {};
  for (const s of services) {
    const c = after[s];
    if (!c?.running) continue;
    const same = before[s] && before[s].id === c.id && before[s].startedAt === c.startedAt;
    out[s] = { container: c.id, started: c.startedAt, code: (same && planCodes[s] ? planCodes[s] : upCodes[s]).hash };
  }
  return out;
}
