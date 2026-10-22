// Сервер ККТ на настоящем Postgres: регистрация моста и токен, WebSocket, очередь чеков (заявки
// стола M1 и касса M2), T14 (ККТ выключена → receipt_pending → включили → пробит), обрыв и
// идемпотентность (один чек на один receipt_id), ошибки, тревога «чек не пробит 10 минут», RLS.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { CLUB_A, CLUB_B, setupKkt, TABLE_B, waitFor } from './harness.mjs';

let t;

before(async () => {
  t = await setupKkt();
});
after(async () => {
  await t?.stop();
});

/** Попытка подключиться к /api/kkt/ws: код ответа апгрейда или 101. */
function tryConnect(token, { origin } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    const ws = new WebSocket(t.wsUrl, { headers });
    ws.on('open', () => {
      ws.terminate();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on('error', () => resolve(0));
  });
}

async function outboxTopics(topic) {
  const { rows } = await t.admin.query('select payload from bl.outbox where topic = $1 order by id', [topic]);
  return rows.map((r) => r.payload);
}

async function alarmsOf(clubId, type) {
  const { rows } = await t.admin.query('select * from bl.alarms where club_id = $1 and type = $2', [clubId, type]);
  return rows;
}

describe('мост ККТ: регистрация и токен', () => {
  it('владелец получает токен один раз; в базе только sha256; управляющий и ресепшн — 403', async () => {
    const reg = await t.registerBridge('owner', CLUB_A, 'ПК ресепшена');
    assert.match(reg.token, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(reg.bridge.name, 'ПК ресепшена');
    const { rows } = await t.admin.query('select token_hash from bl.kkt_bridges where id = $1', [reg.bridge.id]);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(rows).includes(reg.token));
    for (const who of ['manager', 'reception']) {
      const res = await t.request('POST', `/api/clubs/${CLUB_A}/kkt/bridges`, { token: await t.login(who), body: { name: 'x' } });
      assert.equal(res.status, 403, who);
    }
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/kkt/bridges`, { token: await t.login('manager') });
    assert.equal(list.status, 200);
    assert.ok(list.json.some((b) => b.id === reg.bridge.id));
    assert.ok(!JSON.stringify(list.json).includes(reg.token), 'токен не отдаётся повторно');
    // журнал
    const audit = await t.admin.query("select 1 from bl.audit_log where club_id = $1 and action = 'kkt.bridge_register' and object_id = $2", [CLUB_A, reg.bridge.id]);
    assert.equal(audit.rowCount, 1);
  });

  it('владелец чужого клуба не регистрирует мост клуба A и не видит его мосты', async () => {
    const tokenB = await t.login('ownerB');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/kkt/bridges`, { token: tokenB, body: { name: 'чужой' } })).status, 403);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/kkt/bridges`, { token: tokenB })).status, 403);
  });

  it('WebSocket: без токена, с мусором, с поддельным клубом в токене и из браузера (Origin) — отказ', async () => {
    const reg = await t.registerBridge();
    assert.equal(await tryConnect(null), 401);
    assert.equal(await tryConnect('x'.repeat(64)), 401);
    // Тот же секрет, но клуб B в первых байтах токена: строки нет в контексте клуба B.
    const raw = Buffer.from(reg.token, 'base64url');
    Buffer.from(CLUB_B.replace(/-/g, ''), 'hex').copy(raw, 0);
    assert.equal(await tryConnect(raw.toString('base64url')), 401);
    assert.equal(await tryConnect(reg.token, { origin: 'https://evil.example' }), 403);
    assert.equal(await tryConnect(reg.token), 101);
  });

  it('отозванный мост: соединение закрывается, токен больше не принимается; отзыв — только владелец', async () => {
    const reg = await t.registerBridge('owner', CLUB_A, 'Старый ПК');
    const ws = new WebSocket(t.wsUrl, { headers: { authorization: `Bearer ${reg.token}` } });
    const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    await new Promise((resolve) => ws.on('message', resolve));
    assert.equal((await t.request('POST', `/api/kkt/bridges/${reg.bridge.id}/revoke`, { token: await t.login('manager') })).status, 403);
    // Владелец клуба Б: в его клубе такого моста нет (RLS) — 404.
    assert.equal((await t.request('POST', `/api/kkt/bridges/${reg.bridge.id}/revoke`, { token: await t.login('ownerB') })).status, 404);
    const res = await t.request('POST', `/api/kkt/bridges/${reg.bridge.id}/revoke`, { token: await t.login('owner') });
    assert.equal(res.status, 200);
    assert.ok(res.json.revoked_at);
    assert.equal(await closed, 4001);
    assert.equal(await tryConnect(reg.token), 401);
    ws.terminate();
  });
});

describe('очередь чеков ККТ', () => {
  let bridgeA;

  it('чек заявки стола M1 (receipt_pending от money) пробивается мостом: ФД, ФП, ФН, журнал, outbox receipt.printed', async () => {
    const reg = await t.registerBridge('owner', CLUB_A, 'Ресепшн');
    bridgeA = reg;
    t.startBridge(reg.token);
    const { receiptId } = await t.receptionPayment({ amount: 160000, minutes: 120 });
    await t.waitPrinted(receiptId);
    const r = await t.receipt(receiptId);
    assert.equal(r.status, 'printed');
    assert.ok(Number(r.fd) > 0);
    assert.match(r.fp, /^\d{10}$/);
    assert.match(r.fn, /^\d{16}$/);
    assert.equal(r.kkt_job.uuid, receiptId, 'UUID задания АТОЛ = receipt_id (№78)');
    assert.equal(r.kkt_job.task.operator.name, 'Ресепшн (тест)', 'кассир — принявший оплату');
    assert.equal(r.kkt_job.task.items[0].paymentObject, 'service');
    const doc = t.emu.control.documents().find((d) => d.uuid === receiptId);
    assert.equal(doc.total_kopecks, 160000);
    assert.deepEqual(doc.payments, [{ type: 'cash', sum_kopecks: 160000 }]);
    const printed = await waitFor(async () => (await outboxTopics('receipt.printed')).find((p) => p.receipt_id === receiptId));
    assert.deepEqual(printed, { receipt_id: receiptId, club_id: CLUB_A, fd: Number(r.fd), fp: r.fp });
    const audit = await t.admin.query("select data from bl.audit_log where club_id = $1 and action = 'kkt.receipt_printed' and object_id = $2", [CLUB_A, receiptId]);
    assert.equal(audit.rows[0].data.fd, Number(r.fd));
  });

  it('касса M2: enqueueReceipt — позиции, терминал → electronically, receipt_id; повтор с тем же saleId — тот же чек', async () => {
    const sale = await t.barSale({ method: 'card_terminal', lines: [{ name: 'Кофе', price_kopecks: 18000, quantity: 1 }, { name: 'Вода', price_kopecks: 9000, quantity: 3, payment_subject: 'commodity' }] });
    await t.waitPrinted(sale.receiptId);
    const doc = t.emu.control.documents().find((d) => d.uuid === sale.receiptId);
    assert.equal(doc.total_kopecks, 45000);
    assert.deepEqual(doc.payments, [{ type: 'electronically', sum_kopecks: 45000 }]);
    assert.equal(doc.items.length, 2);
    // Повтор того же saleId — тот же receipt_id, второй строки нет.
    const { enqueueReceipt } = await import('../../api.mjs');
    const r = await t.receipt(sale.receiptId);
    const again = await t.asClub(CLUB_A, (db) =>
      enqueueReceipt(db, { clubId: CLUB_A, kind: 'sell', lines: [{ name: 'x', price_kopecks: 100 }], payments: [{ method: 'cash', amount_kopecks: 100 }], operatorName: 'x', saleId: r.sale_id }),
    );
    assert.equal(again, sale.receiptId);
  });

  it('enqueueReceipt проверяет задание сразу: сумма оплат ≠ сумме позиций, чужой клуб — ошибка', async () => {
    const { enqueueReceipt } = await import('../../api.mjs');
    await assert.rejects(
      t.asClub(CLUB_A, (db) => enqueueReceipt(db, { clubId: CLUB_A, kind: 'sell', lines: [{ name: 'Чай', price_kopecks: 15000 }], payments: [{ method: 'cash', amount_kopecks: 10000 }], operatorName: 'x', saleId: '0d4e7a5c-1111-4222-8333-944455556661' })),
      (err) => err.code === 'bad_request',
    );
    await assert.rejects(
      t.asClub(CLUB_B, (db) => enqueueReceipt(db, { clubId: CLUB_A, kind: 'sell', lines: [{ name: 'Чай', price_kopecks: 15000 }], payments: [{ method: 'cash', amount_kopecks: 15000 }], operatorName: 'x', saleId: '0d4e7a5c-1111-4222-8333-944455556662' })),
      /контексте клуба/,
    );
  });

  it('T14: ККТ выключена — продажа сохранена, receipt_pending, предупреждение; включили — пробит один раз', async () => {
    t.emu.control.power(false, 'reject');
    await waitFor(async () => (await t.request('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: await t.login('reception') })).json.state === 'offline');
    const sale = await t.barSale({ method: 'cash', lines: [{ name: 'Пиво б/а', price_kopecks: 25000 }] });
    await waitFor(async () => (await t.receipt(sale.receiptId)).error === 'kkt_offline');
    let r = await t.receipt(sale.receiptId);
    assert.equal(r.status, 'receipt_pending');
    const st = await t.request('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: await t.login('reception') });
    assert.equal(st.status, 200);
    assert.equal(st.json.state, 'offline');
    assert.ok(st.json.queue.pending >= 1);
    // SSE kkt (offline) публикуется с задержкой до 150 мс после события.
    await waitFor(() => t.log.lines.some((l) => l.msg === 'kkt_state' && l.state === 'offline'));
    const before = t.emu.control.state().receipts;
    t.emu.control.power(true);
    await t.waitPrinted(sale.receiptId);
    r = await t.receipt(sale.receiptId);
    assert.equal(r.error, null);
    assert.equal(t.emu.control.state().receipts, before + 1, 'один чек');
    assert.equal(t.emu.control.documents().filter((d) => d.uuid === sale.receiptId).length, 1);
    await waitFor(async () => (await t.request('GET', `/api/clubs/${CLUB_A}/kkt/status`, { token: await t.login('reception') })).json.state === 'online');
  });

  it('ККТ без связи во время задания (задание в АТОЛ с ошибкой) — новая попытка с новым UUID, чек один', async () => {
    t.emu.control.power(false, 'error');
    const sale = await t.barSale({ lines: [{ name: 'Сок', price_kopecks: 12000 }] });
    await waitFor(async () => Number((await t.receipt(sale.receiptId)).kkt_job?.errors ?? 0) >= 1);
    t.emu.control.power(true);
    await t.waitPrinted(sale.receiptId);
    const r = await t.receipt(sale.receiptId);
    assert.ok(r.kkt_job.attempt >= 2);
    assert.notEqual(r.kkt_job.done_uuid, sale.receiptId);
    assert.equal(t.emu.control.documents().filter((d) => r.kkt_job.uuids.includes(d.uuid)).length, 1);
  });

  it('обрыв связи моста во время печати: после переподключения — тот же UUID, чек один (идемпотентность)', async () => {
    t.emu.control.delay(600);
    const sale = await t.barSale({ lines: [{ name: 'Орешки', price_kopecks: 20000 }] });
    await waitFor(() => t.emu.control.documents().length >= 0 && t.emu.control.state().open_requests > 0);
    // Разорвать все соединения мостов на сервере.
    t.service().closeConnections();
    await t.waitPrinted(sale.receiptId);
    t.emu.control.delay(0);
    const r = await t.receipt(sale.receiptId);
    assert.equal(r.kkt_job.attempt, 1);
    assert.equal(t.emu.control.documents().filter((d) => d.uuid === sale.receiptId).length, 1);
  });

  it('связь с ККТ оборвалась после закрытия документа в ФН: чек пробит, известен только ФД (partial)', async () => {
    t.emu.control.fault('lose_after_fiscal', 1);
    const sale = await t.barSale({ lines: [{ name: 'Лимонад', price_kopecks: 13000 }] });
    await t.waitPrinted(sale.receiptId);
    const r = await t.receipt(sale.receiptId);
    assert.ok(Number(r.fd) > 0);
    assert.equal(r.fp, null);
    assert.equal(r.fiscal.kkt.partial, true);
    assert.equal(t.emu.control.documents().filter((d) => d.uuid === sale.receiptId).length, 1);
  });

  it('несколько чеков подряд — все пробиты, номера ФД разные', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) ids.push((await t.barSale({ lines: [{ name: `Позиция ${i}`, price_kopecks: 1000 + i }] })).receiptId);
    await t.waitPrinted(ids);
    const { rows } = await t.admin.query('select fd from bl.receipts where id = any($1::uuid[])', [ids]);
    assert.equal(new Set(rows.map((r) => String(r.fd))).size, 5);
  });

  it('неверные данные чека (НДС 13) — failed, receipt.failed, тревога; повтор управляющим — с причиной', async () => {
    const { receiptId, paymentId } = await t.receptionPayment({ amount: 50000 });
    // Испортить позицию до отправки — так пришла бы ошибка данных от соседа.
    await t.admin.query(`update bl.receipts set items = jsonb_set(items, '{0,vat_code}', '13'::jsonb) where id = $1`, [receiptId]);
    await waitFor(async () => (await t.receipt(receiptId)).status === 'failed');
    const r = await t.receipt(receiptId);
    assert.equal(r.error, 'invalid_receipt');
    assert.ok((await outboxTopics('receipt.failed')).some((p) => p.receipt_id === receiptId && p.error === 'invalid_receipt'));
    assert.equal((await alarmsOf(CLUB_A, 'receipt_failed')).length, 1);
    void paymentId;
    // Исправили данные — управляющий повторяет; без причины — reason_required; ресепшн — 403.
    await t.admin.query(`update bl.receipts set items = jsonb_set(items, '{0,vat_code}', '1'::jsonb) where id = $1`, [receiptId]);
    assert.equal((await t.request('POST', `/api/kkt/receipts/${receiptId}/retry`, { token: await t.login('reception'), body: { reason: 'x' } })).status, 403);
    const noReason = await t.request('POST', `/api/kkt/receipts/${receiptId}/retry`, { token: await t.login('manager'), body: {} });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.json.error, 'reason_required');
    const ok = await t.request('POST', `/api/kkt/receipts/${receiptId}/retry`, { token: await t.login('manager'), body: { reason: 'Исправили ставку НДС' } });
    assert.equal(ok.status, 200);
    await t.waitPrinted(receiptId);
    const audit = await t.admin.query("select reason from bl.audit_log where action = 'kkt.receipt_retry' and object_id = $1", [receiptId]);
    assert.equal(audit.rows[0].reason, 'Исправили ставку НДС');
  });

  it('ошибка ФН: несколько повторов, затем failed', async () => {
    t.emu.control.fn(115);
    const sale = await t.barSale({ lines: [{ name: 'Шоколад', price_kopecks: 9900 }] });
    await waitFor(async () => (await t.receipt(sale.receiptId)).status === 'failed', { timeoutMs: 20_000 });
    t.emu.control.fn(null);
    const r = await t.receipt(sale.receiptId);
    assert.equal(r.error, 'atol_115');
    assert.equal(r.kkt_job.errors, 5);
  });

  it('исход неизвестен (АТОЛ потерял задание): тревога критично; «нашли на ККТ» — ФД руками, ручное действие', async () => {
    // Смоделировать: мост сообщил «исход неизвестен» (АТОЛ не знает отправленное задание).
    const lost = await t.barSale({ lines: [{ name: 'Потерянный', price_kopecks: 7000 }] });
    await t.waitPrinted(lost.receiptId);
    const { rows: ins } = await t.admin.query(
      `insert into bl.receipts (club_id, payment_id, kind, channel, status, amount_kopecks, items, kkt_job, error, created_at, updated_at)
       select club_id, payment_id, 'sale', 'kkt', 'receipt_pending', amount_kopecks, items,
              jsonb_build_object('state', 'lost', 'uuid', gen_random_uuid()::text, 'attempt', 1), 'atol_task_lost', now(), now()
         from bl.receipts where id = $1 returning id`,
      [lost.receiptId],
    );
    const unknownId = ins[0].id;
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/kkt/receipts?status=unknown`, { token: await t.login('manager') });
    assert.ok(list.json.some((x) => x.id === unknownId && x.status === 'unknown'));
    const bad = await t.request('POST', `/api/kkt/receipts/${unknownId}/mark-printed`, { token: await t.login('manager'), body: { fd: 99999, fp: '123', reason: '' } });
    assert.equal(bad.json.error, 'reason_required');
    const res = await t.request('POST', `/api/kkt/receipts/${unknownId}/mark-printed`, { token: await t.login('manager'), body: { fd: 99999, fp: '1234567890', reason: 'Нашли чек в ленте ККТ' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'printed');
    const alarm = await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data ->> 'action' = 'receipt_mark_printed'", [CLUB_A]);
    assert.equal(alarm.rowCount, 1);
    const notes = await t.admin.query("select 1 from bl.notifications where club_id = $1 and text like 'Чек отмечен пробитым вручную%'", [CLUB_A]);
    assert.ok(notes.rowCount >= 1, 'владелец уведомлён');
  });

  it('мост клуба B не получает чеки клуба A', async () => {
    await t.stopBridges();
    const regB = await t.registerBridge('ownerB', CLUB_B, 'ПК клуба Б');
    t.startBridge(regB.token);
    const { receiptId } = await t.receptionPayment({ amount: 30000 });
    const { receiptId: receiptB } = await t.receptionPayment({ clubId: CLUB_B, resourceId: TABLE_B, amount: 70000, acceptedBy: null });
    await t.waitPrinted(receiptB);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await t.receipt(receiptId)).status, 'receipt_pending', 'чек клуба A ждёт свой мост');
    t.startBridge(bridgeA.token);
    await t.waitPrinted(receiptId);
  });
});

