/**
 * M5.7 «API и вебхуки» для владельца (docs/contracts/m5-5-8.md, №199–202; формы — server/clubapi/README.md):
 * ключи API с правами, адреса вебхуков, журнал доставок. Логика без JSX — тестируется в Node (test/clubapi.test.mjs).
 */

import { plural } from '@billiardum/shared/format';

export const MAX_KEYS = 5;
export const MAX_WEBHOOKS = 10;
export const KEY_NAME_MAX = 100;
export const WEBHOOK_DESCRIPTION_MAX = 200;
export const DOCS_PATH = 'docs/api/club-api-v1.md';

/** Права ключа (server/clubapi/keys.mjs SCOPES) словами. */
export const SCOPE_LABEL = {
  'tables:read': 'Столы и их статус',
  'tariffs:read': 'Тарифы и цены',
  'availability:read': 'Свободное время для брони',
  'sales:read': 'Продажи по дням',
  'bookings:read': 'Брони без данных гостей',
};
export const SCOPES = Object.keys(SCOPE_LABEL);

/** События вебхуков (server/clubapi/webhooks.mjs EVENTS) словами; ping — тестовое. */
export const EVENT_LABEL = {
  'session.started': 'Игра началась',
  'session.ended': 'Игра закончилась',
  'booking.created': 'Бронь создана',
  'booking.canceled': 'Бронь отменена',
  'shift.closed': 'Смена закрыта',
  ping: 'Тестовое событие',
};
export const EVENTS = Object.keys(EVENT_LABEL).filter((e) => e !== 'ping');

/** Статус доставки словом (не только цветом). */
export const DELIVERY_STATUS = { pending: 'Ждёт попытки', delivered: 'Доставлено', failed: 'Не доставлено', canceled: 'Отменено' };
export const DELIVERY_FILTER = [
  { value: '', label: 'Все' },
  { value: 'pending', label: 'Ждут попытки' },
  { value: 'delivered', label: 'Доставлены' },
  { value: 'failed', label: 'Не доставлены' },
  { value: 'canceled', label: 'Отменены' },
];

/** Код ошибки доставки (README, «Коды ошибок доставки») словами. */
const DELIVERY_ERROR = {
  http: 'адрес ответил не 2xx',
  redirect: 'адрес ответил переадресацией — переадресации не выполняются',
  timeout: 'адрес не ответил за 10 секунд',
  dns: 'имя адреса не находится в DNS',
  connect_refused: 'сервер отказал в соединении',
  connect_reset: 'соединение оборвалось',
  unreachable: 'сервер недоступен',
  tls: 'ошибка сертификата HTTPS',
  url_forbidden: 'адрес стал внутренним — отправка запрещена',
  url_invalid: 'адрес некорректен',
  secret: 'не удалось прочитать секрет — выключите адрес и добавьте заново',
};

export function deliveryErrorText(error, httpStatus) {
  if (!error) return null;
  if (error === 'http' && Number.isInteger(httpStatus)) return `адрес ответил ${httpStatus}`;
  if (DELIVERY_ERROR[error]) return DELIVERY_ERROR[error];
  if (String(error).startsWith('net:')) return `ошибка сети (${String(error).slice(4)})`;
  return 'ошибка доставки';
}

const KEYS = ['ключ', 'ключа', 'ключей'];
const HOOKS = ['адрес', 'адреса', 'адресов'];

/** «Активно 2 ключа из 5». */
export function keysCountText(active, limit = MAX_KEYS) {
  return `Активно ${active} ${plural(active, KEYS)} из ${limit}`;
}
export function hooksCountText(active, limit = MAX_WEBHOOKS) {
  return `Включено ${active} ${plural(active, HOOKS)} из ${limit}`;
}

