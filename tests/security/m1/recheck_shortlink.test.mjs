// Перепроверка M1 (правки 53e69aa): GET /t/{code} → 302 /app/t/{CODE} (api/routes/owner.mjs:256).
// Вопрос оркестратора: открытое перенаправление, обход через кодировки/CRLF, Host/X-Forwarded-Host,
// кэширование. Живой стек через Caddy. Запуск: node --test tests/security/m1/recheck_shortlink.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { req, CODE7 } from './helper.mjs';

test('валидный код → 302 строго на /app/t/{CODE}, Location без хоста и схемы', async () => {
  const r = await req('GET', `/t/${CODE7}`, {});
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/app/t/${CODE7}`, 'редирект собран только из проверенного кода');
  // Ответ не кэшируется.
  assert.match(String(r.headers['cache-control'] ?? ''), /no-store|no-cache/);
});

test('нижний регистр кода нормализуется к верхнему (не отдельный ресурс)', async () => {
  const r = await req('GET', `/t/${CODE7.toLowerCase()}`, {});
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/app/t/${CODE7}`);
});

test('X-Forwarded-Host/Proto в редирект не попадают (нет открытого перенаправления)', async () => {
  const r = await req('GET', `/t/${CODE7}`, { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, `/app/t/${CODE7}`, 'Location не зависит от заголовков прокси');
  assert.ok(!String(r.headers.location).includes('evil'), 'чужой хост не просочился');
});

test('сервер (без Caddy) игнорирует Host при сборке редиректа', async () => {
  // Прямо на server:3000 (loopback): видно сырой Location до Caddy.
  const raw = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: 3000, method: 'GET', path: `/t/${CODE7}`, headers: { host: 'evil.example' }, timeout: 5000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end();
  });
  assert.equal(raw.status, 302);
  assert.equal(raw.location, `/app/t/${CODE7}`, 'сырой Location собран только из кода, Host проигнорирован');
});

test('кодировки, CRLF и обходы: никогда не редиректит на внешний адрес', async () => {
  const payloads = [
    '//evil.example', '/\\evil.example', 'https:%2f%2fevil.example',
    'ABCDEFGHIJ%0d%0aLocation:%20https://evil.example', 'ABCDEFGHIJ%2f..%2f..%2fevil',
    '@evil.example', '..%2f..%2fapp', 'ABCDEFGHI', 'ABCDEFGHIJK',
    '%2e%2e/%2e%2e/app', 'ABCDEFGHIJ%00', 'ABCDEFGHIJ ',
  ];
  for (const p of payloads) {
    const r = await req('GET', `/t/${p}`, {});
    const loc = r.headers.location;
    if (loc !== undefined) {
      // Любой редирект обязан быть относительным и на свой origin: начинается с одного '/',
      // не '//', без схемы и без чужого хоста.
      assert.match(String(loc), /^\/[^/]/, `payload ${p}: небезопасный Location ${loc}`);
      assert.ok(!/^https?:/i.test(String(loc)) && !String(loc).toLowerCase().includes('evil'), `payload ${p}: внешний редирект ${loc}`);
    } else {
      assert.ok([400, 404].includes(r.status), `payload ${p} → ${r.status}`);
    }
  }
});

test('код стола-оракула нет: невалидная форма и чужой код неотличимы по типу ответа', async () => {
  // Несуществующий, но валидный по форме код → 302 на /app (SPA сама покажет «не найдено»):
  // редирект не раскрывает, существует ли стол. А невалидная форма → 404.
  const bogus = await req('GET', '/t/ZZZZZZZZZZ', {});
  assert.equal(bogus.status, 302, 'валидная форма → 302 (без обращения к базе, db:false)');
  const bad = await req('GET', '/t/zzz', {});
  assert.equal(bad.status, 404);
});
