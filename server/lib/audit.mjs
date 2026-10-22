// Журнал действий (инвариант 2, decisions №13, контракт M1 §8, §13).
// Приложение делает обычный INSERT в bl.audit_log; seq, created_at, prev_hash и hash
// считает триггер базы (M0). Клуб — из контекста транзакции (withContext): RLS не даст
// записать в чужую цепочку. Без клуба запись идёт в цепочку платформы.

import { randomUUID } from 'node:crypto';
import { HttpError } from '../http/errors.mjs';

const ACTION = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const OBJECT_TYPE = /^[a-z][a-z0-9_]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR_TYPES = new Set(['user', 'system', 'device', 'support']);
/** Ручные действия (PRODUCT §8.4, контракт §8): без причины — reason_required. */
const MANUAL = /^(service|manual)\./;
export const MAX_REASON = 2000;

export class AuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

/**
 * Запись журнала в цепочку клуба из контекста транзакции db.
 * @param {import('pg').ClientBase} db клиент транзакции withContext
 * @param {{ action: string, objectType?: string|null, objectId?: string|null, reason?: string|null,
 *           data?: object, actorType?: 'user'|'system'|'device'|'support', actorId?: string|null }} entry
 *   actorType и actorId по умолчанию — из контекста (app.actor_type, app.user_id).
 * @returns {Promise<{ id: string, seq: number|null, hash: string|null }>}
 *   seq и hash — null у записи платформы: строку платформы app_api не видит.
 */
export async function appendAudit(db, { action, objectType = null, objectId = null, reason = null, data = {}, actorType, actorId } = {}) {
  if (typeof action !== 'string' || action.length > 100 || !ACTION.test(action)) throw new AuditError('appendAudit: action');
  if (objectType !== null && (typeof objectType !== 'string' || !OBJECT_TYPE.test(objectType))) throw new AuditError('appendAudit: objectType');
  if (objectId !== null && !(typeof objectId === 'string' && UUID.test(objectId))) throw new AuditError('appendAudit: objectId');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new AuditError('appendAudit: data');
  if (actorType !== undefined && !ACTOR_TYPES.has(actorType)) throw new AuditError('appendAudit: actorType');
  if (actorId !== undefined && actorId !== null && !(typeof actorId === 'string' && UUID.test(actorId))) throw new AuditError('appendAudit: actorId');
  let why = reason;
  if (why !== null && why !== undefined) {
    if (typeof why !== 'string') throw new AuditError('appendAudit: reason');
    why = why.trim();
    if (why.length > MAX_REASON) throw new HttpError(400, 'bad_request', { detail: 'reason too long' });
    if (why === '') why = null;
  } else {
    why = null;
  }
  if (MANUAL.test(action) && why === null) throw new HttpError(400, 'reason_required', { detail: action });

  const id = randomUUID();
  const params = [
    id,
    actorType ?? null,
    actorType === undefined ? null : (actorId ?? null),
    action,
    objectType,
    objectId,
    why,
    JSON.stringify(data),
  ];
  // Цепочка клуба из контекста: строка видна, RETURNING отдаёт seq и hash.
  const res = await db.query(
    `insert into bl.audit_log (id, club_id, actor_type, actor_id, action, object_type, object_id, reason, data)
     select $1, x.club_id,
            coalesce($2, bl.ctx_actor_type()),
            case when $2::text is null then bl.ctx_user_id() else $3::uuid end,
            $4, $5, $6, $7, $8::jsonb
       from (select bl.ctx_club_id() as club_id) x
      where x.club_id is not null
     returning id, seq, hash`,
    params,
  );
  if (res.rowCount === 1) {
    const row = res.rows[0];
    return { id: row.id, seq: Number(row.seq), hash: row.hash };
  }
  // Без клуба — цепочка платформы (только system/support, политика M0); RETURNING не работает.
  await db.query(
    `insert into bl.audit_log (id, club_id, actor_type, actor_id, action, object_type, object_id, reason, data)
     values ($1, null, coalesce($2, bl.ctx_actor_type()),
             case when $2::text is null then bl.ctx_user_id() else $3::uuid end,
             $4, $5, $6, $7, $8::jsonb)`,
    params,
  );
  return { id, seq: null, hash: null };
}
