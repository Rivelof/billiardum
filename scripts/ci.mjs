// `npm run ci`: то же, что .github/workflows/ci.yml, локально (контракт M0 §9).
// lint → test → test:it симулятора (свой брокер в Docker) → чистый Postgres
// (supabase/postgres) в отдельном контейнере на свободном порту → роли в
// supautils.reserved_roles (deploy/postgres/reserved-roles.sh) → db:migrate →
// db:seed → test:db → контейнер удаляется.
// Только синтетические данные сида (decisions №21). .env не читается.
//
//   npm run ci             — всё
//   npm run ci -- --db     — только этап базы (чистый Postgres, migrate, seed, test:db)

import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  capture,
  checkDocker,
  fail,
  isMain,
  makeLogger,
  POSTGRES_IMAGE,
  RESERVED_ROLES_SCRIPT,
  run,
  runChecked,
  runMain,
  runNpm,
} from './dev-lib.mjs';

const log = makeLogger('ci');
const READY_TIMEOUT_MS = 180_000;

let container = null;
let interrupted = false;

function removeContainer() {
  if (!container) return;
  capture('docker', ['rm', '-f', '-v', container]);
  log(`контейнер ${container} удалён`);
  container = null;
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
  container = name;
  log(`Postgres ${POSTGRES_IMAGE}: контейнер ${name}`);

  const started = Date.now();
  for (;;) {
    if (interrupted) fail('прервано');
    const s = capture('docker', ['inspect', '-f', '{{.State.Status}} {{.State.Health.Status}}', name]).stdout.trim();
    if (s === 'running healthy') break;
    if (!s.startsWith('running') || Date.now() - started > READY_TIMEOUT_MS) {
      await run('docker', ['logs', '--tail', '40', name]);
      fail(`Postgres не поднялся (${s || 'нет контейнера'})`);
    }
    await sleep(1000);
  }
  const port = capture('docker', ['port', name, '5432/tcp']).stdout.trim().split('\n')[0].split(':').at(-1);
  if (!/^\d+$/.test(port)) fail('не удалось узнать порт Postgres');
  log(`Postgres готов за ${Math.round((Date.now() - started) / 1000)} с, порт ${port}`);
  await runChecked('docker', ['exec', '-i', '-u', 'postgres', name, 'sh', '-s'], { stdinFile: RESERVED_ROLES_SCRIPT }, 'reserved-roles.sh');
  return { port, password };
}

async function main() {
  process.on('SIGINT', () => {
    interrupted = true;
  });
  process.on('exit', removeContainer);

  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--db')) fail(`неизвестные параметры: ${args.join(' ')}. Есть только --db.`);
  const dbOnly = args.includes('--db');

  checkDocker();
  if (!dbOnly) {
    log('lint');
    await runNpm(['run', 'lint']);
    log('test');
    await runNpm(['test']);
    log('test:it симулятора');
    await runNpm(['run', 'test:it', '-w', 'tools/device-sim']);
  }

  try {
    const { port, password } = await startPostgres();
    const appPassword = randomBytes(24).toString('hex');
    const env = {
      ...process.env,
      DATABASE_ADMIN_URL: `postgres://supabase_admin:${password}@127.0.0.1:${port}/postgres`,
      DB_APP_PASSWORD: appPassword,
      DATABASE_URL: `postgres://app_api:${appPassword}@127.0.0.1:${port}/postgres`,
    };
    for (const script of ['db:migrate', 'db:seed', 'test:db']) {
      log(script);
      await runNpm(['run', script], { env });
    }
  } finally {
    removeContainer();
  }
  log('всё зелёное');
  return 0;
}

if (isMain(import.meta.url)) runMain('ci', main);
