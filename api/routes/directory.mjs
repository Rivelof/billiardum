// Каталог клубов и сайт-агрегатор (M4 §4, m4-api.md). Логика — server/directory/ (backend-directory).
// /api/public/* — без входа, кэш 60 с и лимит частоты задаёт роутер (core).

import { directory } from '../../server/directory/index.mjs';

const d = () => directory();
const userId = (req) => req.user?.id ?? null;
const OPERATOR = ['platform_operator', 'platform_admin'];
const CLUB_STAFF = ['owner', 'manager', 'reception'];
const CLUB_MANAGERS = ['owner', 'manager'];

/** Объект клуба запроса — для персонала с несколькими клубами (findClub роутера). */
const inClub = (table) => async (db, req) =>
  (await db.query(`select 1 from bl.${table} where id = $1 and club_id = nullif(current_setting('app.club_id', true), '')::uuid`, [req.params.id])).rowCount > 0;

export const routes = [
  // Публичное для сайта ------------------------------------------------------------------------
  { method: 'GET', path: '/api/public/cities', auth: 'none', handler: async (ctx) => ({ status: 200, json: await d().public.cities(ctx.db) }) },
  {
    method: 'GET',
    path: '/api/public/cities/{slug}',
    auth: 'none',
    handler: async (ctx, req) => ({ status: 200, json: await d().public.city(ctx.db, { slug: req.params.slug, query: req.query }) }),
  },
  {
    method: 'GET',
    path: '/api/public/clubs/{city}/{slug}',
    auth: 'none',
    handler: async (ctx, req) => ({ status: 200, json: await d().public.club(ctx.db, { city: req.params.city, slug: req.params.slug }) }),
  },
  {
    method: 'GET',
    path: '/api/public/listings/{id}',
    auth: 'none',
    handler: async (ctx, req) => ({ status: 200, json: await d().public.listing(ctx.db, { id: req.params.id }) }),
  },

  // Заявки гостей в клубы без программы (T25) ---------------------------------------------------
  {
    method: 'POST',
    path: '/api/clubs/requests',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 10, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 201, json: await d().requests.create(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  { method: 'GET', path: '/api/clubs/requests', auth: 'guest', handler: async (ctx, req) => ({ status: 200, json: await d().requests.listMine(ctx.db, { userId: userId(req) }) }) },
  {
    method: 'GET',
    path: '/api/clubs/requests/{id}',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.get(ctx.db, { userId: userId(req), id: req.params.id }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/requests/{id}/cancel',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.cancel(ctx.db, { userId: userId(req), id: req.params.id }) }),
  },
  // Ответ клуба по одноразовой ссылке из уведомления: без входа, проверка токена в коде.
  {
    method: 'GET',
    path: '/api/clubs/requests/{id}/answer',
    auth: 'none',
    actor: 'system',
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.byToken(ctx.db, { id: req.params.id, token: req.query.t }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/requests/{id}/answer',
    auth: 'none',
    actor: 'system',
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.answerByToken(ctx.db, { id: req.params.id, body: req.body }) }),
  },
  // Клуб в программе отвечает на заявки через программу.
  {
    method: 'GET',
    path: '/api/clubs/{club}/requests',
    auth: 'staff',
    roles: CLUB_STAFF,
    handler: async (ctx) => ({ status: 200, json: await d().requests.listClub(ctx.db, { clubId: ctx.club }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/requests/{id}/answer',
    auth: 'staff',
    roles: CLUB_STAFF,
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.answerByClub(ctx.db, { clubId: ctx.club, id: req.params.id, body: req.body }) }),
  },

  // Карточки: клуб, «Подтвердить клуб», «Добавить клуб» ----------------------------------------
  {
    method: 'GET',
    path: '/api/clubs/{club}/listing',
    auth: 'staff',
    roles: CLUB_MANAGERS,
    handler: async (ctx) => ({ status: 200, json: await d().listings.getClubListing(ctx.db, { clubId: ctx.club }) }),
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/listing',
    auth: 'staff',
    roles: CLUB_MANAGERS,
    handler: async (ctx, req) => ({ status: 200, json: await d().listings.patchClubListing(ctx.db, { clubId: ctx.club, body: req.body }) }),
  },
  {
    method: 'POST',
    path: '/api/directory/claim',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 10, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 201, json: await d().listings.claim(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'POST',
    path: '/api/directory/add',
    auth: 'guest',
    requires: ['phone', 'consent'],
    rateLimit: { max: 10, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 201, json: await d().listings.add(ctx.db, { userId: userId(req), body: req.body }) }),
  },

  // Отзывы ------------------------------------------------------------------------------------
  {
    method: 'POST',
    path: '/api/reviews',
    auth: 'guest',
    requires: ['consent'],
    rateLimit: { max: 20, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.upsert(ctx.db, { userId: userId(req), body: req.body }) }),
  },
  {
    method: 'GET',
    path: '/api/reviews/mine',
    auth: 'guest',
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.getMine(ctx.db, { userId: userId(req), clubId: req.query.club_id }) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/reviews',
    auth: 'staff',
    roles: CLUB_STAFF,
    handler: async (ctx) => ({ status: 200, json: await d().reviews.listClub(ctx.db, { clubId: ctx.club }) }),
  },
  {
    method: 'POST',
    path: '/api/reviews/{id}/reply',
    auth: 'staff',
    roles: CLUB_MANAGERS,
    findClub: inClub('reviews'),
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.reply(ctx.db, { id: req.params.id, clubId: ctx.club, userId: userId(req), body: req.body }) }),
  },
  // Жалоба — любой вошедший; запись в контексте платформы (оператору), автор жалобы — из входа.
  {
    method: 'POST',
    path: '/api/reviews/{id}/report',
    auth: 'guest',
    actor: 'system',
    rateLimit: { max: 10, windowMs: 60_000 },
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.report(ctx.db, { id: req.params.id, reporterId: userId(req), body: req.body }) }),
  },

  // Экран оператора платформы -------------------------------------------------------------------
  {
    method: 'GET',
    path: '/api/platform/requests',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.listPlatform(ctx.db, { status: req.query.status }) }),
  },
  {
    method: 'PATCH',
    path: '/api/platform/requests/{id}',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().requests.patchPlatform(ctx.db, { id: req.params.id, body: req.body, operatorId: userId(req) }) }),
  },
  {
    method: 'GET',
    path: '/api/platform/listings',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().listings.listPlatform(ctx.db, { status: req.query.status }) }),
  },
  {
    method: 'PATCH',
    path: '/api/platform/listings/{id}',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().listings.patchPlatform(ctx.db, { id: req.params.id, body: req.body, operatorId: userId(req) }) }),
  },
  {
    method: 'POST',
    path: '/api/platform/cards',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 201, json: await d().listings.createCard(ctx.db, { body: req.body, operatorId: userId(req) }) }),
  },
  {
    method: 'PATCH',
    path: '/api/platform/cards/{id}',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().listings.patchCard(ctx.db, { id: req.params.id, body: req.body, operatorId: userId(req) }) }),
  },
  {
    method: 'GET',
    path: '/api/platform/cities',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx) => ({ status: 200, json: await d().cities.list(ctx.db) }),
  },
  {
    method: 'POST',
    path: '/api/platform/cities',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 201, json: await d().cities.create(ctx.db, { body: req.body }) }),
  },
  {
    method: 'PATCH',
    path: '/api/platform/cities/{id}',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().cities.patch(ctx.db, { id: req.params.id, body: req.body }) }),
  },
  {
    method: 'GET',
    path: '/api/platform/reports',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.listReports(ctx.db, { status: req.query.status }) }),
  },
  {
    method: 'PATCH',
    path: '/api/platform/reports/{id}',
    auth: 'platform',
    roles: OPERATOR,
    handler: async (ctx, req) => ({ status: 200, json: await d().reviews.patchReport(ctx.db, { id: req.params.id, body: req.body, operatorId: userId(req) }) }),
  },
];
