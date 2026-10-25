// Сети клубов (M5.5, docs/contracts/m5-5-8.md №190–194). Логика — server/networks/.
//
// Сеть — личный вход владельца или управляющего сети (не PIN терминала):
//   GET    /api/networks                                  → { items: [{network_id, name, role, clubs, tariffs_mode, menu_mode}] }
//   POST   /api/networks {name}                           → 201 сеть; 409 networks_limit
//   GET    /api/networks/{network_id}                     → сеть (владелец, управляющий)
//   PATCH  /api/networks/{network_id} {name?, tariffs_mode?, menu_mode?, reason?} → сеть (владелец)
//   DELETE /api/networks/{network_id}                     → { ok, clubs_removed } (владелец, архив)
//   POST   /api/networks/{network_id}/clubs {club_id}     → 201 сеть; 403 не свой клуб; 409 club_in_network
//   DELETE /api/networks/{network_id}/clubs/{club_id}     → сеть
//   GET    /api/networks/{network_id}/managers            → { items } (владелец)
//   POST   /api/networks/{network_id}/managers {phone}    → 201 { id, status, phone_masked, expires_at, invite_url, invite_text }
//   DELETE /api/networks/{network_id}/managers/{member_id} → { ok }
//   GET    /api/networks/{network_id}/tariffs             → шаблон тарифов (владелец, управляющий)
//   PUT    /api/networks/{network_id}/tariffs {rules, reason?} → шаблон; 400 tariff_gap|tariff_overlap {club_id, …}, reason_required
//   DELETE /api/networks/{network_id}/tariffs             → шаблон снят (тарифы клубов остаются)
//   GET    /api/networks/{network_id}/menu                → шаблон меню (владелец, управляющий)
//   PUT    /api/networks/{network_id}/menu {products, reason?} → шаблон
//   DELETE /api/networks/{network_id}/menu                → шаблон снят
//   GET    /api/networks/{network_id}/dashboard?from&to&compare → вкладка «Сеть» (владелец, управляющий)
// Клуб:
//   GET    /api/clubs/{club}/network                      → { network: null | {...} } (владелец, управляющий клуба)
//   POST   /api/clubs/{club}/network/reset {scope: tariffs|menu, reason?} → клуб к шаблону сети
//
// Ошибки: 400 bad_request, 401, 403 (управляющий на действиях владельца, не свой клуб, PIN), 404 (нет
// доступа к сети), 409 club_in_network | networks_limit | duplicate | network_locked.

import { networkDashboard } from '../../server/networks/compare.mjs';
import {
  addClub,
  archiveNetwork,
  clubNetworkJson,
  createNetwork,
  inviteManager,
  listManagers,
  myNetworks,
  networkAccess,
  networkJson,
  removeClub,
  requireSession,
  revokeManager,
  updateNetwork,
} from '../../server/networks/service.mjs';
import {
  deleteMenuTemplate,
  deleteTariffTemplate,
  enforceTemplates,
  getMenuTemplate,
  getTariffTemplate,
  putMenuTemplate,
  putTariffTemplate,
  resetClub,
} from '../../server/networks/templates.mjs';

const MANAGER_UP = ['owner', 'manager'];
const WRITE = { max: 60, windowMs: 60_000 };
const TEMPLATE = { max: 30, windowMs: 60_000 };
const DASH = { max: 60, windowMs: 60_000 };
const id = (req) => req.params.network_id;

