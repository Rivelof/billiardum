// Денежный модуль (контракт M1 §2.1): init(ctx) и stop().
//
// * Подписка на outbox session.closed — списание фактической суммы «Без лимита» по карте.
// * Планировщик (раз в 10 с, время — ctx.clock): сжигает заявки ресепшена, у которых вышло
//   время (pending со стола снимается), и сверяет по API ЮKassa платежи, которые больше
//   минуты в pending (вебхук мог потеряться).
// * Задаёт зависимости для server/payments/api.mjs (refund для light).

import { withContext as storeWithContext } from '../lib/store.mjs';
import { expireRequest } from '../reception/index.mjs';
import { setRuntime } from './api.mjs';
import { onSessionClosed } from './capture.mjs';
import { loadMoneyConfig } from './config.mjs';
import { resolveDeps } from './deps.mjs';
import { syncPayment } from './pay.mjs';
import { enterClub } from './context.mjs';
import { settleDeposit } from './deposits.mjs';
import { SETTLE_TOPIC, sendSettlementReceipt } from './settle.mjs';

const TICK_MS = 10_000;
let state = null;

/** Один проход планировщика (экспортирован для тестов). */
export async function tick({ pool, withContext, deps, config, limit = 100 }) {
  const now = deps.clock.now();
  const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
    db.query('select club_id, kind, id from bl.money_due($1, $2)', [now, limit]),
  );
  let done = 0;
  for (const row of due.rows) {
    try {
      await withContext(pool, { clubId: row.club_id, actorType: 'system' }, async (db) => {
        if (row.kind === 'reception_expired') {
          if (await expireRequest(db, deps, row.id)) done += 1;
          return;
        }
        if (row.kind === 'payment_stale') {
          const { rows } = await db.query('select * from bl.payments where id = $1 for update', [row.id]);
          if (!rows[0] || rows[0].status !== 'pending') return;
          try {
            await syncPayment(db, deps, config, rows[0], { source: 'reconcile' });
            done += 1;
          } catch (err) {
            deps.log.warn('payment_reconcile_failed', { payment_id: row.id, error: err.message });
            await db.query('update bl.payments set checked_at = $2 where id = $1', [row.id, now]);
          }
        }
      });
    } catch (err) {
      deps.log.error('money_tick_error', { kind: row.kind, id: row.id, error: err.message });
    }
  }
  return { due: due.rows.length, done };
}

/** @param {object} ctx общий контекст (§2.1) */
export async function init(ctx) {
  if (state) return;
  const deps = await resolveDeps(ctx);
  const config = ctx.money?.config ?? loadMoneyConfig(process.env, ctx.config ?? {});
  setRuntime({ deps, config });
  const withContext = ctx.withContext ?? storeWithContext;
  deps.outbox.subscribe(
    'session.closed',
    async (payload, { db, log } = {}) => onSessionClosed(db, log ? { ...deps, log } : deps, config, payload),
    { name: 'money.capture' },
  );
  // M3: чеки зачёта предоплаты в ЮKassa и расчёт депозитных сессий при закрытии.
  deps.outbox.subscribe(
    SETTLE_TOPIC,
    async (payload, { db, log } = {}) => sendSettlementReceipt(db, log ? { ...deps, log } : deps, config, payload),
    { name: 'money.receipt_settle' },
  );
  deps.outbox.subscribe(
    'session.closed',
    async (payload, { db, log } = {}) => {
      if (!payload?.session_id || !payload?.club_id) return;
      await enterClub(db, payload.club_id);
      await settleDeposit(db, log ? { ...deps, log } : deps, { sessionId: payload.session_id, usedKopecks: payload.used_kopecks ?? null });
    },
    { name: 'money.deposit' },
  );
  let running = null;
  const timer = setInterval(() => {
    if (running || !ctx.pool) return;
    running = tick({ pool: ctx.pool, withContext, deps, config })
      .catch((err) => deps.log.error('money_tick_error', { error: err.message }))
      .finally(() => {
        running = null;
      });
  }, ctx.money?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, running: () => running };
  if (deps.missing.length > 0) deps.log.warn('money_deps_stubbed', { missing: deps.missing });
  deps.log.info('money_started', { yookassa: config.yookassaApiUrl, dev_any_minutes: config.devAllowAnyMinutes });
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  await state.running();
  state = null;
  setRuntime(null);
}
