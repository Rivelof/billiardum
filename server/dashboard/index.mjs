// Модуль дашборда (M5.2, решения №166–172): планировщик суточных агрегатов.
//
// Раз в минуту на ctx.clock: каждому активному клубу (bl.stats_clubs) — закрытые рабочие сутки без
// агрегата (после конца суток с запасом GRACE_MS; догоняет пропущенные после простоя сервера, не
// глубже HORIZON_DAYS) и «грязные» сутки (поздний возврат, списание заморозки, закрытая позже игра,
// принятая тревога — отметки ставит триггер базы, миграция 1100).
// Сутки старой версии формул (VERSION в day.mjs) — фоновый пересчёт порциями: не больше
// RESTATE_PER_TICK суток за проход на все клубы и RESTATE_PER_CLUB на клуб, свежие первыми, и не в
// часы пик клуба (RESTATE_PEAK, местное время): до пересчёта экран показывает сохранённые сутки.
// Каждые сутки — своя транзакция в контексте клуба от system; запись — bl.stats_put_day.
// Идемпотентно: повтор пересчитывает те же сутки в то же значение.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { dueDays, loadClub, recomputeDay, staleDays } from './store.mjs';
import { addDays, localParts, workingDayOf } from './time.mjs';
import { cashbookTick } from './cashbook.mjs';

export const TICK_MS = 60_000;
export const FIRST_TICK_MS = 5_000;
/** Сутки считаются закрытыми через 5 минут после конца (транзакции на границе успевают закоммититься). */
export const GRACE_MS = 5 * 60_000;
export const HORIZON_DAYS = 400;
export const DAYS_PER_TICK = 31;
/** Пересчёт суток старой версии формул: суток за проход на все клубы и на один клуб. */
export const RESTATE_PER_TICK = 12;
export const RESTATE_PER_CLUB = 4;
/** Часы пик по местному времени клуба: старые сутки в это время не пересчитываются. */
export const RESTATE_PEAK = Object.freeze({ from: '17:00', to: '02:00' });

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (v) => {
  const m = HHMM.exec(v ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Момент at внутри окна {from, to} (HH:MM, через полночь — можно) по местному времени пояса. */
export function inWindow(window, at, timeZone) {
  const from = toMin(window?.from);
  const to = toMin(window?.to);
  if (from === null || to === null || from === to) return false;
  const p = localParts(at, timeZone);
  const now = p.hour * 60 + p.minute;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

/**
 * Один проход планировщика.
 * restate — пересчёт суток старой версии формул: { perTick, perClub, peak } (peak: null — без часов пик).
 * @returns {Promise<{ computed: { club_id: string, day: string }[], restated: { club_id: string, day: string }[] }>}
 */
export async function tick({ pool, withContext = storeWithContext, clock, log, daysPerClub = DAYS_PER_TICK, restate = {} }) {
  const { perTick = RESTATE_PER_TICK, perClub = RESTATE_PER_CLUB, peak = RESTATE_PEAK } = restate;
  const now = clock.now();
  const clubs = await withContext(pool, { clubId: null, actorType: 'system' }, (db) => db.query('select club_id from bl.stats_clubs()'));
  const computed = [];
  const restated = [];
  let restateLeft = perTick;
  for (const { club_id: clubId } of clubs.rows) {
    try {
      const plan = await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
        const club = await loadClub(db, clubId);
        if (!club) return null;
        const lastClosed = addDays(workingDayOf(new Date(now.getTime() - GRACE_MS), club.timezone, club.day_start_local), -1);
        const days = await dueDays(db, club, { lastClosed, horizonDays: HORIZON_DAYS, limit: daysPerClub });
        let stale = [];
        if (restateLeft > 0 && !(peak && inWindow(peak, now, club.timezone))) {
          stale = (await staleDays(db, club, { lastClosed, limit: Math.min(perClub, restateLeft) })).filter((d) => !days.includes(d));
        }
        return { days, stale };
      });
      restateLeft -= plan?.stale?.length ?? 0;
      for (const day of [...(plan?.days ?? []), ...(plan?.stale ?? [])]) {
        await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
          const club = await loadClub(db, clubId);
          await recomputeDay(db, club, day, now);
        });
        computed.push({ club_id: clubId, day });
        if (plan.stale.includes(day)) restated.push({ club_id: clubId, day });
      }
      if (plan?.days?.length) log?.info('stats_days_computed', { club_id: clubId, days: plan.days.length, first: plan.days[0], last: plan.days.at(-1) });
      if (plan?.stale?.length) log?.info('stats_days_restated', { club_id: clubId, days: plan.stale.length, first: plan.stale.at(-1), last: plan.stale[0] });
      // Касса управляющего (№177): инкассации закрытых смен — записями книги, один раз на смену.
      await withContext(pool, { clubId, actorType: 'system' }, (db) => cashbookTick(db, { clubId, now }));
    } catch (err) {
      log?.error('stats_failed', { club_id: clubId, error: err.message, code: err.code });
    }
  }
  return { computed, restated };
}

let state = null;

export async function init(ctx) {
  if (state) return;
  const run = () => tick({ pool: ctx.pool, withContext: ctx.withContext ?? storeWithContext, clock: ctx.clock, log: ctx.log, restate: ctx.dashboard?.restate });
  let running = null;
  const fire = () => {
    if (running) return;
    running = run()
      .catch((err) => ctx.log.error('stats_tick_failed', { error: err.message }))
      .finally(() => {
        running = null;
      });
  };
  const tickMs = ctx.dashboard?.tickMs ?? TICK_MS;
  const first = setTimeout(fire, ctx.dashboard?.firstTickMs ?? FIRST_TICK_MS);
  first.unref?.();
  const timer = setInterval(fire, tickMs);
  timer.unref?.();
  state = { timer, first, running: () => running };
  ctx.log.info('dashboard_started', {});
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  clearTimeout(state.first);
  await state.running();
  state = null;
}
