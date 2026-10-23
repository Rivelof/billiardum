// Персонал клуба (контракт M3 §4, decisions №111): только владелец.
// POST …/staff и POST …/staff/invites (M5.1 §4) — приглашение со ссылкой и текстом (№158).

import { changeRole, invite, listStaff, revoke, revokeInvite } from '../../server/staff/index.mjs';

const OWNER = ['owner'];

/**
 * Приглашение {phone, role} → 201 {id, phone_masked, role, created_at, expires_at, invite_url, invite_text}:
 * текст со ссылкой на вход /club/ без телефона приглашённого (M5.1 №158).
 */
async function inviteHandler(ctx, req) {
  return {
    status: 201,
    json: await invite(ctx.db, {
      clubId: req.params.club,
      phone: req.body.phone,
      role: req.body.role,
      byUserId: ctx.user.id,
      now: ctx.clock.now(),
      publicHost: ctx.config?.publicHost ?? null,
    }),
  };
}

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/staff',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx) => ({ status: 200, json: await listStaff(ctx.db, { now: ctx.clock.now() }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/staff',
    auth: 'staff',
    roles: OWNER,
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: inviteHandler,
  },
  // M5.1 №158 (m5-1.md §4): тот же вызов по адресу контракта.
  {
    method: 'POST',
    path: '/api/clubs/{club}/staff/invites',
    auth: 'staff',
    roles: OWNER,
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: inviteHandler,
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/staff/{user_id}',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await changeRole(ctx.db, { userId: req.params.user_id, role: req.body.role, byUserId: ctx.user.id }) }),
  },
  {
    method: 'DELETE',
    path: '/api/clubs/{club}/staff/{user_id}',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await revoke(ctx.db, { userId: req.params.user_id, byUserId: ctx.user.id, now: ctx.clock.now() }) }),
  },
  {
    method: 'DELETE',
    path: '/api/clubs/{club}/staff/invites/{id}',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ status: 200, json: await revokeInvite(ctx.db, { inviteId: req.params.id, byUserId: ctx.user.id, now: ctx.clock.now() }) }),
  },
];
