// Сети (M5.5) без базы: разбор шаблона меню, текст приглашения, ошибки узких функций, опция роутера.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRouter } from '../../../api/router.mjs';
import { MENU_TEMPLATE_FIELDS } from '../lock.mjs';
import { networkDbError, networkInviteMessage } from '../service.mjs';
import { MAX_TEMPLATE_PRODUCTS, normalizeProducts, storedRule } from '../templates.mjs';
import { applyTemplate, normalizeRules } from '../../setup/tariffs.mjs';
import { withoutMethods } from '../../reports/shift-report.mjs';
import { hideMoneyMethods, MONEY_METHOD_KEYS } from '../../lib/network-view.mjs';

describe('шаблон меню сети: разбор', () => {
  it('значения по умолчанию: шт, алкоголь — подакцизный предмет расчёта, активен', () => {
    const [tea, beer] = normalizeProducts([
      { name: 'Чай', price_kopecks: 15000 },
      { category: 'Бар', name: 'Пиво', price_kopecks: 25000, is_alcohol: true, sku: 'BEER-1' },
    ]);
    assert.deepEqual([tea.unit, tea.is_alcohol, tea.payment_subject, tea.category, tea.active, tea.sku], ['шт', false, 'commodity', null, true, null]);
    assert.deepEqual([beer.payment_subject, beer.category, beer.sku], ['excise', 'Бар', 'BEER-1']);
  });

  it('цена — целые копейки больше нуля; поля проверяются; дубли — 400', () => {
    const bad = [
      [{ name: 'Чай', price_kopecks: 0 }],
      [{ name: 'Чай', price_kopecks: 150.5 }],
      [{ name: 'Чай', price_kopecks: '150' }],
      [{ name: ' Чай', price_kopecks: 100 }],
      [{ name: 'Чай', price_kopecks: 100, unit: 'ящик' }],
      [{ name: 'Чай', price_kopecks: 100, vat_code: 13 }],
      [{ name: 'Чай', price_kopecks: 100, is_alcohol: 'да' }],
      [{ name: 'Чай', price_kopecks: 100, sku: 'a b' }],
      [{ name: 'Чай', price_kopecks: 100, id: 'x' }],
      [{ name: 'Чай', price_kopecks: 100 }, { name: 'чай', price_kopecks: 200 }],
      [{ name: 'Чай', price_kopecks: 100, sku: 'S' }, { name: 'Кофе', price_kopecks: 200, sku: 'S' }],
      'не список',
      Array.from({ length: MAX_TEMPLATE_PRODUCTS + 1 }, (_, i) => ({ name: `Т${i}`, price_kopecks: 100 })),
    ];
    for (const b of bad) assert.throws(() => normalizeProducts(b), (e) => e.status === 400 && e.code === 'bad_request', JSON.stringify(b).slice(0, 80));
    // Снятый товар может повторять название активного.
    assert.equal(normalizeProducts([{ name: 'Чай', price_kopecks: 100 }, { name: 'Чай', price_kopecks: 100, active: false }]).length, 2);
  });

  it('шаблон задаёт состав и цену, но не стоп-лист, склад и фото клуба', () => {
    for (const f of ['price_kopecks', 'name', 'is_alcohol', 'active']) assert.ok(MENU_TEMPLATE_FIELDS.includes(f), f);
    for (const f of ['stop_list', 'track_stock', 'photo', 'sort']) assert.ok(!MENU_TEMPLATE_FIELDS.includes(f), f);
  });
});

describe('шаблон тарифов сети: хранение правил (M5.8)', () => {
  it('сохранённое правило разбирается мастером в то же правило — и у столов, и у корта (слот)', () => {
    const input = [
      ...applyTemplate('day_evening', { day: 50000, evening: 70000 }),
      ...applyTemplate('single', { price: 300000 }, { kind: 'padel_court', slot_minutes: 90 }),
    ];
    const rules = normalizeRules(input);
    const stored = rules.map(storedRule);
    assert.deepEqual(normalizeRules(JSON.parse(JSON.stringify(stored))), rules);
    const court = stored.find((r) => r.kind === 'padel_court');
    assert.deepEqual(court, { kind: 'padel_court', days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '06:00', slot_minutes: 90, price_per_slot_kopecks: 300000 });
    assert.equal(stored.find((r) => r.kind === null).price_per_slot_kopecks, undefined);
  });
});

