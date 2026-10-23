// Ручное действие персонала (инвариант 8, PRODUCT §8.4, decisions №66, №125; M5.1 §3):
// причина обязательна, запись manual.* в журнал клуба и сразу тревога manual_action владельцу
// (уведомление при каждом действии, даже если такая тревога уже открыта).
//
// Роутер даёт обработчикам ctx.manual(entry) — эта функция в транзакции запроса и контексте клуба.
// Модули M5.1 (изменение тарифа, вывод стола, правка магазина ЮKassa в live) зовут её вместо
// своих копий «журнал + тревога».

import { HttpError } from '../http/errors.mjs';
import { alarms as defaultAlarms } from '../alarms/index.mjs';
import { appendAudit, MAX_REASON } from './audit.mjs';

const ACTION = /^manual\.[a-z][a-z0-9_]{0,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Причина ручного действия: непустая строка до 2000 символов, иначе 400 reason_required / bad_request. */
export function manualReason(reason) {
  if (reason === undefined || reason === null || (typeof reason === 'string' && reason.trim() === '')) {
    throw new HttpError(400, 'reason_required');
  }
  if (typeof reason !== 'string') throw new HttpError(400, 'bad_request', { detail: 'reason' });
  const why = reason.trim();
  if (why.length > MAX_REASON) throw new HttpError(400, 'bad_request', { detail: 'reason too long' });
  return why;
}

/**
 * @param {import('pg').ClientBase} db транзакция в контексте клуба clubId
 * @param {{ clubId: string, userId?: string|null, alarms?: { raise: Function } }} who
 * @param {{ action: string, reason: string, objectType?: string|null, objectId?: string|null, data?: object,
 *           text: string, level?: 'critical'|'important', resourceId?: string|null, dedupeKey?: string }} entry
 *   action — manual.*; text — текст уведомления владельцу (без персональных данных).
 * @returns {Promise<{ audit_id: string, alarm_id: string }>}
 */
export async function recordManual(db, { clubId, userId = null, alarms = defaultAlarms }, entry) {
  if (!UUID.test(clubId ?? '')) throw new Error('manual: нужен клуб в контексте');
  const { action, objectType = null, objectId = null, data = {}, text, level = 'critical', resourceId = null, dedupeKey } = entry ?? {};
  if (typeof action !== 'string' || !ACTION.test(action)) throw new Error('manual: action — manual.*');
  if (typeof text !== 'string' || text.trim() === '') throw new Error('manual: text');
  const reason = manualReason(entry.reason);
  const audit = await appendAudit(db, { action, objectType, objectId, reason, data, ...(userId ? { actorType: 'user', actorId: userId } : {}) });
  const alarm = await alarms.raise(db, clubId, {
    type: 'manual_action',
    level,
    manual: true,
    resourceId,
    data: { action, reason, staff_id: userId, ...data },
    text: `${text.trim()} Причина: ${reason}`,
    ...(dedupeKey ? { dedupeKey } : {}),
  });
  return { audit_id: audit.id, alarm_id: alarm.id };
}
