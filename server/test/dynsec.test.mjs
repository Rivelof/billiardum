// Провижининг Dynamic Security без брокера: поддельный клиент отвечает как плагин.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadServerConfig } from '../lib/config.mjs';
import {
  createDynsec,
  deviceRoleAcls,
  deviceRoleName,
  ensureServerClient,
  SERVER_CLIENT_ID,
  serverRoleAcls,
} from '../lib/dynsec.mjs';
import { FakeDynsecBroker } from './fake-dynsec.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const DEV = 'd1000000-0000-4000-8000-000000000001';

describe('ACL ролей (protocol §2)', () => {
  it('устройство: читает только свой cmd, пишет только свои ack, state, event, status', () => {
    const base = `bl/v1/${CLUB}/${DEV}`;
    assert.deepEqual(
      deviceRoleAcls(CLUB, DEV).map((a) => `${a.acltype} ${a.topic} ${a.allow}`),
      [
        `subscribeLiteral ${base}/cmd true`,
        `publishClientReceive ${base}/cmd true`,
        `publishClientSend ${base}/ack true`,
        `publishClientSend ${base}/state true`,
        `publishClientSend ${base}/event true`,
        `publishClientSend ${base}/status true`,
      ],
    );
    assert.ok(deviceRoleAcls(CLUB, DEV).every((a) => !a.topic.includes('+') && !a.topic.includes('#')), 'без шаблонов');
  });

  it('сервер: bl/v1/# и ничего про $CONTROL', () => {
    assert.ok(serverRoleAcls().every((a) => a.topic === 'bl/v1/#'));
  });
});

describe('ensureRole и ensureClient', () => {
  it('создают роль и клиента, повторный запуск обновляет пароль и не плодит ACL', async () => {
    const broker = new FakeDynsecBroker();
    const dynsec = await createDynsec(broker);
    const role = deviceRoleName(DEV);

    assert.equal(await dynsec.ensureRole(role, deviceRoleAcls(CLUB, DEV), 'Стол 1'), 'created');
    assert.equal(await dynsec.ensureClient({ username: DEV, password: 'p1-aaaaaaaaaaaa', clientid: DEV, rolename: role }), 'created');
    assert.deepEqual(broker.clients.get(DEV), { password: 'p1-aaaaaaaaaaaa', clientid: DEV, roles: [{ rolename: role, priority: -1 }], disabled: false });

    broker.clients.get(DEV).disabled = true;
    broker.roles.get(role).push({ acltype: 'publishClientSend', topic: 'bl/v1/#', priority: 0, allow: true });
    assert.equal(await dynsec.ensureRole(role, deviceRoleAcls(CLUB, DEV), 'Стол 1'), 'updated');
    assert.equal(await dynsec.ensureClient({ username: DEV, password: 'p2-bbbbbbbbbbbb', clientid: DEV, rolename: role }), 'updated');

    assert.deepEqual(broker.roles.get(role), deviceRoleAcls(CLUB, DEV), 'лишний ACL удалён, нужные на месте');
    assert.equal(broker.clients.get(DEV).password, 'p2-bbbbbbbbbbbb');
    assert.equal(broker.clients.get(DEV).disabled, false);
  });

  it('клиент сервера: client id закреплён как bl-server, в том числе у уже созданного клиента без него', async () => {
    const broker = new FakeDynsecBroker();
    const dynsec = await createDynsec(broker);
    assert.equal(SERVER_CLIENT_ID, 'bl-server');
    assert.equal(await ensureServerClient(dynsec, { username: 'bl-server', password: 's1-aaaaaaaaaaaa' }), 'created');
    assert.deepEqual(broker.clients.get('bl-server'), {
      password: 's1-aaaaaaaaaaaa',
      clientid: 'bl-server',
      roles: [{ rolename: 'bl-server', priority: -1 }],
      disabled: false,
    });
    assert.deepEqual(broker.roles.get('bl-server'), serverRoleAcls());
    // Клиент из прошлой версии провижининга — без закреплённого client id.
    broker.clients.get('bl-server').clientid = undefined;
    assert.equal(await ensureServerClient(dynsec, { username: 'bl-server', password: 's2-bbbbbbbbbbbb' }), 'updated');
    assert.equal(broker.clients.get('bl-server').clientid, 'bl-server');
    assert.equal(broker.clients.get('bl-server').password, 's2-bbbbbbbbbbbb');
  });

  it('сервер подключается именно с закреплённым client id', () => {
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://app_api@localhost/postgres',
      MQTT_URL: 'mqtts://localhost:8883',
      MQTT_CA_FILE: 'deploy/dev/certs/ca.crt',
      MQTT_SERVER_USER: 'bl-server',
      MQTT_SERVER_PASSWORD: 'x'.repeat(16),
      SECRETS_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
      MQTT_CLIENT_ID: 'something-else',
    });
    assert.equal(config.mqtt.clientId, SERVER_CLIENT_ID);
  });

  it('ошибка плагина — исключение с кодом команды', async () => {
    const broker = new FakeDynsecBroker();
    const dynsec = await createDynsec(broker);
    await assert.rejects(dynsec.run({ command: 'bogus' }), /dynsec bogus: Unknown command/);
  });
});
