import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { MOCK_WEBHOOK_ID } from '../src/mock/clubapi.js';
import { can } from '../src/lib/auth.js';
import { navItems } from '../src/lib/nav.js';
import {
  deliveryErrorText,
  hooksCountText,
  keyBody,
  keyFormErrors,
  keysCountText,
  lastDeliveryWords,
  webhookBody,
  webhookFormErrors,
  webhookServerError,
  webhookUrlError,
} from '../src/lib/clubapi.js';

const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const memory = () => {
  let v = null;
  return { load: () => v, save: (s) => (v = JSON.parse(JSON.stringify(s))) };
};
// Время заглушки — фиксированное (сутки клуба 24 октября 2026, 17:00 в Екатеринбурге): даты в проверках не плывут
const NOW = Date.parse('2026-10-24T12:00:00Z');
const backend = (sc) => {
  const b = createBackend(memory(), () => NOW);
  b.scenario(sc);
  return (path, method = 'GET', body) => b.handle(method, { href: `http://x${path}`, body });
};

test('форма ключа: имя, права в порядке сервера', () => {
  assert.ok(keyFormErrors({ name: ' ', scopes: ['tables:read'] }).name);
  assert.ok(keyFormErrors({ name: 'x'.repeat(101), scopes: ['tables:read'] }).name);
  assert.ok(keyFormErrors({ name: 'CRM', scopes: [] }).scopes);
  assert.deepEqual(keyFormErrors({ name: 'CRM', scopes: ['sales:read'] }), {});
  assert.deepEqual(keyBody({ name: '  CRM   клуба ', scopes: ['sales:read', 'tables:read'] }), { name: 'CRM клуба', scopes: ['tables:read', 'sales:read'] });
  assert.equal(keysCountText(2), 'Активно 2 ключа из 5');
  assert.equal(hooksCountText(1), 'Включено 1 адрес из 10');
});

