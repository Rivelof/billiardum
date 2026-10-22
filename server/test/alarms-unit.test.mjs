// Тексты и уровни тревог по умолчанию (PRODUCT §8, decisions №66, M2) и словарь кодов ошибок.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALARM_LEVELS, ALARM_TEXTS, alarmText } from '../alarms/index.mjs';
import { ERROR_CODES } from '../http/errors.mjs';

describe('тревоги и коды ошибок M2', () => {
  it('у каждого типа M2 есть текст по-русски и уровень по контракту', () => {
    const expected = {
      discount_over_limit: 'important',
      order_canceled: 'important',
      pos_refund: 'critical',
      bar_double_payment: 'important',
      cash_discrepancy: 'critical',
      receipt_failed: 'important',
      receipt_unknown: 'critical',
      receipt_double: 'critical',
      service_light_threshold: 'important',
      kkt_shift_failed: 'important',
    };
    for (const [type, level] of Object.entries(expected)) {
      assert.equal(ALARM_LEVELS[type], level, type);
      assert.match(ALARM_TEXTS[type], /^[А-ЯЁ][^a-z]*$/u, `${type}: текст`);
    }
    assert.equal(alarmText('cash_discrepancy', null), 'Расхождение кассы при закрытии смены');
    assert.equal(alarmText('receipt_failed', 4), 'Стол 4: Чек не пробит: ККТ вернула ошибку');
    // Все типы с текстом имеют уровень, кроме устаревших без уровня по умолчанию (уровень передаёт вызывающий).
    for (const type of Object.keys(ALARM_LEVELS)) assert.ok(ALARM_TEXTS[type], `${type}: нет текста`);
  });

  it('коды ошибок M2 в словаре', () => {
    for (const code of ['shift_closed', 'shift_open', 'stop_list', 'already_paid', 'duplicate', 'receipt_not_failed', 'receipt_not_unknown', 'no_tariff']) {
      assert.ok(ERROR_CODES.has(code), code);
    }
  });
});
