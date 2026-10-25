// Тревоги клуба (контракт M1 §7, §13; PRODUCT §8).
// raise(db, clubId, { type, level, resourceId?, data }) в транзакции вызывающего (контекст
// клуба clubId): строка bl.alarms, запись журнала alarm.raised, уведомление владельцам
// и управляющим, после коммита — событие alarm в SSE club:{id}. Пока тревога того же типа
// по тому же столу открыта, повтор только увеличивает счётчик (без журнала и уведомлений),
// кроме ручных действий (уведомляют всегда, №66) и критичной тревоги, о которой не
// уведомляли 10 минут (№75).

import { resourceName } from '../lib/resource-kinds.mjs';
import { appendAudit } from '../lib/audit.mjs';
import { afterCommit } from '../lib/store.mjs';
import { publish } from '../http/sse.mjs';
import { sendToClubStaff } from '../notify/index.mjs';

export const LEVELS = ['critical', 'important', 'info'];
export const NOTIFY_ROLES = ['owner', 'manager'];
/** Повтор открытой критичной тревоги уведомляет снова не чаще этого (decisions №75). */
export const RENOTIFY_CRITICAL_MS = 10 * 60_000;
const TYPE = /^[a-z][a-z0-9_.]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Тексты тревог (PRODUCT §8): номер стола и суть, без персональных данных. */
export const ALARM_TEXTS = {
  bypass_detected: 'Свет горит без игры — проверьте стол',
  lamp_fault: 'Лампа не горит при включённом свете',
  device_offline: 'Контроллер не на связи во время игры больше 2 минут',
  cmd_no_ack: 'Контроллер не отвечает на команды',
  bad_sig: 'Контроллер получил команду с неверной подписью',
  device_topic_mismatch: 'Контроллер прислал данные не своего клуба',
  device_seq_gap: 'Расхождение счётчика команд контроллера',
  outbox_failed: 'Сбой обработки события на сервере',
  payment_conflict: 'Оплата пришла, когда стол был занят: деньги возвращаются',
  service_light: 'Включён сервисный свет',
  manual_action: 'Ручное действие персонала',
  receipt_pending: 'Чек не пробит больше 10 минут',
  payment_mismatch: 'Платёж ЮKassa не совпал с заказом: проверьте оплату',
  refund_mismatch: 'Возврат ЮKassa не совпал с запросом: проверьте возврат',
  unlimited_overrun: 'Игра «Без лимита» дороже замороженной суммы',
  relay_fault: 'Реле не переключилось: проверьте контроллер стола',
  replayed_seq: 'Контроллер отклонил повтор старой команды',
  events_dropped: 'Контроллер потерял часть событий без связи',
  ota_failed: 'Обновление прошивки контроллера не установилось',
  offline_resume_denied: 'Контроллер не вернул игру после перезагрузки без связи',
  state_mismatch: 'Состояние стола не совпадает с сервером',
  light_without_session: 'Свет включён без оплаченной игры',
  payment_unapplied: 'Оплата получена, но игра не запущена: проверьте стол',
  // M2: касса и бар (backend-pos).
  discount_over_limit: 'Скидка выше лимита клуба',
  order_canceled: 'Отменён заказ бара',
  pos_refund: 'Возврат по продаже на кассе',
  bar_double_payment: 'Заказ бара оплачен дважды: нужен возврат',
  // M2: ККТ и смены (backend-kkt).
  cash_discrepancy: 'Расхождение кассы при закрытии смены',
  receipt_failed: 'Чек не пробит: ККТ вернула ошибку',
  receipt_unknown: 'Неизвестно, пробит ли чек: проверьте ККТ',
  receipt_double: 'Чек пробит дважды: проверьте ККТ',
  service_light_threshold: 'Сервисный свет за смену дольше порога клуба',
  kkt_shift_failed: 'ККТ не открыла или не закрыла смену',
  receipt_fd_conflict: 'Касса вернула номер документа, который уже есть у другого чека — проверьте чек на ленте',
  // M3: предоплата брони и пакеты (backend-money).
  settlement_receipt_failed: 'Не пробит чек зачёта предоплаты',
  // Ревью входа п. 5: подбор PIN на терминале.
  terminal_locked: 'Терминал ресепшена заблокирован: 10 неверных PIN за час. Разблокируйте в настройках клуба',
  // M4 (№147): матч турнира упёрся в предел света (конец турнира + время матча).
  tournament_match_overdue: 'Матч турнира затянулся: свет погаснет в конце отведённого времени',
  // M5.1 (№154): платёж подтверждён сверкой, а вебхука ЮKassa нет 10 минут.
  yookassa_webhook_missing: 'Вебхук ЮKassa не настроен: укажите адрес уведомлений в кабинете ЮKassa',
};

