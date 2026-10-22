// Модуль брони (контракт M3 §1 п. 1–5, §3): брони, предоплата, удержание, сгорание, старт.
//
//   await init(ctx)  — server/http/app.mjs (core, MODULES): зависимости, подписки outbox
//                      (payment.confirmed, session.closed, session.started), планировщик на ctx.clock.
//   await stop()     — отписка и остановка планировщика.
//   bookings()       — состояние для маршрутов (api/routes/bookings.mjs) и api.mjs.
//   tick()           — один проход планировщика (тесты гоняют его на ускоренных часах).
//
// ctx: { config, log, pool, clock, outbox, alarms, notify, sse, audit, withContext } (§2.1);
// ctx.bookingDeps — подмена соседей в тестах; ctx.bookingsOptions — { tickMs } (0 — без таймера).

import { withContext as withContextM0 } from '../lib/store.mjs';
import { availability } from './availability.mjs';
import { resolveDeps } from './deps.mjs';
import { createBookingService } from './service.mjs';
import { REMIND_BEFORE_MS, WAITLIST_STALE_MS } from './settings.mjs';

export const TICK_MS = 10_000;
/** Сколько неудач шага брони подряд до тревоги. */
export const FAIL_ALARM = 5;
const BATCH = 200;

let state = null;

export function bookings() {
  if (!state) throw new Error('модуль bookings не запущен: init(ctx)');
  return state;
}

/** Для api.mjs: сервис запущенного модуля или null. */
export function bookingsOrNull() {
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль bookings уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const pool = ctx.pool;
  const deps = await resolveDeps(ctx, log);
  const service = createBookingService({ deps, log, clock, config: ctx.config ?? {} });
  const timers = ctx.timers ?? globalThis;
  const tickMs = ctx.bookingsOptions?.tickMs ?? TICK_MS;

  let stopped = false;
  const guard = (fn) => async (payload, opts) => {
    if (stopped) throw new Error('модуль bookings остановлен');
    return fn(opts.db, payload);
  };
  const unsubscribe = [
    ctx.outbox.subscribe('payment.confirmed', guard(service.onPaymentConfirmed), { name: 'bookings.payment_confirmed' }),
    ctx.outbox.subscribe('session.closed', guard(service.onSessionClosed), { name: 'bookings.session_closed' }),
    ctx.outbox.subscribe('session.started', guard(service.onSessionStarted), { name: 'bookings.session_started' }),
  ];

  // «Ядовитая» бронь (шаг падает раз за разом) не держит планировщик: пауза растёт 10 с → 10 мин,
  // после FAIL_ALARM неудач подряд — тревога клубу (один раз до успеха).
  const failures = new Map();
  async function stepFailed(row, err, nowMs) {
    const f = failures.get(row.id) ?? { n: 0, nextAt: 0, alarmed: false };
    f.n += 1;
    f.nextAt = nowMs + Math.min(10_000 * 2 ** (f.n - 1), 600_000);
    failures.set(row.id, f);
    log.error('booking_step_failed', { booking_id: row.id, error: err.message, code: err.code, failures: f.n });
    if (f.n >= FAIL_ALARM && !f.alarmed) {
      f.alarmed = true;
      try {
        await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) =>
          deps.alarms.raise(db, row.club_id, {
            type: 'booking_step_failed',
            level: 'important',
            data: { booking_id: row.id },
            text: 'Бронь не обрабатывается планировщиком: проверьте её в программе клуба',
          }),
        );
      } catch (e) {
        log.error('booking_alarm_failed', { booking_id: row.id, error: e.message });
      }
    }
  }

  /** Брони, по которым пора действовать (bl.booking_due), — каждая в своей транзакции клуба. */
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
        const nowMs = clock.now().getTime();
        for (const row of due.rows) {
          if (stopped) break;
          if (row.kind !== 'booking') continue;
          const f = failures.get(row.id);
          if (f && f.nextAt > nowMs) continue;
          try {
            await withContext(pool, { clubId: row.club_id, actorType: 'system' }, (db) => service.step(db, row.id));
            failures.delete(row.id);
            processed += 1;
          } catch (err) {
            await stepFailed(row, err, nowMs);
          }
        }
      } catch (err) {
        log.error('booking_tick_failed', { error: err.message });
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
    availability: (db, args) => availability(db, { deps, clock, log }, args),
    async stop() {
      stopped = true;
      for (const off of unsubscribe) if (typeof off === 'function') off();
      if (handle) timers.clearInterval(handle);
      if (running) await running.catch(() => {});
    },
  };
  log.info('bookings_started', { deps_stubbed: deps.missing });
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}

export function tick() {
  return bookings().tick();
}
