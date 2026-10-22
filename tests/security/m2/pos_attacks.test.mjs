// M2 касса/бар/счёт стола — пентест (атакующие: гость, ресепшн, посторонний).
// Поднимает настоящий сервер backend-pos над временной базой (обвязка server/orders/test/db).
// Проверяет: алкоголь скрыт сервером (№76); цена только с сервера; наличные без смены — отказ
// (№93); скидка выше лимита без управляющего — отказ; одобрение скидки по PIN одноразовое, не
// переносится на другую сумму и на другой клуб; изоляция клубов на кассе (X-Club-Id, IDOR).
//
// Разрушающее — во временной базе (создаётся и удаляется). Запуск:
//   DATABASE_ADMIN_URL=… node --test tests/security/m2/pos_attacks.test.mjs

import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hashPin } from '../../../server/auth/pin.mjs';
import { setup, waitFor, CLUB_A, CLUB_B, PHONES, P, M, table, newKey } from '../../../server/orders/test/db/harness.mjs';

let h;
let guest; // участник сессии за столом 7
let session7;

before(async () => {
  h = await setup();
  await h.openShift(CLUB_A); // смена нужна кассе
  guest = await h.login('+79990000077');
  session7 = await h.session({ resourceId: table(7), payer: guest.id });
});

after(async () => {
  await h?.close();
});

describe('Гость: алкоголь скрывает сервер (№76)', () => {
  it('в QR-меню гостя пива нет, у персонала есть', async () => {
    const asGuest = await h.request('GET', `/api/clubs/${CLUB_A}/menu`);
    assert.equal(asGuest.status, 200);
    const guestIds = asGuest.json.categories.flatMap((c) => c.products.map((p) => p.id));
    assert.ok(!guestIds.includes(P.beer), 'пиво видно гостю в меню');
    assert.equal(asGuest.json.alcohol_hidden, true);
    const rec = await h.login(PHONES.reception);
    const asStaff = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: rec.token });
    const staffIds = asStaff.json.categories.flatMap((c) => c.products.map((p) => p.id));
    assert.ok(staffIds.includes(P.beer), 'пиво не видно персоналу');
  });

  it('прямой заказ пива со стола — not_found (не раскрываем товар)', async () => {
    const res = await h.request('POST', '/api/orders', {
      token: guest.token,
      key: newKey(),
      body: { session_id: session7, items: [{ product_id: P.beer, qty: 1 }], pay: 'tab' },
    });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not_found');
  });

  it('оплата счёта стола с алкоголем гостем — forbidden (алкоголь только на ресепшене)', async () => {
    // Персонал/сид мог бы занести алкоголь в счёт; имитируем строку алкоголя в счёте через admin.
    const orderId = randomUUID();
    await h.q(
      `insert into bl.orders (id, club_id, number, source, pay_mode, status, session_id, resource_id, user_id, subtotal_kopecks, committed_at, status_at, created_at, updated_at)
       values ($1, $2, 9001, 'qr', 'tab', 'new', $3, $4, $5, 25000, now(), now(), now(), now())`,
      [orderId, CLUB_A, session7, table(7), guest.id],
    );
    await h.q(
      `insert into bl.order_items (club_id, order_id, position, product_id, name, qty, unit_price_kopecks, amount_kopecks, track_stock, is_alcohol, vat_code, payment_subject, created_at)
       values ($1, $2, 0, $3, 'Пиво', 1, 25000, 25000, true, true, 1, 'excise', now())`,
      [CLUB_A, orderId, P.beer],
    );
    const res = await h.request('POST', `/api/sessions/${session7}/tab/pay`, { token: guest.token, key: newKey(), body: { method: 'sbp' } });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.error, 'forbidden');
    // уберём имитацию, чтобы не мешала другим тестам
    await h.q('delete from bl.order_items where order_id = $1', [orderId]);
    await h.q('delete from bl.orders where id = $1', [orderId]);
  });
});

