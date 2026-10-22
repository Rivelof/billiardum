// Необязательные сервисы Compose (эмуляторы, мост ККТ), регистрация моста разработки,
// маршрут WebSocket в Caddy и честность CI (контракт M2 §2, §6).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { NODE_IMAGE } from './ci.mjs';
import { extraDbTestPackages, moduleDbTestDirs } from './ci-test-db.mjs';
import { globToRegExp, testPatterns, uncoveredTests } from './ci-test-files.mjs';
import { KKT_REGISTER_SCRIPTS, kktRegisterCommand } from './dev.mjs';
import { ALL_PROFILE_ARGS, missingDependencies, missingFiles, OPTIONAL_SERVICES, ROOT } from './dev-lib.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bl-services-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Дерево файлов во временной папке: { 'путь': содержимое }. */
function tree(name, files) {
  const root = join(tmp, name);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const compose = readFileSync(join(ROOT, 'deploy', 'dev', 'compose.yml'), 'utf8');
/** Текст сервиса compose.yml от его имени до следующего сервиса верхнего уровня. */
const serviceBlock = (name) => compose.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|\\nvolumes:)`))?.[1] ?? '';

test('необязательные сервисы: у каждого свой профиль в compose.yml, порта наружу нет', () => {
  assert.deepEqual(OPTIONAL_SERVICES.map((s) => s.service), ['yookassa-emu', 'kkt-emu', 'kkt-bridge']);
  assert.deepEqual(ALL_PROFILE_ARGS, ['--profile', 'yookassa-emu', '--profile', 'kkt-emu', '--profile', 'kkt-bridge']);
  for (const s of OPTIONAL_SERVICES) {
    const block = serviceBlock(s.service);
    assert.match(block, new RegExp(`profiles: \\[${s.service}\\]`), s.service);
    assert.doesNotMatch(block, /\n {4}ports:/, `${s.service}: управление эмуляторов и мост — только внутри сети Compose`);
  }
  assert.match(serviceBlock('kkt-emu'), /command: \["node", "tools\/kkt-bridge\/emu\/index\.mjs"\]/);
  assert.match(serviceBlock('kkt-emu'), /ATOL_EMU_PORT: "16732"/);
  assert.match(serviceBlock('kkt-emu'), /ATOL_EMU_HOST: 0\.0\.0\.0/);
  assert.match(serviceBlock('kkt-bridge'), /command: \["node", "tools\/kkt-bridge\/index\.mjs", "--config", "deploy\/dev\/kkt-bridge\.json"\]/);
});

test('настройки моста разработки: без секретов, токен — из файла вне git', async () => {
  const dev = JSON.parse(readFileSync(join(ROOT, 'deploy', 'dev', 'kkt-bridge.json'), 'utf8'));
  const host = JSON.parse(readFileSync(join(ROOT, 'deploy', 'dev', 'kkt-bridge.host.json'), 'utf8'));
  for (const c of [dev, host]) {
    assert.equal(c.token, undefined);
    assert.equal(c.token_file, 'kkt-bridge.token');
  }
  assert.equal(dev.server_url, 'ws://server:3000/api/kkt/ws');
  assert.equal(dev.atol_url, 'http://kkt-emu:16732');
  assert.match(dev.data_dir, /^\/var\/lib\//, 'журнал — вне /repo (там только чтение)');
  assert.equal(host.server_url, 'wss://localhost:8443/api/kkt/ws');

  // Сам мост принимает оба файла (если пакет уже есть).
  const lib = join(ROOT, 'tools', 'kkt-bridge', 'lib', 'config.mjs');
  if (!existsSync(lib)) return;
  const { parseConfig } = await import(pathToFileURL(lib).href);
  const env = { KKT_BRIDGE_TOKEN: 'a'.repeat(48) };
  assert.equal(parseConfig(dev, { env, baseDir: '/repo/deploy/dev' }).serverUrl, 'ws://server:3000/api/kkt/ws');
  assert.equal(parseConfig(host, { env, baseDir: '/x/deploy/dev' }).dataDir, '/x/deploy/dev/kkt-bridge-data');
});

test('мост ККТ стартует, только когда есть и пакет, и файл настроек с токеном', () => {
  const bridge = OPTIONAL_SERVICES.find((s) => s.service === 'kkt-bridge');
  const root = tree('svc', { 'tools/kkt-bridge/index.mjs': '' });
  assert.deepEqual(missingFiles(bridge, root), ['deploy/dev/kkt-bridge.token']);
  mkdirSync(join(root, 'deploy', 'dev'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'dev', 'kkt-bridge.token'), 'x');
  assert.deepEqual(missingFiles(bridge, root), []);
});

test('токен и журнал моста разработки не попадают в git', () => {
  const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^deploy\/dev\/kkt-bridge\.token$/m);
  assert.match(ignore, /^deploy\/dev\/kkt-bridge-data\/$/m);
});

test('регистрация моста разработки: скрипт npm пакета главнее файла, нет ничего — null', () => {
  assert.equal(kktRegisterCommand(tree('reg0', { 'package.json': {} })), null);
  const file = tree('reg1', { [KKT_REGISTER_SCRIPTS[0]]: '' });
  assert.deepEqual(kktRegisterCommand(file), { label: `node ${KKT_REGISTER_SCRIPTS[0]}`, script: KKT_REGISTER_SCRIPTS[0] });
  const npmScript = tree('reg2', {
    [KKT_REGISTER_SCRIPTS[0]]: '',
    'tools/kkt-bridge/package.json': { name: '@billiardum/kkt-bridge', scripts: { 'provision:dev': 'node x.mjs' } },
  });
  assert.deepEqual(kktRegisterCommand(npmScript).npmArgs, ['run', 'provision:dev', '-w', '@billiardum/kkt-bridge']);
});

test('новый workspace без строки в package-lock.json — повод для npm install', () => {
  const root = tree('lock', {
    'package.json': { workspaces: ['server', 'tools/kkt-bridge', 'tools/missing'] },
    'package-lock.json': { packages: { '': {}, server: {}, 'node_modules/@billiardum/server': { link: true } } },
    'node_modules/@billiardum/server/package.json': {},
    'server/package.json': {},
    'tools/kkt-bridge/package.json': { name: '@billiardum/kkt-bridge' },
  });
  assert.deepEqual(missingDependencies(root), ['tools/kkt-bridge']);
});

test('тесты модулей на базе и test:db пакетов находятся сами', () => {
  const root = tree('dbt', {
    'package.json': { workspaces: ['supabase', 'server', 'tools/kkt-bridge', 'tools/device-sim'] },
    'server/package.json': { scripts: { 'test:db': 'x' } },
    'tools/kkt-bridge/package.json': { scripts: { test: 'x', 'test:db': 'node --test "test/db/*.test.mjs"' } },
    'tools/device-sim/package.json': { scripts: { test: 'x' } },
    'server/test/db/a.test.mjs': '',
    'server/test/light/b.test.mjs': '',
    'server/test/pos/c.test.mjs': '',
    'server/test/kkt/helpers.mjs': '',
    'server/kkt/test/db/d.test.mjs': '',
    'server/kkt/test/unit.test.mjs': '',
  });
  assert.deepEqual(moduleDbTestDirs(root), ['server/kkt/test/db', 'server/test/pos']);
  assert.deepEqual(extraDbTestPackages(root), ['tools/kkt-bridge']);
});

test('честность CI: шаблоны node --test и тесты, которые никто не запускает', () => {
  assert.deepEqual(testPatterns('node --test --test-concurrency=1 "tests/*.test.mjs"'), ['tests/*.test.mjs']);
  assert.deepEqual(testPatterns('node --test'), ['**/*.test.mjs']);
  assert.deepEqual(testPatterns('node scripts/integration.mjs'), []);
  assert.ok(globToRegExp('test/**/*.test.mjs').test('test/a/b/c.test.mjs'));
  assert.ok(globToRegExp('test/**/*.test.mjs').test('test/c.test.mjs'));
  assert.ok(!globToRegExp('test/*.test.mjs').test('test/a/c.test.mjs'));

  const root = tree('orphans', {
    'package.json': { workspaces: ['server', 'tools/kkt-bridge'], scripts: { test: 'node --test "scripts/*.test.mjs"' } },
    'server/package.json': { scripts: { test: 'node --test "test/*.test.mjs" "payments/test/*.test.mjs"', 'test:db': 'node --test "test/db/*.test.mjs"' } },
    'tools/kkt-bridge/package.json': { scripts: { test: 'node --test' } },
    'scripts/a.test.mjs': '',
    'server/test/b.test.mjs': '',
    'server/test/db/c.test.mjs': '',
    'server/test/light/d.test.mjs': '',
    'server/test/kkt/e.test.mjs': '',
    'server/payments/test/f.test.mjs': '',
    'server/kkt/test/g.test.mjs': '',
    'tools/kkt-bridge/test/emu/h.test.mjs': '',
    'tests/e2e/m2/i.test.mjs': '',
    'node_modules/x/j.test.mjs': '',
  });
  assert.deepEqual(uncoveredTests(root), ['server/kkt/test/g.test.mjs']);
});

test('образ Node один в compose.yml, CI и проверке WebSocket через Caddy', () => {
  assert.match(compose, new RegExp(`x-node-service: &node-service\\n  image: ${NODE_IMAGE.replaceAll('.', '\\.')}\\n`));
  const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(workflow.includes(`docker pull ${NODE_IMAGE}\n`));
});

test('Caddy: WebSocket моста ККТ — свой маршрут без лимита тела, без буфера, с stream_close_delay', () => {
  const caddyfile = readFileSync(join(ROOT, 'deploy', 'dev', 'Caddyfile'), 'utf8');
  const block = caddyfile.match(/\thandle \/api\/kkt\/ws \{\n([\s\S]*?)\n\t\}\n/)?.[1] ?? '';
  assert.match(block, /reverse_proxy server:3000 \{/);
  assert.match(block, /flush_interval -1/);
  assert.match(block, /stream_close_delay 5m/);
  assert.doesNotMatch(block, /request_body|encode|import api/);
  assert.ok(caddyfile.indexOf('handle /api/kkt/ws {') < caddyfile.indexOf('handle @server {'), 'маршрут моста — до общего /api/*');
});
