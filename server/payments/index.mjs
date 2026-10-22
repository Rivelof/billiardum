// Денежный модуль (контракт M1 §2.1): init(ctx) и stop().
//
// * Подписка на outbox session.closed — списание фактической суммы «Без лимита» по карте.
// * Подписка session.closed — чеки зачёта за сыгранные минуты баланса (пакеты часов).
// * Планировщик (раз в 10 с, время — ctx.clock, bl.money_due): сжигает заявки ресепшена, у которых
//   вышло время (pending со стола снимается); сверяет по API ЮKassa платежи и возвраты, которые
//   больше минуты в pending (вебхук мог потеряться); опрашивает зависшие чеки зачёта; выдаёт
//   отложенные до открытия смены возвраты наличных. Каждая сверка — в точке сохранения.
// * Задаёт зависимости для server/payments/api.mjs (refund для light).

import { withContext as storeWithContext } from '../lib/store.mjs';
import { expireRequest } from '../reception/index.mjs';
import { setRuntime, syncRefund } from './api.mjs';
import { onSessionClosed } from './capture.mjs';
import { loadMoneyConfig } from './config.mjs';
import { resolveDeps } from './deps.mjs';
import { syncPayment } from './pay.mjs';
import { enterClub } from './context.mjs';
import { settleDeposit } from './deposits.mjs';
import { pollSettlementReceipt, SETTLE_TOPIC, sendSettlementReceipt, settleSessionBalance } from './settle.mjs';
import { issueQueuedCashRefund } from './cash-refunds.mjs';

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
        // Каждая сверка — в своей точке сохранения (ревью п. 11): сбой откатывает её частичные
        // записи, а отметка checked_at (не опрашивать снова сразу) коммитится.
        const guarded = async (fn, onError) => {
          await db.query('savepoint money_tick_item');
          try {
            await fn();
            await db.query('release savepoint money_tick_item');
            done += 1;
          } catch (err) {
            await db.query('rollback to savepoint money_tick_item');
            await onError(err);
          }
        };
        if (row.kind === 'payment_stale') {
          const { rows } = await db.query('select * from bl.payments where id = $1 for update', [row.id]);
          if (!rows[0] || rows[0].status !== 'pending') return;
          await guarded(
            () => syncPayment(db, deps, config, rows[0], { source: 'reconcile' }),
            async (err) => {
              deps.log.warn('payment_reconcile_failed', { payment_id: row.id, error: err.message });
              await db.query('update bl.payments set checked_at = $2 where id = $1', [row.id, now]);
            },
          );
          return;
        }
        if (row.kind === 'refund_stale') {
          await guarded(
            () => syncRefund(db, deps, config, row.id),
            async (err) => {
              deps.log.warn('refund_reconcile_failed', { refund_id: row.id, error: err.message });
              await db.query('update bl.refunds set checked_at = $2 where id = $1', [row.id, now]);
            },
          );
          return;
        }
        if (row.kind === 'receipt_stale') {
          await guarded(
            () => pollSettlementReceipt(db, deps, config, row.id),
            async (err) => {
              deps.log.warn('receipt_poll_failed', { receipt_id: row.id, error: err.message });
              await db.query('update bl.receipts set updated_at = $2 where id = $1', [row.id, now]);
            },
          );
          return;
        }
        if (row.kind === 'cash_refund_queued') {
          await guarded(
            () => issueQueuedCashRefund(db, deps, row.id),
            async (err) => {
              deps.log.warn('cash_refund_issue_failed', { pending_id: row.id, error: err.message });
              await db.query('update bl.cash_refunds_pending set checked_at = $2 where id = $1', [row.id, now]);
            },
          );
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
  // Чеки зачёта за сыгранные минуты баланса — при закрытии сессии (ревью п. 2).
  deps.outbox.subscribe(
    'session.closed',
    async (payload, { db, log } = {}) => {
      if (!payload?.session_id || !payload?.club_id) return;
      await enterClub(db, payload.club_id);
      await settleSessionBalance(db, log ? { ...deps, log } : deps, { sessionId: payload.session_id, now: deps.clock.now() });
    },
    { name: 'money.balance_settle' },
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
