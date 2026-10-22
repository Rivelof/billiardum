import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createClient, readErrorCode, newIdempotencyKey, openStream } from '../api.mjs';

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
