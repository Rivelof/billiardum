import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createClient, loginChoice, loginMethods, readError, readErrorCode, newIdempotencyKey, openStream } from '../api.mjs';

const json = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  f.calls = calls;
  return f;
}

test('readErrorCode: код из тела {"error"}, иначе по статусу', async () => {
  assert.equal(await readErrorCode(json(409, { error: 'table_busy' })), 'table_busy');
  assert.equal(await readErrorCode(json(401)), 'unauthorized');
  assert.equal(await readErrorCode(json(403, { message: 'x' })), 'forbidden');
  assert.equal(await readErrorCode(json(404, 'not json at all')), 'not_found');
  assert.equal(await readErrorCode(json(429)), 'rate_limited');
  assert.equal(await readErrorCode(json(502)), 'server_error');
  assert.equal(await readErrorCode(new Response('<html>', { status: 500 })), 'server_error');
  assert.equal(await readErrorCode(json(418)), 'unknown');
  // посторонний текст в поле error не становится кодом
  assert.equal(await readErrorCode(json(400, { error: '<script>alert(1)</script>' })), 'bad_request');
});

test('readError: безопасные поля рядом с кодом (booking_id), прочее отбрасывается', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(await readError(json(409, { error: 'booking_start_required', booking_id: id, phone: '+79990000000', x: { y: 1 } })), {
    code: 'booking_start_required',
    data: { booking_id: id },
  });
  assert.deepEqual(await readError(json(409, { error: 'table_busy' })), { code: 'table_busy', data: null });
  assert.deepEqual(await readError(json(500, { error: 'internal', booking_id: id })), { code: 'internal', data: null });
  const f = fakeFetch(() => json(409, { error: 'booking_start_required', booking_id: id }));
  const err = await createClient({ fetch: f }).post('/quotes/q/pay', {}).catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.data.booking_id, id);
  assert.equal(err.retryAfterSec, null);
  const g = fakeFetch(() => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429, headers: { 'retry-after': '840' } }));
  const limited = await createClient({ fetch: g }).post('/staff/pin', {}).catch((e) => e);
  assert.equal(limited.code, 'rate_limited');
  assert.equal(limited.retryAfterSec, 840);
});

test('GET: префикс /api, Accept, cookie same-origin, без Content-Type и тела', async () => {
  const f = fakeFetch(() => json(200, { ok: 1 }));
  const api = createClient({ fetch: f });
  assert.deepEqual(await api.get('/t/ABC', { query: { a: 1, b: undefined, c: '' } }), { ok: 1 });
  const { url, init } = f.calls[0];
  assert.equal(url, '/api/t/ABC?a=1');
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.body, undefined);
  assert.equal(init.headers['Content-Type'], undefined);
});

test('POST: JSON и Content-Type даже без тела, Idempotency-Key, Bearer', async () => {
  const f = fakeFetch(() => json(200, { ok: true }));
  const api = createClient({ fetch: f, token: () => 'tok' });
  await api.post('/sessions/1/stop');
  await api.post('/quotes/q/pay', { method: 'sbp' }, { idempotencyKey: 'k-1' });
  assert.equal(f.calls[0].init.body, '{}');
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(f.calls[1].init.body, '{"method":"sbp"}');
  assert.equal(f.calls[1].init.headers['Idempotency-Key'], 'k-1');
});

test('ошибки: ApiError с кодом и статусом, 401 зовёт onUnauthorized, сеть — network', async () => {
  let unauthorized = 0;
  const api = createClient({
    fetch: async (url) => (url.includes('busy') ? json(409, { error: 'table_busy' }) : json(401, { error: 'unauthorized' })),
    onUnauthorized: () => (unauthorized += 1),
  });
  await assert.rejects(api.get('/busy'), (err) => err instanceof ApiError && err.code === 'table_busy' && err.status === 409);
  await assert.rejects(api.get('/me'), (err) => err.code === 'unauthorized');
  assert.equal(unauthorized, 1);

  const offline = createClient({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.get('/me'), (err) => err.code === 'network' && err.status === 0);

  const garbage = createClient({ fetch: async () => new Response('not json', { status: 200 }) });
  await assert.rejects(garbage.get('/me'), (err) => err.code === 'server_error');
});

test('raw: ответ как есть (PDF наклеек), пустое тело — null', async () => {
  const api = createClient({ fetch: async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }) });
  const res = await api.request('GET', '/clubs/1/qr-stickers.pdf', { raw: true });
  assert.equal(await res.text(), '%PDF');
  const empty = createClient({ fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await empty.post('/x'), null);
});

