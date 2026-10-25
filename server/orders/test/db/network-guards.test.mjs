// Находки pentester M5.5 (Н-1…Н-3) на настоящем Postgres:
//   Н-1 — скидка мимо лимита, причины и тревоги через модификатор с отрицательной надбавкой (инвариант 8):
//         надбавка только 0 и больше; старая отрицательная в продаже — 400; в «жёстком» меню сети привязка
//         групп модификаторов к товару шаблона — под замком network_locked;
//   Н-2 — терминал управляющего сети гаснет вместе с его доступом (вывод клуба, отзыв, архив сети);
//         управляющий сети терминал не заводит;
//   Н-3 — управляющий сети не видит деньги по способам оплаты ни в одном GET-маршруте клуба (обход всех
//         маршрутов роли manager) и в SSE; итоги и сверка кассы смены (ожидалось, факт, расхождение) остаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../../api/router.mjs';
import { newToken, tokenHash } from '../../../auth/index.mjs';
import { CLUB_A, M, newKey, P, PHONES, setup } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const NM_PHONE = '+79990000301';
const EXTRA = ['owner.mjs', 'shifts.mjs', 'history.mjs', 'dashboard.mjs', 'who-played.mjs', 'cashbook.mjs', 'reports.mjs', 'staff.mjs', 'networks.mjs'];
const FILES = ['auth.mjs', 'catalog.mjs', 'orders.mjs', 'pos.mjs', 'stock.mjs', 'reception.mjs', 'webhooks.mjs', 'payments.mjs', ...EXTRA];

let h;
let owner;
let manager;
let reception;
let nm;
let net;
let memberId;

const req = (method, path, who, body, extra = {}) => h.request(method, path, { token: who.token, body, club: CLUB_A, ...extra });
const sale = (who, body) => h.request('POST', '/api/pos/sales', { token: who.token, body, key: newKey(), club: CLUB_A });

before(async () => {
  if (SKIP) return;
  h = await setup({ extraRoutes: EXTRA });
  owner = await h.login('+70000000001');
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
  await h.openShift();
  // Сеть владельца A из клуба A и управляющий сети по приглашению (привязывается при первом входе).
  const created = await req('POST', '/api/networks', owner, { name: 'Сеть Н' }, { club: undefined });
  net = created.json.id;
  assert.equal((await req('POST', `/api/networks/${net}/clubs`, owner, { club_id: CLUB_A }, { club: undefined })).status, 201);
  const inv = await req('POST', `/api/networks/${net}/managers`, owner, { phone: NM_PHONE }, { club: undefined });
  assert.equal(inv.status, 201, JSON.stringify(inv.json));
  memberId = inv.json.id;
  nm = await h.login(NM_PHONE);
});

after(async () => {
  await h?.close();
});

