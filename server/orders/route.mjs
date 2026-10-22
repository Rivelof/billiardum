// Обёртка маршрутов бара, кассы, каталога и склада (контракт M1 §2.1, §3).
//
// Обработчик: async (ctx, req) → { status, json }. ctx.db — транзакция роутера с контекстом
// пользователя и клуба запроса (если клуб известен роутеру), ctx.roles — роли в этом клубе.
// Ошибка (PosError, MoneyError — поля status и code) бросается роутеру: он откатывает
// транзакцию целиком (вместе с ключом идемпотентности) и отвечает {"error": code}.

import { resolveDeps } from './deps.mjs';

export function requestInfo(ctx, req = {}) {
  const user = req.user ?? ctx.user ?? null;
  return {
    user,
    userId: user?.id ?? null,
    clubId: ctx.club ?? req.club ?? null,
    roles: Array.isArray(ctx.roles) ? ctx.roles : Array.isArray(req.roles) ? req.roles : [],
    idempotencyKey: req.idempotencyKey ?? ctx.idempotencyKey ?? null,
    params: req.params ?? {},
    query: req.query ?? {},
    body: req.body ?? null,
  };
}

export function posRoute(fn, { status = 200 } = {}) {
  return async function handler(ctx = {}, req = {}) {
    const info = requestInfo(ctx, req);
    const deps = await resolveDeps(ctx);
    const out = await fn({ db: ctx.db, deps, info, ctx, req });
    return { status, json: out };
  };
}

/** У сотрудника несколько клубов: роутер ищет объект в каждом (RLS — только в своём). */
export function inClub(table) {
  if (!/^[a-z_]+$/.test(table)) throw new Error('inClub: table');
  return async (db, req) => {
    const { rowCount } = await db.query(`select 1 from bl.${table} where id = $1`, [req.params.id]);
    return rowCount > 0;
  };
}
