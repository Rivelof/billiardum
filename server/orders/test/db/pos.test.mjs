// Касса ресепшена (контракт M2 §4, §5; decisions №81–83) на настоящем Postgres и эмуляторе ЮKassa:
// смена, наличные со сдачей, терминал, СБП по QR, скидка и её лимит, заявка стола M1 в корзине,
// идемпотентность и гонка повтора, возврат (права, причина, чек, склад, тревога), деньги до копейки.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { linesTotal } from '../../money.mjs';
import { CLUB_A, CLUB_B, M, newKey, P, PHONES, setup, TABLE_2, TABLE_3, waitFor } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
let h;
let owner;
let manager;
let reception;

before(async () => {
  if (SKIP) return;
  h = await setup();
  owner = await h.login(PHONES.owner);
  manager = await h.login(PHONES.manager);
  reception = await h.login(PHONES.reception);
});

after(async () => {
  await h?.close();
});

const sale = (token, body, key = newKey()) => h.request('POST', '/api/pos/sales', { token, body, key, club: CLUB_A });

describe('касса: смена', { skip: SKIP }, () => {
  it('без открытой смены продажа невозможна — 409 shift_closed, ничего не записано', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 10000 });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'shift_closed' });
    assert.equal((await h.q("select count(*)::int as n from bl.payments where kind = 'bar'"))[0].n, 0);
    assert.equal((await h.q('select count(*)::int as n from bl.orders'))[0].n, 0);
  });
});

