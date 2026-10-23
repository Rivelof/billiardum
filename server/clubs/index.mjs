// Модуль подключения клуба (M5.1 backend-A, №152–154, №160): init(ctx) и stop().
//
// * Подписка outbox club.went_live — карточка каталога связывается с клубом (linkCatalogCard).
// * Планировщик (раз в 15 с, время — ctx.clock, bl.onboarding_due): сверяет проверочные платежи
//   1 ₽ по API ЮKassa и оформляет их возврат; поднимает тревогу «вебхук ЮKassa не настроен»,
//   если платёж (проверочный или гостя) подтверждён сверкой, а вебхука нет 10 минут.
// * Функции соседей для чек-листа (backend-B): resources.activeCount, tariffs.coversWeek,
//   qr.printedAt — neighbors.mjs; ctx.clubsModule.neighbors — подмена в тестах.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { moneyConfig } from '../payments/config.mjs';
import { resolveNeighbors } from './neighbors.mjs';
import { linkCatalogCard, WENT_LIVE_TOPIC } from './service.mjs';
import { checkWebhookMissing, paymentWebhookMissing, syncCheck } from './shops.mjs';

export const TICK_MS = 15_000;
let state = null;
let neighborsCache = null;

/** Функции соседей для чек-листа (один раз на процесс; overrides — тесты). */
export async function neighbors(ctx = {}) {
  if (ctx.clubsModule?.neighbors) return resolveNeighbors(ctx.clubsModule.neighbors);
  neighborsCache ??= await resolveNeighbors();
  return neighborsCache;
}

/** Один проход планировщика (экспортирован для тестов). */
export async function tick({ pool, withContext = storeWithContext, deps, config, limit = 100 }) {
  const now = deps.clock.now();
  const due = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
    db.query('select club_id, kind, id from bl.onboarding_due($1, $2)', [now, limit]),
  );
  let done = 0;
  for (const row of due.rows) {
    try {
      await withContext(pool, { clubId: row.club_id, actorType: 'system' }, async (db) => {
        if (row.kind === 'check_sync' || row.kind === 'check_refund') {
          await db.query('savepoint clubs_tick_item');
          try {
            await syncCheck(db, deps, config, row.id);
            await db.query('release savepoint clubs_tick_item');
          } catch (err) {
            await db.query('rollback to savepoint clubs_tick_item');
            deps.log.warn('shop_check_sync_failed', { check_id: row.id, error: err.code ?? err.message });
            await db.query('update bl.shop_checks set checked_at = $2 where id = $1', [row.id, now]);
            return;
          }
        } else if (row.kind === 'check_webhook') {
          await checkWebhookMissing(db, deps, row.id);
        } else if (row.kind === 'payment_webhook') {
          await paymentWebhookMissing(db, deps, row.id);
        }
        done += 1;
      });
    } catch (err) {
      deps.log.error('clubs_tick_error', { kind: row.kind, id: row.id, error: err.message });
    }
  }
  return { due: due.rows.length, done };
}

function depsOf(ctx) {
  return {
    clock: ctx.clock ?? { now: () => new Date() },
    log: ctx.log ?? { debug() {}, info() {}, warn() {}, error() {} },
    alarms: ctx.alarms,
    audit: ctx.audit,
    outbox: ctx.outbox,
  };
}

/** @param {object} ctx общий контекст сервера */
export async function init(ctx) {
  if (state) return;
  const deps = depsOf(ctx);
  const config = ctx.money?.config ?? moneyConfig(ctx);
  const withContext = ctx.withContext ?? storeWithContext;
  ctx.outbox?.subscribe?.(
    WENT_LIVE_TOPIC,
    async (payload, { db, log } = {}) => linkCatalogCard(db, log ? { ...deps, log } : deps, payload),
    { name: 'clubs.catalog_card' },
  );
  let running = null;
  const timer = setInterval(() => {
    if (running || !ctx.pool) return;
    running = tick({ pool: ctx.pool, withContext, deps, config })
      .catch((err) => deps.log.error('clubs_tick_error', { error: err.message }))
      .finally(() => {
        running = null;
      });
  }, ctx.clubsModule?.tickMs ?? TICK_MS);
  timer.unref?.();
  state = { timer, running: () => running };
  deps.log.info('clubs_started', {});
}

export async function stop() {
  if (!state) return;
  clearInterval(state.timer);
  await state.running();
  state = null;
}
