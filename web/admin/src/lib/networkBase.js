/**
 * M5.5 «Сети» — то, что нужно основной сборке программы клуба (шапка, разделы, меню, отчёты): права управляющего сети,
 * числительные, причина ручного действия. Экран «Сеть» и вкладка дашборда — lib/networks.js и lib/networkDashboard.js
 * (свои чанки). Без JSX и DOM — тестируется в Node.
 */

import { plural } from '@billiardum/shared/format';
import { isNetworkManager } from './auth.js';

export { isNetworkManager };

const CLUBS = ['клуб', 'клуба', 'клубов'];
const PRODUCTS = ['товар', 'товара', 'товаров'];
const MANAGERS = ['управляющий', 'управляющих', 'управляющих'];

export const clubsWord = (n) => `${n} ${plural(n, CLUBS)}`;
export const productsWord = (n) => `${n} ${plural(n, PRODUCTS)}`;
export const managersWord = (n) => `${n} ${plural(n, MANAGERS)}`;

/** Пределы сервера (bl.network_create, bl.network_add_club, MAX_TEMPLATE_PRODUCTS). */
export const NETWORKS_MAX = 5;
export const CLUBS_MAX = 100;
export const TEMPLATE_PRODUCTS_MAX = 300;
export const NAME_MAX = 100;
export const REASON_MAX = 500;

export const PERSONAL_LOGIN_TEXT = 'Сеть клубов меняется только по личному входу. Войдите со своего телефона через MAX или Telegram — PIN терминала для этого не подходит.';

/** Боевой клуб (isLiveClub сервера): live, а приостановленный считаем бывшим боевым — причина не помешает. */
export const isLive = (club) => club?.live === true || club?.mode === 'live' || club?.mode === 'suspended';

/** Причина ручного действия: в боевом режиме обязательна (инвариант 8), до 500 символов. */
export function reasonError(reason, needed) {
  const r = String(reason ?? '').trim();
  if (needed && !r) return 'Клубы в боевом режиме: без причины изменение не сохранится.';
  if (r.length > REASON_MAX) return `Причина — до ${REASON_MAX} символов.`;
  return null;
}
/** Тело с причиной: пустую не шлём. */
export const withReason = (body, reason) => (String(reason ?? '').trim() ? { ...body, reason: String(reason).trim() } : body);

/** Нужен ли пункт «Сеть» в разделах: владелец клуба (может создать сеть), управляющий сети, участник любой сети. */
export function showNetworkNav(membership, networks) {
  return membership?.role === 'owner' || isNetworkManager(membership) || ((Array.isArray(networks) ? networks.length : 0) > 0 && membership?.role === 'manager');
}

/** Сводка «Все мои клубы» без «Денег»: только если все клубы выборки — через сеть (сервер иначе их просто исключит). */
export function moneyHiddenForAll(clubs) {
  const mine = (Array.isArray(clubs) ? clubs : []).filter((c) => c.role === 'owner' || c.role === 'manager');
  return mine.length > 0 && mine.every(isNetworkManager);
}

/** Клубы одной сети у управляющего сети — для переключателя клубов в шапке. */
export function networkSiblings(clubs, membership) {
  if (!isNetworkManager(membership)) return [];
  return (Array.isArray(clubs) ? clubs : []).filter((c) => c.network_id === membership.network_id);
}

/**
 * Выгрузки CSV (истории, смены, касса управляющего): управляющему сети — нет (№192). У «Все мои клубы» сервер сам
 * исключает клубы сети; если других клубов нет — кнопки тоже нет.
 */
export function exportAllowed({ all = false, club, clubs } = {}) {
  return all ? !moneyHiddenForAll(clubs) : !isNetworkManager(club);
}
