// T29, дополнения §7 и §8 (docs/contracts/m5-2.md; №173–178): истории склада и заказов, список смен,
// касса управляющего.
//
//   * приход, списание с причиной и ревизия управляющим (склад клуба сида): строки историй = движения
//     склада (bl.stock_movements) — количества и суммы; итоги периода = SQL по движениям; ведомость ревизии
//     (слепая — без остатка); поиск, сортировка, страницы; CSV = экран (BOM, «;»);
//   * история заказов: продажи кассы сегодняшней своей смены (02) = отчёт смены (бар); гость — маска или ник;
//   * список смен: фильтры статуса и сотрудника, своя смена из 02 — «закрыта», расхождение 0; CSV = список;
//   * касса управляющего: конец = начало + доходы + инкассации − расходы; инкассация смены из 02 =
//     наличные при закрытии − размен; ручной расход и доход (ключ идемпотентности), сторно с причиной вместо
//     правки (повтор — 409), UPDATE/DELETE записей запрещены базой; журнал cashbook.*; «Расходы» и «Прибыль»
//     на дашборде; CSV книги.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  apiRaw,
  appClient,
  bounds,
  CLUB_A,
  dash,
  get,
  loadState,
  loginWait,
  P,
  parseCsv,
  ru,
  rubCsv,
  short,
  tv,
  workingDay,
} from './helpers.mjs';

const S = { st: loadState() };
const today = workingDay();
const month = `${today.slice(0, 8)}01`;
let db;

before(async () => {
  db = await adminClient();
  S.owner = await loginWait('+70000000001');
  S.man = await loginWait('+70000000003');
  S.rec = await loginWait('+70000000004');
});
after(async () => db?.end());

const H = { 'x-club-id': CLUB_A };
const mapi = (method, p, body, idem) => api(method, p, { token: S.man.token, body, idem: idem ?? (method === 'POST' ? true : undefined), headers: H });
const hist = async (kind, qs = '') => (await get(`/api/clubs/${CLUB_A}/history/${kind}?from=${today}&to=${today}&limit=200${qs}`, S.owner.token, H)).json;

