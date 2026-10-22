// Корзина кассы M3 без базы: товары бара и пакеты часов (контракт m3.md §1 п. 10).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PACKAGES, splitCart } from '../pos.mjs';

const PKG = '0d4e7a5c-1111-4222-8333-944455556661';
const USER = 'a9000000-0000-4000-8000-0000000000aa';
const PRODUCT = 'b1000000-0000-4000-8000-000000000001';

describe('корзина кассы: пакеты часов', () => {
  it('товары и пакеты разделяются; kind product снимается; пустая корзина — пусто', () => {
    const out = splitCart([
      { product_id: PRODUCT, qty: 2 },
      { kind: 'product', product_id: PRODUCT, qty: 1, modifier_ids: [] },
      { kind: 'package', package_id: PKG, user_id: USER },
      { kind: 'package', package_id: PKG, phone: '+79990001122' },
    ]);
    assert.deepEqual(out.products, [{ product_id: PRODUCT, qty: 2 }, { product_id: PRODUCT, qty: 1, modifier_ids: [] }]);
    assert.deepEqual(out.packages, [
      { package_id: PKG, user_id: USER, phone: null },
      { package_id: PKG, user_id: null, phone: '+79990001122' },
    ]);
    assert.deepEqual(splitCart(undefined), { products: [], packages: [] });
    assert.deepEqual(splitCart([]), { products: [], packages: [] });
  });

  it('гость обязателен — guest_required; оба способа сразу, неверный телефон или id, qty ≠ 1 — bad_request', () => {
    assert.throws(() => splitCart([{ kind: 'package', package_id: PKG }]), (e) => e.code === 'guest_required' && e.status === 400);
    assert.throws(() => splitCart([{ kind: 'package', package_id: PKG, phone: '' }]), (e) => e.code === 'guest_required');
    for (const bad of [
      { kind: 'package', package_id: PKG, user_id: USER, phone: '+79990001122' },
      { kind: 'package', package_id: PKG, phone: '89990001122' },
      { kind: 'package', package_id: PKG, user_id: 'x' },
      { kind: 'package', package_id: 'x', user_id: USER },
      { kind: 'package', package_id: PKG, user_id: USER, qty: 2 },
      { kind: 'service', product_id: PRODUCT, qty: 1 },
      null,
    ]) {
      assert.throws(() => splitCart([bad]), (e) => e.code === 'bad_request', JSON.stringify(bad));
    }
  });

  it(`не больше ${MAX_PACKAGES} пакетов в продаже`, () => {
    const many = Array.from({ length: MAX_PACKAGES + 1 }, () => ({ kind: 'package', package_id: PKG, user_id: USER }));
    assert.throws(() => splitCart(many), (e) => e.code === 'bad_request');
    assert.equal(splitCart(many.slice(0, MAX_PACKAGES)).packages.length, MAX_PACKAGES);
  });
});
