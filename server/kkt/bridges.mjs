// Мосты ККТ клуба: регистрация владельцем (токен — один раз), список, отзыв (decisions №77).
// db — транзакция роутера в контексте клуба.

import { HttpError } from '../http/errors.mjs';
import { withoutControl } from './atol-task.mjs';
import { markBridgeLost } from './queue.mjs';
import { newBridgeToken } from './tokens.mjs';

export const MAX_BRIDGES = 10;

function view(b, online) {
  return {
    id: b.id,
    name: b.name,
    kkt_model: b.kkt_model ?? null,
    bridge_version: b.bridge_version ?? null,
    created_at: new Date(b.created_at).toISOString(),
    last_seen_at: b.last_seen_at ? new Date(b.last_seen_at).toISOString() : null,
    last_status: b.last_status ?? null,
    online: Boolean(online),
    revoked_at: b.revoked_at ? new Date(b.revoked_at).toISOString() : null,
  };
}

/** POST /api/clubs/{club}/kkt/bridges {name, kkt_model?} → {bridge, token} — токен показывается один раз. */
export async function registerBridge(db, deps, { clubId, userId, body, now }) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 100 || withoutControl(name) !== name) throw new HttpError(400, 'bad_request', { detail: 'name' });
  const model = body?.kkt_model === undefined || body.kkt_model === null ? null : String(body.kkt_model).trim().slice(0, 100) || null;
  const { rows: cnt } = await db.query('select count(*)::int as n from bl.kkt_bridges where club_id = $1 and revoked_at is null', [clubId]);
  if (cnt[0].n >= MAX_BRIDGES) throw new HttpError(409, 'limit_exceeded', { detail: 'bridges' });
  const { token, hash } = newBridgeToken(clubId);
  const { rows } = await db.query(
    `insert into bl.kkt_bridges (club_id, name, token_hash, kkt_model, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6) returning *`,
    [clubId, name, hash, model, userId, now],
  );
  const b = rows[0];
  await deps.audit.appendAudit(db, {
    action: 'kkt.bridge_register',
    objectType: 'kkt_bridge',
    objectId: b.id,
    actorType: 'user',
    actorId: userId,
    data: { bridge_id: b.id },
  });
  deps.log?.info?.('kkt_bridge_registered', { bridge_id: b.id, club_id: clubId });
  return { bridge: view(b, false), token };
}

/** GET /api/clubs/{club}/kkt/bridges */
export async function listBridges(db, { clubId, isOnline = () => false }) {
  const { rows } = await db.query('select * from bl.kkt_bridges where club_id = $1 order by revoked_at nulls first, created_at', [clubId]);
  return rows.map((b) => view(b, !b.revoked_at && isOnline(b.id)));
}

/** POST /api/kkt/bridges/{id}/revoke — токен перестаёт действовать, соединение закрывается. */
export async function revokeBridge(db, deps, { bridgeId, userId, now }) {
  const { rows } = await db.query('select * from bl.kkt_bridges where id = $1 for update', [bridgeId]);
  const b = rows[0];
  if (!b) throw new HttpError(404, 'not_found');
  if (b.revoked_at) return view(b, false);
  const upd = await db.query('update bl.kkt_bridges set revoked_at = $2, revoked_by = $3, updated_at = $2 where id = $1 returning *', [bridgeId, now, userId]);
  const lost = await markBridgeLost(db, deps, { clubId: b.club_id, bridgeId, now });
  await deps.audit.appendAudit(db, {
    action: 'kkt.bridge_revoke',
    objectType: 'kkt_bridge',
    objectId: bridgeId,
    actorType: 'user',
    actorId: userId,
    data: { bridge_id: bridgeId, jobs_unknown: lost },
  });
  return view(upd.rows[0], false);
}