test('адрес вебхука: только https:443, без логина, фрагмента, внутренних адресов', () => {
  assert.equal(webhookUrlError('https://crm.example.ru/hooks/bl'), null);
  assert.equal(webhookUrlError('https://crm.example.ru:443/x'), null);
  assert.match(webhookUrlError('http://crm.example.ru/x'), /https/);
  assert.match(webhookUrlError('https://u:p@crm.example.ru/x'), /логин/);
  assert.match(webhookUrlError('https://crm.example.ru/x#a'), /#/);
  assert.match(webhookUrlError('https://crm.example.ru:8443/x'), /443/);
  assert.ok(webhookUrlError('https://localhost/x'));
  assert.ok(webhookUrlError('https://printer.local/x'));
  assert.ok(webhookUrlError('https://192.168.1.10/x'));
  assert.ok(webhookUrlError('https://169.254.169.254/latest'));
  assert.ok(webhookUrlError('https://[::1]/x'));
  assert.ok(webhookUrlError(''));
  assert.ok(webhookFormErrors({ url: 'https://a.ru/x', events: [] }).events);
  assert.deepEqual(webhookBody({ url: ' https://a.ru/x ', events: ['booking.created', 'session.started'], description: '' }), { url: 'https://a.ru/x', events: ['session.started', 'booking.created'] });
  assert.ok(webhookServerError({ code: 'url_forbidden' }).url);
  assert.ok(webhookServerError({ code: 'url_invalid' }).url);
  assert.equal(webhookServerError({ code: 'forbidden' }), null);
});

test('доставки словами: статус, код ошибки, HTTP', () => {
  assert.equal(deliveryErrorText('http', 503), 'адрес ответил 503');
  assert.equal(deliveryErrorText('timeout'), 'адрес не ответил за 10 секунд');
  assert.equal(deliveryErrorText('net:EHOSTDOWN'), 'ошибка сети (EHOSTDOWN)');
  assert.equal(deliveryErrorText(null), null);
  assert.equal(lastDeliveryWords(null, String), 'Доставок ещё не было');
  assert.equal(lastDeliveryWords({ status: 'delivered', http_status: 200, at: 'T' }, (x) => `при ${x}`), 'Доставлено · при T · 200');
  assert.equal(lastDeliveryWords({ status: 'pending', http_status: 503, error: 'http', at: 'T' }, () => 'сейчас'), 'Ждёт попытки · сейчас · адрес ответил 503');
});

test('права: «API и вебхуки» — только владелец, в разделах владельца', () => {
  assert.equal(can.clubApi('owner'), true);
  for (const r of ['manager', 'reception', 'bar', 'installer']) assert.equal(can.clubApi(r), false, r);
  assert.ok(navItems('owner', CLUB).some((i) => i.key === 'api'));
  assert.ok(!navItems('manager', CLUB).some((i) => i.key === 'api'));
});

test('заглушка ?mock=api: ключ один раз, лимит 5, отзыв; адрес и секрет один раз, тест, выключение, журнал', async () => {
  const call = backend('api');
  const keys = `/api/clubs/${CLUB}/api-keys`;
  const list = (await call(keys)).body;
  assert.equal(list.limit, 5);
  assert.equal(list.active, 1);
  const k = await call(keys, 'POST', { name: 'Сайт', scopes: ['tables:read'] });
  assert.equal(k.status, 201);
  assert.match(k.body.key, /^blk_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify((await call(keys)).body).includes(k.body.key), 'ключ не повторяется в списке');
  for (let i = 0; i < 3; i += 1) assert.equal((await call(keys, 'POST', { name: `K${i}`, scopes: ['sales:read'] })).status, 201);
  assert.deepEqual((await call(keys, 'POST', { name: 'Шестой', scopes: ['sales:read'] })).body, { error: 'api_keys_limit' });
  const revoked = await call(`${keys}/${k.body.key_id}/revoke`, 'POST', {});
  assert.equal(revoked.body.active, false);
  assert.equal((await call(`${keys}/${k.body.key_id}/revoke`, 'POST', {})).status, 200, 'повтор — тот же ответ');

  const hooks = `/api/clubs/${CLUB}/webhooks`;
  const h = await call(hooks, 'POST', { url: 'https://hooks.example.ru/bl', events: ['session.started'] });
  assert.equal(h.status, 201);
  assert.match(h.body.secret, /^whsec_/);
  assert.ok(!JSON.stringify((await call(hooks)).body).includes(h.body.secret));
  assert.deepEqual((await call(hooks, 'POST', { url: 'http://hooks.example.ru/bl', events: ['session.started'] })).body, { error: 'url_invalid' });
  const t = await call(`${hooks}/${h.body.webhook_id}/test`, 'POST', {});
  assert.equal(t.status, 202);
  assert.equal(t.body.event, 'ping');
  const log = (await call(`${hooks}/${MOCK_WEBHOOK_ID}/deliveries`)).body;
  assert.ok(log.items.some((d) => d.status === 'failed'));
  assert.ok(log.items.every((d) => Array.isArray(d.log)));
  assert.equal((await call(`${hooks}/${MOCK_WEBHOOK_ID}/deliveries?status=delivered`)).body.items.every((d) => d.status === 'delivered'), true);
  const off = await call(`${hooks}/${MOCK_WEBHOOK_ID}/disable`, 'POST', {});
  assert.equal(off.body.active, false);
  assert.deepEqual((await call(`${hooks}/${MOCK_WEBHOOK_ID}/test`, 'POST', {})).body, { error: 'webhook_disabled' });
  assert.ok((await call(`${hooks}/${MOCK_WEBHOOK_ID}/deliveries?status=pending`)).body.items.length === 0, 'ждущие доставки отменены');
});

test('заглушка ?mock=api-pin: вход по PIN — выпуск и регистрация 403; управляющий и ресепшн — 403', async () => {
  const pin = backend('api-pin');
  assert.equal((await pin('/api/me')).body.session.kind, 'pin');
  assert.equal((await pin(`/api/clubs/${CLUB}/api-keys`, 'POST', { name: 'X', scopes: ['tables:read'] })).status, 403);
  assert.equal((await pin(`/api/clubs/${CLUB}/webhooks`, 'POST', { url: 'https://a.example.ru/x', events: ['session.started'] })).status, 403);
  assert.equal((await pin(`/api/clubs/${CLUB}/api-keys`)).status, 200, 'смотреть можно');
  for (const sc of ['manager', 'reception']) {
    const call = backend(sc);
    assert.equal((await call(`/api/clubs/${CLUB}/api-keys`)).status, 403, sc);
    assert.equal((await call(`/api/clubs/${CLUB}/webhooks`)).status, 403, sc);
  }
});