describe('Н-1. Модификатор не снижает цену мимо механизма скидок (инвариант 8)', { skip: SKIP }, () => {
  it('отрицательная надбавка при создании группы, модификатора и правке — 400 bad_request; нулевая и положительная — можно', async () => {
    const neg = await req('POST', `/api/clubs/${CLUB_A}/catalog/modifier-groups`, manager, { name: 'Акция', modifiers: [{ name: 'Своим', price_delta_kopecks: -14000 }] });
    assert.deepEqual([neg.status, neg.json], [400, { error: 'bad_request' }]);
    assert.equal((await h.q("select count(*)::int as n from bl.modifier_groups where name = 'Акция'"))[0].n, 0, 'группа не создана');
    const ok = await req('POST', `/api/clubs/${CLUB_A}/catalog/modifier-groups`, manager, { name: 'Топпинг', modifiers: [{ name: 'Без', price_delta_kopecks: 0 }, { name: 'Доп', price_delta_kopecks: 1500 }] });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    const [free, extra] = ok.json.modifiers;
    assert.equal((await req('POST', `/api/catalog/modifier-groups/${ok.json.id}/modifiers`, manager, { name: 'Скидка', price_delta_kopecks: -1 })).status, 400);
    assert.equal((await req('PATCH', `/api/catalog/modifiers/${extra.id}`, manager, { price_delta_kopecks: -100 })).status, 400);
    assert.equal((await req('PATCH', `/api/catalog/modifiers/${free.id}`, manager, { price_delta_kopecks: 500 })).json.price_delta_kopecks, 500);
  });

  it('старая отрицательная надбавка в данных: продажа отклоняется 400, цена не снижается; правка — только с новой надбавкой', async () => {
    // Данные, оставшиеся от времён, когда отрицательная надбавка была допустима (прямой UPDATE суперпользователя).
    await h.q('update bl.modifiers set price_delta_kopecks = -4000 where id = $1', [M.v04]);
    const before = (await h.q('select count(*)::int as n from bl.pos_sales'))[0].n;
    const res = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.sugar] }], method: 'cash', received_kopecks: 100000 });
    assert.deepEqual([res.status, res.json], [400, { error: 'bad_request' }]);
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales'))[0].n, before, 'продажи нет');
    // Без отрицательного модификатора тот же товар продаётся.
    const fine = await sale(reception, { items: [{ product_id: P.cappuccino, qty: 1, modifier_ids: [M.v03, M.sugar] }], method: 'cash', received_kopecks: 100000 });
    assert.equal(fine.status, 201, JSON.stringify(fine.json));
    // Правка названия, не трогая надбавку, не оставляет скидку действующей; выключить — можно; задать заново — можно.
    assert.equal((await req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { name: 'Большая порция' })).status, 400);
    assert.equal((await req('PATCH', `/api/catalog/modifiers/${M.v04}`, manager, { price_delta_kopecks: 4000 })).json.price_delta_kopecks, 4000);
  });

  it('жёсткое меню сети: привязка групп модификаторов к товару шаблона — 409 network_locked; мягкое и свой товар — можно', async () => {
    const cap = await req('GET', `/api/clubs/${CLUB_A}/catalog`, manager);
    const group = cap.json.modifier_groups[0].id;
    // Сеть уже создана API; шаблон меню — строкой напрямую, товар клуба «вода» привязан к нему.
    const tpl = (await h.q(
      `insert into bl.network_products (network_id, name, price_kopecks, updated_by) values ($1, 'Вода', 9000, $2) returning id`, [net, OWNER_A],
    ))[0].id;
    await h.q('update bl.networks set menu_template = true, menu_mode = $2, menu_version = 1 where id = $1', [net, 'hard']);
    await h.q('update bl.products set network_product_id = $2 where id = $1', [P.water, tpl]);
    const locked = await req('PATCH', `/api/catalog/products/${P.water}`, manager, { modifier_group_ids: [group] });
    assert.deepEqual([locked.status, locked.json.error], [409, 'network_locked']);
    assert.equal((await h.q('select count(*)::int as n from bl.product_modifier_groups where product_id = $1 and active', [P.water]))[0].n, 0, 'ничего не привязано');
    // Тот же состав (без изменений) и поле клуба — не блокируются.
    assert.equal((await req('PATCH', `/api/catalog/products/${P.water}`, manager, { modifier_group_ids: [], sort: 3 })).status, 200);
    // Свой товар клуба в жёстком режиме — можно.
    assert.equal((await req('PATCH', `/api/catalog/products/${P.chips}`, manager, { modifier_group_ids: [group] })).status, 200);
    // Мягкий режим — можно.
    await h.q("update bl.networks set menu_mode = 'soft' where id = $1", [net]);
    assert.equal((await req('PATCH', `/api/catalog/products/${P.water}`, manager, { modifier_group_ids: [group] })).status, 200);
    await h.q("update bl.networks set menu_mode = 'hard' where id = $1", [net]);
    // Снять привязку в жёстком — тоже под замком.
    assert.equal((await req('PATCH', `/api/catalog/products/${P.water}`, manager, { modifier_group_ids: [] })).status, 409);
    await h.q('update bl.networks set menu_template = false where id = $1', [net]);
  });
});

