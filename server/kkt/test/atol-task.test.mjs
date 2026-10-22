// Задание АТОЛ из чека bl.receipts, токен моста, UUID попыток — без базы.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atolItems, jobUuid, lineAmount, operatorName, parseRub, ReceiptDataError, receiptTask, shiftTask, VAT_BY_CODE } from '../atol-task.mjs';
import { lineToItem } from '../api.mjs';
import { backoffMs } from '../queue.mjs';
import { bearerToken, clubOfToken, hashToken, newBridgeToken } from '../tokens.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const item = (over = {}) => ({
  description: 'Игра, стол 4, 2 ч',
  quantity: 1,
  amount: { value: '1600.00', currency: 'RUB' },
  vat_code: 1,
  payment_mode: 'full_payment',
  payment_subject: 'service',
  ...over,
});

describe('задание АТОЛ', () => {
  it('чек заявки стола M1: sell, позиция-услуга, наличные, СНО клуба, кассир', () => {
    const task = receiptTask({ kind: 'sale', items: [item()], amountKopecks: 160000, taxSystemCode: 2, payments: [{ method: 'cash', amount_kopecks: 160000 }], operatorName: 'Ресепшн (тест)' });
    assert.deepEqual(task, {
      type: 'sell',
      electronically: false,
      operator: { name: 'Ресепшн (тест)' },
      items: [
        { type: 'position', name: 'Игра, стол 4, 2 ч', price: 1600, quantity: 1, amount: 1600, tax: { type: 'none' }, paymentMethod: 'fullPayment', paymentObject: 'service', measurementUnit: 'piece' },
      ],
      payments: [{ type: 'cash', sum: 1600 }],
      total: 1600,
      taxationType: 'usnIncome',
    });
  });

  it('возврат — sellReturn; терминал — electronically; смешанная оплата суммируется по типу', () => {
    const task = receiptTask({
      kind: 'refund',
      items: [item({ amount: { value: '150.50' }, quantity: 3, payment_subject: 'commodity', vat_code: 11 })],
      amountKopecks: 45150,
      taxSystemCode: null,
      payments: [{ method: 'card_terminal', amount_kopecks: 40000 }, { method: 'cash', amount_kopecks: 5000 }, { method: 'cash', amount_kopecks: 150 }],
      operatorName: null,
    });
    assert.equal(task.type, 'sellReturn');
    assert.equal(task.taxationType, undefined);
    assert.equal(task.operator.name, 'Кассир');
    assert.deepEqual(task.payments, [{ type: 'electronically', sum: 400 }, { type: 'cash', sum: 51.5 }]);
    assert.equal(task.items[0].tax.type, 'vat22');
    assert.equal(task.items[0].amount, 451.5);
  });

  it('сумма до копейки: вес 0,333 × 99,99 ₽ = 33,30 ₽; сумма позиций ≠ сумме чека — ошибка', () => {
    assert.equal(lineAmount(9999, 0.333), 3330);
    assert.equal(lineAmount(1, 0.5), 1);
    assert.equal(atolItems([item({ quantity: 0.333, amount: { value: '99.99' } })]).totalKopecks, 3330);
    assert.throws(() => receiptTask({ kind: 'sale', items: [item()], amountKopecks: 150000, payments: [{ method: 'cash', amount_kopecks: 150000 }] }), ReceiptDataError);
    assert.throws(() => receiptTask({ kind: 'sale', items: [item()], amountKopecks: 160000, payments: [{ method: 'cash', amount_kopecks: 100 }] }), /оплаты/);
    assert.throws(() => receiptTask({ kind: 'sale', items: [item({ vat_code: 13 })], amountKopecks: 160000, payments: [{ method: 'cash', amount_kopecks: 160000 }] }), /vat_code/);
    assert.throws(() => receiptTask({ kind: 'sale', items: [item({ payment_subject: 'magic' })], amountKopecks: 160000, payments: [{ method: 'cash', amount_kopecks: 160000 }] }), /payment_subject/);
    assert.throws(() => receiptTask({ kind: 'sale', items: [item()], amountKopecks: 160000, taxSystemCode: 9, payments: [{ method: 'cash', amount_kopecks: 160000 }] }), /tax_system_code/);
  });

  it('все ставки НДС ЮKassa 1–12 сопоставлены типам АТОЛ', () => {
    assert.deepEqual(Object.keys(VAT_BY_CODE).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(parseRub('1600'), 160000);
    assert.equal(parseRub('0.5'), 50);
    assert.throws(() => parseRub('1.234'), ReceiptDataError);
  });

  it('кассир — до 64 символов без управляющих; смена ККТ — openShift и closeShift', () => {
    assert.equal(operatorName('  Иванова\nА.  '), 'Иванова А.');
    assert.equal(operatorName('x'.repeat(100)).length, 64);
    assert.deepEqual(shiftTask('open_shift', 'Петров'), { type: 'openShift', operator: { name: 'Петров' } });
    assert.deepEqual(shiftTask('close_shift', ''), { type: 'closeShift', operator: { name: 'Кассир' } });
  });

  it('UUID задания: первая попытка — id чека (№78), следующие — детерминированные и разные', () => {
    const id = '5f0c7d2e-1111-4222-8333-944455556666';
    assert.equal(jobUuid(id, 1), id);
    assert.equal(jobUuid(id, 2), jobUuid(id, 2));
    assert.notEqual(jobUuid(id, 2), jobUuid(id, 3));
    assert.match(jobUuid(id, 2), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('позиция кассы: короткий вид и вид ЮKassa дают одну позицию чека', () => {
    const a = lineToItem({ name: 'Чай', price_kopecks: 15000, quantity: 2, payment_subject: 'commodity' }, 1);
    const b = lineToItem({ description: 'Чай', quantity: 2, amount: { value: '150.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'commodity' }, 4);
    assert.deepEqual(a, b);
    assert.throws(() => lineToItem({ name: '', price_kopecks: 1 }, 1), /bad_request/);
    assert.throws(() => lineToItem({ name: 'x', price_kopecks: 1.5 }, 1), /bad_request/);
    assert.throws(() => lineToItem({ description: 'x', amount: { value: '1.234' } }, 1), /bad_request/);
  });

  it('пауза повтора: 5, 10, 20 … 60 с', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => backoffMs(n)), [5000, 10000, 20000, 40000, 60000, 60000]);
    assert.equal(backoffMs(3, { baseMs: 10, maxMs: 25 }), 25);
  });
});

describe('токен моста', () => {
  it('клуб читается из токена, в базе — sha256; чужой вид — null', () => {
    const { token, hash } = newBridgeToken(CLUB);
    assert.match(token, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(clubOfToken(token), CLUB);
    assert.equal(hash, hashToken(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(newBridgeToken(CLUB).token, token);
    assert.equal(clubOfToken('x'.repeat(64)), clubOfToken('x'.repeat(64)));
    assert.equal(clubOfToken('short'), null);
    assert.equal(clubOfToken(`${token}=`), null);
    assert.equal(bearerToken(`Bearer ${token}`), token);
    assert.equal(bearerToken(`Basic ${token}`), null);
  });
});
