// Модуль каталога бара (backend-pos, контракт M2 §5): init(ctx) и stop() по образцу M1.
// Таймеров и подписок нет; маршруты — api/routes/catalog.mjs, функции — ./api.mjs (menuFor).

export { menuFor, resolveItems, alcoholAllowedForGuests } from './api.mjs';

export async function init(ctx) {
  ctx?.log?.info?.('catalog_started', {});
}

export async function stop() {}
