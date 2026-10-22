// Планировщик сессий (контракт M1 §6): сигналы гостю T−10 (с «Продлить»), T−1, T−0,
// «Игра завершена»; переходы active → ending → grace → closed по ctx.clock; закрытие в
// T+льгота. Таймер на каждую идущую сессию; после перезапуска сервера таймеры
// восстанавливаются из базы (bl.light_open_sessions), запасной обход — раз в sweepMs.
//
// Время — только ctx.clock.now(); таймеры — подменяемые (тесты гоняют ускоренные часы).

export const SWEEP_MS = 30_000;
/** setTimeout не держит больше ~24,8 суток; дальние сроки перепроверяются раньше. */
export const MAX_TIMER_MS = 60 * 60_000;
const RETRY_MS = 5_000;

/**
 * @param {{
 *   pool: import('pg').Pool,
 *   withContext: Function,
 *   clock: { now(): Date },
 *   log: object,
 *   tick: (db, sessionId) => Promise<Date|null>,
 *   timers?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 *   sweepMs?: number,
 * }} opts
 */
export function createScheduler({ pool, withContext, clock, log, tick, timers = globalThis, sweepMs = SWEEP_MS }) {
  /** @type {Map<string, { clubId: string, handle: any, dueAt: number, running: Promise<void>|null }>} */
  const jobs = new Map();
  let sweepHandle = null;
  let stopped = false;

  function arm(sessionId, clubId, dueAt) {
    const job = jobs.get(sessionId) ?? { clubId, handle: null, dueAt: 0, running: null };
    job.clubId = clubId;
    if (job.handle) timers.clearTimeout(job.handle);
    job.dueAt = dueAt;
    const delay = Math.max(0, Math.min(dueAt - clock.now().getTime(), MAX_TIMER_MS));
    job.handle = timers.setTimeout(() => {
      job.handle = null;
      run(sessionId);
    }, delay);
    jobs.set(sessionId, job);
  }

  function drop(sessionId) {
    const job = jobs.get(sessionId);
    if (job?.handle) timers.clearTimeout(job.handle);
    jobs.delete(sessionId);
  }

  /** Шаг сессии в своей транзакции; следующий срок — из ответа tick. */
  function run(sessionId) {
    const job = jobs.get(sessionId);
    if (!job || stopped) return Promise.resolve();
    if (job.running) return job.running;
    // Таймер сработал раньше срока (часы, MAX_TIMER_MS) — перевзвести.
    if (clock.now().getTime() < job.dueAt) {
      arm(sessionId, job.clubId, job.dueAt);
      return Promise.resolve();
    }
    job.running = (async () => {
      try {
        const next = await withContext(pool, { clubId: job.clubId, actorType: 'system' }, (db) => tick(db, sessionId));
        if (stopped) return;
        if (next) arm(sessionId, job.clubId, next.getTime());
        else drop(sessionId);
      } catch (err) {
        log.error('scheduler_tick_failed', { session_id: sessionId, error: err.message });
        if (!stopped) arm(sessionId, job.clubId, clock.now().getTime() + RETRY_MS);
      } finally {
        job.running = null;
      }
    })();
    return job.running;
  }

  /** Сессия изменилась (оплата, продление, остановка): пересчитать срок сейчас. */
  function refresh(sessionId, clubId) {
    if (stopped) return Promise.resolve();
    const job = jobs.get(sessionId);
    if (job?.running) return job.running.then(() => refresh(sessionId, clubId));
    arm(sessionId, clubId, clock.now().getTime());
    return run(sessionId);
  }

  /** Обход всех идущих сессий: восстановление после перезапуска и страховка от потерянных сигналов. */
  async function sweep() {
    let rows;
    try {
      rows = await withContext(pool, { clubId: null, actorType: 'system' }, async (db) => {
        const r = await db.query('select session_id, club_id from bl.light_open_sessions()');
        return r.rows;
      });
    } catch (err) {
      log.error('scheduler_sweep_failed', { error: err.message });
      return 0;
    }
    let added = 0;
    for (const r of rows) {
      if (!jobs.has(r.session_id)) {
        added += 1;
        await refresh(r.session_id, r.club_id);
      }
    }
    return added;
  }

  /** Прогнать все сессии, срок которых наступил (тесты с ускоренными часами). */
  async function runDue() {
    const t = clock.now().getTime();
    const due = [...jobs.entries()].filter(([, j]) => j.dueAt <= t).map(([id]) => id);
    for (const id of due) await run(id);
    return due.length;
  }

  return {
    async start() {
      stopped = false;
      const n = await sweep();
      log.info('scheduler_started', { sessions: n });
      sweepHandle = timers.setInterval(() => {
        sweep().catch(() => {});
      }, sweepMs);
    },
    async stop() {
      stopped = true;
      if (sweepHandle) timers.clearInterval(sweepHandle);
      const running = [...jobs.values()].map((j) => j.running).filter(Boolean);
      for (const id of [...jobs.keys()]) drop(id);
      await Promise.allSettled(running);
    },
    refresh,
    sweep,
    runDue,
    /** Дождаться выполняющихся шагов (тесты). */
    async idle() {
      await Promise.allSettled([...jobs.values()].map((j) => j.running).filter(Boolean));
    },
    size: () => jobs.size,
    dueAt: (sessionId) => (jobs.has(sessionId) ? new Date(jobs.get(sessionId).dueAt) : null),
  };
}
