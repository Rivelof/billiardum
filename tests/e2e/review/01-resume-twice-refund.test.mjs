// Ревью (свет): прерывание → «Продолжить» → снова прерывание → возврат. Вернулось не больше
// неотыгранного последнего отрезка (неотыгранное считается от начала отрезка после
// «Продолжить», а не от начала сессии).
//
// Стол E2E_REVIEW_RESUME_TABLE (по умолчанию 1). Как в M1 T6: игра 2 мин, обрыв связи стола
// (симулятор net down), продление +3 мин без связи — контроллер доигрывает 2 мин + льгота,
// связь вернулась → interrupted (неотыгранное ≈ 3 мин). «Продолжить» → свет на 3 мин. Снова
// обрыв, продление +2 мин без связи → контроллер доигрывает 3 мин + льгота → interrupted
// (неотыгранное ≈ 2 мин). «Вернуть деньги» → возврат = второе продление целиком (№73: свет по
// нему контроллер не показал), первое продление не возвращается (его сыграли после «Продолжить»).
// Около 13 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  brief,
  extendGame,
  logLines,
  MIN,
  ok,
  SERVER_CONTAINER,
  sim,
  simPost,
  sleep,
  startGame,
  waitFor,
  waitSim,
  waitTableFree,
} from '../m3/helpers.mjs';

const T = Number(process.env.E2E_REVIEW_RESUME_TABLE || 1);
let db;
let down = false;

before(async () => {
  db = await adminClient();
  await waitTableFree(T);
});

after(async () => {
  if (down) await simPost(T, 'net', { up: true });
  await db?.end();
});

async function goOffline(t, deviceId) {
  const since = new Date();
  await simPost(T, 'net', { up: false });
  down = true;
  await waitFor(() => logLines(SERVER_CONTAINER, since, 'device_offline').find((l) => l.device_id === deviceId), { timeoutMs: 90_000, intervalMs: 1000, what: 'сервер видит офлайн' });
  t.diagnostic(`обрыв: сервер увидел офлайн через ${Math.round((Date.now() - since) / 1000)} с`);
}

async function playOutAndReconnect(t, guest, sessionId) {
  await waitSim(T, (y) => y.state.mode === 'free' && y.state.relay === false, { timeoutMs: 8 * MIN, intervalMs: 500, what: 'контроллер доиграл без связи' });
  await simPost(T, 'net', { up: true });
  down = false;
  return waitFor(async () => {
    const r = await api('GET', `/api/sessions/${sessionId}`, { token: guest.token });
    return r.json?.status === 'interrupted' ? r.json : null;
  }, { timeoutMs: 30_000, what: 'сессия interrupted' });
}

async function refundsOfSession(sessionId) {
  const { rows } = await db.query(
    `select r.payment_id, r.amount_kopecks, r.status from bl.refunds r join bl.payments p on p.id = r.payment_id where p.session_id = $1 order by r.created_at`,
    [sessionId],
  );
  return rows;
}

test(`прерывание → «Продолжить» → прерывание → возврат не больше неотыгранного (стол ${T})`, { timeout: 25 * MIN }, async (t) => {
  const game = await startGame(T, 2);
  const on = await waitSim(T, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 5000 });
  await sleep(5000);
  await goOffline(t, on.device_id);
  const ext1 = await extendGame(game.guest, game.tbl.resource.id, game.sessionId, 3);
  await sleep(1500);
  const i1 = await playOutAndReconnect(t, game.guest, game.sessionId);
  t.diagnostic(`1-е прерывание: неотыгранное ${Math.round(i1.remaining_ms / 1000)} с; продление 1 стоило ${ext1.q.amount_kopecks} коп.`);
  assert.ok(Math.abs(i1.remaining_ms - 3 * MIN) < 10_000, 'неотыгранное ≈ 3 мин');

  const cont = await ok(api('POST', `/api/sessions/${game.sessionId}/resolve`, { token: game.guest.token, body: { choice: 'continue' } }));
  const lit = await waitSim(T, (x) => x.state.relay === true && x.state.session_id === game.sessionId, { timeoutMs: 10_000, what: 'свет после «Продолжить»' });
  t.diagnostic(`«Продолжить»: ${cont.status}, до ${cont.paid_until}; контроллер ${brief(lit)}`);
  await sleep(5000);
  await goOffline(t, lit.device_id);
  const ext2 = await extendGame(game.guest, game.tbl.resource.id, game.sessionId, 2);
  await sleep(1500);
  const i2 = await playOutAndReconnect(t, game.guest, game.sessionId);
  t.diagnostic(`2-е прерывание: неотыгранное ${Math.round(i2.remaining_ms / 1000)} с; продление 2 стоило ${ext2.q.amount_kopecks} коп.`);
  assert.ok(Math.abs(i2.remaining_ms - 2 * MIN) < 10_000, 'неотыгранное второго отрезка ≈ 2 мин (не от начала сессии)');

  const r = await ok(api('POST', `/api/sessions/${game.sessionId}/resolve`, { token: game.guest.token, body: { choice: 'refund' } }));
  const refunds = await waitFor(async () => {
    const x = await refundsOfSession(game.sessionId);
    return x.length && x.every((y) => y.status === 'succeeded') ? x : null;
  }, { timeoutMs: 20_000, what: 'возврат succeeded' });
  const total = refunds.reduce((s, x) => s + Number(x.amount_kopecks), 0);
  const byPayment = refunds.map((x) => `${x.payment_id === ext2.payResp.payment_id ? 'продление 2' : x.payment_id === ext1.payResp.payment_id ? 'продление 1' : 'старт'}: ${x.amount_kopecks}`);
  t.diagnostic(`возврат: ${r.status}/${r.close_reason}; ${byPayment.join(', ')}; всего ${total} коп. (продление 2 = ${ext2.q.amount_kopecks}, продление 1 = ${ext1.q.amount_kopecks})`);
  assert.ok(total <= ext2.q.amount_kopecks, 'вернули не больше неотыгранного последнего отрезка');
  assert.equal(total, ext2.q.amount_kopecks, 'второе продление (не показанное контроллером) — целиком, №73');
  assert.ok(!refunds.some((x) => x.payment_id === ext1.payResp.payment_id), 'первое продление сыграно после «Продолжить» — не возвращается');
  const { rows: au } = await db.query("select data from bl.audit_log where action = 'session.resolve' and data->>'session_id' = $1 order by seq", [game.sessionId]);
  t.diagnostic(`журнал session.resolve: ${JSON.stringify(au.map((a) => ({ choice: a.data.choice, unplayed_ms: a.data.unplayed_ms, refund: a.data.refund_kopecks })))}`);
  assert.equal(au.length, 2);
  assert.equal((await sim(T)).state.relay, false);
});
