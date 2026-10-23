// Модуль Бильярдум+ (контракт M4 §1 п. 7–10, §3): профиль, рейтинг Эло, партии и подтверждения,
// таблицы, друзья, «Ищу соперника», «Сыграем?», достижения.
//
//   await init(ctx)  — server/http/app.mjs (core, MODULES 'plus'): зависимости, подписки outbox
//                      (session.closed, tournament.match_finished), планировщик истечения партий.
//   await stop()     — отписка и остановка планировщика.
//   plus()           — состояние для маршрутов (api/routes/plus.mjs) и api.mjs.
//   tick()           — один проход планировщика (тесты гоняют его на ускоренных часах).
//
// ctx: { config, log, pool, clock, outbox, notify, sse, audit, withContext } (§2.1);
// ctx.plusDeps — подмена соседей в тестах; ctx.plusOptions — { tickMs } (0 — без таймера).

import { withContext as withContextM0 } from '../lib/store.mjs';
import { resolveDeps } from './deps.mjs';
import { createPlusService } from './service.mjs';

export const TICK_MS = 30_000;
const BATCH = 200;

let state = null;

export function plus() {
  if (!state) throw new Error('модуль plus не запущен: init(ctx)');
  return state;
}

/** Для api.mjs: состояние запущенного модуля или null. */
export function plusOrNull() {
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль plus уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const pool = ctx.pool;
  const deps = await resolveDeps(ctx, log);
  if (!ctx.outbox?.subscribe) throw new Error('ctx.outbox (core) обязателен');
  const service = createPlusService({ deps, log, clock, config: ctx.config ?? {} });
  const timers = ctx.timers ?? globalThis;
  const tickMs = ctx.plusOptions?.tickMs ?? TICK_MS;

  let stopped = false;
  const guard = (fn) => async (payload, opts) => {
    if (stopped) throw new Error('модуль plus остановлен');
    return fn(opts.db, payload);
  };
  const unsubscribe = [
    ctx.outbox.subscribe('session.closed', guard(service.onSessionClosed), { name: 'plus.session_closed' }),
    ctx.outbox.subscribe('tournament.match_finished', guard(service.onTournamentMatchFinished), { name: 'plus.tournament_match' }),
  ];

  /** Партии без подтверждения дольше 30 минут → не засчитаны (confirm_timeout). */
  let running = null;
  function tick() {
    if (stopped) return Promise.resolve({ processed: 0 });
    if (running) return running;
    running = (async () => {
      let processed = 0;
      try {
        const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
          db.query('select match_id, club_id from bl.plus_due($1, $2)', [clock.now(), BATCH]),
        );
        for (const row of due.rows) {
          if (stopped) break;
          try {
            const done = await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) => service.expireDue(db, row.match_id));
            if (done) processed += 1;
          } catch (err) {
            log.error('plus_expire_failed', { match_id: row.match_id, error: err.code ?? err.message });
          }
        }
      } catch (err) {
        log.error('plus_tick_failed', { error: err.code ?? err.message });
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
    clock,
    tick,
    async stop() {
      stopped = true;
      for (const off of unsubscribe) if (typeof off === 'function') off();
      if (handle) timers.clearInterval(handle);
      if (running) await running.catch(() => {});
    },
  };
  log.info('plus_started', { deps_stubbed: deps.missing });
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}

export function tick() {
  return plus().tick();
}
