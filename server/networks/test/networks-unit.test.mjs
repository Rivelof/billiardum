// Сети (M5.5) без базы: разбор шаблона меню, текст приглашения, ошибки узких функций, опция роутера.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRouter } from '../../../api/router.mjs';
import { MENU_TEMPLATE_FIELDS } from '../lock.mjs';
import { networkDbError, networkInviteMessage } from '../service.mjs';
import { MAX_TEMPLATE_PRODUCTS, normalizeProducts, storedRule } from '../templates.mjs';
import { applyTemplate, normalizeRules } from '../../setup/tariffs.mjs';

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
