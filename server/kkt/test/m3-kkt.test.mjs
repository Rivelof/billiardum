// ККТ и отчёт смены M3 без базы: оплата «зачёт предоплаты» в задании АТОЛ (prepaid), выручка смены
// с пакетами часов и без игры балансом (контракт m3.md §1 п. 5, 10, 11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PAYMENT_TYPE, ReceiptDataError, receiptTask } from '../atol-task.mjs';
import { revenueOf } from '../../reports/queries.mjs';

const item = (over = {}) => ({
  description: 'Игра, стол 4, 1 ч',
  quantity: 1,
  amount: { value: '800.00', currency: 'RUB' },
  vat_code: 1,
  payment_mode: 'full_payment',
  payment_subject: 'service',
  ...over,
});

describe('задание АТОЛ: зачёт предоплаты', () => {
  it('prepayment → prepaid; смешанная оплата зачётом и наличными, сумма = сумма чека', () => {
    assert.equal(PAYMENT_TYPE.prepayment, 'prepaid');
    const task = receiptTask({
      kind: 'sale',
      items: [item(), item({ description: 'Чай', amount: { value: '150.00' }, quantity: 2, payment_subject: 'commodity' })],
      amountKopecks: 110000,
      taxSystemCode: 2,
      payments: [{ method: 'prepayment', amount_kopecks: 80000 }, { method: 'cash', amount_kopecks: 30000 }],
      operatorName: 'Ресепшн',
    });
    assert.deepEqual(task.payments, [{ type: 'prepaid', sum: 800 }, { type: 'cash', sum: 300 }]);
    assert.equal(task.total, 1100);
    assert.ok(task.items.every((p) => p.paymentMethod === 'fullPayment'));
  });

  it('зачёт больше позиций «полный расчёт» или в оплату позиции «предоплата 100 %» — ошибка', () => {
    assert.throws(
      () => receiptTask({ kind: 'sale', items: [item({ payment_mode: 'full_prepayment' })], amountKopecks: 80000, taxSystemCode: null, payments: [{ method: 'prepayment', amount_kopecks: 80000 }] }),
      ReceiptDataError,
    );
    assert.throws(
      () =>
        receiptTask({
          kind: 'sale',
          items: [item(), item({ payment_mode: 'full_prepayment', description: 'Пакет' })],
          amountKopecks: 160000,
          taxSystemCode: null,
          payments: [{ method: 'prepayment', amount_kopecks: 90000 }, { method: 'cash', amount_kopecks: 70000 }],
        }),
      /зачёт предоплаты/,
    );
    // Чек предоплаты наличными — как раньше.
    const pre = receiptTask({ kind: 'sale', items: [item({ payment_mode: 'full_prepayment' })], amountKopecks: 80000, taxSystemCode: null, payments: [{ method: 'cash', amount_kopecks: 80000 }] });
    assert.equal(pre.items[0].paymentMethod, 'fullPrepayment');
  });
});

describe('выручка смены M3', () => {
  const pay = (over) => ({ method: 'cash', status: 'succeeded', counted_kopecks: 0, hold_kopecks: 0, package_kopecks: 0, ...over });

  it('пакеты часов — своя строка (покупка в приложении и доля в продаже кассы); депозит и возврат остатка — наличные', () => {
    const r = revenueOf(
      [
        pay({ kind: 'bar', category: 'bar', counted_kopecks: 516200, package_kopecks: 500000 }),
        pay({ kind: 'package', category: 'packages', method: 'sbp', counted_kopecks: 300000 }),
        pay({ kind: 'start', category: 'tables', counted_kopecks: 200000 }),
        pay({ kind: 'booking', category: 'other', method: 'card', counted_kopecks: 100000 }),
      ],
      [{ kind: 'start', category: 'tables', method: 'cash', amount_kopecks: 150000 }],
    );
    assert.equal(r.bar.total_kopecks, 16200);
    assert.equal(r.packages.by_method.cash, 500000);
    assert.equal(r.packages.by_method.sbp, 300000);
    assert.equal(r.packages.total_kopecks, 800000);
    assert.equal(r.tables.total_kopecks, 200000);
    assert.equal(r.other.total_kopecks, 100000);
    assert.equal(r.by_method.cash, 716200);
    assert.equal(r.total_kopecks, 1116200);
    assert.equal(r.refunds.tables_kopecks, 150000);
    assert.equal(r.net_kopecks, 1116200 - 150000);
  });

  it('игра балансом (method balance) в выручку не входит', () => {
    const r = revenueOf([pay({ kind: 'extend', category: 'tables', method: 'balance', counted_kopecks: 75000 })], []);
    assert.equal(r.total_kopecks, 0);
    assert.equal(r.tables.total_kopecks, 0);
  });
});
