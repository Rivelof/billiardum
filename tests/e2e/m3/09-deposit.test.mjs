// Депозит наличными для «Без лимита» (контракт M3 §1 п. 11; decisions №87, №112).
//
// Стол E2E_DEPOSIT_TABLE (по умолчанию 4).
// 1. Без открытой смены — 409 shift_closed, сессия не создана, команд свету нет (если смену
//    держит не tester — проверка пропускается с пометкой).
// 2. Своя смена (размен 3 000 ₽). Ресепшн принимает депозит 1 000 ₽, получено 1 500 ₽ — сдача
//    500 ₽; сессия «Без лимита» до исчерпания по тарифу, свет; чек ККТ «предоплата 100 %» наличными;
//    журнал reception.deposit. Продление гостем — 400 (депозит сам не продлевается).
// 3. ~1,5 минуты игры, ресепшн закрывает игру → свет гаснет; расчёт по факту: чек ККТ зачёта
//    (оплата prepaid) на сыгранное, возврат остатка наличными (bl.refunds manual) с чеком
//    возврата ККТ; журнал reception.deposit_settled.
// 4. Смена: своя книга (размен + депозит − возврат) = ожидаемое управляющего; закрытие честным
//    фактом — расхождение 0.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditOf,
  closeMyShift,
  cmdsWithAudit,
  currentShift,
  docsFor,
  isMine,
  kktDocs,
  MIN,
  newGuest,
  ok,
  openMyShift,
  quote,
  RES,
  receiptRow,
  session,
  sim,
  sleep,
  staff,
  tableCode,
  waitFor,
  waitReceiptsPrinted,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_DEPOSIT_TABLE || 4);
const FLOAT = 300_000;
const DEPOSIT = 100_000;
let db;
let rec;
let man;
let shift;

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  await waitTableFree(T, { timeoutMs: 45 * MIN });
});

after(async () => {
  if (shift) await closeMyShift({ rec, man, shiftId: shift.id }).catch((e) => console.log(`смена не закрыта: ${e.message}`));
  await db?.end();
});

