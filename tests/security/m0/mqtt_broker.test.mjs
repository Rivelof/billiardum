// PoC безопасности M0 — брокер MQTT (объект атаки 3, docs/contracts/m0.md §2, protocol §2).
// Атакующий: посторонний (анонимно/без ключей) и устройство с украденной учёткой.
// Проверяется: анонимный вход запрещён; вход без пароля/с чужим client id запрещён;
// устройство не читает и не пишет чужие топики, не пишет в свой cmd, не лезет в
// $CONTROL/dynamic-security и $SYS. Секреты не печатаются.
//
// Тест кратковременно подключается под client id device8 (захватывает сессию симулятора)
// и в конце ждёт восстановления онлайна, чтобы сервер снова видел 8/8.
//
// Запуск: node --test tests/security/m0/mqtt_broker.test.mjs

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import mqtt from 'mqtt';
import { ca, devices, mqttUrl } from './_env.mjs';

const URL = mqttUrl();
const CA = ca();
const DEVS = devices().devices;
const d8 = DEVS.find((d) => /0{11}8$/.test(d.device_id)) || DEVS[7];
const d7 = DEVS.find((d) => /0{11}7$/.test(d.device_id)) || DEVS[6];
const clubId = d8.club_id;
const T = (dev, kind) => `bl/v1/${dev.club_id}/${dev.device_id}/${kind}`;

function tryConnect(opts, ms = 6000) {
  return new Promise((resolve) => {
    const c = mqtt.connect(URL, { rejectUnauthorized: true, protocolVersion: 4, clean: true, reconnectPeriod: 0, connectTimeout: ms, ...opts, ca: CA });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { c.end(true); } catch { /* ignore */ } resolve(r); } };
    c.on('connect', () => finish({ ok: true }));
    c.on('error', (err) => finish({ ok: false, code: err.code || err.message }));
    c.on('close', () => finish({ ok: false, code: 'closed' }));
    setTimeout(() => finish({ ok: false, code: 'timeout' }), ms + 500);
  });
}

test('анонимный вход в брокер запрещён (allow_anonymous false)', async () => {
  const r = await tryConnect({ clientId: 'bl-pentest-anon' });
  assert.equal(r.ok, false, 'брокер не должен пускать без логина');
});

test('вход с логином устройства, но с чужим client id — отказ (client id закреплён)', async () => {
  // Верный логин/пароль устройства, но client id не равен device_id: Dynamic Security
  // создаёт клиента с обязательным clientid, поэтому подключение отвергается и
  // существующую сессию устройства не захватывает.
  const r = await tryConnect({ clientId: 'bl-pentest-hijack', username: d8.mqtt_username, password: d8.mqtt_password });
  assert.equal(r.ok, false, 'client id, не равный device_id, должен отвергаться');
});

test('вход с логином устройства и неверным паролем — отказ', async () => {
  const r = await tryConnect({ clientId: 'bl-pentest-badpw', username: d8.mqtt_username, password: 'wrong-password-xxxxxxxx' });
  assert.equal(r.ok, false, 'неверный пароль должен отвергаться');
});

test('устройство ограничено своими топиками; cmd, чужое, $CONTROL и $SYS — запрещены', async (t) => {
  // Полноценная учётка device8 с верным client id: это кратковременно выбивает симулятор.
  const c = await new Promise((resolve, reject) => {
    const client = mqtt.connect(URL, {
      clientId: d8.device_id, username: d8.mqtt_username, password: d8.mqtt_password,
      ca: CA, rejectUnauthorized: true, protocolVersion: 5, clean: true, reconnectPeriod: 0, connectTimeout: 6000,
    });
    client.on('connect', () => resolve(client));
    client.on('error', reject);
    setTimeout(() => reject(new Error('device8 connect timeout')), 7000);
  });

  const sub = (topic) => new Promise((resolve) => {
    c.subscribe(topic, { qos: 1 }, (err, granted) => {
      if (err) return resolve({ granted: false, code: err.code || 'err' });
      const g = granted && granted[0];
      resolve({ granted: g && g.qos !== 128, qos: g ? g.qos : null });
    });
  });
  const pub = (topic, payload = 'x') => new Promise((resolve) => {
    c.publish(topic, payload, { qos: 1 }, (err, packet) => {
      const rc = packet && typeof packet.reasonCode === 'number' ? packet.reasonCode : null;
      // v5: reasonCode >= 0x80 — не авторизовано. err — тоже отказ.
      resolve({ accepted: !err && (rc === null || rc < 0x80), reasonCode: rc, err: err ? (err.code || err.message) : null });
    });
  });

  try {
    // Разрешено своё.
    await t.test('подписка на свой cmd разрешена', async () => {
      assert.equal((await sub(T(d8, 'cmd'))).granted, true);
    });
    await t.test('публикация своего state разрешена', async () => {
      const r = await pub(T(d8, 'state'), JSON.stringify({ v: 1, state_seq: 1, mode: 'free' }));
      assert.equal(r.accepted, true, `ожидали приём своего state, reasonCode=${r.reasonCode}`);
    });

    // Запрещено своё опасное: публикация в собственный cmd (инъекция команды себе).
    await t.test('публикация в свой cmd запрещена (устройство не командует собой)', async () => {
      const r = await pub(T(d8, 'cmd'), 'x');
      assert.equal(r.accepted, false, `устройство не должно писать в свой cmd (reasonCode=${r.reasonCode})`);
    });

    // Запрещено чужое.
    await t.test('подписка на чужой cmd запрещена', async () => {
      assert.equal((await sub(T(d7, 'cmd'))).granted, false);
    });
    await t.test('подписка на чужой state запрещена', async () => {
      assert.equal((await sub(T(d7, 'state'))).granted, false);
    });
    await t.test('публикация чужого cmd запрещена', async () => {
      assert.equal((await pub(T(d7, 'cmd'), 'x')).accepted, false);
    });
    await t.test('подмена чужого state запрещена', async () => {
      const r = await pub(T(d7, 'state'), JSON.stringify({ v: 1, state_seq: 99, mode: 'active' }));
      assert.equal(r.accepted, false, 'нельзя публиковать state другого устройства');
    });
    await t.test('подмена чужого status (Last Will в чужой топик) запрещена', async () => {
      assert.equal((await pub(T(d7, 'status'), 'offline')).accepted, false);
    });

    // Запрещены широкие и служебные топики.
    await t.test('подписка на bl/v1/# запрещена', async () => {
      assert.equal((await sub('bl/v1/#')).granted, false);
    });
    await t.test('подписка на весь свой клуб запрещена', async () => {
      assert.equal((await sub(`bl/v1/${clubId}/#`)).granted, false);
    });
    await t.test('подписка на $SYS/# запрещена', async () => {
      assert.equal((await sub('$SYS/#')).granted, false);
    });
    await t.test('подписка на ответы Dynamic Security запрещена', async () => {
      assert.equal((await sub('$CONTROL/dynamic-security/v1/response')).granted, false);
    });
    await t.test('управление Dynamic Security ($CONTROL) запрещено', async () => {
      const r = await pub('$CONTROL/dynamic-security/v1', JSON.stringify({ commands: [{ command: 'getDefaultACLAccess' }] }));
      assert.equal(r.accepted, false, 'устройство не должно управлять Dynamic Security');
    });
  } finally {
    c.end(true);
  }
});

// Восстановление: ждём, пока симулятор вернёт device8 онлайн (reconnectPeriod 3 с).
after(async () => {
  await new Promise((r) => setTimeout(r, 6000));
});
