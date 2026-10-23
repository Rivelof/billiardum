import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { DEV_EMU_SHOPS, emulatorBase, shopsToRegister } from './dev-yookassa-emu.mjs';
import { ROOT } from './dev-lib.mjs';

const SCRIPT = join(ROOT, 'scripts', 'dev-yookassa-emu.mjs');
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Запускает обёртку как сервис Compose; ждёт строку emu_dev_shops (или выход). */
async function startEmu(extraEnv) {
  const port = await freePort();
  const env = { PATH: process.env.PATH, YOOKASSA_EMU_PORT: String(port), YOOKASSA_EMU_HOST: '127.0.0.1', ...extraEnv };
  const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`эмулятор не завёл магазины за 10 с:\n${out}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"emu_dev_shops"')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`эмулятор вышел с кодом ${code}:\n${out}`));
    });
  });
  return { base: `http://127.0.0.1:${port}`, out: () => out };
}

async function me(base, shopId, secret) {
  const res = await fetch(`${base}/v3/me`, { headers: { authorization: `Basic ${Buffer.from(`${shopId}:${secret}`).toString('base64')}` } });
  return { status: res.status, body: await res.json() };
}

test('магазины для нового клуба: тестовый, боевой с чеками, боевой без чеков', () => {
  assert.deepEqual(
    DEV_EMU_SHOPS.map((s) => [s.shop_id, s.test, s.fiscalization_enabled]),
    [['800001', true, true], ['800002', false, true], ['800003', false, false]],
  );
  for (const s of DEV_EMU_SHOPS) {
    // Не пересекаются с магазином из .env: npm run dev выбирает его из 900000–999999.
    assert.ok(Number(s.shop_id) < 900000, s.shop_id);
    // Проходят проверки формы на сервере (server/clubs/shops.mjs: SHOP_ID и SECRET).
    assert.match(s.shop_id, /^[0-9A-Za-z_-]{1,64}$/);
    assert.match(s.secret, /^[\x21-\x7e]{8,200}$/);
  }
  assert.equal(new Set(DEV_EMU_SHOPS.map((s) => s.shop_id)).size, DEV_EMU_SHOPS.length);
});

test('магазин из .env с тем же shop_id не подменяется; адрес эмулятора — loopback', () => {
  assert.deepEqual(shopsToRegister({ YOOKASSA_EMU_SHOP_ID: '800002' }).map((s) => s.shop_id), ['800001', '800003']);
  assert.equal(shopsToRegister({}).length, 3);
  assert.equal(emulatorBase({}), 'http://127.0.0.1:8090');
  assert.equal(emulatorBase({ YOOKASSA_EMU_HOST: '0.0.0.0', YOOKASSA_EMU_PORT: '8091' }), 'http://127.0.0.1:8091');
  assert.equal(emulatorBase({ YOOKASSA_EMU_HOST: '::1' }), 'http://[::1]:8090');
});

test('compose: сервис yookassa-emu запускает обёртку и передаёт флаги магазина, server — версию оферты', () => {
  const text = readFileSync(join(ROOT, 'deploy', 'dev', 'compose.yml'), 'utf8');
  assert.match(text, /command: \["node", "scripts\/dev-yookassa-emu\.mjs"\]/);
  assert.match(text, /YOOKASSA_EMU_SHOP_TEST: \$\{YOOKASSA_EMU_SHOP_TEST:-1\}/);
  assert.match(text, /YOOKASSA_EMU_SHOP_FISCALIZATION: \$\{YOOKASSA_EMU_SHOP_FISCALIZATION:-1\}/);
  assert.match(text, /CLUB_OFFER_VERSION: \$\{CLUB_OFFER_VERSION:-\}/);
});

test('эмулятор в процессе обёртки: GET /v3/me у каждого магазина, магазин из .env с флагами', async () => {
  const { base, out } = await startEmu({
    YOOKASSA_EMU_SHOP_ID: '912345',
    YOOKASSA_EMU_SECRET: 'test_env_shop_secret',
    YOOKASSA_EMU_SHOP_TEST: '0',
    YOOKASSA_EMU_SHOP_FISCALIZATION: '0',
  });
  for (const s of DEV_EMU_SHOPS) {
    const r = await me(base, s.shop_id, s.secret);
    assert.equal(r.status, 200, s.shop_id);
    assert.equal(r.body.account_id, s.shop_id);
    assert.equal(r.body.test, s.test);
    assert.equal(r.body.fiscalization_enabled, s.fiscalization_enabled);
  }
  const env = await me(base, '912345', 'test_env_shop_secret');
  assert.deepEqual([env.status, env.body.test, env.body.fiscalization_enabled], [200, false, false]);
  assert.equal((await me(base, '800002', 'wrong-secret')).status, 401);
  // Секреты в лог не попадают.
  for (const s of DEV_EMU_SHOPS) assert.ok(!out().includes(s.secret));
  assert.ok(!out().includes('test_env_shop_secret'));
});

test('с YOOKASSA_EMU_CONTROL_TOKEN магазины заводятся с X-Emu-Token', async () => {
  const { base } = await startEmu({ YOOKASSA_EMU_CONTROL_TOKEN: 'ctl-token-123' });
  const s = DEV_EMU_SHOPS[1];
  assert.equal((await me(base, s.shop_id, s.secret)).status, 200);
  const res = await fetch(`${base}/__emu/requests`);
  assert.equal(res.status, 401);
});
