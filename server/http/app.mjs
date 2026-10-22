// Сборка сервера (контракт M1 §2.1): общий контекст, модули core → light → money,
// роутер api/routes/*.mjs, HTTP-обработчик. server/index.mjs и интеграционные тесты
// собирают сервер через createApp.

import { createRouter, loadRoutes } from '../../api/router.mjs';
import { alarms } from '../alarms/index.mjs';
import { createNotifier } from '../notify/index.mjs';
import { outbox as defaultOutbox } from '../outbox.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { withContext } from '../lib/store.mjs';
import { createTelegramBot } from '../lib/telegram-bot.mjs';
import { hub as defaultHub } from './sse.mjs';
import { createHttpHandler } from './server.mjs';
import { createRateLimiter } from './rate-limit.mjs';

/** Модули по порядку подъёма (контракт §2.1): light, затем money. */
export const MODULES = [
  { name: 'light', spec: '../sessions/index.mjs' },
  { name: 'money', spec: '../payments/index.mjs' },
];

/** Импорт модуля соседа; нет файла — null (сервер работает без него), ошибка внутри — бросается. */
export async function importOptional(spec, base = import.meta.url) {
  const url = new URL(spec, base);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) return null;
    throw err;
  }
}

/**
 * @param {{ config: object, log: any, pool: import('pg').Pool, clock?: { now(): Date },
 *           modules?: { name: string, spec?: string, module?: object }[], fallbackBridge?: (ctx) => Promise<object>,
 *           outbox?: object, sse?: object, telegram?: object, routes?: object[], listen?: boolean }} options
 */
export async function createApp({
  config,
  log,
  pool,
  clock = { now: () => new Date() },
  modules = MODULES,
  fallbackBridge = null,
  outbox = defaultOutbox,
  sse = defaultHub,
  telegram = null,
  routes = null,
  listen = true,
}) {
  const bot =
    telegram ??
    createTelegramBot({
      token: config.telegram?.botToken ?? null,
      proxyUrl: config.telegram?.proxyUrl ?? null,
    });
  const notify = createNotifier({ config, log, telegram: bot, clock });
  const ctx = {
    config,
    log,
    pool,
    clock,
    outbox,
    alarms,
    notify,
    sse,
    audit: { appendAudit },
    telegram: bot,
    bridge: null,
    withContext,
    modules: {},
  };

  // core: доставка уведомлений через outbox.
  notify.register(outbox);

  const started = [];
  for (const m of modules) {
    const mod = m.module ?? (await importOptional(m.spec));
    if (!mod) {
      log.warn('module_missing', { module: m.name });
      continue;
    }
    if (typeof mod.init !== 'function') throw new Error(`модуль ${m.name}: нет init(ctx)`);
    await mod.init(ctx);
    ctx.modules[m.name] = mod;
    started.push({ name: m.name, mod });
    log.info('module_started', { module: m.name });
  }
  // Модуля light нет — мост MQTT как в M0, чтобы рабочий стек не сломался.
  if (!ctx.bridge && fallbackBridge) ctx.bridge = await fallbackBridge(ctx);

  const router = createRouter(ctx, {
    routes: routes ?? (await loadRoutes({ config })),
    rateLimiter: createRateLimiter(),
  });
  const handler = createHttpHandler({
    router,
    checkDb: () => pool.query('select 1').then(() => undefined),
    mqttConnected: () => Boolean(ctx.bridge?.isConnected?.()),
    log,
  });

  await outbox.start({ pool, log, alarms, listen });

  // Уборка раз в час (контекст платформы): просроченные nonce входа через бота и ключи
  // идемпотентности. Токены не удаляются: отозванный или истёкший токен не действует сам.
  async function janitor() {
    try {
      await withContext(pool, { clubId: null, actorType: 'system' }, async (db) => {
        const n = await db.query("delete from bl.bot_link_nonces where expires_at < $1::timestamptz - interval '1 day'", [clock.now()]);
        const k = await db.query('delete from bl.idempotency_keys where expires_at < $1', [clock.now()]);
        if (n.rowCount || k.rowCount) log.info('janitor', { bot_link_nonces: n.rowCount, idempotency_keys: k.rowCount });
      });
    } catch (err) {
      log.warn('janitor_failed', { error: err.code ?? err.message });
    }
  }
  const janitorTimer = setInterval(janitor, 3600_000);
  janitorTimer.unref();

  return {
    ctx,
    router,
    handler,
    janitor,
    async stop() {
      clearInterval(janitorTimer);
      sse.closeAll();
      for (const { name, mod } of [...started].reverse()) {
        try {
          await mod.stop?.();
        } catch (err) {
          log.error('module_stop_failed', { module: name, error: err.message });
        }
      }
      if (ctx.bridge?.fallback) await ctx.bridge.stopFallback();
      await outbox.stop();
    },
  };
}
