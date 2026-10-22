#!/usr/bin/env node
// Регистрация вебхука Telegram-бота: setWebhook на https://{PUBLIC_HOST}/api/bots/telegram/webhook
// с secret_token = TELEGRAM_WEBHOOK_SECRET (сервер сверяет X-Telegram-Bot-Api-Secret-Token),
// только апдейты message. Запросы — через TELEGRAM_PROXY_URL (api.telegram.org с сервера закрыт).
// Токен и секрет не печатаются. Запуск: node server/bin/telegram-webhook.mjs [--delete]

import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../lib/config.mjs';
import { createLogger } from '../lib/log.mjs';
import { createTelegramBot } from '../lib/telegram-bot.mjs';

const log = createLogger({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  const envFile = path.join(REPO_ROOT, '.env');
  if (!process.env.TELEGRAM_BOT_TOKEN && existsSync(envFile)) process.loadEnvFile(envFile);
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_PROXY_URL: proxyUrl, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
  const host = process.env.PUBLIC_HOST || 'localhost:8443';
  if (!token || !proxyUrl || !secret) throw new Error('нужны TELEGRAM_BOT_TOKEN, TELEGRAM_PROXY_URL и TELEGRAM_WEBHOOK_SECRET');
  const bot = createTelegramBot({ token, proxyUrl });
  if (process.argv.includes('--delete')) {
    await bot.call('deleteWebhook', { drop_pending_updates: false });
    log.info('telegram_webhook_deleted', {});
    return;
  }
  const url = `https://${host}/api/bots/telegram/webhook`;
  await bot.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], max_connections: 20 });
  const info = await bot.call('getWebhookInfo', {});
  log.info('telegram_webhook_set', { url: info.url, pending: info.pending_update_count, last_error: info.last_error_message ?? null });
}

main().catch((err) => {
  log.error('telegram_webhook_failed', { error: err.code ?? err.message });
  process.exitCode = 1;
});
