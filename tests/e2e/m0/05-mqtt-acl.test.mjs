// Критерий 4: устройство не читает и не пишет чужие топики и не пишет в свой cmd.
//
// Учётка стола 1 из deploy/dev/devices.json (client id = device_id обязателен, поэтому
// на время проверки брокер отключает симулятор этого стола; он переподключается сам через 3 с).
// Свидетель — второе подключение под учёткой администратора брокера (MQTT_ADMIN_USER) со своим
// client id: подписан на bl/v1/#, видит всё, что брокер принял. Проверка дважды: MQTT 5 (коды отказа
// в SUBACK/PUBACK) и MQTT 3.1.1 (как прошивка ESP32: отказ публикации молчаливый).
// В конце: симулятор восстановился — сервер снова пишет devices_online 8/8.

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import {
  adminClient,
  connectMqtt,
  connectObserver,
  containerLog,
  env,
  loadDevices,
  publishQos1,
  SERVER_CONTAINER,
  signCommand,
  sleep,
  subscribeEach,
  topic,
  waitAllOnline,
  waitFor,
} from './helpers.mjs';

const devices = loadDevices();
const A = devices.find((d) => d.table_number === 1);
const B = devices.find((d) => d.table_number === 2);
const tA = (k) => topic(A.club_id, A.device_id, k);
const tB = (k) => topic(B.club_id, B.device_id, k);

const DENIED_V5 = 135; // 0x87 Not authorized
const DENIED_V4 = 128; // 0x80 Failure

let observer;
let startedAt;

before(async () => {
  startedAt = new Date();
  observer = await connectObserver();
  const granted = await subscribeEach(observer.client, ['bl/v1/#']);
  assert.equal(granted['bl/v1/#'], 1, 'свидетель (учётка администратора брокера) должен получить bl/v1/#');
  await sleep(1500); // retained state/status всех столов
});

after(async () => {
  await observer?.client.endAsync();
});

async function lastSeq(deviceId) {
  const db = await adminClient();
  try {
    return Number((await db.query('select last_seq from bl.devices where id = $1', [deviceId])).rows[0].last_seq);
  } finally {
    await db.end();
  }
}

