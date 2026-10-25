// Касса управляющего (M5.2 №177) — владелец и управляющий; справочник статей правит владелец.
//   GET   /api/clubs/{club}/cashbook?from&to                → { period, opening_kopecks, income_kopecks, collections_kopecks,
//                                                              expenses_kopecks, closing_kopecks, by_category, entries, categories }
//   POST  /api/clubs/{club}/cashbook                        {kind: income|expense, amount_kopecks, category_id, date?, comment?} → запись
//   POST  /api/clubs/{club}/cashbook/{id}/storno            {reason} → запись сторно (повтор — 409 duplicate)
//   GET   /api/clubs/{club}/cashbook/categories             → [{category_id, kind, name, sort, active}]
//   POST  /api/clubs/{club}/cashbook/categories             {kind, name, sort?} — владелец
//   PATCH /api/clubs/{club}/cashbook/categories/{id}        {name?, sort?, active?} — владелец
//   GET   /api/clubs/{club}/cashbook/export.csv?from&to     — CSV (№172), журнал owner.export
// Изменяющие запросы — с Idempotency-Key (кроме PATCH статьи).

import { ROLES } from '../router.mjs';
import { addEntry, cashbookView, createCategory, listCategories, parsePeriod, stornoEntry, updateCategory } from '../../server/dashboard/cashbook.mjs';
import { rub, ruDateTime, toCsv } from '../../server/dashboard/csv.mjs';
import { loadClub } from '../../server/dashboard/store.mjs';
import { ruDate, workingDayOf } from '../../server/dashboard/time.mjs';

const MANAGER = [...ROLES.MANAGER_UP];
const OWNER = [...ROLES.OWNER];
const KIND_LABELS = { income: 'доход', expense: 'расход', collection: 'инкассация' };

async function club(ctx) {
  return loadClub(ctx.db, ctx.club);
}

export const routes = [
  {
    method: 'GET',
    path: '/api/clubs/{club}/cashbook',
    auth: 'staff',
    roles: MANAGER,
    handler: async (ctx, req) => {
      const c = await club(ctx);
      const now = ctx.clock.now();
      const p = parsePeriod(req.query, workingDayOf(now, c.timezone, c.day_start_local));
      return { json: await cashbookView(ctx.db, c, { ...p, now }) };
    },
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/cashbook',
    auth: 'staff',
    roles: MANAGER,
    idempotent: true,
    handler: async (ctx, req) => ({ status: 201, json: await addEntry(ctx.db, { club: await club(ctx), userId: req.user.id, body: req.body, now: ctx.clock.now() }) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/cashbook/{id}/storno',
    auth: 'staff',
    roles: MANAGER,
    idempotent: true,
    handler: async (ctx, req) => ({
      status: 201,
      json: await stornoEntry(ctx.db, { club: await club(ctx), userId: req.user.id, entryId: req.params.id, reason: req.body?.reason, now: ctx.clock.now() }),
    }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/cashbook/categories',
    auth: 'staff',
    roles: MANAGER,
    handler: async (ctx) => ({ json: await listCategories(ctx.db, ctx.club, ctx.clock.now()) }),
  },
  {
    method: 'POST',
    path: '/api/clubs/{club}/cashbook/categories',
    auth: 'staff',
    roles: OWNER,
    idempotent: true,
    handler: async (ctx, req) => ({ status: 201, json: await createCategory(ctx.db, { clubId: ctx.club, userId: req.user.id, body: req.body, now: ctx.clock.now() }) }),
  },
  {
    method: 'PATCH',
    path: '/api/clubs/{club}/cashbook/categories/{id}',
    auth: 'staff',
    roles: OWNER,
    handler: async (ctx, req) => ({ json: await updateCategory(ctx.db, { clubId: ctx.club, userId: req.user.id, categoryId: req.params.id, body: req.body, now: ctx.clock.now() }) }),
  },
  {
    method: 'GET',
    path: '/api/clubs/{club}/cashbook/export.csv',
    auth: 'staff',
    // Экспорт — не управляющему сети (M5.5 №192).
    networkManager: false,
    roles: MANAGER,
    handler: async (ctx, req) => {
      const c = await club(ctx);
      const now = ctx.clock.now();
      const p = parsePeriod(req.query, workingDayOf(now, c.timezone, c.day_start_local));
      const v = await cashbookView(ctx.db, c, { ...p, now });
      const rows = [
        ['', '', 'Остаток на начало', '', rub(v.opening_kopecks), '', '', '', ''],
        ...v.entries.map((e) => {
          const t = ruDateTime(e.created_at, c.timezone);
          return [ruDate(e.date), KIND_LABELS[e.kind], e.category ?? 'Инкассации', e.comment ?? '', rub(e.signed_kopecks), e.reverses_id ? 'сторно' : '', e.reason ?? '', e.created_by_name ?? 'система', `${t.date} ${t.time}`];
        }),
        ['', '', 'Доходы', '', rub(v.income_kopecks), '', '', '', ''],
        ['', '', 'Инкассации', '', rub(v.collections_kopecks), '', '', '', ''],
        ['', '', 'Расходы', '', rub(-v.expenses_kopecks), '', '', '', ''],
        ['', '', 'Остаток на конец', '', rub(v.closing_kopecks), '', '', '', ''],
      ];
      const body = toCsv(['Дата', 'Вид', 'Статья', 'Комментарий', 'Сумма, ₽', 'Сторно', 'Причина', 'Кто', 'Внесено'], rows);
      await ctx.audit.appendAudit(ctx.db, {
        action: 'owner.export',
        objectType: 'club',
        objectId: ctx.club,
        data: { source: 'cashbook', table: 'cashbook', from: p.from, to: p.to, rows: v.entries.length },
      });
      return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="cashbook-${p.from}-${p.to}.csv"` }, body };
    },
  },
];
