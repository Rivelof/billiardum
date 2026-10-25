// Каталог и склад (контракт M2 §3, §4; decisions №76, №80): меню гостю и персоналу, управление
// каталогом с журналом и правами, импорт CSV, стоп-лист и «кончился», приход, списание, ревизия
// с расхождением в деньгах по средней себестоимости.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, CLUB_B, newKey, P, PHONES, setup, table } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
let h;
let owner;
let manager;
let reception;
let guest;

before(async () => {
  if (SKIP) return;
  h = await setup();
  owner = await h.login(PHONES.owner);
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
  guest = await h.login('+79990000301');
  await h.openShift();
});

after(async () => {
  await h?.close();
});

const req = (method, path, token, body) => h.request(method, path, { token, body, club: CLUB_A });

describe('меню', { skip: SKIP }, () => {
  it('без входа и гостю — без алкоголя; персоналу — всё, с остатками', async () => {
    const anon = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.equal(anon.status, 200);
    assert.equal(anon.json.audience, 'guest');
    const names = anon.json.categories.flatMap((c) => c.products.map((p) => p.name));
    assert.ok(names.includes('Капучино'));
    assert.ok(!names.some((n) => n.startsWith('Пиво')));
    assert.ok(!anon.json.categories.some((c) => c.name === 'Пиво'), 'пустая категория алкоголя скрыта');
    const cap = anon.json.categories.flatMap((c) => c.products).find((p) => p.id === P.cappuccino);
    assert.equal(cap.stock_qty, undefined, 'гостю остатки числом не показываются');
    assert.equal(cap.is_alcohol, undefined);
    assert.deepEqual(cap.modifier_groups.map((g) => g.name), ['Объём', 'Сахар']);
    const staff = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: reception.token });
    assert.equal(staff.json.audience, 'staff');
    const beer = staff.json.categories.flatMap((c) => c.products).find((p) => p.id === P.beer);
    assert.equal(beer.is_alcohol, true);
    assert.equal(beer.stock_qty, 60);
    const g = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: guest.token });
    assert.equal(g.json.audience, 'guest');
    const none = await h.request('GET', '/api/clubs/c9999999-0000-4000-8000-000000000009/menu');
    assert.equal(none.status, 404);
  });

  it('меню другого клуба не показывает товары клуба А', async () => {
    const b = await h.request('GET', `/api/clubs/${CLUB_B}/menu`);
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.categories, []);
  });
});