describe('тревога «Чек не пробит больше 10 минут»', () => {
  it('чек старше 10 минут без моста — тревога владельцу один раз; повторный проход не дублирует', async () => {
    await t.stopBridges();
    const { receiptId } = await t.receptionPayment({ amount: 45000, at: new Date(Date.now() - 11 * 60_000) });
    await t.admin.query('update bl.receipts set created_at = $2 where id = $1', [receiptId, new Date(Date.now() - 11 * 60_000)]);
    const n = await t.service().alarmTick();
    assert.ok(n >= 1);
    const alarms = await alarmsOf(CLUB_A, 'receipt_pending');
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].level, 'important');
    assert.ok((await t.receipt(receiptId)).alarmed_at);
    const notes = await t.admin.query("select text from bl.notifications where club_id = $1 and text like 'Чек не пробит больше 10 минут%'", [CLUB_A]);
    assert.ok(notes.rowCount >= 1);
    assert.match(notes.rows[0].text, /на 450\s₽/);
    await t.service().alarmTick();
    assert.equal((await alarmsOf(CLUB_A, 'receipt_pending'))[0].count, 1);
  });
});

describe('RLS и права новых таблиц', () => {
  async function asAppApi(clubId, fn) {
    const c = await t.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role app_api');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [clubId ?? '']);
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  }
  const attempt = async (c, sql, params) => {
    await c.query('savepoint s');
    try {
      await c.query(sql, params);
      await c.query('release savepoint s');
      return null;
    } catch (err) {
      await c.query('rollback to savepoint s');
      return err;
    }
  };

  it('клуб A не видит мосты, задания ККТ и смены клуба B; без контекста — ничего', async () => {
    await asAppApi(CLUB_A, async (c) => {
      for (const table of ['kkt_bridges', 'kkt_ops', 'shifts']) {
        const { rows } = await c.query(`select count(*)::int as n from bl.${table} where club_id <> $1`, [CLUB_A]);
        assert.equal(rows[0].n, 0, table);
      }
      const err = await attempt(c, `insert into bl.kkt_bridges (club_id, name, token_hash) values ($1, 'x', repeat('a', 64))`, [CLUB_B]);
      assert.equal(err?.code, '42501', 'чужой club_id — нарушение политики');
    });
    await asAppApi(null, async (c) => {
      const { rows } = await c.query('select (select count(*) from bl.kkt_bridges)::int as b, (select count(*) from bl.shifts)::int as s');
      assert.deepEqual(rows[0], { b: 0, s: 0 });
    });
    const forced = await t.admin.query(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'bl'::regnamespace and relname in ('kkt_bridges', 'kkt_ops', 'shifts') order by 1`,
    );
    assert.deepEqual(forced.rows.map((r) => [r.relname, r.relrowsecurity, r.relforcerowsecurity]), [
      ['kkt_bridges', true, true],
      ['kkt_ops', true, true],
      ['shifts', true, true],
    ]);
  });

  it('app_api: нет DELETE, хеш токена не меняется, пробитый чек неизменен, отзыв не снимается', async () => {
    const { rows: br } = await t.admin.query('select id from bl.kkt_bridges where club_id = $1 limit 1', [CLUB_A]);
    const { rows: pr } = await t.admin.query("select id from bl.receipts where club_id = $1 and status = 'printed' limit 1", [CLUB_A]);
    const { rows: rv } = await t.admin.query('select id from bl.kkt_bridges where club_id = $1 and revoked_at is not null limit 1', [CLUB_A]);
    await asAppApi(CLUB_A, async (c) => {
      assert.equal((await attempt(c, 'delete from bl.kkt_bridges where id = $1', [br[0].id]))?.code, '42501');
      assert.equal((await attempt(c, 'delete from bl.receipts where id = $1', [pr[0].id]))?.code, '42501');
      assert.equal((await attempt(c, "update bl.kkt_bridges set token_hash = repeat('b', 64) where id = $1", [br[0].id]))?.code, '42501');
      assert.equal((await attempt(c, 'update bl.receipts set fd = fd + 1 where id = $1', [pr[0].id]))?.code, '23514');
      assert.equal((await attempt(c, "update bl.receipts set status = 'receipt_pending' where id = $1", [pr[0].id]))?.code, '23514');
      assert.equal((await attempt(c, 'update bl.kkt_bridges set revoked_at = null where id = $1', [rv[0].id]))?.code, '23514');
    });
  });

  it('kkt_due — узкая функция: только идентификаторы, EXECUTE только у app_api', async () => {
    const { rows } = await t.admin.query(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef, has_function_privilege('public', p.oid, 'execute') as pub
         from pg_proc p where p.proname = 'kkt_due' and p.pronamespace = 'bl'::regnamespace`,
    );
    assert.deepEqual(rows[0], { owner: 'bl_definer', prosecdef: true, pub: false });
  });
});
