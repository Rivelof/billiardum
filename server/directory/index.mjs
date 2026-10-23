// Модуль каталога клубов (M4, backend-directory): города, карточки, публичный API сайта, заявки
// гостей в клубы без программы (T25), «Подтвердить/Добавить клуб», leads, отзывы, экран оператора.
//
//   await init(ctx)  — server/http/app.mjs (core, MODULES): зависимости, планировщик передачи
//                      заявок оператору (раз в 30 с, время — ctx.clock).
//   await stop()
//   directory()      — сервисы для маршрутов api/routes/directory.mjs и leads.mjs.
//   tick()           — один проход планировщика (тесты — на ускоренных часах).
//
// ctx.directoryDeps — подмена соседей в тестах ({ sessions, plus, tournaments }); ctx.directoryOptions — { tickMs }.

import { withContext as withContextM0 } from '../lib/store.mjs';
import { createLeadsService } from './leads.mjs';
import { createListingsService } from './listings.mjs';
import { createPublicService } from './public.mjs';
import { createRequestsService } from './requests.mjs';
import { createReviewsService } from './reviews.mjs';

export const TICK_MS = 30_000;
let state = null;

async function tryImport(spec) {
  const url = new URL(spec, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(url.pathname)) return null;
    throw err;
  }
}

/** Соседи: light (статус стола), plus (ник автора отзыва), tournaments (турниры клуба) — необязательные. */
export async function resolveDirectoryDeps(ctx) {
  const o = ctx.directoryDeps ?? {};
  const pick = async (key, spec, names) => {
    if (o[key]) return o[key];
    const mod = await tryImport(spec);
    return mod && names.some((n) => typeof mod[n] === 'function') ? mod : {};
  };
  return {
    audit: ctx.audit ?? (await tryImport('../lib/audit.mjs')),
    notify: ctx.notify ?? (await tryImport('../notify/index.mjs')),
    sessions: await pick('sessions', '../sessions/api.mjs', ['getResourceStatus']),
    plus: await pick('plus', '../plus/api.mjs', ['playerCard']),
    tournaments: await pick('tournaments', '../tournaments/api.mjs', ['publicTournaments']),
  };
}

export function directory() {
  if (!state) throw new Error('модуль directory не запущен: init(ctx)');
  return state;
}

export function directoryOrNull() {
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль directory уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const deps = await resolveDirectoryDeps(ctx);
  const opts = { deps, log, clock, config: ctx.config ?? {} };
  const services = {
    public: createPublicService(opts),
    requests: createRequestsService(opts),
    listings: createListingsService(opts),
    leads: createLeadsService(opts),
    reviews: createReviewsService(opts),
  };
  const timers = ctx.timers ?? globalThis;
  const tickMs = ctx.directoryOptions?.tickMs ?? TICK_MS;
  let stopped = false;
  let running = null;

  /** Заявки без ответа клуба 15 минут — оператору (контекст платформы). */
  function tick() {
    if (stopped) return Promise.resolve({ escalated: 0 });
    if (running) return running;
    running = (async () => {
      try {
        const n = await withContext(ctx.pool, { clubId: null, actorType: 'system' }, (db) => services.requests.escalateDue(db));
        return { escalated: n };
      } catch (err) {
        log.error('directory_tick_failed', { error: err.message });
        return { escalated: 0 };
      } finally {
        running = null;
      }
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
    ...services,
    deps,
    tick,
    async stop() {
      stopped = true;
      if (handle) timers.clearInterval(handle);
      if (running) await running.catch(() => {});
    },
  };
  log.info('directory_started', {});
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}

export function tick() {
  return directory().tick();
}
