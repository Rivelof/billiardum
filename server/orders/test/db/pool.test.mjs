// pentester R-1 (доступность): обработчик не должен держать соединение транзакции запроса и ждать
// второе из того же пула. POST /api/pos/discount-approvals проверяет PIN своей транзакцией
// (checkStaffPin core: счётчик ошибок не откатывается с запросом) — при 2×размер пула параллельных
// одобрений пул не должен заблокироваться: другие запросы отвечают.
//
// Одобрения проверяют PIN в транзакции запроса (одно соединение пула на запрос; отказ — ответом с
// коммитом счётчика ошибок). Пул маленький (4): 2×пул параллельных одобрений укладывается в лимит
// маршрута (20 в минуту с адреса).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPin } from '../../../auth/pin.mjs';
import { ORIGIN } from '../../../test/db/helpers.mjs';
import { CLUB_A, PHONES, setup } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
// Маленький пул: лимит маршрута — 20 одобрений в минуту с адреса, 2×пул должно в него влезать.
const POOL_SIZE = 4;
let h;
let reception;
let manager;

before(async () => {
  if (SKIP) return;
  h = await setup({ poolMax: POOL_SIZE });
  reception = await h.login(PHONES.reception);
  manager = await h.login(PHONES.manager);
  const pin = await hashPin('2468', h.config.pinPepper);
  await h.q('update bl.club_members set pin_hash = $3 where club_id = $1 and user_id = $2', [CLUB_A, manager.id, pin]);
});

after(async () => {
  await h?.close();
});

/** Запрос с тайм-аутом: зависший пул — ошибка теста, а не зависший файл. */
async function timed(method, path, { token, body, ms = 5000 } = {}) {
  const headers = { authorization: `Bearer ${token}`, 'x-club-id': CLUB_A };
  if (method !== 'GET') Object.assign(headers, { 'content-type': 'application/json', origin: ORIGIN });
  const res = await fetch(`${h.base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

describe('R-1: одобрения скидки не блокируют пул', { skip: SKIP }, () => {
  it(`${2 * POOL_SIZE} параллельных одобрений (пул ${POOL_SIZE}) — другие запросы отвечают, одобрения завершаются`, async () => {
    const body = { user_id: manager.id, pin: '2468', reason_code: 'regular_guest', reason_text: 'Постоянный гость', amount_kopecks: 1000, subtotal_kopecks: 18000 };
    const approvals = Array.from({ length: 2 * POOL_SIZE }, () => timed('POST', '/api/pos/discount-approvals', { token: reception.token, body, ms: 20_000 }));
    const probe = await timed('GET', `/api/clubs/${CLUB_A}/pos/settings`, { token: reception.token });
    assert.equal(probe.status, 200, 'API отвечает, пока идут одобрения');
    const results = await Promise.all(approvals);
    assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.some((r) => r.status === 201));
  });

  it('неверный PIN — 401, счётчик ошибок закоммичен (отказ — ответом, не откатом); параллельно с ошибками пул не блокируется', async () => {
    const body = { user_id: manager.id, pin: '1111', reason_code: 'regular_guest', reason_text: 'Постоянный гость', amount_kopecks: 1000, subtotal_kopecks: 18000 };
    const bad = Array.from({ length: 3 }, () => timed('POST', '/api/pos/discount-approvals', { token: manager.token, body, ms: 20_000 }));
    const probe = await timed('GET', `/api/clubs/${CLUB_A}/pos/settings`, { token: manager.token });
    assert.equal(probe.status, 200);
    const res = await Promise.all(bad);
    assert.ok(res.every((r) => r.status === 401 && r.json?.error === 'unauthorized'), JSON.stringify(res));
    const [m] = await h.q('select pin_failed_count from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, manager.id]);
    assert.equal(m.pin_failed_count, 3);
    assert.equal((await h.q('select count(*)::int as n from bl.pos_discount_approvals where reason_text = $1 and approver_id = $2', ['Постоянный гость', manager.id]))[0].n, 2 * POOL_SIZE);
  });
});
