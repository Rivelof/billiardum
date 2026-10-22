// Брони (контракт M3 §4). Логика — server/bookings/service.mjs (backend-booking).
// Ошибки — BookingError и ошибки соседей { status, code } → {"error": code}.

import { bookings } from '../../server/bookings/index.mjs';

const svc = () => bookings().service;
const userId = (req) => req.user?.id ?? null;
const STAFF = ['owner', 'manager', 'reception'];

/** Бронь клуба запроса — для выбора клуба персонала с несколькими клубами (findClub роутера). */
async function bookingInClub(db, req) {
  const { rows } = await db.query("select 1 from bl.bookings where id = $1 and club_id = nullif(current_setting('app.club_id', true), '')::uuid", [req.params.id]);
  return rows.length > 0;
}

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/availability',
    auth: 'none',
    rateLimit: { max: 120, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, json: await bookings().availability(ctx.db, { clubId: req.params.club, date: req.query.date }) };
    },
  },
  {
    method: 'POST',
    path: '/api/bookings',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 201, json: await svc().create(ctx.db, { userId: userId(req), body: req.body }) };
    },
  },
  {
    method: 'GET',
    path: '/api/me/bookings',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().listMine(ctx.db, { userId: userId(req) }) };
    },
  },
  {
    method: 'GET',
    path: '/api/bookings/{id}',
    auth: 'guest',
    async handler(ctx, req) {
      return { status: 200, json: await svc().get(ctx.db, { bookingId: req.params.id, userId: userId(req), club: ctx.club, roles: ctx.roles }) };
    },
  },
  {
    method: 'POST',
    path: '/api/bookings/{id}/pay',
    auth: 'guest',
    requires: ['phone', 'consent'],
    idempotent: true,
    async handler(ctx, req) {
      return {
        status: 200,
        json: await svc().pay(ctx.db, { bookingId: req.params.id, userId: userId(req), body: req.body, requestKey: ctx.idempotencyKey }),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/bookings/{id}/cancel',
    auth: 'guest',
    async handler(ctx, req) {
      return {
        status: 200,
        json: await svc().cancel(ctx.db, { bookingId: req.params.id, userId: userId(req), club: ctx.club, roles: ctx.roles, reason: req.body?.reason }),
      };
    },
  },
  {
    method: 'POST',
    path: '/api/bookings/{id}/start',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 30, windowMs: 60_000 },
    async handler(ctx, req) {
      return { status: 200, json: await svc().start(ctx.db, { bookingId: req.params.id, userId: userId(req), body: req.body }) };
    },
  },
  {
    method: 'POST',
    path: '/api/bookings/{id}/arrive',
    auth: 'staff',
    roles: STAFF,
    findClub: bookingInClub,
    async handler(ctx, req) {
      return { status: 200, json: await svc().arrive(ctx.db, { bookingId: req.params.id, userId: userId(req), club: ctx.club, roles: ctx.roles }) };
    },
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/bookings',
    auth: 'staff',
    roles: STAFF,
    async handler(ctx, req) {
      return { status: 200, json: await svc().listClub(ctx.db, { clubId: ctx.club, date: req.query.date }) };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/bookings',
    auth: 'staff',
    roles: STAFF,
    async handler(ctx, req) {
      return { status: 201, json: await svc().createByStaff(ctx.db, { clubId: ctx.club, staffId: userId(req), body: req.body }) };
    },
  },
];
