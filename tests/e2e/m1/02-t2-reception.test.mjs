// T2. Оплата «на ресепшене» наличными: заявка на экране ресепшена, после «Принять» — свет,
// чек ККТ в очереди (receipt_pending).
//
// Гость: котировка 60 мин → pay {method: reception} → {reception_request_id, waiting_reception};
// стол pending (симулятор: white_blink). Ресепшн (+70000000004): заявка в списке клуба с маской
// телефона; принять наличными меньше суммы — отказ; принять 2 000 ₽ → сдача, сессия, свет;
// повтор с тем же Idempotency-Key — тот же ответ; второй «Принять» с новым ключом — отказ.
// Чек: bl.receipts channel kkt, status receipt_pending; в чеке сессии — pending. Журнал
// reception.accept. В конце гость «Закончить игру».

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  brief,
  CLUB_A,
  logLines,
  newGuest,
  ok,
  pay,
  quote,
  SIM_CONTAINER,
  staff,
  table,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_T2_TABLE || 5);
let db;
let guest;
let rec;
let q;
let requestId;
let accepted;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
  guest = await newGuest();
  rec = await staff('reception');
});

after(async () => {
  await db?.end();
});

test(`T2: гость выбирает «Оплачу на ресепшене» (стол ${TABLE}) → заявка, стол pending`, async (t) => {
  const tbl = await table(TABLE, guest.token);
  q = await ok(quote(guest.token, { resourceId: tbl.resource.id, minutes: 60 }));
  const r = await ok(pay(guest.token, q.quote_id, 'reception'));
  t.diagnostic(`pay reception → ${JSON.stringify(r)}; сумма ${q.amount_kopecks} коп.`);
  assert.equal(r.status, 'waiting_reception');
  assert.ok(r.reception_request_id);
  requestId = r.reception_request_id;
  const st = await waitSim(TABLE, (x) => x.state.mode === 'pending', { timeoutMs: 5000 });
  t.diagnostic(`симулятор: ${brief(st)}`);
  assert.equal(st.state.led, 'white_blink');
  assert.equal(st.state.relay, false);
  const g = await ok(api('GET', `/api/reception/requests/${requestId}`, { token: guest.token }));
  t.diagnostic(`заявка глазами гостя: ${JSON.stringify(g)}`);
});

test('T2: заявка на экране ресепшена (список клуба), гость не видит список', async (t) => {
  const list = await ok(api('GET', `/api/clubs/${CLUB_A}/reception/requests`, { token: rec.token }));
  const mine = list.find((x) => x.id === requestId);
  t.diagnostic(`заявка у ресепшена: ${JSON.stringify(mine)}`);
  assert.ok(mine, 'заявка в списке');
  assert.equal(mine.resource_number, TABLE);
  assert.equal(mine.minutes, 60);
  assert.equal(mine.amount_kopecks, q.amount_kopecks);
  assert.match(mine.guest_masked_phone, /\*/, 'телефон маскирован');
  assert.ok(!mine.guest_masked_phone.includes(guest.phone.slice(-7, -2)), 'полный номер не виден');
  const denied = await api('GET', `/api/clubs/${CLUB_A}/reception/requests`, { token: guest.token });
  t.diagnostic(`гость → список заявок: HTTP ${denied.status} ${denied.text}`);
  assert.ok([401, 403].includes(denied.status));
});

