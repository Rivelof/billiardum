#!/usr/bin/env node
// Заводской реестр контроллеров (M5.1 №159, backend-B).
//
//   node scripts/provision-factory.mjs --count 24 [--batch B-2026-10] [--out stickers.pdf]
//                                      [--commands-out factory.txt] [--dry-run]
//
// 1. Генерирует device_id (UUID v4) и код привязки (16 символов Crockford Base32, XXXX-XXXX-XXXX-XXXX).
// 2. Пишет в bl.device_factory только hex(sha256(device_id:код)) — тот же хеш, что у окна привязки (№67).
//    Подключение — DATABASE_ADMIN_URL (окружение или .env): у app_api прав на реестр нет.
//    --dry-run — без записи в базу (проверить наклейки на принтере).
// 3. Печатает PDF наклеек на корпус (по умолчанию factory-<партия>.pdf): QR «BLD1:{device_id}:{код}»,
//    короткий номер и код для ручного ввода.
// 4. Выводит команды служебной консоли прошивки «factory <device_id> <код>» — по одной на контроллер
//    (USB, один раз на производстве). --commands-out — в файл с правами 0600 вместо stdout.
//
// Коды привязки в открытом виде есть только в PDF и командах: файлы — на машине производства,
// в репозиторий и чат не попадают. Повторный запуск создаёт новые устройства, старые не трогает.

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatDeviceQr, generateClaimCode } from '../server/devices/qr.mjs';
import { deviceStickersPdf } from '../server/qr/device-stickers.mjs';
import { claimCodeHash } from '../server/sessions/service.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MAX_COUNT = 1000;
const BATCH = /^[A-Za-z0-9._-]{1,64}$/;

/** Аргументы командной строки. */
export function parseArgs(argv) {
  const out = { count: 1, batch: null, out: null, commandsOut: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a}: нужно значение`);
      i += 1;
      return v;
    };
    if (a === '--count') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUNT) throw new Error(`--count — целое от 1 до ${MAX_COUNT}`);
      out.count = n;
    } else if (a === '--batch') {
      const b = value();
      if (!BATCH.test(b)) throw new Error('--batch — латиница, цифры, «.», «_», «-», до 64 символов');
      out.batch = b;
    } else if (a === '--out') out.out = value();
    else if (a === '--commands-out') out.commandsOut = value();
    else if (a === '--dry-run') out.dryRun = true;
    else throw new Error(`неизвестный параметр ${a}`);
  }
  return out;
}

/** n новых устройств: { device_id, claim_code, claim_code_hash, qr }. */
export function generateDevices(n) {
  return Array.from({ length: n }, () => {
    const deviceId = randomUUID();
    const code = generateClaimCode();
    return { device_id: deviceId, claim_code: code, claim_code_hash: claimCodeHash(deviceId, code), qr: formatDeviceQr(deviceId, code) };
  });
}

/** Команды консоли прошивки (firmware/src/main.cpp: factory <device_id> <claim_code>). */
export function factoryCommands(devices) {
  return devices.map((d) => `factory ${d.device_id} ${d.claim_code}`);
}

/** Запись реестра одной транзакцией: только хеши. */
export async function insertFactory(client, devices, batch) {
  await client.query('begin');
  try {
    for (const d of devices) {
      await client.query('insert into bl.device_factory (device_id, claim_code_hash, batch) values ($1, $2, $3)', [d.device_id, d.claim_code_hash, batch]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  }
}

function adminUrl() {
  if (!process.env.DATABASE_ADMIN_URL) {
    const envFile = join(ROOT, '.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
  }
  if (!process.env.DATABASE_ADMIN_URL) throw new Error('нет DATABASE_ADMIN_URL ни в окружении, ни в .env');
  return process.env.DATABASE_ADMIN_URL;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const batch = args.batch ?? `B-${new Date().toISOString().slice(0, 10)}`;
  const devices = generateDevices(args.count);
  if (!args.dryRun) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: adminUrl(), application_name: 'bl-provision-factory' });
    await client.connect();
    try {
      await insertFactory(client, devices, batch);
    } finally {
      await client.end();
    }
  }
  const pdfPath = resolve(args.out ?? `factory-${batch}.pdf`);
  writeFileSync(pdfPath, deviceStickersPdf({ devices, batch }), { mode: 0o600 });
  chmodSync(pdfPath, 0o600);
  const commands = `${factoryCommands(devices).join('\n')}\n`;
  if (args.commandsOut) {
    const p = resolve(args.commandsOut);
    writeFileSync(p, commands, { mode: 0o600 });
    chmodSync(p, 0o600);
    process.stderr.write(`команды консоли: ${p}\n`);
  } else {
    process.stdout.write(commands);
  }
  process.stderr.write(
    `${args.dryRun ? 'без записи в базу (--dry-run), ' : 'записано в bl.device_factory, '}партия ${batch}, устройств ${devices.length}; наклейки: ${pdfPath}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`provision-factory: ${err.message}\n`);
    process.exit(1);
  });
}
