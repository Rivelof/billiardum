// Персонал клуба (контракт M3 §4, decisions №111): только владелец.

import { changeRole, invite, listStaff, revoke, revokeInvite } from '../../server/staff/index.mjs';

const OWNER = ['owner'];

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
    handler: async (ctx, req) => ({
      status: 201,
      json: await invite(ctx.db, { clubId: ctx.club, phone: req.body.phone, role: req.body.role, byUserId: ctx.user.id, now: ctx.clock.now() }),
    }),
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