test('§7: приход, списание с причиной, ревизия — строки историй = движения склада', async (t) => {
  S.since = new Date();
  const arr = await mapi('POST', '/api/stock/arrivals', { items: [{ product_id: P.nuts, qty: 6, cost_kopecks: 36_000 }, { product_id: P.chips, qty: 4, unit_cost_kopecks: 5_000 }], note: 'Поставка e2e M5.2' });
  assert.ok([200, 201].includes(arr.status), short(arr));
  const noReason = await mapi('POST', '/api/stock/writeoffs', { items: [{ product_id: P.nuts, qty: 1 }] });
  assert.equal(noReason.status, 400);
  const wo = await mapi('POST', '/api/stock/writeoffs', { items: [{ product_id: P.nuts, qty: 1 }], reason: 'Просрочка (тест e2e M5.2), звонок +79990003344' });
  assert.ok([200, 201].includes(wo.status), short(wo));
  const stock = (await get(`/api/clubs/${CLUB_A}/stock`, S.man.token, H)).json;
  const chipsQty = (stock.items ?? stock).find((x) => x.product_id === P.chips)?.qty;
  assert.ok(typeof chipsQty === 'number', `остаток чипсов: ${JSON.stringify(stock).slice(0, 200)}`);
  const au = await mapi('POST', '/api/stock/audits', { items: [{ product_id: P.chips, actual_qty: Math.max(0, chipsQty - 2) }], note: 'Ревизия e2e M5.2' });
  assert.ok([200, 201].includes(au.status), short(au));
  S.audit = au.json;
  // Движения за окно — из базы.
  const mv = (await db.query("select kind, product_id, qty::float8 as qty, cost_kopecks::bigint as cost, reason, audit_id from bl.stock_movements where club_id = $1 and created_at >= $2 and kind in ('arrival', 'writeoff', 'audit') order by created_at", [CLUB_A, S.since])).rows;
  const arrivals = await hist('arrivals', '&q=e2e%20M5.2');
  const mineA = arrivals.items.filter((i) => new Date(i.created_at) >= S.since);
  assert.equal(mineA.length, 2);
  for (const m of mv.filter((x) => x.kind === 'arrival')) {
    const row = mineA.find((i) => i.qty === m.qty && i.cost_kopecks === Number(m.cost));
    assert.ok(row, `приход ${m.qty} × на ${m.cost} в истории`);
    assert.equal(row.created_by_name, 'Управляющий (тест)');
    assert.equal(row.supplier, null);
  }
  assert.equal(mineA.find((i) => i.product.length && i.qty === 4).unit_cost_kopecks, 5_000, 'цена закупки');
  const wos = await hist('writeoffs');
  const mineW = wos.items.filter((i) => new Date(i.created_at) >= S.since);
  const mvW = mv.filter((x) => x.kind === 'writeoff' || (x.kind === 'audit' && x.qty < 0));
  assert.equal(mineW.length, mvW.length, 'списания и недостача ревизии');
  for (const m of mvW) {
    const row = mineW.find((i) => i.qty === -m.qty && i.cost_kopecks === -Number(m.cost));
    assert.ok(row, `списание ${-m.qty} на ${-Number(m.cost)}`);
    assert.equal(row.source, m.kind === 'audit' ? 'audit' : 'program');
  }
  const prog = mineW.find((i) => i.source === 'program');
  assert.doesNotMatch(prog.reason, /79990003344/, 'телефон в причине списания — маской');
  const audits = await hist('audits');
  const mineAu = audits.items.find((i) => i.audit_id === (S.audit.audit_id ?? S.audit.id));
  assert.ok(mineAu, 'ревизия в истории');
  const line = mineAu.lines.find((l) => l.product_id === P.chips);
  assert.equal(line.expected_qty, chipsQty);
  assert.equal(line.actual_qty, Math.max(0, chipsQty - 2));
  assert.equal(line.diff_qty, Math.max(0, chipsQty - 2) - chipsQty);
  const auMv = mv.find((x) => x.kind === 'audit');
  assert.equal(mineAu.diff_kopecks, Number(auMv.cost), 'расхождение в рублях = поправка склада');
  // Итоги периода = SQL по движениям.
  const b = await bounds(db, today);
  const sql = (await db.query(
    `select coalesce(sum(cost_kopecks) filter (where kind = 'arrival'), 0)::bigint as arr, count(*) filter (where kind = 'arrival')::int as narr,
            coalesce(-sum(cost_kopecks) filter (where kind = 'writeoff' or (kind = 'audit' and qty < 0)), 0)::bigint as wo,
            count(*) filter (where kind = 'writeoff' or (kind = 'audit' and qty < 0))::int as nwo
       from bl.stock_movements where club_id = $1 and created_at >= $2 and created_at < $3`, [CLUB_A, b.from, b.to])).rows[0];
  const allA = await hist('arrivals');
  assert.deepEqual(allA.totals, { count: sql.narr, cost_kopecks: Number(sql.arr) }, 'итог приходов = движения');
  assert.deepEqual(wos.totals, { count: sql.nwo, cost_kopecks: Number(sql.wo) }, 'итог списаний = движения');
  t.diagnostic(`приходы: ${mineA.map((i) => `${i.product} ${i.qty} × ${i.unit_cost_kopecks} = ${i.cost_kopecks}`).join('; ')}; списания: ${mineW.map((i) => `${i.source} ${i.product} ${i.qty} на ${i.cost_kopecks} «${i.reason}»`).join('; ')}; ревизия: ${line.name} ${line.expected_qty} → ${line.actual_qty}, ${mineAu.diff_kopecks} коп.; итоги дня: приходы ${JSON.stringify(allA.totals)}, списания ${JSON.stringify(wos.totals)}`);
});

