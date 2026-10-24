// Модуль подписки клубов (M5.3, №180–186): init(ctx) и stop().
//
// * Подписка outbox club.went_live — подписка с пробным периодом создаётся сразу при переходе
//   клуба в боевой режим (на всякий случай её создают и планировщик, и GET подписки).
// * Планировщик раз в минуту (время — ctx.clock): счета, автосписания, повторы, напоминания,
//   уведомление Андрею, сверка платежей без вебхука — scheduler.mjs.
// * Без PLATFORM_YOOKASSA_SHOP_ID / PLATFORM_YOOKASSA_SECRET планировщик не работает, API и вебхук
//   отвечают 503 billing_unavailable.
// Подмена в тестах: ctx.billing = { config, tickMs }.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { billingConfig } from './config.mjs';
import { tick as runTick, TICK_MS } from './scheduler.mjs';

export const WENT_LIVE_TOPIC = 'club.went_live';
let state = null;

function depsOf(ctx) {
  return {
    clock: ctx.clock ?? { now: () => new Date() },
    log: ctx.log ?? { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** Один проход планировщика (тесты). */
export async function tick(ctx, options = {}) {
  return runTick({
    pool: ctx.pool,
    withContext: ctx.withContext ?? storeWithContext,
    deps: depsOf(ctx),
    config: billingConfig(ctx),
    ...options,
  });
}

/** @param {object} ctx общий контекст сервера */
export async function init(ctx) {
  if (state) return;
  const deps = depsOf(ctx);
  const config = billingConfig(ctx);
  ctx.outbox?.subscribe?.(
    WENT_LIVE_TOPIC,
    async (payload, { db } = {}) => {
      if (db && typeof payload?.club_id === 'string') await db.query('select bl.billing_ensure_subscription($1)', [payload.club_id]);
    },
    { name: 'billing.trial' },
  );
  if (!config.configured) deps.log.warn('billing_unavailable', { hint: 'PLATFORM_YOOKASSA_SHOP_ID и PLATFORM_YOOKASSA_SECRET не заданы' });
  let running = null;
  const timer = setInterval(() => {
    if (running || !ctx.pool || !config.configured) return;
    running = tick(ctx)
      .catch((err) => deps.log.error('billing_tick_error', { error: err.message }))
      .finally(() => {
        running = null;
      });
  }, ctx.billing?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, running: () => running };
  deps.log.info('billing_started', { configured: config.configured });
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  await state.running();
  state = null;
}
