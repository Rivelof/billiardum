import { familyOf } from '@billiardum/shared/resource';

/**
 * Какой ресурс в заявке ресепшену (M5.8, Д1): вид и номер. Заявку открывают и в новой вкладке, где нет
 * sessionStorage первой, поэтому источники по порядку: ответ сервера (resource_family / resource_type /
 * resource_number) → строка запроса адреса (?f=court&n=2) → состояние покупки этой вкладки.
 * @param {{ req?: object | null, search?: string, flow?: object }} src
 * @returns {{ family: 'table' | 'court', number: number | null }}
 */
export function requestResource({ req, search = '', flow = {} } = {}) {
  const q = new URLSearchParams(search);
  const fromServer = req && (req.resource_family || req.resource_type) ? { family: req.resource_family, type: req.resource_type } : null;
  const queryFamily = q.get('f') === 'court' || q.get('f') === 'table' ? q.get('f') : null;
  const family = fromServer ? familyOf(fromServer) : queryFamily ?? (flow.family ? familyOf(flow.family) : 'table');
  const num = (v) => (Number.isInteger(Number(v)) && v !== null && v !== undefined && v !== '' && Number(v) > 0 ? Number(v) : null);
  const number = num(req?.resource_number) ?? num(q.get('n')) ?? num(flow.number);
  return { family, number };
}

/** Строка запроса для адреса заявки: ?f=court&n=2 — вид и номер переживают открытие в новой вкладке. */
export function requestSearch({ family, number } = {}) {
  const q = new URLSearchParams();
  if (family === 'court' || family === 'table') q.set('f', family);
  if (Number.isInteger(number) && number > 0) q.set('n', String(number));
  const s = q.toString();
  return s ? `?${s}` : '';
}
