// Эмулятор веб-сервера драйвера АТОЛ: формат заданий и результатов, ФД/ФП/смена, сбои ККТ.

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createAtolEmulator } from '../emu/emulator.mjs';

let emu;
let base;

const sell = (over = {}) => ({
  type: 'sell',
  taxationType: 'usnIncome',
  electronically: false,
  operator: { name: 'Ресепшн (тест)' },
  items: [
    { type: 'position', name: 'Чай', price: 150, quantity: 2, amount: 300, tax: { type: 'none' }, paymentMethod: 'fullPayment', paymentObject: 'commodity' },
    { type: 'position', name: 'Игра, стол 4, 1 ч', price: 800, quantity: 1, amount: 800, tax: { type: 'vat22' }, paymentMethod: 'fullPayment', paymentObject: 'service' },
  ],
  payments: [{ type: 'cash', sum: 1100 }],
  total: 1100,
  ...over,
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function result(uuid, { timeoutMs = 3000, legacy = false } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await call('GET', `${legacy ? '' : '/api/v2'}/requests/${uuid}`);
    const open = r.json?.results?.some((x) => ['wait', 'inProgress', 'blocked'].includes(x.status));
    if (r.status === 200 && !open) return r.json.results;
    if (Date.now() > until) return r.json?.results ?? null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

before(async () => {
  emu = createAtolEmulator({ recoverMs: 50 });
  await emu.listen(0);
  base = emu.url;
});
after(async () => {
  await emu.close();
});
beforeEach(() => emu.control.reset());

describe('эмулятор АТОЛ: задания', () => {
  it('sell: 201, затем ready с ФД, ФП, номером чека и смены (смена открывается сама)', async () => {
    const add = await call('POST', '/api/v2/requests', { uuid: 'u-1', request: [sell()] });
    assert.equal(add.status, 201);
    assert.equal(add.json.uuid, 'u-1');
    assert.equal(add.json.isBlocked, false);
    const [r] = await result('u-1');
    assert.equal(r.status, 'ready');
    assert.deepEqual(r.error, { code: 0, description: 'Ошибок нет' });
    const f = r.result.fiscalParams;
    assert.equal(f.fiscalDocumentNumber, 2, 'ФД 1 — отчёт об открытии смены');
    assert.match(f.fiscalDocumentSign, /^\d{10}$/);
    assert.equal(f.fiscalReceiptNumber, 1);
    assert.equal(f.shiftNumber, 1);
    assert.equal(f.total, 1100);
    assert.match(f.fnNumber, /^\d{16}$/);
    const docs = emu.control.documents();
    assert.deepEqual(docs.map((d) => d.kind), ['openShift', 'sell']);
    assert.equal(docs[1].total_kopecks, 110000);
    assert.equal(docs[1].operator, 'Ресепшн (тест)');
  });

  it('повтор UUID — 409, неизвестный UUID — 404, старый формат /requests — errorCode', async () => {
    await call('POST', '/api/v2/requests', { uuid: 'u-2', request: [sell()] });
    const dup = await call('POST', '/api/v2/requests', { uuid: 'u-2', request: [sell()] });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error.code, 505);
    assert.equal((await call('GET', '/api/v2/requests/nope')).status, 404);
    const [r] = await result('u-2', { legacy: true });
    assert.equal(r.errorCode, 0);
    assert.equal(r.status, 'ready');
    assert.equal(emu.control.state().receipts, 1);
  });

  it('проверка задания: сумма позиций ≠ total, неверный НДС, нет кассира — ошибка 9', async () => {
    for (const [uuid, task] of [
      ['v-1', sell({ total: 1000 })],
      ['v-2', sell({ items: [{ ...sell().items[0], tax: { type: 'vat18' } }], total: 300, payments: [{ type: 'cash', sum: 300 }] })],
      ['v-3', sell({ operator: {} })],
      ['v-4', sell({ payments: [{ type: 'electronically', sum: 1200 }] })],
    ]) {
      await call('POST', '/api/v2/requests', { uuid, request: [task] });
      const [r] = await result(uuid);
      assert.equal(r.status, 'error', uuid);
      assert.equal(r.error.code, 9, uuid);
    }
    assert.equal(emu.control.state().receipts, 0);
  });

  it('после ошибки остальные задачи задания — interrupted (502)', async () => {
    await call('POST', '/api/v2/requests', { uuid: 'i-1', request: [sell({ total: 1 }), { type: 'getShiftStatus' }] });
    const rs = await result('i-1');
    assert.deepEqual(rs.map((x) => x.status), ['error', 'interrupted']);
    assert.equal(rs[1].error.code, 502);
  });
});

describe('эмулятор АТОЛ: сбои ККТ', () => {
  it('выключена (reject) — 409 «ККТ не подключена», задание не создаётся', async () => {
    emu.control.power(false, 'reject');
    const add = await call('POST', '/api/v2/requests', { uuid: 'p-1', request: [sell()] });
    assert.equal(add.status, 409);
    assert.match(add.json.error.description, /не подключена/);
    assert.equal((await call('GET', '/api/v2/requests/p-1')).status, 404);
    const op = await call('POST', '/api/v2/operations/queryDeviceStatus', {});
    assert.equal(op.status, 409);
  });

  it('выключена (error) — задача error «Нет связи» (2), документа нет', async () => {
    emu.control.power(false, 'error');
    await call('POST', '/api/v2/requests', { uuid: 'p-2', request: [sell()] });
    const [r] = await result('p-2');
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 2);
    assert.equal(emu.control.state().fd, 0);
  });

  it('выключена (wait) — задание ждёт в очереди и выполняется после включения', async () => {
    emu.control.power(false, 'wait');
    await call('POST', '/api/v2/requests', { uuid: 'p-3', request: [sell()] });
    const waiting = await result('p-3', { timeoutMs: 150 });
    assert.equal(waiting[0].status, 'wait');
    emu.control.power(true);
    const [r] = await result('p-3');
    assert.equal(r.status, 'ready');
  });

  it('нет бумаги (error) — 44 до документа; (block) — документ без печати, очередь ждёт бумагу', async () => {
    emu.control.paper(false, 'error');
    await call('POST', '/api/v2/requests', { uuid: 'b-1', request: [sell()] });
    assert.equal((await result('b-1'))[0].error.code, 44);
    assert.equal(emu.control.state().fd, 0);

    emu.control.paper(false, 'block');
    await call('POST', '/api/v2/requests', { uuid: 'b-2', request: [sell()] });
    await call('POST', '/api/v2/requests', { uuid: 'b-3', request: [sell()] });
    await new Promise((r) => setTimeout(r, 100));
    const q = await call('GET', '/api/v2/getRequestsQueueStatus');
    assert.equal(q.json.isBlocked, true);
    assert.equal(q.json.blockReason, 'paperError');
    const b2 = (await call('GET', '/api/v2/requests/b-2')).json.results[0];
    assert.equal(b2.status, 'ready');
    assert.equal(b2.result.warnings.notPrinted, true);
    assert.equal((await call('GET', '/api/v2/requests/b-3')).json.results[0].status, 'wait');
    emu.control.paper(true);
    assert.equal((await result('b-3'))[0].status, 'ready');
    assert.equal(emu.control.state().receipts, 2);
  });

  it('ошибка ФН — код ФН, документа нет', async () => {
    emu.control.fn(115);
    await call('POST', '/api/v2/requests', { uuid: 'f-1', request: [sell()] });
    const [r] = await result('f-1');
    assert.equal(r.error.code, 115);
    assert.equal(emu.control.state().receipts, 0);
  });

  it('обрыв после закрытия документа в ФН — blocked, затем ready только с номером ФД', async () => {
    emu.control.fault('lose_after_fiscal', 1);
    await call('POST', '/api/v2/requests', { uuid: 'l-1', request: [sell()] });
    await new Promise((r) => setTimeout(r, 10));
    const mid = (await call('GET', '/api/v2/requests/l-1')).json.results[0];
    assert.ok(['inProgress', 'blocked', 'ready'].includes(mid.status));
    const [r] = await result('l-1');
    assert.equal(r.status, 'ready');
    assert.deepEqual(Object.keys(r.result.fiscalParams), ['fiscalDocumentNumber']);
    assert.equal(r.result.fiscalParams.fiscalDocumentNumber, 2);
    assert.equal(emu.control.state().receipts, 1);
  });

  it('«забыть задание»: документ в ФН есть, а GET по UUID — 404', async () => {
    emu.control.fault('forget_request', 1);
    await call('POST', '/api/v2/requests', { uuid: 'fg-1', request: [sell()] });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call('GET', '/api/v2/requests/fg-1')).status, 404);
    assert.equal(emu.control.documents().filter((d) => d.uuid === 'fg-1').length, 1);
    await call('POST', '/api/v2/requests', { uuid: 'fg-2', request: [sell()] });
    assert.equal((await result('fg-2'))[0].status, 'ready', 'сбой — один раз');
    assert.equal((await call('POST', '/__emu/fault', { kind: 'nope' })).status, 400);
  });

  it('задержка печати: задача inProgress, затем ready', async () => {
    emu.control.delay(200);
    await call('POST', '/api/v2/requests', { uuid: 'd-1', request: [sell()] });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal((await call('GET', '/api/v2/requests/d-1')).json.results[0].status, 'inProgress');
    assert.equal((await result('d-1'))[0].status, 'ready');
  });
});

