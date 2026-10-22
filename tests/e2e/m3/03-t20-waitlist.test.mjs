// T20. Стол освободился, есть очередь из двух (decisions №109; PRODUCT §3, §6).
//
// Стол E2E_T20_TABLE (по умолчанию 5), свободный стол для отказа — E2E_T20_FREE_TABLE (6).
// 1. Гость A играет; B и C встают в очередь (позиции 1 и 2), повтор B — та же запись; очередь на
//    свободный стол — 409 table_free.
// 2. A заканчивает игру → B получает предложение на 5 минут: статус offered, offer_until = +5 мин,
//    уведомление waitlist.offer с действием «Занять стол», событие SSE waitlist в своём канале
//    (?me=1). C ждёт.
// 3. B не отвечает → через 5 минут запись B expired (no_answer), предложение уходит C; B
//    принять уже не может (409 offer_expired).
// 4. C принимает → стол удержан за C (pending, белый в симуляторе, hold_until = +3 мин); чужая
//    котировка — 409 table_pending; C платит обычной котировкой — свет. Команды стола — в журнале.
// Длится около 7 минут.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  cmdsWithAudit,
  hhmm,
  MIN,
  newGuest,
  notificationsOf,
  ok,
  pay,
  providerId,
  emuSucceed,
  quote,
  RES,
  sim,
  sse,
  startGame,
  tableCode,
  waitFor,
  waitPaymentSession,
  waitSim,
  waitTableFree,
} from './helpers.mjs';

const T = Number(process.env.E2E_T20_TABLE || 5);
const FREE = Number(process.env.E2E_T20_FREE_TABLE || 6);
let db;
const streams = [];

before(async () => {
  db = await adminClient();
  // Хвост прошлого прогона: живые записи очереди стола закрываются (их гостей тест не знает).
  const { rowCount } = await db.query(
    "update bl.waitlist set status = 'canceled', closed_at = now(), close_reason = 'guest', updated_at = now() where resource_id = $1 and status in ('waiting', 'offered')",
    [RES(T)],
  );
  if (rowCount) console.log(`закрыто записей очереди прошлого прогона: ${rowCount}`);
  await waitTableFree(T);
});

after(async () => {
  for (const s of streams) s.close();
  await db?.end();
});

async function mine(token, id) {
  const list = await ok(api('GET', '/api/me/waitlist', { token }));
  return list.find((w) => w.id === id) ?? null;
}

