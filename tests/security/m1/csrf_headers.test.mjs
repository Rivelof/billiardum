// PoC M1 — CSRF, заголовки безопасности, утечки (атакующий: посторонний).
// Живой стек через Caddy. Запуск: node --test tests/security/m1/csrf_headers.test.mjs
//
// Доказывает:
//  * изменяющий запрос с cookie без Origin и с чужим Origin — 403 (защита от CSRF);
//  * ответы несут no-store, nosniff, CSP, X-Frame-Options DENY;
//  * тело ошибки — только код, без подробностей и персональных данных.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { req, devLogin, ORIGIN } from './helper.mjs';

test('CSRF: изменяющий запрос с cookie без Origin отклоняется', async () => {
  const { token } = await devLogin('+79990007050');
  const cookie = `bl_session=${token}`;
  // Нет Origin вовсе — браузерный POST с cookie обязан его прислать; сервер требует.
  const noOrigin = await req('POST', '/api/auth/consent', { cookie, body: { version: '2026-10-21' } });
  assert.equal(noOrigin.status, 403, `cookie без Origin → ${noOrigin.status}`);
  assert.equal(noOrigin.json.error, 'forbidden');
});

test('CSRF: чужой Origin отклоняется (и с cookie, и с Bearer)', async () => {
  const { token } = await devLogin('+79990007051');
  const evil = 'https://evil.example';
  const viaCookie = await req('POST', '/api/auth/consent', { cookie: `bl_session=${token}`, origin: evil, body: { version: '2026-10-21' } });
  assert.equal(viaCookie.status, 403, 'чужой Origin с cookie → 403');
  const viaBearer = await req('POST', '/api/auth/consent', { token, origin: evil, body: { version: '2026-10-21' } });
  assert.equal(viaBearer.status, 403, 'чужой Origin даже с Bearer → 403');
});

test('свой Origin проходит', async () => {
  const { token } = await devLogin('+79990007052');
  const ok = await req('POST', '/api/auth/consent', { token, origin: ORIGIN, body: { version: '2026-10-21' } });
  assert.equal(ok.status, 200, 'свой Origin — ок');
});

test('заголовки безопасности присутствуют', async () => {
  const { token } = await devLogin('+79990007053');
  const r = await req('GET', '/api/me', { token });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['cache-control']), /no-store/, 'Cache-Control: no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff', 'X-Content-Type-Options');
  assert.equal(String(r.headers['x-frame-options']).toUpperCase(), 'DENY', 'X-Frame-Options DENY');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/, 'CSP default-src none');
});

test('тело ошибки — только код, без подробностей', async () => {
  // bad_request с внутренним detail: наружу уходит только { error }.
  const r = await req('GET', '/api/clubs/not-a-uuid/now', { });
  assert.ok([400, 401, 404].includes(r.status), `статус ${r.status}`);
  assert.deepEqual(Object.keys(r.json ?? {}), ['error'], 'ровно один ключ error');
  assert.equal(typeof r.json.error, 'string');
});
