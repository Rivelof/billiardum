// PoC M1 — вход для разработки и ускоренное время в проде (атакующий: посторонний).
// Контракт §2.3, §4; decisions №54. В production маршрут /api/auth/dev не регистрируется,
// а DEV_ALLOW_ANY_MINUTES игнорируется — даже если флаги выставлены в 1.
//
// Поднимает ОТДЕЛЬНЫЙ сервер в своём процессе (NODE_ENV=production, ALLOW_DEV_LOGIN=1,
// DEV_ALLOW_ANY_MINUTES=1) на своём порту 3099 и своей временной базе bl_pentest_prod;
// MQTT указывает на мёртвый порт (к брокеру стека не подключается). В конце всё удаляется.
// В production обязательна TRUSTED_PROXY_CIDRS (M4-I4): серверу и loadServerConfig — 127.0.0.1/32.
// Проверки loadServerConfig работают без базы; тесты с сервером — только при DATABASE_ADMIN_URL.
//
// Запуск: node --test tests/security/m1/prod_dev_routes.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv, adminUrl, sql } from './helper.mjs';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 3099;
const TMPDB = 'bl_pentest_prod';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const TABLE7 = 'e1000000-0000-4000-8000-000000000007';

const env = readEnv();
const admin = adminUrl();
const adminTmp = admin.replace(/\/postgres(\?|$)/, `/${TMPDB}$1`);
let child;
let ownerToken;

