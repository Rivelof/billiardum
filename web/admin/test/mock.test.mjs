import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

test('заглушка ресепшена: заявки, приём наличных со сдачей, отклонение с причиной', async () => {
  const b = createBackend(memory());
  const list = (await req(b, 'GET', '/api/clubs/c/reception/requests')).body;
  assert.equal(list.length, 2);
  for (const k of ['id', 'resource_number', 'minutes', 'amount_kopecks', 'created_at', 'guest_masked_phone']) assert.ok(k in list[0], k);
  const r = list[1];
  const acc = await req(b, 'POST', `/api/reception/requests/${r.id}/accept`, { method: 'cash', received_kopecks: 200000 });
  assert.equal(acc.body.change_kopecks, 40000);
  assert.ok(acc.body.session_id && acc.body.payment_id);
  assert.equal((await req(b, 'POST', `/api/reception/requests/${list[0].id}/decline`, {})).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', `/api/reception/requests/${list[0].id}/decline`, { reason_code: 'guest_left' })).body.ok, true);
});

test('заглушка: сервисный свет без причины — reason_required, журнал и проверка цепочки владельцем', async () => {
  const b = createBackend(memory());
  const hall = (await req(b, 'GET', '/api/clubs/c/hall')).body;
  const free = hall.find((x) => x.status === 'free');
  assert.equal((await req(b, 'POST', `/api/resources/${free.resource.id}/service`, { minutes: 15, reason_code: 'cleaning' })).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', `/api/resources/${free.resource.id}/service`, { minutes: 15, reason_code: 'cleaning', reason_text: 'Уборка' })).body.ok, true);
  const audit = (await req(b, 'GET', '/api/clubs/c/audit?action=service.*')).body;
  assert.equal(audit.items[0].action, 'service.start');
  assert.equal(audit.items[0].reason, 'Уборка');
  assert.equal((await req(b, 'GET', '/api/clubs/c/audit/verify')).body.error, 'forbidden', 'проверка цепочки — только владелец');
  b.scenario('owner');
  assert.equal((await req(b, 'GET', '/api/clubs/c/audit/verify')).body.ok, true);
});
