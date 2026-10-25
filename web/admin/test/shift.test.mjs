import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { revenueToday } from '../src/lib/now.js';
import { closeLabel, currentOf, discrepancy, expectedCash, methodsHidden, reconcile, revenueTable, revenueTotals, shiftList, staffName, utilization } from '../src/lib/shift.js';

const memory = () => {
  let v = null;
  return { load: () => v, save: (s) => (v = JSON.parse(JSON.stringify(s))) };
};
const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const backend = (sc) => {
  const b = createBackend(memory(), () => Date.parse('2026-10-24T12:00:00Z'));
  b.scenario(sc);
  return (path, method = 'GET', body) => b.handle(method, { href: `http://x${path}`, body });
};

test('ожидаемые наличные = размен + наличные продажи − наличные возвраты (№81)', () => {
  assert.equal(expectedCash(300000, 1248000, 50000), 1498000);
  assert.equal(expectedCash(0, 0), 0);
  assert.throws(() => expectedCash(3000.5, 0), TypeError);
  assert.throws(() => expectedCash(-1, 0), TypeError);
});

test('расхождение при закрытии смены: недостача, излишек, сходится', () => {
  const short = discrepancy(1548000, 1498000);
  assert.equal(short.kind, 'shortage');
  assert.equal(short.kopecks, -50000);
  assert.equal(short.word, 'Недостача 500 ₽');
  assert.equal(closeLabel(short), 'Закрыть смену с недостачей 500 ₽');
  const over = discrepancy(100000, 112050);
  assert.equal(over.kind, 'surplus');
  assert.equal(over.word, 'Излишек 120,50 ₽');
  assert.equal(discrepancy(100000, 100000).kind, 'none');
  assert.equal(closeLabel(discrepancy(100000, 100000)), 'Закрыть смену');
  assert.equal(discrepancy(100000, null).kind, 'unknown');
  assert.equal(closeLabel(discrepancy(100000, null)), 'Введите наличные в кассе');
  assert.throws(() => discrepancy(null, 1), TypeError);
});

test('выручка отчёта backend-kkt: столы и бар по способам, итоги до копейки', () => {
  const t = revenueTable({
    tables: { by_method: { cash: 960000, card_terminal: 640000, sbp: 1780000, card: 480000 }, total_kopecks: 3860000 },
    bar: { by_method: { cash: 500050, card_terminal: 214000, sbp: 96000, card: 61000 } },
    other: { by_method: { cash: 0, card_terminal: 0, sbp: 0, card: 0 } },
  });
  assert.deepEqual(t.rows[0], { method: 'cash', tables: 960000, bar: 500050, packages: 0, other: 0, total: 1460050 });
  assert.equal(t.tables, 3860000);
  assert.equal(t.bar, 871050);
  assert.equal(t.total, 4731050);
  assert.equal(revenueTable({ tables: { cash: 100 } }).total, 100, 'старый плоский вид тоже');
  assert.equal(revenueTable(null).total, 0);
  const pk = revenueTable({ tables: { by_method: { cash: 100 } }, packages: { by_method: { sbp: 300000, cash: 550000 } } });
  assert.equal(pk.packages, 850000, 'пакеты часов (M3) — своя колонка');
  assert.equal(pk.total, 850100);
});

test('сверка: сходится, расходится, не проверено (ЮKassa не ответила)', () => {
  assert.deepEqual(reconcile({ ok: true, diff_kopecks: 0 }), { state: 'ok', diff: 0 });
  assert.deepEqual(reconcile({ ok: false, diff_kopecks: 64000 }), { state: 'diff', diff: 64000 });
  assert.equal(reconcile({ ok: false, status: 'unavailable' }).state, 'unchecked');
  assert.equal(reconcile({ ok: null, status: 'skipped' }).state, 'unchecked');
  assert.equal(reconcile(null).state, 'unchecked');
});

test('смена из ответов backend-kkt: { shift }, { items }, имена', () => {
  assert.equal(currentOf({ shift: null }), null);
  assert.equal(currentOf({ shift: { id: 's' } }).id, 's');
  assert.equal(currentOf({ id: 's', opened_at: 'x' }).id, 's', 'смена без обёртки');
  assert.equal(shiftList({ items: [{ id: 1 }], next_cursor: null }).length, 1);
  assert.equal(shiftList([{ id: 1 }]).length, 1);
  assert.equal(staffName({ opened_by: 'u1', opened_by_name: 'Анна К.' }, 'opened'), 'Анна К.');
  assert.equal(staffName({ closed_by: { name: 'Игорь П.' } }, 'closed'), 'Игорь П.');
  assert.equal(staffName({ opened_by: 'u1', opened_by_name: null }, 'opened'), null);
  assert.equal(utilization(1460, 8, 312), 58);
});

