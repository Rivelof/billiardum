// Скидка выше лимита по PIN управляющего на терминале кассы (decisions №95, №82, инвариант 8).
//
// * GET /api/clubs/{club}/staff/approvers — кто может подтвердить: управляющие и владельцы клуба
//   с заданным PIN ([{user_id, name, role}]).
// * POST /api/pos/discount-approvals {user_id, pin, reason_code, reason_text, percent | amount_kopecks, subtotal_kopecks}
//   → {approval_id, expires_at, subtotal_kopecks, max_discount_kopecks}: одноразовое подтверждение на 5 минут. PIN проверяет core
//   (checkStaffPin из server/auth, роли owner и manager): своя транзакция, общий счётчик ошибок
//   с входом по PIN — 5 ошибок подряд блокируют PIN на 15 минут. Неверный PIN — 401, не
//   управляющий — 403, блокировка — 429 с Retry-After.
// * В продаже: discount.approval_id — подтверждение той же скидки (процент или сумма), не
//   использованное и не истёкшее; журнал manual.discount — от имени управляющего с его причиной,
//   тревога владельцу (useApproval вызывает касса, pos.mjs). Одобрение привязано к сумме корзины
//   (№100): корзина больше одобренной или скидка в копейках больше одобренной — 403.

import { checkStaffPin } from '../auth/index.mjs';
import { PIN } from '../auth/pin.mjs';
import { PosError } from './errors.mjs';
import { discountKopecks } from './money.mjs';
import { isUuid, MANAGER_ROLES } from './core.mjs';

export const APPROVAL_TTL_MS = 5 * 60_000;
const REASON_CODE = /^[a-z][a-z0-9_]{0,31}$/;
/** Коды причин, которые показывает касса (frontend); принимается любой код того же вида. */
export const DISCOUNT_REASON_CODES = Object.freeze(['regular_guest', 'promo', 'compensation', 'staff', 'other']);

export async function listApprovers(db, { clubId }) {
  const { rows } = await db.query(
    `select m.user_id, m.role, u.name from bl.club_members m join bl.users u on u.id = m.user_id
      where m.club_id = $1 and m.active and m.role = any($2::text[]) and m.pin_hash is not null
      order by case m.role when 'manager' then 0 else 1 end, u.name nulls last, m.user_id`,
    [clubId, MANAGER_ROLES],
  );
  return rows.map((r) => ({ user_id: r.user_id, name: r.name ?? null, role: r.role }));
}

function parseDiscount(b) {
  const hasPercent = b.percent !== undefined && b.percent !== null;
  const hasAmount = b.amount_kopecks !== undefined && b.amount_kopecks !== null;
  if (hasPercent === hasAmount) throw new PosError('bad_request', 'percent или amount_kopecks');
  if (hasPercent && (!Number.isInteger(b.percent) || b.percent < 1 || b.percent > 100)) throw new PosError('bad_request', 'percent');
  if (hasAmount && (!Number.isSafeInteger(b.amount_kopecks) || b.amount_kopecks < 1 || b.amount_kopecks > 100_000_000)) {
    throw new PosError('bad_request', 'amount_kopecks');
  }
  return { percent: hasPercent ? b.percent : null, amount: hasAmount ? b.amount_kopecks : null };
}

/**
 * POST /api/pos/discount-approvals → { approval_id, expires_at }. PIN проверяет core
 * (checkStaffPin, своя транзакция: счётчик ошибок не откатывается вместе с запросом).
 * @param {{ pool, withContext?, pepper }} pin доступ к пулу и «перец» PIN (ctx.pool, ctx.withContext, ctx.config.pinPepper)
 */
