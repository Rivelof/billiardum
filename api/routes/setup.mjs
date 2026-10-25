// Мастер подключения клуба, часть backend-B (M5.1 №155, №156): столы, план зала, тарифы.
// Логика — server/setup/. Только владелец и управляющий (шаблоны тарифов — любой вошедший).
//
//   GET   /api/clubs/{club}/resources        → { plan: {width_cm, height_cm}, resources: [стол] } — и выведенные из работы
//   POST  /api/clubs/{club}/resources        {number, kind, title?, plan_x?, plan_y?, plan_rotation?, reason?} → 201 стол
//   PATCH /api/clubs/{club}/resources/{id}   {number?, kind?, title?, plan_x?, plan_y?, plan_rotation?, active?, reason?} → стол
//   PUT   /api/clubs/{club}/hall             {width, height} (см) → { plan }
//   GET   /api/tariff-templates              → { defaults, slot, templates }
//   GET   /api/resource-kinds                → { kinds, families, slot_minutes, default_slot_minutes } — справочник видов (M5.8)
//   GET   /api/clubs/{club}/tariffs          → { timezone, day_start_local, rules, resource_rules, coverage }
//   PUT   /api/clubs/{club}/tariffs          {rules, reason?} → как GET; 400 tariff_gap | tariff_overlap {kind?, weekday, from, to}
//
// В режиме live: добавление, вывод и возврат стола и изменение тарифа — с причиной (reason),
// иначе 400 reason_required; журнал manual.* и тревога владельцу. В test — журнал без причины.

import { createResource, listResources, setHallSize, updateResource } from '../../server/setup/hall.mjs';
import { getTariffs, saveTariffs, templatesJson } from '../../server/setup/tariffs.mjs';
import { kindsJson } from '../../server/lib/resource-kinds.mjs';

const MANAGER_UP = ['owner', 'manager'];
const userId = (ctx) => ctx.user?.id ?? null;

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/resources',
    auth: 'staff',
    roles: MANAGER_UP,
    handler: async (ctx, req) => ({ status: 200, json: await listResources(ctx.db, { clubId: req.params.club }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/resources',
    auth: 'staff',
    roles: MANAGER_UP,
    rateLimit: { max: 120, windowMs: 60_000 },
    handler: async (ctx, req) => ({
      status: 201,
      json: await createResource(ctx.db, { clubId: req.params.club, userId: userId(ctx), body: req.body, now: ctx.clock.now(), ctx, log: ctx.log }),
    }),
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/resources/{id}',
    auth: 'staff',
    roles: MANAGER_UP,
    rateLimit: { max: 600, windowMs: 60_000 },
    handler: async (ctx, req) => ({
      status: 200,
      json: await updateResource(ctx.db, { clubId: req.params.club, userId: userId(ctx), resourceId: req.params.id, body: req.body, now: ctx.clock.now(), ctx, log: ctx.log }),
    }),
  },
  {
    method: 'PUT',
    path: '/api/clubs/{club}/hall',
    auth: 'staff',
    roles: MANAGER_UP,
    handler: async (ctx, req) => ({ status: 200, json: await setHallSize(ctx.db, { clubId: req.params.club, userId: userId(ctx), body: req.body }) }),
  },
  {
    // Справочник видов ресурсов (M5.8 №203): код, семья, слова «стол/стола/столов», «корт/корта/кортов».
    method: 'GET',
    path: '/api/resource-kinds',
    auth: 'none',
    handler: async () => ({ status: 200, json: kindsJson() }),
  },
  {
    method: 'GET',
    path: '/api/tariff-templates',
    auth: 'guest',
    handler: async () => ({ status: 200, json: templatesJson() }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/tariffs',
    auth: 'staff',
    roles: MANAGER_UP,
    handler: async (ctx, req) => ({ status: 200, json: await getTariffs(ctx.db, { clubId: req.params.club }) }),
  },
  {
    method: 'PUT',
    path: '/api/clubs/{club}/tariffs',
    auth: 'staff',
    roles: MANAGER_UP,
    rateLimit: { max: 60, windowMs: 60_000 },
    handler: async (ctx, req) => ({
      status: 200,
      json: await saveTariffs(ctx.db, { clubId: req.params.club, userId: userId(ctx), body: req.body, now: ctx.clock.now(), ctx, log: ctx.log }),
    }),
  },
];
