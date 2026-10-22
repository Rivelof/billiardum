// Пакеты часов и баланс гостя (контракт M3 §4, backend-money; server/packages/service.mjs).

import { archivePackage, buyPackage, createPackage, listPackageLots, listPackages, MANAGER_ROLES, myBalance, refundLot } from '../../server/packages/service.mjs';
import { moneyRoute } from '../../server/payments/route.mjs';

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/packages',
    auth: 'none',
    handler: moneyRoute(({ db, deps, info }) => listPackages(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/packages',
    auth: 'staff',
    roles: [...MANAGER_ROLES],
    handler: moneyRoute(({ db, deps, info }) => createPackage(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/packages/{id}/archive',
    auth: 'staff',
    roles: [...MANAGER_ROLES],
    findClub: async (db, req) => (await db.query('select 1 from bl.tariff_packages where id = $1', [req.params.id])).rowCount > 0,
    handler: moneyRoute(({ db, deps, info }) => archivePackage(db, deps, info)),
  },
  {
    method: 'POST',
    path: '/api/packages/{id}/buy',
    auth: 'guest',
    requires: ['phone', 'consent'],
    idempotent: true,
    handler: moneyRoute(({ db, deps, info, config }) => buyPackage(db, deps, config, info)),
  },
  {
    // Партии гостя для экрана возврата (№118): только точный телефон, маска в ответе.
    // rateLimit — на IP; на сотрудника — 30 в минуту в обработчике.
    method: 'GET',
    path: '/api/clubs/{club}/package-lots',
    auth: 'staff',
    roles: [...MANAGER_ROLES],
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: moneyRoute(({ db, deps, info }) => listPackageLots(db, deps, info)),
  },
  {
    // Возврат пакета из приложения целиком (№118): партия отзывается, деньги — ЮKassa с чеком возврата.
    method: 'POST',
    path: '/api/packages/lots/{id}/refund',
    auth: 'staff',
    roles: [...MANAGER_ROLES],
    findClub: async (db, req) => (await db.query('select 1 from bl.balance_lots where id = $1', [req.params.id])).rowCount > 0,
    handler: moneyRoute(({ db, deps, info, config }) => refundLot(db, deps, config, info)),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/balance',
    auth: 'guest',
    handler: moneyRoute(({ db, deps, info }) => myBalance(db, deps, info)),
  },
];
