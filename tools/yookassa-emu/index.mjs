#!/usr/bin/env node
// Эмулятор ЮKassa API v3 (только разработка и тесты). Настройки — переменные окружения,
// см. README.md. При NODE_ENV=production не запускается.

import { createEmulator } from './lib/emulator.mjs';

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

if (process.env.NODE_ENV === 'production') {
  log('error', 'emu_refused', { reason: 'NODE_ENV=production' });
  process.exit(1);
}

const env = process.env;
const port = Number(env.YOOKASSA_EMU_PORT || 8090);
const host = env.YOOKASSA_EMU_HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log('error', 'emu_config_error', { error: 'YOOKASSA_EMU_PORT — целое от 1 до 65535' });
  process.exit(1);
}

const shops = [];
if (env.YOOKASSA_EMU_SHOP_ID && env.YOOKASSA_EMU_SECRET) {
  // M5.1 №154: YOOKASSA_EMU_SHOP_TEST=0 — магазин боевой (GET /v3/me test: false), YOOKASSA_EMU_SHOP_FISCALIZATION=0 — без чеков.
  shops.push({
    shopId: env.YOOKASSA_EMU_SHOP_ID,
    secret: env.YOOKASSA_EMU_SECRET,
    test: env.YOOKASSA_EMU_SHOP_TEST !== '0',
    fiscalization: env.YOOKASSA_EMU_SHOP_FISCALIZATION !== '0',
  });
} else {
  log('warn', 'emu_no_shop', { hint: 'YOOKASSA_EMU_SHOP_ID и YOOKASSA_EMU_SECRET не заданы: магазины — через POST /__emu/shops' });
}
// M5.3: магазин платформы (подписка клубов) — свой адрес вебхука, без {club_id}.
if (env.YOOKASSA_EMU_PLATFORM_SHOP_ID && env.YOOKASSA_EMU_PLATFORM_SECRET) {
  shops.push({
    shopId: env.YOOKASSA_EMU_PLATFORM_SHOP_ID,
    secret: env.YOOKASSA_EMU_PLATFORM_SECRET,
    webhookUrl: env.YOOKASSA_EMU_PLATFORM_WEBHOOK_URL || null,
    test: true,
    fiscalization: true,
  });
}

const emu = createEmulator({
  shops,
  webhookUrl: env.YOOKASSA_EMU_WEBHOOK_URL || null,
  publicUrl: env.YOOKASSA_EMU_PUBLIC_URL || `http://localhost:${port}`,
  webhookDelayMs: Number(env.YOOKASSA_EMU_WEBHOOK_DELAY_MS || 0),
  webhookRetries: Number(env.YOOKASSA_EMU_WEBHOOK_RETRIES || 3),
  webhookRetryDelayMs: Number(env.YOOKASSA_EMU_WEBHOOK_RETRY_DELAY_MS || 1000),
  controlToken: env.YOOKASSA_EMU_CONTROL_TOKEN || null,
  log: { info: (msg, f) => log('info', msg, f), warn: (msg, f) => log('warn', msg, f) },
});

const addr = await emu.listen(port, host);
log('info', 'emu_started', { host: addr.address, port: addr.port, shops: shops.length, webhook: Boolean(env.YOOKASSA_EMU_WEBHOOK_URL) });

async function shutdown(signal) {
  log('info', 'emu_stopping', { signal });
  await emu.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