test(`T20: очередь из двух — предложение первому на 5 минут, затем второму; принятие держит стол (стол ${T})`, { timeout: 15 * MIN }, async (t) => {
  const since = new Date(Date.now() - 1000);
  const A = await startGame(T, 5);
  await waitSim(T, (s) => s.state.relay === true, { timeoutMs: 5000 });
  const B = await newGuest();
  const C = await newGuest();
  const D = await newGuest();
  const sB = sse('me=1', B.token);
  const sC = sse('me=1', C.token);
  streams.push(sB, sC);
  t.diagnostic(`SSE ?me=1: B ${JSON.stringify(await sB.ready)}, C ${JSON.stringify(await sC.ready)}`);

  const wB = await api('POST', '/api/waitlist', { token: B.token, body: { resource_id: RES(T) } });
  const wC = await api('POST', '/api/waitlist', { token: C.token, body: { resource_id: RES(T) } });
  const wB2 = await api('POST', '/api/waitlist', { token: B.token, body: { resource_id: RES(T) } });
  t.diagnostic(`очередь: B ${wB.status} поз. ${wB.json?.position}, C ${wC.status} поз. ${wC.json?.position}, повтор B ${wB2.status} ${wB2.json?.id === wB.json?.id ? 'та же запись' : 'другая запись'}`);
  assert.equal(wB.status, 201, wB.text);
  assert.equal(wC.status, 201, wC.text);
  assert.equal(wB.json.position, 1);
  assert.equal(wC.json.position, 2);
  assert.equal(wB2.json.id, wB.json.id);
  await waitTableFree(FREE, { timeoutMs: 60_000 }).catch(() => null);
  const wFree = await api('POST', '/api/waitlist', { token: D.token, body: { resource_id: RES(FREE) } });
  t.diagnostic(`очередь на свободный стол ${FREE}: ${wFree.status} ${wFree.text}`);
  assert.equal(wFree.status, 409);
  assert.equal(wFree.json.error, 'table_free');

  // 2. Стол освободился.
  const tStop = Date.now();
  await ok(api('POST', `/api/sessions/${A.sessionId}/stop`, { token: A.guest.token }));
  const offB = await waitFor(async () => {
    const w = await mine(B.token, wB.json.id);
    return w?.status === 'offered' ? w : null;
  }, { timeoutMs: 20_000, intervalMs: 300, what: 'предложение B' });
  const tOffer = Date.now();
  const offerMs = new Date(offB.offer_until).getTime() - tStop;
  t.diagnostic(`предложение B через ${tOffer - tStop} мс после конца игры, до ${hhmm(offB.offer_until)} (${Math.round(offerMs / 1000)} с от конца игры)`);
  assert.ok(Math.abs(offerMs - 5 * MIN) < 20_000, 'предложение на 5 минут');
  const cWait = await mine(C.token, wC.json.id);
  assert.equal(cWait.status, 'waiting');
  const evB = await sB.waitEvent((e) => e.event === 'waitlist' && (e.data?.type === 'waitlist.offered' || e.data?.status === 'offered'), { timeoutMs: 10_000, what: 'SSE waitlist offered у B' });
  t.diagnostic(`SSE B: ${evB.event} ${JSON.stringify(evB.data).slice(0, 160)}`);
  const nB = await waitFor(async () => (await notificationsOf(db, B.user.id, { kind: 'waitlist.offer' }))[0] ?? null, { timeoutMs: 10_000, what: 'уведомление B' });
  t.diagnostic(`уведомление B: «${nB.text}», действия ${JSON.stringify(nB.actions)}, статус ${nB.status}`);
  assert.ok(nB.actions.some((a) => a.id === 'accept' && a.url === `/app/waitlist/${wB.json.id}`));
  const tblOffer = await ok(api('GET', `/api/t/${tableCode(T)}`));
  t.diagnostic(`стол во время предложения B: ${tblOffer.status} (наблюдение: предложение стол не держит — принятие держит)`);

  // 3. B молчит 5 минут.
  const offC = await waitFor(async () => {
    const w = await mine(C.token, wC.json.id);
    return w?.status === 'offered' ? w : null;
  }, { timeoutMs: 6 * MIN, intervalMs: 1000, what: 'предложение C' });
  const tC = Date.now();
  const bAfter = await mine(B.token, wB.json.id);
  const { rows: bRow } = await db.query('select status, close_reason, offer_until from bl.waitlist where id = $1', [wB.json.id]);
  t.diagnostic(`через ${Math.round((tC - tOffer) / 1000)} с: B ${bRow[0].status}/${bRow[0].close_reason}, C ${offC.status} до ${hhmm(offC.offer_until)}`);
  assert.equal(bRow[0].status, 'expired');
  assert.equal(bRow[0].close_reason, 'no_answer');
  assert.ok(tC - tOffer >= 5 * MIN - 15_000, 'B держал предложение 5 минут');
  assert.ok(tC - tOffer <= 5 * MIN + 30_000, 'C получил предложение сразу после');
  assert.ok(!bAfter || bAfter.status !== 'offered');
  const lateB = await api('POST', `/api/waitlist/${wB.json.id}/accept`, { token: B.token });
  t.diagnostic(`B принимает после срока: ${lateB.status} ${lateB.text}`);
  assert.equal(lateB.status, 409);
  assert.equal(lateB.json.error, 'offer_expired');
  await sC.waitEvent((e) => e.event === 'waitlist' && (e.data?.type === 'waitlist.offered' || e.data?.status === 'offered'), { timeoutMs: 10_000, what: 'SSE waitlist offered у C' });

  // 4. C принимает.
  const acc = await ok(api('POST', `/api/waitlist/${wC.json.id}/accept`, { token: C.token }));
  const holdMs = new Date(acc.hold_until).getTime() - Date.now();
  const tbl = await ok(api('GET', `/api/t/${tableCode(T)}`));
  const pend = await waitSim(T, (s) => s.state.mode === 'pending', { timeoutMs: 10_000, what: 'стол удержан (pending)' });
  t.diagnostic(`C принял: ${acc.status}, удержание до ${hhmm(acc.hold_until)} (~${Math.round(holdMs / 1000)} с); стол ${tbl.status}; контроллер ${pend.state.mode}/${pend.state.led}`);
  assert.equal(acc.status, 'accepted');
  assert.ok(holdMs > 2.5 * MIN && holdMs <= 3 * MIN + 2000);
  assert.equal(tbl.status, 'pending');
  const qD = await quote(D.token, { resourceId: RES(T), minutes: 5 });
  t.diagnostic(`чужая котировка на удержанный стол: ${qD.status} ${qD.text}`);
  assert.equal(qD.status, 409);
  assert.equal(qD.json.error, 'table_pending');
  const qC = await ok(quote(C.token, { resourceId: RES(T), minutes: 2 }));
  const payC = await ok(pay(C.token, qC.quote_id));
  emuSucceed(providerId(payC));
  const pC = await waitPaymentSession(C.token, payC.payment_id);
  const on = await waitSim(T, (s) => s.state.relay === true && s.state.session_id === pC.session_id, { timeoutMs: 10_000, what: 'свет у C' });
  t.diagnostic(`C оплатил: сессия ${pC.session_id.slice(0, 8)}, контроллер ${on.state.mode}, свет ${on.state.relay}`);
  const { rows: cRow } = await db.query('select status from bl.waitlist where id = $1', [wC.json.id]);
  assert.equal(cRow[0].status, 'accepted');

  await ok(api('POST', `/api/sessions/${pC.session_id}/stop`, { token: C.token }));
  await waitSim(T, (s) => s.state.mode === 'free', { timeoutMs: 10_000 });
  const { cmds, missing } = await cmdsWithAudit(db, T, since);
  t.diagnostic(`команды стола: ${cmds.map((c) => `${c.type}:${c.status}`).join(', ')}; без журнала ${missing.length}`);
  assert.deepEqual(missing, []);
  assert.ok(cmds.some((c) => c.type === 'state.pending'));
  const s = await sim(T);
  assert.equal(s.state.mode, 'free');
});
