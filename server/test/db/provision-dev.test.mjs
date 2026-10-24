// provision:dev (дефект Н1 M5.1) на временной базе с сидом и поддельным брокером Dynamic Security:
// обслуживаются только устройства клуба сида; контроллеры клуба пользователя (привязанные через
// bind/claim и из заводского реестра) не меняются и в devices.json не попадают; повторный запуск
// оставляет ключи и пароли сида, если они совпадают с файлом.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { createDynsec, deviceRoleAcls, deviceRoleName } from '../../lib/dynsec.mjs';
import { decryptSecret, deviceKeyContext, encryptSecret } from '../../lib/secrets.mjs';
import { provisionSeedDevices, SEED_CLUB_ID } from '../../devices/provision-dev.mjs';
import { createTestDatabase } from '../../../supabase/tests/helpers.mjs';
import { FakeDynsecBroker } from '../fake-dynsec.mjs';

const CLUB_U = 'c7000000-0000-4000-8000-000000000001'; // клуб пользователя (как созданные в M5.1)
const OWNER_U = 'a7000000-0000-4000-8000-000000000001';
const RES_U1 = 'e7000000-0000-4000-8000-000000000001';
const RES_U2 = 'e7000000-0000-4000-8000-000000000002';
const DEV_CLAIMED = 'd7000000-0000-4000-8000-000000000001'; // привязан через bind/claim
const DEV_FACTORY = 'd7000000-0000-4000-8000-000000000002'; // из заводского реестра
const RES_SEED_9 = 'e1000000-0000-4000-8000-000000000009';
const DEV_SEED_CLAIMED = 'd1000000-0000-4000-8000-000000000009'; // в клубе сида, но привязан владельцем
const SEED = (n) => `d1000000-0000-4000-8000-00000000000${n}`;
const FOREIGN = [DEV_CLAIMED, DEV_FACTORY, DEV_SEED_CLAIMED];

let db;
let conn; // одно соединение: provisionSeedDevices ведёт транзакцию begin/commit
let dir;
let file;
const encKey = randomBytes(32);
const broker = new FakeDynsecBroker();
let dynsec;
const userKeys = new Map();
const userPasswords = new Map();
let foreignBefore;

const hash = () => randomBytes(32).toString('hex');

async function deviceRows(ids) {
  const { rows } = await db.pool.query('select id, device_key_enc, mqtt_username, resource_id from bl.devices where id = any($1::uuid[]) order by id', [ids]);
  return rows;
}

function run(opts = {}) {
  return provisionSeedDevices({ db: conn, dynsec, encKey, devicesFile: file, mqttUrl: 'mqtts://localhost:8883', caFile: 'deploy/dev/certs/ca.crt', ...opts });
}

const readFile = () => JSON.parse(readFileSync(file, 'utf8'));

before(async () => {
  db = await createTestDatabase();
  conn = await db.pool.connect();
  dir = mkdtempSync(path.join(tmpdir(), 'bl-provision-'));
  file = path.join(dir, 'devices.json');
  dynsec = await createDynsec(broker);

  // Константы теста, не ввод: многооператорный запрос без параметров.
  await db.pool.query(`
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_U}', 'Клуб пользователя', 'Казань', 'Europe/Moscow');
    insert into bl.users (id, phone) values ('${OWNER_U}', '+70000000701');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_U}', '${OWNER_U}', 'owner');
    insert into bl.resources (id, club_id, type, number, title) values
      ('${RES_U1}', '${CLUB_U}', 'billiard_pool', 1, 'Стол 1'),
      ('${RES_U2}', '${CLUB_U}', 'billiard_pool', 2, 'Стол 2'),
      ('${RES_SEED_9}', '${SEED_CLUB_ID}', 'billiard_pool', 9, 'Стол 9');
  `);
  // Контроллеры с ключами от claim: в базе и в брокере.
  const bound = [
    [DEV_CLAIMED, CLUB_U, RES_U1],
    [DEV_FACTORY, CLUB_U, RES_U2],
    [DEV_SEED_CLAIMED, SEED_CLUB_ID, RES_SEED_9],
  ];
  for (const [id, club, res] of bound) {
    const key = randomBytes(32);
    userKeys.set(id, key);
    await db.pool.query('insert into bl.devices (id, club_id, resource_id, device_key_enc, mqtt_username) values ($1, $2, $3, $4, $5)', [
      id,
      club,
      res,
      encryptSecret(key, encKey, deviceKeyContext(id)),
      id,
    ]);
    const password = randomBytes(24).toString('base64url');
    userPasswords.set(id, password);
    broker.roles.set(deviceRoleName(id), deviceRoleAcls(club, id));
    broker.clients.set(id, { password, clientid: id, roles: [{ rolename: deviceRoleName(id), priority: -1 }], disabled: false });
  }
  for (const [id, club, res] of [
    [DEV_CLAIMED, CLUB_U, RES_U1],
    [DEV_SEED_CLAIMED, SEED_CLUB_ID, RES_SEED_9],
  ]) {
    await db.pool.query(
      `insert into bl.device_bind_windows (club_id, device_id, resource_id, claim_code_hash, created_by, created_at, until, claimed_at)
       values ($1, $2, $3, $4, $5, now() - interval '1 hour', now() - interval '30 minutes', now() - interval '50 minutes')`,
      [club, id, res, hash(), club === CLUB_U ? OWNER_U : 'a1000000-0000-4000-8000-000000000001'],
    );
  }
  await db.pool.query('insert into bl.device_factory (device_id, claim_code_hash, batch) values ($1, $2, $3)', [DEV_FACTORY, hash(), 'T-1']);

  // Прежний файл как после дефекта: в нём и чужие устройства с повторяющимися номерами столов.
  writeFileSync(
    file,
    JSON.stringify({
      devices: bound.map(([id, club], i) => ({
        device_id: id,
        club_id: club,
        table_number: i + 1,
        mqtt_username: id,
        mqtt_password: userPasswords.get(id),
        device_key: userKeys.get(id).toString('base64'),
      })),
    }),
    { mode: 0o600 },
  );
  foreignBefore = await deviceRows(FOREIGN);
});

