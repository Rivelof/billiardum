import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  FAMILIES,
  COURT_MAX_PLAYERS,
  MAX_SLOTS,
  SLOT_MINUTES,
  countText,
  familyOf,
  familyText,
  isCourt,
  isSlot,
  nounOf,
  pluralForms,
  resourceName,
  slotLabel,
  slotMinutesOf,
  slotOptions,
  slotPriceText,
  slotsText,
} from '../resource.mjs';
import { formatMoney } from '../format.mjs';

test('семья вида: из family, kind, type и строкой; неизвестное — стол', () => {
  assert.equal(familyOf({ family: 'court' }), 'court');
  assert.equal(familyOf({ kind: 'padel_court' }), 'court');
  assert.equal(familyOf({ type: 'padel_court' }), 'court', 'старый ответ без family');
  assert.equal(familyOf({ type: 'billiard_pool', family: 'table' }), 'table');
  assert.equal(familyOf('padel_court'), 'court');
  assert.equal(familyOf('court'), 'court');
  assert.equal(familyOf('billiard_pyramid'), 'table');
  assert.equal(familyOf(null), 'table');
  assert.equal(familyOf({}), 'table');
  assert.equal(isCourt({ family: 'court' }), true);
  assert.equal(isCourt({ type: 'billiard_snooker' }), false);
});

test('слова: падежи, «за столом» и «на корте», формы после числа', () => {
  const c = nounOf('court');
  assert.deepEqual([c.nom, c.gen, c.dat, c.acc, c.ins, c.pre], ['корт', 'корта', 'корту', 'корт', 'кортом', 'корте']);
  assert.equal(c.at, 'на корте');
  assert.equal(c.AtThis, 'На этом корте');
  const t = nounOf({ type: 'billiard_pool' });
  assert.equal(t.at, 'за столом');
  assert.equal(t.atThis, 'за этим столом');
  assert.equal(t.Nom, 'Стол');
  assert.deepEqual(pluralForms('court'), ['корт', 'корта', 'кортов']);
  assert.equal(countText(1, 'court'), '1 корт');
  assert.equal(countText(3, 'court'), '3 корта');
  assert.equal(countText(5, 'court'), '5 кортов');
  assert.equal(countText(21, 'table'), '21 стол');
  // Справочник сервера (noun из GET /api/resource-kinds) главнее своего
  assert.equal(nounOf({ family: 'court', noun: { nom: 'площадка' } }).nom, 'площадка');
});

test('название ресурса: «Корт 2», «стола 6», без номера — слово', () => {
  assert.equal(resourceName({ family: 'court', number: 2 }), 'Корт 2');
  assert.equal(resourceName({ type: 'billiard_pyramid', number: 4 }), 'Стол 4');
  assert.equal(resourceName('table', 6, { case: 'gen', capital: false }), 'стола 6');
  assert.equal(resourceName('court', 1, { case: 'pre', capital: false }), 'корте 1');
  assert.equal(resourceName('court'), 'Корт');
  assert.equal(resourceName({ family: 'court' }, null), 'Корт');
});

test('слот словами и варианты слотов', () => {
  assert.equal(slotLabel(60), '1 ч');
  assert.equal(slotLabel(90), '1,5 ч');
  assert.equal(slotLabel(120), '2 ч');
  assert.equal(slotLabel(270), '4,5 ч');
  assert.equal(slotLabel(100), '1 ч 40 мин');
  assert.equal(slotLabel(45), '45 мин');
  assert.deepEqual(slotOptions(90), [90, 180, 270, 360]);
  assert.deepEqual(slotOptions(60, 3), [60, 120, 180]);
  assert.deepEqual(slotOptions(null), []);
  assert.equal(slotsText(1), '1 слот');
  assert.equal(slotsText(3), '3 слота');
  assert.equal(slotPriceText(240000, 90, formatMoney), '2 400 ₽ за 1,5 ч');
  assert.equal(slotMinutesOf({ slot_minutes: 90 }), 90);
  assert.equal(slotMinutesOf({ slot_minutes: null }), null);
  assert.equal(isSlot({ billing: 'slot' }), true);
  assert.equal(isSlot({ billing: 'hourly', slot_minutes: null }), false);
  assert.deepEqual(SLOT_MINUTES, [60, 90, 120]);
  assert.equal(MAX_SLOTS, 4);
  assert.equal(COURT_MAX_PLAYERS, 4);
});

test('текст про стол → про корт: падежи, предлоги, местоимения; стол не меняется', () => {
  assert.equal(familyText('Стол уже занят. Выберите другой стол.', 'court'), 'Корт уже занят. Выберите другой корт.');
  assert.equal(familyText('Если вы играете за этим столом, подойдите на ресепшн.', 'court'), 'Если вы играете на этом корте, подойдите на ресепшн.');
  assert.equal(familyText('За столом уже 4 игрока', 'court'), 'На корте уже 4 игрока');
  assert.equal(familyText('Заказ со стола, свет на столе, у стола, к столу, столы', 'court'), 'Заказ с корта, свет на корте, у корта, к корту, корты');
  assert.equal(familyText('Настольный теннис. Столько столов', 'court'), 'Настольный теннис. Столько кортов');
  assert.equal(familyText('Стол уже занят.', 'table'), 'Стол уже занят.');
  assert.equal(familyText(undefined, 'court'), undefined);
});

// Слова интерфейса — те же, что у сервера (server/lib/resource-kinds.mjs, GET /api/resource-kinds)
const SERVER = new URL('../../server/lib/resource-kinds.mjs', import.meta.url);
test('справочник слов совпадает с сервером', { skip: !existsSync(SERVER) && 'нет server/lib/resource-kinds.mjs' }, async () => {
  const s = await import(SERVER.href);
  for (const family of ['table', 'court']) {
    assert.deepEqual([...FAMILIES[family].plural], [...s.FAMILIES[family].plural], family);
    assert.deepEqual({ ...FAMILIES[family].cases }, { ...s.FAMILIES[family].cases }, family);
  }
  assert.deepEqual([...SLOT_MINUTES], [...s.SLOT_MINUTES]);
  assert.equal(COURT_MAX_PLAYERS, s.COURT_MAX_PLAYERS);
  for (const k of s.kindsJson().kinds) assert.equal(familyOf(k), k.family, k.kind);
});
