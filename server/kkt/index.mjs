// Модуль ККТ, смен и отчётов (контракт M2 §2, §5; сборка — контракт M1 §2.1): init(ctx) и stop().
//
// * Сервер мостов ККТ (service.mjs) и WebSocket /api/kkt/ws (ws.mjs): handleUpgrade(req, socket, head)
//   вызывает HTTP-сервер на событие upgrade; closeConnections() — до server.close() при остановке.
// * enqueueReceipt (api.mjs) будит очередь клуба после коммита.
// * Подписка outbox shift.closed — отчёт смены владельцу (server/reports/).
//
// Настройки — ctx.kkt (тесты): { resendMs, tickMs, alarmTickMs, staleMs, pingMs, retryBaseMs, retryMaxMs };
// сверка с ЮKassa — ctx.money.config или окружение (server/payments/config.mjs).

import { withContext as storeWithContext } from '../lib/store.mjs';
import { loadMoneyConfig } from '../payments/config.mjs';
import { onShiftClosed } from '../reports/shift-report.mjs';
import { setRuntime } from './api.mjs';
import { createKktService } from './service.mjs';
import { createKktWs, WS_PATH } from './ws.mjs';

let state = null;

export { WS_PATH };

/** Разбудить очередь ККТ клуба (после коммита). */
export function kick(clubId) {
  state?.service.kick(clubId);
}

/** Сервис мостов (маршруты api/routes/kkt.mjs) или null, если модуль не запущен. */
export function kktService() {
  return state?.service ?? null;
}

/** Конфигурация денег для сверки с ЮKassa. */
export function reportsMoneyConfig() {
  return state?.moneyConfig ?? null;
}

/** Событие upgrade HTTP-сервера. Путь не /api/kkt/ws или модуль не запущен — false. */
export function handleUpgrade(req, socket, head) {
  if (!state) return false;
  return state.ws.handleUpgrade(req, socket, head);
}

/** Закрыть соединения мостов: HTTP-сервер не ждёт их при остановке. */
export function closeConnections() {
  state?.service.closeConnections();
}

/** @param {object} ctx общий контекст сервера (контракт M1 §2.1) */
export async function init(ctx) {
  if (state) return;
  const withContext = ctx.withContext ?? storeWithContext;
  const service = createKktService({
    pool: ctx.pool,
    withContext,
    clock: ctx.clock,
    log: ctx.log,
    outbox: ctx.outbox,
    alarms: ctx.alarms,
    audit: ctx.audit,
    sse: ctx.sse,
    options: ctx.kkt ?? {},
  });
  const ws = createKktWs({ service, pool: ctx.pool, withContext, log: ctx.log, config: ctx.config ?? {} });
  let moneyConfig = ctx.money?.config ?? null;
  if (!moneyConfig) {
    try {
      moneyConfig = loadMoneyConfig(process.env, ctx.config ?? {});
    } catch (err) {
      ctx.log.warn('kkt_money_config_failed', { error: err.message });
    }
  }
  setRuntime({ kick: (clubId) => service.kick(clubId), clock: ctx.clock });
  const reportDeps = { clock: ctx.clock, log: ctx.log, moneyConfig, fetch: ctx.kkt?.fetch };
  const unsubscribe = ctx.outbox.subscribe('shift.closed', (payload, { db }) => onShiftClosed(db, reportDeps, payload), { name: 'reports.shift_closed' });
  service.start();
  state = { service, ws, moneyConfig, unsubscribe };
  ctx.kktUpgrade = handleUpgrade;
  ctx.log.info('kkt_started', { ws: WS_PATH });
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  setRuntime({ kick: null });
  s.unsubscribe?.();
  await s.service.stop();
}