after(async () => {
  conn?.release();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('provision:dev — только устройства сида (Н1)', () => {
  it('первый запуск: ключи сиду, чужие контроллеры не тронуты, в файле только сид с уникальными столами', async () => {
    const res = await run();
    assert.deepEqual(res, { devices: 8, reused: 0, issued: 8 });

    assert.deepEqual(await deviceRows(FOREIGN), foreignBefore, 'device_key_enc, mqtt_username и стол привязанных не изменились');
    for (const id of FOREIGN) {
      const row = foreignBefore.find((r) => r.id === id);
      assert.ok(decryptSecret(row.device_key_enc, encKey, deviceKeyContext(id)).equals(userKeys.get(id)));
      assert.equal(broker.clients.get(id).password, userPasswords.get(id), `пароль MQTT ${id} прежний`);
    }

    const f = readFile();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(f.devices.length, 8);
    const ids = f.devices.map((d) => d.device_id);
    for (const id of FOREIGN) assert.ok(!ids.includes(id), `${id} нет в devices.json`);
    assert.ok(f.devices.every((d) => d.club_id === SEED_CLUB_ID));
    const tables = f.devices.map((d) => d.table_number);
    assert.equal(new Set(tables).size, tables.length, 'номера столов уникальны');
    assert.deepEqual(tables, [1, 2, 3, 4, 5, 6, 7, 8]);

    const rows = await deviceRows(ids);
    for (const d of f.devices) {
      const row = rows.find((r) => r.id === d.device_id);
      assert.ok(decryptSecret(row.device_key_enc, encKey, deviceKeyContext(d.device_id)).equals(Buffer.from(d.device_key, 'base64')), 'ключ в базе = ключ в файле');
      assert.equal(broker.clients.get(d.device_id).password, d.mqtt_password, 'пароль в брокере = пароль в файле');
      assert.equal(broker.clients.get(d.device_id).clientid, d.device_id);
    }
  });

  it('повторный запуск: ключи и пароли сида прежние, брокер и база не меняются', async () => {
    const before = readFile();
    const rowsBefore = await deviceRows(before.devices.map((d) => d.device_id));
    const mark = broker.log.length;
    const res = await run();
    assert.deepEqual(res, { devices: 8, reused: 8, issued: 0 });
    assert.deepEqual(readFile().devices, before.devices);
    assert.deepEqual(await deviceRows(before.devices.map((d) => d.device_id)), rowsBefore, 'device_key_enc не перешифрован');
    const cmds = broker.log.slice(mark);
    assert.ok(!cmds.some((c) => ['setClientPassword', 'modifyClient', 'createClient', 'createRole', 'removeRoleACL', 'addRoleACL'].includes(c)), cmds.join(','));
    assert.deepEqual(await deviceRows(FOREIGN), foreignBefore);
  });

  it('ключ в файле не совпал — новый только этому устройству; нет клиента в брокере — создаётся с прежним паролем', async () => {
    const prev = readFile();
    prev.devices[0].device_key = randomBytes(32).toString('base64'); // стол 1
    writeFileSync(file, JSON.stringify(prev), { mode: 0o600 });
    broker.clients.delete(SEED(2));
    const res = await run();
    assert.deepEqual(res, { devices: 8, reused: 7, issued: 1 });
    const next = readFile();
    assert.notEqual(next.devices[0].device_key, prev.devices[0].device_key);
    assert.notEqual(next.devices[0].mqtt_password, prev.devices[0].mqtt_password);
    assert.deepEqual(next.devices.slice(1), prev.devices.slice(1));
    assert.equal(broker.clients.get(SEED(2)).password, prev.devices[1].mqtt_password);
    assert.equal(broker.clients.get(SEED(1)).password, next.devices[0].mqtt_password);
    assert.deepEqual(await deviceRows(FOREIGN), foreignBefore);
  });

  it('rotate: новые ключи всем устройствам сида и только им', async () => {
    const prev = readFile();
    const res = await run({ rotate: true });
    assert.deepEqual(res, { devices: 8, reused: 0, issued: 8 });
    const next = readFile();
    for (let i = 0; i < 8; i += 1) assert.notEqual(next.devices[i].device_key, prev.devices[i].device_key);
    assert.deepEqual(await deviceRows(FOREIGN), foreignBefore);
    for (const id of FOREIGN) assert.equal(broker.clients.get(id).password, userPasswords.get(id));
  });
});
