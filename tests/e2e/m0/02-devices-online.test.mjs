// Критерий 1: симулятор показывает 8 столов онлайн в логе сервера:
// строка devices_online 8/8 и cmd_ack ok на ping от каждого из 8 устройств.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminClient, containerLog, loadDevices, SERVER_CONTAINER, SIM_CONTAINER } from './helpers.mjs';

const devices = loadDevices();

test('devices.json: 8 устройств сида, столы 1–8, у каждого свой ключ', () => {
  assert.equal(devices.length, 8);
  assert.deepEqual(
    devices.map((d) => d.table_number),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
  for (const d of devices) {
    assert.equal(d.mqtt_username, d.device_id);
    assert.equal(Buffer.from(d.device_key, 'base64').length, 32);
  }
  assert.equal(new Set(devices.map((d) => d.device_key)).size, 8, 'ключи устройств разные');
  assert.equal(new Set(devices.map((d) => d.mqtt_password)).size, 8, 'пароли MQTT разные');
});

test('лог сервера: devices_online 8/8 (свежая строка, total = число устройств в базе)', async (t) => {
  const db = await adminClient();
  let dbTotal;
  try {
    dbTotal = Number((await db.query('select count(*) from bl.devices')).rows[0].count);
  } finally {
    await db.end();
  }
  const lines = containerLog(SERVER_CONTAINER).filter((l) => l.msg === 'devices_online');
  assert.ok(lines.length > 0, 'нет строк devices_online');
  const reached = lines.find((l) => l.online === 8 && l.total === 8);
  const last = lines.at(-1);
  t.diagnostic(`первая 8/8: ${JSON.stringify(reached)}`);
  t.diagnostic(`последняя: ${JSON.stringify(last)}; устройств в bl.devices: ${dbTotal}`);
  assert.ok(reached, 'в логе нет devices_online 8/8');
  assert.equal(dbTotal, 8);
  assert.equal(last.online, 8);
  assert.equal(last.total, dbTotal);
  // Сервер повторяет строку раз в 60 с — последняя не старше 70 с.
  assert.ok(Date.now() - Date.parse(last.t) < 70_000, `последняя devices_online старая: ${last.t}`);
});

test('лог сервера: cmd_ack ok для ping от всех 8 устройств', (t) => {
  const acks = containerLog(SERVER_CONTAINER).filter((l) => l.msg === 'cmd_ack');
  const okPing = acks.filter((l) => l.ok === true && l.type === 'ping');
  const bad = acks.filter((l) => l.ok !== true);
  const byDevice = new Map();
  for (const a of okPing) if (!byDevice.has(a.device_id)) byDevice.set(a.device_id, a);
  for (const d of devices) {
    const a = byDevice.get(d.device_id);
    t.diagnostic(`стол ${d.table_number}: ${a ? JSON.stringify(a) : 'нет cmd_ack'}`);
    assert.ok(a, `нет cmd_ack ok для стола ${d.table_number}`);
  }
  t.diagnostic(`всего cmd_ack ok: ${okPing.length}, с ошибкой: ${bad.length}`);
  assert.equal(bad.length, 0, `cmd_ack с ошибкой: ${JSON.stringify(bad)}`);
});

test('лог симулятора: 8 столов подключены, ping исполнен у каждого', (t) => {
  const lines = containerLog(SIM_CONTAINER);
  const start = lines.filter((l) => l.msg === 'sim_start').at(-1);
  t.diagnostic(`sim_start: ${JSON.stringify(start)}`);
  const pinged = new Set(
    lines.filter((l) => l.msg === 'sim_cmd' && l.type === 'ping' && l.result === 'ok').map((l) => l.device_id),
  );
  const connected = new Set(lines.filter((l) => l.msg === 'mqtt_connected').map((l) => l.device_id));
  t.diagnostic(`mqtt_connected: ${connected.size} устройств, ping ok: ${pinged.size} устройств`);
  for (const d of devices) {
    assert.ok(connected.has(d.device_id), `стол ${d.table_number} не подключался`);
    assert.ok(pinged.has(d.device_id), `стол ${d.table_number} не исполнил ping`);
  }
});