describe('управление каталогом', { skip: SKIP }, () => {
  let groupId;
  let productId;

  it('ресепшн каталог не меняет — 403; гость — 401/403', async () => {
    const r = await req('POST', `/api/clubs/${CLUB_A}/catalog/categories`, reception.token, { name: 'Коктейли' });
    assert.equal(r.status, 403);
    const g = await req('POST', `/api/clubs/${CLUB_A}/catalog/categories`, guest.token, { name: 'Коктейли' });
    assert.equal(g.status, 403);
  });

  it('управляющий: категория, группа модификаторов, товар; журнал; повтор имени — 409', async () => {
    const cat = await req('POST', `/api/clubs/${CLUB_A}/catalog/categories`, manager.token, { name: 'Лимонады', sort: 60 });
    assert.equal(cat.status, 201);
    const dup = await req('POST', `/api/clubs/${CLUB_A}/catalog/categories`, manager.token, { name: 'лимонады' });
    assert.deepEqual([dup.status, dup.json.error], [409, 'duplicate']);
    const grp = await req('POST', `/api/clubs/${CLUB_A}/catalog/modifier-groups`, manager.token, {
      name: 'Лёд', min_select: 0, max_select: 1, modifiers: [{ name: 'Со льдом', price_delta_kopecks: 0 }, { name: 'Двойной лёд', price_delta_kopecks: 1000, stock_factor: 1 }],
    });
    assert.equal(grp.status, 201, JSON.stringify(grp.json));
    groupId = grp.json.id;
    const prod = await req('POST', `/api/clubs/${CLUB_A}/catalog/products`, manager.token, {
      name: 'Лимонад', price_kopecks: 19900, category_id: cat.json.id, unit: 'порц', vat_code: 1, modifier_group_ids: [groupId], sku: 'LEM-1',
    });
    assert.equal(prod.status, 201, JSON.stringify(prod.json));
    productId = prod.json.id;
    assert.equal(prod.json.payment_subject, 'commodity');
    const dupSku = await req('POST', `/api/clubs/${CLUB_A}/catalog/products`, manager.token, { name: 'Другой', price_kopecks: 100, sku: 'LEM-1' });
    assert.equal(dupSku.status, 409);
    const bad = await req('POST', `/api/clubs/${CLUB_A}/catalog/products`, manager.token, { name: 'Ноль', price_kopecks: 0 });
    assert.equal(bad.status, 400);
    const badPhoto = await req('POST', `/api/clubs/${CLUB_A}/catalog/products`, manager.token, { name: 'Фото', price_kopecks: 100, photo: 'javascript:alert(1)' });
    assert.equal(badPhoto.status, 400);
    assert.ok((await h.audit('catalog.product_create')).some((a) => a.object_id === productId && a.actor_id === manager.id));
  });

  it('изменение цены — в журнале «было → стало»; снятие с продажи скрывает товар из меню', async () => {
    const upd = await req('PATCH', `/api/catalog/products/${productId}`, manager.token, { price_kopecks: 21900 });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.price_kopecks, 21900);
    const [a] = (await h.audit('catalog.product_update')).filter((x) => x.object_id === productId);
    assert.deepEqual(a.data.changes.price_kopecks, [19900, 21900]);
    const off = await req('PATCH', `/api/catalog/products/${productId}`, owner.token, { active: false });
    assert.equal(off.json.active, false);
    const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.ok(!JSON.stringify(menu.json).includes(productId));
    const full = await req('GET', `/api/clubs/${CLUB_A}/catalog`, manager.token);
    assert.ok(full.json.products.some((p) => p.id === productId && p.active === false));
    const mod = await req('POST', `/api/catalog/modifier-groups/${groupId}/modifiers`, manager.token, { name: 'Без льда', is_default: true });
    assert.equal(mod.status, 201);
    const modUpd = await req('PATCH', `/api/catalog/modifiers/${mod.json.id}`, manager.token, { price_delta_kopecks: 500, stock_factor: 0.5 });
    assert.equal(modUpd.json.stock_factor, 0.5);
    assert.equal(modUpd.json.price_delta_kopecks, 500);
    const missing = await req('PATCH', '/api/catalog/products/cb999999-0000-4000-8000-000000000001', manager.token, { price_kopecks: 1 });
    assert.equal(missing.status, 404);
  });

  it('стоп-лист: ресепшн переключает (№88), но не меняет цену; в меню недоступен, продажа — 409 stop_list', async () => {
    const price = await req('PATCH', `/api/catalog/products/${P.sparkling}`, reception.token, { price_kopecks: 1 });
    assert.equal(price.status, 403);
    const g = await req('POST', `/api/catalog/products/${P.sparkling}/stop-list`, guest.token, { stop_list: true });
    assert.equal(g.status, 403);
    const r = await req('POST', `/api/catalog/products/${P.sparkling}/stop-list`, reception.token, { stop_list: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.stop_list, true);
    assert.ok((await h.audit('catalog.stop_list')).some((a) => a.object_id === P.sparkling && a.actor_id === reception.id));
    const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.equal(menu.json.categories.flatMap((c) => c.products).find((p) => p.id === P.sparkling).available, false);
    const sale = await h.request('POST', '/api/pos/sales', { token: reception.token, body: { items: [{ product_id: P.sparkling, qty: 1 }], method: 'card_terminal' }, key: newKey(), club: CLUB_A });
    assert.deepEqual([sale.status, sale.json.error], [409, 'stop_list']);
    const off = await req('POST', `/api/catalog/products/${P.sparkling}/stop-list`, reception.token, { stop_list: false });
    assert.equal(off.json.stop_list, false);
  });
});

