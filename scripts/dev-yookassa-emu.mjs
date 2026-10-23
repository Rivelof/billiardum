// Эмулятор ЮKassa в Docker Compose разработки (deploy/dev/compose.yml, сервис yookassa-emu).
//
// Запускает tools/yookassa-emu/index.mjs (зона backend, настройки — его переменные
// YOOKASSA_EMU_*) и сразу заводит в нём магазины для подключения нового клуба (M5.1 №154,
// сценарии T26–T28) через POST /__emu/shops. Эмулятор держит магазины в памяти, поэтому
// они заводятся в том же процессе: перезапуск контейнера заводит их снова. Не удалось —
// процесс выходит с ошибкой, Docker перезапускает контейнер.
//
// Магазин из .env (YOOKASSA_EMU_SHOP_ID и YOOKASSA_EMU_SECRET, флаги YOOKASSA_EMU_SHOP_TEST и
// YOOKASSA_EMU_SHOP_FISCALIZATION) остаётся как был: его provision:dev кладёт клубу сида.
//
// Значения ниже — учётные данные эмулятора, не секреты: эмулятор не запускается при
// NODE_ENV=production, его API доступен только внутри сети Compose (наружу через Caddy —
// только страница /pay/), а сервер в проде ходит только в https://api.yookassa.ru/v3.
// Список — в README, раздел «Подключение нового клуба (M5.1)».
//
//   node scripts/dev-yookassa-emu.mjs   — команда сервиса yookassa-emu
//
// Healthcheck сервиса прежний (порт принимает соединения): магазины заводятся за
// миллисекунды после открытия порта, а проверка через /v3/me сама попала бы в журнал
// /__emu/requests и съедала бы сбои fail_next, заказанные тестами.
//
// Только встроенные модули Node: работает в контейнере без установки пакетов.

import { pathToFileURL } from 'node:url';

/** Магазины эмулятора для нового клуба. shop_id вне диапазона магазина из .env (900000–999999). */
export const DEV_EMU_SHOPS = [
  { shop_id: '800001', secret: 'test_emu_800001_dev_only', test: true, fiscalization_enabled: true, use: 'тестовый магазин клуба' },
  { shop_id: '800002', secret: 'live_emu_800002_dev_only', test: false, fiscalization_enabled: true, use: 'боевой магазин клуба, чеки включены' },
  { shop_id: '800003', secret: 'live_emu_800003_dev_only', test: false, fiscalization_enabled: false, use: 'боевой без чеков: отказ fiscalization_off (T28)' },
];

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

/** Адрес эмулятора изнутри контейнера: тот же порт, что у index.mjs. */
export function emulatorBase(env = process.env) {
  const port = Number(env.YOOKASSA_EMU_PORT || 8090);
  const host = env.YOOKASSA_EMU_HOST;
  const local = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${port}`;
}

/** Магазины, которые надо завести: без совпадения с магазином из .env (его не подменяем). */
export function shopsToRegister(env = process.env, shops = DEV_EMU_SHOPS) {
  return shops.filter((s) => s.shop_id !== env.YOOKASSA_EMU_SHOP_ID);
}

async function registerShops(env) {
  const base = emulatorBase(env);
  const shops = shopsToRegister(env);
  if (shops.length < DEV_EMU_SHOPS.length) log('warn', 'emu_dev_shop_skipped', { reason: 'YOOKASSA_EMU_SHOP_ID совпадает с магазином для нового клуба' });
  const headers = { 'content-type': 'application/json' };
  if (env.YOOKASSA_EMU_CONTROL_TOKEN) headers['x-emu-token'] = env.YOOKASSA_EMU_CONTROL_TOKEN;
  for (const s of shops) {
    const body = JSON.stringify({ shop_id: s.shop_id, secret: s.secret, test: s.test, fiscalization_enabled: s.fiscalization_enabled });
    const res = await fetch(`${base}/__emu/shops`, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`POST /__emu/shops ${s.shop_id}: HTTP ${res.status}`);
  }
  log('info', 'emu_dev_shops', { shops: shops.map((s) => ({ shop_id: s.shop_id, test: s.test, fiscalization_enabled: s.fiscalization_enabled })) });
}

async function main() {
  const env = process.env;
  // index.mjs слушает порт к концу импорта (await listen); при NODE_ENV=production он сам выходит.
  await import(new URL('../tools/yookassa-emu/index.mjs', import.meta.url).href);
  try {
    await registerShops(env);
  } catch (err) {
    log('error', 'emu_dev_shops_failed', { error: err.message });
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