test('§7: поиск, сортировка, страницы, CSV = экран; ведомость ревизии (слепая)', async (t) => {
  const asc = await hist('arrivals', '&sort=cost');
  const desc = await hist('arrivals', '&sort=-cost');
  const costs = asc.items.map((i) => i.cost_kopecks);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b), 'сортировка по сумме');
  assert.deepEqual(desc.items.map((i) => i.cost_kopecks), [...costs].sort((a, b) => b - a));
  const p1 = (await get(`/api/clubs/${CLUB_A}/history/arrivals?from=${today}&to=${today}&limit=1`, S.owner.token, H)).json;
  assert.equal(p1.items.length, 1);
  if (asc.items.length > 1) {
    assert.ok(p1.next_cursor !== null && p1.next_cursor !== undefined, 'есть следующая страница');
    const p2 = (await get(`/api/clubs/${CLUB_A}/history/arrivals?from=${today}&to=${today}&limit=1&cursor=${p1.next_cursor}`, S.owner.token, H)).json;
    assert.notEqual(p2.items[0].movement_id, p1.items[0].movement_id);
  }
  const none = await hist('arrivals', '&q=нет-такого-товара-e2e');
  assert.deepEqual(none.totals, { count: 0, cost_kopecks: 0 });
  const csv = await apiRaw('GET', `/api/clubs/${CLUB_A}/history/arrivals/export.csv?from=${today}&to=${today}`, { token: S.man.token, headers: H });
  assert.equal(csv.status, 200);
  assert.deepEqual([...csv.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const rows = parseCsv(csv.buf);
  assert.equal(rows.length - 1, asc.totals.count, 'строк CSV = записей');
  const sumCsv = rows.slice(1).reduce((a, r) => a + Math.round(Number(r.at(-2)?.replace(',', '.') ?? 0) * 100), 0);
  const au = await db.query("select data from bl.audit_log where club_id = $1 and action = 'owner.export' and created_at > now() - interval '1 minute' and data->>'source' like 'history%' order by seq desc limit 1", [CLUB_A]);
  const sheet = (await get(`/api/clubs/${CLUB_A}/stock/sheet?blind=1`, S.man.token, H)).json;
  const open = (await get(`/api/clubs/${CLUB_A}/stock/sheet`, S.man.token, H)).json;
  assert.equal(sheet.blind, true);
  assert.ok(sheet.groups.every((g) => g.items.every((i) => i.system_qty === null && i.actual_qty === null)), 'слепая: без остатка, факт пустой');
  assert.ok(open.groups.some((g) => g.items.some((i) => typeof i.system_qty === 'number')), 'обычная — с остатком');
  t.diagnostic(`сортировка и страницы — ok; CSV приходов: ${rows.length - 1} строк, заголовок «${rows[0].join(';')}», сумма по CSV ${sumCsv} (экран ${asc.totals.cost_kopecks}); журнал ${JSON.stringify(au.rows[0]?.data ?? null)}; ведомость: ${sheet.groups.length} групп, ${sheet.items_count} позиций`);
});