describe('Гость: цену ставит сервер, не запрос', () => {
  it('подмена amount_kopecks/unit_price в items игнорируется (цена из каталога)', async () => {
    const res = await h.request('POST', '/api/orders', {
      token: guest.token,
      key: newKey(),
      body: {
        session_id: session7,
        items: [{ product_id: P.water, qty: 2, amount_kopecks: 2, unit_price_kopecks: 1, price_kopecks: 1 }],
        pay: 'tab',
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // Вода 9000 коп/шт × 2 = 18000; подменённые 2 коп не применились.
    assert.equal(res.json.order.subtotal_kopecks, 18000);
    assert.equal(res.json.order.items[0].unit_price_kopecks, 9000);
  });

  it('заказ в чужую сессию — not_found', async () => {
    const other = await h.login('+79990000088');
    const otherSession = await h.session({ resourceId: table(8), payer: other.id });
    const res = await h.request('POST', '/api/orders', {
      token: guest.token,
      key: newKey(),
      body: { session_id: otherSession, items: [{ product_id: P.water, qty: 1 }], pay: 'tab' },
    });
    assert.equal(res.status, 404);
  });
});

describe('Ресепшн: наличные только при открытой смене (№83, №93)', () => {
  it('продажа наличными без открытой смены — shift_closed', async () => {
    await h.closeShift(CLUB_A);
    const rec = await h.login(PHONES.reception);
    const res = await h.request('POST', '/api/pos/sales', {
      token: rec.token,
      key: newKey(),
      club: CLUB_A,
      body: { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 10000 },
    });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.error, 'shift_closed');
  });

  it('приём заявки стола наличными без открытой смены — shift_closed (№93)', async () => {
    const rec = await h.login(PHONES.reception);
    const reqId = await h.receptionRequest({ resourceId: table(7), userId: guest.id, amount: 50000, minutes: 60 });
    const res = await h.request('POST', `/api/reception/requests/${reqId}/accept`, {
      token: rec.token,
      key: newKey(),
      club: CLUB_A,
      body: { method: 'cash', received_kopecks: 50000 },
    });
    assert.equal(res.status, 409, JSON.stringify(res.json));
    assert.equal(res.json.error, 'shift_closed');
    await h.openShift(CLUB_A); // вернуть смену для следующих тестов
  });
});

describe('Ресепшн: скидка выше лимита — только управляющий/PIN', () => {
  it('ресепшн не даёт скидку выше лимита клуба (10 %) без одобрения', async () => {
    const rec = await h.login(PHONES.reception);
    const res = await h.request('POST', '/api/pos/sales', {
      token: rec.token,
      key: newKey(),
      club: CLUB_A,
      body: { items: [{ product_id: P.water, qty: 10 }], discount: { percent: 50 }, method: 'cash', received_kopecks: 100000 },
    });
    assert.equal(res.json.error, 'limit_exceeded', JSON.stringify(res.json));
    assert.equal(res.status, 400);
  });
});

describe('Одобрение скидки по PIN управляющего (№95)', () => {
  let managerId;
  const PIN = '4321';

  before(async () => {
    const mgr = await h.login(PHONES.manager);
    managerId = mgr.id;
    const hash = await hashPin(PIN, h.config.pinPepper);
    await h.q('update bl.club_members set pin_hash = $1, pin_failed_count = 0, pin_locked_until = null where club_id = $2 and user_id = $3', [hash, CLUB_A, managerId]);
  });

  // №100: одобрение привязано к сумме корзины (subtotal_kopecks), по умолчанию 10 бутылок воды = 90 000 коп.
  async function makeApproval(percent, subtotal = 90000, extra = {}) {
    const rec = await h.login(PHONES.reception);
    const discount = percent === null ? {} : { percent };
    const res = await h.request('POST', '/api/pos/discount-approvals', {
      token: rec.token,
      key: newKey(),
      club: CLUB_A,
      body: { user_id: managerId, pin: PIN, reason_code: 'promo', reason_text: 'акция', ...discount, subtotal_kopecks: subtotal, ...extra },
    });
    return res;
  }

  async function sell(items, discount) {
    const rec = await h.login(PHONES.reception);
    return h.request('POST', '/api/pos/sales', {
      token: rec.token, key: newKey(), club: CLUB_A,
      body: { items, discount, method: 'cash', received_kopecks: 10_000_000 },
    });
  }

  it('неверный PIN — 401, и 5 ошибок подряд блокируют (429)', async () => {
    const rec = await h.login(PHONES.reception);
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = await h.request('POST', '/api/pos/discount-approvals', {
        token: rec.token, key: newKey(), club: CLUB_A,
        body: { user_id: managerId, pin: '0000', reason_code: 'promo', reason_text: 'x', percent: 50, subtotal_kopecks: 90000 },
      });
    }
    // Последняя из 5 неверных уже даёт блокировку; верный PIN теперь — 429.
    const locked = await makeApproval(50);
    assert.equal(locked.status, 429, `ожидали 429 после блокировки, получили ${locked.status}`);
    // Снять блокировку для следующих тестов.
    await h.q('update bl.club_members set pin_failed_count = 0, pin_locked_until = null where club_id = $1 and user_id = $2', [CLUB_A, managerId]);
  });

  it('одобрение одноразовое: повтор того же approval_id — forbidden', async () => {
    const appr = await makeApproval(50);
    assert.equal(appr.status, 201, JSON.stringify(appr.json));
    const approvalId = appr.json.approval_id;
    const rec = await h.login(PHONES.reception);
    const body = { items: [{ product_id: P.water, qty: 10 }], discount: { percent: 50, approval_id: approvalId }, method: 'cash', received_kopecks: 100000 };
    const first = await h.request('POST', '/api/pos/sales', { token: rec.token, key: newKey(), club: CLUB_A, body });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.discount_kopecks, 45000); // 50 % от 90000
    const second = await h.request('POST', '/api/pos/sales', { token: rec.token, key: newKey(), club: CLUB_A, body });
    assert.equal(second.status, 403, JSON.stringify(second.json));
    assert.equal(second.json.error, 'forbidden');
  });

  it('одобрение на 50 % нельзя применить как 70 %', async () => {
    const appr = await makeApproval(50);
    const approvalId = appr.json.approval_id;
    const rec = await h.login(PHONES.reception);
    const res = await h.request('POST', '/api/pos/sales', {
      token: rec.token, key: newKey(), club: CLUB_A,
      body: { items: [{ product_id: P.water, qty: 10 }], discount: { percent: 70, approval_id: approvalId }, method: 'cash', received_kopecks: 100000 },
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
  });

  it('одобрение чужого клуба (чужой approval_id) — forbidden', async () => {
    // approval в контексте CLUB_B (admin), затем применить в CLUB_A.
    const otherApproval = randomUUID();
    await h.q(
      `insert into bl.pos_discount_approvals (id, club_id, approver_id, requested_by, reason_code, reason_text, percent, subtotal_kopecks, max_discount_kopecks, expires_at, created_at)
       values ($1, $2, $3, $3, 'promo', 'x', 50, 90000, 45000, now() + interval '5 minutes', now())`,
      [otherApproval, CLUB_B, 'a2000000-0000-4000-8000-000000000002'],
    );
    const rec = await h.login(PHONES.reception);
    const res = await h.request('POST', '/api/pos/sales', {
      token: rec.token, key: newKey(), club: CLUB_A,
      body: { items: [{ product_id: P.water, qty: 10 }], discount: { percent: 50, approval_id: otherApproval }, method: 'cash', received_kopecks: 100000 },
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
  });

  it('№100: 50 % на 9 000 коп. нельзя применить к корзине 90 000 коп. — 403', async () => {
    const appr = await makeApproval(50, 9000);
    assert.equal(appr.status, 201, JSON.stringify(appr.json));
    assert.equal(appr.json.max_discount_kopecks, 4500);
    const res = await sell([{ product_id: P.water, qty: 10 }], { percent: 50, approval_id: appr.json.approval_id });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    // одобрение не израсходовано отказом: на одобренную корзину проходит
    const ok = await sell([{ product_id: P.water, qty: 1 }], { percent: 50, approval_id: appr.json.approval_id });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.discount_kopecks, 4500);
  });

  it('№100: процентное одобрение нельзя применить суммой (и наоборот) — 403', async () => {
    const pct = await makeApproval(50, 90000);
    const asAmount = await sell([{ product_id: P.water, qty: 10 }], { amount_kopecks: 45000, approval_id: pct.json.approval_id });
    assert.equal(asAmount.status, 403, JSON.stringify(asAmount.json));
    const amt = await makeApproval(null, 9000, { amount_kopecks: 4500 });
    assert.equal(amt.status, 201, JSON.stringify(amt.json));
    const asPercent = await sell([{ product_id: P.water, qty: 1 }], { percent: 50, approval_id: amt.json.approval_id });
    assert.equal(asPercent.status, 403, JSON.stringify(asPercent.json));
    // сумма скидки больше одобренной суммы корзины при создании — 400
    const tooBig = await makeApproval(null, 9000, { amount_kopecks: 9001 });
    assert.equal(tooBig.status, 400, JSON.stringify(tooBig.json));
  });

  it('№100: другая корзина на ту же сумму и корзина меньше — скидка в копейках не больше одобренной', async () => {
    // Одобрено 50 % на 18 000 (2 воды); корзина другого состава на 18 000 (2 газ. воды) — проходит,
    // ущерб тот же (9 000), это ожидаемо: одобрение привязано к сумме, не к составу.
    const a = await makeApproval(50, 18000);
    const same = await sell([{ product_id: P.sparkling, qty: 2 }], { percent: 50, approval_id: a.json.approval_id });
    assert.equal(same.status, 201, JSON.stringify(same.json));
    assert.equal(same.json.discount_kopecks, 9000);
    // Фиксированная сумма 9 000 на корзину 18 000, применённая к меньшей корзине (15 000 — чипсы):
    // процент вырос, но копеек скидки не больше одобренных 9 000.
    const b = await makeApproval(null, 18000, { amount_kopecks: 9000 });
    const smaller = await sell([{ product_id: P.chips, qty: 1 }], { amount_kopecks: 9000, approval_id: b.json.approval_id });
    assert.equal(smaller.status, 201, JSON.stringify(smaller.json));
    assert.ok(smaller.json.discount_kopecks <= 9000);
  });

  it('№100: округление процента не даёт копейку сверх одобренного; повтор с другим Idempotency-Key — 403', async () => {
    // 33 % от 27 000 = 8 910 при создании и при применении к той же сумме.
    const a = await makeApproval(33, 27000);
    assert.equal(a.json.max_discount_kopecks, 8910);
    const first = await sell([{ product_id: P.water, qty: 3 }], { percent: 33, approval_id: a.json.approval_id });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(first.json.discount_kopecks, 8910);
    const again = await sell([{ product_id: P.water, qty: 3 }], { percent: 33, approval_id: a.json.approval_id });
    assert.equal(again.status, 403, JSON.stringify(again.json));
  });

  it('остаток №100: subtotal_kopecks заявляет клиент кассы, а не сервер по корзине', async () => {
    // Сервер не знает корзины на момент одобрения: касса может заявить сумму больше той, что
    // видит управляющий на экране. Отказ ловится только интерфейсом и журналом/тревогой владельцу.
    const a = await makeApproval(50, 1_000_000);
    assert.equal(a.status, 201, JSON.stringify(a.json));
    assert.equal(a.json.max_discount_kopecks, 500000);
  });
});

describe('Бармен (роль bar, №97): экран бара без кассы, денег и отмен', () => {
  let bar;
  let committedOrderId;

  before(async () => {
    bar = await h.login('+79990000061');
    await h.q(`insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar') on conflict do nothing`, [CLUB_A, bar.id]);
    // Заказ в счёт стола (committed) — чтобы бармен мог менять статус.
    const res = await h.request('POST', '/api/orders', {
      token: guest.token, key: newKey(),
      body: { session_id: session7, items: [{ product_id: P.chips, qty: 1 }], pay: 'tab' },
    });
    committedOrderId = res.json.order.id;
  });

  it('бармен видит очередь бара и двигает статус заказа', async () => {
    const q = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: bar.token });
    assert.equal(q.status, 200, JSON.stringify(q.json));
    const s = await h.request('POST', `/api/orders/${committedOrderId}/status`, { token: bar.token, body: { status: 'preparing' } });
    assert.equal(s.status, 200, JSON.stringify(s.json));
  });

  it('бармен НЕ отменяет заказ (деньги счёта — ресепшн и выше)', async () => {
    const res = await h.request('POST', `/api/orders/${committedOrderId}/status`, { token: bar.token, body: { status: 'canceled', reason: 'не хочу' } });
    assert.equal(res.status, 403, JSON.stringify(res.json));
  });

  it('бармен НЕ продаёт на кассе, не видит счета и склад', async () => {
    const sale = await h.request('POST', '/api/pos/sales', { token: bar.token, key: newKey(), club: CLUB_A, body: { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 9000 } });
    assert.equal(sale.status, 403, JSON.stringify(sale.json));
    const tabs = await h.request('GET', `/api/clubs/${CLUB_A}/tabs`, { token: bar.token });
    assert.equal(tabs.status, 403);
    const stock = await h.request('GET', `/api/clubs/${CLUB_A}/stock`, { token: bar.token });
    assert.equal(stock.status, 403);
  });
});

describe('Посторонний/другой клуб: изоляция кассы', () => {
  it('ресепшн клуба A с X-Club-Id клуба B — forbidden', async () => {
    const rec = await h.login(PHONES.reception);
    const res = await h.request('POST', '/api/pos/sales', {
      token: rec.token, key: newKey(), club: CLUB_B,
      body: { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 10000 },
    });
    assert.equal(res.status, 403, JSON.stringify(res.json));
  });

  it('GET продажи другого клуба по id — not_found', async () => {
    // Продажа в CLUB_B (admin), затем ресепшн CLUB_A читает её по id.
    const saleId = randomUUID();
    await h.q(
      `insert into bl.pos_sales (id, club_id, channel, method, status, created_by, bar_subtotal_kopecks, bar_total_kopecks, table_kopecks, completed_at, created_at, updated_at)
       values ($1, $2, 'pos', 'card_terminal', 'completed', 'a2000000-0000-4000-8000-000000000002', 0, 0, 5000, now(), now(), now())`,
      [saleId, CLUB_B],
    );
    const rec = await h.login(PHONES.reception);
    const res = await h.request('GET', `/api/pos/sales/${saleId}`, { token: rec.token });
    assert.equal(res.status, 404, JSON.stringify(res.json));
  });
});