describe('приглашение управляющего сети и ошибки базы', () => {
  it('текст без телефона, ссылка на программу клуба, срок по поясу', () => {
    const m = networkInviteMessage({ networkName: 'Сеть  Урал', publicHost: 'bl.test', expiresAt: '2026-10-31T20:00:00Z', timezone: 'Asia/Yekaterinburg' });
    assert.equal(m.invite_url, 'https://bl.test/club/');
    assert.match(m.invite_text, /«Сеть Урал»/);
    assert.match(m.invite_text, /до 1 ноября/);
    assert.throws(() => networkInviteMessage({ networkName: 'x', publicHost: 'bad host/', expiresAt: new Date() }));
  });

  it('коды узких функций → ответы API без подробностей', () => {
    const cases = { BLN01: [403, 'forbidden'], BLN02: [409, 'club_in_network'], BLN03: [404, 'not_found'], BLN04: [409, 'networks_limit'], BLN05: [409, 'networks_limit'], BLN06: [409, 'duplicate'], BLN07: [404, 'not_found'], BLN10: [409, 'network_locked'] };
    for (const [code, [status, error]] of Object.entries(cases)) {
      const e = networkDbError({ code, message: 'secret detail' });
      assert.deepEqual([e.status, e.code], [status, error], code);
    }
    const other = { code: 'XX000' };
    assert.equal(networkDbError(other), other);
  });

  it('опция маршрута networkManager: только false и только у staff', () => {
    const base = { method: 'GET', handler: async () => ({}) };
    assert.doesNotThrow(() => createRouter({ config: {} }, { routes: [{ ...base, path: '/api/clubs/{club}/x', auth: 'staff', roles: ['owner'], networkManager: false }] }));
    assert.throws(() => createRouter({ config: {} }, { routes: [{ ...base, path: '/api/clubs/{club}/x', auth: 'staff', roles: ['owner'], networkManager: true }] }), /networkManager/);
    assert.throws(() => createRouter({ config: {} }, { routes: [{ ...base, path: '/api/x', auth: 'guest', networkManager: false }] }), /networkManager/);
  });
});

