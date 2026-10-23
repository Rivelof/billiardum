// Касса ресепшена (контракт M2 §4, §5; decisions №81–83; backend-pos).
//   POST  /api/pos/sales                — ресепшн и выше, Idempotency-Key (клуб — X-Club-Id или единственный):
//                                         {items?: [{product_id, qty, modifier_ids?} | {kind: 'package', package_id, user_id | phone}],
//                                          tabs?: [session_id], requests?: [request_id],
//                                          discount?: {percent | amount_kopecks, reason?}, method: cash|card_terminal|sbp,
//                                          received_kopecks? (cash), customer_phone? (sbp), to_bar?, comment?}
//                                         пакет часов (M3): гость обязателен — 400 guest_required, только существующий —
//                                         409 guest_not_found (№117); до 5 пакетов; скидка
//                                         на пакет не действует; после оплаты минуты на балансе гостя (packages в ответе)
//                                         → продажа; без открытой смены — 409 shift_closed; sbp — status pending и
//                                           confirmation {type: qr, confirmation_data}
//   GET   /api/pos/sales/{id}           — ресепшн и выше: продажа (СБП ждёт — сверка с ЮKassa)
//   POST  /api/pos/sales/{id}/refund    — управляющий и выше, Idempotency-Key: {reason, items?: [{order_item_id, qty}]}
//                                         packages?: [idx] — возврат нетронутого пакета часов (№118): 409 package_used, already_refunded
//   GET   /api/clubs/{club}/pos/sales   — ресепшн и выше: продажи (?from&to&limit)
//   POST  /api/pos/sales/{id}/cancel    — ресепшн и выше: снять QR неоплаченной СБП-продажи (№98) {reason?}
//   GET   /api/clubs/{club}/staff/approvers — ресепшн и выше: кто подтверждает скидку PIN [{user_id, name, role}]
//   POST  /api/pos/discount-approvals   — ресепшн и выше: {user_id, pin, reason_code, reason_text, percent | amount_kopecks}
//                                         → {approval_id, expires_at} (5 минут, одноразовое; №95); в продаже discount.approval_id
//   GET   /api/clubs/{club}/pos/settings   — ресепшн и выше (чтение: лимит скидки): настройки кассы клуба
//   PATCH /api/clubs/{club}/pos/settings   — владелец: {discount_limit_percent?, stop_at_zero?, tab_limit_kopecks?, receipt_email?}

import { ROLES } from '../../server/orders/core.mjs';
import { PosError } from '../../server/orders/errors.mjs';
import { cancelSaleByStaff, createSale, listSales, refundSale, saleView, settleSale } from '../../server/orders/pos.mjs';
import { createApproval, listApprovers } from '../../server/orders/approvals.mjs';
import { inClub, posRoute } from '../../server/orders/route.mjs';
import { loadClub, readPosSettings, validatePosSettingsPatch } from '../../server/orders/settings.mjs';

const RECEPTION = [...ROLES.RECEPTION_UP];
const MANAGER = [...ROLES.MANAGER_UP];

function parseTime(v, name) {
  if (v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new PosError('bad_request', name);
  return d;
}

export const routes = [
  {
    method: 'POST',
    path: '/api/pos/sales',
    auth: 'staff',
    roles: RECEPTION,
    idempotent: true,
    handler: posRoute(({ db, deps, info }) => createSale(db, deps, info), { status: 201 }),
  },
  {
    method: 'GET',
    path: '/api/pos/sales/{id}',
    auth: 'staff',
    roles: RECEPTION,
    findClub: inClub('pos_sales'),
    handler: posRoute(async ({ db, deps, info }) => {
      const { rowCount } = await db.query('select 1 from bl.pos_sales where id = $1', [info.params.id]);
      if (rowCount === 0) throw new PosError('not_found', 'sale');
      await settleSale(db, deps, info.params.id, { sync: true });
      return saleView(db, info.params.id);
    }),
  },
  {
    method: 'POST',
    path: '/api/pos/sales/{id}/refund',
    auth: 'staff',
    roles: MANAGER,
    idempotent: true,
    findClub: inClub('pos_sales'),
    handler: posRoute(({ db, deps, info }) => refundSale(db, deps, info), { status: 201 }),
  },
  {
    method: 'POST',
    path: '/api/pos/sales/{id}/cancel',
    auth: 'staff',
    roles: RECEPTION,
    findClub: inClub('pos_sales'),
    handler: posRoute(({ db, deps, info }) => cancelSaleByStaff(db, deps, info)),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/staff/approvers',
    auth: 'staff',
    roles: RECEPTION,
    handler: posRoute(({ db, info }) => listApprovers(db, { clubId: info.clubId })),
  },
  {
    method: 'POST',
    path: '/api/pos/discount-approvals',
    auth: 'staff',
    roles: RECEPTION,
    rateLimit: { max: 20, windowMs: 60_000 },
    // R-1: PIN проверяется в транзакции запроса (одно соединение пула), отказ — ответом с коммитом счётчика.
    handler: posRoute(({ db, deps, info, ctx }) => createApproval(db, deps, info, { pepper: ctx.config.pinPepper }), { status: 201 }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/pos/sales',
    auth: 'staff',
    roles: RECEPTION,
    handler: posRoute(({ db, info }) => {
      const limit = Math.min(Math.max(Number.parseInt(info.query.limit ?? '50', 10) || 50, 1), 200);
      return listSales(db, { clubId: info.clubId, from: parseTime(info.query.from, 'from'), to: parseTime(info.query.to, 'to'), limit });
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/pos/settings',
    auth: 'staff',
    roles: RECEPTION,
    handler: posRoute(async ({ db, info }) => readPosSettings((await loadClub(db, info.clubId))?.settings)),
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/pos/settings',
    auth: 'staff',
    roles: [...ROLES.OWNER],
    handler: posRoute(async ({ db, deps, info }) => {
      const patch = validatePosSettingsPatch(info.body);
      if (!patch) throw new PosError('bad_request', 'settings');
      const before = readPosSettings((await loadClub(db, info.clubId))?.settings);
      await db.query('update bl.clubs set settings = settings || $2::jsonb where id = $1', [info.clubId, JSON.stringify(patch)]);
      const after = readPosSettings((await loadClub(db, info.clubId))?.settings);
      await deps.audit.appendAudit(db, {
        action: 'pos.settings',
        objectType: 'club',
        objectId: info.clubId,
        data: { before, after },
        actorType: 'user',
        actorId: info.userId,
      });
      return after;
    }),
  },
];