describe('касса: продажа', { skip: SKIP }, () => {
  let shiftId;
  before(async () => {
    shiftId = await h.openShift();
  });

  it('наличные со сдачей: платёж бара, чек ККТ, склад, sale.completed, журнал', async () => {
    const waterBefore = await h.stock(P.water);
    const capBefore = await h.stock(P.cappuccino);
    const res = await sale(reception.token, {
      items: [
        { product_id: P.water, qty: 2 },
        { product_id: P.cappuccino, qty: 1, modifier_ids: [M.v04, M.sugar] },
      ],
      method: 'cash',
      received_kopecks: 100000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const s = res.json;
    // 2 × 90 ₽ + (220 + 40) ₽ = 440 ₽; сдача с 1 000 ₽ — 560 ₽.
    assert.equal(s.status, 'completed');
    assert.equal(s.total_kopecks, 44000);
    assert.equal(s.change_kopecks, 56000);
    assert.equal(s.receipt_status, 'receipt_pending');
    const [p] = await h.q('select * from bl.payments where id = $1', [s.payment_id]);
    assert.equal(p.kind, 'bar');
    assert.equal(p.provider, 'reception');
    assert.equal(p.method, 'cash');
    assert.equal(Number(p.amount_kopecks), 44000);
    assert.equal(Number(p.received_kopecks), 100000);
    assert.equal(Number(p.change_kopecks), 56000);
    assert.equal(p.status, 'succeeded');
    assert.equal(p.resource_id, null);
    // Чек ККТ: позиции = сумма, оплата наличными, кассир — имя сотрудника.
    const call = h.kktCalls.find((c) => c.saleId === s.sale_id);
    assert.equal(call.kind, 'sell');
    assert.equal(linesTotal(call.lines), 44000);
    assert.deepEqual(call.payments, [{ method: 'cash', amount_kopecks: 44000 }]);
    assert.equal(call.operatorName, 'Ресепшн (тест)');
    assert.equal(call.lines.find((l) => l.description.startsWith('Капучино')).description, 'Капучино, 0,4 л, С сахаром');
    // Склад: вода −2, капучино 0,4 л — 1,3 порции.
    assert.equal(await h.stock(P.water), waterBefore - 2);
    assert.equal(Math.round((capBefore - (await h.stock(P.cappuccino))) * 1000), 1300);
    const [ev] = (await h.outboxEvents('sale.completed')).filter((e) => e.payload.sale_id === s.sale_id);
    assert.equal(ev.payload.amount_kopecks, 44000);
    assert.equal(ev.payload.bar_kopecks, 44000);
    assert.equal(ev.payload.tables_kopecks, 0);
    assert.equal(ev.payload.method, 'cash');
    assert.equal(ev.payload.shift_id, shiftId);
    assert.equal(ev.payload.payment_id, s.payment_id);
    const [a] = (await h.audit('pos.sale')).filter((x) => x.object_id === s.sale_id);
    assert.equal(a.actor_id, reception.id);
    assert.equal(a.data.change_kopecks, 56000);
    const capItem = s.items.find((i) => i.product_id === P.cappuccino);
    assert.deepEqual([capItem.product_name, capItem.name], ['Капучино', 'Капучино, 0,4 л, С сахаром']);
    // Заказ кассы выдан сразу и оплачен; на экран бара не попадает.
    const [o] = await h.q('select * from bl.orders where sale_id = $1', [s.sale_id]);
    assert.equal(o.status, 'served');
    assert.ok(o.paid_at);
  });

  it('полученной суммы меньше — 400, терминал — оплата electronically', async () => {
    const low = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 8999 });
    assert.equal(low.status, 400);
    const res = await sale(reception.token, { items: [{ product_id: P.chips, qty: 1 }], method: 'card_terminal' });
    assert.equal(res.status, 201);
    assert.equal(res.json.change_kopecks, null);
    const call = h.kktCalls.find((c) => c.saleId === res.json.sale_id);
    assert.deepEqual(call.payments, [{ method: 'electronically', amount_kopecks: 15000 }]);
  });

  it('повтор с тем же ключом — та же продажа, один платёж; другой запрос с тем же ключом — 409', async () => {
    const key = newKey();
    const body = { items: [{ product_id: P.nuts, qty: 1 }], method: 'cash', received_kopecks: 20000 };
    const [a, b] = await Promise.all([sale(reception.token, body, key), sale(reception.token, body, key)]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(a.json.sale_id, b.json.sale_id);
    const c = await sale(reception.token, body, key);
    assert.equal(c.json.sale_id, a.json.sale_id);
    assert.equal(c.headers.get('idempotent-replayed'), 'true');
    const conflict = await sale(reception.token, { ...body, received_kopecks: 50000 }, key);
    assert.equal(conflict.status, 409);
    assert.equal((await h.q('select count(*)::int as n from bl.payments where request_key = $1', [key]))[0].n, 1);
    assert.equal((await h.q('select count(*)::int as n from bl.pos_sales where request_key = $1', [key]))[0].n, 1);
    assert.equal(h.kktCalls.filter((x) => x.saleId === a.json.sale_id).length, 1);
  });

  it('алкоголь на кассе продаётся (ресепшн продаёт как обычно)', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.beer, qty: 1 }], method: 'cash', received_kopecks: 25000 });
    assert.equal(res.status, 201);
    const call = h.kktCalls.find((c) => c.saleId === res.json.sale_id);
    assert.equal(call.lines[0].payment_subject, 'excise');
  });
});

