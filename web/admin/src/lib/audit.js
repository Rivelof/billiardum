import { formatMoney, formatTime, formatDate } from '@billiardum/shared/format';
import { DECLINE_REASONS, SERVICE_REASONS, lateRefundLabel, reasonLabel } from '@billiardum/shared/reasons';
import { METHOD_LABEL, ROLE_LABEL, minutesWords } from './words.js';

/** Действия журнала M1 (контракт §8) словами. */
export const ACTION_LABEL = {
  'device.cmd': 'Команда столу',
  'device.event': 'Событие контроллера',
  'device.seq_sync': 'Сверка счётчика команд',
  'session.start': 'Игра началась',
  'session.extend': 'Игра продлена',
  'session.stop': 'Гость закончил игру',
  'session.close': 'Игра закрыта',
  'session.interrupted': 'Игра прервана: стол без связи',
  'session.resolve': 'Решение гостя после обрыва',
  'payment.succeeded': 'Оплата прошла',
  'payment.canceled': 'Оплата отменена',
  'payment.refunded': 'Возврат денег',
  'reception.accept': 'Ресепшн принял оплату',
  'reception.decline': 'Ресепшн отклонил заявку',
  'service.start': 'Сервисный свет включён',
  'service.stop': 'Сервисный свет выключен',
  'manual.extend_free': 'Продление без оплаты',
  'alarm.raised': 'Тревога',
  'alarm.ack': 'Тревога принята',
  'device.bind': 'Контроллер привязан к столу',
  'device.claim': 'Контроллер подключился',
  'auth.staff_login': 'Вход сотрудника',
  'auth.pin_switch': 'Смена сотрудника по PIN',
  // M2: касса, бар, смены, склад, ККТ (имена действий сверяются с backend-pos и backend-kkt)
  'pos.sale': 'Продажа на кассе',
  'pos.refund': 'Возврат продажи',
  'pos.discount': 'Скидка на кассе',
  'manual.discount': 'Скидка выше лимита',
  'pos.sale_canceled': 'Продажа отменена',
  'pos.settings': 'Настройки кассы изменены',
  'order.create': 'Заказ со стола',
  'order.cancel': 'Заказ бара отменён',
  'tab.pay': 'Оплата счёта стола',
  'pos.discount_approval': 'Скидка подтверждена PIN управляющего',
  'kkt.receipt_retry': 'Чек ККТ повторён',
  'kkt.receipt_mark_printed': 'Чек ККТ отмечен пробитым',
  'manual.receipt_mark_printed': 'Чек ККТ отмечен пробитым вручную',
  'kkt.receipt_printed': 'Чек пробит на кассе',
  'kkt.receipt_failed': 'Чек не пробился',
  'kkt.receipt_unknown': 'Исход чека неизвестен',
  'kkt.shift_open': 'Смена ККТ открыта',
  'kkt.shift_close': 'Смена ККТ закрыта',
  'catalog.import': 'Меню загружено из CSV',
  'order.status': 'Статус заказа бара',
  'shift.open': 'Смена открыта',
  'shift.close': 'Смена закрыта',
  'stock.arrival': 'Приход на склад',
  'stock.writeoff': 'Списание со склада',
  'stock.audit': 'Ревизия склада',
  'menu.product': 'Товар меню изменён',
  'menu.stop_list': 'Стоп-лист изменён',
  'catalog.stop_list': 'Стоп-лист изменён',
  'catalog.product_create': 'Товар добавлен в меню',
  'catalog.product_update': 'Товар меню изменён',
  'catalog.category_create': 'Раздел меню добавлен',
  'catalog.category_update': 'Раздел меню изменён',
  'catalog.modifier_group_create': 'Группа модификаторов добавлена',
  'catalog.modifier_group_update': 'Группа модификаторов изменена',
  'catalog.modifier_create': 'Модификатор добавлен',
  'catalog.modifier_update': 'Модификатор изменён',
  'receipt.printed': 'Чек пробит на кассе',
  'receipt.failed': 'Чек не пробился',
  'kkt.bridge_register': 'Мост ККТ подключён',
  'kkt.bridge_revoke': 'Мост ККТ отключён',
  // M3: брони, очередь, пакеты, персонал, депозит, предоплата
  'booking.create': 'Бронь создана',
  'booking.confirm': 'Бронь подтверждена',
  'booking.reserve': 'Стол ждёт гостя по брони',
  'booking.start': 'Игра по брони началась',
  'booking.arrive': 'Гость по брони пришёл',
  'booking.cancel': 'Бронь отменена',
  'manual.booking_cancel': 'Бронь отменена сотрудником',
  'booking.expire': 'Бронь сгорела',
  'booking.complete': 'Бронь завершена',
  'booking.late_payment': 'Оплата брони пришла поздно — возврат',
  'manual.waitlist_release': 'Снято удержание стола для очереди',
  'manual.package_refund': 'Возврат пакета часов',
  'manual.receipt_retry': 'Чек зачёта отправлен повторно',
  'package.credited': 'Часы пакета начислены',
  'payment.forfeited': 'Предоплата удержана по правилам',
  'payment.settled': 'Предоплата зачтена',
  'payment.captured': 'Списание с карты',
  'reception.deposit': 'Депозит наличными',
  'reception.deposit_settled': 'Депозит рассчитан',
  'staff.invite': 'Сотрудник приглашён',
  'staff.invite_accepted': 'Приглашение принято',
  'staff.invite_revoked': 'Приглашение отозвано',
  'staff.role': 'Роль сотрудника изменена',
  'staff.revoke': 'Доступ сотрудника отозван',
  'tariff.package_created': 'Пакет часов в продаже',
  'tariff.package_archived': 'Пакет часов снят с продажи',
  // M4: турниры (server/tournaments/README.md) и споры по партиям Бильярдум+ (server/plus/README.md)
  'tournament.create': 'Турнир создан',
  'tournament.update': 'Турнир изменён',
  'tournament.publish': 'Турнир опубликован',
  'tournament.close': 'Запись на турнир закрыта',
  'tournament.entry': 'Запись на турнир',
  'tournament.entry_paid': 'Взнос за турнир оплачен',
  'tournament.entry_cancel': 'Запись на турнир отменена',
  'tournament.payment_refund': 'Взнос за турнир возвращён',
  'tournament.start': 'Турнир начался',
  'tournament.match_start': 'Матч турнира начался',
  'tournament.match_light_off': 'Свет матча турнира выключен',
  'tournament.score_report': 'Игрок внёс счёт матча',
  'tournament.dispute': 'Спор по счёту матча',
  'tournament.match_finished': 'Матч турнира сыгран',
  'tournament.groups_done': 'Групповой этап завершён',
  'tournament.finish': 'Турнир завершён',
  'tournament.winner_corrected': 'Победитель матча изменён',
  'manual.tournament_score': 'Счёт матча турнира исправлен',
  'manual.tournament_cancel': 'Турнир отменён',
  'manual.tournament_extend': 'Турнир продлён без оплаты',
  'manual.tournament_refund': 'Возврат взноса за турнир',
  'plus.match_resolve': 'Спор по партии решён',
  // M5.1–M5.2: подключение клуба, касса управляющего, экспорт, «Кто играл»
  'manual.tariff_change': 'Тариф изменён',
  'tariff.update': 'Тарифы сохранены',
  'manual.resource_add': 'Стол добавлен',
  'manual.resource_remove': 'Стол выведен из работы',
  'manual.resource_kind': 'Тип стола изменён',
  'manual.payment_settings': 'Настройки оплаты изменены',
  'manual.free_game': 'Бесплатная игра',
  'manual.item_remove': 'Удаление из чека',
  'manual.cancel': 'Отмена',
  'manual.refund': 'Возврат',
  'guest.lookup': 'Просмотрен телефон гостя',
  'cashbook.entry': 'Запись в кассе управляющего',
  'cashbook.storno': 'Сторно в кассе управляющего',
  'cashbook.collection': 'Инкассация из смены',
  'cashbook.category_create': 'Статья кассы добавлена',
  'cashbook.category_update': 'Статья кассы изменена',
  'owner.export': 'Выгрузка отчёта',
};

