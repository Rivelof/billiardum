// Перепроверка M1 (правки 53e69aa): возврат за неотыгранное время (decisions №73, shareRefunds).
// Вопрос оркестратора: можно ли получить денег больше, чем заплатил, или сыграть и получить
// полный возврат? Чистая функция server/sessions/service.mjs → shareRefunds.
// Запуск: node --test tests/security/m1/recheck_refund.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareRefunds, UNSHOWN_TOLERANCE_MS } from '../../../server/sessions/service.mjs';

const H = 3_600_000; // час в мс = covered для платежа на 60 минут
const sum = (a) => a.reduce((s, x) => s + x.amountKopecks, 0);

test('неотыгранный почти целиком платёж возвращается полностью, но не больше оплаченного', () => {
  const rows = [{ payment_id: 'p', minutes: 60, amount_kopecks: 50000, refunded_kopecks: 0 }];
  // Показано 0.5 с из часа — в пределах допуска часов: возврат целиком.
  const r = shareRefunds(rows, H - 500);
  assert.equal(r.length, 1);
  assert.equal(r[0].amountKopecks, 50000);
  // Ровно весь час неотыгран — тоже целиком, не больше суммы.
  assert.equal(shareRefunds(rows, H)[0].amountKopecks, 50000);
  // «Больше чем заплатил» невозможно даже при завышенном unplayed.
  assert.equal(shareRefunds(rows, 10 * H)[0].amountKopecks, 50000);
});

test('доля округляется вверх до копейки, но не превышает невозвращённый остаток', () => {
  const rows = [{ payment_id: 'p', minutes: 60, amount_kopecks: 50001, refunded_kopecks: 0 }];
  // Половина часа неотыграна: ceil(50001/2) = 25001 (в пользу гостя), ≤ суммы.
  const r = shareRefunds(rows, H / 2);
  assert.equal(r[0].amountKopecks, 25001);
  assert.ok(r[0].amountKopecks <= 50001);
  // Уже возвращено почти всё: остаток room ограничивает.
  const r2 = shareRefunds([{ payment_id: 'p', minutes: 60, amount_kopecks: 50000, refunded_kopecks: 49990 }], H - 500);
  assert.equal(r2[0].amountKopecks, 10, 'не больше невозвращённого остатка (room)');
});

test('сыграл — полного возврата не будет: отыгранные платежи не возвращаются', () => {
  // p1 (старый, отыгран), p2 (новый, продление). Контроллер показал 90 мин из 120 — неотыграно 30.
  const rows = [
    { payment_id: 'p2', minutes: 60, amount_kopecks: 50000, refunded_kopecks: 0 },
    { payment_id: 'p1', minutes: 60, amount_kopecks: 50000, refunded_kopecks: 0 },
  ];
  const r = shareRefunds(rows, 30 * 60_000); // 30 минут неотыграно
  assert.equal(r.length, 1, 'возврат только по новому платежу');
  assert.equal(r[0].paymentId, 'p2');
  assert.equal(r[0].amountKopecks, 25000, 'ровно неотыгранная половина нового платежа');
  // Отыгранный p1 не возвращён — за сыгранное время деньги не возвращаются.
  assert.ok(!r.some((x) => x.paymentId === 'p1'));
  assert.ok(sum(r) <= 100000, 'суммарный возврат не больше оплаченного');
});

test('инварианты на случайных наборах: возврат по строке ≤ остатка, сумма ≤ оплаченного', () => {
  let seed = 123456789;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let iter = 0; iter < 2000; iter += 1) {
    const k = 1 + rnd(4);
    const rows = [];
    let paid = 0;
    for (let i = 0; i < k; i += 1) {
      const minutes = 1 + rnd(180);
      const amount = 100 + rnd(500000);
      const refunded = rnd(amount + 1);
      rows.push({ payment_id: `p${i}`, minutes, amount_kopecks: amount, refunded_kopecks: refunded });
      paid += amount;
    }
    const totalCovered = rows.reduce((s, r) => s + r.minutes * 60000, 0);
    const unplayed = rnd(totalCovered + 2 * H);
    const out = shareRefunds(rows, unplayed);
    const byId = Object.fromEntries(rows.map((r) => [r.payment_id, r]));
    let total = 0;
    for (const o of out) {
      const row = byId[o.paymentId];
      const room = row.amount_kopecks - row.refunded_kopecks;
      assert.ok(o.amountKopecks >= 0 && o.amountKopecks <= room, `строка: возврат ${o.amountKopecks} вне [0, ${room}]`);
      total += o.amountKopecks;
    }
    assert.ok(total <= paid, `сумма возврата ${total} > оплаченного ${paid}`);
  }
});

test('допуск «не показанного» — ровно 1 с', () => {
  assert.equal(UNSHOWN_TOLERANCE_MS, 1000);
});