test('newIdempotencyKey — UUID v4', () => {
  const a = newIdempotencyKey();
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, newIdempotencyKey());
});

test('openStream: события по именам, JSON, onOpen, переподключение после закрытия', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const made = [];
  class FakeES {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      made.push(this);
    }
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    }
    close() {
      this.readyState = 2;
    }
  }
  const events = [];
  let opened = 0;
  const states = [];
  const s = openStream('/api/stream?session=1', {
    EventSource: FakeES,
    events: ['session'],
    onEvent: (name, data) => events.push([name, data]),
    onOpen: () => (opened += 1),
    onState: (x) => states.push(x),
  });
  made[0].onopen();
  made[0].listeners.session({ data: '{"id":"1","status":"active"}' });
  made[0].listeners.session({ data: 'не json' });
  assert.deepEqual(events, [['session', { id: '1', status: 'active' }]]);
  assert.equal(opened, 1);
  made[0].readyState = 2;
  made[0].onerror();
  assert.equal(made.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(made.length, 2, 'новое соединение через 1 с');
  s.close();
  assert.equal(made[1].readyState, 2);
  assert.deepEqual(states, ['open', 'reconnecting']);
});

test('loginMethods: только известные способы входа, MAX первым; чужая форма — null', () => {
  assert.deepEqual(loginMethods({ methods: ['telegram', 'max'] }), ['max', 'telegram']);
  assert.deepEqual(loginMethods({ methods: [] }), []);
  assert.deepEqual(loginMethods({ methods: [{ id: 'telegram' }, { method: 'dev' }, 'vk'] }), ['telegram', 'dev']);
  assert.deepEqual(loginMethods(['max']), ['max']);
  assert.equal(loginMethods({ ok: true }), null);
  assert.equal(loginMethods(null), null);
});

test('loginChoice: только настроенные мессенджеры; пусто — «вход временно недоступен»', () => {
  assert.deepEqual(loginChoice(['telegram']), { channels: ['telegram'], dev: false, empty: false });
  assert.deepEqual(loginChoice([]), { channels: [], dev: false, empty: true });
  assert.equal(loginChoice(['dev']).empty, true, 'dev без сборки для разработки не показываем');
  assert.deepEqual(loginChoice(['dev'], { devBuild: true }), { channels: [], dev: true, empty: false });
  assert.deepEqual(loginChoice(null).channels, ['max', 'telegram'], 'нет ответа — как раньше');
  assert.equal(loginChoice(['telegram'], { unavailable: ['telegram'] }).empty, true);
});

test('котировка QR на столе турнира: 409 table_busy { reason, busy_until } доходит до текста «Стол занят турниром»', async () => {
  const { errorMessage } = await import('../errors.mjs');
  const f = fakeFetch(() => json(409, { error: 'table_busy', reason: 'tournament', busy_until: '2026-10-23T18:00:00Z' }));
  const err = await createClient({ fetch: f }).post('/quotes', { resource_id: 'r', kind: 'start', minutes: 60 }).catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'table_busy');
  assert.deepEqual(err.data, { busy_until: '2026-10-23T18:00:00Z', reason: 'tournament' });
  assert.equal(errorMessage(err, { audience: 'guest', busyUntil: '23:00' }).title, 'Стол занят турниром до 23:00.');
  assert.match(errorMessage(err).action, /после турнира/);
});
