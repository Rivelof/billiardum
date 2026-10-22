// Чеки зачёта предоплаты на ККТ (M3: контракт m3.md §1 п. 5, 10, 11; decisions №52, №87, №112) на
// настоящем Postgres, эмуляторе АТОЛ и мосте: оплата «зачёт предоплаты» (АТОЛ prepaid), колонки
// settles_payment_id и settlement_kopecks, ключ повтора (чек предоплаты ≠ чек зачёта ≠ возврат),
// депозит наличными «Без лимита» в отчёте смены и сверке (зачёт — не выручка и не наличные,
// возврат остатка — минус наличные), пакет часов: чек покупки и зачёт при списании минут.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { creditPackageForSale, debitBalance, packageSaleLine, settleDeposit, takeDeposit } from '../../../payments/api.mjs';
import { resolveDeps } from '../../../payments/deps.mjs';
import * as shiftsApi from '../../../shifts/api.mjs';
import * as kktApi from '../../api.mjs';
import { CLUB_A, GUEST, RECEPTION_A, setupKkt, TABLE_1, TABLE_2 } from './harness.mjs';

let t;
let inj;
let reception;
let manager;

before(async () => {
  t = await setupKkt();
  reception = await t.login('reception');
  manager = await t.login('manager');
  const reg = await t.registerBridge();
  t.startBridge(reg.token);
  const deps = await resolveDeps({
    log: t.log,
    outbox: t.outbox,
    kktApi,
    shiftsApi,
    alarms: { raise: async () => null },
    notify: { send: async () => null, sendToClubStaff: async () => null },
  });
  inj = { deps, config: null };
});
after(async () => {
  await t?.stop();
});

