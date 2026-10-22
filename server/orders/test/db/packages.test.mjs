// Пакет часов на кассе (контракт M3 §1 п. 10; decisions №112) на настоящем Postgres и эмуляторе
// ЮKassa: позиция корзины { kind: 'package', package_id, user_id | phone }, гость обязателен и только
// существующий (№117: с телефоном и согласием; учётка не заводится — guest_not_found),
// строка чека — money packageSaleLine («предоплата 100 %»), скидка на пакет не действует, после
// оплаты — минуты на балансе гостя (creditPackageForSale), повтор — без второго начисления.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { guestLookupGuard } from '../../guest-lookup.mjs';
import { linesTotal } from '../../money.mjs';
import { CLUB_A, CLUB_B, newKey, P, PHONES, setup, waitFor } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const GUEST = 'a9000000-0000-4000-8000-0000000000bb';
const NO_CONSENT = 'a9000000-0000-4000-8000-0000000000cc';
let h;
let reception;
let pkgA;
let pkgB;
let pkgOld;

before(async () => {
  if (SKIP) return;
  h = await setup();
  reception = await h.login(PHONES.reception);
  await h.q(`insert into bl.users (id, phone) values ($1, '+79990000077') on conflict do nothing`, [GUEST]);
  await h.q(`insert into bl.consents (user_id, version, accepted_at) values ($1, '2026-10-21', now()) on conflict do nothing`, [GUEST]);
  await h.q(`insert into bl.users (id, phone) values ($1, '+79990000088') on conflict do nothing`, [NO_CONSENT]);
  const ins = async (clubId, title, active = true) =>
    (await h.q(
      `insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days, active) values ($1, $2, 600, 500000, 30, $3) returning id`,
      [clubId, title, active],
    ))[0].id;
  pkgA = await ins(CLUB_A, 'Десятка');
  pkgB = await ins(CLUB_B, 'Чужой');
  pkgOld = await ins(CLUB_A, 'Снят', false);
  await h.openShift();
});

after(async () => {
  await h?.close();
});

const sale = (body, key = newKey()) => h.request('POST', '/api/pos/sales', { token: reception.token, body, key, club: CLUB_A });
const lots = (userId) => h.q('select * from bl.balance_lots where user_id = $1 order by created_at', [userId]);

