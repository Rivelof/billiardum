// `npm run down`: останавливает окружение разработки.
// `npm run down -- --volumes`: ещё и стирает данные — тома базы, брокера, NVS
// симулятора и Caddy, deploy/dev/devices.json и deploy/dev/kkt-bridge.token (их секреты
// без томов брокера и базы недействительны).
// .env и сертификаты остаются.

import { existsSync, unlinkSync } from 'node:fs';

import {
  ALL_PROFILE_ARGS,
  checkDocker,
  composeArgs,
  DEVICES_FILE,
  ENV_EXAMPLE,
  ENV_FILE,
  isMain,
  KKT_TOKEN_FILE,
  makeLogger,
  runChecked,
  runMain,
} from './dev-lib.mjs';

const log = makeLogger('down');

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !['--volumes', '-v'].includes(a));
  if (unknown.length > 0) {
    console.error(`[down] Неизвестные параметры: ${unknown.join(' ')}. Есть только --volumes.`);
    return 2;
  }
  const volumes = args.length > 0;
  checkDocker();
  // Без .env Compose ругался бы на незаданные переменные; для остановки они не нужны.
  const envFile = existsSync(ENV_FILE) ? ENV_FILE : ENV_EXAMPLE;
  // Профили необязательных сервисов включены все: иначе Compose не остановит их контейнеры.
  const downArgs = [...ALL_PROFILE_ARGS, 'down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])];
  await runChecked('docker', composeArgs(envFile, ...downArgs), {}, 'docker compose down');
  if (volumes) {
    for (const file of [DEVICES_FILE, KKT_TOKEN_FILE]) if (existsSync(file)) unlinkSync(file);
    log('окружение остановлено, данные стёрты (тома, deploy/dev/devices.json и kkt-bridge.token). .env, сертификаты и web/*/dist на месте.');
  } else {
    log('окружение остановлено, данные сохранены. Стереть: npm run down -- --volumes');
  }
  return 0;
}

if (isMain(import.meta.url)) runMain('down', main);
