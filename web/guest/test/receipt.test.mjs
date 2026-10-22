import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptState, refundLines } from '../src/lib/receipt.js';

test('статус чека: строка контракта или объект сервера по платежам', () => {
  assert.equal(receiptState('sent'), 'succeeded');
  assert.equal(receiptState('receipt_pending'), 'receipt_pending');
  assert.equal(receiptState('unknown'), 'none');
  assert.equal(receiptState({ a: 'succeeded', b: 'succeeded' }), 'succeeded');
  assert.equal(receiptState({ a: 'succeeded', b: 'receipt_pending' }), 'receipt_pending');
  assert.equal(receiptState({ a: 'pending' }), 'pending');
  assert.equal(receiptState({ a: 'canceled', b: 'succeeded' }), 'succeeded');
  assert.equal(receiptState({ a: 'none' }), 'none');
  assert.equal(receiptState({ a: 'none', b: 'succeeded' }), 'succeeded');
  assert.equal(receiptState({}), 'none');
  assert.equal(receiptState(null), 'none');
});

test('возвраты — отрицательные строки чека', () => {
  assert.deepEqual(refundLines([{ amount_kopecks: 80000, refunded_kopecks: 0 }, { amount_kopecks: 80000, refunded_kopecks: 24000 }]), [{ title: 'Возврат', amount_kopecks: -24000 }]);
  assert.deepEqual(refundLines(undefined), []);
});