describe('касса: скидка', { skip: SKIP }, () => {
  it('в пределах лимита (10 %) — ресепшн; раскладка по строкам до копейки', async () => {
    const res = await sale(reception.token, {
      items: [
        { product_id: P.water, qty: 3 },
        { product_id: P.teaBlack, qty: 1 },
      ],
      discount: { percent: 10 },
      method: 'cash',
      received_kopecks: 50000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    // 3 × 90 + 150 = 420 ₽, скидка 42 ₽ → 378 ₽.
    assert.equal(res.json.discount_kopecks, 4200);
    assert.equal(res.json.total_kopecks, 37800);
    assert.equal(res.json.items.reduce((s, i) => s + i.amount_kopecks, 0), 37800);
    assert.equal(res.json.items.reduce((s, i) => s + i.discount_kopecks, 0), 4200);
    const call = h.kktCalls.find((c) => c.saleId === res.json.sale_id);
    assert.equal(linesTotal(call.lines), 37800);
    assert.equal((await h.audit('pos.discount')).length >= 1, true);
  });

  it('выше лимита: ресепшн — 400 limit_exceeded; управляющий без причины — reason_required; с причиной — тревога', async () => {
    const body = { items: [{ product_id: P.chips, qty: 1 }], discount: { amount_kopecks: 3001 }, method: 'card_terminal' };
    const r1 = await sale(reception.token, body);
    assert.deepEqual([r1.status, r1.json.error], [400, 'limit_exceeded']);
    const r2 = await sale(manager.token, body);
    assert.deepEqual([r2.status, r2.json.error], [400, 'reason_required']);
    const r3 = await sale(manager.token, { ...body, discount: { amount_kopecks: 3001, reason: 'Постоянный гость, акция' } });
    assert.equal(r3.status, 201);
    assert.equal(r3.json.total_kopecks, 11999);
    const [a] = (await h.audit('manual.discount')).filter((x) => x.object_id === r3.json.sale_id);
    assert.equal(a.reason, 'Постоянный гость, акция');
    const alarms = await h.alarms('discount_over_limit');
    assert.equal(alarms.length, 1);
    const notes = await h.q("select * from bl.notifications where kind = 'alarm' and text like 'Скидка%'");
    assert.ok(notes.length >= 1, 'владельцу ушло уведомление');
  });
});

describe('касса: заявка стола M1 в корзине', { skip: SKIP }, () => {
  it('стол и бар одной оплатой наличными: заявку принимает money, сдача у платежа бара', async () => {
    const guest = await h.login('+79990001001');
    const requestId = await h.receptionRequest({ resourceId: TABLE_3, userId: guest.id, amount: 80000 });
    const res = await sale(reception.token, {
      items: [{ product_id: P.water, qty: 1 }],
      requests: [requestId],
      method: 'cash',
      received_kopecks: 100000,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.total_kopecks, 89000);
    assert.equal(res.json.table_kopecks, 80000);
    assert.equal(res.json.change_kopecks, 11000);
    assert.equal(res.json.table_payments.length, 1);
    const [rr] = await h.q('select * from bl.reception_requests where id = $1', [requestId]);
    assert.equal(rr.status, 'accepted');
    const [tp] = await h.q('select * from bl.payments where id = $1', [res.json.table_payments[0].payment_id]);
    assert.equal(tp.kind, 'start');
    assert.equal(Number(tp.amount_kopecks), 80000);
    assert.equal(Number(tp.change_kopecks), 0);
    const [bp] = await h.q('select * from bl.payments where id = $1', [res.json.payment_id]);
    assert.equal(Number(bp.received_kopecks), 20000);
    assert.equal(Number(bp.change_kopecks), 11000);
    // Свет — через money: payment.confirmed для заявки; чек стола — у money (receipt_pending).
    assert.ok((await h.outboxEvents('payment.confirmed')).some((e) => e.payload.payment_id === tp.id));
    const [ev] = (await h.outboxEvents('sale.completed')).filter((e) => e.payload.sale_id === res.json.sale_id);
    assert.deepEqual([ev.payload.amount_kopecks, ev.payload.bar_kopecks, ev.payload.tables_kopecks], [89000, 9000, 80000]);
    // Повторно ту же заявку — нельзя.
    const again = await sale(reception.token, { requests: [requestId], method: 'cash', received_kopecks: 80000 });
    assert.equal(again.status, 409);
  });

  it('заявку стола СБП на кассе не принимают (money M1: наличные или терминал)', async () => {
    const guest = await h.login('+79990001002');
    const requestId = await h.receptionRequest({ resourceId: TABLE_2, userId: guest.id });
    const res = await sale(reception.token, { requests: [requestId], method: 'sbp' });
    assert.equal(res.status, 400);
  });
});

describe('касса: СБП по QR', { skip: SKIP }, () => {
  it('продажа ждёт оплаты с QR на экране; вебхук — продажа завершена, чек ЮKassa', async () => {
    const before = await h.stock(P.sparkling);
    const res = await sale(reception.token, { items: [{ product_id: P.sparkling, qty: 2 }], method: 'sbp', to_bar: true });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.status, 'pending');
    assert.equal(res.json.confirmation.type, 'qr');
    assert.match(res.json.confirmation.confirmation_data, /^https:\/\/qr\.nspk\.ru\//);
    // До оплаты: заказ не на экране бара, склад не списан.
    const queue = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(!queue.json.some((o) => o.sale_id === res.json.sale_id || o.payment_id === res.json.payment_id));
    assert.equal(await h.stock(P.sparkling), before);
    const [rc] = await h.q('select * from bl.receipts where payment_id = $1', [res.json.payment_id]);
    assert.equal(rc.channel, 'yookassa');
    assert.equal(linesTotal(rc.items), 18000);
    await h.emuSucceed(await h.providerId(res.json.payment_id));
    const done = await waitFor(async () => {
      const r = await h.request('GET', `/api/pos/sales/${res.json.sale_id}`, { token: reception.token, club: CLUB_A });
      return r.json.status === 'completed' ? r.json : null;
    });
    assert.equal(done.receipt_status, 'succeeded');
    assert.equal(await h.stock(P.sparkling), before - 2);
    const q2 = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: reception.token });
    assert.ok(q2.json.some((o) => o.items.some((i) => i.product_id === P.sparkling)), 'после оплаты — на экране бара');
    assert.ok(h.sseEvents.some((e) => e.event === 'pos_sale' && e.data.sale_id === res.json.sale_id && e.data.status === 'completed'));
  });

  it('отмена платежа СБП — продажа и заказ кассы отменены (планировщик)', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.chips, qty: 1 }], method: 'sbp', customer_phone: '+79990002233' });
    assert.equal(res.json.status, 'pending');
    await h.emuCancel(await h.providerId(res.json.payment_id));
    await waitFor(async () => (await h.q('select status from bl.payments where id = $1', [res.json.payment_id]))[0].status === 'canceled');
    await h.tick();
    const [s] = await h.q('select * from bl.pos_sales where id = $1', [res.json.sale_id]);
    assert.equal(s.status, 'canceled');
    const [o] = await h.q('select o.* from bl.orders o join bl.pos_sale_items si on si.order_id = o.id where si.sale_id = $1', [res.json.sale_id]);
    assert.equal(o.status, 'canceled');
  });
});