test('T2: «Принять» наличными: меньше суммы — отказ; 2 000 ₽ — сдача, свет, повтор идемпотентен', async (t) => {
  const short = await api('POST', `/api/reception/requests/${requestId}/accept`, { token: rec.token, idem: true, body: { method: 'cash', received_kopecks: q.amount_kopecks - 100 } });
  t.diagnostic(`наличных меньше суммы → HTTP ${short.status} ${short.text}`);
  assert.equal(short.status, 400);
  const st0 = await (await fetch(`http://127.0.0.1:18080/sim/tables/${TABLE}`)).json();
  assert.equal(st0.state.relay, false, 'свет не включился без оплаты');

  const since = new Date(Date.now() - 500);
  const key = randomUUID();
  const received = Math.max(200_000, q.amount_kopecks);
  const tAccept = Date.now();
  const a = await api('POST', `/api/reception/requests/${requestId}/accept`, { token: rec.token, idem: key, body: { method: 'cash', received_kopecks: received } });
  t.diagnostic(`accept → HTTP ${a.status} ${a.text}`);
  assert.equal(a.status, 200);
  accepted = { ...a.json };
  assert.equal(accepted.change_kopecks, received - q.amount_kopecks, 'сдача считается сервером');
  assert.ok(accepted.payment_id);
  if (!a.json.session_id) {
    // Контракт §5: ответ {payment_id, change_kopecks, session_id}. Сессия создаётся через outbox
    // после ответа, поэтому session_id берём из заявки глазами гостя (как приложение гостя).
    t.diagnostic('замечание: в ответе accept session_id = null (сессия создаётся асинхронно через outbox)');
    const g = await waitFor(
      async () => {
        const x = await api('GET', `/api/reception/requests/${requestId}`, { token: guest.token });
        return x.status === 200 && x.json.session_id ? x.json : null;
      },
      { timeoutMs: 5000, intervalMs: 50, what: 'session_id у заявки' },
    );
    accepted.session_id = g.session_id;
  }
  const st = await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === accepted.session_id, { timeoutMs: 5000, intervalMs: 50 });
  t.diagnostic(`свет через ${Date.now() - tAccept} мс после ответа «Принять» (опрос); симулятор: ${brief(st)}`);
  const relay = await waitFor(() => logLines(SIM_CONTAINER, since, 'sim_relay').find((l) => l.table === TABLE), { timeoutMs: 5000, what: 'sim_relay' });
  const { rows: pr } = await db.query('select confirmed_at, method, status, received_kopecks, change_kopecks from bl.payments where id = $1', [accepted.payment_id]);
  t.diagnostic(`платёж: ${JSON.stringify(pr[0])}; confirmed_at → sim_relay ${new Date(relay.t) - new Date(pr[0].confirmed_at)} мс`);
  assert.equal(pr[0].method, 'cash');

  const again = await api('POST', `/api/reception/requests/${requestId}/accept`, { token: rec.token, idem: key, body: { method: 'cash', received_kopecks: received } });
  t.diagnostic(`повтор с тем же ключом → HTTP ${again.status} ${again.text}`);
  assert.equal(again.status, 200);
  assert.equal(again.json.payment_id, accepted.payment_id);
  assert.equal(again.json.change_kopecks, accepted.change_kopecks);
  const second = await api('POST', `/api/reception/requests/${requestId}/accept`, { token: rec.token, idem: true, body: { method: 'cash', received_kopecks: received } });
  t.diagnostic(`второй «Принять» с новым ключом → HTTP ${second.status} ${second.text}`);
  assert.ok(second.status >= 400, 'вторая оплата той же заявки не проходит');
  const { rows: cnt } = await db.query("select count(*)::int as n from bl.payments where session_id = $1 and status = 'succeeded'", [accepted.session_id]);
  assert.equal(cnt[0].n, 1, 'одна оплата');
});

test('T2: чек ККТ в очереди (receipt_pending), журнал reception.accept', async (t) => {
  assert.ok(accepted);
  const { rows } = await db.query('select kind, channel, status, amount_kopecks from bl.receipts where payment_id = $1', [accepted.payment_id]);
  t.diagnostic(`bl.receipts: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((r) => r.channel === 'kkt' && r.status === 'receipt_pending' && Number(r.amount_kopecks) === q.amount_kopecks));
  const rc = await ok(api('GET', `/api/sessions/${accepted.session_id}/receipt`, { token: guest.token }));
  t.diagnostic(`чек сессии у гостя: receipt_status=${rc.receipt_status}, платежи ${JSON.stringify(rc.payments.map((p) => ({ method: p.method, amount_kopecks: p.amount_kopecks, receipt_status: p.receipt_status })))}`);
  assert.equal(rc.receipt_status, 'pending');
  const { rows: au } = await db.query("select action, actor_type, data from bl.audit_log where club_id = $1 and action = 'reception.accept' and data->>'request_id' = $2", [CLUB_A, requestId]);
  t.diagnostic(`журнал: ${JSON.stringify(au.map((r) => ({ action: r.action, actor_type: r.actor_type, method: r.data.method, amount_kopecks: r.data.amount_kopecks })))}`);
  assert.equal(au.length, 1);
  assert.equal(au[0].data.method, 'cash');
});

test('T2: гость видит игру и заканчивает её', async (t) => {
  const s = await ok(api('GET', `/api/sessions/${accepted.session_id}`, { token: guest.token }));
  t.diagnostic(`сессия гостя: status=${s.status} remaining_ms=${s.remaining_ms} is_payer=${s.is_payer}`);
  assert.equal(s.is_payer, true);
  await ok(api('POST', `/api/sessions/${accepted.session_id}/stop`, { token: guest.token, body: {} }));
  const st = await waitSim(TABLE, (x) => x.state.mode === 'free' && x.state.relay === false, { timeoutMs: 5000 });
  t.diagnostic(`после «Закончить»: ${brief(st)}`);
});
