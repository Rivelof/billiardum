// `npm run down`: останавливает окружение разработки.
// `npm run down -- --volumes`: ещё и стирает данные — тома базы, брокера, NVS
// симулятора и Caddy и deploy/dev/devices.json (его секреты без тома брокера
// недействительны).
// .env и сертификаты остаются.

import { existsSync, unlinkSync } from 'node:fs';

import { checkDocker, composeArgs, DEVICES_FILE, EMU_PROFILE, ENV_EXAMPLE, ENV_FILE, isMain, makeLogger, runChecked, runMain } from './dev-lib.mjs';

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
  // Профиль эмулятора включён всегда: иначе Compose не остановит его контейнер.
  const downArgs = ['--profile', EMU_PROFILE, 'down', '--remove-orphans', ...(volumes ? ['--volumes'] : [])];
  await runChecked('docker', composeArgs(envFile, ...downArgs), {}, 'docker compose down');
  if (volumes) {
    if (existsSync(DEVICES_FILE)) unlinkSync(DEVICES_FILE);
    log('окружение остановлено, данные стёрты (тома и deploy/dev/devices.json). .env, сертификаты и web/*/dist на месте.');
  } else {
    log('окружение остановлено, данные сохранены. Стереть: npm run down -- --volumes');
  }
  return 0;
}

if (isMain(import.meta.url)) runMain('down', main);