describe('касса: возврат', { skip: SKIP }, () => {
  let s;
  before(async () => {
    const res = await sale(reception.token, {
      items: [{ product_id: P.nuts, qty: 3 }],
      discount: { amount_kopecks: 1000 },
      method: 'cash',
      received_kopecks: 60000,
    });
    s = res.json;
  });
  const refund = (token, body, key = newKey()) => h.request('POST', `/api/pos/sales/${s.sale_id}/refund`, { token, body, key, club: CLUB_A });

  it('ресепшн не делает возврат — 403; без причины — reason_required', async () => {
    const r1 = await refund(reception.token, { reason: 'Гость передумал' });
    assert.equal(r1.status, 403);
    const r2 = await refund(manager.token, {});
    assert.deepEqual([r2.status, r2.json.error], [400, 'reason_required']);
  });

  it('частичный и полный возврат: суммы до копейки, чек возврата ККТ, склад, тревога владельцу', async () => {
    // 3 × 180 = 540 ₽ − 10 ₽ = 530 ₽: единицы 176,67 / 176,67 / 176,66.
    const nutsBefore = await h.stock(P.nuts);
    const item = s.items[0];
    const r1 = await refund(manager.token, { reason: 'Вскрытая пачка', items: [{ order_item_id: item.order_item_id, qty: 1 }] });
    assert.equal(r1.status, 201, JSON.stringify(r1.json));
    assert.equal(r1.json.amount_kopecks, 17666);
    assert.equal(r1.json.status, 'manual');
    // Чек возврата ККТ ставит refund money (receipt_pending в bl.receipts; пробьёт server/kkt, №84).
    const [rc] = await h.q('select * from bl.receipts where refund_id = $1', [r1.json.refund_id]);
    assert.deepEqual([rc.channel, rc.kind, rc.status], ['kkt', 'refund', 'receipt_pending']);
    assert.equal(linesTotal(rc.items), 17666);
    assert.equal(Number(rc.amount_kopecks), 17666);
    assert.equal(r1.json.receipt_id, rc.id);
    assert.equal(await h.stock(P.nuts), nutsBefore + 1);
    const r2 = await refund(owner.token, { reason: 'Возврат остатка' });
    assert.equal(r2.status, 201);
    assert.equal(r2.json.amount_kopecks, 17667 * 2);
    assert.equal(r1.json.amount_kopecks + r2.json.amount_kopecks, 53000);
    const r3 = await refund(owner.token, { reason: 'Ещё раз' });
    assert.equal(r3.status, 409);
    const refunds = await h.q('select * from bl.refunds where payment_id = $1', [s.payment_id]);
    assert.equal(refunds.reduce((x, f) => x + Number(f.amount_kopecks), 0), 53000);
    assert.ok(refunds.every((f) => f.status === 'manual' && f.reason));
    assert.equal((await h.alarms('pos_refund')).length, 1);
    assert.ok((await h.audit('pos.refund')).filter((a) => a.object_id === s.sale_id).every((a) => a.reason));
    // payment.refunded — один раз на возврат (пишет money, касса не дублирует).
    assert.equal((await h.audit('payment.refunded')).filter((a) => a.object_id === s.payment_id).length, 2);
    assert.equal((await h.outboxEvents('payment.refunded')).filter((e) => e.payload.payment_id === s.payment_id).length, 2);
    const [row] = await h.q('select * from bl.pos_sales where id = $1', [s.sale_id]);
    assert.equal(Number(row.refunded_kopecks), 53000);
  });

  it('возврат наличных без открытой смены — shift_closed', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 9000 });
    await h.closeShift();
    try {
      const r = await h.request('POST', `/api/pos/sales/${res.json.sale_id}/refund`, { token: manager.token, body: { reason: 'Тест' }, key: newKey(), club: CLUB_A });
      assert.deepEqual([r.status, r.json.error], [409, 'shift_closed']);
    } finally {
      await h.openShift();
    }
  });

  it('возврат СБП — через ЮKassa с чеком возврата', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.teaBlack, qty: 2 }], method: 'sbp' });
    await h.emuSucceed(await h.providerId(res.json.payment_id));
    await waitFor(async () => (await h.q('select status from bl.pos_sales where id = $1', [res.json.sale_id]))[0].status === 'completed');
    const r = await h.request('POST', `/api/pos/sales/${res.json.sale_id}/refund`, { token: manager.token, body: { reason: 'Остыл' }, key: newKey(), club: CLUB_A });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.amount_kopecks, 30000);
    assert.equal(r.json.status, 'succeeded');
    const emuPay = h.emu.state.payments.get(await h.providerId(res.json.payment_id));
    assert.equal(emuPay.refundedKopecks, 30000);
    const [rc] = await h.q("select * from bl.receipts where refund_id = $1", [r.json.refund_id]);
    assert.equal(rc.channel, 'yookassa');
    assert.equal(linesTotal(rc.items), 30000);
  });
});