/** Идущая сессия «Без лимита» (как light startFromDeposit). */
async function session(resourceId) {
  const id = randomUUID();
  await t.admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, created_at, updated_at)
     values ($1, $2, $3, 'active', $4, now() - interval '30 minutes', now() + interval '90 minutes', now(), now())`,
    [id, CLUB_A, resourceId, GUEST],
  );
  return id;
}

async function closeSession(id) {
  await t.admin.query("update bl.sessions set status = 'closed', ended_at = now(), close_reason = 'expired', updated_at = now() where id = $1", [id]);
}

const doc = (receiptId) => t.emu.control.documents().find((d) => d.uuid === receiptId);
const asClub = (fn) => t.asClub(CLUB_A, fn);

describe('enqueueReceipt: зачёт предоплаты', () => {
  it('оплата prepayment без settlesPaymentId, settles без prepayment, зачёт в возврате, зачёт позиции «предоплата» — 400', async () => {
    const pay = await t.barSale({ method: 'cash', lines: [{ name: 'Чай', price_kopecks: 15000 }] });
    const line = { name: 'Игра, стол 1', price_kopecks: 15000, payment_subject: 'service' };
    const cases = [
      { lines: [line], payments: [{ method: 'prepayment', amount_kopecks: 15000 }], paymentId: pay.paymentId },
      { lines: [line], payments: [{ method: 'cash', amount_kopecks: 15000 }], paymentId: pay.paymentId, settlesPaymentId: pay.paymentId },
      { kind: 'sell_refund', lines: [line], payments: [{ method: 'prepayment', amount_kopecks: 15000 }], paymentId: pay.paymentId, refundId: randomUUID(), settlesPaymentId: pay.paymentId },
      { lines: [{ ...line, payment_mode: 'full_prepayment' }], payments: [{ method: 'prepayment', amount_kopecks: 15000 }], paymentId: pay.paymentId, settlesPaymentId: pay.paymentId },
      { lines: [line], payments: [{ method: 'prepayment', amount_kopecks: 15000 }], paymentId: pay.paymentId, settlesPaymentId: pay.paymentId, settlementKopecks: 14000 },
      { lines: [line], payments: [{ method: 'prepayment', amount_kopecks: 15000 }], paymentId: pay.paymentId, settlesPaymentId: randomUUID() },
    ];
    for (const [i, c] of cases.entries()) {
      await assert.rejects(
        asClub((db) => kktApi.enqueueReceipt(db, { clubId: CLUB_A, kind: 'sell', operatorName: 'Кассир', ...c })),
        (err) => err.code === 'bad_request',
        `случай ${i}`,
      );
    }
  });

  it('чек зачёта: колонки зачёта, АТОЛ prepaid, сумма чека; повтор — тот же receipt_id, чек предоплаты не возвращается', async () => {
    const pre = await t.barSale({ method: 'cash', lines: [{ name: 'Предоплата игры', price_kopecks: 120000, payment_subject: 'service', payment_mode: 'full_prepayment' }] });
    const args = {
      clubId: CLUB_A,
      kind: 'sell',
      lines: [{ name: 'Игра, стол 2, 1 ч', price_kopecks: 100000, payment_subject: 'service' }, { name: 'Чай', price_kopecks: 30000 }],
      payments: [{ method: 'prepayment', amount_kopecks: 120000 }, { method: 'cash', amount_kopecks: 10000 }],
      operatorName: 'Ресепшн (тест)',
      paymentId: pre.paymentId,
      settlesPaymentId: pre.paymentId,
    };
    const id = await asClub((db) => kktApi.enqueueReceipt(db, args));
    assert.notEqual(id, pre.receiptId, 'зачёт — новый чек, не чек предоплаты');
    const again = await asClub((db) => kktApi.enqueueReceipt(db, args));
    assert.equal(again, id);
    const r = await t.receipt(id);
    assert.deepEqual(
      { s: r.settles_payment_id, k: Number(r.settlement_kopecks), a: Number(r.amount_kopecks), p: r.payment_id },
      { s: pre.paymentId, k: 120000, a: 130000, p: pre.paymentId },
    );
    assert.deepEqual(r.kkt_job.payments, [{ method: 'prepayment', amount_kopecks: 120000 }, { method: 'cash', amount_kopecks: 10000 }]);
    // Чек предоплаты того же платежа по-прежнему находится повтором без зачёта.
    const preAgain = await asClub((db) =>
      kktApi.enqueueReceipt(db, {
        clubId: CLUB_A, kind: 'sell', lines: [{ name: 'x', price_kopecks: 1 }], payments: [{ method: 'cash', amount_kopecks: 1 }], operatorName: 'x', paymentId: pre.paymentId,
      }),
    );
    assert.equal(preAgain, pre.receiptId);
    await t.waitPrinted([id, pre.receiptId]);
    const d = doc(id);
    assert.equal(d.total_kopecks, 130000);
    assert.equal(d.prepaid_kopecks, 120000);
    assert.deepEqual(d.payments, [{ type: 'prepaid', sum_kopecks: 120000 }, { type: 'cash', sum_kopecks: 10000 }]);
    const view = await asClub((db) => kktApi.getReceipt(db, id));
    assert.deepEqual({ s: view.settles_payment_id, k: view.settlement_kopecks, st: view.status }, { s: pre.paymentId, k: 120000, st: 'printed' });
  });
});

describe('депозит наличными «Без лимита»: зачёт и возврат остатка в смене', () => {
  let shiftId;
  let dep;
  let sessionId;
  let settled;

  it('смена, депозит 2 000 ₽ (чек предоплаты наличными), сессия закрыта: зачёт 500 ₽ и возврат 1 500 ₽ наличными', async () => {
    const open = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: reception, body: { float_kopecks: 300000 } });
    assert.equal(open.status, 201, JSON.stringify(open.json));
    shiftId = open.json.id;
    sessionId = await session(TABLE_1);
    dep = await asClub((db) => takeDeposit(db, { clubId: CLUB_A, sessionId, amountKopecks: 200000, staffId: RECEPTION_A }, inj));
    assert.ok(dep.receipt_id);
    await closeSession(sessionId);
    settled = await asClub((db) => settleDeposit(db, { sessionId, usedKopecks: 50000 }, inj));
    assert.deepEqual({ u: settled.used_kopecks, r: settled.refunded_kopecks }, { u: 50000, r: 150000 });
    // Повтор — ничего нового.
    const again = await asClub((db) => settleDeposit(db, { sessionId, usedKopecks: 50000 }, inj));
    assert.deepEqual({ u: again.used_kopecks, r: again.refunded_kopecks, f: again.refund_id }, { u: 50000, r: 150000, f: settled.refund_id });

    const rows = (await t.admin.query('select * from bl.receipts where payment_id = $1 order by created_at, id', [dep.payment_id])).rows;
    assert.equal(rows.length, 3, 'чек предоплаты, чек зачёта, чек возврата');
    const sale = rows.find((r) => r.kind === 'sale' && !r.settles_payment_id);
    const settle = rows.find((r) => r.kind === 'sale' && r.settles_payment_id);
    const refund = rows.find((r) => r.kind === 'refund');
    assert.equal(sale.id, dep.receipt_id);
    assert.deepEqual({ s: settle.settles_payment_id, k: Number(settle.settlement_kopecks), a: Number(settle.amount_kopecks) }, { s: dep.payment_id, k: 50000, a: 50000 });
    assert.equal(refund.refund_id, settled.refund_id);
    await t.waitPrinted(rows.map((r) => r.id));
    assert.deepEqual(doc(sale.id).payments, [{ type: 'cash', sum_kopecks: 200000 }]);
    assert.equal(doc(sale.id).items[0].payment_method, 'fullPrepayment');
    assert.deepEqual(doc(settle.id).payments, [{ type: 'prepaid', sum_kopecks: 50000 }]);
    assert.equal(doc(settle.id).items[0].payment_method, 'fullPayment');
    assert.equal(doc(refund.id).kind, 'sellReturn');
    assert.deepEqual(doc(refund.id).payments, [{ type: 'cash', sum_kopecks: 150000 }]);
    // Наличные в ящике ККТ: +2 000 − 1 500; зачёт денег не добавил.
    const totals = t.emu.control.state().shift.totals;
    assert.equal(totals.sell.prepaid >= 50000, true);
  });

  it('отчёт смены: зачёт — не выручка и не наличные, возврат остатка — минус наличные; сверка ККТ сходится', async () => {
    const res = await t.request('GET', `/api/shifts/${shiftId}/report`, { token: manager });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const r = res.json;
    // Чеки этой смены: депозит 2 000 ₽ наличными (столы), возврат 1 500 ₽ наличными. Продажи
    // бара первого describe были до открытия смены — в смену не входят.
    assert.equal(r.revenue.tables.by_method.cash, 200000);
    assert.equal(r.revenue.refunds.by_method.cash, 150000);
    assert.equal(r.revenue.net_kopecks, 50000);
    assert.equal(r.cash.expected_cash_kopecks, 300000 + 200000 - 150000);
    const k = r.reconciliation.kkt;
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.equal(k.system_kopecks, 50000);
    assert.equal(k.kkt_kopecks, 50000);
    assert.equal(k.by_method.cash.kkt_sales_kopecks, 200000, 'чек зачёта не входит в продажи ККТ');
    assert.equal(k.by_method.cash.kkt_refunds_kopecks, 150000);
    assert.equal(k.settlements.count, 1);
    assert.equal(k.settlements.settlement_kopecks, 50000);
    assert.equal(k.settlements.by_state.printed.count, 1);
  });

  it('закрытие смены с фактом 3 500 ₽ — расхождения нет', async () => {
    const res = await t.request('POST', `/api/shifts/${shiftId}/close`, { token: reception, body: { actual_cash_kopecks: 350000 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const [s] = (await t.admin.query('select * from bl.shifts where id = $1', [shiftId])).rows;
    assert.equal(Number(s.expected_cash_kopecks), 350000);
    assert.equal(Number(s.discrepancy_kopecks), 0);
  });
});

describe('пакет часов на кассе: чек покупки и зачёт при списании минут', () => {
  let shiftId;
  let pkgId;
  let sale;

  it('продажа пакета (чек «предоплата 100 %»), списание 90 минут — чек зачёта prepaid по платежу пакета; игра балансом — не выручка', async () => {
    const open = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: reception, body: { float_kopecks: 0 } });
    assert.equal(open.status, 201, JSON.stringify(open.json));
    shiftId = open.json.id;
    const { rows } = await t.admin.query(
      `insert into bl.tariff_packages (club_id, title, minutes, price_kopecks, valid_days) values ($1, 'Десятка', 600, 500000, 30) returning id`,
      [CLUB_A],
    );
    pkgId = rows[0].id;
    const line = await asClub((db) => packageSaleLine(db, { packageId: pkgId }));
    assert.equal(line.line.payment_mode, 'full_prepayment');
    const l = line.line;
    sale = await t.barSale({
      method: 'card_terminal',
      lines: [{ name: l.description, price_kopecks: line.amount_kopecks, vat_code: l.vat_code, payment_mode: l.payment_mode, payment_subject: l.payment_subject }],
    });
    const payment = (await t.admin.query('select * from bl.payments where id = $1', [sale.paymentId])).rows[0];
    const lot = await asClub((db) => creditPackageForSale(db, { payment, packageId: pkgId, userId: GUEST, index: 0 }, inj));
    assert.equal(lot.minutes_left, 600);
    const sid = await session(TABLE_2);
    const debit = await asClub((db) => debitBalance(db, { clubId: CLUB_A, userId: GUEST, minutes: 90, sessionId: sid }, inj));
    assert.equal(debit.value_kopecks, 75000, '90/600 × 5 000 ₽');
    const settle = (await t.admin.query('select * from bl.receipts where settles_payment_id = $1', [sale.paymentId])).rows;
    assert.equal(settle.length, 1);
    assert.deepEqual({ p: settle[0].payment_id, c: settle[0].channel, k: Number(settle[0].settlement_kopecks) }, { p: debit.payment_id, c: 'kkt', k: 75000 });
    await t.waitPrinted([sale.receiptId, settle[0].id]);
    assert.equal(doc(sale.receiptId).items[0].payment_method, 'fullPrepayment');
    assert.deepEqual(doc(settle[0].id).payments, [{ type: 'prepaid', sum_kopecks: 75000 }]);

    const res = await t.request('GET', `/api/shifts/${shiftId}/report`, { token: manager });
    const r = res.json;
    assert.equal(r.revenue.total_kopecks, 500000, 'выручка — только продажа пакета; игра балансом не деньги');
    assert.equal(r.revenue.tables.total_kopecks, 0);
    assert.equal(r.reconciliation.kkt.ok, true, JSON.stringify(r.reconciliation.kkt));
    assert.equal(r.reconciliation.kkt.settlements.count, 1);
    assert.equal(r.reconciliation.kkt.settlements.settlement_kopecks, 75000);
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/shifts`, { token: manager });
    const mine = list.json.items.find((s) => s.id === shiftId);
    assert.equal(mine.revenue_total_kopecks, 500000);
  });
});