describe('импорт меню из CSV', { skip: SKIP }, () => {
  const csv = [
    'Категория;Название;Цена;Ед;Алкоголь;Артикул',
    'Снеки;Сухарики;"95,50";шт;нет;SNK-RUSK',
    'Пиво;Пиво тёмное 0,5 л;270;шт;да;BEER-DARK',
    'Десерты;"Чизкейк ""Нью-Йорк""";320;порц;;',
  ].join('\r\n');

  it('ошибки по строкам — ничего не записано', async () => {
    const broken = `${csv}\r\nСнеки;Без цены;;шт;нет;\r\nСнеки;Странное;10;ящик;нет;`;
    const r = await req('POST', `/api/clubs/${CLUB_A}/catalog/import`, manager.token, { csv: broken });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, false);
    assert.deepEqual(r.json.errors, [{ line: 5, field: 'price', code: 'bad_price' }, { line: 6, field: 'unit', code: 'bad_unit' }]);
    assert.equal((await h.q("select count(*)::int as n from bl.products where sku = 'SNK-RUSK'"))[0].n, 0);
  });

  it('пробный прогон, применение, повтор без изменений; журнал catalog.import', async () => {
    const dry = await req('POST', `/api/clubs/${CLUB_A}/catalog/import`, manager.token, { csv, dry_run: true });
    assert.deepEqual([dry.json.applied, dry.json.created, dry.json.categories_created], [false, 3, ['Десерты']]);
    const r = await req('POST', `/api/clubs/${CLUB_A}/catalog/import`, manager.token, { csv });
    assert.deepEqual([r.json.applied, r.json.created, r.json.updated], [true, 3, 0]);
    const [rusk] = await h.q("select * from bl.products where sku = 'SNK-RUSK'");
    assert.equal(Number(rusk.price_kopecks), 9550);
    const [dark] = await h.q("select * from bl.products where sku = 'BEER-DARK'");
    assert.equal(dark.is_alcohol, true);
    assert.equal(dark.payment_subject, 'excise');
    const [cake] = await h.q("select * from bl.products where name = 'Чизкейк \"Нью-Йорк\"'");
    assert.equal(cake.unit, 'порц');
    const again = await req('POST', `/api/clubs/${CLUB_A}/catalog/import`, manager.token, { csv: csv.replace('"95,50"', '99') });
    assert.deepEqual([again.json.created, again.json.updated, again.json.unchanged], [0, 1, 2]);
    const audits = await h.audit('catalog.import');
    assert.equal(audits.length, 2);
    assert.equal(audits[1].data.price_changes, 1);
    const anon = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.ok(!JSON.stringify(anon.json).includes('Пиво тёмное'), 'импортированный алкоголь гостю не виден');
  });
});

