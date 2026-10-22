// POST /api/receipts/{id}/retry (дефект Д2): повтор чека зачёта предоплаты после отказа ЮKassa.
// Клуб — из контекста запроса (роутер: findClub по bl.receipts), строка чека — под RLS этого клуба.

import { enterClub, isUuid, requireIdempotencyKey, requireStaff } from './context.mjs';
import { MoneyError } from './errors.mjs';
import { retrySettlementReceipt } from './settle.mjs';

const MANAGER_ROLES = ['owner', 'manager'];

export async function retryReceipt(db, deps, info) {
  const id = info.params.id;
  if (!isUuid(id)) throw new MoneyError('not_found', 'receipt');
  requireIdempotencyKey(info);
  if (!info.clubId) throw new MoneyError('not_found', 'receipt');
  await enterClub(db, info.clubId);
  await requireStaff(db, info, info.clubId, MANAGER_ROLES);
  return retrySettlementReceipt(db, deps, { receiptId: id, reason: info.body?.reason, staffId: info.userId });
}
