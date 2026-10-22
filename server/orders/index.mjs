// Модуль заказов бара и кассы (backend-pos, контракт M2 §4, §5): init(ctx) и stop().
//
// * Подписки outbox payment.confirmed (pos.settle) и payment.canceled (pos.cancel): платёж бара
//   (kind bar) завершает свою продажу — заказ со стола уходит на экран бара, счёт стола
//   закрывается, чек и склад — или отменяет её (заказы, ждавшие оплаты, отменены).
// * Планировщик раз в 10 с — подстраховка: продажи в pending, у которых платёж уже в конечном
//   статусе (bl.pos_due), завершаются или отменяются.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { resolveDeps } from './deps.mjs';
import { onPaymentConfirmed, settleSale } from './pos.mjs';

const TICK_MS = 10_000;
let state = null;

/** Один проход планировщика (экспортирован для тестов). */
export async function tick({ pool, withContext = storeWithContext, deps, limit = 100 }) {
  const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
    db.query('select club_id, sale_id from bl.pos_due($1)', [limit]),
  );
  let done = 0;
  for (const row of due.rows) {
    try {
      const r = await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) => settleSale(db, deps, row.sale_id));
      if (r.result === 'completed' || r.result === 'canceled') done += 1;
    } catch (err) {
      deps.log.error('pos_tick_error', { sale_id: row.sale_id, error: err.message });
    }
  }
  return { due: due.rows.length, done };
}

/** @param {object} ctx общий контекст (контракт M1 §2.1) */
export async function init(ctx) {
  if (state) return;
  const deps = await resolveDeps(ctx);
  const withContext = ctx.withContext ?? storeWithContext;
  const handler = async (payload, { db, log } = {}) => onPaymentConfirmed(db, log ? { ...deps, log } : deps, payload);
  const unsubscribe = [
    deps.outbox.subscribe?.('payment.confirmed', handler, { name: 'pos.settle' }),
    deps.outbox.subscribe?.('payment.canceled', handler, { name: 'pos.cancel' }),
  ];
  let running = null;
  const timer = setInterval(() => {
    if (running || !ctx.pool) return;
    running = tick({ pool: ctx.pool, withContext, deps })
      .catch((err) => deps.log.error('pos_tick_error', { error: err.message }))
      .finally(() => {
        running = null;
      });
  }, ctx.pos?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, running: () => running, unsubscribe };
  if (deps.missing.length > 0) deps.log.warn('pos_deps_stubbed', { missing: deps.missing });
  deps.log.info('pos_started', {});
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  await state.running();
  for (const u of state.unsubscribe) if (typeof u === 'function') u();
  state = null;
}

export { openTab } from './api.mjs';
