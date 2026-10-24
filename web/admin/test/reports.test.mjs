import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canStorno,
  cashbookFormErrors,
  cashbookSummary,
  countWords,
  gameMinutes,
  guestLabel,
  maskPhone,
  qtyWords,
  REPORT_KEYS,
  revealReasonError,
  shiftStaff,
  shiftState,
} from '../src/lib/reports.js';
import { can } from '../src/lib/auth.js';
import { navItems } from '../src/lib/nav.js';
import { createBackend } from '../src/mock/backend.js';

const NB = '\u00a0';
const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

// ---------- гость без ПДн (№173, №179) ----------

test('гость в истории — ник или маска; полный номер маскируется даже если пришёл с сервера', () => {
  assert.equal(maskPhone('+79120001234'), '+7 *** ***-12-34');
  assert.equal(maskPhone('8 (912) 000-12-34'), '+7 *** ***-12-34');
  assert.equal(maskPhone('+7 *** ***-12-34'), '+7 *** ***-12-34');
  assert.equal(maskPhone(''), null);
  assert.equal(guestLabel({ nick: 'Свояк', masked_phone: '+7 *** ***-11-22' }), 'Свояк');
  assert.equal(guestLabel({ masked_phone: '+7 *** ***-11-22' }), '+7 *** ***-11-22');
  assert.equal(guestLabel({ nick: null, phone_masked: '+7999***4567' }), '+7999***4567'); // маска сервера
  assert.equal(guestLabel({ phone: '+79991112233' }), '+7 *** ***-22-33');
  assert.equal(guestLabel(null), 'Гость без входа');
  assert.equal(guestLabel(null, { pos: true }), '—');
});

// ---------- смены (№176) ----------

test('смены: состояние словом, сотрудники для фильтра, CSV', () => {
  assert.deepEqual(shiftState({ status: 'open', closed_at: null }), { key: 'open', word: 'Идёт' });
  assert.equal(shiftState({ status: 'closed', closed_at: 'x', discrepancy_kopecks: 0 }).word, 'Сошлась');
  assert.equal(shiftState({ status: 'closed', closed_at: 'x', discrepancy_kopecks: -10000 }).word, `Недостача 100${NB}₽`);
  assert.equal(shiftState({ status: 'closed', closed_at: 'x', discrepancy_kopecks: 5000 }).key, 'over');
  const list = [
    { opened_by: 'r2', opened_by_name: 'Игорь П.', closed_by: 'r1', closed_by_name: 'Анна К.' },
    { opened_by: 'r1', opened_by_name: 'Анна К.' },
  ];
  assert.deepEqual(shiftStaff(list), [{ id: 'r1', name: 'Анна К.' }, { id: 'r2', name: 'Игорь П.' }]);
  assert.equal(shiftState({ state: 'open', closed_at: null }).key, 'open');
});

// ---------- касса управляющего (№177) ----------

const CATS = [
  { category_id: 'rent', name: 'Аренда', kind: 'expense', active: true },
  { category_id: 'old', name: 'Старое', kind: 'expense', active: false },
  { category_id: 'inc', name: 'Прочие доходы', kind: 'income', active: true },
];

test('касса: конец = начало + доходы + инкассации − расходы; сторно — обратной суммой; по статьям', () => {
  const data = {
    opening_kopecks: 5000000,
    closing_kopecks: 5000000 + 50000 + 2600000 - 9000000,
    entries: [
      { entry_id: '1', kind: 'collection', category: 'Инкассация', amount_kopecks: 2600000 },
      { entry_id: '2', kind: 'income', category: 'Прочие доходы', amount_kopecks: 50000 },
      { entry_id: '3', kind: 'expense', category: 'Аренда', amount_kopecks: 9000000 },
      { entry_id: '4', kind: 'expense', category: 'Закупка', amount_kopecks: 1500000, reversed_by: '5' },
      { entry_id: '5', kind: 'expense', category: 'Закупка', amount_kopecks: -1500000, reverses_id: '4', reason: 'Внесли дважды' },
    ],
  };
  const s = cashbookSummary(data);
  assert.equal(s.collections, 2600000);
  assert.equal(s.otherIncome, 50000);
  assert.equal(s.expense, 9000000);
  assert.equal(s.closing, s.opening + s.otherIncome + s.collections - s.expense);
  assert.equal(s.mismatch, false);
  assert.deepEqual(s.byCategory, [{ name: 'Аренда', amount: 9000000 }]); // сторнированная закупка в ноль — не показываем
  assert.equal(cashbookSummary({ ...data, closing_kopecks: 1 }).mismatch, true);
  // статьи от сервера (by_category) важнее своего подсчёта
  assert.deepEqual(cashbookSummary({ ...data, by_category: [{ kind: 'expense', name: 'Аренда', amount_kopecks: 9000000 }, { kind: 'income', name: 'Прочие доходы', amount_kopecks: 50000 }] }).byCategory, [{ name: 'Аренда', amount: 9000000 }]);
  assert.equal(canStorno(data.entries[0]), false); // инкассация из смены
  assert.equal(canStorno(data.entries[2]), true);
  assert.equal(canStorno(data.entries[3]), false); // уже сторнирована
  assert.equal(canStorno(data.entries[4]), false); // само сторно
});

