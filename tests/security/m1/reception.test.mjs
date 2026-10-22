// PoC M1 — ресепшн и сервисный свет (атакующий: ресепшн, который хочет взять наличку мимо кассы).
// Живой стек, столы 7/8. Ресепшн тестового клуба — +70000000004. Запуск:
//   node --test tests/security/m1/reception.test.mjs
//
// Доказывает:
//  * приём заявки всегда создаёт платёж, задание на чек ККТ (54-ФЗ) и запись reception.accept —
//    взять наличные «мимо кассы» и без чека нельзя; повторный приём — quote_used;
//  * отклонение требует кода причины; приём после включения света не продлевается повторно;
//  * сервисный свет — ручное действие: без причины нельзя, минуты ограничены, запись service.start
//    и уведомление владельцу (manual) при каждом включении; свет только с записью в журнале.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { req, guest, devLogin, sql, clearHolds, resetTable, uuid, ORIGIN, TABLE7, TABLE8, CLUB } from './helper.mjs';

const openSessions = (r) => sql("select id from bl.sessions where resource_id = $1 and status in ('active','ending','grace','interrupted')", [r]);
async function stopAll(r) {
  await resetTable(r);
}

async function receptionToken() {
  const { token } = await devLogin('+70000000004');
  return token;
}

/** Гость создаёт заявку «Оплачу на ресепшене» на столе, вернуть reception_request_id. */
async function makeRequest(resourceId) {
  await clearHolds(resourceId);
  await stopAll(resourceId);
  const g = await guest('+79990009010');
  const q = await req('POST', '/api/quotes', { token: g, origin: ORIGIN, body: { resource_id: resourceId, kind: 'start', minutes: 60 } });
  assert.equal(q.status, 200, `quote: ${q.text}`);
  const pay = await req('POST', `/api/quotes/${q.json.quote_id}/pay`, { token: g, origin: ORIGIN, idem: uuid(), body: { method: 'reception' } });
  assert.equal(pay.status, 200, `pay reception: ${pay.text}`);
  return pay.json.reception_request_id;
}

test('приём заявки создаёт платёж, чек ККТ и запись reception.accept; повтор — quote_used', async () => {
  const reqId = await makeRequest(TABLE7);
  const staff = await receptionToken();
  const acc = await req('POST', `/api/reception/requests/${reqId}/accept`, { token: staff, origin: ORIGIN, idem: uuid(), body: { method: 'cash', received_kopecks: 60000 } });
  assert.equal(acc.status, 200, `accept: ${acc.text}`);
  assert.ok(acc.json.payment_id, 'создан платёж');
  assert.equal(acc.json.change_kopecks, 10000, 'сдача 100 ₽ (получено 600, сумма 500)');

  // Чек 54-ФЗ (ККТ) создан как задание — наличные не минуют кассу.
  const receipts = await sql("select channel, status from bl.receipts where payment_id = $1", [acc.json.payment_id]);
  assert.ok(receipts.some((x) => x.channel === 'kkt'), 'есть задание на чек ККТ');
  // Запись reception.accept в журнал.
  const audit = await sql("select count(*)::int n from bl.audit_log where action = 'reception.accept' and object_id = $1", [reqId]);
  assert.equal(audit[0].n, 1, 'ровно одна запись reception.accept');

  // Повторный приём той же заявки (новый ключ идемпотентности) — отказ.
  const again = await req('POST', `/api/reception/requests/${reqId}/accept`, { token: staff, origin: ORIGIN, idem: uuid(), body: { method: 'cash', received_kopecks: 60000 } });
  assert.equal(again.status, 409, 'повторный приём отклонён');
  assert.equal(again.json.error, 'quote_used');

  await stopAll(TABLE7);
});

test('отклонение заявки требует кода причины', async () => {
  const reqId = await makeRequest(TABLE8);
  const staff = await receptionToken();
  const noReason = await req('POST', `/api/reception/requests/${reqId}/decline`, { token: staff, origin: ORIGIN, body: {} });
  assert.equal(noReason.status, 400, 'без причины нельзя');
  assert.equal(noReason.json.error, 'reason_required');
  const bad = await req('POST', `/api/reception/requests/${reqId}/decline`, { token: staff, origin: ORIGIN, body: { reason_code: 'whatever' } });
  assert.equal(bad.json.error, 'bad_request', 'произвольный код отклонён');
  const ok = await req('POST', `/api/reception/requests/${reqId}/decline`, { token: staff, origin: ORIGIN, body: { reason_code: 'guest_left' } });
  assert.equal(ok.status, 200, 'с кодом причины — ок');
  await stopAll(TABLE8);
});

test('сервисный свет: без причины нельзя, минуты ограничены, запись и уведомление владельцу', async () => {
  const staff = await receptionToken();
  await clearHolds(TABLE7);
  await stopAll(TABLE7);

  // Без reason_text — reason_required.
  const noReason = await req('POST', `/api/resources/${TABLE7}/service`, { token: staff, origin: ORIGIN, body: { minutes: 5, reason_code: 'cleaning' } });
  assert.equal(noReason.json.error, 'reason_required', 'без причины нельзя');

  // Свыше предела (service_max_minutes = 30) — limit_exceeded.
  const tooLong = await req('POST', `/api/resources/${TABLE7}/service`, { token: staff, origin: ORIGIN, body: { minutes: 999, reason_code: 'cleaning', reason_text: 'долго' } });
  assert.equal(tooLong.json.error, 'limit_exceeded', 'минуты ограничены');

  const before = (await sql("select count(*)::int n from bl.audit_log where action = 'service.start' and object_id = $1", [TABLE7]))[0].n;
  const beforeNotif = (await sql("select coalesce(sum(count),0)::int c from bl.alarms where club_id = $1 and type = 'service_light'", [CLUB]))[0].c;

  const ok = await req('POST', `/api/resources/${TABLE7}/service`, { token: staff, origin: ORIGIN, body: { minutes: 5, reason_code: 'cleaning', reason_text: 'уборка стола' } });
  assert.equal(ok.status, 200, `service: ${ok.text}`);

  const after = (await sql("select count(*)::int n from bl.audit_log where action = 'service.start' and object_id = $1", [TABLE7]))[0].n;
  assert.equal(after, before + 1, 'каждое включение сервисного света пишется в журнал (service.start)');
  // Ручное действие уведомляет владельца (тревога service_light, decisions №66, инвариант 8).
  const afterNotif = (await sql("select coalesce(sum(count),0)::int c from bl.alarms where club_id = $1 and type = 'service_light'", [CLUB]))[0].c;
  assert.ok(afterNotif > beforeNotif, 'владелец уведомлён о сервисном свете (тревога service_light)');

  await req('POST', `/api/resources/${TABLE7}/service/stop`, { token: staff, origin: ORIGIN, body: {} });
});

after(async () => {
  await stopAll(TABLE7);
  await stopAll(TABLE8);
  const staff = await receptionToken();
  await req('POST', `/api/resources/${TABLE7}/service/stop`, { token: staff, origin: ORIGIN, body: {} });
  await req('POST', `/api/resources/${TABLE8}/service/stop`, { token: staff, origin: ORIGIN, body: {} });
});
