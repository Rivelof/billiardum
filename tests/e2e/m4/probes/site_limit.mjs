// Проба из отдельного контейнера (свой IP): сайт через Caddy — 125 разных несуществующих адресов
// клуба за минуту → после 120 некэшированных — 429 с Retry-After; кэшированные страницы с того же
// IP открываются. Запуск — tests/e2e/m4/12-security-live.test.mjs (docker run … node /probe/site_limit.mjs).
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const ca = readFileSync('/ca/root.crt');
function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'caddy', port: 443, servername: 'localhost', path, method: 'GET', ca, headers: { host: 'localhost', accept: 'text/html' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, retry: res.headers['retry-after'] ?? null }));
    });
    req.on('error', reject);
    req.end();
  });
}
// Прогрев: кэшированные страницы (сайт кэширует ответы API 60 с и готовый HTML).
const warm = [];
for (const p of ['/', '/ekaterinburg/', '/ekaterinburg/testovyy-klub/']) warm.push((await get(p)).status);
const codes = [];
let firstLimited = null;
let retry = null;
for (let i = 0; i < 125; i += 1) {
  const r = await get(`/ekaterinburg/net-kluba-${randomUUID().slice(0, 8)}/`);
  codes.push(r.status);
  if (r.status === 429 && firstLimited === null) {
    firstLimited = i + 1;
    retry = r.retry;
  }
}
const after = [];
for (const p of ['/', '/ekaterinburg/', '/ekaterinburg/testovyy-klub/']) after.push((await get(p)).status);
const count = {};
for (const c of codes) count[c] = (count[c] ?? 0) + 1;
console.log(JSON.stringify({ warm, count, firstLimited, retry, after }));