test('касса: форма записи объясняет ошибки словами', () => {
  const ok = cashbookFormErrors({ kind: 'expense', amount: 1250000, categoryId: 'rent', date: '2026-10-24' }, CATS, '2026-10-24');
  assert.deepEqual(ok, {});
  const bad = cashbookFormErrors({ kind: 'expense', amount: 0, categoryId: 'inc', date: '2026-10-25' }, CATS, '2026-10-24');
  assert.match(bad.amount, /больше нуля/);
  assert.match(bad.category, /статья доходов/);
  assert.match(bad.date, /позже сегодняшней/);
  assert.match(cashbookFormErrors({ kind: 'expense', amount: 100, categoryId: 'old', date: '2026-10-24' }, CATS, '2026-10-24').category, /Выберите статью/);
});

// ---------- ведомость ревизии (№174) и прочее ----------

test('ведомость: количество без лишних нулей, с запятой', () => {
  assert.equal(qtyWords(1.5), '1,5');
  assert.equal(qtyWords(2), '2');
  assert.equal(qtyWords(null), '—');
});

test('тексты: plural, длительность игры, причина для телефона', () => {
  assert.equal(countWords.records(1), '1 запись');
  assert.equal(countWords.records(3), '3 записи');
  assert.equal(countWords.records(25), '25 записей');
  assert.equal(countWords.positions(21), '21 позиция');
  assert.equal(gameMinutes('2026-10-24T15:00:00Z', '2026-10-24T16:30:00Z'), 90);
  assert.equal(gameMinutes('2026-10-24T16:00:00Z', '2026-10-24T15:00:00Z'), null);
  assert.match(revealReasonError('  '), /Напишите причину/);
  assert.equal(revealReasonError('Гость забыл кий'), null);
});

// ---------- права (№166, №172–179) ----------

test('права: ресепшн и бар не видят дашборд и отчёты; экспорт дашборда, статьи кассы и телефон — только владелец', () => {
  for (const r of ['reception', 'bar', 'installer']) {
    assert.equal(can.dashboard(r), false, r);
    assert.equal(can.reportsView(r), false, r);
  }
  assert.equal(can.dashboard('manager'), true);
  assert.equal(can.dashboardExport('manager'), false);
  assert.equal(can.dashboardExport('owner'), true);
  assert.equal(can.cashbookCategories('manager'), false);
  assert.equal(can.revealPhone('manager'), false);
  assert.equal(can.revealPhone('owner'), true);
  const owner = navItems('owner', CLUB).map((i) => i.key);
  assert.equal(owner[0], 'dashboard');
  assert.ok(owner.includes('reports'));
  const phone = navItems('manager', CLUB).filter((i) => !i.wideOnly).map((i) => i.key);
  assert.deepEqual(phone, ['dashboard', 'now', 'shift', 'alarms', 'more']);
  assert.ok(!navItems('reception', CLUB).some((i) => ['dashboard', 'reports'].includes(i.key)));
  assert.ok(REPORT_KEYS.has('audit-sheet'));
});

// ---------- заглушка отчётов ----------

const FROM = '2026-10-01';
const TO = '2026-10-24';
const NOW = Date.parse('2026-10-24T12:00:00Z');