describe('Н-3. Управляющий сети без денег по способам оплаты', { skip: SKIP }, () => {
  const METHOD_VALUES = new Set(['cash', 'card_terminal', 'sbp', 'card']);
  const HIDDEN_KEYS = new Set(['method', 'methods', 'payment_method', 'by_method', 'cash_sales_kopecks', 'cash_refunds_kopecks', 'received_kopecks', 'change_kopecks']);
  // Утечка: поле способа с не-null значением, способ строкой (в любом поле) или сумма под ключом-способом.
  const leaks = (v, path = '') => {
    if (Array.isArray(v)) return v.flatMap((x, i) => leaks(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      return Object.entries(v).flatMap(([k, x]) => {
        const at = `${path}.${k}`;
        if (HIDDEN_KEYS.has(k) && x !== null) return [at];
        if (METHOD_VALUES.has(k) && x !== null && typeof x === 'number') return [at];
        return leaks(x, at);
      });
    }
    return typeof v === 'string' && METHOD_VALUES.has(v) ? [path] : [];
  };

  let saleId;
  it('подготовка: управляющий сети привязан, продажи наличными и картой терминала, у владельца способы видны', async () => {
    const me = await req('GET', '/api/me', nm);
    assert.ok(me.json.clubs.some((c) => c.club_id === CLUB_A && c.network_id === net), JSON.stringify(me.json.clubs));
    const s1 = await sale(reception, { items: [{ product_id: P.water, qty: 2 }], method: 'cash', received_kopecks: 50000 });
    const s2 = await sale(reception, { items: [{ product_id: P.water, qty: 1 }], method: 'card_terminal' });
    assert.deepEqual([s1.status, s2.status], [201, 201], JSON.stringify([s1.json, s2.json]));
    saleId = s1.json.sale_id;
    assert.equal(s1.json.method, 'cash');
    const own = await req('GET', `/api/pos/sales/${saleId}`, owner);
    assert.deepEqual([own.json.method, own.json.received_kopecks], ['cash', 50000]);
  });

  it('смена, продажи кассы, журнал: способ и наличные по способам — null; ожидалось, факт, расхождение и итоги остаются', async () => {
    const cur = await req('GET', `/api/clubs/${CLUB_A}/shifts/current`, nm);
    assert.equal(cur.status, 200);
    assert.deepEqual([cur.json.shift.cash_sales_kopecks, cur.json.shift.cash_refunds_kopecks], [null, null]);
    assert.equal(typeof cur.json.shift.expected_cash_kopecks, 'number', 'сверка кассы остаётся');
    const ownCur = await req('GET', `/api/clubs/${CLUB_A}/shifts/current`, owner);
    assert.ok(ownCur.json.shift.cash_sales_kopecks > 0, 'владельцу наличные видны');
    const list = await req('GET', `/api/clubs/${CLUB_A}/pos/sales`, nm);
    assert.equal(list.status, 200);
    const items = list.json.items ?? list.json;
    assert.ok(items.length >= 2 && items.every((x) => x.method === null && x.total_kopecks > 0), JSON.stringify(items[0]));
    const one = await req('GET', `/api/pos/sales/${saleId}`, nm);
    assert.deepEqual([one.json.method, one.json.received_kopecks, one.json.change_kopecks, one.json.total_kopecks], [null, null, null, 18000]);
    const audit = await req('GET', `/api/clubs/${CLUB_A}/audit?action=pos.sale&limit=10`, nm);
    assert.ok(audit.json.items.length >= 2 && audit.json.items.every((i) => i.data.method === null && i.data.received_kopecks === null));
    assert.ok((await req('GET', `/api/clubs/${CLUB_A}/audit?action=pos.sale&limit=10`, owner)).json.items.some((i) => i.data.method === 'cash'));
    // Закрытие смены и списки смен: те же правила.
    const shiftList = await req('GET', `/api/clubs/${CLUB_A}/shifts`, nm);
    assert.ok(shiftList.json.items.every((s) => s.cash_sales_kopecks === null || s.cash_sales_kopecks === undefined));
  });

  it('обход всех GET-маршрутов роли manager: ни один не отдаёт управляющему сети способы оплаты; у владельца они есть', async () => {
    const routes = (await loadRoutes({ config: h.config, only: FILES })).filter(
      (r) => r.method === 'GET' && r.auth === 'staff' && r.roles?.includes('manager') && /\{club\}/.test(r.path) && !/\{(?!club\})/.test(r.path) && !r.stream && r.networkManager !== false,
    );
    assert.ok(routes.length >= 15, `маршрутов ${routes.length}`);
    const bad = [];
    const ownerSees = [];
    for (const r of routes) {
      const path = r.path.replace('{club}', CLUB_A);
      const net1 = await req('GET', path, nm);
      const own = await req('GET', path, owner);
      if (own.status === 200 && leaks(own.json).length) ownerSees.push(r.path);
      if (net1.status === 200 && leaks(net1.json).length) bad.push(`${r.path} ${leaks(net1.json).slice(0, 3).join(',')}`);
    }
    assert.deepEqual(bad, []);
    assert.ok(ownerSees.length >= 3, `у владельца способы видны в ${ownerSees.length} маршрутах: проверка осмысленна`);
    // По id смены: отчёт и карточка.
    const shiftId = (await req('GET', `/api/clubs/${CLUB_A}/shifts/current`, nm)).json.shift.id;
    for (const path of [`/api/shifts/${shiftId}`, `/api/shifts/${shiftId}/report?online=0`]) {
      const r = await req('GET', path, nm);
      assert.equal(r.status, 200, path);
      assert.deepEqual(leaks(r.json), [], path);
    }
    const report = await req('GET', `/api/shifts/${shiftId}/report?online=0`, nm);
    assert.equal(report.json.methods_hidden, true);
    assert.ok(report.json.revenue.total_kopecks > 0);
  });
});

describe('Н-2. Терминал управляющего сети гаснет вместе с его доступом', { skip: SKIP }, () => {
  const terminalOf = async (name) => {
    const token = newToken();
    const nmId = nm.id;
    await h.q(
      `insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at)
       values ($1, $2, $3, $4, now(), now() + interval '365 days')`,
      [CLUB_A, name, tokenHash(token), nmId],
    );
    return token;
  };
  const alive = async (token) => (await h.request('GET', '/api/staff/terminal', { token })).status === 200;

  it('новый терминал управляющему сети не заводится (403); владельцу и управляющему клуба — можно', async () => {
    const r = await h.request('POST', '/api/staff/terminal', { token: nm.token, body: { club_id: CLUB_A, name: 'Стойка сети' } });
    assert.deepEqual([r.status, r.json.error], [403, 'forbidden']);
    assert.equal((await h.request('POST', '/api/staff/terminal', { token: manager.token, body: { club_id: CLUB_A, name: 'Стойка 1' } })).status, 200);
  });

  it('отзыв управляющего сети гасит заведённые им терминалы; терминал другого сотрудника живёт', async () => {
    const mine = await terminalOf('Старый терминал');
    const others = newToken();
    await h.q(
      `insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at) values ($1, 'Чужой', $2, $3, now(), now() + interval '365 days')`,
      [CLUB_A, tokenHash(others), manager.id],
    );
    assert.equal(await alive(mine), true);
    const rv = await req('DELETE', `/api/networks/${net}/managers/${memberId}`, owner, undefined, { club: undefined });
    assert.equal(rv.status, 200, JSON.stringify(rv.json));
    assert.equal(await alive(mine), false, 'терминал отозван вместе с доступом');
    assert.equal(await alive(others), true, 'терминал, заведённый управляющим клуба, не тронут');
    assert.equal((await h.q('select count(*)::int as n from bl.staff_terminals where created_by = $1 and revoked_at is null', [nm.id]))[0].n, 0);
  });

  it('вывод клуба из сети и архив сети гасят терминалы управляющего, пока он держал доступ от сети', async () => {
    // Управляющий принят снова (новое приглашение на тот же номер) и заводит терминал «старым» способом.
    const inv = await req('POST', `/api/networks/${net}/managers`, owner, { phone: NM_PHONE }, { club: undefined });
    assert.equal(inv.status, 201, JSON.stringify(inv.json));
    // Привязка приглашения — при входе: токен существующий, поэтому новый вход.
    const again = await h.request('POST', '/api/auth/dev', { body: { phone: NM_PHONE } });
    assert.equal(again.status, 200);
    const tok = await terminalOf('Терминал 2');
    assert.equal(await alive(tok), true);
    const out = await req('DELETE', `/api/networks/${net}/clubs/${CLUB_A}`, owner, undefined, { club: undefined });
    assert.equal(out.status, 200, JSON.stringify(out.json));
    assert.equal(await alive(tok), false, 'клуб выведен — терминал отозван');
    // Архив сети: возвращаем клуб, ещё терминал, архивируем.
    assert.equal((await req('POST', `/api/networks/${net}/clubs`, owner, { club_id: CLUB_A }, { club: undefined })).status, 201);
    const tok2 = await terminalOf('Терминал 3');
    assert.equal(await alive(tok2), true);
    assert.equal((await req('DELETE', `/api/networks/${net}`, owner, undefined, { club: undefined })).status, 200);
    assert.equal(await alive(tok2), false, 'сеть в архиве — терминал отозван');
  });

  it('прямое членство в клубе не страдает: терминал пользователя, который и управляющий клуба напрямую, живёт после выхода из сети', async () => {
    // manager клуба A (прямое членство) — в сеть не входит; его терминал вывод клуба из сети не трогает.
    const tok = newToken();
    await h.q(
      `insert into bl.staff_terminals (club_id, name, token_hash, created_by, created_at, expires_at) values ($1, 'Прямой', $2, $3, now(), now() + interval '365 days')`,
      [CLUB_A, tokenHash(tok), manager.id],
    );
    const n2 = (await req('POST', '/api/networks', owner, { name: 'Сеть 2' }, { club: undefined })).json.id;
    assert.equal((await req('POST', `/api/networks/${n2}/clubs`, owner, { club_id: CLUB_A }, { club: undefined })).status, 201);
    assert.equal((await req('DELETE', `/api/networks/${n2}/clubs/${CLUB_A}`, owner, undefined, { club: undefined })).status, 200);
    assert.equal(await alive(tok), true);
  });
});
