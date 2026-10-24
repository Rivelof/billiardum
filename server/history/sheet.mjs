// Ведомость ревизии для печати (№174): товары с учётом остатка по группам (категориям меню),
// остаток по системе (в «слепой» ревизии — без него), пустая колонка «факт» — её заполняют от руки,
// ввод факта — существующий экран «Ревизия» (POST /api/stock/audits).

import { stockList } from '../stock/service.mjs';

/** @returns {Promise<{ club: {id, name}, blind: boolean, generated_at: string, groups: object[], items_count: number }>} */
export async function stockSheet(db, { clubId, blind = false, now = new Date() }) {
  const club = (await db.query('select id, name from bl.clubs where id = $1', [clubId])).rows[0] ?? null;
  const items = (await stockList(db, { clubId })).filter((p) => p.active);
  const cats = await db.query('select id, name, sort from bl.product_categories where club_id = $1', [clubId]);
  const byCat = new Map(cats.rows.map((c) => [c.id, { category_id: c.id, name: c.name, sort: c.sort ?? 0, items: [] }]));
  const none = { category_id: null, name: 'Без группы', sort: Number.MAX_SAFE_INTEGER, items: [] };
  for (const p of items) {
    const g = byCat.get(p.category_id) ?? none;
    g.items.push({ product_id: p.product_id, name: p.name, unit: p.unit, system_qty: blind ? null : p.qty, actual_qty: null });
  }
  const groups = [...byCat.values(), none]
    .filter((g) => g.items.length > 0)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'ru'))
    .map(({ sort: _s, ...g }) => ({ ...g, items: g.items.sort((a, b) => a.name.localeCompare(b.name, 'ru')) }));
  return { club: club ? { id: club.id, name: club.name } : null, blind, generated_at: now.toISOString(), groups, items_count: items.length };
}
