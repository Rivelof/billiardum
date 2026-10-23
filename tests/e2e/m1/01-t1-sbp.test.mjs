// T1. Гость сканирует QR, платит 2 часа по СБП → свет < 1 с после вебхука, таймер 2:00:00, чек.
//
// Скан QR: ссылка с наклейки https://{PUBLIC_HOST}/t/{код} → 302 на /app/t/{код} (№72); кривой код
// и попытки открытого перенаправления → 404, Location только на свой /app/t/{код}.
// Дальше только API гостя: /api/t/{code} → котировка 120 мин → оплата sbp → «Оплатить» в эмуляторе
// ЮKassa (вебхук на сервер) → симулятор: relay true. Время до света — от payments.confirmed_at
// (сервер принял вебхук) до строки sim_relay симулятора с cmd_id команды session.start
// (часы одного хоста), плюс light_latency сервера (confirmed_at → ack).
// Чек: receipt сессии (receipt_status succeeded) и чек в эмуляторе (позиции = сумма, full_payment,
// service). В конце плательщик нажимает «Закончить игру» — стол свободен, свет погас.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  brief,
  emuPayment,
  fmtMs,
  logLines,
  ok,
  SERVER_CONTAINER,
  session,
  sim,
  SIM_CONTAINER,
  startGame,
  tableCode,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const TABLE = Number(process.env.E2E_T1_TABLE || 1);
let db;
let game;

before(async () => {
  db = await adminClient();
  await waitTableFree(TABLE);
});

after(async () => {
  await db?.end();
});

test(`T1: скан QR — /t/{код} → 302 /app/t/{код}; кривой код и открытое перенаправление → 404`, async (t) => {
  const code = tableCode(TABLE);
  const r = await api('GET', `/t/${code}`, { headers: { accept: 'text/html' } });
  t.diagnostic(`GET /t/${code} → HTTP ${r.status} Location: ${r.headers.location}`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/app/t/${code}`);
  const app = await api('GET', r.headers.location, { headers: { accept: 'text/html' } });
  t.diagnostic(`GET ${r.headers.location} → HTTP ${app.status} ${app.headers['content-type']}`);
  assert.equal(app.status, 200);
  assert.match(app.headers['content-type'], /text\/html/);
  const lower = await api('GET', `/t/${code.toLowerCase()}`);
  t.diagnostic(`строчными /t/${code.toLowerCase()} → ${lower.status} ${lower.headers.location}`);
  assert.equal(lower.headers.location, `/app/t/${code}`);

  const bad = [
    '/t/AAA', // короче 10
    '/t/TEST0000011', // длиннее 10
    '/t/TESTI00001', // I вне Crockford Base32
    '/t/BADCODE%21%21%21', // недопустимые символы
    '/t/%2F%2Fevil.example.com',
    '/t//evil.example.com',
    '/t/https:%2F%2Fevil.example.com',
    '/t/%5Cevil.example.com',
    '/t/evil.example.com',
    `/t/${code}%0d%0aLocation:%20https://evil.example.com`,
    `/t/${code}/..%2F..%2Fevil`,
  ];
  for (const p of bad) {
    const x = await api('GET', p);
    t.diagnostic(`${p} → HTTP ${x.status}${x.headers.location ? ` Location: ${x.headers.location}` : ''} ${x.text.slice(0, 40)}`);
    assert.equal(x.status, 404, p);
    assert.equal(x.headers.location, undefined, p);
  }
  // Параметры запроса и чужой Host в адрес перенаправления не попадают.
  const q = await api('GET', `/t/${code}?next=https://evil.example.com&url=//evil.example.com`, { headers: { 'x-forwarded-host': 'evil.example.com' } });
  t.diagnostic(`с ?next=…&url=… и X-Forwarded-Host → HTTP ${q.status} Location: ${q.headers.location}`);
  assert.equal(q.headers.location, `/app/t/${code}`);
});

