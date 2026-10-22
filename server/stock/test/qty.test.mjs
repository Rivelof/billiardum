// Количество склада в тысячных и себестоимость без плавающей точки (decisions №80).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromMilli, itemQtyMilli, movementCost, toMilli } from '../api.mjs';
import { parseQty } from '../service.mjs';

describe('склад: количество и себестоимость', () => {
  it('тысячные туда и обратно', () => {
    assert.equal(toMilli('1.5'), 1500n);
    assert.equal(toMilli('-0.001'), -1n);
    assert.equal(toMilli('30'), 30000n);
    assert.equal(fromMilli(-1300n), '-1.300');
    assert.equal(itemQtyMilli(2, '1.300'), 2600n);
    assert.throws(() => toMilli('1.2345'));
  });

  it('себестоимость движения по средней: «половина вверх», без приходов — 0', () => {
    // 30 шт за 2 100 ₽ и 10 шт за 800 ₽: средняя 72,50 ₽.
    const avg = { cost: 290000n, qtyMilli: 40000n };
    assert.equal(movementCost(avg, 1000n), 7250);
    assert.equal(movementCost(avg, 1300n), 9425);
    assert.equal(movementCost({ cost: 100n, qtyMilli: 3000n }, 1000n), 33);
    assert.equal(movementCost({ cost: 200n, qtyMilli: 3000n }, 1000n), 67);
    assert.equal(movementCost(undefined, 1000n), 0);
  });

  it('количество из API: до тысячных, положительное (факт ревизии — может быть 0)', () => {
    assert.equal(parseQty(2), 2000n);
    assert.equal(parseQty('0.5'), 500n);
    assert.equal(parseQty(0), null);
    assert.equal(parseQty(0, { allowZero: true }), 0n);
    assert.equal(parseQty(-1), null);
    assert.equal(parseQty(1.0001), null);
    assert.equal(parseQty('1e3'), null);
  });
});
