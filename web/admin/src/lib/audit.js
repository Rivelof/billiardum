import { formatMoney, formatTime, formatDate } from '@billiardum/shared/format';
import { DECLINE_REASONS, SERVICE_REASONS, reasonLabel } from '@billiardum/shared/reasons';
import { METHOD_LABEL, minutesWords } from './words.js';

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

/**
 * Запись журнала для экрана. Поля сервера, которых нет в контракте явно, читаются бережно:
 * actor_name, resource_number (запрошены у backend-core), иначе — тип исполнителя.
 * @param {object} raw
 * @param {string} timeZone
 */
export function auditView(raw, timeZone) {
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

  const actorType = raw.actor_type ?? raw.actor?.type;
  const actorName = raw.actor_name ?? raw.actor?.name ?? ACTOR[actorType] ?? (actorType === 'staff' ? 'Сотрудник' : 'Система');
  const number = raw.resource_number ?? data.resource_number ?? null;
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