describe('склад', { skip: SKIP }, () => {
  const post = (path, token, body) => h.request('POST', path, { token, body, club: CLUB_A });

  it('приход — управляющий; ресепшн — 403; средняя себестоимость по приходам', async () => {
    const denied = await post('/api/stock/arrivals', reception.token, { items: [{ product_id: P.chips, qty: 10, cost_kopecks: 70000 }] });
    assert.equal(denied.status, 403);
    // Сид: 30 шт за 2 100 ₽; приход 10 шт по 80 ₽ → средняя (210 000 + 80 000) / 40 = 72,50 ₽.
    const r = await post('/api/stock/arrivals', manager.token, { items: [{ product_id: P.chips, qty: 10, unit_cost_kopecks: 8000 }], note: 'Накладная 17' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.cost_kopecks, 80000);
    const list = await h.request('GET', `/api/clubs/${CLUB_A}/stock`, { token: reception.token });
    const chips = list.json.find((x) => x.product_id === P.chips);
    assert.equal(chips.qty, 40);
    assert.equal(chips.avg_cost_kopecks, 7250);
    assert.equal(chips.value_kopecks, 290000);
  });

  it('списание — только с причиной, себестоимость по средней', async () => {
    const no = await post('/api/stock/writeoffs', manager.token, { items: [{ product_id: P.chips, qty: 1 }] });
    assert.deepEqual([no.status, no.json.error], [400, 'reason_required']);
    const r = await post('/api/stock/writeoffs', manager.token, { items: [{ product_id: P.chips, qty: 2 }], reason: 'Порвана упаковка' });
    assert.equal(r.status, 201);
    assert.equal(r.json.cost_kopecks, 14500);
    assert.equal(await h.stock(P.chips), 38);
    assert.ok((await h.audit('stock.writeoff')).some((a) => a.reason === 'Порвана упаковка'));
  });

  it('ревизия «факт против расчёта»: расхождение в штуках и деньгах, поправка остатка', async () => {
    // Орешки: сид 30 шт за 2 700 ₽ (90 ₽); факт 27 → недостача 3 шт = −270 ₽. Вода: факт = расчёт.
    const water = await h.stock(P.water);
    const r = await post('/api/stock/audits', manager.token, {
      items: [{ product_id: P.nuts, actual_qty: 27 }, { product_id: P.water, actual_qty: water }],
      note: 'Ревизия недели',
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const nuts = r.json.lines.find((l) => l.product_id === P.nuts);
    assert.deepEqual([nuts.expected_qty, nuts.actual_qty, nuts.diff_qty, nuts.diff_kopecks, nuts.unit_cost_kopecks], [30, 27, -3, -27000, 9000]);
    assert.equal(r.json.lines.find((l) => l.product_id === P.water).diff_kopecks, 0);
    assert.equal(r.json.total_diff_kopecks, -27000);
    assert.equal(await h.stock(P.nuts), 27);
    const get = await h.request('GET', `/api/stock/audits/${r.json.audit_id}`, { token: manager.token, club: CLUB_A });
    assert.equal(get.json.total_diff_kopecks, -27000);
    const mv = await h.request('GET', `/api/clubs/${CLUB_A}/stock/movements?product_id=${P.nuts}`, { token: manager.token });
    assert.deepEqual(mv.json.map((m) => m.kind), ['audit', 'arrival']);
  });

  it('стоп-лист при нуле (настройка клуба): товар кончился — недоступен в меню и в заказе', async () => {
    const left = await h.stock(P.chips);
    await post('/api/stock/writeoffs', manager.token, { items: [{ product_id: P.chips, qty: left }], reason: 'Обнуление для теста' });
    const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.equal(menu.json.categories.flatMap((c) => c.products).find((p) => p.id === P.chips).available, false);
    const sid = await h.session({ resourceId: table(6), payer: guest.id });
    const o = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.chips, qty: 1 }], pay: 'tab' }, key: newKey() });
    assert.deepEqual([o.status, o.json.error], [409, 'stop_list']);
    // Настройку меняет только владелец; без стоп-листа при нуле товар снова доступен.
    const deny = await h.request('PATCH', `/api/clubs/${CLUB_A}/pos/settings`, { token: manager.token, body: { stop_at_zero: false } });
    assert.equal(deny.status, 403);
    const ok = await h.request('PATCH', `/api/clubs/${CLUB_A}/pos/settings`, { token: owner.token, body: { stop_at_zero: false } });
    assert.equal(ok.json.stop_at_zero, false);
    const menu2 = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.equal(menu2.json.categories.flatMap((c) => c.products).find((p) => p.id === P.chips).available, true);
    await h.request('PATCH', `/api/clubs/${CLUB_A}/pos/settings`, { token: owner.token, body: { stop_at_zero: true } });
  });
});
