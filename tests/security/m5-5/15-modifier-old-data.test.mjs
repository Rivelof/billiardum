// PoC M5.5, заход 2 — Н-1, «старые данные»: действующий модификатор с отрицательной надбавкой, оставшийся от времён
// до запрета (№217). Создать такой через API нельзя — прямой UPDATE на СВОЁМ временном Postgres. Используется
// обвязка тестов репозитория (server/orders/test/db/harness.mjs: настоящий createApp, роутер, сид).
//
// Проверки: касса (наличные, СБП), заказ гостя в счёт стола и онлайн, надбавка по умолчанию в группе
// с min_select > 0, сумма +/− двух модификаторов, неактивный модификатор, повторное включение, переименование,
// сброс надбавки в 0; цена строки не опускается ниже цены товара ни в одном пути.
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-5/15-modifier-old-data.test.mjs

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, M, newKey, P, PHONES, setup } from '../../../server/orders/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

let h;
let owner;
let manager;
let reception;
const req = (method, path, who, body, extra = {}) => h.request(method, path, { token: who.token, body, club: CLUB_A, ...extra });
const sale = (who, body) => h.request('POST', '/api/pos/sales', { token: who.token, body, key: newKey(), club: CLUB_A });

before(async () => {
  if (SKIP) return;
  h = await setup();
  owner = await h.login(PHONES.owner);
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
  await h.openShift();
});
after(async () => {
  await h?.close();
});

describe('Н-1 (заход 2): старая отрицательная надбавка не снижает цену ни в одном пути', { skip: SKIP }, () => {
  it('подготовка: сид содержит модификаторы капучино; одному задаём −4000 прямым UPDATE', async () => {
    const mods = await h.q('select id, price_delta_kopecks from bl.modifiers where id = any($1::uuid[])', [[M.v03, M.v04, M.noSugar, M.sugar]]);
    assert.equal(mods.length, 4);
    await h.q('update bl.modifiers set price_delta_kopecks = -4000 where id = $1', [M.v04]);
    const price = Number((await h.q('select price_kopecks from bl.products where id = $1', [P.cappuccino]))[0].price_kopecks);
    assert.ok(price > 4000, `цена капучино ${price}`);
  });

  it('касса: наличные и карта терминала с отрицательным модификатором → 400, продажи нет', async () => {
    const before = (await h.q('select count(*)::int as n from bl.pos_sales'))[0].n;
    for (const method of ['cash', 'card_terminal']) {
      const res = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04] }], method, received_kopecks: method === 'cash' ? 100000 : undefined });
      assert.deepEqual([res.status, res.json.error], [400, 'bad_request'], method);
    }
    // Вместе с положительным — то же (проверка по каждому модификатору, а не по сумме).
    const mixed = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.sugar] }], method: 'cash', received_kopecks: 100000 });
    assert.equal(mixed.status, 400);
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales'))[0].n, before);
  });

  it('несколько строк корзины: одна чистая и одна с минусом → вся продажа 400 (частичной нет)', async () => {
    const before = (await h.q('select count(*)::int as n from bl.pos_sales'))[0].n;
    const res = await sale(manager, {
      items: [{ product_id: P.water, qty: 1 }, { product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04] }], method: 'cash', received_kopecks: 100000,
    });
    assert.equal(res.status, 400);
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales'))[0].n, before);
  });

  it('заказ гостя со стола (в счёт и онлайн) с отрицательным модификатором → 400', async () => {
    const guest = await h.login('+79990000611');
    const sid = await h.session({ resourceId: 'e1000000-0000-4000-8000-000000000005', payer: guest.id });
    for (const pay of ['tab', 'online']) {
      const o = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04] }], pay }, key: newKey() });
      assert.deepEqual([o.status, o.json.error], [400, 'bad_request'], pay);
    }
    const okOrder = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v03] }], pay: 'tab' }, key: newKey() });
    assert.equal(okOrder.status, 201, JSON.stringify(okOrder.json));
    await h.closeSession(sid);
  });

  it('надбавка по умолчанию: если группа с min_select = 1 выбирает отрицательный модификатор сама → 400', async () => {
    // Группа капучино «Объём» (v03/v04): делаем v04 модификатором по умолчанию и требуем выбор.
    const grp = (await h.q('select group_id from bl.modifiers where id = $1', [M.v04]))[0].group_id;
    await h.q('update bl.modifier_groups set min_select = 1, max_select = 1 where id = $1', [grp]);
    await h.q('update bl.modifiers set is_default = false where group_id = $1', [grp]);
    await h.q('update bl.modifiers set is_default = true where id = $1', [M.v04]);
    const res = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1 }], method: 'cash', received_kopecks: 100000 });
    assert.deepEqual([res.status, res.json.error], [400, 'bad_request'], 'выбор по умолчанию тоже проверяется');
    // С явным выбором безопасного — проходит.
    const fine = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v03] }], method: 'cash', received_kopecks: 100000 });
    assert.equal(fine.status, 201, JSON.stringify(fine.json));
    assert.equal(fine.json.discount_kopecks, 0);
  });

  it('неактивный отрицательный модификатор недоступен: выбор → 400, умолчание не подставляется', async () => {
    await req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { active: false });
    const res = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04] }], method: 'cash', received_kopecks: 100000 });
    assert.equal(res.status, 400);
  });

  it('включить обратно, переименовать, сделать по умолчанию — 400, пока надбавка отрицательная; 0 — можно', async () => {
    for (const body of [{ active: true }, { active: true, name: 'Большая' }, { name: 'Большая' }, { is_default: true }, { sort: 3 }]) {
      const r = await req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, body);
      // Неактивный: переименование/сортировка отрицательного допустимы (он не действует); включение — нет.
      if (body.active === true) assert.equal(r.status, 400, JSON.stringify(body));
    }
    const state = (await h.q('select active, price_delta_kopecks from bl.modifiers where id = $1', [M.v04]))[0];
    assert.equal(state.active, false, 'отрицательный модификатор остался выключен');
    const fixed = await req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { price_delta_kopecks: 0, active: true });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.json));
  });

  it('гонка: два параллельных PATCH — «включить» и «надбавка −1000» — отрицательное действующим не становится', async () => {
    await h.q('update bl.modifiers set active = false, price_delta_kopecks = -2500 where id = $1', [M.v04]);
    const results = await Promise.all([
      req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { active: true }),
      req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { price_delta_kopecks: -1000, active: true }),
      req('PATCH', `/api/catalog/modifiers/${M.v04}`, owner, { active: true }),
    ]);
    const row = (await h.q('select active, price_delta_kopecks::int as d from bl.modifiers where id = $1', [M.v04]))[0];
    assert.ok(!(row.active && row.d < 0), `статусы ${results.map((r) => r.status)} состояние ${JSON.stringify(row)}`);
  });

  it('в базе нет строк заказов дешевле товара (все пути прогона)', async () => {
    const bad = await h.q('select oi.id from bl.order_items oi join bl.products p on p.id = oi.product_id where oi.unit_price_kopecks < p.price_kopecks');
    assert.deepEqual(bad, []);
  });
});
