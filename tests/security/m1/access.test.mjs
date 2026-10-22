// PoC M1 — доступ и права (атакующие: гость за чужой счёт; посторонний к чужим данным).
// Живой стек, столы 7/8. Запуск: node --test tests/security/m1/access.test.mjs
//
// Доказывает:
//  * чужую сессию/платёж/заявку посторонний гость не видит (not_found) и не останавливает;
//  * «Остановить» — только плательщик (not_payer), «join» не даёт прав плательщика;
//  * штатные маршруты персонала гостю запрещены (403/401), в т. ч. через подделку X-Club-Id;
//  * котировка одноразовая (quote_used); продление чужой сессии без участия запрещено.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { req, guest, devLogin, sql, clearHolds, uuid, ORIGIN, TABLE7, TABLE8, CLUB } from './helper.mjs';

const openSessions = (r) => sql("select id from bl.sessions where resource_id = $1 and status in ('active','ending','grace','interrupted')", [r]);
async function stopAll(r, token) {
  for (const row of await openSessions(r)) await req('POST', `/api/sessions/${row.id}/stop`, { token, origin: ORIGIN, body: {} });
}

/** Оплатить и подтвердить сессию на столе, вернуть { sid, paymentId }. */
async function startSession(token, resourceId) {
  await clearHolds(resourceId);
  await stopAll(resourceId, token);
  const q = await req('POST', '/api/quotes', { token, origin: ORIGIN, body: { resource_id: resourceId, kind: 'start', minutes: 60 } });
  assert.equal(q.status, 200, `quote: ${q.text}`);
  const pay = await req('POST', `/api/quotes/${q.json.quote_id}/pay`, { token, origin: ORIGIN, idem: uuid(), body: { method: 'sbp' } });
  const provider = pay.json.confirmation.url.split('/pay/')[1];
  await req('POST', `/pay/${provider}/confirm`, { origin: null, rawContentType: 'application/x-www-form-urlencoded', body: '' });
  let ps;
  for (let i = 0; i < 20 && (!ps || ps.json.status !== 'succeeded'); i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    ps = await req('GET', `/api/payments/${pay.json.payment_id}`, { token });
  }
  assert.equal(ps.json.status, 'succeeded', 'сессия оплачена');
  return { sid: ps.json.session_id, paymentId: pay.json.payment_id, quoteId: q.json.quote_id };
}

test('посторонний гость не видит и не трогает чужую сессию/платёж', async () => {
  const payer = await guest('+79990007010');
  const stranger = await guest('+79990007011');
  const { sid, paymentId } = await startSession(payer, TABLE7);

  const getS = await req('GET', `/api/sessions/${sid}`, { token: stranger });
  assert.equal(getS.status, 404, 'чужая сессия — not_found');
  const rec = await req('GET', `/api/sessions/${sid}/receipt`, { token: stranger });
  assert.equal(rec.status, 404, 'чужой чек — not_found');
  const pay = await req('GET', `/api/payments/${paymentId}`, { token: stranger });
  assert.equal(pay.status, 404, 'чужой платёж — not_found');

  // join разрешён (любой может «играть за этим столом»), но прав плательщика не даёт.
  const join = await req('POST', `/api/sessions/${sid}/join`, { token: stranger, origin: ORIGIN, body: {} });
  assert.equal(join.status, 200, 'join открытой сессии разрешён');
  const stop = await req('POST', `/api/sessions/${sid}/stop`, { token: stranger, origin: ORIGIN, body: {} });
  assert.equal(stop.status, 403, 'остановить может только плательщик');
  assert.equal(stop.json.error, 'not_payer', 'код not_payer');

  await stopAll(TABLE7, payer);
});

test('посторонний до join вообще получает not_found на остановку', async () => {
  const payer = await guest('+79990007012');
  const stranger = await guest('+79990007013');
  const { sid } = await startSession(payer, TABLE8);
  const stop = await req('POST', `/api/sessions/${sid}/stop`, { token: stranger, origin: ORIGIN, body: {} });
  assert.equal(stop.status, 404, 'не участник — сессию даже не видит');
  await stopAll(TABLE8, payer);
});

test('штатные маршруты персонала гостю запрещены, X-Club-Id не помогает', async () => {
  const g = await guest('+79990007014');
  const cases = [
    ['POST', `/api/resources/${TABLE7}/service`, { minutes: 5, reason_code: 'cleaning', reason_text: 'x' }],
    ['POST', `/api/resources/${TABLE7}/service/stop`, {}],
    ['POST', `/api/resources/${TABLE7}/identify`, { seconds: 3 }],
    ['GET', `/api/clubs/${CLUB}/hall`, null],
    ['GET', `/api/clubs/${CLUB}/now`, null],
    ['GET', `/api/clubs/${CLUB}/audit`, null],
    ['GET', `/api/clubs/${CLUB}/audit/verify`, null],
  ];
  for (const [m, p, body] of cases) {
    const r = await req(m, p, { token: g, origin: ORIGIN, body: body ?? undefined, headers: { 'x-club-id': CLUB } });
    assert.ok(r.status === 403 || r.status === 401, `${m} ${p} → ${r.status} (ожидали 403/401)`);
  }
  // Подделка X-Club-Id случайным клубом — тоже отказ.
  const spoof = await req('GET', `/api/clubs/${uuid()}/now`, { token: g, origin: ORIGIN });
  assert.ok(spoof.status === 403 || spoof.status === 404, `спуф клуба → ${spoof.status}`);
});

test('extend-free (продление без оплаты) гостю запрещён', async () => {
  const payer = await guest('+79990007015');
  const { sid } = await startSession(payer, TABLE7);
  const r = await req('POST', `/api/sessions/${sid}/extend-free`, { token: payer, origin: ORIGIN, body: { minutes: 30, reason_text: 'free' } });
  assert.ok(r.status === 403 || r.status === 401, `гость extend-free → ${r.status}`);
  await stopAll(TABLE7, payer);
});

test('котировка одноразовая; продление чужой сессии без участия запрещено', async () => {
  const payer = await guest('+79990007016');
  const stranger = await guest('+79990007017');
  const { sid } = await startSession(payer, TABLE8);

  // Котировка на продление от постороннего (не участник) — forbidden/not_found.
  const q = await req('POST', '/api/quotes', { token: stranger, origin: ORIGIN, body: { resource_id: TABLE8, kind: 'extend', minutes: 60, session_id: sid } });
  assert.ok(q.status === 403 || q.status === 404, `чужое продление → ${q.status}`);

  // Одноразовость котировки: оплатить дважды (разные ключи) — второй раз quote_used.
  await clearHolds(TABLE7);
  await stopAll(TABLE7, payer);
  const q2 = await req('POST', '/api/quotes', { token: payer, origin: ORIGIN, body: { resource_id: TABLE7, kind: 'start', minutes: 60 } });
  const first = await req('POST', `/api/quotes/${q2.json.quote_id}/pay`, { token: payer, origin: ORIGIN, idem: uuid(), body: { method: 'sbp' } });
  assert.equal(first.status, 200, 'первая оплата');
  const second = await req('POST', `/api/quotes/${q2.json.quote_id}/pay`, { token: payer, origin: ORIGIN, idem: uuid(), body: { method: 'sbp' } });
  assert.equal(second.status, 409, 'повторная оплата той же котировки');
  assert.equal(second.json.error, 'quote_used', 'код quote_used');

  await stopAll(TABLE8, payer);
});

after(async () => {
  const { token } = await devLogin('+79990007010');
  await stopAll(TABLE7, token);
  await stopAll(TABLE8, token);
});