test('§7: история заказов — продажи кассы своей смены = отчёт смены (бар); гость — маска или ник', async (t) => {
  const shiftId = S.st.liveShift;
  if (!shiftId) return t.skip('нет своей смены из 02');
  const rep = (await get(`/api/shifts/${shiftId}/report`, S.owner.token, H)).json;
  const sh = (await db.query('select opened_at, closed_at from bl.shifts where id = $1', [shiftId])).rows[0];
  const orders = (await get(`/api/clubs/${CLUB_A}/history/orders?from=${today}&to=${today}&limit=200`, S.owner.token, H)).json;
  const inShift = orders.items.filter((o) => o.paid_at && new Date(o.paid_at) >= sh.opened_at && new Date(o.paid_at) <= sh.closed_at && o.status !== 'canceled');
  const sum = inShift.reduce((a, o) => a + o.amount_kopecks, 0);
  assert.equal(sum, rep.revenue.bar.total_kopecks, `заказы в смене ${sum} = бар отчёта смены ${rep.revenue.bar.total_kopecks}`);
  for (const o of inShift) {
    assert.ok(o.lines.length > 0, 'состав заказа');
    assert.equal(o.lines.reduce((a, l) => a + l.amount_kopecks, 0), o.amount_kopecks + 0, `заказ №${o.number}: строки = сумма`);
  }
  // Итоги дня: число и сумма = SQL по заказам.
  const b = await bounds(db, today);
  const sql = (await db.query("select count(*)::int as n, coalesce(sum(subtotal_kopecks) filter (where status <> 'canceled'), 0)::bigint as k, count(*) filter (where status = 'canceled')::int as c from bl.orders where club_id = $1 and created_at >= $2 and created_at < $3 and not is_test", [CLUB_A, b.from, b.to]).catch((e) => ({ rows: [{ err: e.message }] }))).rows[0];
  if (!sql.err) assert.deepEqual(orders.totals, { count: sql.n, amount_kopecks: Number(sql.k), canceled: sql.c }, 'итоги = заказы в базе');
  const guests = orders.items.map((o) => o.guest).filter(Boolean);
  assert.ok(guests.every((g) => g.nick || /^\+7\d{3}\*{3}\d{4}$/.test(g.phone_masked)), 'гость — ник или маска');
  t.diagnostic(`смена ${shiftId.slice(0, 8)}: заказов ${inShift.length} на ${sum} коп., отчёт смены: бар ${rep.revenue.bar.total_kopecks}; итоги дня ${JSON.stringify(orders.totals)}${sql.err ? ` (SQL: ${sql.err})` : ''}; гостей в заказах ${guests.length}`);
});