export async function createApproval(db, deps, info, { pool, withContext, pepper }) {
  const b = info.body ?? {};
  const { user_id: approverId, pin } = b;
  if (!isUuid(approverId) || typeof pin !== 'string' || !PIN.test(pin)) throw new PosError('bad_request', 'user_id, pin');
  const reasonCode = b.reason_code;
  if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) throw new PosError('reason_required', 'reason_code');
  const reasonText = typeof b.reason_text === 'string' ? b.reason_text.trim() : '';
  if (!reasonText) throw new PosError('reason_required', 'reason_text');
  if (reasonText.length > 2000) throw new PosError('bad_request', 'reason_text');
  const { percent, amount } = parseDiscount(b);
  // Сумма корзины (бар), на которую дана скидка (№100): одобрение не переносится на корзину крупнее.
  const subtotal = b.subtotal_kopecks;
  if (!Number.isSafeInteger(subtotal) || subtotal < 1 || subtotal > 100_000_000) throw new PosError('bad_request', 'subtotal_kopecks');
  if (amount !== null && amount > subtotal) throw new PosError('bad_request', 'скидка больше суммы корзины');
  const maxDiscount = percent !== null ? discountKopecks({ percent }, subtotal) : amount;
  const clubId = info.clubId;
  const now = deps.clock.now();
  const check = await checkStaffPin({ pool, withContext, clubId, userId: approverId, pin, roles: [...MANAGER_ROLES], pepper, now });
  if (!check.ok) {
    deps.log?.warn?.('discount_approval_rejected', { club_id: clubId, user_id: approverId, code: check.code, locked: Boolean(check.locked) });
    const status = { bad_request: 400, unauthorized: 401, forbidden: 403, rate_limited: 429 }[check.code] ?? 401;
    const err = new PosError(check.code ?? 'unauthorized', 'PIN управляющего', status);
    if (check.code === 'rate_limited' && check.retryAfterSec) err.headers = { 'retry-after': String(check.retryAfterSec) };
    throw err;
  }
  const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
  const { rows: ins } = await db.query(
    `insert into bl.pos_discount_approvals (club_id, approver_id, requested_by, reason_code, reason_text, percent, amount_kopecks,
                                            subtotal_kopecks, max_discount_kopecks, expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [clubId, approverId, info.userId, reasonCode, reasonText, percent, amount, subtotal, maxDiscount, expiresAt, now],
  );
  const approvalId = ins[0].id;
  await deps.audit.appendAudit(db, {
    action: 'pos.discount_approval',
    objectType: 'pos_discount_approval',
    objectId: approvalId,
    reason: reasonText,
    data: { approval_id: approvalId, reason_code: reasonCode, percent, amount_kopecks: amount, subtotal_kopecks: subtotal, max_discount_kopecks: maxDiscount, requested_by: info.userId },
    actorType: 'user',
    actorId: approverId,
  });
  deps.log?.info?.('discount_approval', { club_id: clubId, approval_id: approvalId });
  return { approval_id: approvalId, expires_at: expiresAt.toISOString(), subtotal_kopecks: subtotal, max_discount_kopecks: maxDiscount };
}

/**
 * Проверить подтверждение для продажи: та же скидка, не использовано, не истекло; mark(saleId)
 * отмечает использование. Неверное, чужое, истёкшее или использованное — 403 forbidden.
 * @returns {Promise<{ id, approver_id, reason_code, reason_text }>}
 */
export async function useApproval(db, { approvalId, discount, discountKopecks: applied, subtotal, at }) {
  if (!isUuid(approvalId)) throw new PosError('bad_request', 'discount.approval_id');
  const { rows } = await db.query('select * from bl.pos_discount_approvals where id = $1 for update', [approvalId]);
  const a = rows[0];
  if (!a) throw new PosError('forbidden', 'approval not found');
  if (a.used_at) throw new PosError('forbidden', 'approval used');
  if (new Date(a.expires_at).getTime() <= at.getTime()) throw new PosError('forbidden', 'approval expired');
  const samePercent = a.percent !== null && discount?.percent === a.percent && (discount.amount_kopecks === undefined || discount.amount_kopecks === null);
  const sameAmount = a.amount_kopecks !== null && discount?.amount_kopecks === Number(a.amount_kopecks) && (discount.percent === undefined || discount.percent === null);
  if (!samePercent && !sameAmount) throw new PosError('forbidden', 'approval: другая скидка');
  // №100: корзина не крупнее одобренной, скидка в копейках не больше одобренной.
  if (subtotal > Number(a.subtotal_kopecks)) throw new PosError('forbidden', 'approval: корзина больше одобренной');
  if (applied > Number(a.max_discount_kopecks)) throw new PosError('forbidden', 'approval: скидка больше одобренной');
  return {
    id: a.id,
    approver_id: a.approver_id,
    reason_code: a.reason_code,
    reason_text: a.reason_text,
    /** Отметить использование — после записи продажи (внешний ключ sale_id). */
    mark: (saleId) => db.query('update bl.pos_discount_approvals set used_at = $2, sale_id = $3 where id = $1', [a.id, at, saleId]),
  };
}