test('без открытой смены депозит не принимается: shift_closed, свет не включается', async (t) => {
  const cur = await currentShift(man.token);
  if (cur && !isMine(cur.id)) {
    t.diagnostic(`открыта чужая смена №${cur.number} — проверка без смены пропущена`);
    t.skip('чужая смена');
    return;
  }
  if (cur) await closeMyShift({ rec, man, shiftId: cur.id });
  const since = new Date();
  const r = await api('POST', '/api/reception/deposits', { token: rec.token, idem: true, body: { resource_id: RES(T), amount_kopecks: DEPOSIT } });
  await sleep(1500);
  const { rows } = await db.query('select count(*)::int as n from bl.sessions where resource_id = $1 and created_at >= $2', [RES(T), since]);
  const { cmds } = await cmdsWithAudit(db, T, since);
  const s = await sim(T);
  t.diagnostic(`без смены: ${r.status} ${r.text}; сессий ${rows[0].n}, команд ${cmds.length}, стол ${s.state.mode}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'shift_closed');
  assert.equal(rows[0].n, 0);
  assert.equal(cmds.length, 0);
  assert.equal(s.state.relay, false);
});

test(`депозит наличными «Без лимита»: игра, закрытие, возврат остатка с чеком, смена сходится (стол ${T})`, { timeout: 10 * MIN }, async (t) => {
  const since = new Date();
  shift = await openMyShift({ rec, man, floatKopecks: FLOAT, log: (m) => t.diagnostic(m) });
  const guest = await newGuest();
  const ph = (await ok(api('GET', `/api/t/${tableCode(T)}`))).price_now.price_per_hour_kopecks;
  const r = await api('POST', '/api/reception/deposits', { token: rec.token, idem: true, body: { resource_id: RES(T), amount_kopecks: DEPOSIT, received_kopecks: 150_000, user_id: guest.user.id } });
  assert.equal(r.status, 201, r.text);
  const dep = r.json;
  const on = await waitSim(T, (s) => s.state.relay === true && s.state.session_id === dep.session_id, { timeoutMs: 5000, what: 'свет по депозиту' });
  const s0 = await session(guest.token, dep.session_id);
  t.diagnostic(`депозит: ${JSON.stringify(dep)}; сессия unlimited=${s0.unlimited}, deposit ${s0.deposit_kopecks}, до ${s0.paid_until} (${dep.minutes} мин); контроллер ${on.state.mode}, остаток ${Math.round(on.state.remaining_ms / 1000)} с`);
  assert.equal(dep.change_kopecks, 50_000);
  assert.equal(s0.unlimited, true);
  assert.equal(s0.deposit_kopecks, DEPOSIT);
  assert.ok(Math.abs(dep.minutes - Math.floor((DEPOSIT * 60) / ph)) <= 1, `1 000 ₽ по ${ph / 100} ₽/ч`);
  const sale = await receiptRow(db, dep.receipt_id);
  await waitReceiptsPrinted(db, dep.receipt_id);
  const d1 = docsFor(kktDocs(), await receiptRow(db, dep.receipt_id));
  t.diagnostic(`чек депозита: ${sale.kind}/${sale.channel} ${sale.amount_kopecks}; АТОЛ ${JSON.stringify(d1.map((d) => ({ kind: d.kind, total: d.total_kopecks, payments: d.payments, items: d.items.map((i) => [i.name, i.amount_kopecks, i.payment_method]) })))}`);
  assert.equal(d1.length, 1);
  assert.deepEqual(d1[0].payments, [{ type: 'cash', sum_kopecks: DEPOSIT }]);
  assert.ok(d1[0].items.every((i) => /prepayment/i.test(i.payment_method ?? '')), 'предоплата 100 %');
  const q = await quote(guest.token, { resourceId: RES(T), kind: 'extend', minutes: 30, sessionId: dep.session_id });
  t.diagnostic(`продление гостем: ${q.status} ${q.text}`);
  assert.equal(q.status, 400);

  await sleep(90_000);
  const stop = await api('POST', `/api/sessions/${dep.session_id}/stop`, { token: rec.token, headers: { 'x-club-id': s0.club.id } });
  t.diagnostic(`ресепшн закрывает игру: ${stop.status}`);
  assert.equal(stop.status, 200, stop.text);
  await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000, what: 'свет погас' });
  const p = await waitFor(async () => {
    const { rows } = await db.query('select id, settlement_status, settled_kopecks from bl.payments where id = $1', [dep.payment_id]);
    return rows[0].settlement_status === 'settled' ? rows[0] : null;
  }, { timeoutMs: 20_000, what: 'депозит рассчитан' });
  const { rows: rf } = await db.query('select id, amount_kopecks, status from bl.refunds where payment_id = $1', [dep.payment_id]);
  const { rows: rc } = await db.query('select id, kind, status, amount_kopecks, settles_payment_id from bl.receipts where (payment_id = $1 or settles_payment_id = $1) and id <> $2 order by created_at', [dep.payment_id, dep.receipt_id]);
  const s1 = await session(guest.token, dep.session_id);
  const playedMin = (new Date(s1.ended_at) - new Date(s1.started_at)) / MIN;
  const used = Number(p.settled_kopecks);
  // По факту с минимумом тарифа (правило клуба min_minutes 30, шаг 1 минута).
  const billed = Math.max(30, Math.ceil(playedMin));
  const want = Math.round((ph * billed) / 60);
  t.diagnostic(`сыграно ${playedMin.toFixed(2)} мин (к оплате по тарифу ${billed} мин ≈ ${want}) → удержано ${used} коп., возврат ${JSON.stringify(rf.map((x) => [x.amount_kopecks, x.status]))}, чеки ${JSON.stringify(rc.map((x) => [x.kind, x.status, x.amount_kopecks, Boolean(x.settles_payment_id)]))}`);
  assert.ok(Math.abs(used - want) <= 100, 'расчёт по факту (с минимумом тарифа)');
  assert.equal(rf.length, 1);
  assert.equal(Number(rf[0].amount_kopecks), DEPOSIT - used);
  await waitReceiptsPrinted(db, rc.map((x) => x.id));
  const docs = kktDocs();
  const settleDoc = docsFor(docs, await receiptRow(db, rc.find((x) => x.settles_payment_id).id));
  const refundDoc = docsFor(docs, await receiptRow(db, rc.find((x) => x.kind === 'refund').id));
  t.diagnostic(`АТОЛ зачёт: ${JSON.stringify(settleDoc.map((d) => ({ kind: d.kind, total: d.total_kopecks, payments: d.payments })))}; возврат: ${JSON.stringify(refundDoc.map((d) => ({ kind: d.kind, total: d.total_kopecks, payments: d.payments })))}`);
  assert.deepEqual(settleDoc[0].payments, [{ type: 'prepaid', sum_kopecks: used }]);
  assert.equal(refundDoc[0].kind, 'sellReturn');
  assert.deepEqual(refundDoc[0].payments, [{ type: 'cash', sum_kopecks: DEPOSIT - used }]);
  const au = (await auditOf(db, dep.session_id)).map((a) => a.action);
  t.diagnostic(`журнал: ${au.join(', ')}`);
  for (const a of ['session.start', 'reception.deposit', 'reception.deposit_settled']) assert.ok(au.includes(a), a);

  const mine = FLOAT + DEPOSIT - (DEPOSIT - used);
  const cur = await currentShift(man.token);
  t.diagnostic(`смена №${cur.number}: ожидаемые наличные управляющего ${cur.expected_cash_kopecks}, своя книга ${mine}`);
  assert.equal(Number(cur.expected_cash_kopecks), mine);
  const closed = await closeMyShift({ rec, man, shiftId: shift.id, actual: mine });
  const disc = closed?.discrepancy_kopecks ?? closed?.shift?.discrepancy_kopecks;
  t.diagnostic(`закрытие фактом ${mine}: расхождение ${disc}`);
  assert.equal(Number(disc), 0);
  shift = null;
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}`);
  assert.deepEqual(missing, []);
});