describe('отчёт смены управляющему сети (№192): без денег по способам оплаты', () => {
  const zero = () => ({ cash: 0, card_terminal: 0, sbp: 0, card: 0 });
  const report = () => ({
    revenue: {
      total_kopecks: 150000,
      by_method: { ...zero(), sbp: 100000, cash: 50000 },
      tables: { total_kopecks: 150000, by_method: { ...zero(), sbp: 100000, cash: 50000 } },
      bar: { total_kopecks: 0, by_method: zero() },
      refunds: { total_kopecks: 0, by_method: zero(), tables_kopecks: 0, bar_kopecks: 0, count: 0 },
      late_returned: { total_kopecks: 0, by_method: zero(), count: 0 },
    },
    shift: { number: 1, cash_sales_kopecks: 50000, cash_refunds_kopecks: 0, expected_cash_kopecks: 50100 },
    cash: { float_kopecks: 100, cash_sales_kopecks: 50000, cash_refunds_kopecks: 0, expected_cash_kopecks: 50100, actual_cash_kopecks: 50100, discrepancy_kopecks: 0 },
    reconciliation: {
      kkt: {
        ok: false, system_kopecks: 50000, kkt_kopecks: 0, diff_kopecks: 50000,
        by_method: { cash: { sales_kopecks: 50000 }, card_terminal: { sales_kopecks: 0 } },
        receipts: { printed: { count: 0, amount_kopecks: 0 }, pending: { count: 1, amount_kopecks: 50000 } },
        missing: [{ payment_id: 'p', method: 'cash', amount_kopecks: 50000 }], missing_refunds: [], missing_count: 1,
      },
      online: { ok: true, status: 'checked', system_kopecks: 100000, system_refunds_kopecks: 0, yookassa_kopecks: 100000, yookassa_refunds_kopecks: 0, diff_kopecks: 0, payments: 1 },
    },
  });

  it('способы обнуляются (null) на всех уровнях выручки и сверки, итоги, статусы и счётчики остаются', () => {
    const src = report();
    const r = withoutMethods(src);
    assert.equal(r.methods_hidden, true);
    assert.equal(r.revenue.total_kopecks, 150000);
    for (const k of ['tables', 'bar', 'refunds', 'late_returned']) assert.equal(r.revenue[k].by_method, null, k);
    assert.equal(r.revenue.by_method, null);
    assert.equal(r.revenue.tables.total_kopecks, 150000);
    assert.equal(r.revenue.refunds.count, 0);
    const k = r.reconciliation.kkt;
    assert.deepEqual([k.ok, k.diff_kopecks, k.missing_count, k.system_kopecks, k.kkt_kopecks, k.by_method], [false, 50000, 1, null, null, null]);
    assert.deepEqual(k.missing, [{ payment_id: 'p', method: null, amount_kopecks: 50000 }]);
    assert.deepEqual(k.receipts.pending, { count: 1, amount_kopecks: null });
    const o = r.reconciliation.online;
    assert.deepEqual([o.ok, o.status, o.diff_kopecks, o.payments, o.system_kopecks, o.yookassa_kopecks], [true, 'checked', 0, 1, null, null]);
    // Касса смены: наличные продажи и возвраты скрыты, сверка кассы (ожидалось, факт, расхождение) остаётся.
    assert.deepEqual(r.cash, { ...src.cash, cash_sales_kopecks: null, cash_refunds_kopecks: null });
    assert.deepEqual([r.shift.cash_sales_kopecks, r.shift.expected_cash_kopecks], [null, 50100]);
    assert.equal(src.revenue.by_method.sbp, 100000, 'исходный отчёт не меняется');
  });
});

describe('ответы управляющему сети: hideMoneyMethods (Н-3)', () => {
  it('поля способов и наличных по способам — null на любой глубине, итоги и сверка кассы остаются, исходное не меняется', () => {
    const src = {
      shift: { id: 's', cash_sales_kopecks: 500, cash_refunds_kopecks: 100, expected_cash_kopecks: 1000, actual_cash_kopecks: 1000, discrepancy_kopecks: 0, revenue_total_kopecks: 700 },
      items: [{ sale_id: 'a', method: 'cash', total_kopecks: 500, received_kopecks: 1000, change_kopecks: 500, items: [{ name: 'Чай', amount_kopecks: 500 }] }],
      data: { method: 'card_terminal', payment_id: 'p' },
      who: { methods: ['cash', 'sbp'], count: 2 },
      date: new Date('2026-10-25T00:00:00Z'),
    };
    const copy = structuredClone(src);
    const out = hideMoneyMethods(src);
    assert.deepEqual(src, copy, 'исходный объект не изменён');
    assert.deepEqual([out.shift.cash_sales_kopecks, out.shift.cash_refunds_kopecks], [null, null]);
    assert.deepEqual([out.shift.expected_cash_kopecks, out.shift.actual_cash_kopecks, out.shift.discrepancy_kopecks, out.shift.revenue_total_kopecks], [1000, 1000, 0, 700]);
    assert.deepEqual(out.items[0], { sale_id: 'a', method: null, total_kopecks: 500, received_kopecks: null, change_kopecks: null, items: [{ name: 'Чай', amount_kopecks: 500 }] });
    assert.deepEqual(out.data, { method: null, payment_id: 'p' });
    assert.deepEqual(out.who, { methods: null, count: 2 });
    assert.ok(out.date instanceof Date, 'не простые объекты (Date) не трогаются');
    assert.ok(MONEY_METHOD_KEYS.includes('by_method'));
    assert.equal(hideMoneyMethods(null), null);
    assert.equal(hideMoneyMethods('cash'), 'cash');
  });
});
