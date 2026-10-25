// Критерий 1: симулятор показывает все устройства сида онлайн в логе сервера:
// строка devices_online N/N и cmd_ack ok на ping от каждого из N устройств.
// С M5.8 (сид 1300_padel.sql) N = 10: столы 1–8 и 2 корта (в devices.json — table_number 101, 102).
// В строке devices_online `online` — подключённые устройства (у симулятора их N, все — сида), а `total` — устройства
// ВСЕЙ базы, в том числе тестовых клубов других проверок (у них контроллера в симуляторе нет): поэтому
// сравниваем `online === N` и `total >= N`, а в базе считаем устройства клуба сида (`club_id = CLUB_A`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminClient, CLUB_A, containerLog, loadDevices, SERVER_CONTAINER, SIM_CONTAINER } from './helpers.mjs';

const devices = loadDevices();
/** Устройства сида: столы 1–8 и корты M5.8 (101, 102). */
const SEED_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 101, 102];
const N = SEED_NUMBERS.length;

test(`devices.json: ${N} устройств сида (столы 1–8, корты 101–102), у каждого свой ключ`, () => {
  assert.equal(devices.length, N);
  assert.deepEqual(
    devices.map((d) => d.table_number),
    SEED_NUMBERS,
  );
  for (const d of devices) {
    assert.equal(d.mqtt_username, d.device_id);
    assert.equal(Buffer.from(d.device_key, 'base64').length, 32);
  }
  assert.equal(new Set(devices.map((d) => d.device_key)).size, N, 'ключи устройств разные');
  assert.equal(new Set(devices.map((d) => d.mqtt_password)).size, N, 'пароли MQTT разные');
});

test(`лог сервера: devices_online ${N}/… (online = ${N} устройств сида, total — все устройства базы)`, async (t) => {
  const db = await adminClient();
  let seedTotal;
  let allTotal;
  try {
    seedTotal = Number((await db.query('select count(*) from bl.devices where club_id = $1', [CLUB_A])).rows[0].count);
    allTotal = Number((await db.query('select count(*) from bl.devices')).rows[0].count);
  } finally {
    await db.end();
  }
  const lines = containerLog(SERVER_CONTAINER).filter((l) => l.msg === 'devices_online');
  assert.ok(lines.length > 0, 'нет строк devices_online');
  const reached = lines.find((l) => l.online === N && l.total >= N);
  const last = lines.at(-1);
  t.diagnostic(`первая online=${N}: ${JSON.stringify(reached)}`);
  t.diagnostic(`последняя: ${JSON.stringify(last)}; устройств в bl.devices: клуб сида ${seedTotal}, вся база ${allTotal}`);
  assert.ok(reached, `в логе нет devices_online с online=${N}`);
  assert.equal(seedTotal, N, 'устройств клуба сида');
  assert.equal(last.online, N, 'онлайн — ровно устройства симулятора');
  // total — вся база: не меньше устройств сида; чужие тестовые клубы могут добавиться между строкой лога и запросом,
  // поэтому верхняя граница — число сейчас.
  assert.ok(last.total >= N && last.total <= allTotal, `total в логе ${last.total} вне [${N}; ${allTotal}]`);
  // Сервер повторяет строку раз в 60 с — последняя не старше 70 с.
  assert.ok(Date.now() - Date.parse(last.t) < 70_000, `последняя devices_online старая: ${last.t}`);
});

test(`лог сервера: cmd_ack ok для ping от всех ${N} устройств`, (t) => {
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

test(`лог симулятора: ${N} устройств подключены, ping исполнен у каждого`, (t) => {
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
