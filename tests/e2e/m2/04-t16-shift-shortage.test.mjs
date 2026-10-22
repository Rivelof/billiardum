// T16. Закрытие смены с недостачей 500 ₽: ресепшн не видит ожидаемую сумму до ввода факта
// (decisions №94: GET shifts/current, GET shifts/{id} без ожидаемого; отчёт и список смен — 403),
// закрытие без факта — 400; после ввода — ожидаемое и расхождение −500 ₽ в ответе и в отчёте
// смены, тревога cash_discrepancy (критично) и уведомление владельцу, отчёт смены владельцу.
//
// Смена: размен 2 000 ₽ + две продажи наличными + одна терминалом. Ожидаемые наличные тест
// считает сам: размен + наличные продажи.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditFor,
  catalog,
  cartAmount,
  CLUB_A,
  M,
  ok,
  openMyShift,
  OWNER_ID,
  P,
  posSale,
  rub,
  staff,
  waitFor,
  ensureStock,
} from './helpers.mjs';

let db;
let rec;
let man;
let owner;
let cat;
let shift;
let closed;
let myExpected;
const FLOAT = 200_000;

before(async () => {
  db = await adminClient();
  rec = await staff('reception');
  man = await staff('manager');
  owner = await staff('owner');
  await ensureStock(db, man, { [P.chips]: 30, [P.nuts]: 20, [P.waterStill]: 30, [P.waterSpark]: 20, [P.beer]: 20 });
  cat = await catalog(db, rec.token);
  shift = await openMyShift({ rec, man, floatKopecks: FLOAT, log: (m) => console.log(`# ${m}`) });
});

after(async () => {
  await db?.end();
});

