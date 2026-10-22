// PoC M1 — вебхук ЮKassa и путь «деньги → свет» (атакующий: гость, который хочет играть бесплатно).
// Главный вопрос этапа: нельзя включить свет без оплаты и без записи в журнале.
//
// Проверяется на живом стеке (npm run dev) через Caddy. Столы 7 и 8 — зона pentester.
// Запуск: node --test --test-concurrency=1 tests/security/m1/webhook.test.mjs
//
// Доказывает:
//  1. Поддельное тело вебхука (статус succeeded, заниженная/завышенная сумма, чужая metadata)
//     не создаёт сессию и не включает свет: сервер перепроверяет платёж по API ключами клуба.
//  2. Вебхук на неизвестный object.id — 200 без действий; на несуществующий клуб — 404.
//  3. После настоящего подтверждения оплаты создаётся ровно одна сессия, и у команды света
//     есть запись device.cmd в журнале (инварианты 1 и 2).
//  4. Повтор вебхука и подмена суммы в теле не добавляют ни времени, ни денег (T17).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { req, guest, devLogin, sql, clearHolds, uuid, ORIGIN, TABLE7, TABLE8, CLUB } from './helper.mjs';

const openSessions = (resourceId) =>
  sql("select id from bl.sessions where resource_id = $1 and status in ('active','ending','grace','interrupted')", [resourceId]);

async function stopAll(resourceId, token) {
  for (const row of await openSessions(resourceId)) {
    await req('POST', `/api/sessions/${row.id}/stop`, { token, origin: ORIGIN, body: {} });
  }
}

async function payPending(token, resourceId, minutes = 60) {
  const q = await req('POST', '/api/quotes', { token, origin: ORIGIN, body: { resource_id: resourceId, kind: 'start', minutes } });
  assert.equal(q.status, 200, `quote: ${q.text}`);
  const pay = await req('POST', `/api/quotes/${q.json.quote_id}/pay`, { token, origin: ORIGIN, idem: uuid(), body: { method: 'sbp' } });
  assert.equal(pay.status, 200, `pay: ${pay.text}`);
  const provider = pay.json.confirmation.url.split('/pay/')[1];
  return { quoteId: q.json.quote_id, paymentId: pay.json.payment_id, provider };
}

test('поддельный вебхук (succeeded + заниженная сумма) до оплаты не включает свет', async () => {
  const token = await guest('+79990007001');
  await clearHolds(TABLE7);
  await stopAll(TABLE7, token);
  const { quoteId, paymentId, provider } = await payPending(token, TABLE7);

  const forged = await req('POST', `/api/webhooks/yookassa/${CLUB}`, {
    origin: null,
    body: { type: 'notification', event: 'payment.succeeded', object: { id: provider, status: 'succeeded', paid: true, amount: { value: '0.01', currency: 'RUB' }, metadata: { club_id: CLUB, quote_id: quoteId } } },
  });
  assert.equal(forged.status, 200, 'вебхук принят формально');

  const ps = await req('GET', `/api/payments/${paymentId}`, { token });
  assert.equal(ps.json.status, 'pending', 'платёж остаётся pending: телу не верят');
  assert.equal(ps.json.session_id, null, 'сессия не создана');
  const open = await openSessions(TABLE7);
  assert.equal(open.length, 0, 'ни одной идущей сессии на столе 7');
});

test('вебхук с неизвестным object.id и на несуществующий клуб', async () => {
  const unknown = await req('POST', `/api/webhooks/yookassa/${CLUB}`, {
    origin: null,
    body: { type: 'notification', event: 'payment.succeeded', object: { id: 'nonexistent-object-id-123', status: 'succeeded', amount: { value: '1.00', currency: 'RUB' }, metadata: { club_id: CLUB, quote_id: uuid() } } },
  });
  assert.equal(unknown.status, 200, 'неизвестный платёж — 200 без действий');

  const otherClub = await req('POST', `/api/webhooks/yookassa/${uuid()}`, {
    origin: null,
    body: { type: 'notification', event: 'payment.succeeded', object: { id: 'x', status: 'succeeded', amount: { value: '1.00', currency: 'RUB' } } },
  });
  assert.equal(otherClub.status, 404, 'магазина у несуществующего клуба нет — 404');
});

test('настоящая оплата: одна сессия, свет в журнале; повтор и подмена суммы ничего не добавляют', async () => {
  const token = await guest('+79990008001');
  await clearHolds(TABLE8);
  await stopAll(TABLE8, token);
  const { quoteId, paymentId, provider } = await payPending(token, TABLE8);

  // Гость подтверждает оплату на странице ЮKassa (эмулятор шлёт настоящий вебхук).
  const conf = await req('POST', `/pay/${provider}/confirm`, { origin: null, rawContentType: 'application/x-www-form-urlencoded', body: '' });
  assert.equal(conf.status, 303, 'страница оплаты подтвердила платёж');

  let ps;
  for (let i = 0; i < 20 && (!ps || ps.json.status !== 'succeeded'); i += 1) {
    await new Promise((r) => setTimeout(r, 300));
    ps = await req('GET', `/api/payments/${paymentId}`, { token });
  }
  assert.equal(ps.json.status, 'succeeded', 'платёж подтверждён');
  const sid = ps.json.session_id;
  assert.ok(sid, 'сессия создана');

  // Инвариант 1 и 2: команда света записана в журнал (device.cmd) вместе с session.start.
  const audit = await sql("select action, count(*)::int n from bl.audit_log where (data->>'session_id') = $1 group by action", [sid]);
  const byAction = Object.fromEntries(audit.map((r) => [r.action, r.n]));
  assert.equal(byAction['session.start'], 1, 'ровно одна запись session.start');
  assert.ok((byAction['device.cmd'] ?? 0) >= 1, 'есть запись device.cmd — свет только с записью в журнале');

  const before = (await sql('select paid_until from bl.sessions where id = $1', [sid]))[0].paid_until;

  // Повтор и подмена суммы в теле (999 999 ₽) — сервер перепроверяет по API.
  for (let i = 0; i < 4; i += 1) {
    const w = await req('POST', `/api/webhooks/yookassa/${CLUB}`, {
      origin: null,
      body: { type: 'notification', event: 'payment.succeeded', object: { id: provider, status: 'succeeded', amount: { value: '999999.00', currency: 'RUB' }, metadata: { club_id: CLUB, quote_id: quoteId } } },
    });
    assert.equal(w.status, 200);
  }
  const sp = (await sql('select count(*)::int n, coalesce(sum(amount_kopecks),0)::bigint s from bl.session_payments where session_id = $1', [sid]))[0];
  assert.equal(sp.n, 1, 'ровно один платёж применён к сессии');
  assert.equal(String(sp.s), '50000', 'сумма платежа неизменна (50000 копеек), подмена не прошла');
  const after = (await sql('select paid_until from bl.sessions where id = $1', [sid]))[0].paid_until;
  assert.equal(new Date(after).getTime(), new Date(before).getTime(), 'paid_until не изменился после повторов');
  const active = await openSessions(TABLE8);
  assert.equal(active.length, 1, 'по-прежнему ровно одна сессия на столе 8');

  await stopAll(TABLE8, token);
});

after(async () => {
  // Подчистить идущие сессии своих столов.
  const { token } = await devLogin('+79990008001');
  await stopAll(TABLE7, token);
  await stopAll(TABLE8, token);
});