test('«Сейчас»: выручка по способам; управляющему сети — null и итог revenue_today_total_kopecks (M5.5 №192)', () => {
  const full = revenueToday({ revenue_today_kopecks: { sbp: 100, card: 20, cash: 300, card_terminal: 4000 }, revenue_today_total_kopecks: 4420 });
  assert.equal(full.hidden, false);
  assert.equal(full.total, 4420);
  assert.deepEqual(full.rows.map((r) => r.method), ['sbp', 'card', 'cash', 'card_terminal']);
  assert.equal(revenueToday({ revenue_today_kopecks: { cash: 500 } }).total, 500, 'старый ответ без итога — сумма способов');
  assert.equal(revenueToday(null).total, 0);
  const hidden = revenueToday({ revenue_today_kopecks: null, revenue_today_total_kopecks: 123400 });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.total, 123400);
  assert.deepEqual(hidden.rows, []);
  assert.equal(revenueToday({}, { networkManager: true }).hidden, true, 'членство сети — разбивки нет, даже если поля нет');
  assert.equal(revenueToday({ revenue_today_kopecks: { cash: 1 } }, { networkManager: true }).hidden, false);
});

test('заглушка: /now управляющего сети без разбивки, у владельца — с ней', async () => {
  const mgr = backend('network-manager');
  const n = (await mgr(`/api/clubs/${CLUB}/now`)).body;
  assert.equal(n.revenue_today_kopecks, null);
  assert.ok(Number.isSafeInteger(n.revenue_today_total_kopecks));
  const owner = backend('network');
  const o = (await owner(`/api/clubs/${CLUB}/now`)).body;
  assert.equal(typeof o.revenue_today_kopecks, 'object');
  assert.equal(o.revenue_today_total_kopecks, n.revenue_today_total_kopecks);
});

test('отчёт смены управляющего сети: methods_hidden, итоги остаются, сверка без сумм по способам (M5.5 №192)', async () => {
  const mgr = backend('network-manager');
  const shifts = (await mgr(`/api/clubs/${CLUB}/shifts`)).body;
  const id = (Array.isArray(shifts) ? shifts : shifts.items)[0].id;
  const r = (await mgr(`/api/shifts/${id}/report`)).body;
  assert.equal(r.methods_hidden, true);
  assert.equal(methodsHidden(r), true);
  assert.equal(r.revenue.tables.by_method, null);
  assert.equal(r.revenue.by_method, null);
  assert.ok(Number.isSafeInteger(r.revenue.tables.total_kopecks));
  assert.equal(r.reconciliation.kkt.system_kopecks, null);
  assert.equal(r.reconciliation.online.yookassa_kopecks, null);
  assert.equal(typeof r.reconciliation.kkt.ok, 'boolean');
  assert.equal(reconcile(r.reconciliation.kkt).state, 'ok', 'сходится или нет — остаётся');
  assert.ok(Number.isSafeInteger(r.cash.expected_cash_kopecks), 'касса смены — как есть');
  // Итоги без способов
  const t = revenueTotals(r.revenue);
  assert.equal(t.total, r.revenue.total_kopecks);
  assert.deepEqual(t.rows.map((x) => x.label), ['Столы', 'Бар']);
  assert.equal(t.rows[0].kopecks + t.rows[1].kopecks, t.total);
  // Старая таблица по способам не должна показывать нули: её не строим при methods_hidden
  assert.equal(revenueTable(r.revenue).total, 0);
  // Владельцу отчёт целиком
  const owner = backend('network');
  const ownerShifts = (await owner(`/api/clubs/${CLUB}/shifts`)).body;
  const full = (await owner(`/api/shifts/${(Array.isArray(ownerShifts) ? ownerShifts : ownerShifts.items)[0].id}/report`)).body;
  assert.equal(methodsHidden(full), false);
  assert.ok(revenueTable(full.revenue).total > 0);
});

test('итоги выручки: пакеты, турниры и прочее — только если не нулевые', () => {
  const rows = revenueTotals({ tables: { total_kopecks: 1000 }, bar: { total_kopecks: 0 }, packages: { total_kopecks: 300 }, tournaments: { total_kopecks: 0 }, other: { total_kopecks: 50 }, total_kopecks: 1350 });
  assert.deepEqual(rows.rows.map((r) => r.key), ['tables', 'bar', 'packages', 'other']);
  assert.equal(rows.total, 1350);
  assert.equal(revenueTotals(null).total, 0);
  assert.equal(methodsHidden({ revenue: { by_method: null } }), true);
  assert.equal(methodsHidden(null), false);
});