/** Одна сессия под учёткой стола A: подписки и публикации, всё — за ~1 с. */
async function probeAsDevice(protocolVersion, t) {
  const tag = `e2e-acl-${randomBytes(4).toString('hex')}`;
  const seq = (await lastSeq(A.device_id)) + 1;
  const ping = { v: 1, id: randomUUID(), seq, type: 'ping', issued_at: Math.floor(Date.now() / 1000), body: {} };
  ping.sig = signCommand(ping, A.device_key).sig;
  const controlAck = { v: 1, cmd_id: randomUUID(), seq: null, ok: false, error: 'bad_format', state_seq: null };
  const mark = observer.messages.length;
  const t0 = Date.now();

  const dev = await connectMqtt({ clientId: A.device_id, username: A.mqtt_username, password: A.mqtt_password, protocolVersion });
  const received = [];
  let kicked = false;
  dev.on('message', (tp, p) => received.push({ topic: tp, payload: p.toString('utf8') }));
  dev.on('close', () => (kicked = true));

  const subs = await subscribeEach(dev, [
    tA('cmd'), // своё — разрешено (положительный контроль)
    tB('cmd'),
    tB('state'),
    tA('state'),
    tA('ack'),
    `bl/v1/${A.club_id}/${A.device_id}/#`,
    `bl/v1/${A.club_id}/+/cmd`,
    'bl/v1/+/+/cmd',
    'bl/v1/#',
    '#',
    '$SYS/#',
    '$CONTROL/dynamic-security/v1/response',
  ]);

  const otherClub = randomUUID();
  const probes = {
    [`свой cmd (подписанный ping seq=${seq})`]: [tA('cmd'), JSON.stringify(ping), ping.id],
    'чужой cmd (стол 2)': [tB('cmd'), JSON.stringify({ ...ping, id: randomUUID() }).replace(/"id":"[^"]+"/, `"id":"${tag}-cmd"`), `${tag}-cmd`],
    'чужой state (стол 2)': [tB('state'), `${tag}-state`, `${tag}-state`],
    'чужой status (стол 2)': [tB('status'), `${tag}-status`, `${tag}-status`],
    'чужой ack (стол 2)': [tB('ack'), `${tag}-ack`, `${tag}-ack`],
    'чужой event (стол 2)': [tB('event'), `${tag}-event`, `${tag}-event`],
    'свой state под чужим club_id': [topic(otherClub, A.device_id, 'state'), `${tag}-club`, `${tag}-club`],
    'топик вне bl/v1': [`bl/v2/${A.club_id}/${A.device_id}/state`, `${tag}-v2`, `${tag}-v2`],
    '$CONTROL/dynamic-security (только чтение)': [
      '$CONTROL/dynamic-security/v1',
      JSON.stringify({ commands: [{ command: 'getDefaultACLAccess', correlationData: `${tag}-dynsec` }] }),
      `${tag}-dynsec`,
    ],
  };
  const pubs = {};
  for (const [name, [tp, payload]] of Object.entries(probes)) pubs[name] = await publishQos1(dev, tp, payload);
  // Положительный контроль: свой ack разрешён (сервер его проигнорирует: cmd_id не его команды).
  const allowed = await publishQos1(dev, tA('ack'), JSON.stringify(controlAck));
  const elapsed = Date.now() - t0;
  assert.equal(kicked, false, 'симулятор выбил проверочное подключение раньше конца проверки — повторите');
  await dev.endAsync();
  await sleep(1500); // свидетель досчитывает доставленное

  const seen = observer.messages.slice(mark);
  t.diagnostic(`MQTT ${protocolVersion === 5 ? '5' : '3.1.1'}: сессия стола 1 длилась ${elapsed} мс`);
  for (const [f, code] of Object.entries(subs)) t.diagnostic(`  SUBSCRIBE ${f} → ${code}`);
  for (const [name, r] of Object.entries(pubs)) {
    const leaked = seen.filter((m) => m.payload.includes(probes[name][2]));
    t.diagnostic(`  PUBLISH ${name} → PUBACK ${r.ok ? r.code : `${r.code} (${r.message})`}; свидетель получил: ${leaked.length}`);
  }
  t.diagnostic(`  PUBLISH свой ack (контроль) → PUBACK ${allowed.ok ? allowed.code : allowed.code}; свидетель получил: ${seen.filter((m) => m.payload.includes(controlAck.cmd_id)).length}`);
  t.diagnostic(`  сообщения, пришедшие самому устройству: ${received.length ? received.map((m) => m.topic).join(', ') : 'нет'}`);
  return { subs, pubs, probes, allowed, seen, received, controlAck, t0 };
}

function checkProbe(r, protocolVersion) {
  const deny = protocolVersion === 5 ? DENIED_V5 : DENIED_V4;
  for (const [f, code] of Object.entries(r.subs)) {
    if (f === tA('cmd')) assert.equal(code, 1, `своя подписка на cmd должна быть разрешена (${f})`);
    else assert.equal(code, deny, `подписка ${f} разрешена: код ${code}`);
  }
  for (const [name, [, , marker]] of Object.entries(r.probes)) {
    const leaked = r.seen.filter((m) => m.payload.includes(marker));
    assert.equal(leaked.length, 0, `${name}: сообщение дошло до подписчиков`);
    assert.ok(!r.received.some((m) => m.payload.includes(marker)), `${name}: сообщение вернулось устройству`);
    if (protocolVersion === 5) assert.equal(r.pubs[name].code, DENIED_V5, `${name}: брокер не ответил Not authorized`);
  }
  // Положительный контроль: разрешённая публикация доходит — значит, свидетель работает.
  assert.equal(r.allowed.ok, true, 'свой ack должен публиковаться');
  assert.equal(r.seen.filter((m) => m.payload.includes(r.controlAck.cmd_id)).length, 1, 'свидетель не увидел разрешённую публикацию');
  assert.deepEqual(r.received, [], 'устройству пришли чужие или свои публикации');
}

async function waitSimBack(t0, t) {
  // Симулятор стола 1 снова публикует online (retained) после переподключения.
  const back = await waitFor(
    () => observer.messages.find((m) => m.at > t0 && m.topic === tA('status') && m.payload === 'online'),
    { timeoutMs: 20_000, what: 'status online стола 1 от симулятора' },
  );
  t.diagnostic(`  симулятор стола 1 переподключился через ${back.at - t0} мс`);
}

test('учётка устройства: MQTT 5 — подписки и публикации вне своих топиков и в свой cmd запрещены', async (t) => {
  const r = await probeAsDevice(5, t);
  checkProbe(r, 5);
  await waitSimBack(r.t0, t);
});

test('учётка устройства: MQTT 3.1.1 — то же, отказ публикации молчаливый, но ничего не доходит', async (t) => {
  await sleep(5000); // симулятор стола 1 успел подписаться и получить ping после первой проверки
  const r = await probeAsDevice(4, t);
  checkProbe(r, 4);
  await waitSimBack(r.t0, t);
});

test('вход: учётки устройства и сервера только со своим client id; анонимно и с чужим паролем — отказ', async (t) => {
  // Отказ при входе симулятор не выбивает: сессия не создаётся.
  const cases = [
    ['логин стола 1, client id другой', { clientId: `${A.device_id}-e2e`, username: A.mqtt_username, password: A.mqtt_password }],
    ['логин стола 1, client id стола 2', { clientId: B.device_id, username: A.mqtt_username, password: A.mqtt_password }],
    ['логин стола 1, пароль стола 2', { clientId: A.device_id, username: A.mqtt_username, password: B.mqtt_password }],
    ['анонимно', { clientId: `bl-e2e-anon-${randomBytes(3).toString('hex')}` }],
    // Учётка сервера закреплена за client id 'bl-server'; с ним самим не входим — выбьем сервер.
    [
      'логин сервера, чужой client id',
      { clientId: `bl-e2e-srv-${randomBytes(3).toString('hex')}`, username: env('MQTT_SERVER_USER'), password: env('MQTT_SERVER_PASSWORD') },
    ],
    ['логин сервера, client id стола 1', { clientId: A.device_id, username: env('MQTT_SERVER_USER'), password: env('MQTT_SERVER_PASSWORD') }],
  ];
  for (const [name, opts] of cases) {
    let res;
    try {
      const c = await connectMqtt(opts);
      await c.endAsync();
      res = 'ПОДКЛЮЧИЛСЯ';
    } catch (err) {
      res = `отказ: ${err.code ?? ''} ${err.message}`;
    }
    t.diagnostic(`${name}: ${res}`);
    assert.notEqual(res, 'ПОДКЛЮЧИЛСЯ', name);
  }
});

test(`после проверок сервер не принял ни одной подделки и снова видит ${devices.length}/${devices.length}`, async (t) => {
  // С M5.8 устройств сида 10 (столы 1–8 и 2 корта) — число берётся из devices.json.
  const last = await waitAllOnline(startedAt, devices.length, { timeoutMs: 75_000 });
  t.diagnostic(`devices_online после проверки: ${JSON.stringify(last)}`);
  const lines = containerLog(SERVER_CONTAINER, { since: startedAt });
  const suspicious = lines.filter((l) =>
    ['status_bad_format', 'state_bad_format', 'event_bad_format', 'ack_bad_format', 'device_club_mismatch', 'device_unknown', 'ack_unmatched'].includes(l.msg) &&
    l.level !== 'debug',
  );
  for (const l of lines.filter((x) => x.device_id === A.device_id || x.msg === 'devices_online')) {
    t.diagnostic(`  ${JSON.stringify(l)}`);
  }
  assert.deepEqual(suspicious, [], 'сервер обработал подложенное сообщение');
  // Сервер не видел чужих сообщений стола 2 за время проверки.
  assert.equal(lines.filter((l) => l.device_id === B.device_id && l.level !== 'info').length, 0);
});