describe('касса: деньги до копейки', { skip: SKIP }, () => {
  it('20 продаж разными способами и скидками: платежи = продажи = позиции чеков', async () => {
    const methods = ['cash', 'card_terminal', 'cash', 'card_terminal'];
    const ids = [];
    for (let n = 0; n < 20; n += 1) {
      const items = [
        { product_id: P.water, qty: 1 + (n % 3) },
        { product_id: P.americano, qty: 1 + (n % 2), modifier_ids: n % 2 ? [M.v04, M.noSugar] : [] },
      ];
      const discount = n % 4 === 0 ? { percent: 7 } : n % 4 === 1 ? { amount_kopecks: 1 + n * 13 } : undefined;
      const method = methods[n % 4];
      const res = await sale(reception.token, { items, discount, method, ...(method === 'cash' ? { received_kopecks: 500000 } : {}) });
      assert.equal(res.status, 201, JSON.stringify(res.json));
      ids.push(res.json.sale_id);
    }
    const sales = await h.q('select * from bl.pos_sales where id = any($1::uuid[])', [ids]);
    const payments = await h.q('select p.* from bl.payments p join bl.pos_sales s on s.payment_id = p.id where s.id = any($1::uuid[])', [ids]);
    const receipts = await h.q('select r.* from bl.receipts r join bl.pos_sales s on s.receipt_id = r.id where s.id = any($1::uuid[])', [ids]);
    const sumSales = sales.reduce((x, s) => x + Number(s.bar_total_kopecks), 0);
    const sumPayments = payments.reduce((x, p) => x + Number(p.amount_kopecks), 0);
    const sumLines = receipts.reduce((x, r) => x + linesTotal(r.items), 0);
    const sumItems = (await h.q('select coalesce(sum(amount_kopecks), 0)::bigint as s from bl.pos_sale_items where sale_id = any($1::uuid[])', [ids]))[0].s;
    assert.equal(receipts.length, 20);
    assert.equal(sumPayments, sumSales);
    assert.equal(sumLines, sumSales);
    assert.equal(Number(sumItems), sumSales);
    for (const s of sales) assert.equal(Number(s.bar_total_kopecks), Number(s.bar_subtotal_kopecks) - Number(s.discount_kopecks));
  });
});

