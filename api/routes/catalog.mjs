// Каталог бара (контракт M2 §3, §4; decisions №76; backend-pos).
//   GET   /api/clubs/{club}/menu                      — без входа или любой вошедший: меню с остатками
//                                                       и стоп-листом; гостю без алкоголя (№76), персоналу — всё
//   GET   /api/clubs/{club}/catalog                   — управляющий и выше: весь каталог (и снятое с продажи)
//   POST  /api/clubs/{club}/catalog/categories        — управляющий и выше: {name, sort?}
//   PATCH /api/catalog/categories/{id}                — {name?, sort?, active?}
//   POST  /api/clubs/{club}/catalog/products          — {name, price_kopecks, category_id?, is_alcohol?, vat_code?,
//                                                       payment_subject?, unit?, stop_list?, track_stock?, photo?,
//                                                       sku?, description?, sort?, modifier_group_ids?}
//   PATCH /api/catalog/products/{id}                  — те же поля, частично; active: false — снять с продажи
//   POST  /api/catalog/products/{id}/stop-list        — бармен, ресепшн и выше: {stop_list: boolean} (№88; цены и состав — нет)
//   POST  /api/clubs/{club}/catalog/modifier-groups   — {name, min_select?, max_select?, sort?, modifiers?: [...]}
//   PATCH /api/catalog/modifier-groups/{id}           — {name?, min_select?, max_select?, sort?, active?}
//   POST  /api/catalog/modifier-groups/{id}/modifiers — {name, price_delta_kopecks?, stock_factor?, is_default?, sort?}
//   PATCH /api/catalog/modifiers/{id}                 — те же поля, частично; active
//   POST  /api/clubs/{club}/catalog/import            — {csv, dry_run?}: импорт меню из CSV (PRODUCT §16.4)
// Каждое изменение — журнал catalog.*.

import { ALL_ROLES } from '../router.mjs';
import { ROLES } from '../../server/orders/core.mjs';
import { menuFor } from '../../server/catalog/api.mjs';
import {
  createCategory,
  createGroup,
  createModifier,
  createProduct,
  fullCatalog,
  importCsv,
  setStopList,
  updateCategory,
  updateGroup,
  updateModifier,
  updateProduct,
} from '../../server/catalog/service.mjs';
import { PosError } from '../../server/orders/errors.mjs';
import { inClub, posRoute } from '../../server/orders/route.mjs';

const MANAGER = [...ROLES.MANAGER_UP];
const RECEPTION = [...ROLES.RECEPTION_UP];
// Бармен (№97): экран бара, статусы, стоп-лист — когда роль bar есть у core (api/router.mjs ALL_ROLES).
const BAR = ALL_ROLES.includes('bar') ? [...RECEPTION, 'bar'] : RECEPTION;

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/menu',
    auth: 'none',
    rateLimit: { max: 120, windowMs: 60_000 },
    handler: posRoute(async ({ db, info }) => {
      const { rowCount } = await db.query('select 1 from bl.clubs where id = $1', [info.clubId]);
      if (rowCount === 0) throw new PosError('not_found', 'club');
      const staff = info.roles.some((r) => BAR.includes(r));
      return menuFor(db, { clubId: info.clubId, audience: staff ? 'staff' : 'guest' });
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/catalog',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, info }) => fullCatalog(db, { clubId: info.clubId })),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/catalog/categories',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => createCategory(db, deps, info), { status: 201 }),
  },
  {
    method: 'PATCH',
    path: '/api/catalog/categories/{id}',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('product_categories'),
    handler: posRoute(({ db, deps, info }) => updateCategory(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/catalog/products',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => createProduct(db, deps, info), { status: 201 }),
  },
  {
    method: 'PATCH',
    path: '/api/catalog/products/{id}',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('products'),
    handler: posRoute(({ db, deps, info }) => updateProduct(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/catalog/products/{id}/stop-list',
    auth: 'staff',
    roles: BAR,
    findClub: inClub('products'),
    handler: posRoute(({ db, deps, info }) => setStopList(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/catalog/modifier-groups',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => createGroup(db, deps, info), { status: 201 }),
  },
  {
    method: 'PATCH',
    path: '/api/catalog/modifier-groups/{id}',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('modifier_groups'),
    handler: posRoute(({ db, deps, info }) => updateGroup(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/catalog/modifier-groups/{id}/modifiers',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('modifier_groups'),
    handler: posRoute(({ db, deps, info }) => createModifier(db, deps, info), { status: 201 }),
  },
  {
    method: 'PATCH',
    path: '/api/catalog/modifiers/{id}',
    auth: 'staff',
    roles: MANAGER,
    findClub: inClub('modifiers'),
    handler: posRoute(({ db, deps, info }) => updateModifier(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/catalog/import',
    auth: 'staff',
    roles: MANAGER,
    handler: posRoute(({ db, deps, info }) => importCsv(db, deps, info)),
  },
];