/**
 * Уровни по умолчанию (PRODUCT §8, decisions №66): если вызывающий не передал level.
 * Ручные действия — critical и уведомляют владельца всегда (№66, инвариант 8).
 */
export const ALARM_LEVELS = {
  bypass_detected: 'critical',
  device_offline: 'critical',
  bad_sig: 'critical',
  relay_fault: 'critical',
  state_mismatch: 'critical',
  light_without_session: 'critical',
  payment_unapplied: 'critical',
  outbox_failed: 'critical',
  service_light: 'critical',
  manual_action: 'critical',
  lamp_fault: 'important',
  replayed_seq: 'important',
  events_dropped: 'important',
  ota_failed: 'important',
  offline_resume_denied: 'important',
  receipt_pending: 'important',
  discount_over_limit: 'important',
  order_canceled: 'important',
  pos_refund: 'critical',
  bar_double_payment: 'important',
  cash_discrepancy: 'critical',
  receipt_failed: 'important',
  receipt_unknown: 'critical',
  receipt_double: 'critical',
  service_light_threshold: 'important',
  kkt_shift_failed: 'important',
  receipt_fd_conflict: 'critical',
  settlement_receipt_failed: 'important',
  terminal_locked: 'critical',
  tournament_match_overdue: 'important',
  yookassa_webhook_missing: 'important',
};

/**
 * Объект склейки по умолчанию: тревоги этих типов по разным чекам, платежам, продажам —
 * отдельные (ключ — поле data). Остальные склеиваются по типу и столу.
 */
export const DEDUPE_FIELDS = {
  receipt_unknown: 'receipt_id',
  receipt_failed: 'receipt_id',
  receipt_fd_conflict: 'receipt_id',
  receipt_double: 'receipt_id',
  settlement_receipt_failed: 'receipt_id',
  terminal_locked: 'terminal_id',
  payment_mismatch: 'payment_id',
  refund_mismatch: 'refund_id',
  unlimited_overrun: 'session_id',
  bar_double_payment: 'sale_id',
  bar_late_payment: 'sale_id',
  cash_discrepancy: 'shift_id',
  kkt_shift_failed: 'op_id',
};

/** Ключ склейки: явный dedupeKey или поле data по DEDUPE_FIELDS; null — тип + стол. */
export function dedupeKeyFor(type, data, dedupeKey) {
  if (dedupeKey !== undefined && dedupeKey !== null) {
    if (typeof dedupeKey !== 'string' || dedupeKey.length < 1 || dedupeKey.length > 200) throw new Error('alarms.raise: dedupeKey');
    return dedupeKey;
  }
  const field = DEDUPE_FIELDS[type];
  const v = field ? data?.[field] : undefined;
  return typeof v === 'string' && v.length > 0 && v.length <= 150 ? `${field.replace(/_id$/, '')}:${v}` : null;
}

/** Типы ручных действий персонала: уведомление владельцу при каждом подъёме. */
export const MANUAL_TYPES = new Set(['service_light', 'manual_action']);

/** Текст тревоги: «Стол 3: …» или «Корт 1: …» по виду ресурса (M5.8); без вида — стол. */
export function alarmText(type, tableNumber, resourceType = null) {
  const text = ALARM_TEXTS[type] ?? `Тревога: ${type}`;
  return tableNumber ? `${resourceName(resourceType, tableNumber)}: ${text}` : text;
}

export function alarmJson(row) {
  return {
    id: row.id,
    club_id: row.club_id,
    type: row.type,
    level: row.level,
    resource_id: row.resource_id,
    resource_number: row.resource_number ?? null,
    resource_type: row.resource_type ?? null,
    data: row.data,
    state: row.state,
    count: row.count,
    raised_at: row.raised_at instanceof Date ? row.raised_at.toISOString() : row.raised_at,
    last_raised_at: row.last_raised_at instanceof Date ? row.last_raised_at.toISOString() : row.last_raised_at,
    acked_at: row.acked_at instanceof Date ? row.acked_at.toISOString() : (row.acked_at ?? null),
    acked_by: row.acked_by ?? null,
    last_notified_at: row.last_notified_at instanceof Date ? row.last_notified_at.toISOString() : (row.last_notified_at ?? null),
    text: alarmText(row.type, row.resource_number, row.resource_type),
  };
}

