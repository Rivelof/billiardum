import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMenu,
  available,
  unavailableWord,
  defaultModifiers,
  toggleModifier,
  validateModifiers,
  unitPrice,
  lineKey,
  modifiersText,
  emptyCart,
  addProduct,
  addFixed,
  setQty,
  removeLine,
  cartTotals,
  orderItems,
  refreshCart,
  waitMinutes,
  orderTable,
  orderTotal,
  orderPayWord,
  waitTone,
  sortQueue,
  mergeOrder,
  orderWord,
  ORDER_NEXT,
} from '../bar.mjs';

const VOLUME = { id: 'g-vol', name: 'Объём', required: true, modifiers: [{ id: 'm-03', name: '0,3 л', price_delta_kopecks: 0 }, { id: 'm-04', name: '0,4 л', price_delta_kopecks: 4000 }] };
const SUGAR = { id: 'g-sug', name: 'Сахар', required: false, max: 1, modifiers: [{ id: 'm-s1', name: '1 ложка', price_delta_kopecks: 0 }, { id: 'm-s2', name: '2 ложки', price_delta_kopecks: 0 }] };
const SYRUP = { id: 'g-syr', name: 'Сироп', required: false, max: 2, modifiers: [{ id: 'm-van', name: 'Ваниль', price_delta_kopecks: 3000 }, { id: 'm-car', name: 'Карамель', price_delta_kopecks: 3000 }, { id: 'm-coc', name: 'Кокос', price_delta_kopecks: 3500 }] };

const RAW = {
  categories: [
    { id: 'c-food', name: 'Еда', sort: 2 },
    { id: 'c-coffee', name: 'Кофе', sort: 1 },
    { id: 'c-empty', name: 'Пустая', sort: 3 },
  ],
  modifier_groups: [VOLUME, SUGAR, SYRUP],
  products: [
    { id: 'p-amer', category_id: 'c-coffee', name: 'Американо', price_kopecks: 18000, modifier_group_ids: ['g-vol', 'g-sug', 'g-syr'] },
    { id: 'p-fries', category_id: 'c-food', name: 'Картофель фри', price_kopecks: 25000, stock_qty: 0, available: false },
    { id: 'p-mors', category_id: 'c-food', name: 'Морс', price_kopecks: 16000, stop_list: true },
    { id: 'p-chalk', category_id: 'c-gone', name: 'Мел', price_kopecks: 10000, modifier_groups: [{ id: 'g-x', name: 'Цвет', required: true, modifiers: [{ id: 'm-blue', name: 'Синий', default: true }, { id: 'm-green', name: 'Зелёный' }] }] },
    { id: 'bad', name: 'Без цены', price_kopecks: 12.5 },
  ],
};

test('меню: группы ссылками и внутри товара, порядок категорий, пустые категории скрыты', () => {
  const m = normalizeMenu(RAW);
  assert.deepEqual(m.categories.map((c) => c.name), ['Кофе', 'Еда', 'Другое'], 'пустая категория не показывается, товар без категории — в «Другое»');
  assert.equal(m.products.length, 4, 'товар без целой цены в копейках отброшен');
  const amer = m.byId.get('p-amer');
  assert.deepEqual(amer.modifier_groups.map((g) => g.id), ['g-vol', 'g-sug', 'g-syr']);
  assert.equal(amer.modifier_groups[0].min, 1);
  assert.equal(amer.modifier_groups[0].max, 1);
  assert.equal(amer.modifier_groups[2].max, 2);
  assert.equal(m.byId.get('p-chalk').modifier_groups[0].modifiers[1].price_delta_kopecks, 0, 'нет дельты — 0');
  assert.deepEqual(normalizeMenu(null).products, []);
});

