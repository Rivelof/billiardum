// M5.8 «Падел-корт»: слова по виду ресурса, варианты слотов, ориентир цены корта, заглушка
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionLabel, tableName } from '../src/lib/words.js';
import { optionPrice, slotOptionPrice } from '../src/lib/prices.js';
import { zonedMs } from '@billiardum/shared/booking';
import { createBackend } from '../src/mock/backend.js';

const TZ = 'Asia/Yekaterinburg';
const at = (h, m = 0) => zonedMs('2026-10-22', h * 60 + m, TZ); // четверг

test('название и варианты: «Корт 2», слоты коротко, стол — как раньше', () => {
  assert.equal(tableName(2, { family: 'court' }), 'Корт 2');
  assert.equal(tableName(4, { type: 'padel_court' }), 'Корт 4');
  assert.equal(tableName(4), 'Стол 4');
  assert.equal(tableName(null), 'Стол');
  assert.equal(optionLabel(90, { billing: 'slot', slot_minutes: 90 }), '1,5 ч');
  assert.equal(optionLabel(180, { slot_minutes: 90 }), '3 ч');
  assert.equal(optionLabel(120, { billing: 'hourly', slot_minutes: null }), '2 часа');
  assert.equal(optionLabel('unlimited'), 'Без лимита');
});

test('ориентир цены корта: цена слота, смена цены внутри слота — по минутам', () => {
  const table = {
    club: { timezone: TZ },
    price_now: { price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90, until_local: '17:00' },
    price_next: { price_per_hour_kopecks: 240000, price_per_slot_kopecks: 360000, slot_minutes: 90, from_local: '17:00' },
  };
  assert.equal(optionPrice(table, 90, at(12)), 240000);
  assert.equal(optionPrice(table, 180, at(12)), 480000);
  // 16:30–18:00: 30 минут по 2 400 ₽ за слот (800 ₽) и 60 по 3 600 ₽ (2 400 ₽)
  assert.equal(optionPrice(table, 90, at(16, 30)), 320000);
  assert.equal(slotOptionPrice({ price_now: { price_per_slot_kopecks: 240000, slot_minutes: 90 } }, 270, at(12)), 720000);
  assert.equal(slotOptionPrice({ price_now: { price_per_hour_kopecks: 80000 } }, 90, at(12)), null);
  // Стол — прежний почасовой расчёт
  assert.equal(optionPrice({ club: { timezone: TZ }, price_now: { price_per_hour_kopecks: 80000 } }, 120, at(12)), 160000);
});

test('заглушка: корт по QR — слоты без «Без лимита», котировка только слотами, пятый игрок — limit_exceeded', async () => {
  let saved = null;
  const b = createBackend({ load: () => saved, save: (s) => { saved = JSON.parse(JSON.stringify(s)); } });
  b.scenario('court');
  const t = (await b.handle('GET', '/api/t/TESTC00001')).body;
  assert.equal(t.resource.family, 'court');
  assert.equal(t.resource.slot_minutes, 90);
  assert.equal(t.resource.max_players, 4);
  assert.deepEqual(t.options, [90, 180, 270]);
  assert.equal(t.price_now.slot_minutes, 90);
  const bad = await b.handle('POST', '/api/quotes', { resource_id: t.resource.id, kind: 'start', minutes: 60 });
  assert.equal(bad.status, 400);
  assert.equal((await b.handle('POST', '/api/quotes', { resource_id: t.resource.id, kind: 'start', minutes: null })).status, 400);
  const q = await b.handle('POST', '/api/quotes', { resource_id: t.resource.id, kind: 'start', minutes: 180 });
  assert.equal(q.status, 200);
  assert.equal(q.body.slots, 2);
  // Стол рядом — прежний: часы и «Без лимита»
  assert.ok((await b.handle('GET', '/api/t/4K7P9QW2XM')).body.options.includes('unlimited'));

  b.scenario('courtfull');
  const full = (await b.handle('GET', '/api/t/TESTC00002')).body;
  const join = await b.handle('POST', `/api/sessions/${full.session_id}/join`, { code: 'TESTC00002' });
  assert.equal(join.status, 400);
  assert.equal(join.body.error, 'limit_exceeded');
});
