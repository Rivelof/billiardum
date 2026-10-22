// Деньги бара в копейках (инвариант 10): скидка, раскладка, позиции чека, доли возврата — без базы.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocate, discountKopecks, linesTotal, mulDivRound, overLimit, receiptLines, refundAmount, rub, unitGroups } from '../money.mjs';
import { readPosSettings, validatePosSettingsPatch } from '../settings.mjs';

describe('скидка', () => {
  it('процент — один раз, «половина вверх»; сумма — как есть; не больше суммы', () => {
    assert.equal(discountKopecks({ percent: 10 }, 42000), 4200);
    assert.equal(discountKopecks({ percent: 7 }, 12345), 864); // 864,15
    assert.equal(discountKopecks({ percent: 5 }, 30), 2); // 1,5 → 2
    assert.equal(discountKopecks({ amount_kopecks: 3001 }, 15000), 3001);
    assert.equal(discountKopecks(null, 100), 0);
    assert.equal(discountKopecks({}, 100), 0);
    assert.throws(() => discountKopecks({ amount_kopecks: 101 }, 100));
    assert.throws(() => discountKopecks({ percent: 10, amount_kopecks: 1 }, 100));
    assert.throws(() => discountKopecks({ percent: 10.5 }, 100));
    assert.throws(() => discountKopecks({ amount_kopecks: -1 }, 100));
  });

  it('лимит: ровно лимит — в пределах, на копейку больше — выше', () => {
    assert.equal(overLimit(1500, 15000, 10), false);
    assert.equal(overLimit(1501, 15000, 10), true);
    assert.equal(overLimit(1500, 15001, 10), false);
    assert.equal(overLimit(1501, 15010, 10), false);
    assert.equal(overLimit(0, 100, 0), false);
    assert.equal(overLimit(1, 100, 0), true);
  });
});

describe('раскладка по строкам', () => {
  it('сумма долей равна скидке, доли пропорциональны, ничья — раньше строка', () => {
    assert.deepEqual(allocate(4200, [27000, 15000]), [2700, 1500]);
    assert.deepEqual(allocate(1, [100, 100, 100]), [1, 0, 0]);
    assert.deepEqual(allocate(2, [100, 100, 100]), [1, 1, 0]);
    assert.deepEqual(allocate(0, [5, 6]), [0, 0]);
    for (let n = 0; n < 500; n += 1) {
      const weights = Array.from({ length: 1 + (n % 7) }, (_, i) => 1 + ((n * 7919 + i * 104729) % 50000));
      const total = weights.reduce((s, w) => s + w, 0);
      const d = (n * 31337) % (total + 1);
      const parts = allocate(d, weights);
      assert.equal(parts.reduce((s, p) => s + p, 0), d);
      parts.forEach((p, i) => assert.ok(p >= 0 && p <= weights[i]));
    }
  });

  it('большие суммы — без потери точности (BigInt)', () => {
    const parts = allocate(9_007_199_254, [9_007_199_254_740, 1, 1]);
    assert.equal(parts.reduce((s, p) => s + p, 0), 9_007_199_254);
    assert.equal(mulDivRound(5, 1, 2), 3n);
    assert.equal(mulDivRound(-5, 1, 2), -3n);
  });
});

describe('позиции чека', () => {
  it('строка, сумма которой не делится на количество, — две позиции; Σ = сумма до копейки', () => {
    const lines = receiptLines([{ name: 'Орешки', qty: 3, amount_kopecks: 53000, vat_code: 1, payment_subject: 'commodity' }]);
    assert.deepEqual(lines.map((l) => [l.quantity, l.amount.value]), [[2, '176.67'], [1, '176.66']]);
    assert.equal(linesTotal(lines), 53000);
    assert.equal(lines[0].payment_mode, 'full_payment');
    const even = receiptLines([{ name: 'Вода', qty: 2, amount_kopecks: 18000, vat_code: 1, payment_subject: 'commodity' }]);
    assert.equal(even.length, 1);
    for (let n = 1; n < 300; n += 1) {
      const qty = 1 + (n % 9);
      const amount = qty + ((n * 7919) % 100000);
      assert.equal(linesTotal(receiptLines([{ name: 'x', qty, amount_kopecks: amount, vat_code: 1, payment_subject: 'commodity' }])), amount);
    }
  });

  it('позиция с нулевой ценой невозможна', () => {
    assert.throws(() => receiptLines([{ name: 'x', qty: 3, amount_kopecks: 2, vat_code: 1, payment_subject: 'commodity' }]));
  });

  it('название обрезается до 128 символов (54-ФЗ, ЮKassa)', () => {
    const [l] = receiptLines([{ name: 'я'.repeat(200), qty: 1, amount_kopecks: 100, vat_code: 1, payment_subject: 'commodity' }]);
    assert.equal(l.description.length, 128);
  });
});

describe('доли возврата', () => {
  it('возврат по единицам в любом порядке даёт ровно сумму строки', () => {
    assert.equal(refundAmount(53000, 3, 0, 1), 17666);
    assert.equal(refundAmount(53000, 3, 1, 2), 35334);
    for (let n = 1; n < 200; n += 1) {
      const qty = 1 + (n % 8);
      const amount = qty + ((n * 104729) % 90000);
      let left = qty;
      let sum = 0;
      let done = 0;
      while (left > 0) {
        const k = 1 + ((n + done) % left);
        sum += refundAmount(amount, qty, done, k);
        const groups = unitGroups(amount, qty, qty - done - k, qty - done);
        assert.equal(groups.reduce((s, g) => s + g.qty * g.price, 0), refundAmount(amount, qty, done, k));
        done += k;
        left -= k;
      }
      assert.equal(sum, amount);
    }
    assert.throws(() => refundAmount(100, 2, 2, 1));
  });

  it('формат для уведомлений', () => {
    assert.equal(rub(17666), '176,66 ₽');
    assert.equal(rub(149000), '1 490,00 ₽');
  });
});

describe('настройки кассы клуба', () => {
  it('по умолчанию и проверка значений', () => {
    assert.deepEqual(readPosSettings({}), { discount_limit_percent: 10, stop_at_zero: false, tab_limit_kopecks: null, receipt_email: null });
    assert.equal(readPosSettings({ pos_discount_limit_percent: 150 }).discount_limit_percent, 10);
    assert.deepEqual(validatePosSettingsPatch({ discount_limit_percent: 15, stop_at_zero: true }), { pos_discount_limit_percent: 15, pos_stop_at_zero: true });
    assert.equal(validatePosSettingsPatch({ discount_limit_percent: 101 }), null);
    assert.equal(validatePosSettingsPatch({ other: 1 }), null);
    assert.equal(validatePosSettingsPatch({ receipt_email: 'нет' }), null);
    assert.deepEqual(validatePosSettingsPatch({ tab_limit_kopecks: null }), { pos_tab_limit_kopecks: null });
  });
});