test(`T1: стол ${TABLE}, 2 часа по СБП → свет, таймер 2:00:00`, async (t) => {
  const since = new Date(Date.now() - 1000);
  game = await startGame(TABLE, 120);
  t.diagnostic(`котировка: ${game.q.minutes} мин, ${game.q.amount_kopecks} коп.; платёж ${game.payResp.payment_id} → сессия ${game.sessionId}`);
  assert.equal(game.q.minutes, 120);
  assert.equal(game.payResp.status, 'pending');

  const st = await waitSim(TABLE, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000, intervalMs: 50 });
  t.diagnostic(`симулятор: ${brief(st)}`);

  // Время до света: confirmed_at (база) → sim_relay (лог симулятора).
  const { rows: pr } = await db.query('select confirmed_at, status, method from bl.payments where id = $1', [game.payResp.payment_id]);
  const { rows: cr } = await db.query("select id from bl.device_commands where session_id = $1 and type = 'session.start' order by created_at limit 1", [game.sessionId]);
  assert.equal(pr[0].status, 'succeeded');
  assert.equal(pr[0].method, 'sbp');
  const relay = await waitFor(() => logLines(SIM_CONTAINER, since, 'sim_relay').find((l) => l.cmd_id === cr[0].id), { timeoutMs: 5000, what: 'sim_relay' });
  const lat = await waitFor(() => logLines(SERVER_CONTAINER, since, 'light_latency').find((l) => l.session_id === game.sessionId), { timeoutMs: 5000, what: 'light_latency' });
  const e2e = new Date(relay.t).getTime() - new Date(pr[0].confirmed_at).getTime();
  t.diagnostic(`confirmed_at ${new Date(pr[0].confirmed_at).toISOString()} → sim_relay ${relay.t}: ${e2e} мс; light_latency сервера ${lat.ms} мс; ms_since_cmd ${relay.ms_since_cmd}`);
  assert.ok(e2e >= 0 && e2e < 1000, `свет через ${e2e} мс после подтверждения оплаты`);

  // Таймер 2:00:00: остаток в API и в контроллере.
  const s = await session(game.guest.token, game.sessionId);
  const simNow = await sim(TABLE);
  t.diagnostic(`сессия: status=${s.status} remaining_ms=${s.remaining_ms} (${fmtMs(s.remaining_ms)}), paid_until=${s.paid_until}; контроллер remaining_ms=${simNow.state.remaining_ms} (${fmtMs(simNow.state.remaining_ms)})`);
  assert.equal(s.status, 'active');
  assert.equal(s.is_payer, true);
  assert.equal(new Date(s.paid_until) - new Date(s.started_at), 120 * 60_000);
  // Таймер на старте — 2:00:00: остаток, приведённый к моменту старта (чтение идёт через
  // секунду-другую после света — ожидание логов), ровно 2 часа.
  const atStart = s.remaining_ms + (Date.now() - new Date(s.started_at).getTime());
  assert.equal(fmtMs(Math.min(atStart, 120 * 60_000)), '2:00:00');
  assert.ok(s.remaining_ms > 120 * 60_000 - 5000 && s.remaining_ms <= 120 * 60_000, `остаток ${s.remaining_ms} мс`);
  assert.ok(Math.abs(simNow.state.remaining_ms - s.remaining_ms) < 3000, 'остаток контроллера ≈ остатку сервера');
  assert.equal(simNow.state.mode, 'active');
  assert.equal(simNow.state.led, 'off');

  // Журнал: платёж, сессия, команда.
  const { rows: au } = await db.query(
    `select action from bl.audit_log where club_id = $1 and created_at >= $2 and (data->>'payment_id' = $3 or data->>'session_id' = $4) order by seq`,
    [s.club.id, since, game.payResp.payment_id, game.sessionId],
  );
  const actions = au.map((r) => r.action);
  t.diagnostic(`журнал: ${actions.join(', ')}`);
  for (const a of ['payment.succeeded', 'session.start', 'device.cmd']) assert.ok(actions.includes(a), `в журнале есть ${a}`);
});

test('T1: чек — в сессии и в ЮKassa (эмулятор), 54-ФЗ', async (t) => {
  assert.ok(game, 'T1 не стартовал');
  const r = await waitFor(
    async () => {
      const x = await api('GET', `/api/sessions/${game.sessionId}/receipt`, { token: game.guest.token });
      return x.status === 200 && x.json.receipt_status === 'succeeded' ? x.json : null;
    },
    { timeoutMs: 10_000, what: 'receipt_status succeeded' },
  );
  t.diagnostic(`чек сессии: ${JSON.stringify({ lines: r.lines, total_kopecks: r.total_kopecks, receipt_status: r.receipt_status, payments: r.payments.map((p) => ({ method: p.method, amount_kopecks: p.amount_kopecks, receipt_status: p.receipt_status })) })}`);
  assert.equal(r.total_kopecks, game.q.amount_kopecks);
  assert.equal(r.payments.length, 1);
  assert.equal(r.payments[0].method, 'sbp');

  const p = emuPayment(game.pid);
  const items = p.receipt?.items ?? [];
  const sum = items.reduce((a, i) => a + Math.round(Number(i.amount.value) * 100) * Number(i.quantity), 0);
  t.diagnostic(
    `эмулятор: status=${p.status} amount=${p.amount.value} ${p.amount.currency} receipt_registration=${p.receipt_registration}; позиции: ${JSON.stringify(items.map((i) => ({ d: i.description, q: i.quantity, a: i.amount.value, vat: i.vat_code, mode: i.payment_mode, subj: i.payment_subject })))}; покупатель: ${p.receipt?.customer?.phone ? 'телефон есть' : 'нет'}`,
  );
  assert.equal(p.status, 'succeeded');
  assert.equal(Math.round(Number(p.amount.value) * 100), game.q.amount_kopecks);
  assert.equal(sum, game.q.amount_kopecks, 'сумма позиций чека = сумме платежа');
  assert.ok(items.every((i) => i.payment_mode === 'full_payment' && i.payment_subject === 'service'), 'full_payment, service (№52)');
  assert.ok(p.receipt?.customer?.phone || p.receipt?.customer?.email, 'покупатель в чеке');

  const { rows } = await db.query('select kind, channel, status, amount_kopecks from bl.receipts where payment_id = $1', [game.payResp.payment_id]);
  t.diagnostic(`bl.receipts: ${JSON.stringify(rows)}`);
  assert.ok(rows.some((x) => x.channel === 'yookassa' && Number(x.amount_kopecks) === game.q.amount_kopecks), 'чек ЮKassa в bl.receipts');
});

test('T1: «Закончить игру» плательщиком гасит свет, стол свободен', async (t) => {
  assert.ok(game, 'T1 не стартовал');
  const s = await ok(api('POST', `/api/sessions/${game.sessionId}/stop`, { token: game.guest.token, body: {} }));
  const st = await waitSim(TABLE, (x) => x.state.relay === false && x.state.mode === 'free', { timeoutMs: 5000 });
  t.diagnostic(`stop → ${s.status} (${s.close_reason}); симулятор: ${brief(st)}`);
  assert.ok(['closed', 'stopped'].includes(s.status) || s.close_reason, 'сессия закрыта');
});