/**
 * Поднять тревогу.
 * @param {import('pg').ClientBase} db транзакция в контексте клуба clubId
 * @param {string} clubId
 * @param {{ type: string, level?: 'critical'|'important'|'info', resourceId?: string|null, data?: object,
 *           manual?: boolean, text?: string, dedupeKey?: string }} alarm
 *   dedupeKey — объект тревоги для склейки повторов (по умолчанию DEDUPE_FIELDS: receipt:<id>,
 *   payment:<id> …; иначе тип + стол).
 *   level — по умолчанию из ALARM_LEVELS (иначе important); manual — ручное действие персонала
 *   (по умолчанию для service_light и manual_action): владелец и управляющий получают уведомление
 *   при каждом вызове, даже если тревога этого типа по столу уже открыта; text — текст уведомления
 *   вместо стандартного (без персональных данных: телефоны вырезаются).
 * @returns {Promise<{ id: string, created: boolean, count: number, notified: boolean }>}
 */
export async function raise(db, clubId, { type, level, resourceId = null, data = {}, manual, text = null, dedupeKey }) {
  if (typeof clubId !== 'string' || !UUID.test(clubId)) throw new Error('alarms.raise: clubId');
  if (typeof type !== 'string' || !TYPE.test(type)) throw new Error('alarms.raise: type');
  level ??= ALARM_LEVELS[type] ?? 'important';
  if (!LEVELS.includes(level)) throw new Error('alarms.raise: level');
  if (text !== null && (typeof text !== 'string' || text.trim() === '')) throw new Error('alarms.raise: text');
  const isManual = manual ?? MANUAL_TYPES.has(type);
  const key = dedupeKeyFor(type, data, dedupeKey);
  if (resourceId !== null && !UUID.test(resourceId)) throw new Error('alarms.raise: resourceId');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('alarms.raise: data');
  const ctxClub = (await db.query('select bl.ctx_club_id() as club_id')).rows[0].club_id;
  if (ctxClub !== clubId) throw new Error('alarms.raise: транзакция не в контексте клуба тревоги');

  const { rows } = await db.query(
    `insert into bl.alarms (club_id, type, level, resource_id, data, dedupe_key)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (club_id, type, coalesce(resource_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(dedupe_key, '')) where state = 'open'
     do update set count = bl.alarms.count + 1, last_raised_at = now(), data = excluded.data
     returning *, (xmax = 0) as created, now() as db_now`,
    [clubId, type, level, resourceId, JSON.stringify(data), key],
  );
  const alarm = rows[0];
  if (resourceId) {
    const r = await db.query('select number, type from bl.resources where id = $1', [resourceId]);
    alarm.resource_number = r.rows[0]?.number ?? null;
    alarm.resource_type = r.rows[0]?.type ?? null;
  }
  if (alarm.created) {
    await appendAudit(db, {
      action: 'alarm.raised',
      objectType: 'alarm',
      objectId: alarm.id,
      actorType: 'system',
      actorId: null,
      data: { alarm_id: alarm.id, type, level, ...(resourceId ? { resource_id: resourceId } : {}) },
    });
  }
  // Новая тревога — уведомление; повтор открытой — только счётчик, кроме ручных действий
  // и критичной тревоги, о которой не напоминали 10 минут (№75).
  const critical = level === 'critical' || alarm.level === 'critical';
  const stale = !alarm.last_notified_at || alarm.db_now.getTime() - alarm.last_notified_at.getTime() >= RENOTIFY_CRITICAL_MS;
  const notified = alarm.created || isManual || (critical && stale);
  if (notified) {
    await db.query('update bl.alarms set last_notified_at = now() where id = $1', [alarm.id]);
    await sendToClubStaff(db, clubId, NOTIFY_ROLES, {
      kind: 'alarm',
      level,
      text: text ?? alarmText(type, alarm.resource_number, alarm.resource_type),
      data: { alarm_id: alarm.id, type, url: '/club/' },
    });
  }
  const json = alarmJson(alarm);
  await afterCommit(db, () => publish(`club:${clubId}`, 'alarm', json));
  return { id: alarm.id, created: alarm.created, count: alarm.count, notified };
}

/** Подтвердить тревогу (владелец, управляющий). Контекст — клуб тревоги. */
export async function ack(db, alarmId, userId) {
  const { rows } = await db.query(
    `update bl.alarms set state = 'acked', acked_at = now(), acked_by = $2
      where id = $1 and state = 'open'
      returning *`,
    [alarmId, userId],
  );
  if (rows.length === 0) return null;
  const alarm = rows[0];
  await appendAudit(db, {
    action: 'alarm.ack',
    objectType: 'alarm',
    objectId: alarm.id,
    actorType: 'user',
    actorId: userId,
    data: { alarm_id: alarm.id, type: alarm.type },
  });
  const json = alarmJson(alarm);
  await afterCommit(db, () => publish(`club:${alarm.club_id}`, 'alarm', json));
  return json;
}

export const alarms = { raise, ack };
