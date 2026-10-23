// Через Caddy (как браузер), свой адрес контейнера: 31 запрос к маршруту с лимитом 30/мин,
// каждый с новым поддельным X-Forwarded-For. Если сервер поверил заголовку — 429 не будет.
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const ca = readFileSync('/probe/caddy-root.crt');
function get(path, xff) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'caddy', port: 443, servername: 'localhost', path, method: 'GET', ca, headers: { host: 'localhost', 'x-forwarded-for': xff } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}
const out = [];
for (let i = 0; i < 31; i += 1) out.push(await get(`/api/clubs/requests/${randomUUID()}/answer?t=${'x'.repeat(43)}`, `10.231.47.${(i % 5) + 2}, 203.0.113.${i + 1}`));
console.log(JSON.stringify(out));
