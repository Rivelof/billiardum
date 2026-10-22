// Модуль листа ожидания (контракт M3 §1 п. 6, §3; решение №109).
//
//   await init(ctx)  — после bookings (MODULES core): подписки outbox session.closed (light),
//                      booking.expired и booking.canceled (bookings), планировщик предложений.
//   await stop()
//   waitlist()       — состояние для маршрутов (api/routes/waitlist.mjs).
//   tick()           — один проход планировщика (тесты — на ускоренных часах).
//
// ctx.bookingDeps.light — подмена light в тестах (holdPending, releasePending);
// ctx.waitlistOptions — { tickMs } (0 — без таймера).

import { nextBookingStart } from '../bookings/api.mjs';
import { resolveDeps } from '../bookings/deps.mjs';
import { REMIND_BEFORE_MS, WAITLIST_STALE_MS } from '../bookings/settings.mjs';
import { withContext as withContextM0 } from '../lib/store.mjs';
import { createWaitlistService } from './service.mjs';

export const TICK_MS = 10_000;
const BATCH = 200;
let state = null;

export function waitlist() {
  if (!state) throw new Error('модуль waitlist не запущен: init(ctx)');
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль waitlist уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const pool = ctx.pool;
  const deps = await resolveDeps(ctx, log);
  const service = createWaitlistService({ deps, log, clock, nextBookingStart });
  const timers = ctx.timers ?? globalThis;
  const tickMs = ctx.waitlistOptions?.tickMs ?? TICK_MS;

  let stopped = false;
  const guard = (fn) => async (payload, opts) => {
    if (stopped) throw new Error('модуль waitlist остановлен');
    return fn(opts.db, payload);
  };
  const unsubscribe = [
    ctx.outbox.subscribe('session.closed', guard(service.onFreed), { name: 'waitlist.session_closed' }),
    ctx.outbox.subscribe('booking.expired', guard(service.onFreed), { name: 'waitlist.booking_expired' }),
    ctx.outbox.subscribe('booking.canceled', guard(service.onFreed), { name: 'waitlist.booking_canceled' }),
  ];

  let running = null;
  function tick() {
    if (stopped) return Promise.resolve({ processed: 0 });
    if (running) return running;
    running = (async () => {
      let processed = 0;
      try {
        const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
          db.query('select kind, id, club_id from bl.booking_due($1, $2::interval, $3::interval, $4)', [
            clock.now(),
            `${REMIND_BEFORE_MS / 1000} seconds`,
            `${WAITLIST_STALE_MS / 1000} seconds`,
            BATCH,
          ]),
        );
        for (const row of due.rows) {
          if (stopped) break;
          // waitlist — запись очереди; waitlist_resource — стол с очередью без предложения (id — стол):
          // предложить, если он свободен (очередь не «засыпает» без события session.closed).
          if (row.kind !== 'waitlist' && row.kind !== 'waitlist_resource') continue;
          try {
            await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) =>
              row.kind === 'waitlist' ? service.step(db, row.id) : service.offerNext(db, row.id),
            );
            processed += 1;
          } catch (err) {
            log.error('waitlist_step_failed', { waitlist_id: row.id, error: err.message, code: err.code });
          }
        }
      } catch (err) {
        log.error('waitlist_tick_failed', { error: err.message });
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
    service,
    tick,
    async stop() {
      stopped = true;
      for (const off of unsubscribe) if (typeof off === 'function') off();
      if (handle) timers.clearInterval(handle);
      if (running) await running.catch(() => {});
    },
  };
  log.info('waitlist_started', {});
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}

export function tick() {
  return waitlist().tick();
}
