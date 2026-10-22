import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeLabel, currentOf, discrepancy, expectedCash, reconcile, revenueTable, shiftList, staffName, utilization } from '../src/lib/shift.js';

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
