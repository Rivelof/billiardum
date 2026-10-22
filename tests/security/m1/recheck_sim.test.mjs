// Перепроверка M1: управление симулятором POST /sim/tables/{n}/inject — только разработка.
// Вопрос оркестратора: при NODE_ENV=production управление не стартует; в боевом контуре
// (сервер, прошивка) ничего подобного нет. Отдельный процесс симулятора, стек не трогаю.
// Запуск: node --test tests/security/m1/recheck_sim.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../tools/device-sim/lib/config.mjs';
import { startControl } from '../../../tools/device-sim/lib/control.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DEVICES = path.join(ROOT, 'deploy/dev/devices.json');
const CTRL_PORT = 18099; // не 18080 стека
const execFileP = promisify(execFile);

test('loadConfig отклоняет SIM_CONTROL_PORT при NODE_ENV=production', () => {
  const env = { NODE_ENV: 'production', SIM_CONTROL_PORT: String(CTRL_PORT), SIM_DEVICES_FILE: DEVICES };
  assert.throws(() => loadConfig({ env, argv: [], cwd: ROOT }), /production/, 'конфигурация должна отказать');
  // В dev тот же конфиг даёт управляющий порт.
  const dev = loadConfig({ env: { NODE_ENV: 'development', SIM_CONTROL_PORT: String(CTRL_PORT), SIM_DEVICES_FILE: DEVICES }, argv: [], cwd: ROOT });
  assert.equal(dev.controlPort, CTRL_PORT, 'в разработке порт управления выставляется');
});

test('startControl бросает при NODE_ENV=production (второй предохранитель)', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(startControl({ devices: [], port: CTRL_PORT, log: { info() {}, warn() {}, error() {} } }), /production/);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prev;
  }
});

test('реальный процесс симулятора в production не открывает управляющий порт', async () => {
  const child = spawn('node', ['tools/device-sim/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', SIM_CONTROL_PORT: String(CTRL_PORT), SIM_DEVICES_FILE: DEVICES, LOG_LEVEL: 'error',
      // Мёртвый брокер: даже если дошло бы до MQTT — к стеку не подключаемся.
      MQTT_URL: 'mqtts://127.0.0.1:18883', MQTT_CA_FILE: 'deploy/dev/certs/ca.crt' },
    stdio: 'ignore',
  });
  // Процесс должен завершиться с ненулевым кодом (ConfigError → exitCode 2) и порт не слушать.
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise((r) => setTimeout(() => r(['timeout']), 8000)),
  ]);
  if (code === 'timeout') {
    child.kill('SIGKILL');
    assert.fail('симулятор не завершился в production — возможно, поднял управление');
  }
  assert.notEqual(code, 0, `ожидался ненулевой код выхода в production, получили ${code}`);
  // Порт управления не слушается.
  const listening = await new Promise((resolve) => {
    const s = net.connect(CTRL_PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
  assert.equal(listening, false, 'управляющий порт не должен слушаться в production');
});

test('в боевом контуре нет аналога inject/sim-control (сервер и прошивка)', async () => {
  // Управление симулятором — только в tools/device-sim. В server/ и firmware/ команд
  // контроллеру извне по HTTP нет: единственный путь к cmd — подписанный мост MQTT.
  const { stdout } = await execFileP('bash', ['-lc',
    "grep -rilE '/sim/|\\binject\\b' server firmware/src firmware/lib 2>/dev/null | grep -vE 'test|node_modules' || true"], { cwd: ROOT });
  const hits = stdout.split('\n').map((s) => s.trim()).filter(Boolean)
    // server/payments/api.mjs: 'injected' — имя параметра внедрения зависимостей, не сетевой ввод.
    .filter((f) => f !== 'server/payments/api.mjs');
  assert.deepEqual(hits, [], `подозрительные файлы: ${hits.join(', ')}`);
});
