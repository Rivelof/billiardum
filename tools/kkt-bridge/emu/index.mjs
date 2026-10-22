#!/usr/bin/env node
// Эмулятор веб-сервера драйвера АТОЛ (только разработка и тесты). Настройки — переменные
// окружения, см. tools/kkt-bridge/README.md. При NODE_ENV=production не запускается.

import { createAtolEmulator, DEFAULT_PORT, randomFn } from './emulator.mjs';

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`);
}

if (process.env.NODE_ENV === 'production') {
  log('error', 'atol_emu_refused', { reason: 'NODE_ENV=production' });
  process.exit(1);
}

const env = process.env;
const port = Number(env.ATOL_EMU_PORT || DEFAULT_PORT);
const host = env.ATOL_EMU_HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  log('error', 'atol_emu_config_error', { error: 'ATOL_EMU_PORT — целое от 1 до 65535' });
  process.exit(1);
}

const fnNumber = env.ATOL_EMU_FN || randomFn();
if (!/^\d{16}$/.test(fnNumber)) {
  log('error', 'atol_emu_config_error', { error: 'ATOL_EMU_FN — 16 цифр' });
  process.exit(1);
}
const emu = createAtolEmulator({
  fnNumber,
  controlToken: env.ATOL_EMU_CONTROL_TOKEN || null,
  autoOpenShift: env.ATOL_EMU_AUTO_OPEN_SHIFT !== '0',
  log: { info: (msg, f) => log('info', msg, f), warn: (msg, f) => log('warn', msg, f) },
});
const addr = await emu.listen(port, host);
log('info', 'atol_emu_started', { host: addr.address, port: addr.port, fn: fnNumber, control_token: Boolean(env.ATOL_EMU_CONTROL_TOKEN) });

async function shutdown(signal) {
  log('info', 'atol_emu_stopping', { signal });
  await emu.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
