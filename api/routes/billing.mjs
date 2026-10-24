// Подписка клубов (M5.3, контракт m5-3.md §3; решения №180–186). Формы ответов — server/billing/README.md.
//
//   GET    /api/clubs/{club}/subscription            — владелец (всё), управляющий (состояние и плашка)
//   POST   /api/clubs/{club}/subscription/card       — владелец {return_url?, email?} → {confirmation_url, payment_id, purpose, amount_kopecks}
//   DELETE /api/clubs/{club}/subscription/autopay    — владелец {reason?} → {autopay: false, card: null}; карты нет — 409 card_required
//   GET    /api/clubs/{club}/subscription/invoices   — владелец: история счетов с чеками
//   GET    /api/platform/subscriptions               — оператор и Андрей: клубы, долг, MRR, оплаты за месяц, планы
//   POST   /api/platform/subscriptions/{club}/mark-paid {invoice_id, reason, document} — Андрей; оплачен — 409 invoice_paid
//   PUT    /api/platform/subscriptions/{club}/price  {price_per_table_kopecks | null, reason} — Андрей
//   PUT    /api/platform/plans/{id}                  {title?, price_per_table_kopecks?, active?, reason?} — Андрей
// Ресепшн, бар и монтажник — 403. Без ключей магазина платформы — 503 billing_unavailable.
// Вебхук магазина платформы — api/routes/webhooks.mjs (/api/webhooks/yookassa-platform).

import { ROLES } from '../router.mjs';
import { billingConfig } from '../../server/billing/config.mjs';
import { disableAutopay, getSubscription, listInvoices, markPaid, platformList, setPrice, startCard, updatePlan } from '../../server/billing/service.mjs';

const MINUTE = 60_000;
const depsOf = (ctx) => ({ log: ctx.log, clock: ctx.clock });

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/subscription',
    auth: 'staff',
    roles: ROLES.MANAGER_UP,
    handler: async (ctx) => ({
      json: await getSubscription(ctx.db, { clubId: ctx.club, owner: ctx.roles.includes('owner'), now: ctx.clock.now(), config: billingConfig(ctx) }),
    }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/subscription/card',
    auth: 'staff',
    roles: ROLES.OWNER,
    rateLimit: { max: 10, windowMs: MINUTE },
    handler: async (ctx, req) => ({
      status: 201,
      json: await startCard(ctx.db, depsOf(ctx), billingConfig(ctx), { clubId: ctx.club, userId: ctx.user.id, body: req.body, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'DELETE',
    path: '/api/clubs/{club}/subscription/autopay',
    auth: 'staff',
    roles: ROLES.OWNER,
    handler: async (ctx, req) => ({
      json: await disableAutopay(ctx.db, depsOf(ctx), billingConfig(ctx), { clubId: ctx.club, userId: ctx.user.id, body: req.body, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/subscription/invoices',
    auth: 'staff',
    roles: ROLES.OWNER,
    handler: async (ctx) => ({ json: await listInvoices(ctx.db, { clubId: ctx.club, config: billingConfig(ctx) }) }),
  },
  {
    method: 'GET',
    path: '/api/platform/subscriptions',
    auth: 'platform',
    roles: ROLES.PLATFORM_OPERATOR,
    handler: async (ctx) => ({ json: await platformList(ctx.db, { now: ctx.clock.now(), config: billingConfig(ctx) }) }),
  },
  {
    method: 'POST',
    path: '/api/platform/subscriptions/{club}/mark-paid',
    auth: 'platform',
    roles: ROLES.PLATFORM_ADMIN,
    handler: async (ctx, req) => ({
      json: await markPaid(ctx.db, depsOf(ctx), billingConfig(ctx), { clubId: req.params.club, userId: ctx.user.id, body: req.body, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'PUT',
    path: '/api/platform/subscriptions/{club}/price',
    auth: 'platform',
    roles: ROLES.PLATFORM_ADMIN,
    handler: async (ctx, req) => ({
      json: await setPrice(ctx.db, depsOf(ctx), billingConfig(ctx), { clubId: req.params.club, body: req.body, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'PUT',
    path: '/api/platform/plans/{id}',
    auth: 'platform',
    roles: ROLES.PLATFORM_ADMIN,
    handler: async (ctx, req) => ({
      json: await updatePlan(ctx.db, depsOf(ctx), billingConfig(ctx), { planId: req.params.id, userId: ctx.user.id, body: req.body, now: ctx.clock.now() }),
    }),
  },
];