describe('эмулятор АТОЛ: смена ККТ', () => {
  it('openShift, повтор — 70; closeShift, повтор — 69; номер смены растёт', async () => {
    await call('POST', '/api/v2/requests', { uuid: 's-1', request: [{ type: 'openShift', operator: { name: 'Иванова' } }] });
    const [o] = await result('s-1');
    assert.equal(o.status, 'ready');
    assert.equal(o.result.fiscalParams.shiftNumber, 1);
    await call('POST', '/api/v2/requests', { uuid: 's-2', request: [{ type: 'openShift', operator: { name: 'Иванова' } }] });
    assert.equal((await result('s-2'))[0].error.code, 70);
    await call('POST', '/api/v2/requests', { uuid: 's-3', request: [{ type: 'closeShift', operator: { name: 'Иванова' } }] });
    assert.equal((await result('s-3'))[0].status, 'ready');
    await call('POST', '/api/v2/requests', { uuid: 's-4', request: [{ type: 'closeShift', operator: { name: 'Иванова' } }] });
    assert.equal((await result('s-4'))[0].error.code, 69);
    await call('POST', '/api/v2/requests', { uuid: 's-5', request: [{ type: 'getShiftStatus' }] });
    assert.deepEqual((await result('s-5'))[0].result.shiftStatus.state, 'closed');
    await call('POST', '/api/v2/requests', { uuid: 's-6', request: [sell()] });
    assert.equal((await result('s-6'))[0].result.fiscalParams.shiftNumber, 2);
  });

  it('смена старше 24 часов — чек 68, closeShift проходит, затем чек в новой смене', async () => {
    emu.control.expireShift();
    const st = await call('POST', '/api/v2/operations/queryShiftStatus', {});
    assert.equal(st.json.shiftStatus.state, 'expired');
    await call('POST', '/api/v2/requests', { uuid: 'e-1', request: [sell()] });
    assert.equal((await result('e-1'))[0].error.code, 68);
    await call('POST', '/api/v2/requests', { uuid: 'e-2', request: [{ type: 'closeShift', operator: { name: 'Авто' } }] });
    assert.equal((await result('e-2'))[0].status, 'ready');
    await call('POST', '/api/v2/requests', { uuid: 'e-3', request: [sell()] });
    assert.equal((await result('e-3'))[0].status, 'ready');
  });

  it('управление /__emu: состояние, сброс, неверный режим — 400', async () => {
    assert.equal((await call('POST', '/__emu/power', { on: false, mode: 'sleep' })).status, 400);
    const s = await call('POST', '/__emu/power', { on: false, mode: 'wait' });
    assert.equal(s.json.power, false);
    assert.equal((await call('GET', '/__emu/state')).json.offline_mode, 'wait');
    assert.equal((await call('POST', '/__emu/reset', {})).json.power, true);
  });
});