test('меню в виде backend-pos: товары внутри категорий, min_select/max_select, is_default', () => {
  const m = normalizeMenu({
    club_id: 'c',
    audience: 'guest',
    alcohol_hidden: true,
    categories: [
      { id: 'c1', name: 'Кофе', products: [{ id: 'p1', name: 'Капучино', price_kopecks: 22000, available: true, stop_list: false, modifier_groups: [{ id: 'g1', name: 'Молоко', min_select: 1, max_select: 1, modifiers: [{ id: 'm1', name: 'Обычное', price_delta_kopecks: 0 }, { id: 'm2', name: 'Овсяное', price_delta_kopecks: 5000, is_default: true }] }] }] },
      { id: null, name: 'Другое', products: [{ id: 'p2', name: 'Мел', price_kopecks: 10000, available: false, stop_list: false, modifier_groups: [] }] },
    ],
  });
  assert.deepEqual(m.categories.map((c) => c.name), ['Кофе', 'Другое']);
  assert.equal(m.byId.get('p1').category_id, 'c1');
  assert.equal(m.byId.get('p2').category_id, null);
  assert.deepEqual(defaultModifiers(m.byId.get('p1')), ['m2'], 'is_default');
  assert.equal(m.byId.get('p1').modifier_groups[0].required, true);
  assert.equal(available(m.byId.get('p2')), false);
  assert.equal(m.alcoholHidden, true);
});

test('доступность: стоп-лист и нулевой остаток — словом', () => {
  const m = normalizeMenu(RAW);
  assert.equal(available(m.byId.get('p-amer')), true);
  assert.equal(available(m.byId.get('p-fries')), false);
  assert.equal(unavailableWord(m.byId.get('p-fries')), 'Закончился');
  assert.equal(unavailableWord(m.byId.get('p-mors')), 'Стоп-лист');
  assert.equal(unavailableWord(m.byId.get('p-amer')), null);
});

test('модификаторы: по умолчанию, радио, флажки с лимитом, проверка', () => {
  const amer = normalizeMenu(RAW).byId.get('p-amer');
  let sel = defaultModifiers(amer);
  assert.deepEqual(sel, ['m-03'], 'обязательный объём — первый вариант');
  assert.deepEqual(defaultModifiers(normalizeMenu(RAW).byId.get('p-chalk')), ['m-blue'], 'вариант с default');

  sel = toggleModifier(amer, sel, 'g-vol', 'm-04');
  assert.deepEqual(sel, ['m-04'], 'объём — как радио');
  assert.deepEqual(toggleModifier(amer, sel, 'g-vol', 'm-04'), ['m-04'], 'обязательный нельзя снять');

  sel = toggleModifier(amer, sel, 'g-sug', 'm-s1');
  sel = toggleModifier(amer, sel, 'g-sug', 'm-s2');
  assert.deepEqual(sel, ['m-04', 'm-s2'], 'сахар — один вариант');
  sel = toggleModifier(amer, sel, 'g-sug', 'm-s2');
  assert.deepEqual(sel, ['m-04'], 'необязательный снимается');

  sel = toggleModifier(amer, sel, 'g-syr', 'm-van');
  sel = toggleModifier(amer, sel, 'g-syr', 'm-car');
  sel = toggleModifier(amer, sel, 'g-syr', 'm-coc');
  assert.deepEqual(sel, ['m-04', 'm-van', 'm-car'], 'сиропов не больше двух');
  assert.deepEqual(toggleModifier(amer, sel, 'g-syr', 'nope'), sel, 'чужой вариант не меняет выбор');

  assert.equal(unitPrice(amer, sel), 18000 + 4000 + 3000 + 3000);
  assert.equal(validateModifiers(amer, sel).ok, true);
  const bad = validateModifiers(amer, ['m-s1']);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'required');
  assert.match(bad.errors[0].text, /объём/);
  assert.equal(validateModifiers(amer, ['m-03', 'm-s1', 'm-s2']).errors[0].code, 'too_many');
});

