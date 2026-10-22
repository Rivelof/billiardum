/**
 * Применить событие SSE `hall` к залу: сервер шлёт один стол или весь зал (контракт §7).
 * @param {object[] | null} hall
 * @param {object | object[]} data
 */
export function mergeHall(hall, data) {
  if (Array.isArray(data)) return data;
  if (!data?.resource?.id || !Array.isArray(hall)) return hall;
  const i = hall.findIndex((x) => x.resource.id === data.resource.id);
  if (i < 0) return [...hall, data];
  const next = hall.slice();
  next[i] = { ...hall[i], ...data };
  return next;
}
