// Обёртка денежных маршрутов (контракт M1 §2.1, §3).
//
// Обработчик: async (ctx, req) → { status, json }. ctx.db — транзакция роутера с контекстом
// пользователя (и клуба, если он в пути). Всё, что делает маршрут, идёт в точке сохранения.
// Ошибка модуля (MoneyError: status и code): под роутером api/router.mjs (есть ctx.useClub)
// бросается дальше — роутер откатывает транзакцию целиком (вместе с ключом идемпотентности,
// поэтому повтор после сбоя ЮKassa выполняется заново) и отвечает {"error": code}; без
// роутера — откат до точки сохранения и ответ {"error": code, ...data}. Прочие ошибки — роутеру (500).
// err.data — только безопасные поля (errors.mjs PUBLIC_DATA_FIELDS: booking_id); роутер core отдаёт
// их рядом с кодом по своему белому списку.
// Без ctx.db (вызов вне роутера) — своя транзакция withContext.

import { withContext as storeWithContext } from '../lib/store.mjs';
import { moneyConfig } from './config.mjs';
import { requestInfo } from './context.mjs';
import { resolveDeps } from './deps.mjs';
import { MoneyError } from './errors.mjs';

export function moneyRoute(fn) {
  return async function handler(ctx = {}, req = {}) {
    const info = requestInfo(ctx, req);
    const deps = await resolveDeps(ctx);
    const config = moneyConfig(ctx);
    const run = async (db) => {
      await db.query('savepoint money_route');
      try {
        const out = await fn({ db, deps, info, config, ctx, req });
        await db.query('release savepoint money_route');
        return out && typeof out.status === 'number' && 'json' in out ? out : { status: 200, json: out };
      } catch (err) {
        await db.query('rollback to savepoint money_route').catch(() => {});
        if (err instanceof MoneyError) {
          (ctx.log ?? deps.log)?.info?.('money_route_error', { code: err.code, status: err.status, detail: err.message });
          if (typeof ctx.useClub === 'function') throw err;
          return { status: err.status, json: { error: err.code, ...(err.data ?? {}) } };
        }
        throw err;
      }
    };
    if (ctx.db) return run(ctx.db);
    const withContext = ctx.withContext ?? storeWithContext;
    return withContext(ctx.pool, { clubId: info.clubId ?? null, userId: info.userId ?? null, actorType: 'user' }, run);
  };
}
