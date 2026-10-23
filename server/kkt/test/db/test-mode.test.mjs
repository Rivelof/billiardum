// Касса в тестовом режиме клуба (M5.1 №153, tester Д1): вся цепочка сервер → мост tools/kkt-bridge →
// эмулятор АТОЛ на настоящем Postgres. Задание тестового клуба уходит мосту с test: true; мост печатает
// нефискальный «ТЕСТ», ФД не тратится; чек — printed без ФД (kkt.receipt_test_printed); закрытие смены —
// нефискальный отчёт, задание done; ложных тревог (receipt_unknown, receipt_pending, kkt_shift_failed) нет.
// Защита моста: даже сохранённое фискальное задание тестового чека печатается «ТЕСТ», фискальное
// закрытие смены в тестовом задании — отказ.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { jobUuid, receiptTask } from '../../atol-task.mjs';
import { ensureOp } from '../../queue.mjs';
import { CLUB_A, setupKkt, waitFor } from './harness.mjs';

let t;
let bridgeId;
let token;

before(async () => {
  t = await setupKkt();
  await t.admin.query("update bl.clubs set mode = 'test', mode_before_suspend = null where id = $1", [CLUB_A]);
  const reg = await t.registerBridge();
  bridgeId = reg.bridge.id;
  token = reg.token;
  t.startBridge(token);
  await waitFor(() => t.service().isOnline(bridgeId), { timeoutMs: 5000, stepMs: 20 });
});
after(async () => {
  await t?.stop();
});

const FALSE_ALARMS = ['receipt_unknown', 'receipt_pending', 'kkt_shift_failed', 'receipt_failed', 'receipt_fd_conflict', 'receipt_double'];

async function falseAlarms() {
  const { rows } = await t.admin.query('select type from bl.alarms where club_id = $1 and type = any($2::text[])', [CLUB_A, FALSE_ALARMS]);
  return rows.map((r) => r.type);
}

async function auditOf(action, objectId) {
  const { rows } = await t.admin.query('select * from bl.audit_log where club_id = $1 and action = $2 and object_id = $3 order by seq', [CLUB_A, action, objectId]);
  return rows;
}

const emuState = () => t.emu.control.state();
const nonFiscalDocs = () => t.emu.control.documents().filter((d) => d.kind === 'nonFiscal');

