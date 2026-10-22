// Волна B M3: поток гостя (№120) — POST /api/stream/token {me:true} и GET /api/stream?me=1.
// Атаки: подмена канала одноразовым токеном (токен «me» на канал клуба/сессии и обратно),
// повторное использование, истёкший токен, чужой канал user:{id} через параметры запроса,
// смешение ?me=1 с ?club=. Без БД: обработчик маршрута вызывается с поддельным ctx.
//
// Запуск: node --test tests/security/m3/wave_b_stream.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { routes } from '../../../api/routes/stream.mjs';
import { createStreamTokens, streamTarget } from '../../../server/http/stream-tokens.mjs';

const STREAM = routes.find((r) => r.method === 'GET' && r.path === '/api/stream');
const TOKEN = routes.find((r) => r.method === 'POST' && r.path === '/api/stream/token');
const CLUB = 'c1000000-0000-4000-8000-000000000001';

/** Вызов GET /api/stream с поддельным ctx; возвращает каналы, к которым подключился бы поток. */
async function openStream({ userId, query, roles = [], club = null }) {
  let attached = null;
  const ctx = {
    user: { id: userId },
    roles,
    club,
    principal: { userId, tokenId: randomUUID() },
    pool: null,
    db: { query: async () => ({ rows: [{ ok: false }], rowCount: 0 }) },
    sse: { attach: (_res, opts) => ((attached = opts), { ok: true }) },
  };
  const out = await STREAM.handler(ctx, { query });
  await out.stream({});
  return attached;
}

test('?me=1 подключает только свой канал user:{id} — никаких чужих каналов', async () => {
  const me = randomUUID();
  const a = await openStream({ userId: me, query: { me: '1' } });
  assert.deepEqual(a.channels, [`user:${me}`]);
  assert.equal(a.only, null);
});

test('?me=1 нельзя смешать с ?club= или ?session=; me=true/0/2 — 400', async () => {
  const me = randomUUID();
  for (const query of [{ me: '1', club: CLUB }, { me: '1', session: randomUUID() }, { me: 'true' }, { me: '0' }, { me: '2' }, {}]) {
    await assert.rejects(openStream({ userId: me, query, roles: ['owner'], club: CLUB }), (e) => e.status === 400, JSON.stringify(query));
  }
});

test('гость без роли не подключится к каналу клуба (?club=) — 403', async () => {
  await assert.rejects(openStream({ userId: randomUUID(), query: { club: CLUB }, roles: [], club: CLUB }), (e) => e.status === 403);
});

test('одноразовый токен «me» не подходит к каналу клуба или сессии (подмена канала) и наоборот', () => {
  const tokens = createStreamTokens();
  const victim = { userId: randomUUID(), tokenId: randomUUID() };
  const me = tokens.issue(victim, streamTarget({ me: true }));
  assert.equal(tokens.consume(me.token, streamTarget({ club: CLUB })), null, 'me → club');
  // Токен сгорает при первой попытке, даже неудачной.
  assert.equal(tokens.consume(me.token, streamTarget({ me: '1' })), null, 'сгорел после неудачной попытки');

  const me2 = tokens.issue(victim, streamTarget({ me: true }));
  assert.equal(tokens.consume(me2.token, streamTarget({ session: randomUUID() })), null, 'me → session');

  const club = tokens.issue(victim, streamTarget({ club: CLUB }));
  assert.equal(tokens.consume(club.token, streamTarget({ me: '1' })), null, 'club → me');

  const ok = tokens.issue(victim, streamTarget({ me: true }));
  assert.deepEqual(tokens.consume(ok.token, streamTarget({ me: '1' })), victim, 'свой канал по своему токену');
  assert.equal(tokens.consume(ok.token, streamTarget({ me: '1' })), null, 'повтор — нельзя');
});

test('токен истекает через 60 с; поддельный и чужой формат не принимаются', () => {
  let t = 1_000_000;
  const tokens = createStreamTokens({ now: () => t });
  const p = { userId: randomUUID(), tokenId: randomUUID() };
  const x = tokens.issue(p, streamTarget({ me: true }));
  t += 60_001;
  assert.equal(tokens.consume(x.token, streamTarget({ me: '1' })), null, 'истёк');
  for (const bad of ['', 'x'.repeat(43), `${x.token}A`, null, 42]) assert.equal(tokens.consume(bad, streamTarget({ me: '1' })), null);
});

test('не больше 20 живых токенов на пользователя', () => {
  const tokens = createStreamTokens();
  const p = { userId: randomUUID(), tokenId: randomUUID() };
  for (let i = 0; i < 20; i += 1) assert.ok(tokens.issue(p, streamTarget({ me: true })));
  assert.equal(tokens.issue(p, streamTarget({ me: true })), null);
});

test('POST /api/stream/token: {me:true} → токен; {me:true, club} и {me:"yes"} — 400', async () => {
  const principal = { userId: randomUUID(), tokenId: randomUUID() };
  const streamTokens = createStreamTokens();
  const ok = await TOKEN.handler({ principal, streamTokens }, { body: { me: true } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.token, /^[A-Za-z0-9_-]{43}$/);
  for (const body of [{ me: true, club: CLUB }, { me: 'yes' }, { me: false }]) {
    await assert.rejects(TOKEN.handler({ principal, streamTokens }, { body }), (e) => e.status === 400, JSON.stringify(body));
  }
  // Канал определяет вошедший пользователь, а не токен: потребление возвращает только его principal.
  assert.deepEqual(streamTokens.consume(ok.json.token, streamTarget({ me: '1' })), principal);
});
