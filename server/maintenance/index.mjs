// Модуль обслуживания столов (M5.6 №198): планировщик проверки порогов часов игры.
//
// Каждые TICK_MS на ctx.clock — каждому активному клубу (bl.stats_clubs) в своей транзакции
// (контекст клуба, actor system): счётчики часов с последнего события вида, достигнутый порог —
// уведомление (не тревога) управляющему и владельцу, одно на (стол, вид, событие, порог).
// Логика — service.mjs; маршруты — api/routes/maintenance.mjs.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { loadClub } from '../dashboard/store.mjs';
import { checkThresholds } from './service.mjs';

export const TICK_MS = 10 * 60_000;
export const FIRST_TICK_MS = 30_000;

/** Один проход: { notified: [{ club_id, resource_id, kind, hours, threshold_hours }] }. */
export async function tick({ pool, withContext = storeWithContext, clock, log }) {
  const now = clock.now();
  const clubs = await withContext(pool, { clubId: null, actorType: 'system' }, (db) => db.query('select club_id from bl.stats_clubs()'));
  const notified = [];
  for (const { club_id: clubId } of clubs.rows) {
    try {
      const out = await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
        const club = await loadClub(db, clubId);
        return club ? checkThresholds(db, club, { now }) : { notified: [] };
      });
      for (const n of out.notified) notified.push({ club_id: clubId, ...n });
      if (out.notified.length) log?.info('maintenance_due_notified', { club_id: clubId, count: out.notified.length });
    } catch (err) {
      log?.error('maintenance_check_failed', { club_id: clubId, error: err.message, code: err.code });
    }
  }
  return { notified };
}

let state = null;

export async function init(ctx) {
  if (state) return;
  const run = () => tick({ pool: ctx.pool, withContext: ctx.withContext ?? storeWithContext, clock: ctx.clock, log: ctx.log });
  let running = null;
  const fire = () => {
    if (running) return;
    running = run()
      .catch((err) => ctx.log.error('maintenance_tick_failed', { error: err.message }))
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(fire, ctx.maintenance?.firstTickMs ?? FIRST_TICK_MS);
  first.unref?.();
  const timer = setInterval(fire, ctx.maintenance?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, first, running: () => running };
  ctx.log.info('maintenance_started', {});
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  clearTimeout(state.first);
  await state.running();
  state = null;
}
