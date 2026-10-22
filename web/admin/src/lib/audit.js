import { formatMoney, formatTime, formatDate } from '@billiardum/shared/format';
import { DECLINE_REASONS, SERVICE_REASONS, reasonLabel } from '@billiardum/shared/reasons';
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
};

/** Ручные действия (инвариант 8) — подсвечиваются в журнале. */
export const MANUAL_ACTIONS = new Set(['service.start', 'service.stop', 'manual.extend_free', 'payment.refunded']);

/** Группы фильтра «Действие». В API уходит список через запятую, `*` — любое продолжение (запрошено у backend-core). */
export const ACTION_GROUPS = [
  { value: '', label: 'Все действия' },
  { value: 'service.*,manual.*,payment.refunded', label: 'Ручные действия' },
  { value: 'payment.*,reception.*', label: 'Деньги' },
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