test('корзина: одинаковые позиции складываются, разные модификаторы — разные строки', () => {
  const m = normalizeMenu(RAW);
  const amer = m.byId.get('p-amer');
  let cart = emptyCart();
  cart = addProduct(cart, amer, ['m-03']);
  cart = addProduct(cart, amer, ['m-03']);
  cart = addProduct(cart, amer, ['m-s1', 'm-04']);
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.lines[0].qty, 2);
  assert.equal(lineKey('p-amer', ['m-04', 'm-s1']), lineKey('p-amer', ['m-s1', 'm-04']), 'порядок выбора не важен');
  assert.equal(modifiersText(cart.lines[1].modifiers), '0,4 л, 1 ложка', 'в порядке групп меню');
  assert.deepEqual(cartTotals(cart), { count: 3, subtotal_kopecks: 18000 * 2 + 22000 });

  cart = setQty(cart, cart.lines[0].key, 5);
  assert.equal(cart.lines[0].qty, 5);
  cart = setQty(cart, cart.lines[0].key, 1000);
  assert.equal(cart.lines[0].qty, 99, 'не больше 99 штук в строке');
  cart = setQty(cart, cart.lines[0].key, 0);
  assert.equal(cart.lines.length, 1, '0 — строка убрана');

  cart = addFixed(cart, { key: 'request:r1', kind: 'request', request_id: 'r1', name: 'Стол 4 · 2 ч', amount_kopecks: 160000 });
  cart = addFixed(cart, { key: 'request:r1', kind: 'request', request_id: 'r1', name: 'Стол 4 · 2 ч', amount_kopecks: 160000 });
  assert.equal(cart.lines.length, 2, 'заявку нельзя добавить дважды');
  cart = setQty(cart, 'request:r1', 3);
  assert.equal(cart.lines[1].qty, 1, 'у заявки количество всегда 1');
  assert.deepEqual(orderItems(cart), [{ product_id: 'p-amer', qty: 1, modifier_ids: ['m-s1', 'm-04'] }], 'в заказ — только товары');
  assert.throws(() => addFixed(cart, { key: 'x', kind: 'tab', name: 'x', amount_kopecks: 1.5 }), TypeError);
  assert.equal(removeLine(cart, 'request:r1').lines.length, 1);
});

test('корзина после обновления меню: стоп-лист убирает позицию, цена новая', () => {
  const m = normalizeMenu(RAW);
  let cart = addProduct(emptyCart(), m.byId.get('p-amer'), ['m-03']);
  cart = addProduct(cart, m.byId.get('p-chalk'), ['m-blue']);
  const next = normalizeMenu({
    ...RAW,
    products: RAW.products.map((p) => (p.id === 'p-amer' ? { ...p, price_kopecks: 19000 } : p.id === 'p-chalk' ? { ...p, stop_list: true } : p)),
  });
  const { cart: fresh, removed } = refreshCart(cart, next);
  assert.deepEqual(removed, ['Мел']);
  assert.equal(fresh.lines.length, 1);
  assert.equal(fresh.lines[0].unit_kopecks, 19000);
});

test('очередь бара: порядок, ожидание, статусы словами', () => {
  const now = Date.parse('2026-10-22T16:30:00Z');
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const q = sortQueue([
    { id: 'a', status: 'ready', created_at: ago(30) },
    { id: 'b', status: 'new', created_at: ago(2) },
    { id: 'c', status: 'new', created_at: ago(9) },
    { id: 'd', status: 'served', created_at: ago(40) },
    { id: 'e', status: 'preparing', created_at: ago(12) },
  ]);
  assert.deepEqual(q.map((o) => o.id), ['c', 'b', 'e', 'a'], 'выданные ушли, внутри статуса — кто ждёт дольше');
  assert.equal(waitMinutes({ created_at: ago(9.5) }, now), 9);
  assert.equal(waitMinutes({ created_at: 'x' }, now), 0);
  assert.equal(waitTone(9), 'ok');
  assert.equal(waitTone(10), 'slow');
  assert.equal(waitTone(20), 'late');
  assert.equal(orderWord('new', 'staff'), 'Новый');
  assert.equal(orderWord('new'), 'Принят');
  assert.equal(orderWord('ready'), 'Готов, несём к столу');
  assert.equal(ORDER_NEXT.preparing, 'ready');
  assert.equal(ORDER_NEXT.served, undefined, 'после «Выдан» действий нет');
  assert.equal(orderTable({ resource: { number: 4 } }), 4);
  assert.equal(orderTable({ resource: null }), null, 'заказ кассы — без стола');
  assert.equal(orderTotal({ subtotal_kopecks: 44000 }), 44000);
  assert.equal(orderPayWord({ pay_mode: 'tab' }), 'В счёт стола');
  assert.equal(orderPayWord({ pay_mode: 'online', awaiting_payment: true }), 'Ждёт оплаты');
  assert.equal(orderPayWord({ pay_mode: 'pos', source: 'pos' }), 'Оплачен на кассе');
  const merged = mergeOrder([{ id: 'a', status: 'new', items: [1] }], { id: 'a', status: 'preparing' });
  assert.deepEqual(merged, [{ id: 'a', status: 'preparing', items: [1] }]);
  assert.equal(mergeOrder([], { id: 'z', status: 'new' }).length, 1);
});