/** Ручные действия (инвариант 8) — подсвечиваются в журнале. */
export const MANUAL_ACTIONS = new Set(['service.start', 'service.stop', 'manual.extend_free', 'manual.discount', 'manual.receipt_mark_printed', 'pos.discount_approval', 'pos.sale_canceled', 'payment.refunded', 'pos.refund', 'order.cancel', 'stock.writeoff', 'kkt.receipt_retry', 'manual.tournament_score', 'manual.tournament_cancel', 'manual.tournament_extend', 'manual.tournament_refund', 'plus.match_resolve']);

/** Группы фильтра «Действие». В API уходит список через запятую, `*` — любое продолжение (запрошено у backend-core). */
export const ACTION_GROUPS = [
  { value: '', label: 'Все действия' },
  { value: 'service.*,manual.*,payment.refunded,pos.refund,pos.discount_approval,pos.sale_canceled,order.cancel,stock.writeoff,kkt.receipt_retry,plus.match_resolve', label: 'Ручные действия' },
  { value: 'payment.*,reception.*', label: 'Деньги' },
  { value: 'pos.*,shift.*,kkt.*,tab.*', label: 'Касса и смены' },
  { value: 'order.*,stock.*,catalog.*', label: 'Бар и склад' },
  { value: 'session.*', label: 'Игры' },
  { value: 'alarm.*', label: 'Тревоги' },
  { value: 'device.*', label: 'Контроллеры' },
  { value: 'auth.*', label: 'Вход персонала' },
];

const ACTOR = { guest: 'Гость', system: 'Система', device: 'Контроллер' };

