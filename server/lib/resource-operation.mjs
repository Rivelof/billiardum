// Когда ресурс (стол, корт) «в работе» (№170, №187, M5.8): с создания, с учётом журнала вывода и возврата в работу.
// Общее для дашборда (ёмкость суток), утренней сводки и отчёта смены: корт, которого не было в эти сутки, в
// ёмкость не входит, стол, выведенный из работы, — с момента вывода. Журнал — события ресурса в bl.audit_log.

export const ACTIVATE = new Set(['resource.activate', 'manual.resource_add']);
export const DEACTIVATE = new Set(['resource.deactivate', 'manual.resource_remove']);
export const RESOURCE_EVENTS = ['resource.activate', 'resource.deactivate', 'manual.resource_add', 'manual.resource_remove'];

/**
 * Интервалы «в работе» ресурса [{from, to}] (мс) с создания до horizon.
 * events — записи журнала ресурса по порядку (action, created_at).
 */
export function operationIntervals(resource, events, horizon) {
  const out = [];
  const start = new Date(resource.created_at).getTime();
  const list = events.filter((e) => ACTIVATE.has(e.action) || DEACTIVATE.has(e.action));
  // Состояние до первого события — противоположное ему; без событий — текущее.
  let active = list.length ? DEACTIVATE.has(list[0].action) : Boolean(resource.active);
  let since = start;
  for (const e of list) {
    const t = Math.max(start, new Date(e.created_at).getTime());
    const next = ACTIVATE.has(e.action);
    if (active && !next && t > since) out.push({ from: since, to: t });
    if (!active && next) since = t;
    active = next;
  }
  if (active && horizon > since) out.push({ from: since, to: horizon });
  return out;
}

/** События ресурсов клуба по порядку записи: Map resource_id → [{ action, created_at }] (без кэша). */
export async function resourceEventsByResource(db, clubId) {
  const { rows } = await db.query(
    `select object_id, action, created_at from bl.audit_log
      where club_id = $1 and object_type = 'resource' and action = any($2::text[]) order by seq`,
    [clubId, RESOURCE_EVENTS],
  );
  const by = new Map();
  for (const e of rows) {
    if (!by.has(e.object_id)) by.set(e.object_id, []);
    by.get(e.object_id).push(e);
  }
  return by;
}

/** Миллисекунды, когда интервалы пересекают [from, to]. */
export function capacityMs(intervals, from, to) {
  let ms = 0;
  for (const x of intervals) ms += Math.max(0, Math.min(x.to, to) - Math.max(x.from, from));
  return ms;
}
