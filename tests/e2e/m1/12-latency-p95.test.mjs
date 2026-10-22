// Критерий M1: от подтверждения оплаты до relay: true в симуляторе p95 < 1 с.
//
// Серия из E2E_LATENCY_N (по умолчанию 25) оплат СБП подряд на столах E2E_LATENCY_TABLES
// (по умолчанию 2,6 — по кругу): котировка 1 мин → оплата → «Оплатить» в эмуляторе → свет →
// «Закончить игру» → стол свободен. Метрики по каждой оплате:
//   * e2e — от bl.payments.confirmed_at (сервер принял и перепроверил вебхук) до строки sim_relay
//     симулятора с cmd_id этой session.start (часы одного хоста; главная метрика);
//   * light_latency — строка лога сервера (confirmed_at → ack session.start);
//   * webhook — от отметки «Оплатить» в эмуляторе (captured_at) до sim_relay (с доставкой вебхука).
// p50/p95/max печатаются; проверка: p95(e2e) < 1000 мс.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  emuPayment,
  logLines,
  newGuest,
  ok,
  percentile,
  SERVER_CONTAINER,
  SIM_CONTAINER,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const N = Number(process.env.E2E_LATENCY_N || 25);
const TABLES = (process.env.E2E_LATENCY_TABLES || '2,6').split(',').map(Number);
let db;

before(async () => {
  db = await adminClient();
  for (const n of TABLES) await waitTableFree(n);
});

after(async () => {
  await db?.end();
});

function stats(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.at(-1), min: s[0] };
}

test(`оплата → свет: ${N} оплат, p95 < 1 с`, { timeout: 15 * 60_000 }, async (t) => {
  const since = new Date(Date.now() - 1000);
  const guest = await newGuest();
  const runs = [];
  for (let i = 0; i < N; i += 1) {
    const n = TABLES[i % TABLES.length];
    await waitTableFree(n, { timeoutMs: 30_000 });
    const g = await startGame(n, 1, { guest });
    await waitSim(n, (x) => x.state.relay === true && x.state.session_id === g.sessionId, { timeoutMs: 5000, intervalMs: 50 });
    runs.push({ n, sessionId: g.sessionId, paymentId: g.payResp.payment_id, pid: g.pid });
    await ok(api('POST', `/api/sessions/${g.sessionId}/stop`, { token: guest.token, body: {} }));
    await waitSim(n, (x) => x.state.mode === 'free', { timeoutMs: 5000 });
  }
  const e2e = [];
  const lat = [];
  const hook = [];
  await waitFor(() => logLines(SERVER_CONTAINER, since, 'light_latency').filter((l) => runs.some((r) => r.sessionId === l.session_id)).length === N, { timeoutMs: 10_000, what: 'все light_latency' });
  const relays = logLines(SIM_CONTAINER, since, 'sim_relay');
  const latLines = logLines(SERVER_CONTAINER, since, 'light_latency');
  for (const r of runs) {
    const { rows } = await db.query(
      "select p.confirmed_at, c.id as cmd_id from bl.payments p join bl.device_commands c on c.session_id = p.session_id and c.type = 'session.start' where p.id = $1",
      [r.paymentId],
    );
    const relay = relays.find((l) => l.cmd_id === rows[0].cmd_id);
    assert.ok(relay, `sim_relay для оплаты ${r.paymentId}`);
    const ms = new Date(relay.t) - new Date(rows[0].confirmed_at);
    e2e.push(ms);
    lat.push(latLines.find((l) => l.session_id === r.sessionId).ms);
    const p = emuPayment(r.pid);
    if (p.captured_at) hook.push(new Date(relay.t) - new Date(p.captured_at));
  }
  const se = stats(e2e);
  const sl = stats(lat);
  const sh = stats(hook);
  t.diagnostic(`e2e confirmed_at → sim_relay, мс: ${e2e.join(' ')}`);
  t.diagnostic(`e2e: n=${se.n} min=${se.min} p50=${se.p50} p95=${se.p95} max=${se.max} мс`);
  t.diagnostic(`light_latency (сервер, до ack): n=${sl.n} p50=${sl.p50} p95=${sl.p95} max=${sl.max} мс`);
  t.diagnostic(`«Оплатить» в эмуляторе (captured_at) → sim_relay, с доставкой вебхука: n=${sh.n} p50=${sh.p50} p95=${sh.p95} max=${sh.max} мс`);
  assert.ok(se.n >= 20);
  assert.ok(se.p95 < 1000, `p95 ${se.p95} мс`);
});
