// Файл устройств (контракт M0 §4), переменные окружения, флаги, лог без секретов.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig, parseArgs } from '../lib/config.mjs';
import { FaultFlags, parseFaults } from '../lib/faults.mjs';
import { createLogger, redactUrl } from '../lib/log.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'bl-sim-config-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const PASSWORD = 'pw-should-never-be-printed';
const KEY = Buffer.alloc(32, 9).toString('base64');

function device(i, extra = {}) {
  const hex = String(i).padStart(12, '0');
  return {
    device_id: `0192f3c2-0000-7000-8000-${hex}`,
    club_id: '0192f3c0-0000-7000-8000-00000000c1ab',
    resource_id: `0192f3c3-0000-7000-8000-${hex}`,
    table_number: i,
    mqtt_username: `0192f3c2-0000-7000-8000-${hex}`,
    mqtt_password: PASSWORD,
    device_key: KEY,
    ...extra,
  };
}

function writeDevices(name, content) {
  const sub = path.join(dir, name);
  mkdirSync(path.join(sub, 'certs'), { recursive: true });
  writeFileSync(path.join(sub, 'certs', 'ca.crt'), '-----BEGIN CERTIFICATE-----\n');
  const file = path.join(sub, 'devices.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const base = (devices) => ({ mqtt_url: 'mqtts://localhost:8883', ca_file: 'certs/ca.crt', devices });

test('читает файл устройств; ca_file относительно папки файла; без переопределений', () => {
  const file = writeDevices('ok', base([device(1), device(2)]));
  const cfg = loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: [], cwd: '/' });
  assert.equal(cfg.mqttUrl, 'mqtts://localhost:8883');
  assert.equal(cfg.tls, true);
  assert.equal(cfg.caFile, path.join(path.dirname(file), 'certs', 'ca.crt'));
  assert.ok(Buffer.isBuffer(cfg.ca));
  assert.equal(cfg.devices.length, 2);
  assert.equal(cfg.devices[1].table, 2);
  assert.equal(cfg.devices[0].deviceKey.length, 32);
  assert.equal(cfg.logLevel, 'info');
});

test('MQTT_URL, MQTT_CA_FILE и LOG_LEVEL переопределяют файл; относительный путь — от INIT_CWD', () => {
  const file = writeDevices('env', base([device(1)]));
  const other = path.join(dir, 'other-ca.crt');
  writeFileSync(other, 'x');
  const cfg = loadConfig({
    env: { SIM_DEVICES_FILE: 'env/devices.json', INIT_CWD: dir, MQTT_URL: 'mqtts://mosquitto:8883', MQTT_CA_FILE: other, LOG_LEVEL: 'debug' },
    argv: [],
    cwd: '/',
  });
  assert.equal(cfg.devicesFile, file);
  assert.equal(cfg.mqttUrl, 'mqtts://mosquitto:8883');
  assert.equal(cfg.caFile, other);
  assert.equal(cfg.logLevel, 'debug');
});

test('mqtt:// без CA допустим (только тесты); mqtts:// без CA — ошибка', () => {
  const file = writeDevices('plain', { mqtt_url: 'mqtt://localhost:18883', devices: [device(1)] });
  const cfg = loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: [] });
  assert.equal(cfg.tls, false);
  assert.equal(cfg.ca, null);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: file, MQTT_URL: 'mqtts://localhost:8883' }, argv: [] }), /CA/);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: file, MQTT_URL: 'http://x' }, argv: [] }), ConfigError);
});

test('ошибки файла называют поле, но не печатают секреты', () => {
  const cases = [
    [{ device_key: 'AAAA' }, /device_key/],
    [{ device_key: `${KEY}x` }, /device_key/],
    [{ mqtt_password: '' }, /mqtt_password/],
    [{ device_id: 'table-1' }, /device_id/],
    [{ table_number: 0 }, /table_number/],
  ];
  for (const [patch, re] of cases) {
    const file = writeDevices('bad', base([device(1, patch)]));
    try {
      loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: [] });
      assert.fail('ожидалась ошибка');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, re);
      assert.ok(!err.message.includes(PASSWORD) && !err.message.includes(KEY), 'секрет в тексте ошибки');
    }
  }
  const dup = writeDevices('dup', base([device(1), device(1)]));
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: dup }, argv: [] }), /повторяется/);
  const broken = writeDevices('broken', `{"devices":[{"mqtt_password":"${PASSWORD}"`);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: broken }, argv: [] }), (err) => !err.message.includes(PASSWORD));
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: path.join(dir, 'nope.json') }, argv: [] }), /provision:dev/);
});

test('флаги: --tables, --fault, --caps, --help, SIM_FAULTS', () => {
  const file = writeDevices('flags', base([device(1), device(2), device(3)]));
  const cfg = loadConfig({
    env: { SIM_DEVICES_FILE: file, SIM_FAULTS: 'net-drop@2' },
    argv: ['--tables', '1,3', '--fault=slow-ack', '--caps', 'relay,led,dimmer'],
  });
  assert.deepEqual(cfg.devices.map((d) => d.table), [1, 3]);
  assert.deepEqual(cfg.faults, [{ name: 'net-drop', table: 2 }, { name: 'slow-ack', table: null }]);
  assert.deepEqual(cfg.caps, ['relay', 'led', 'dimmer']);
  assert.deepEqual(loadConfig({ env: {}, argv: ['--help'] }), { help: true });
  assert.throws(() => parseArgs(['--what']), /неизвестный аргумент/);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: ['--fault', 'meteor'] }), /meteor/);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: ['--caps', 'led'] }), /relay/);
  assert.throws(() => loadConfig({ env: { SIM_DEVICES_FILE: file }, argv: ['--tables', '9'] }), /не осталось/);
});

test('режимы сбоя: разбор и флаги стола', () => {
  const faults = parseFaults(['reboot,lamp-fault@4', 'bypass@4', 'replay-old']);
  const t4 = new FaultFlags(faults, 4);
  const t1 = new FaultFlags(faults, 1);
  assert.ok(t4.has('lamp-fault') && t4.has('bypass') && t4.has('reboot'));
  assert.ok(!t1.has('lamp-fault') && t1.has('reboot') && t1.has('replay-old'));
  assert.throws(() => parseFaults(['bypass@x']));
  assert.throws(() => parseFaults(['bypass@1@2']));
});

test('лог: строки JSON с t, level, msg; уровень отсекает; URL без логина и пароля', () => {
  const lines = [];
  const log = createLogger({ level: 'info', write: (l) => lines.push(l), now: () => new Date(0) });
  log.debug('hidden');
  log.child({ device_id: 'd', table: 4 }).info('sim_state', { mode: 'free', relay: false, led: 'green_dim' });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    t: '1970-01-01T00:00:00.000Z', level: 'info', msg: 'sim_state', device_id: 'd', table: 4, mode: 'free', relay: false, led: 'green_dim',
  });
  assert.equal(redactUrl(`mqtts://user:${PASSWORD}@host:8883`), 'mqtts://host:8883');
});