/** Значение фильтра → шаблоны: 'service.*,manual.*' → ['service.*', 'manual.*']. */
export function actionPatterns(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Подходит ли действие под фильтр (`*` в конце — префикс). Для фильтрации на клиенте. */
export function matchesAction(value, action) {
  const pats = actionPatterns(value);
  if (!pats.length) return true;
  return pats.some((p) => (p.endsWith('*') ? String(action).startsWith(p.slice(0, -1)) : action === p));
}

/**
 * Параметр action для сервера старого вида (одно имя или префикс с точкой: «session.»).
 * Несколько шаблонов так не выразить — null, фильтруем на клиенте.
 */
export function legacyActionParam(value) {
  const pats = actionPatterns(value);
  if (pats.length !== 1) return pats.length ? null : undefined;
  return pats[0].endsWith('*') ? pats[0].slice(0, -1) : pats[0];
}

/** Исполнитель словами: имя, иначе роль и маска телефона (actor: {role, phone_masked}), иначе тип. */
export function actorLabel(raw) {
  if (raw.actor_name) return raw.actor_name;
  if (raw.actor?.name) return raw.actor.name;
  const role = raw.actor_role ?? raw.actor?.role;
  if (role) return `${ROLE_LABEL[role] ?? 'Сотрудник'}${raw.actor?.phone_masked ? `, ${raw.actor.phone_masked}` : ''}`;
  const t = raw.actor_type ?? raw.actor?.type;
  if (t === 'user' || t === 'staff') return 'Сотрудник';
  return ACTOR[t] ?? 'Система';
}

/**
 * Запись журнала для экрана. Поля §14 (actor_name, resource_number) читаются, если есть;
 * иначе стол — по data.resource_id или object_id через карту столов зала, исполнитель — роль и маска телефона.
 * @param {object} raw
 * @param {string} timeZone
 * @param {{ tables?: Map<string, number> }} [ctx] resource_id → номер стола
 */
export function auditView(raw, timeZone, ctx = {}) {
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const at = raw.created_at ?? raw.at;
  const details = [];
  if (Number.isSafeInteger(data.amount_kopecks)) details.push(formatMoney(data.amount_kopecks));
  if (data.method && METHOD_LABEL[data.method]) details.push(METHOD_LABEL[data.method]);
  if (Number.isFinite(data.minutes)) details.push(minutesWords(data.minutes));
  if (raw.action?.startsWith('service.') && data.reason_code) details.push(reasonLabel(SERVICE_REASONS, data.reason_code));
  if (raw.action === 'reception.decline' && data.reason_code) details.push(reasonLabel(DECLINE_REASONS, data.reason_code));
  if (data.type && raw.action?.startsWith('device.')) details.push(String(data.type));
  if (raw.action === 'manual.tournament_refund' && data.reason_code) details.push(lateRefundLabel(data.reason_code));
  if (data.paid_until) details.push(`до ${formatTime(data.paid_until, timeZone)}`);

  const actorName = actorLabel(raw);
  const tables = ctx.tables ?? new Map();
  const number =
    raw.resource_number ??
    data.resource_number ??
    tables.get(raw.resource_id) ??
    tables.get(data.resource_id) ??
    (raw.object_type === 'resource' ? tables.get(raw.object_id) : undefined) ??
    null;
  return {
    id: raw.id ?? `${raw.seq}`,
    seq: raw.seq ?? null,
    at,
    time: at ? formatTime(at, timeZone) : '',
    date: at ? formatDate(at, timeZone) : '',
    action: raw.action,
    title: ACTION_LABEL[raw.action] ?? raw.action ?? 'Действие',
    actor: actorName,
    table: number !== null && number !== undefined ? `Стол ${number}` : null,
    reason: raw.reason ?? null,
    details,
    manual: MANUAL_ACTIONS.has(raw.action),
    hash: typeof raw.hash === 'string' ? `${raw.hash.slice(0, 8)}…` : null,
  };
}

/** Записи по дням: [{ date: '21 октября', items: [...] }], порядок сохраняется. */
export function groupByDate(items) {
  const groups = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === it.date) last.items.push(it);
    else groups.push({ date: it.date, items: [it] });
  }
  return groups;
}

/**
 * Фильтры журнала из адреса (M5.2, переход из «Контроля» дашборда): ?group=manual — ручные действия,
 * ?period=today | yesterday | week, ?actor={id сотрудника}. Неизвестное — по умолчанию.
 */
export function journalLink(search) {
  const q = new URLSearchParams(search ?? '');
  const period = ['today', 'yesterday', 'week'].includes(q.get('period')) ? q.get('period') : 'today';
  const group = q.get('group') === 'manual' ? (ACTION_GROUPS.find((g) => g.label === 'Ручные действия')?.value ?? '') : '';
  const actor = /^[\w-]{1,64}$/.test(q.get('actor') ?? '') ? q.get('actor') : '';
  return { period, group, actor };
}