describe('касса: пакет часов', { skip: SKIP }, () => {
  it('без гостя — 400 guest_required; чужой или снятый пакет — 404; неверный телефон — 400; ничего не записано', async () => {
    const before = (await h.q('select count(*)::int as n from bl.pos_sales'))[0].n;
    const none = await sale({ items: [{ kind: 'package', package_id: pkgA }], method: 'cash', received_kopecks: 500000 });
    assert.equal(none.status, 400);
    assert.deepEqual(none.json, { error: 'guest_required' });
    for (const id of [pkgB, pkgOld]) {
      const r = await sale({ items: [{ kind: 'package', package_id: id, user_id: GUEST }], method: 'cash', received_kopecks: 500000 });
      assert.equal(r.status, 404, id);
    }
    const phone = await sale({ items: [{ kind: 'package', package_id: pkgA, phone: '89990001122' }], method: 'cash', received_kopecks: 500000 });
    assert.equal(phone.status, 400);
    const both = await sale({ items: [{ kind: 'package', package_id: pkgA, user_id: GUEST, phone: '+79990001122' }], method: 'cash', received_kopecks: 500000 });
    assert.equal(both.status, 400);
    // Гость только существующий (№117): нет учётки, нет согласия — 409 guest_not_found, учётка не заводится.
    for (const item of [
      { user_id: '0d4e7a5c-1111-4222-8333-944455556661' },
      { user_id: NO_CONSENT },
      { phone: '+79990000088' },
      { phone: '+79990001122' },
    ]) {
      const r = await sale({ items: [{ kind: 'package', package_id: pkgA, ...item }], method: 'cash', received_kopecks: 500000 });
      assert.equal(r.status, 409, JSON.stringify(item));
      assert.deepEqual(r.json, { error: 'guest_not_found' });
    }
    assert.equal((await h.q("select count(*)::int as n from bl.users where phone = '+79990001122'"))[0].n, 0, 'учётка не создана');
    const logText = JSON.stringify(h.log.lines);
    assert.ok(!logText.includes('+79990001122') && !logText.includes('+79990000088'), 'телефон в логе только маской');
    assert.ok(logText.includes('+7999***1122'));
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales'))[0].n, before);
    assert.equal((await lots(GUEST)).length, 0);
  });

  it('наличные: вода со скидкой 10 % и пакет — скидка только на бар; чек ККТ с позицией «предоплата 100 %»; минуты на балансе', async () => {
    const res = await sale({
      items: [{ product_id: P.water, qty: 2 }, { kind: 'package', package_id: pkgA, user_id: GUEST }],
      discount: { percent: 10 },
      method: 'cash',
      received_kopecks: 600000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const s = res.json;
    // Вода 2 × 90 ₽ = 180 ₽, скидка 18 ₽ → 162 ₽; пакет 5 000 ₽ без скидки.
    assert.equal(s.status, 'completed');
    assert.equal(s.bar_kopecks, 16200);
    assert.equal(s.package_kopecks, 500000);
    assert.equal(s.total_kopecks, 516200);
    assert.equal(s.change_kopecks, 600000 - 516200);
    assert.equal(s.packages.length, 1);
    assert.equal(s.packages[0].package_id, pkgA);
    assert.equal(s.packages[0].user_id, GUEST);
    assert.ok(s.packages[0].lot_id);
    const [p] = await h.q('select * from bl.payments where id = $1', [s.payment_id]);
    assert.deepEqual({ k: p.kind, a: Number(p.amount_kopecks), m: p.method }, { k: 'bar', a: 516200, m: 'cash' });
    const call = h.kktCalls.find((c) => c.saleId === s.sale_id);
    assert.equal(linesTotal(call.lines), 516200);
    assert.deepEqual(call.payments, [{ method: 'cash', amount_kopecks: 516200 }]);
    const pkgLine = call.lines.find((l) => l.payment_mode === 'full_prepayment');
    assert.equal(pkgLine.amount.value, '5000.00');
    assert.equal(pkgLine.payment_subject, 'service');
    assert.ok(call.lines.filter((l) => l !== pkgLine).every((l) => l.payment_mode === 'full_payment'));
    const [lot] = await lots(GUEST);
    assert.deepEqual(
      { id: lot.id, pay: lot.payment_id, pk: lot.package_id, m: lot.minutes_left, price: Number(lot.price_kopecks), key: lot.source_key },
      { id: s.packages[0].lot_id, pay: s.payment_id, pk: pkgA, m: 600, price: 500000, key: `${s.payment_id}:${pkgA}:0` },
    );
    const [ev] = (await h.outboxEvents('sale.completed')).filter((e) => e.payload.sale_id === s.sale_id);
    assert.deepEqual({ a: ev.payload.amount_kopecks, b: ev.payload.bar_kopecks, k: ev.payload.packages_kopecks }, { a: 516200, b: 16200, k: 500000 });
    assert.equal((await h.audit('package.credited')).filter((a) => a.object_id === s.payment_id).length, 1);
    const [a] = (await h.audit('pos.sale')).filter((x) => x.object_id === s.sale_id);
    assert.equal(a.data.packages_kopecks, 500000);
  });

  it('гость по телефону (существующий): два пакета в одной продаже — две партии; повтор ключа — без второго начисления', async () => {
    const key = newKey();
    const body = {
      items: [
        { kind: 'package', package_id: pkgA, phone: '+79990000077' },
        { kind: 'package', package_id: pkgA, phone: '+79990000077' },
      ],
      method: 'card_terminal',
    };
    const before = (await lots(GUEST)).length;
    const res = await sale(body, key);
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.total_kopecks, 1000000);
    const u = { id: GUEST };
    assert.ok(res.json.packages.every((p) => p.user_id === u.id));
    const again = await sale(body, key);
    assert.equal(again.json.sale_id, res.json.sale_id);
    const got = (await lots(u.id)).filter((l) => l.payment_id === res.json.payment_id);
    assert.equal((await lots(u.id)).length, before + 2);
    assert.deepEqual(got.map((l) => l.source_key).sort(), [`${res.json.payment_id}:${pkgA}:0`, `${res.json.payment_id}:${pkgA}:1`]);
    const call = h.kktCalls.find((c) => c.saleId === res.json.sale_id);
    assert.deepEqual(call.payments, [{ method: 'electronically', amount_kopecks: 1000000 }]);
    // В логе нет телефона гостя.
    assert.ok(!JSON.stringify(h.log.lines).includes('+79990000077'));
  });

  it('пакетов больше пяти — 400; пустая строка пакета (qty 2) — 400', async () => {
    const six = Array.from({ length: 6 }, () => ({ kind: 'package', package_id: pkgA, user_id: GUEST }));
    assert.equal((await sale({ items: six, method: 'card_terminal' })).status, 400);
    assert.equal((await sale({ items: [{ kind: 'package', package_id: pkgA, user_id: GUEST, qty: 2 }], method: 'card_terminal' })).status, 400);
  });

  it('СБП по QR: пакет в чеке ЮKassa; до оплаты минут нет, после оплаты — партия', async () => {
    const before = (await lots(GUEST)).length;
    const res = await sale({ items: [{ kind: 'package', package_id: pkgA, user_id: GUEST }], method: 'sbp', customer_phone: '+79990000077' });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.status, 'pending');
    const [rc] = await h.q('select * from bl.receipts where payment_id = $1', [res.json.payment_id]);
    assert.equal(rc.channel, 'yookassa');
    assert.equal(linesTotal(rc.items), 500000);
    assert.equal(rc.items[0].payment_mode, 'full_prepayment');
    assert.equal((await lots(GUEST)).length, before);
    await h.emuSucceed(await h.providerId(res.json.payment_id));
    const done = await waitFor(async () => {
      const r = await h.request('GET', `/api/pos/sales/${res.json.sale_id}`, { token: reception.token, club: CLUB_A });
      return r.json.status === 'completed' ? r.json : null;
    });
    assert.ok(done.packages[0].lot_id);
    assert.equal((await lots(GUEST)).length, before + 1);
  });

  describe('возврат пакета (№118)', () => {
    let manager;
    before(async () => {
      manager = await h.login(PHONES.manager);
    });
    const refund = (saleId, body, token = manager.token, key = newKey()) =>
      h.request('POST', `/api/pos/sales/${saleId}/refund`, { token, body, key, club: CLUB_A });
    const buy = async (method = 'cash') => {
      const res = await sale({
        items: [{ product_id: P.water, qty: 1 }, { kind: 'package', package_id: pkgA, user_id: GUEST }],
        method,
        ...(method === 'cash' ? { received_kopecks: 509000 } : {}),
      });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      return res.json;
    };

    it('без packages возвращается только бар — пакет не трогается', async () => {
      const s = await buy();
      const r = await refund(s.sale_id, { reason: 'Гость передумал' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.amount_kopecks, 9000);
      const [lot] = await h.q('select * from bl.balance_lots where id = $1', [s.packages[0].lot_id]);
      assert.deepEqual({ m: lot.minutes_left, r: lot.revoked_at }, { m: 600, r: null });
    });

    it('нетронутый пакет: партия отозвана, деньги наличными с чеком возврата «предоплата 100 %», журнал и тревога; повтор — already_refunded', async () => {
      const s = await buy();
      const reasonless = await refund(s.sale_id, { packages: [0] });
      assert.deepEqual([reasonless.status, reasonless.json], [400, { error: 'reason_required' }]);
      const byReception = await refund(s.sale_id, { packages: [0], reason: 'Ошибка продажи' }, reception.token);
      assert.equal(byReception.status, 403);
      const r = await refund(s.sale_id, { packages: [0], reason: 'Ошибка продажи' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.amount_kopecks, 500000);
      assert.equal(r.json.items.length, 1);
      assert.equal(r.json.items[0].lot_id, s.packages[0].lot_id);
      const [lot] = await h.q('select * from bl.balance_lots where id = $1', [s.packages[0].lot_id]);
      assert.equal(lot.minutes_left, 0);
      assert.ok(lot.revoked_at);
      const [f] = await h.q('select * from bl.refunds where id = $1', [r.json.refund_id]);
      assert.deepEqual({ st: f.status, a: Number(f.amount_kopecks), p: f.payment_id }, { st: 'manual', a: 500000, p: s.payment_id });
      const [rc] = await h.q("select * from bl.receipts where refund_id = $1 and kind = 'refund'", [r.json.refund_id]);
      assert.equal(rc.channel, 'kkt');
      assert.equal(linesTotal(rc.items), 500000);
      assert.ok(rc.items.every((l) => l.payment_mode === 'full_prepayment'));
      const [sp] = await h.q('select * from bl.pos_sale_packages where sale_id = $1 and idx = 0', [s.sale_id]);
      assert.ok(sp.refunded_at);
      assert.equal(sp.pos_refund_id, r.json.pos_refund_id);
      const [ps] = await h.q('select refunded_kopecks from bl.pos_sales where id = $1', [s.sale_id]);
      assert.equal(Number(ps.refunded_kopecks), 500000);
      assert.equal((await h.audit('manual.package_refund')).filter((a) => a.data.lot_id === lot.id).length, 1);
      const [a] = (await h.audit('pos.refund')).filter((x) => x.data.pos_refund_id === r.json.pos_refund_id);
      assert.equal(a.reason, 'Ошибка продажи');
      assert.equal(a.data.packages[0].lot_id, lot.id);
      assert.ok((await h.alarms('pos_refund')).some((x) => x.data.sale_id === s.sale_id));
      const view = await h.request('GET', `/api/pos/sales/${s.sale_id}`, { token: reception.token, club: CLUB_A });
      assert.ok(view.json.packages[0].refunded_at);
      const again = await refund(s.sale_id, { packages: [0], reason: 'Ещё раз' });
      assert.deepEqual([again.status, again.json], [409, { error: 'already_refunded' }]);
      // Бар той же продажи возвращается отдельно.
      const bar = await refund(s.sale_id, { reason: 'И воду' });
      assert.equal(bar.json.amount_kopecks, 9000);
    });

    it('пакет и товар одним возвратом (терминал): сумма = бар + пакет', async () => {
      const s = await buy('card_terminal');
      const water = s.items[0].order_item_id;
      const r = await refund(s.sale_id, { items: [{ order_item_id: water, qty: 1 }], packages: [0], reason: 'Ошибка продажи' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.amount_kopecks, 509000);
      const [rc] = await h.q("select * from bl.receipts where refund_id = $1 and kind = 'refund'", [r.json.refund_id]);
      assert.equal(linesTotal(rc.items), 509000);
    });

    it('минуты пакета тронуты — 409 package_used, ничего не возвращено; нет такого пакета — 404', async () => {
      const s = await buy();
      await h.q('update bl.balance_lots set minutes_left = minutes_left - 30 where id = $1', [s.packages[0].lot_id]);
      const before = (await h.q('select count(*)::int as n from bl.refunds'))[0].n;
      const r = await refund(s.sale_id, { packages: [0], reason: 'Ошибка продажи' });
      assert.deepEqual([r.status, r.json], [409, { error: 'package_used' }]);
      assert.equal((await h.q('select count(*)::int as n from bl.refunds'))[0].n, before);
      const [lot] = await h.q('select * from bl.balance_lots where id = $1', [s.packages[0].lot_id]);
      assert.deepEqual({ m: lot.minutes_left, r: lot.revoked_at }, { m: 570, r: null });
      const none = await refund(s.sale_id, { packages: [3], reason: 'Ошибка продажи' });
      assert.equal(none.status, 404);
      const badIdx = await refund(s.sale_id, { packages: [0, 0], reason: 'Ошибка продажи' });
      assert.equal(badIdx.status, 400);
    });
  });

  it('RLS: строки пакетов кассы клуба A не видны в контексте клуба B', async () => {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_B]);
      assert.equal((await c.query('select count(*)::int as n from bl.pos_sale_packages')).rows[0].n, 0);
      await c.query('rollback');
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      assert.ok((await c.query('select count(*)::int as n from bl.pos_sale_packages')).rows[0].n > 0);
      // Узкая функция гостя отвечает только персоналу кассы клуба из контекста.
      assert.equal((await c.query('select bl.pos_guest($1, null) as id', [GUEST])).rows[0].id, null, 'без сотрудника в контексте');
      await c.query("select set_config('app.user_id', $1, true)", [reception.id]);
      assert.equal((await c.query('select bl.pos_guest($1, null) as id', [GUEST])).rows[0].id, GUEST);
      await assert.rejects(c.query('delete from bl.pos_sale_packages'), /permission denied/);
      await c.query('rollback');
      // Без клуба в контексте узкая функция гостя не отвечает.
      await c.query('begin');
      await c.query("select set_config('app.club_id', '', true), set_config('app.actor_type', 'user', true)");
      assert.equal((await c.query("select bl.pos_guest(null, '+79990000077') as id")).rows[0].id, null);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});

describe('касса: поиск гостя — лимит и тревога о промахах (№121)', { skip: SKIP }, () => {
  let manager;
  const missSale = (token, phone) =>
    h.request('POST', '/api/pos/sales', { token, body: { items: [{ kind: 'package', package_id: pkgA, phone }], method: 'card_terminal' }, key: newKey(), club: CLUB_A });
  before(async () => {
    manager = await h.login(PHONES.manager);
    guestLookupGuard.reset();
  });

  it('10 промахов за час — одна тревога guest_lookup_misses владельцу (ключ — сотрудник), в ответе только guest_not_found', async () => {
    for (let i = 0; i < 9; i += 1) {
      const r = await missSale(manager.token, `+7999555${String(1000 + i)}`);
      assert.deepEqual([r.status, r.json], [409, { error: 'guest_not_found' }]);
    }
    assert.equal((await h.alarms('guest_lookup_misses')).length, 0);
    await missSale(manager.token, '+79995552000');
    await missSale(manager.token, '+79995552001');
    const alarms = await h.alarms('guest_lookup_misses');
    assert.equal(alarms.length, 1, 'одна тревога, хотя транзакции запросов откатились');
    assert.equal(alarms[0].data.staff_id, manager.id);
    assert.equal(alarms[0].club_id, CLUB_A);
    assert.ok(!JSON.stringify(alarms[0]).includes('+7999555'), 'телефонов в тревоге нет');
    // Ресепшн — свой счёт: его промахов нет.
    assert.equal(guestLookupGuard.missesInHour(reception.id, new Date()), 0);
  });

  it('больше 20 поисков гостя в минуту на сотрудника — 429 rate_limited, поиск не выполняется', async () => {
    guestLookupGuard.reset();
    for (let i = 0; i < 20; i += 1) {
      const r = await sale({ items: [{ kind: 'package', package_id: pkgA, user_id: '0d4e7a5c-1111-4222-8333-944455556661' }], method: 'card_terminal' });
      assert.equal(r.status, 409, `поиск ${i + 1}`);
    }
    const over = await sale({ items: [{ kind: 'package', package_id: pkgA, user_id: GUEST }], method: 'card_terminal' });
    assert.deepEqual([over.status, over.json], [429, { error: 'rate_limited' }]);
    // Лимит — на сотрудника: управляющий ищет дальше.
    const other = await missSale(manager.token, '+79995553000');
    assert.equal(other.status, 409);
    guestLookupGuard.reset();
  });
});

