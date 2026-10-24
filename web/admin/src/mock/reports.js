/*
 * BL_MOCK_MARKER — заглушка отчётов M5.2 (только VITE_MOCK=1), docs/contracts/m5-2.md §7–§8, №173–179.
 * Формы ответов — допущения frontend (web/admin/README.md, раздел M5.2): истории заказов, ревизий, списаний и
 * приходов; список смен с фильтрами; касса управляющего со сторно; «Кто играл за столом».
 * Данные синтетические и детерминированные по дате, как у дашборда; гость — только маска телефона или ник.
 */

import { addDays, eachDay, isYmd, spanDays, weekday, workDate } from '../lib/period.js';
import { toCsv, csvMoney, csvDate } from '../lib/export.js';
import { rng } from './dashboard.js';
import { reportSeed, shiftRow } from './m2.js';

const MIN = 60_000;
const TZ = 'Asia/Yekaterinburg';
const PAGE = 50;
const NAMES = { reception: 'Анна К.', reception2: 'Игорь П.', manager: 'Ольга Р.', owner: 'Андрей' };
const NICKS = ['Свояк', 'Кикс', 'Шар_в_лузе', 'Пирамидон', 'Дуплет', 'Абриколь'];
const METHODS = ['sbp', 'card', 'cash', 'card_terminal'];

const pick = (r, list) => list[Math.floor(r() * list.length)];
const maskedPhone = (r) => `+7 *** ***-${String(Math.floor(r() * 100)).padStart(2, '0')}-${String(Math.floor(r() * 100)).padStart(2, '0')}`;
const localIso = (date, minutesFromMidnight) => new Date(Date.parse(`${date}T00:00:00+05:00`) + minutesFromMidnight * MIN).toISOString();

/** Расхождение 100 ₽ три дня назад (смена 211), смена 213 сошлась — для дашборда и списка смен. */
export function patchDashboardShifts(m2, empty) {
  if (!m2?.shifts) return;
  if (empty) {
    m2.shifts = [];
    return;
  }
  for (const s of m2.shifts) {
    const diff = s.number === 211 ? -10000 : 0;
    s.actual_cash_kopecks = s.expected_cash_kopecks + diff;
    s.discrepancy_kopecks = diff;
    s.close_comment = diff ? 'Пересчитали дважды, не хватает 100 ₽' : null;
    if (m2.reports?.[s.id]) m2.reports[s.id].shift = { ...m2.reports[s.id].shift, actual_cash_kopecks: s.actual_cash_kopecks, discrepancy_kopecks: diff, close_comment: s.close_comment };
  }
}

/** Отбор по поиску: без учёта регистра и «ё». */
const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');

function sortItems(items, sort, keys) {
  const desc = String(sort ?? '').startsWith('-');
  const key = String(sort ?? '-created_at').replace(/^-/, '');
  const get = keys[key] ?? keys.created_at;
  return [...items].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const c = typeof x === 'string' ? x.localeCompare(y, 'ru') : (x ?? -Infinity) - (y ?? -Infinity);
    return desc ? -c : c;
  });
}

function page(items, cursor) {
  const start = Number(cursor) || 0;
  const slice = items.slice(start, start + PAGE);
  return { items: slice, next_cursor: start + PAGE < items.length ? String(start + PAGE) : null };
}

