// Модуль турниров (контракт M4 §1 п. 11, §3, §4; решения №138, №143).
//
//   await init(ctx)  — server/http/app.mjs (core, MODULES): зависимости, подписки outbox
//                      (payment.confirmed {kind: 'tournament'}, tournament.refund), планировщик на ctx.clock.
//   await stop()     — отписка, остановка планировщика, закрытие потоков ТВ.
//   tournaments()    — состояние для маршрутов (api/routes/tournaments.mjs) и api.mjs.
//   tick()           — один проход планировщика (тесты гоняют его на поддельных часах).
//
// ctx: { config, log, pool, clock, outbox, alarms, notify, sse, audit, withContext } (§2.1);
// ctx.tournamentDeps — подмена соседей в тестах; ctx.tournamentsOptions — { tickMs, publishDelayMs }.

import { withContext as withContextM0 } from '../lib/store.mjs';
import { isChannel } from '../http/sse.mjs';
import { resolveDeps } from './deps.mjs';
import { createTournamentService } from './service.mjs';
import { createTvHub } from './tv.mjs';

export const TICK_MS = 15_000;

let state = null;

export function tournaments() {
  if (!state) throw new Error('модуль tournaments не запущен: init(ctx)');
  return state;
}

export function tournamentsOrNull() {
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль tournaments уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const pool = ctx.pool;
  const opts = ctx.tournamentsOptions ?? {};
  const deps = await resolveDeps(ctx, log);
  const core = ctx.sse?.attach ? { ...ctx.sse, isChannel: ctx.sse.isChannel ?? isChannel } : null;
  const tv = opts.tv ?? createTvHub({ core, log });
  const service = createTournamentService({ deps, log, clock, pool, withContext, tv, publishDelayMs: opts.publishDelayMs ?? 50 });
  const timers = ctx.timers ?? globalThis;
  const tickMs = opts.tickMs ?? TICK_MS;

  let stopped = false;
  const guard = (fn) => async (payload, o) => {
    if (stopped) throw new Error('модуль tournaments остановлен');
    return fn(o.db, payload);
  };
  const unsubscribe = [
    ctx.outbox.subscribe('payment.confirmed', guard(service.onPaymentConfirmed), { name: 'tournaments.payment_confirmed' }),
    ctx.outbox.subscribe('tournament.refund', guard(service.onRefund), { name: 'tournaments.refund' }),
  ];

  let running = null;
  function tick() {
    if (stopped) return Promise.resolve({ processed: 0 });
    if (running) return running;
    running = (async () => {
      let processed = 0;
      try {
        // Платформа видит опубликованные турниры (политика tournaments_public), шаг — в клубе турнира.
        const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
          db.query("select id, club_id from bl.tournaments where status in ('registration', 'closed', 'running') order by starts_at limit 500"),
        );
        for (const row of due.rows) {
          if (stopped) break;
          try {
            await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) => service.step(db, row.id));
            processed += 1;
          } catch (err) {
            log.error('tournament_step_failed', { tournament_id: row.id, error: err.message, code: err.code });
          }
        }
      } catch (err) {
        log.error('tournament_tick_failed', { error: err.message });
      } finally {
        running = null;
      }
      return { processed };
    })();
    return running;
  }

  let handle = null;
  if (tickMs > 0) {
    handle = timers.setInterval(() => {
      tick();
    }, tickMs);
    handle?.unref?.();
  }

  state = {
    ctx,
    deps,
    service,
    tv,
    clock,
    tick,
    async stop() {
      stopped = true;
      for (const off of unsubscribe) if (typeof off === 'function') off();
      if (handle) timers.clearInterval(handle);
      if (running) await running.catch(() => {});
      await service.flush().catch(() => {});
      tv.closeAll?.();
    },
  };
  log.info('tournaments_started', { deps_stubbed: deps.missing, tv_core_hub: tv.usesCore ?? false });
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}

export function tick() {
  return tournaments().tick();
}