/** HTTP к локальному prod-серверу (без TLS). */
function get(method, p, { token, body } = {}) {
  const headers = { origin: 'https://localhost:8443' };
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

const available = Boolean(admin && env.DB_APP_PASSWORD && env.SECRETS_ENC_KEY);

// Проверки loadServerConfig (без базы и без сети): обязательные переменные — заглушки, ключ шифрования —
// одноразовый случайный, секреты из .env не нужны.
const PROD_BASE = Object.freeze({
  NODE_ENV: 'production',
  DATABASE_URL: 'x',
  MQTT_URL: 'x',
  MQTT_CA_FILE: 'deploy/dev/certs/ca.crt',
  MQTT_SERVER_USER: 'x',
  MQTT_SERVER_PASSWORD: 'x',
  SECRETS_ENC_KEY: randomBytes(32).toString('base64'),
});

before(async () => {
  if (!available) return;
  await sql(`drop database if exists ${TMPDB}`);
  await sql(`create database ${TMPDB}`);
  const childEnv = { ...process.env, DATABASE_ADMIN_URL: adminTmp, DB_APP_PASSWORD: env.DB_APP_PASSWORD, NODE_ENV: 'development' };
  await execFileP('node', ['supabase/bin/migrate.mjs'], { cwd: ROOT, env: childEnv });
  await execFileP('node', ['supabase/bin/seed.mjs'], { cwd: ROOT, env: childEnv });

  // Токен и согласие для владельца прямо в базе (в проде вход для разработки недоступен).
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token, 'utf8').digest('hex');
  await sql("insert into bl.consents(user_id,version,accepted_at) values($1,'2026-10-21',now()) on conflict do nothing", [OWNER], adminTmp);
  await sql("insert into bl.auth_tokens(user_id,token_hash,kind,created_at,expires_at) values($1,$2,'session',now(),now()+interval '1 hour')", [OWNER, hash], adminTmp);
  ownerToken = token;

  child = spawn('node', ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ALLOW_DEV_LOGIN: '1',
      DEV_ALLOW_ANY_MINUTES: '1',
      PORT: String(PORT),
      PUBLIC_HOST: 'localhost:8443',
      // M4-I4: в production список доверенных прокси обязателен; тест ходит напрямую с loopback.
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
      DATABASE_URL: `postgres://app_api:${env.DB_APP_PASSWORD}@127.0.0.1:54322/${TMPDB}`,
      MQTT_URL: 'mqtts://127.0.0.1:18883', // мёртвый порт: к брокеру стека не подключаемся
      MQTT_CA_FILE: 'deploy/dev/certs/ca.crt',
      MQTT_SERVER_USER: 'x',
      MQTT_SERVER_PASSWORD: 'xxxxxxxxxxxx',
      SECRETS_ENC_KEY: env.SECRETS_ENC_KEY,
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i += 1) {
    try {
      await get('GET', '/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error('prod server не поднялся');
});

test('production: /api/auth/dev не зарегистрирован (404), API при этом работает', { skip: available ? false : 'нет DATABASE_ADMIN_URL' }, async () => {
  const dev = await get('POST', '/api/auth/dev', { body: { phone: '+70000000001' } });
  assert.equal(dev.status, 404, 'вход для разработки в проде недоступен');
  assert.equal(dev.json.error, 'not_found');
  const me = await get('GET', '/api/me');
  assert.equal(me.status, 401, 'остальной API смонтирован (нужна авторизация)');
});

test('production: конфигурация гасит оба флага даже при ALLOW_DEV_LOGIN=1 и DEV_ALLOW_ANY_MINUTES=1', async () => {
  const { loadServerConfig } = await import(path.join(ROOT, 'server/lib/config.mjs'));
  const cfg = loadServerConfig({
    ...PROD_BASE, ALLOW_DEV_LOGIN: '1', DEV_ALLOW_ANY_MINUTES: '1', TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  });
  assert.equal(cfg.allowDevLogin, false, 'allowDevLogin forced false');
  assert.equal(cfg.devAllowAnyMinutes, false, 'devAllowAnyMinutes forced false');
});

test('M4-I4 выдержало: production без TRUSTED_PROXY_CIDRS или с широкими сетями доверия — сервер не стартует', async () => {
  const { loadServerConfig } = await import(path.join(ROOT, 'server/lib/config.mjs'));
  const load = (extra) => () => loadServerConfig({ ...PROD_BASE, ...extra });
  const configError = (re) => (err) => err.name === 'ConfigError' && re.test(err.message);

  // Без переменной (или пустая, или из одних разделителей) — отказ, а не «все частные сети» по умолчанию.
  for (const v of [undefined, '', ' ', ' , ,']) {
    assert.throws(load(v === undefined ? {} : { TRUSTED_PROXY_CIDRS: v }), configError(/TRUSTED_PROXY_CIDRS обязательна/), `TRUSTED_PROXY_CIDRS=${JSON.stringify(v)}`);
  }

  // Шире /24 (IPv4) и /120 (IPv6) — отказ, в том числе в необычной записи маски и рядом с узкой сетью.
  const wide = [
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '10.231.0.0/23', '0.0.0.0/0', '10.0.0.0/', '10.0.0.0/ 8', '10.0.0.0/8.0',
    'fc00::/7', '::/0', '2001:db8::/64', '2001:db8::/119', '::ffff:10.0.0.0/104', '::ffff:0:0/96',
  ];
  for (const w of wide) {
    assert.throws(load({ TRUSTED_PROXY_CIDRS: w }), configError(/^TRUSTED_PROXY_CIDRS: /), `TRUSTED_PROXY_CIDRS=${w}`);
    assert.throws(load({ TRUSTED_PROXY_CIDRS: `127.0.0.1/32,${w}` }), configError(/^TRUSTED_PROXY_CIDRS: /), `TRUSTED_PROXY_CIDRS=127.0.0.1/32,${w}`);
    assert.throws(
      load({ TRUSTED_PROXY_CIDRS: '127.0.0.1/32', PUBLIC_API_TRUSTED_CIDRS: w }),
      configError(/^PUBLIC_API_TRUSTED_CIDRS: /),
      `PUBLIC_API_TRUSTED_CIDRS=${w}`,
    );
    assert.throws(
      load({ TRUSTED_PROXY_CIDRS: '127.0.0.1/32', PUBLIC_API_TRUSTED_CIDRS: `10.231.47.6/32,${w}` }),
      configError(/^PUBLIC_API_TRUSTED_CIDRS: /),
      `PUBLIC_API_TRUSTED_CIDRS=10.231.47.6/32,${w}`,
    );
  }

  // Граница: ровно /24 и /120, отдельные адреса без маски — допустимы.
  const cfg = loadServerConfig({
    ...PROD_BASE,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32, 10.231.47.22, 10.231.48.0/24, 2001:db8::1/128, 2001:db8::100/120',
    PUBLIC_API_TRUSTED_CIDRS: '10.231.47.6/32,2001:db8::200/120',
  });
  assert.equal(cfg.trustedProxies.length, 5);
  assert.equal(cfg.publicTrustedCidrs.length, 2);
  // Без PUBLIC_API_TRUSTED_CIDRS сайт ничем не доверен (лимит для всех).
  assert.equal(loadServerConfig({ ...PROD_BASE, TRUSTED_PROXY_CIDRS: '127.0.0.1/32' }).publicTrustedCidrs.length, 0);
});

test('production: ускоренное время выключено — произвольные минуты в котировке отклоняются', { skip: available ? false : 'нет DATABASE_ADMIN_URL' }, async () => {
  const seven = await get('POST', '/api/quotes', { token: ownerToken, body: { resource_id: TABLE7, kind: 'start', minutes: 7 } });
  assert.equal(seven.status, 400, 'minutes=7 (ускоренное) отклонено');
  assert.equal(seven.json.error, 'bad_request');
  // Фиксированные минуты проходят валидацию (дальше упираются в офлайн-стол без брокера).
  const sixty = await get('POST', '/api/quotes', { token: ownerToken, body: { resource_id: TABLE7, kind: 'start', minutes: 60 } });
  assert.notEqual(sixty.status, 400, `minutes=60 принято валидацией (получили ${sixty.status} ${JSON.stringify(sixty.json)})`);
});

after(async () => {
  if (child) {
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
  }
  if (available) await sql(`drop database if exists ${TMPDB}`);
});