test('T16: продажи смены; ресепшн не видит ожидаемые наличные до ввода (№94)', async (t) => {
  const c1 = [{ product_id: P.cappuccino, qty: 2, modifier_ids: [M.v03, M.noSugar] }];
  const c2 = [{ product_id: P.nuts, qty: 1 }];
  const k1 = [{ product_id: P.waterStill, qty: 1 }];
  const s1 = await posSale(rec.token, { items: c1, method: 'cash', received_kopecks: 50_000 });
  const s2 = await posSale(rec.token, { items: c2, method: 'cash', received_kopecks: 20_000 });
  const s3 = await posSale(rec.token, { items: k1, method: 'card_terminal' });
  for (const s of [s1, s2, s3]) assert.equal(s.status, 201, s.text);
  myExpected = FLOAT + cartAmount(cat, c1) + cartAmount(cat, c2);
  t.diagnostic(`смена №${shift.number}: размен ${rub(FLOAT)}; наличными ${rub(cartAmount(cat, c1))} (сдача ${rub(s1.json.change_kopecks)}) и ${rub(cartAmount(cat, c2))} (сдача ${rub(s2.json.change_kopecks)}); терминал ${rub(cartAmount(cat, k1))}; свой расчёт ожидаемых наличных ${rub(myExpected)}`);

  const cur = await ok(api('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: rec.token }));
  const one = await ok(api('GET', `/api/shifts/${shift.id}`, { token: rec.token }));
  const rep = await api('GET', `/api/shifts/${shift.id}/report`, { token: rec.token });
  const list = await api('GET', `/api/clubs/${CLUB_A}/shifts`, { token: rec.token });
  const leak = (o) => ['expected_cash_kopecks', 'cash_sales_kopecks', 'cash_refunds_kopecks', 'discrepancy_kopecks'].filter((k) => o[k] !== undefined && o[k] !== null);
  t.diagnostic(`ресепшн: shifts/current поля ${Object.keys(cur.shift).join(',')} (ожидаемое: ${leak(cur.shift).join(',') || 'нет'}); shifts/{id} ожидаемое: ${leak(one).join(',') || 'нет'}; отчёт → ${rep.status}; список смен → ${list.status}`);
  assert.deepEqual(leak(cur.shift), []);
  assert.deepEqual(leak(one), []);
  assert.equal(rep.status, 403);
  assert.equal(list.status, 403);
  const curMan = await ok(api('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: man.token }));
  t.diagnostic(`управляющий видит ожидаемое: ${rub(curMan.shift.expected_cash_kopecks)} (наличные продажи ${rub(curMan.shift.cash_sales_kopecks)})`);
  assert.equal(curMan.shift.expected_cash_kopecks, myExpected, 'ожидаемое сервера = своему расчёту');
});

test('T16: закрытие без факта — 400; с недостачей 500 ₽ — расхождение в ответе', async (t) => {
  const none = await api('POST', `/api/shifts/${shift.id}/close`, { token: rec.token, body: {} });
  t.diagnostic(`закрыть без факта → ${none.status} ${none.text}`);
  assert.equal(none.status, 400);
  const actual = myExpected - 50_000;
  const tClose = new Date(Date.now() - 1000);
  const r = await api('POST', `/api/shifts/${shift.id}/close`, { token: rec.token, body: { actual_cash_kopecks: actual, comment: 'e2e T16: недостача 500 ₽' } });
  t.diagnostic(`закрыть с фактом ${rub(actual)} → HTTP ${r.status}: expected=${r.json?.expected_cash_kopecks} actual=${r.json?.actual_cash_kopecks} discrepancy=${r.json?.discrepancy_kopecks} status=${r.json?.status}`);
  assert.equal(r.status, 200);
  closed = { ...r.json, tClose };
  assert.equal(r.json.expected_cash_kopecks, myExpected);
  assert.equal(r.json.discrepancy_kopecks, -50_000);
  const again = await api('POST', `/api/shifts/${shift.id}/close`, { token: rec.token, body: { actual_cash_kopecks: actual } });
  t.diagnostic(`повторное закрытие → ${again.status} ${again.text}`);
  assert.equal(again.status, 409);
  const au = await auditFor(db, shift.id, ['shift.close']);
  t.diagnostic(`журнал shift.close: ${JSON.stringify(au.map((a) => ({ actor: a.actor_type, reason: a.reason, discrepancy: a.data.discrepancy_kopecks })))}`);
  assert.equal(au.length, 1);
  assert.equal(Number(au[0].data.discrepancy_kopecks), -50_000);
});

test('T16: расхождение в отчёте смены, тревога и уведомление владельцу', async (t) => {
  assert.ok(closed);
  const rep = await ok(api('GET', `/api/shifts/${shift.id}/report`, { token: owner.token }));
  t.diagnostic(`отчёт (владелец): cash=${JSON.stringify(rep.cash)}; выручка ${JSON.stringify(rep.revenue.by_method)}; ККТ ok=${rep.reconciliation.kkt.ok}`);
  assert.equal(rep.cash.discrepancy_kopecks, -50_000);
  assert.equal(rep.cash.expected_cash_kopecks, myExpected);
  const alarms = await ok(api('GET', `/api/clubs/${CLUB_A}/alarms`, { token: owner.token }));
  const a = alarms.find((x) => x.type === 'cash_discrepancy' && x.data?.shift_id === shift.id);
  t.diagnostic(`тревога владельцу: ${a ? `${a.type} ${a.level} ${a.state} count=${a.count} data=${JSON.stringify(a.data)}` : 'нет'}`);
  assert.ok(a, 'тревога cash_discrepancy по этой смене');
  assert.equal(a.level, 'critical');
  const notes = await waitFor(
    async () => {
      const { rows } = await db.query(
        "select kind, level, text, status, created_at from bl.notifications where club_id = $1 and user_id = $2 and created_at >= $3 and text like $4 order by created_at",
        [CLUB_A, OWNER_ID, closed.tClose, `Смена №${shift.number}%`], // своя смена: отчёт прошлой смены приходит через outbox позже
      );
      return rows.some((r) => r.kind === 'alarm') && rows.some((r) => r.kind === 'shift.report') ? rows : null;
    },
    { timeoutMs: 20_000, what: 'уведомления владельцу: тревога и отчёт смены' },
  );
  for (const n of notes) t.diagnostic(`уведомление владельцу: kind=${n.kind} level=${n.level} status=${n.status}: ${n.text.replace(/\n/g, ' / ')}`);
  const alarmNote = notes.find((n) => n.kind === 'alarm');
  assert.match(alarmNote.text, /недостача/);
  assert.match(alarmNote.text, /−500\s₽/, "знак минус U+2212");
  const report = notes.find((n) => n.kind === 'shift.report');
  assert.match(report.text, /расхождение/);
});