describe('касса клуба в тестовом режиме: сервер → мост → эмулятор АТОЛ', () => {
  it('чеки заявки стола, бара и возврата — «ТЕСТ», printed без ФД, журнал kkt.receipt_test_printed, тревог нет', async () => {
    const fdBefore = emuState().fd;
    const docsBefore = nonFiscalDocs().length;
    const table = await t.receptionPayment({ amount: 80000 });
    const bar = await t.barSale();
    const refund = await t.cashRefund({ paymentId: table.paymentId, amount: 20000 });
    const ids = [table.receiptId, bar.receiptId, refund.receiptId];
    await t.waitPrinted(ids);

    for (const id of ids) {
      const r = await t.receipt(id);
      assert.equal(r.is_test, true, 'чек тестового клуба');
      assert.equal(r.status, 'printed');
      assert.deepEqual([r.fd, r.fp, r.fn, r.error], [null, null, null, null]);
      assert.equal(r.fiscal.test, true);
      assert.equal(r.fiscal.kkt.non_fiscal, true);
      assert.equal(r.kkt_job.test, true, 'kkt_job.test');
      assert.equal(r.kkt_job.state, 'done');
      assert.equal((await auditOf('kkt.receipt_test_printed', id)).length, 1);
      assert.equal((await auditOf('kkt.receipt_unknown', id)).length, 0);
      assert.equal((await auditOf('kkt.receipt_printed', id)).length, 0);
    }
    // ККТ: фискальных документов нет, смена ККТ не открывалась; напечатано три «ТЕСТ».
    assert.equal(emuState().fd, fdBefore, 'ФД не тратится');
    assert.equal(emuState().receipts, 0);
    assert.equal(emuState().shift.state, 'closed');
    const docs = nonFiscalDocs().slice(docsBefore);
    assert.equal(docs.length, 3);
    assert.ok(docs.every((d) => d.lines[0] === 'ТЕСТ' && d.fd === null));
    assert.ok(docs.some((d) => d.lines.includes('Возврат')));
    // Ни одного неизвестного исхода в логе сервера — мост знал, что ФД не будет.
    assert.ok(!t.log.lines.some((l) => JSON.stringify(l).includes('no_fiscal_params')));
    assert.deepEqual(await falseAlarms(), []);

    // Сторож «чек не пробит 10 минут» по напечатанным «ТЕСТ» не срабатывает.
    await t.service().alarmTick();
    assert.deepEqual(await falseAlarms(), []);
    const status = await t.asClub(CLUB_A, (db) => t.service().statusOf(db, CLUB_A));
    assert.deepEqual([status.queue.unknown, status.queue.failed], [0, 0]);
  });

  it('закрытие смены ККТ тестового клуба — нефискальный отчёт «ТЕСТ», задание done, журнал kkt.shift_close с test', async () => {
    const fdBefore = emuState().fd;
    const docsBefore = nonFiscalDocs().length;
    // Открытие смены ККТ в тестовом режиме не создаётся вовсе.
    assert.equal(await t.asClub(CLUB_A, (db) => ensureOp(db, { clubId: CLUB_A, kind: 'open_shift', operatorName: 'Ресепшн', now: new Date() })), null);
    const opId = await t.asClub(CLUB_A, (db) => ensureOp(db, { clubId: CLUB_A, kind: 'close_shift', operatorName: 'Ресепшн', now: new Date() }));
    t.service().kick(CLUB_A);
    await waitFor(
      async () => {
        const { rows } = await t.admin.query('select status from bl.kkt_ops where id = $1', [opId]);
        return rows[0].status !== 'pending';
      },
      { timeoutMs: 10_000, stepMs: 50 },
    );
    const { rows } = await t.admin.query('select * from bl.kkt_ops where id = $1', [opId]);
    const op = rows[0];
    assert.equal(op.is_test, true);
    assert.equal(op.status, 'done', `закрытие тестовой смены: ${op.status} ${op.error}`);
    assert.equal(op.error, null);
    assert.equal(op.kkt_job.test, true);
    const [rec] = await auditOf('kkt.shift_close', opId);
    assert.equal(rec.data.test, true);
    assert.equal(rec.data.fd, null);
    assert.equal(emuState().fd, fdBefore);
    assert.equal(emuState().shift.state, 'closed', 'фискальная смена ККТ не тронута');
    const docs = nonFiscalDocs().slice(docsBefore);
    assert.equal(docs.length, 1);
    assert.ok(docs[0].lines.includes('Отчёт о закрытии смены. Не фискальный'));
    assert.deepEqual(await falseAlarms(), []);
  });

  it('защита моста: сохранённое фискальное задание тестового чека печатается «ТЕСТ», ФД не тратится', async () => {
    const fdBefore = emuState().fd;
    const docsBefore = nonFiscalDocs().length;
    let receiptId;
    // Чек тестового клуба «в полёте» с фискальным заданием sell (как если бы сервер собрал его по ошибке):
    // сервер повторяет мосту сохранённое задание с test: true, мост сам превращает его в «ТЕСТ».
    await offline(async () => {
      const sale = await t.barSale({ lines: [{ name: 'Кофе', price_kopecks: 25000, quantity: 2 }] });
      receiptId = sale.receiptId;
      const r = await t.receipt(receiptId);
      assert.equal(r.is_test, true);
      const task = receiptTask({ kind: 'sell', items: r.items, amountKopecks: Number(r.amount_kopecks), taxSystemCode: null, payments: [{ method: 'cash', amount_kopecks: 50000 }], operatorName: 'Кассир' });
      assert.equal(task.type, 'sell', 'фискальное задание');
      await inFlight('receipts', receiptId, task);
    });
    await t.waitPrinted(receiptId);
    const r = await t.receipt(receiptId);
    assert.deepEqual([r.status, r.fd, r.fn, r.fiscal.test], ['printed', null, null, true]);
    assert.equal(emuState().fd, fdBefore, 'фискальный чек не пробит');
    assert.equal(emuState().receipts, 0);
    const docs = nonFiscalDocs().slice(docsBefore);
    assert.equal(docs.length, 1);
    assert.ok(docs[0].lines.includes('Итого 500,00 ₽'), JSON.stringify(docs[0].lines));
    assert.equal((await auditOf('kkt.receipt_test_printed', receiptId)).length, 1);
    assert.deepEqual(await falseAlarms(), []);
  });

  it('защита моста: фискальное закрытие смены в тестовом задании — отказ, смена ККТ не тронута', async () => {
    const fdBefore = emuState().fd;
    let opId;
    await offline(async () => {
      opId = await t.asClub(CLUB_A, (db) => ensureOp(db, { clubId: CLUB_A, kind: 'close_shift', operatorName: 'Ресепшн', now: new Date() }));
      await inFlight('kkt_ops', opId, { type: 'closeShift', operator: { name: 'Ресепшн' } });
    });
    await waitFor(
      async () => {
        const { rows } = await t.admin.query('select status from bl.kkt_ops where id = $1', [opId]);
        return rows[0].status !== 'pending';
      },
      { timeoutMs: 10_000, stepMs: 50 },
    );
    const { rows } = await t.admin.query('select status, error from bl.kkt_ops where id = $1', [opId]);
    assert.deepEqual([rows[0].status, rows[0].error], ['failed', 'test_fiscal_task']);
    assert.equal(emuState().fd, fdBefore);
    assert.equal(emuState().shift.state, 'closed');
  });
});


/** Мост отключён на время fn (задание не уходит), затем подключается снова. */
async function offline(fn) {
  await t.stopBridges();
  await waitFor(() => !t.service().isOnline(bridgeId), { timeoutMs: 5000, stepMs: 20 });
  await fn();
  t.startBridge(token);
  await waitFor(() => t.service().isOnline(bridgeId), { timeoutMs: 5000, stepMs: 20 });
}

/** Задание «в полёте» этому мосту с данным (фискальным) заданием АТОЛ. */
async function inFlight(table, id, task) {
  const uuid = jobUuid(id, 1);
  await t.admin.query(`update bl.${table} set kkt_job = $2 where id = $1`, [
    id,
    { v: 1, type: task.type, uuid, uuids: [uuid], attempt: 1, state: 'sent', task_created: false, bridge_id: bridgeId, sent_at: new Date(0).toISOString(), task },
  ]);
}
