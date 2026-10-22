// Сверка за смену (контракт M2 §7): 50 продаж разными способами — сумма чеков ККТ = продажи,
// онлайн = ЮKassa (эмулятор), до копейки; затем расхождения видны в отчёте.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, setupKkt, TABLE_2, waitFor } from './harness.mjs';

let t;
let manager;

before(async () => {
  t = await setupKkt({ yookassa: true });
  manager = await t.login('manager');
  const reg = await t.registerBridge();
  t.startBridge(reg.token);
});
after(async () => {
  await t?.stop();
});

describe('сверка смены', () => {
  let shiftId;
  const totals = { all: 0, tables: 0, bar: 0, cash: 0, card_terminal: 0, sbp: 0, card: 0, kkt: 0, online: 0, refunds: 0 };

  it('50 продаж (наличные, терминал, СБП, карта; столы и бар) и возврат — сумма чеков ККТ = продажи, онлайн = ЮKassa, до копейки', async () => {
    const open = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: await t.login('reception'), body: { float_kopecks: 300000 } });
    assert.equal(open.status, 201);
    shiftId = open.json.id;
    const receiptIds = [];
    let firstCash = null;
    for (let i = 0; i < 50; i += 1) {
      const amount = 10000 + i * 137 + (i % 7); // разные копейки
      const kind = i % 6;
      if (kind === 0 || kind === 1) {
        // Бар на кассе: наличные / терминал, 1–3 позиции.
        const method = kind === 0 ? 'cash' : 'card_terminal';
        const lines = [{ name: `Позиция ${i}`, price_kopecks: amount }];
        if (i % 4 === 0) lines.push({ name: 'Вода', price_kopecks: 5050, quantity: 2 });
        const sale = await t.barSale({ method, lines });
        receiptIds.push(sale.receiptId);
        totals.bar += sale.amount;
        totals[method] += sale.amount;
        totals.kkt += sale.amount;
        totals.all += sale.amount;
      } else if (kind === 2 || kind === 3) {
        // Заявка стола M1 на ресепшене: наличные / терминал.
        const method = kind === 2 ? 'cash' : 'card_terminal';
        const p = await t.receptionPayment({ method, amount, resourceId: TABLE_2, number: 2 });
        if (method === 'cash' && !firstCash) firstCash = { ...p, amount };
        receiptIds.push(p.receiptId);
        totals.tables += amount;
        totals[method] += amount;
        totals.kkt += amount;
        totals.all += amount;
      } else {
        // Онлайн: СБП за стол / карта за бар.
        const method = kind === 4 ? 'sbp' : 'card';
        await t.onlinePayment({ method, amount, kind: kind === 4 ? 'start' : 'bar' });
        totals[kind === 4 ? 'tables' : 'bar'] += amount;
        totals[method] += amount;
        totals.online += amount;
        totals.all += amount;
      }
    }
    const refund = await t.cashRefund({ paymentId: firstCash.paymentId, amount: 1234 });
    receiptIds.push(refund.receiptId);
    totals.refunds = 1234;
    await t.waitPrinted(receiptIds, 60_000);
    const expectedCash = 300000 + totals.cash - totals.refunds;
    const close = await t.request('POST', `/api/shifts/${shiftId}/close`, { token: await t.login('reception'), body: { actual_cash_kopecks: expectedCash } });
    assert.equal(close.status, 200);
    assert.equal(close.json.expected_cash_kopecks, expectedCash);
    assert.equal(close.json.discrepancy_kopecks, 0);

    const res = await t.request('GET', `/api/shifts/${shiftId}/report`, { token: manager });
    assert.equal(res.status, 200);
    const r = res.json;
    assert.equal(r.revenue.payments_count, 50);
    assert.equal(r.revenue.total_kopecks, totals.all);
    assert.equal(r.revenue.tables.total_kopecks, totals.tables);
    assert.equal(r.revenue.bar.total_kopecks, totals.bar);
    for (const m of ['cash', 'card_terminal', 'sbp', 'card']) assert.equal(r.revenue.by_method[m], totals[m], m);
    assert.equal(r.revenue.refunds.total_kopecks, 1234);

    const k = r.reconciliation.kkt;
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.equal(k.system_kopecks, totals.kkt - totals.refunds);
    assert.equal(k.kkt_kopecks, totals.kkt - totals.refunds);
    assert.equal(k.diff_kopecks, 0);
    assert.equal(k.receipts.printed.count, 34 + 1);
    assert.equal(k.missing_count, 0);
    // Сумма документов в эмуляторе ККТ — та же.
    const docs = t.emu.control.documents();
    const sold = docs.filter((d) => d.kind === 'sell').reduce((a, d) => a + d.total_kopecks, 0);
    const returned = docs.filter((d) => d.kind === 'sellReturn').reduce((a, d) => a + d.total_kopecks, 0);
    assert.equal(sold - returned, totals.kkt - totals.refunds, 'ККТ напечатала ровно продажи');

    const o = r.reconciliation.online;
    assert.equal(o.status, 'checked');
    assert.equal(o.ok, true, JSON.stringify(o));
    assert.equal(o.payments, 16);
    assert.equal(o.system_kopecks, totals.online);
    assert.equal(o.yookassa_kopecks, totals.online);
    assert.equal(o.diff_kopecks, 0);

    await waitFor(async () => (await t.admin.query("select 1 from bl.notifications where club_id = $1 and kind = 'shift.report'", [CLUB_A])).rowCount === 1, { timeoutMs: 10_000 });
    const note = await t.admin.query("select text from bl.notifications where club_id = $1 and kind = 'shift.report'", [CLUB_A]);
    assert.match(note.rows[0].text, /Чеки ККТ сходятся с продажами/);
    assert.match(note.rows[0].text, /Онлайн-оплаты сходятся с ЮKassa/);
    assert.match(note.rows[0].text, /Касса сошлась/);
  });

  it('расхождения видны: чек ККТ не пробит (ККТ выключена), сумма онлайн-платежа не совпала с ЮKassa', async () => {
    const open = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: await t.login('reception'), body: { float_kopecks: 0 } });
    t.emu.control.power(false, 'reject');
    const sale = await t.barSale({ method: 'cash', lines: [{ name: 'Кофе', price_kopecks: 17000 }] });
    await waitFor(async () => (await t.receipt(sale.receiptId)).error === 'kkt_offline');
    await t.onlinePayment({ method: 'sbp', amount: 50000, recordedAmount: 50100 });
    const res = await t.request('GET', `/api/shifts/${open.json.id}/report`, { token: manager });
    const k = res.json.reconciliation.kkt;
    assert.equal(k.ok, false);
    assert.equal(k.diff_kopecks, 17000);
    assert.equal(k.receipts.pending.count, 1);
    assert.deepEqual(k.missing.map((x) => x.amount_kopecks), [17000]);
    const o = res.json.reconciliation.online;
    assert.equal(o.ok, false);
    assert.equal(o.diff_kopecks, 100);
    assert.equal(o.mismatches[0].reason, 'amount');
    assert.equal(res.json.period.live, true);
    t.emu.control.power(true);
    await t.waitPrinted(sale.receiptId);
    const again = await t.request('GET', `/api/shifts/${open.json.id}/report?online=0`, { token: manager });
    assert.equal(again.json.reconciliation.kkt.ok, true);
    assert.equal(again.json.reconciliation.online.status, 'skipped');
  });

  it('ЮKassa недоступна: сверка онлайн — unavailable, отчёт всё равно собирается', async () => {
    await t.yk.close();
    const { rows } = await t.admin.query('select id from bl.shifts where club_id = $1 and closed_at is null', [CLUB_A]);
    const res = await t.request('GET', `/api/shifts/${rows[0].id}/report`, { token: manager });
    assert.equal(res.status, 200);
    assert.equal(res.json.reconciliation.online.status, 'unavailable');
    t.yk = null;
  });
});