test('заглушка: истории — гость маской или ником, через QR алкоголя нет, CSV без телефонов', async () => {
  const b = createBackend(memory(), () => NOW);
  b.scenario('dashboard');
  const r = await req(b, 'GET', `/api/clubs/${CLUB}/history/orders?from=${FROM}&to=${TO}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.items.length > 0 && r.body.next_cursor);
  const all = [];
  let cursor = null;
  do {
    const p = await req(b, 'GET', `/api/clubs/${CLUB}/history/orders?from=${FROM}&to=${TO}${cursor ? `&cursor=${cursor}` : ''}`);
    all.push(...p.body.items);
    cursor = p.body.next_cursor;
  } while (cursor);
  assert.equal(all.length, r.body.totals.count);
  for (const o of all) {
    if (o.guest?.phone_masked) assert.match(o.guest.phone_masked, /\*\*\*/);
    assert.ok(Date.parse(o.created_at) <= NOW, 'заказов из будущего нет');
  }
  const alcohol = new Set(['Светлое разливное, 0,5 л', 'Тёмное разливное, 0,5 л', 'Сидр, 0,33 л']);
  assert.ok(all.filter((o) => o.source === 'qr').every((o) => o.lines.every((l) => !alcohol.has(l.name))));
  assert.ok(all.every((o) => ['new', 'preparing', 'ready', 'served', 'canceled'].includes(o.status)));
  const canceled = (await req(b, 'GET', `/api/clubs/${CLUB}/history/orders?from=${FROM}&to=${TO}&status=canceled`)).body;
  assert.ok(canceled.items.every((o) => o.status === 'canceled' && o.cancel_reason));
  const sorted = (await req(b, 'GET', `/api/clubs/${CLUB}/history/orders?from=${FROM}&to=${TO}&sort=-amount`)).body.items;
  assert.ok(sorted[0].amount_kopecks >= sorted.at(-1).amount_kopecks);
  const csv = await req(b, 'GET', `/api/clubs/${CLUB}/history/orders/export.csv?from=${FROM}&to=${TO}`);
  assert.ok(csv.csv.startsWith('\uFEFF'));
  assert.doesNotMatch(csv.csv, /\+7\d{10}|\+7 9\d\d/);
  for (const kind of ['audits', 'writeoffs', 'arrivals']) assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/history/${kind}?from=${FROM}&to=${TO}`)).status, 200, kind);
  const wo = (await req(b, 'GET', `/api/clubs/${CLUB}/history/writeoffs?from=${FROM}&to=${TO}&status=audit`)).body;
  assert.ok(wo.items.length && wo.items.every((x) => x.source === 'audit' && x.audit_id));
  const sheet = (await req(b, 'GET', `/api/clubs/${CLUB}/stock/sheet?blind=1`)).body;
  assert.ok(sheet.items_count > 0 && sheet.groups.every((g) => g.items.every((i) => i.system_qty === null)));
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/history/orders?from=2025-01-01&to=${TO}`)).status, 400);
});

test('заглушка: ресепшну отчёты, дашборд и «Кто играл» — 403', async () => {
  const b = createBackend(memory(), () => NOW);
  b.scenario('reception');
  for (const path of [`/api/clubs/${CLUB}/history/orders?from=${FROM}&to=${TO}`, `/api/clubs/${CLUB}/cashbook?from=${FROM}&to=${TO}`, `/api/clubs/${CLUB}/dashboard?from=${FROM}&to=${TO}`, `/api/clubs/${CLUB}/resources/00000000-0000-4000-8000-000000000001/sessions?from=${FROM}&to=${TO}`]) {
    assert.equal((await req(b, 'GET', path)).status, 403, path);
  }
});

test('заглушка: касса управляющего — запись, сторно с причиной, конец сходится', async () => {
  const b = createBackend(memory(), () => NOW);
  b.scenario('dashboard-manager');
  const get = async () => (await req(b, 'GET', `/api/clubs/${CLUB}/cashbook?from=${FROM}&to=${TO}`)).body;
  const before = await get();
  assert.equal(cashbookSummary(before).closing, before.closing_kopecks);
  const cat = before.categories.find((c) => c.name === 'Ремонт столов');
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/cashbook`, { kind: 'income', amount_kopecks: 100, category_id: cat.category_id, date: TO })).status, 400); // статья расходов для дохода
  const add = await req(b, 'POST', `/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 1250000, category_id: cat.category_id, date: TO, comment: 'Перетяжка сукна' });
  assert.equal(add.status, 200);
  const mid = await get();
  assert.equal(mid.closing_kopecks, before.closing_kopecks - 1250000);
  const path = `/api/clubs/${CLUB}/cashbook/${add.body.entry_id}/storno`;
  assert.equal((await req(b, 'POST', path, { reason: '' })).status, 400);
  assert.equal((await req(b, 'POST', path, { reason: 'Ошиблись в сумме' })).status, 200);
  assert.equal((await req(b, 'POST', path, { reason: 'Ещё раз' })).status, 409);
  const after = await get();
  assert.equal(after.closing_kopecks, before.closing_kopecks);
  assert.equal(cashbookSummary(after).closing, after.closing_kopecks);
  assert.ok(after.entries.find((e) => e.entry_id === add.body.entry_id).reversed_by);
  const collection = after.entries.find((x) => x.kind === 'collection');
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/cashbook/${collection.entry_id}/storno`, { reason: 'Нельзя' })).status, 409);
  const csv = await req(b, 'GET', `/api/clubs/${CLUB}/cashbook/export.csv?from=${FROM}&to=${TO}`);
  assert.match(csv.csv, /Остаток на начало/);
  // справочник статей — только владелец
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/cashbook/categories`, { name: 'Реклама', kind: 'expense' })).status, 403);
});

test('заглушка: «Кто играл» — игры стола; телефон только владельцу и с причиной, в журнал guest.lookup', async () => {
  const b = createBackend(memory(), () => NOW);
  b.scenario('dashboard');
  const table = '00000000-0000-4000-8000-000000000003';
  const g = await req(b, 'GET', `/api/clubs/${CLUB}/resources/${table}/sessions?from=2026-10-18&to=${TO}`);
  assert.equal(g.status, 200);
  assert.ok(g.body.items.length > 5);
  assert.ok(g.body.items.every((x) => !x.guest?.phone_masked || x.guest.phone_masked.includes('***')));
  assert.ok(g.body.items.every((x) => Array.isArray(x.methods)));
  const sid = g.body.items[0].session_id;
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/sessions/${sid}/guest-phone`, { reason: 'кий' })).status, 400);
  const ok = await req(b, 'POST', `/api/clubs/${CLUB}/sessions/${sid}/guest-phone`, { reason: 'Гость забыл кий' });
  assert.equal(ok.status, 200);
  assert.match(ok.body.phone, /^\+7 \d{3} /);
  assert.equal(b.state.audit[0].action, 'guest.lookup');
  assert.equal(b.state.audit[0].reason, 'Гость забыл кий');
  b.scenario('dashboard-manager');
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/sessions/${sid}/guest-phone`, { reason: 'Гость забыл кий' })).status, 403);
});

test('заглушка: список смен с периодом и фильтрами; без периода — как в M2', async () => {
  const b = createBackend(memory(), () => NOW);
  b.scenario('dashboard');
  const all = (await req(b, 'GET', `/api/clubs/${CLUB}/shifts?from=${FROM}&to=${TO}`)).body;
  assert.ok(all.items.length >= 40);
  const disc = (await req(b, 'GET', `/api/clubs/${CLUB}/shifts?from=${FROM}&to=${TO}&status=discrepancy`)).body.items;
  assert.deepEqual(disc.map((s) => [s.discrepancy_kopecks, s.state]), [[-10000, 'discrepancy']]);
  const csv = await req(b, 'GET', `/api/clubs/${CLUB}/shifts/export.csv?from=${FROM}&to=${TO}`);
  assert.ok(csv.csv.startsWith('\uFEFF'));
  const anna = (await req(b, 'GET', `/api/clubs/${CLUB}/shifts?from=${FROM}&to=${TO}&staff=reception`)).body.items;
  assert.ok(anna.length > 0 && anna.every((s) => s.opened_by === 'reception' || s.closed_by === 'reception'));
  // отчёт сгенерированной смены открывается
  const old = all.items.find((s) => s.id.startsWith('5f000000'));
  assert.equal((await req(b, 'GET', `/api/shifts/${old.id}/report`)).status, 200);
  const m2 = (await req(b, 'GET', `/api/clubs/${CLUB}/shifts?limit=14`)).body;
  assert.ok(m2.items.length <= 4);
});
