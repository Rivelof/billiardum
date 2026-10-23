// Подключение клуба без выезда (M5.1 backend-A, контракт m5-1.md §4; решения №152–154, №160).
//
//   POST /api/clubs {name, city_id | city_name, timezone, listing_id?} → {club_id, mode: 'test'}; 409 clubs_limit
//   GET  /api/clubs/claimable-listings → {items: [{listing_id, name, address, city, city_id, timezone}]} — карточки
//        с одобренной заявкой пользователя «Подтвердить клуб», ещё не связанные с клубом
//   GET  /api/clubs/{club}/onboarding → {mode, steps, checklist, payment_checks, shops, …} — владелец, управляющий
//   POST /api/clubs/{club}/go-live {accept_offer: true} → {mode: 'live', went_live_at}; 409 checklist_incomplete {failed}
//   GET  /api/clubs/{club}/payment-settings → {settings, shops: {test, live}} — владелец
//   PATCH /api/clubs/{club}/payment-settings {reception_enabled?, sbp_enabled?, card_enabled?, vat_code?, tax_system_code?, reason?}
//   GET|PUT /api/clubs/{club}/payment-settings/{test|live} {shop_id, secret_key?, reason?}
//        → {mode, shop_id, secret_mask: {last4, length}, verified_at, test, fiscalization, account_id}
//   POST /api/clubs/{club}/payment-settings/{test|live}/check → {payment_id, status, confirmation_url}
//   POST /api/platform/clubs/{club}/suspend {reason} | …/resume {reason, mode?} — platform_admin

import { ROLES } from '../router.mjs';
import { moneyConfig } from '../../server/payments/config.mjs';
import { neighbors } from '../../server/clubs/index.mjs';
import { claimableListings, createClub, goLive, onboarding, setSuspended } from '../../server/clubs/service.mjs';
import { createCheck, generalJson, getShop, patchGeneral, putShop, shopJson } from '../../server/clubs/shops.mjs';

const MINUTE = 60_000;
const offerVersion = (ctx) => ctx.config?.clubOfferVersion;
const depsOf = (ctx) => ({ log: ctx.log, clock: ctx.clock, alarms: ctx.alarms, audit: ctx.audit });

async function create(ctx, req) {
  const out = await createClub(ctx.db, depsOf(ctx), { userId: ctx.user.id, body: req.body });
  return { status: 201, json: out };
}

async function getOnboarding(ctx) {
  const json = await onboarding(ctx.db, {
    clubId: ctx.club,
    now: ctx.clock.now(),
    neighbors: await neighbors(ctx),
    config: { ...moneyConfig(ctx), offerVersion: offerVersion(ctx) },
    publicHost: ctx.config.publicHost,
    owner: ctx.roles.includes('owner'),
  });
  return { status: 200, json };
}

async function postGoLive(ctx, req) {
  const json = await goLive(ctx.db, depsOf(ctx), {
    clubId: ctx.club,
    userId: ctx.user.id,
    body: req.body,
    now: ctx.clock.now(),
    neighbors: await neighbors(ctx),
    config: { ...moneyConfig(ctx), offerVersion: offerVersion(ctx) },
  });
  return { status: 200, json };
}

async function getSettings(ctx) {
  const config = moneyConfig(ctx);
  const { rows } = await ctx.db.query('select * from bl.club_payment_settings where club_id = $1', [ctx.club]);
  const row = rows[0] ? { ...rows[0], club_id: ctx.club } : { club_id: ctx.club };
  return { status: 200, json: { settings: generalJson(row), shops: { test: shopJson(row, 'test', config.encKey), live: shopJson(row, 'live', config.encKey) } } };
}

async function patchSettings(ctx, req) {
  const json = await patchGeneral(ctx.db, { clubId: ctx.club, userId: ctx.user.id, body: req.body, now: ctx.clock.now(), manual: ctx.manual });
  return { status: 200, json };
}

async function getModeSettings(ctx, req) {
  return { status: 200, json: await getShop(ctx.db, { clubId: ctx.club, mode: req.params.mode, encKey: moneyConfig(ctx).encKey }) };
}

async function putModeSettings(ctx, req) {
  const json = await putShop(ctx.db, {
    clubId: ctx.club,
    userId: ctx.user.id,
    mode: req.params.mode,
    body: req.body,
    config: moneyConfig(ctx),
    now: ctx.clock.now(),
    manual: ctx.manual,
  });
  return { status: 200, json };
}

async function postCheck(ctx, req) {
  const json = await createCheck(ctx.db, {
    clubId: ctx.club,
    userId: ctx.user.id,
    mode: req.params.mode,
    config: moneyConfig(ctx),
    now: ctx.clock.now(),
    returnUrl: `https://${ctx.config.publicHost}/club/`,
  });
  return { status: 201, json };
}

const platform = (suspend) => async (ctx, req) => ({
  status: 200,
  json: await setSuspended(ctx.db, depsOf(ctx), { clubId: req.params.club, suspend, body: req.body }),
});

export const routes = [
  { method: 'POST', path: '/api/clubs', auth: 'guest', requires: ['phone'], rateLimit: { max: 30, windowMs: MINUTE }, handler: create },
  {
    method: 'GET',
    path: '/api/clubs/claimable-listings',
    auth: 'guest',
    handler: async (ctx) => ({ status: 200, json: await claimableListings(ctx.db, { userId: ctx.user.id }) }),
  },
  { method: 'GET', path: '/api/clubs/{club}/onboarding', auth: 'staff', roles: ROLES.MANAGER_UP, handler: getOnboarding },
  { method: 'POST', path: '/api/clubs/{club}/go-live', auth: 'staff', roles: ROLES.OWNER, rateLimit: { max: 10, windowMs: MINUTE }, handler: postGoLive },
  { method: 'GET', path: '/api/clubs/{club}/payment-settings', auth: 'staff', roles: ROLES.OWNER, handler: getSettings },
  { method: 'PATCH', path: '/api/clubs/{club}/payment-settings', auth: 'staff', roles: ROLES.OWNER, rateLimit: { max: 20, windowMs: MINUTE }, handler: patchSettings },
  { method: 'GET', path: '/api/clubs/{club}/payment-settings/{mode}', auth: 'staff', roles: ROLES.OWNER, handler: getModeSettings },
  { method: 'PUT', path: '/api/clubs/{club}/payment-settings/{mode}', auth: 'staff', roles: ROLES.OWNER, rateLimit: { max: 30, windowMs: MINUTE }, handler: putModeSettings },
  { method: 'POST', path: '/api/clubs/{club}/payment-settings/{mode}/check', auth: 'staff', roles: ROLES.OWNER, rateLimit: { max: 5, windowMs: MINUTE }, handler: postCheck },
  { method: 'POST', path: '/api/platform/clubs/{club}/suspend', auth: 'platform', roles: ROLES.PLATFORM_ADMIN, handler: platform(true) },
  { method: 'POST', path: '/api/platform/clubs/{club}/resume', auth: 'platform', roles: ROLES.PLATFORM_ADMIN, handler: platform(false) },
];