export function reportsRoutes({ state, now, me, err, ok, audit, dash, manageOnly }) {
  const owner = (fn) => (m, b, q) => (!me() ? err(401, 'unauthorized') : me().role === 'owner' ? fn(m, b, q) : err(403, 'forbidden'));
  const empty = () => state().scenario === 'dashboard-empty' || state().scenario === 'empty';
  const today = () => workDate(now(), TZ, '06:00');
  const history = () => (state().scenario === 'dashboard-year' ? 400 : 90);
  const inHistory = (date) => !empty() && spanDays(date, today()) - 1 < history() && date <= today();
  const products = () => state().m2?.catalog?.products ?? [];
  const range = (q) => {
    const from = q.get('from');
    const to = q.get('to');
    if (!isYmd(from) || !isYmd(to) || from > to || spanDays(from, to) > 366) return null;
    return { from, to };
  };

  // ---------- истории (§7, №173) ----------
  const gen = {
    orders(date) {
      if (!inHistory(date)) return [];
      const r = rng(`orders:${date}`);
      const d = dash().day(date);
      const n = Math.min(60, d.barOrders || 0);
      const list = products().filter((p) => p.active !== false);
      const out = [];
      for (let i = 0; i < n; i += 1) {
        const source = r() < 0.6 ? 'qr' : 'pos';
        // Через QR алкоголь не продаётся (до заключения юриста), на кассе — да
        const menu = source === 'qr' ? list.filter((p) => !p.is_alcohol) : list;
        const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
          const p = pick(r, menu);
          const qty = 1 + (r() < 0.25 ? 1 : 0);
          return { name: p.name, qty, unit_price_kopecks: p.price_kopecks, amount_kopecks: p.price_kopecks * qty, modifiers: [] };
        });
        const amount = lines.reduce((s, l) => s + l.amount_kopecks, 0);
        const created = localIso(date, 12 * 60 + Math.floor(r() * 14 * 60));
        const roll = r();
        const age = now() - Date.parse(created);
        const status = roll < 0.03 ? 'canceled' : age < 20 * MIN ? 'preparing' : 'served';
        const guest = source === 'qr' ? (r() < 0.35 ? { nick: pick(r, NICKS), phone_masked: null } : { nick: null, phone_masked: maskedPhone(r) }) : null;
        out.push({
          order_id: `ord-${date}-${i}`,
          number: Number(date.slice(5).replace('-', '')) * 100 + i,
          created_at: created,
          canceled_at: status === 'canceled' ? new Date(Date.parse(created) + 6 * MIN).toISOString() : null,
          guest,
          resource_number: source === 'qr' ? 1 + Math.floor(r() * 8) : null,
          source,
          amount_kopecks: amount,
          method: source === 'qr' ? pick(r, ['sbp', 'card', 'tab']) : pick(r, ['cash', 'card_terminal', 'sbp']),
          status,
          cancel_reason: status === 'canceled' ? 'Гость передумал, заказ не готовили' : null,
          paid_at: status === 'canceled' ? null : created,
          created_by_name: source === 'pos' ? pick(r, [NAMES.reception, NAMES.reception2]) : null,
          canceled_by_name: status === 'canceled' ? NAMES.reception : null,
          lines,
        });
      }
      return out;
    },
    audits(date) {
      if (!inHistory(date) || weekday(date) !== 1) return [];
      const r = rng(`audit:${date}`);
      const lines = products()
        .filter((p) => p.track_stock)
        .map((p) => {
          const system = Math.round(5 + r() * 30);
          const diff = r() < 0.2 ? -1 - Math.floor(r() * 2) : r() < 0.05 ? 1 : 0;
          return { product_id: p.id, name: p.name, unit: p.unit, expected_qty: system, actual_qty: system + diff, diff_qty: diff, unit_cost_kopecks: p.cost_kopecks ?? 0, diff_kopecks: diff * (p.cost_kopecks ?? 0) };
        });
      return [{ audit_id: `aud-${date}`, created_at: localIso(date, 11 * 60 + 20), created_by_name: NAMES.manager, note: null, items: lines.length, mismatches: lines.filter((l) => l.diff_qty).length, diff_qty: lines.reduce((s, l) => s + l.diff_qty, 0), diff_kopecks: lines.reduce((s, l) => s + l.diff_kopecks, 0), lines }];
    },
    writeoffs(date) {
      if (!inHistory(date)) return [];
      const r = rng(`wo:${date}`);
      const out = [];
      const tracked = products().filter((p) => p.track_stock);
      if (r() < 0.35) {
        const p = pick(r, tracked);
        out.push({ movement_id: `wo-${date}-1`, created_at: localIso(date, 23 * 60 + 10), created_by_name: pick(r, [NAMES.reception, NAMES.reception2]), source: 'pos', product: p.name, unit: p.unit, qty: 1, reason: 'Брак: разбилась бутылка', audit_id: null, cost_kopecks: p.cost_kopecks ?? 0 });
      }
      if (r() < 0.2) {
        const p = pick(r, tracked);
        out.push({ movement_id: `wo-${date}-2`, created_at: localIso(date, 13 * 60), created_by_name: NAMES.manager, source: 'program', product: p.name, unit: p.unit, qty: 2, reason: 'Истёк срок годности', audit_id: null, cost_kopecks: (p.cost_kopecks ?? 0) * 2 });
      }
      for (const a of gen.audits(date)) {
        for (const l of a.lines.filter((x) => x.diff_qty < 0)) out.push({ movement_id: `wo-${a.audit_id}-${l.product_id}`, created_at: a.created_at, created_by_name: a.created_by_name, source: 'audit', product: l.name, unit: l.unit, qty: -l.diff_qty, reason: 'Недостача по ревизии', audit_id: a.audit_id, cost_kopecks: -l.diff_kopecks });
      }
      return out;
    },
    arrivals(date) {
      if (!inHistory(date) || weekday(date) !== 1) return [];
      const r = rng(`arr:${date}`);
      return products()
        .filter((p) => p.track_stock && r() < 0.55)
        .map((p, i) => {
          const qty = 6 + Math.floor(r() * 18);
          const cost = p.cost_kopecks ?? 0;
          return { movement_id: `arr-${date}-${i}`, created_at: localIso(date, 10 * 60 + 30), created_by_name: NAMES.manager, supplier: null, product: p.name, unit: p.unit, qty, unit_cost_kopecks: cost, cost_kopecks: cost * qty, note: r() < 0.3 ? 'Счёт поставщика № 214' : null };
        });
    },
  };

  const SORT = {
    orders: { created_at: (x) => Date.parse(x.created_at), amount: (x) => x.amount_kopecks, number: (x) => x.number, status: (x) => x.status, canceled_at: (x) => Date.parse(x.canceled_at ?? 0) },
    audits: { created_at: (x) => Date.parse(x.created_at), items: (x) => x.items, diff_kopecks: (x) => x.diff_kopecks, diff_qty: (x) => x.diff_qty },
    writeoffs: { created_at: (x) => Date.parse(x.created_at), cost: (x) => x.cost_kopecks, product: (x) => x.product, qty: (x) => x.qty, source: (x) => x.source },
    arrivals: { created_at: (x) => Date.parse(x.created_at), cost: (x) => x.cost_kopecks, product: (x) => x.product, qty: (x) => x.qty, unit_cost: (x) => x.unit_cost_kopecks },
  };
  // Поиск как у сервера: заказы — номер или товар; ревизии — товар или комментарий; списания и приходы — товар или причина
  const TEXT = {
    orders: (x) => [x.number, ...x.lines.map((l) => l.name)].join(' '),
    audits: (x) => [x.note, ...x.lines.map((l) => l.name)].join(' '),
    writeoffs: (x) => [x.product, x.reason].join(' '),
    arrivals: (x) => [x.product, x.note].join(' '),
  };

  function historyList(kind, q) {
    const rg = range(q);
    if (!rg) return null;
    let items = eachDay(rg.from, rg.to).flatMap((d) => gen[kind](d)).filter((x) => Date.parse(x.created_at) <= now());
    const text = norm(q.get('q')).trim();
    if (text) items = items.filter((x) => norm(TEXT[kind](x)).includes(text));
    const status = q.get('status');
    if (status && kind === 'orders') items = items.filter((x) => x.status === status);
    if (status && kind === 'writeoffs') items = items.filter((x) => x.source === status);
    items = sortItems(items, q.get('sort'), SORT[kind]);
    const totals = { count: items.length };
    if (kind === 'orders') Object.assign(totals, { amount_kopecks: items.filter((x) => x.status !== 'canceled').reduce((s, x) => s + x.amount_kopecks, 0), canceled: items.filter((x) => x.status === 'canceled').length });
    if (kind === 'audits') Object.assign(totals, { diff_kopecks: items.reduce((s, x) => s + x.diff_kopecks, 0), shortage_kopecks: items.reduce((s, x) => s + x.lines.filter((l) => l.diff_kopecks < 0).reduce((a, l) => a + l.diff_kopecks, 0), 0), surplus_kopecks: items.reduce((s, x) => s + x.lines.filter((l) => l.diff_kopecks > 0).reduce((a, l) => a + l.diff_kopecks, 0), 0) });
    if (kind === 'writeoffs' || kind === 'arrivals') totals.cost_kopecks = items.reduce((s, x) => s + x.cost_kopecks, 0);
    return { items, totals, period: rg };
  }

  const HISTORY_CSV = {
    orders: [['Номер', 'Дата', 'Дата отмены', 'Гость', 'Стол', 'Сумма, ₽', 'Способ', 'Статус', 'Состав'], (x) => [x.number, csvDate(x.created_at, TZ, true), csvDate(x.canceled_at, TZ, true), x.guest?.nick ?? x.guest?.phone_masked ?? '', x.resource_number ? `Стол ${x.resource_number}` : 'Касса', csvMoney(x.amount_kopecks), x.method, x.status, x.lines.map((l) => `${l.name} × ${l.qty}`).join(', ')]],
    audits: [['Дата', 'Провёл', 'Позиций', 'Расхождение, шт', 'Расхождение, ₽'], (x) => [csvDate(x.created_at, TZ, true), x.created_by_name, x.items, x.diff_qty, csvMoney(x.diff_kopecks)]],
    writeoffs: [['Дата', 'Кто списал', 'Источник', 'Товар', 'Количество', 'Причина', 'Сумма, ₽'], (x) => [csvDate(x.created_at, TZ, true), x.created_by_name, x.source, x.product, x.qty, x.reason, csvMoney(x.cost_kopecks)]],
    arrivals: [['Дата', 'Кто', 'Поставщик', 'Товар', 'Количество', 'Цена закупки, ₽', 'Сумма, ₽'], (x) => [csvDate(x.created_at, TZ, true), x.created_by_name, x.supplier ?? '', x.product, x.qty, csvMoney(x.unit_cost_kopecks), csvMoney(x.cost_kopecks)]],
  };

  // ---------- смены (№176) ----------
  const SHIFT_ID = /^5f000000-0000-4000-8000-(\d{8})(\d{4})$/;
  function genShifts(date) {
    if (!inHistory(date) || spanDays(date, today()) - 1 <= 3) return [];
    const d = dash().day(date);
    const r = rng(`sh:${date}`);
    const slots = [
      { slot: 1, open: 12 * 60, close: 20 * 60, who: weekday(date) % 2 ? 'reception' : 'reception2', part: 0.4 },
      { slot: 2, open: 20 * 60, close: 27 * 60, who: weekday(date) % 2 ? 'reception2' : 'reception', part: 0.6 },
    ];
    const number = 210 - (spanDays(date, today()) - 5) * 2;
    return slots.map((s, i) => {
      const cash = Math.round((d.methods.cash * s.part) / 100) * 100;
      const row = shiftRow({ opened: Date.parse(localIso(date, s.open)), closed: Date.parse(localIso(date, s.close)), float: 300000, cash, by: s.who, closer: s.who, actual: 300000 + cash, number: number - (1 - i) });
      row.id = `5f000000-0000-4000-8000-${date.replace(/-/g, '')}${String(s.slot).padStart(4, '0')}`;
      row.opened_by_name = NAMES[s.who];
      row.closed_by_name = NAMES[s.who];
      row.revenue_total_kopecks = Math.round(d.revenue * s.part);
      row.r = r;
      return row;
    });
  }
  function genReport(id) {
    const m = SHIFT_ID.exec(id);
    if (!m) return null;
    const date = `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6)}`;
    const s = genShifts(date).find((x) => x.id === id);
    if (!s) return null;
    const { r: _r, ...shift } = s;
    const d = dash().day(date);
    const part = Number(m[2]) === 1 ? 0.4 : 0.6;
    const k = (v) => Math.round((v * part) / 100) * 100;
    const t = d.tablesRevenue;
    const b = d.bar;
    return reportSeed(shift, {
      tablesCash: k(t * 0.24), tablesTerminal: k(t * 0.18), tablesSbp: k(t * 0.44), tablesCard: k(t * 0.14),
      barCash: k(b * 0.24), barTerminal: k(b * 0.18), barSbp: k(b * 0.44), barCard: k(b * 0.14),
      playMinutes: Math.round(d.playTotal * part), sessions: Math.round(d.games * part), service: [],
    });
  }
  const shiftState = (s) => (s.status === 'open' || !s.closed_at ? 'open' : s.discrepancy_kopecks ? 'discrepancy' : 'closed');
  function shiftsFiltered(q) {
    const rg = range(q);
    if (!rg) return null;
    const m2 = state().m2;
    const dayRevenue = (s) => Math.round((dash().day(workDate(Date.parse(s.opened_at), TZ, '06:00')).revenue * 0.5) / 100) * 100;
    const base = [...(m2.shift ? [{ ...m2.shift, status: 'open' }] : []), ...m2.shifts].map((s) => ({ ...s, revenue_total_kopecks: s.revenue_total_kopecks ?? dayRevenue(s) }));
    const inRange = (s) => {
      const d = workDate(Date.parse(s.opened_at), TZ, '06:00');
      return d >= rg.from && d <= rg.to;
    };
    let items = [...base.filter(inRange), ...eachDay(rg.from, rg.to).reverse().flatMap((d) => genShifts(d).reverse())]
      .map(({ r: _r, ...s }) => ({ ...s, is_test: false, state: shiftState(s) }))
      .filter((s) => Date.parse(s.opened_at) <= now());
    const staff = q.get('staff');
    if (staff) items = items.filter((s) => s.opened_by === staff || s.closed_by === staff);
    const status = q.get('status');
    if (status) items = items.filter((s) => s.state === status);
    items.sort((x, y) => Date.parse(y.opened_at) - Date.parse(x.opened_at));
    return items;
  }
  function shiftsList(q) {
    const items = shiftsFiltered(q);
    if (!items) return undefined; // без периода — список M2 (экран «Смены»)
    // Курсор сервера — номер смены: следующая страница — смены с меньшим номером
    const cursor = Number(q.get('cursor'));
    const rest = Number.isFinite(cursor) && q.get('cursor') ? items.filter((s) => s.number < cursor) : items;
    const pageItems = rest.slice(0, PAGE);
    return ok({ items: pageItems, next_cursor: rest.length > PAGE ? String(pageItems.at(-1).number) : null });
  }

  // ---------- касса управляющего (№177) — форма server/dashboard (entries, by_category, categories) ----------
  const DEFAULT_CATEGORIES = [
    ['rent', 'Аренда', 'expense'],
    ['utilities', 'Коммунальные', 'expense'],
    ['purchase', 'Закупка', 'expense'],
    ['salary', 'Зарплата', 'expense'],
    ['repair', 'Ремонт столов', 'expense'],
    ['other_expense', 'Прочее', 'expense'],
    ['other_income', 'Прочие доходы', 'income'],
    ['opening', 'Начальный остаток', 'income'],
  ];
  const cb = () => {
    const S = state();
    if (!S.cashbook) {
      S.cashbook = {
        categories: DEFAULT_CATEGORIES.map(([id, name, kind], i) => ({ category_id: `cat-${id}`, kind, name, sort: i + 1, active: true })),
        manual: [],
      };
    }
    return S.cashbook;
  };
  const catByName = (name) => cb().categories.find((c) => c.name === name);
  const entry = (o) => ({ comment: null, shift_id: null, reverses_id: null, reversed_by: null, reason: null, created_by: null, ...o, signed_kopecks: o.kind === 'expense' ? -o.amount_kopecks : o.amount_kopecks });
  function cashbookEntries(from, to) {
    const items = [];
    for (const date of eachDay(from, to)) {
      if (!inHistory(date)) continue;
      const d = dash().day(date);
      // Инкассации из смен — автоматически при закрытии смены (здесь — по понедельникам и четвергам за прошлые дни)
      if ([1, 4].includes(weekday(date))) {
        items.push(entry({ entry_id: `col-${date}`, date, kind: 'collection', category_id: null, category: 'Инкассация', amount_kopecks: Math.round([1, 2, 3, ...(weekday(date) === 1 ? [4] : [])].reduce((acc, k) => acc + dash().day(addDays(date, -k)).methods.cash, 0) / 100) * 100, comment: 'Наличные при закрытии смены минус размен', created_at: localIso(date, 11 * 60), created_by_name: 'Система' }));
      }
      for (const [i, e] of d.expenses.entries()) {
        const c = catByName(e.category);
        items.push(entry({ entry_id: `exp-${date}-${i}`, date, kind: 'expense', category_id: c?.category_id ?? null, category: e.category, amount_kopecks: e.amount, created_at: localIso(date, 15 * 60), created_by_name: e.category === 'Аренда' || e.category === 'Зарплата' ? NAMES.owner : NAMES.manager }));
      }
    }
    for (const m of cb().manual) if (m.date >= from && m.date <= to) items.push(m);
    const reversed = new Map(cb().manual.filter((m) => m.reverses_id).map((m) => [m.reverses_id, m.entry_id]));
    return items.map((x) => (reversed.has(x.entry_id) ? { ...x, reversed_by: reversed.get(x.entry_id) } : x)).sort((x, y) => (x.date === y.date ? Date.parse(y.created_at) - Date.parse(x.created_at) : x.date < y.date ? 1 : -1));
  }
  const sum = (list, kind) => list.filter((x) => x.kind === kind).reduce((s, x) => s + x.amount_kopecks, 0);
  function cashbookData(q) {
    const rg = range(q) ?? { from: `${today().slice(0, 8)}01`, to: today() };
    const historyStart = addDays(today(), -(history() - 1));
    const before = rg.from > historyStart ? cashbookEntries(historyStart, addDays(rg.from, -1)) : [];
    const opening = empty() ? 0 : 5000000 + sum(before, 'income') + sum(before, 'collection') - sum(before, 'expense');
    const entries = cashbookEntries(rg.from, rg.to);
    const income = sum(entries, 'income');
    const collections = sum(entries, 'collection');
    const expenses = sum(entries, 'expense');
    const byCat = new Map();
    for (const e of entries.filter((x) => x.kind !== 'collection')) {
      const k = e.category_id ?? e.category;
      const c = byCat.get(k) ?? { category_id: e.category_id, kind: e.kind, name: e.category, amount_kopecks: 0, count: 0 };
      c.amount_kopecks += e.amount_kopecks;
      c.count += 1;
      byCat.set(k, c);
    }
    return { period: rg, opening_kopecks: opening, income_kopecks: income, collections_kopecks: collections, expenses_kopecks: expenses, closing_kopecks: opening + income + collections - expenses, by_category: [...byCat.values()], entries, categories: cb().categories };
  }

  // ---------- «Кто играл за столом» (№179) ----------
  function games(resourceId, q) {
    const rg = range(q);
    if (!rg) return err(400, 'bad_request');
    const hall = state().hall;
    const table = hall.find((x) => x.resource.id === resourceId);
    if (!table) return err(404, 'not_found');
    const items = [];
    for (const date of eachDay(rg.from, rg.to)) {
      if (!inHistory(date)) continue;
      const d = dash().day(date);
      const t = d.tables.find((x) => x.number === table.resource.number);
      if (!t) continue;
      const r = rng(`games:${date}:${t.number}`);
      let cursor = 12 * 60;
      while (cursor < 26 * 60) {
        const hour = Math.floor(cursor / 60) % 24;
        if ((t.play[hour] ?? 0) < 20) {
          cursor += 60;
          continue;
        }
        const len = 60 + Math.floor(r() * 4) * 30;
        const started = localIso(date, cursor + Math.floor(r() * 10));
        const ended = new Date(Date.parse(started) + len * MIN).toISOString();
        const sid = `5e550000-0000-4000-8000-${date.replace(/-/g, '')}${String(cursor).padStart(4, '0')}`;
        const method = pick(r, METHODS);
        const roll = r();
        items.push({ session_id: sid, started_at: started, ended_at: ended, status: 'closed', source: ['cash', 'card_terminal'].includes(method) ? 'reception' : 'qr', players: 1 + Math.floor(r() * 3), amount_kopecks: Math.round((len / 60) * (hour >= 18 || hour < 6 ? 80000 : 50000)), methods: [method], guest: roll < 0.3 ? { nick: pick(r, NICKS), phone_masked: maskedPhone(r) } : roll < 0.85 ? { nick: null, phone_masked: maskedPhone(r) } : null, staff_name: ['cash', 'card_terminal'].includes(method) ? NAMES.reception : null });
        cursor += len + 15;
      }
    }
    const done = items.filter((g) => Date.parse(g.ended_at) <= now()).sort((x, y) => Date.parse(y.started_at) - Date.parse(x.started_at));
    return ok({ resource: { id: table.resource.id, number: table.resource.number, title: `Стол ${table.resource.number}`, type: table.resource.type }, period: rg, items: done });
  }

  // ---------- ведомость ревизии (№174) ----------
  function sheet(q) {
    const blind = q.get('blind') === '1';
    const c = state().m2?.catalog;
    const groups = [...(c?.categories ?? []), { id: null, name: 'Без группы' }]
      .map((cat) => ({ category_id: cat.id, name: cat.name, items: (c?.products ?? []).filter((p) => p.track_stock && p.active !== false && (p.category_id ?? null) === cat.id).sort((x, y) => x.name.localeCompare(y.name, 'ru')).map((p) => ({ product_id: p.id, name: p.name, unit: p.unit, system_qty: blind ? null : p.stock_qty, actual_qty: null })) }))
      .filter((g) => g.items.length);
    return ok({ club: { id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', name: 'Клуб для разработки' }, blind, generated_at: new Date(now()).toISOString(), groups, items_count: groups.reduce((s, g) => s + g.items.length, 0) });
  }

  return [
    ['GET', /^\/api\/clubs\/([^/]+)\/history\/(orders|audits|writeoffs|arrivals)$/, manageOnly((m, _b, q) => {
      const res = historyList(m[2], q);
      if (!res) return err(400, 'bad_request');
      return ok({ period: res.period, ...page(res.items, q.get('cursor')), totals: res.totals });
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/history\/(orders|audits|writeoffs|arrivals)\/export\.csv$/, manageOnly((m, _b, q) => {
      const res = historyList(m[2], q);
      if (!res) return err(400, 'bad_request');
      const [head, row] = HISTORY_CSV[m[2]];
      audit('owner.export', { data: { source: 'history', table: m[2], from: q.get('from'), to: q.get('to') } });
      return { status: 200, csv: toCsv(head, res.items.map(row)), name: `history-${m[2]}-${q.get('from')}-${q.get('to')}.csv` };
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/stock\/sheet$/, manageOnly((_m, _b, q) => sheet(q))],
    ['GET', /^\/api\/clubs\/([^/]+)\/shifts$/, manageOnly((_m, _b, q) => shiftsList(q))],
    ['GET', /^\/api\/clubs\/([^/]+)\/shifts\/export\.csv$/, manageOnly((_m, _b, q) => {
      const items = shiftsFiltered(q);
      if (!items) return err(400, 'bad_request');
      audit('owner.export', { data: { source: 'shifts', from: q.get('from'), to: q.get('to') } });
      const csv = toCsv(['Смена', 'Открыта', 'Закрыта', 'Открыл', 'Закрыл', 'Выручка, ₽', 'Размен, ₽', 'Должно быть, ₽', 'Факт, ₽', 'Расхождение, ₽', 'Состояние'], items.map((x) => [x.number, csvDate(x.opened_at, TZ, true), csvDate(x.closed_at, TZ, true), x.opened_by_name ?? '', x.closed_by_name ?? '', csvMoney(x.revenue_total_kopecks), csvMoney(x.float_kopecks), csvMoney(x.expected_cash_kopecks), csvMoney(x.actual_cash_kopecks), csvMoney(x.discrepancy_kopecks), x.state]));
      return { status: 200, csv, name: `shifts-${q.get('from')}-${q.get('to')}.csv` };
    })],
    ['GET', /^\/api\/shifts\/([^/]+)\/report$/, manageOnly((m) => {
      const rep = genReport(m[1]);
      return rep ? ok(rep) : undefined;
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/cashbook$/, manageOnly((_m, _b, q) => ok(cashbookData(q)))],
    ['GET', /^\/api\/clubs\/([^/]+)\/cashbook\/export\.csv$/, manageOnly((_m, _b, q) => {
      const d = cashbookData(q);
      audit('owner.export', { data: { source: 'cashbook', from: d.period.from, to: d.period.to } });
      const rows = [['', 'Остаток на начало', '', csvMoney(d.opening_kopecks), '', '', ''], ...[...d.entries].reverse().map((e) => [csvDate(e.date), e.kind === 'expense' ? 'Расход' : e.kind === 'collection' ? 'Инкассация' : 'Доход', e.category ?? '', csvMoney(e.signed_kopecks), e.comment ?? '', e.created_by_name ?? '', e.reverses_id ? `сторно: ${e.reason ?? ''}` : '']), ['', 'Остаток на конец', '', csvMoney(d.closing_kopecks), '', '', '']];
      return { status: 200, csv: toCsv(['Дата', 'Вид', 'Статья', 'Сумма, ₽', 'Комментарий', 'Кто', 'Сторно'], rows), name: `cashbook-${d.period.from}-${d.period.to}.csv` };
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/cashbook$/, manageOnly((_m, b) => {
      const amount = b.amount_kopecks;
      const cat = cb().categories.find((c) => c.category_id === b.category_id && c.active);
      const date = b.date ?? today();
      if (!['income', 'expense'].includes(b.kind) || !Number.isSafeInteger(amount) || amount <= 0 || !cat || cat.kind !== b.kind || !isYmd(date) || date > today() || date < addDays(today(), -35)) return err(400, 'bad_request'); // №189: не старше 35 дней
      const item = entry({ entry_id: globalThis.crypto.randomUUID(), date, kind: b.kind, category_id: cat.category_id, category: cat.name, amount_kopecks: amount, comment: typeof b.comment === 'string' ? b.comment.slice(0, 200) : null, created_at: new Date(now()).toISOString(), created_by: me().id, created_by_name: me().name });
      cb().manual.push(item);
      audit('cashbook.entry', { data: { kind: b.kind, amount_kopecks: amount, category: cat.name } });
      return ok(item);
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/cashbook\/([^/]+)\/storno$/, manageOnly((m, b) => {
      if (typeof b.reason !== 'string' || b.reason.trim().length < 3) return err(400, 'reason_required');
      const all = cashbookEntries(addDays(today(), -(history() - 1)), today());
      const orig = all.find((x) => x.entry_id === m[2]);
      if (!orig) return err(404, 'not_found');
      if (orig.kind === 'collection' || orig.reverses_id) return err(409, 'conflict');
      if (orig.reversed_by) return err(409, 'duplicate');
      const item = entry({ entry_id: globalThis.crypto.randomUUID(), date: today(), kind: orig.kind, category_id: orig.category_id, category: orig.category, amount_kopecks: -orig.amount_kopecks, comment: null, reverses_id: orig.entry_id, reason: b.reason.trim(), created_at: new Date(now()).toISOString(), created_by: me().id, created_by_name: me().name });
      cb().manual.push(item);
      audit('cashbook.storno', { reason: b.reason.trim(), data: { amount_kopecks: orig.amount_kopecks, category: orig.category } });
      return ok(item);
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/cashbook\/categories$/, manageOnly(() => ok({ items: cb().categories }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/cashbook\/categories$/, owner((_m, b) => {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (name.length < 2 || name.length > 40 || !['income', 'expense'].includes(b.kind)) return err(400, 'bad_request');
      if (cb().categories.some((c) => norm(c.name) === norm(name) && c.kind === b.kind)) return err(409, 'duplicate');
      const c = { category_id: `cat-${globalThis.crypto.randomUUID().slice(0, 8)}`, name, kind: b.kind, sort: cb().categories.length + 1, active: true };
      cb().categories.push(c);
      audit('cashbook.category_create', { data: { name } });
      return ok(c);
    })],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/cashbook\/categories\/([^/]+)$/, owner((m, b) => {
      const c = cb().categories.find((x) => x.category_id === m[2]);
      if (!c) return err(404, 'not_found');
      if (typeof b.name === 'string') {
        const name = b.name.trim();
        if (name.length < 2 || name.length > 40) return err(400, 'bad_request');
        c.name = name;
      }
      if (typeof b.active === 'boolean') c.active = b.active;
      audit('cashbook.category_update', { data: { name: c.name, active: c.active } });
      return ok(c);
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/resources\/([^/]+)\/sessions$/, manageOnly((m, _b, q) => games(m[2], q))],
    // Полный телефон — только владельцу с причиной; журнал guest.lookup (без номера) и уведомление владельцу (№179)
    ['POST', /^\/api\/clubs\/([^/]+)\/sessions\/([^/]+)\/guest-phone$/, owner((m, b) => {
      if (typeof b.reason !== 'string' || b.reason.trim().length < 5) return err(400, 'reason_required');
      const r = rng(`phone:${m[2]}`);
      const digits = Array.from({ length: 7 }, () => Math.floor(r() * 10)).join('');
      audit('guest.lookup', { reason: b.reason.trim(), data: { session_id: m[2] } });
      return ok({ session_id: m[2], phone: `+7 912 ${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}` });
    })],
  ];
}