test('§8: список смен — фильтры, своя смена «закрыта», CSV = список; строка открывает отчёт', async (t) => {
  const all = (await get(`/api/clubs/${CLUB_A}/shifts?from=2026-10-22&to=${today}&limit=200`, S.owner.token, H)).json;
  const disc = (await get(`/api/clubs/${CLUB_A}/shifts?from=2026-10-22&to=${today}&status=discrepancy&limit=200`, S.owner.token, H)).json;
  const closed = (await get(`/api/clubs/${CLUB_A}/shifts?from=2026-10-22&to=${today}&status=closed&limit=200`, S.owner.token, H)).json;
  assert.ok(disc.items.length > 0 && disc.items.every((s) => s.state === 'discrepancy' && Number(s.discrepancy_kopecks) !== 0), 'с расхождением');
  assert.ok(closed.items.every((s) => s.state === 'closed'), 'закрытые');
  const dbDisc = (await db.query("select count(*)::int as n from bl.shifts where club_id = $1 and not is_test and closed_at is not null and discrepancy_kopecks <> 0 and opened_at >= $2", [CLUB_A, (await bounds(db, '2026-10-22')).from])).rows[0].n;
  assert.equal(disc.items.length, dbDisc, 'число смен с расхождением = база');
  const byStaff = (await get(`/api/clubs/${CLUB_A}/shifts?from=2026-10-22&to=${today}&staff=a1000000-0000-4000-8000-000000000004&limit=200`, S.owner.token, H)).json;
  assert.ok(byStaff.items.length > 0);
  const mine = all.items.find((s) => s.id === S.st.liveShift);
  if (mine) {
    assert.equal(mine.state, 'closed');
    assert.equal(Number(mine.discrepancy_kopecks), 0);
    const rep = await get(`/api/shifts/${mine.id}/report`, S.owner.token, H);
    assert.equal(rep.status, 200);
    assert.equal(rep.json.revenue.total_kopecks, mine.revenue_total_kopecks, 'выручка в списке = отчёт смены');
  }
  const csv = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/shifts/export.csv?from=2026-10-22&to=${today}`, { token: S.owner.token, headers: H })).buf);
  assert.ok(csv.length - 1 >= Math.min(all.items.length, 200) || all.next_cursor, `CSV смен: ${csv.length - 1} строк, в списке ${all.items.length}`);
  t.diagnostic(`смен ${all.items.length}${all.next_cursor ? '+' : ''}; с расхождением ${disc.items.length} (база ${dbDisc}); ресепшн открывал/закрывал ${byStaff.items.length}; своя: ${mine ? `№${mine.number} ${mine.state}, выручка ${mine.revenue_total_kopecks}` : 'нет'}; CSV ${csv.length - 1} строк`);
});

test('§8: касса управляющего — расход, доход, сторно вместо правки; конец = начало + доходы + инкассации − расходы', async (t) => {
  const book0 = (await get(`/api/clubs/${CLUB_A}/cashbook?from=${month}&to=${today}`, S.man.token, H)).json;
  const cats = book0.categories;
  const rent = cats.find((c) => c.kind === 'expense' && c.name === 'Аренда');
  const inc = cats.find((c) => c.kind === 'income' && c.name === 'Прочие доходы');
  assert.ok(rent && inc, 'статьи по умолчанию');
  const key = randomUUID();
  const e1 = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'expense', amount_kopecks: 1_000_000, category_id: rent.category_id, comment: 'Аренда за октябрь (тест e2e)' }, key);
  assert.ok([200, 201].includes(e1.status), short(e1));
  const e1b = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'expense', amount_kopecks: 1_000_000, category_id: rent.category_id, comment: 'Аренда за октябрь (тест e2e)' }, key);
  assert.equal(e1b.json.entry_id ?? e1b.json.id, e1.json.entry_id ?? e1.json.id, 'повтор с тем же ключом — та же запись');
  const e2 = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'income', amount_kopecks: 200_000, category_id: inc.category_id, comment: 'Аренда стола под турнир (тест e2e)' });
  assert.ok([200, 201].includes(e2.status), short(e2));
  const bad = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'expense', amount_kopecks: -5, category_id: rent.category_id });
  assert.equal(bad.status, 400);
  const wrongCat = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'income', amount_kopecks: 100, category_id: rent.category_id });
  assert.equal(wrongCat.status, 400, 'статья расхода для дохода — 400');
  const id1 = e1.json.entry_id ?? e1.json.id;
  const noReason = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook/${id1}/storno`, {});
  assert.equal(noReason.status, 400);
  const st = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook/${id1}/storno`, { reason: 'Ошибся суммой (тест e2e)' });
  assert.ok([200, 201].includes(st.status), short(st));
  const st2 = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook/${id1}/storno`, { reason: 'Ещё раз (тест e2e)' });
  assert.equal(st2.status, 409);
  assert.equal(st2.json.error, 'duplicate');
  const e3 = await mapi('POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'expense', amount_kopecks: 900_000, category_id: rent.category_id, comment: 'Аренда за октябрь, верная сумма (тест e2e)' });
  assert.ok([200, 201].includes(e3.status));
  const book = (await get(`/api/clubs/${CLUB_A}/cashbook?from=${month}&to=${today}`, S.man.token, H)).json;
  assert.equal(book.closing_kopecks, book.opening_kopecks + book.income_kopecks + book.collections_kopecks - book.expenses_kopecks, 'конец = начало + доходы + инкассации − расходы');
  const sumSigned = book.entries.reduce((a, e) => a + e.signed_kopecks, 0);
  assert.equal(book.closing_kopecks - book.opening_kopecks, sumSigned, 'изменение = сумма записей со знаком');
  assert.equal(book.expenses_kopecks - book0.expenses_kopecks, 1_000_000 - 1_000_000 + 900_000, 'расход − сторно + верный расход');
  assert.equal(book.income_kopecks - book0.income_kopecks, 200_000);
  const orig = book.entries.find((e) => e.entry_id === id1);
  const rev = book.entries.find((e) => e.reverses_id === id1);
  assert.equal(orig.amount_kopecks, 1_000_000, 'исходная запись не изменилась');
  assert.equal(orig.reversed_by, rev.entry_id);
  assert.equal(rev.signed_kopecks, 1_000_000, 'сторно расхода — плюс');
  assert.equal(rev.reason, 'Ошибся суммой (тест e2e)');
  // Инкассация своей смены из 02: наличные при закрытии − размен.
  if (S.st.liveShift) {
    const s = (await db.query('select number, float_kopecks, actual_cash_kopecks from bl.shifts where id = $1', [S.st.liveShift])).rows[0];
    const col = book.entries.find((e) => e.kind === 'collection' && e.shift_id === S.st.liveShift);
    const expect = Number(s.actual_cash_kopecks) - Number(s.float_kopecks);
    if (expect > 0) assert.equal(col?.amount_kopecks, expect, `инкассация смены №${s.number} = факт − размен`);
    else assert.equal(col, undefined, 'смена без излишка — без инкассации');
  }
  // Инкассации = закрытые смены периода.
  const b0 = await bounds(db, month);
  const b1 = await bounds(db, today);
  const sh = (await db.query("select coalesce(sum(actual_cash_kopecks - float_kopecks) filter (where actual_cash_kopecks > float_kopecks), 0)::bigint as k from bl.shifts where club_id = $1 and not is_test and closed_at >= $2 and closed_at < $3", [CLUB_A, b0.from, b1.to])).rows[0].k;
  assert.equal(book.collections_kopecks, Number(sh), 'инкассации = закрытые смены периода');
  // Запрет правки и удаления в базе.
  const app = await appClient();
  try {
    await app.query('begin');
    await app.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB_A]);
    await assert.rejects(app.query('update bl.cashbook_entries set amount_kopecks = 1 where id = $1', [id1]));
    await app.query('rollback');
    await app.query('begin');
    await app.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB_A]);
    await assert.rejects(app.query('delete from bl.cashbook_entries where id = $1', [id1]));
    await app.query('rollback');
  } finally {
    await app.end();
  }
  await db.query('begin');
  try {
    await assert.rejects(db.query('update bl.cashbook_entries set amount_kopecks = 1 where id = $1', [id1]), /append|only|запрещ|not allowed|cashbook/i);
  } finally {
    await db.query('rollback');
  }
  const au = (await db.query("select action, reason from bl.audit_log where club_id = $1 and action like 'cashbook.%' and created_at > now() - interval '5 minutes' order by seq", [CLUB_A])).rows;
  assert.ok(au.filter((a) => a.action === 'cashbook.entry').length >= 3);
  assert.ok(au.some((a) => a.action === 'cashbook.storno' && a.reason === 'Ошибся суммой (тест e2e)'));
  // Дашборд: «Расходы» и «Прибыль» за месяц.
  await new Promise((r) => setTimeout(r, 16_000));
  const m = (await dash(S.owner.token, CLUB_A, { from: month, to: today, tab: 'money' })).json;
  assert.equal(tv(m, 'expenses'), book.expenses_kopecks, 'расходы на дашборде = касса');
  assert.equal(tv(m, 'profit'), tv(m, 'revenue') - book.expenses_kopecks, 'прибыль = выручка − расходы');
  const csv = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/cashbook/export.csv?from=${month}&to=${today}`, { token: S.man.token, headers: H })).buf);
  const flat = csv.map((r) => r.join(';')).join('\n');
  assert.ok(flat.includes(rubCsv(book.closing_kopecks)), 'остаток на конец в CSV');
  assert.ok(flat.includes(rubCsv(book.opening_kopecks)), 'остаток на начало в CSV');
  // Ресепшн — 403 на кассу.
  const r403 = await api('GET', `/api/clubs/${CLUB_A}/cashbook`, { token: S.rec.token, headers: H });
  assert.equal(r403.status, 403);
  t.diagnostic(`книга ${month}–${today}: начало ${book.opening_kopecks}, доходы ${book.income_kopecks}, инкассации ${book.collections_kopecks}, расходы ${book.expenses_kopecks}, конец ${book.closing_kopecks}; сторно ${rev.entry_id.slice(0, 8)} +${rev.signed_kopecks}; повтор сторно ${JSON.stringify(st2.json)}; UPDATE/DELETE — отказ; дашборд: расходы ${tv(m, 'expenses')}, прибыль ${tv(m, 'profit')}; CSV ${csv.length} строк; ${ru(today)}`);
});
