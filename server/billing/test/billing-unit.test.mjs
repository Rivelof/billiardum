// Подписка клубов (M5.3): периоды по поясу клуба, состояние и плашка, чек, настройки, маска карты.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadBillingConfig } from '../config.mjs';
import { cardJson, cardOf, chargeKey, platformReceipt, stableUuid } from '../core.mjs';
import {
  bannerFor,
  daysLeft,
  effectivePrice,
  localDate,
  localMidnight,
  MAX_ATTEMPTS,
  nextAttemptAt,
  nextPeriodDate,
  periodFrom,
  subscriptionState,
} from '../period.mjs';
import { ERROR_CODES } from '../../http/errors.mjs';

const DAY = 86_400_000;
const EKB = 'Asia/Yekaterinburg';
const MONEY = { yookassaApiUrl: 'http://emu/v3', yookassaTimeoutMs: 5000, encKey: Buffer.alloc(32, 1), publicHost: 'bl.test' };

describe('периоды по поясу клуба (№182)', () => {
  it('местная дата и местная полночь (UTC+5, UTC−5 с переходом на летнее время)', () => {
    assert.equal(localDate(new Date('2026-10-23T19:30:00Z'), EKB), '2026-10-24');
    assert.equal(localMidnight('2026-12-23', EKB).toISOString(), '2026-12-22T19:00:00.000Z');
    assert.equal(localMidnight('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(localMidnight('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
    assert.equal(localMidnight('2026-11-01', 'Europe/Moscow').toISOString(), '2026-10-31T21:00:00.000Z');
  });

  it('следующий счёт через месяц в день счёта; 29–31 в коротком месяце — последний день', () => {
    assert.equal(nextPeriodDate('2026-12-23', 23), '2027-01-23');
    assert.equal(nextPeriodDate('2027-01-31', 31), '2027-02-28');
    assert.equal(nextPeriodDate('2027-02-28', 31), '2027-03-31');
    assert.equal(nextPeriodDate('2028-01-30', 30), '2028-02-29');
    assert.equal(nextPeriodDate('2026-11-30', 30), '2026-12-30');
    assert.throws(() => nextPeriodDate('2026-1-1', 1), RangeError);
    assert.throws(() => nextPeriodDate('2026-01-01', 0), RangeError);
  });

  it('период от местной полуночи до местной полуночи через месяц', () => {
    const p = periodFrom(new Date('2026-12-22T19:00:00Z'), 23, EKB);
    assert.deepEqual({ ...p, startAt: p.startAt.toISOString(), endAt: p.endAt.toISOString() }, {
      start: '2026-12-23',
      end: '2027-01-23',
      startAt: '2026-12-22T19:00:00.000Z',
      endAt: '2027-01-22T19:00:00.000Z',
    });
  });

  it('повторы списания — через 1 и 3 дня после первой неудачи, потом не повторяем', () => {
    const first = new Date('2026-12-23T00:00:00Z');
    assert.equal(nextAttemptAt(first, 1).toISOString(), '2026-12-24T00:00:00.000Z');
    assert.equal(nextAttemptAt(first, 2).toISOString(), '2026-12-26T00:00:00.000Z');
    assert.equal(nextAttemptAt(first, 3), null);
    assert.equal(MAX_ATTEMPTS, 3);
  });

  it('цена: персональная (в том числе 0) или цена плана', () => {
    assert.equal(effectivePrice({ personal_price_kopecks: null }, { price_per_table_kopecks: '79000' }), 79000);
    assert.equal(effectivePrice({ personal_price_kopecks: '50000' }, { price_per_table_kopecks: 79000 }), 50000);
    assert.equal(effectivePrice({ personal_price_kopecks: 0 }, { price_per_table_kopecks: 79000 }), 0);
  });
});

describe('состояние подписки и плашка (§3, №184)', () => {
  const trialUntil = new Date('2026-12-22T19:00:00Z');
  const sub = (extra = {}) => ({ trial_until: trialUntil, paid_until: null, autopay: false, payment_method_enc: null, ...extra });
  const at = (ms) => new Date(trialUntil.getTime() + ms);

  it('trial → past_due → unpaid через 14 дней; active после оплаты; canceled в test', () => {
    assert.equal(subscriptionState(sub(), { now: at(-DAY) }), 'trial');
    assert.equal(subscriptionState(sub(), { now: at(0) }), 'past_due');
    assert.equal(subscriptionState(sub(), { now: at(14 * DAY - 1) }), 'past_due');
    assert.equal(subscriptionState(sub(), { now: at(14 * DAY) }), 'unpaid');
    assert.equal(subscriptionState(sub({ paid_until: at(30 * DAY) }), { now: at(DAY) }), 'active');
    assert.equal(subscriptionState(sub(), { now: at(-DAY), live: false }), 'canceled');
    assert.equal(subscriptionState(null, { now: at(0) }), null);
  });

  it('долг по открытому счёту (в том числе до приостановки, №188) — по возрасту счёта, даже если срок впереди', () => {
    const debt = { period_start_at: at(-40 * DAY), last_error: 'card_required' };
    const resumed = sub({ paid_until: at(20 * DAY) });
    assert.equal(subscriptionState(resumed, { now: at(0), openInvoice: debt }), 'unpaid');
    assert.equal(subscriptionState(resumed, { now: at(0), openInvoice: { period_start_at: at(-DAY) } }), 'past_due');
    const b = bannerFor(resumed, { now: at(0), openInvoice: debt });
    assert.deepEqual([b.kind, b.days_overdue, b.last_error], ['payment_failed', 40, 'card_required']);
  });

  it('плашка за 7 дней без автоплатежа; с автоплатежом — нет; после конца — payment_failed', () => {
    assert.equal(bannerFor(sub(), { now: at(-8 * DAY) }), null);
    assert.deepEqual(bannerFor(sub(), { now: at(-6.5 * DAY) }), { kind: 'trial_ending', days_left: 7, days_overdue: 0, until: trialUntil.toISOString(), last_error: null });
    assert.equal(bannerFor(sub({ autopay: true, payment_method_enc: 'v1:x' }), { now: at(-DAY) }), null);
    const paid = sub({ paid_until: at(30 * DAY) });
    assert.equal(bannerFor(paid, { now: at(24 * DAY) }).kind, 'period_ending');
    const failed = bannerFor(sub({ autopay: true, payment_method_enc: 'v1:x' }), { now: at(2.5 * DAY), openInvoice: { last_error: 'insufficient_funds', period_start_at: trialUntil } });
    assert.deepEqual([failed.kind, failed.days_overdue, failed.last_error], ['payment_failed', 2, 'insufficient_funds']);
    assert.equal(bannerFor(sub(), { now: at(DAY), live: false }), null);
  });

  it('дней до конца — вверх', () => {
    assert.equal(daysLeft(at(0), at(-0.2 * DAY)), 1);
    assert.equal(daysLeft(at(0), at(-7 * DAY)), 7);
    assert.equal(daysLeft(at(0), at(DAY)), 0);
  });
});

describe('чек, ключи, карта', () => {
  it('чек 54-ФЗ: услуга подписки на email владельца, сумма, НДС и СНО из настроек', () => {
    const r = platformReceipt({ email: 'owner@club.test', amountKopecks: 632000, config: { vatCode: 1, taxSystemCode: 2 } });
    assert.deepEqual(r, {
      customer: { email: 'owner@club.test' },
      items: [{ description: 'Подписка на программу «Бильярдум»', quantity: 1, amount: { value: '6320.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }],
      tax_system_code: 2,
    });
    assert.equal(platformReceipt({ email: 'a@b.cc', amountKopecks: 100, config: { vatCode: 1, taxSystemCode: null } }).tax_system_code, undefined);
    assert.throws(() => platformReceipt({ email: null, amountKopecks: 100, config: {} }));
  });

  it('платёж автосписания: id и ключ идемпотентности одинаковы для счёта и попытки', () => {
    const inv = 'f0000000-0000-4000-8000-000000000001';
    assert.equal(stableUuid(`${inv}:1`), stableUuid(`${inv}:1`));
    assert.notEqual(stableUuid(`${inv}:1`), stableUuid(`${inv}:2`));
    assert.match(stableUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(chargeKey(inv, 2), `bl-sub-${inv}-2`);
    assert.ok(chargeKey(inv, 10).length <= 64);
  });

  it('карта наружу — только маска, тип и срок', () => {
    const card = cardOf({ id: 'pm_secret', card: { first6: '555555', last4: '4477', expiry_month: '12', expiry_year: '2030', card_type: 'MasterCard' } });
    assert.deepEqual(card, { last4: '4477', card_type: 'MasterCard', expiry_month: '12', expiry_year: '2030' });
    assert.deepEqual(cardJson(card), { mask: '•• 4477', type: 'MasterCard', expiry: '12/30' });
    assert.equal(cardJson(null), null);
    assert.equal(JSON.stringify(card).includes('pm_secret'), false);
  });
});

describe('настройки магазина платформы (№183)', () => {
  it('без пары ключей — не настроен; секрет не перечисляется и не попадает в JSON', () => {
    assert.equal(loadBillingConfig({}, MONEY).configured, false);
    assert.equal(loadBillingConfig({ PLATFORM_YOOKASSA_SHOP_ID: '700001' }, MONEY).configured, false);
    const secret = 'live_platform_secret_123456';
    const c = loadBillingConfig({ PLATFORM_YOOKASSA_SHOP_ID: '700001', PLATFORM_YOOKASSA_SECRET: secret }, MONEY);
    assert.equal(c.configured, true);
    assert.equal(c.secret, secret);
    assert.equal(Object.keys(c).includes('secret'), false);
    assert.equal(JSON.stringify(c).includes(secret), false);
    assert.equal(c.returnUrl, 'https://bl.test/club/subscription');
    assert.deepEqual([c.vatCode, c.taxSystemCode], [1, null]);
  });

  it('неверные значения — ошибка без значения секрета', () => {
    assert.throws(() => loadBillingConfig({ PLATFORM_YOOKASSA_SHOP_ID: 'bad id' }, MONEY), /SHOP_ID/);
    const err = (() => {
      try {
        loadBillingConfig({ PLATFORM_YOOKASSA_SHOP_ID: '700001', PLATFORM_YOOKASSA_SECRET: 'with space secret' }, MONEY);
      } catch (e) {
        return e;
      }
      return null;
    })();
    assert.ok(err && !err.message.includes('with space'));
    assert.throws(() => loadBillingConfig({ PLATFORM_VAT_CODE: '13' }, MONEY), /VAT/);
    assert.equal(loadBillingConfig({ PLATFORM_TAX_SYSTEM_CODE: '2' }, MONEY).taxSystemCode, 2);
  });

  it('коды ошибок контракта §3 есть в словаре API', () => {
    for (const code of ['card_required', 'invoice_paid', 'billing_unavailable']) assert.ok(ERROR_CODES.has(code), code);
  });
});