describe('сверка смен (№92)', { skip: SKIP }, () => {
  it('каждая продажа и возврат кассы ссылаются на существующую смену своего клуба', async () => {
    const n = (await h.q('select count(*)::int as n from bl.pos_sales where shift_id is not null'))[0].n;
    assert.ok(n >= 20, 'продажи со сменой есть');
    assert.deepEqual(await h.shiftLinks(CLUB_A), []);
    const shifts = await h.q('select distinct s.shift_id, sh.club_id from bl.pos_sales s join bl.shifts sh on sh.id = s.shift_id');
    assert.ok(shifts.every((x) => x.club_id === CLUB_A));
  });

  it('сверка находит продажу со сменой чужого клуба или несуществующей сменой', async () => {
    const [{ id: shiftA }] = await h.q('select id from bl.shifts where club_id = $1 limit 1', [CLUB_A]);
    const [{ id: pay }] = await h.q(
      `insert into bl.payments (club_id, kind, provider, method, idempotence_key, status, amount_kopecks, confirmed_at)
       values ($1, 'bar', 'reception', 'card_terminal', 'bar-check-b', 'succeeded', 100, now()) returning id`,
      [CLUB_B],
    );
    const [{ id: sale }] = await h.q(
      `insert into bl.pos_sales (club_id, channel, method, status, payment_id, created_by, shift_id, bar_subtotal_kopecks, bar_total_kopecks,
                                 created_at, completed_at, updated_at)
       values ($1, 'pos', 'card_terminal', 'completed', $2, 'a2000000-0000-4000-8000-000000000002', $3, 100, 100, now(), now(), now()) returning id`,
      [CLUB_B, pay, shiftA],
    );
    assert.deepEqual(await h.shiftLinks(CLUB_B), [{ object: 'pos_sale', id: sale, shift_id: shiftA }]);
    assert.deepEqual(await h.shiftLinks(CLUB_A), []);
  });
});