/** Проверка формы ключа: имя 1–100 знаков, хотя бы одно право. */
export function keyFormErrors({ name, scopes }) {
  const e = {};
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) e.name = 'Назовите ключ, например «CRM» или «Сайт клуба».';
  else if (n.length > KEY_NAME_MAX) e.name = `Имя — не длиннее ${KEY_NAME_MAX} знаков.`;
  if (!Array.isArray(scopes) || !scopes.some((s) => SCOPES.includes(s))) e.scopes = 'Отметьте хотя бы одно право.';
  return e;
}

/** Тело POST …/api-keys: права в порядке сервера. */
export function keyBody({ name, scopes }) {
  return { name: String(name ?? '').replace(/\s+/g, ' ').trim(), scopes: SCOPES.filter((s) => scopes.includes(s)) };
}

/**
 * Проверка адреса вебхука на клиенте (сервер проверяет строже, с DNS): только https, порт 443, без логина и пароля,
 * без #фрагмента, не localhost и не IP внутренней сети. → текст ошибки или null.
 */
export function webhookUrlError(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return 'Укажите адрес, например https://crm.example.ru/hooks/billiardum.';
  let u;
  try {
    u = new URL(s);
  } catch {
    return 'Это не похоже на адрес. Начните с https://';
  }
  if (u.protocol !== 'https:') return 'Только https:// — события подписаны, но без шифрования их видно по дороге.';
  if (u.username || u.password) return 'Уберите логин и пароль из адреса: подпись X-Bl-Signature уже подтверждает отправителя.';
  if (s.includes('#')) return 'Уберите часть после # — она не уходит на сервер.';
  if (u.port && u.port !== '443') return 'Только стандартный порт 443.';
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || /\.(local|localhost|internal|home\.arpa|lan)$/.test(host)) return 'Адрес должен быть доступен из интернета, а не только из вашей сети.';
  if (/^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^0\./.test(host) || host.startsWith('[')) return 'Внутренние адреса сети запрещены. Укажите публичный адрес сервера.';
  return null;
}

export function webhookFormErrors({ url, events, description }) {
  const e = {};
  const u = webhookUrlError(url);
  if (u) e.url = u;
  if (!Array.isArray(events) || !events.some((x) => EVENTS.includes(x))) e.events = 'Отметьте хотя бы одно событие.';
  if (String(description ?? '').trim().length > WEBHOOK_DESCRIPTION_MAX) e.description = `Описание — не длиннее ${WEBHOOK_DESCRIPTION_MAX} знаков.`;
  return e;
}

export function webhookBody({ url, events, description }) {
  const d = String(description ?? '').trim();
  return { url: String(url).trim(), events: EVENTS.filter((x) => events.includes(x)), ...(d ? { description: d } : {}) };
}

/** Ошибка сервера при регистрации адреса → поле формы и текст. */
export function webhookServerError(err) {
  if (err?.code === 'url_forbidden') return { url: 'Этот адрес ведёт во внутреннюю сеть — такие запрещены. Укажите публичный адрес сервера.' };
  if (err?.code === 'url_invalid') return { url: 'Адрес не принят: нужен https:// на порту 443, без логина и пароля, имя должно находиться в DNS.' };
  return null;
}

/** Последняя доставка адреса словами: «Доставлено 24 октября, 21:30 · 200». */
export function lastDeliveryWords(last, fmt) {
  if (!last) return 'Доставок ещё не было';
  const word = DELIVERY_STATUS[last.status] ?? last.status;
  const err = last.status === 'delivered' ? null : deliveryErrorText(last.error, last.http_status);
  return [word, last.at ? fmt(last.at) : null, last.status === 'delivered' && last.http_status ? String(last.http_status) : null, err].filter(Boolean).join(' · ');
}

/** Вход по PIN на терминале — выпустить ключ и добавить адрес нельзя (сервер — 403 forbidden). */
export const PERSONAL_LOGIN_TEXT = 'Ключи и адреса вебхуков выпускаются только при личном входе по телефону: при входе по PIN на терминале ресепшена это запрещено. Выйдите и войдите со своего телефона через бота.';