export const routes = [
  {
    method: 'GET',
    path: '/api/networks',
    auth: 'guest',
    handler: async (ctx) => {
      requireSession(ctx);
      return { json: { items: await myNetworks(ctx.db, ctx.user.id) } };
    },
  },
  { method: 'POST', path: '/api/networks', auth: 'guest', rateLimit: WRITE, handler: async (ctx, req) => ({ status: 201, json: await createNetwork(ctx, req.body) }) },
  {
    method: 'GET',
    path: '/api/networks/{network_id}',
    auth: 'guest',
    handler: async (ctx, req) => ({ json: await networkJson(ctx, id(req), await networkAccess(ctx, id(req))) }),
  },
  {
    method: 'PATCH',
    path: '/api/networks/{network_id}',
    auth: 'guest',
    rateLimit: WRITE,
    handler: async (ctx, req) => ({ json: await updateNetwork(ctx, id(req), req.body, { enforceTemplates }) }),
  },
  { method: 'DELETE', path: '/api/networks/{network_id}', auth: 'guest', rateLimit: WRITE, handler: async (ctx, req) => ({ json: await archiveNetwork(ctx, id(req)) }) },
  { method: 'POST', path: '/api/networks/{network_id}/clubs', auth: 'guest', rateLimit: WRITE, handler: async (ctx, req) => addClub(ctx, id(req), req.body) },
  {
    method: 'DELETE',
    path: '/api/networks/{network_id}/clubs/{club_id}',
    auth: 'guest',
    rateLimit: WRITE,
    handler: async (ctx, req) => ({ json: await removeClub(ctx, id(req), req.params.club_id) }),
  },
  { method: 'GET', path: '/api/networks/{network_id}/managers', auth: 'guest', handler: async (ctx, req) => ({ json: await listManagers(ctx, id(req)) }) },
  {
    method: 'POST',
    path: '/api/networks/{network_id}/managers',
    auth: 'guest',
    rateLimit: WRITE,
    handler: async (ctx, req) => ({ status: 201, json: await inviteManager(ctx, id(req), req.body) }),
  },
  {
    method: 'DELETE',
    path: '/api/networks/{network_id}/managers/{member_id}',
    auth: 'guest',
    rateLimit: WRITE,
    handler: async (ctx, req) => ({ json: await revokeManager(ctx, id(req), req.params.member_id) }),
  },
  { method: 'GET', path: '/api/networks/{network_id}/tariffs', auth: 'guest', handler: async (ctx, req) => ({ json: await getTariffTemplate(ctx, id(req)) }) },
  { method: 'PUT', path: '/api/networks/{network_id}/tariffs', auth: 'guest', rateLimit: TEMPLATE, handler: async (ctx, req) => ({ json: await putTariffTemplate(ctx, id(req), req.body) }) },
  { method: 'DELETE', path: '/api/networks/{network_id}/tariffs', auth: 'guest', rateLimit: TEMPLATE, handler: async (ctx, req) => ({ json: await deleteTariffTemplate(ctx, id(req)) }) },
  { method: 'GET', path: '/api/networks/{network_id}/menu', auth: 'guest', handler: async (ctx, req) => ({ json: await getMenuTemplate(ctx, id(req)) }) },
  { method: 'PUT', path: '/api/networks/{network_id}/menu', auth: 'guest', rateLimit: TEMPLATE, handler: async (ctx, req) => ({ json: await putMenuTemplate(ctx, id(req), req.body) }) },
  { method: 'DELETE', path: '/api/networks/{network_id}/menu', auth: 'guest', rateLimit: TEMPLATE, handler: async (ctx, req) => ({ json: await deleteMenuTemplate(ctx, id(req)) }) },
  {
    method: 'GET',
    path: '/api/networks/{network_id}/dashboard',
    auth: 'guest',
    rateLimit: DASH,
    handler: async (ctx, req) => ({ json: await networkDashboard(ctx, id(req), req.query) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/network',
    auth: 'staff',
    roles: MANAGER_UP,
    handler: async (ctx, req) => ({ json: await clubNetworkJson(ctx.db, req.params.club) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/network/reset',
    auth: 'staff',
    roles: MANAGER_UP,
    rateLimit: TEMPLATE,
    handler: async (ctx, req) => ({ json: await resetClub(ctx, req.params.club, req.body) }),
  },
];
