// provision:dev (pentester П-3): .env загружается целиком до проверок; NODE_ENV=production из
// файла — отказ; нет клуба сида в базе — отказ до подключения к брокеру.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { assertNotProduction, loadDotEnv, main } from '../bin/provision-dev.mjs';
import { SEED_CLUB_ID } from '../devices/provision-dev.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'bl-provision-bin-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const envFile = (name, text) => {
  const f = path.join(dir, name);
  writeFileSync(f, text);
  return f;
};

const FULL = {
  DATABASE_ADMIN_URL: 'postgres://admin@127.0.0.1:1/bl',
  MQTT_URL: 'mqtts://127.0.0.1:1',
  MQTT_CA_FILE: 'package.json', // любой читаемый файл: до брокера дело не доходит
  MQTT_ADMIN_USER: 'bl-admin',
  MQTT_ADMIN_PASSWORD: 'x'.repeat(24),
  MQTT_SERVER_USER: 'bl-server',
  MQTT_SERVER_PASSWORD: 'y'.repeat(24),
  SECRETS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/** Поддельная база: строки bl.clubs по запросу клуба сида. */
function fakeDb(clubRows) {
  const calls = [];
  return {
    calls,
    makeDb: () => ({
      async connect() {
        calls.push('connect');
      },
      async query(sql, params) {
        calls.push(sql);
        if (sql.includes('from bl.clubs')) {
          assert.deepEqual(params, [SEED_CLUB_ID]);
          return { rows: clubRows };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      async end() {
        calls.push('end');
      },
    }),
  };
}

describe('provision:dev — порядок отказов (П-3)', () => {
  it('loadDotEnv: файл целиком, окружение главнее, пустая переменная — незаданная', () => {
    const f = envFile('a.env', 'NODE_ENV=production\nMQTT_URL=mqtts://file\nEMPTY=from-file\n');
    const target = { MQTT_URL: 'mqtts://env', EMPTY: '' };
    loadDotEnv(target, f);
    assert.deepEqual(target, { MQTT_URL: 'mqtts://env', EMPTY: 'from-file', NODE_ENV: 'production' });
    assert.deepEqual(loadDotEnv({ A: '1' }, path.join(dir, 'нет.env')), { A: '1' }, 'нет файла — окружение как есть');
    assert.throws(() => assertNotProduction({ NODE_ENV: 'production' }), /NODE_ENV=production/);
    assert.doesNotThrow(() => assertNotProduction({ NODE_ENV: 'development' }));
  });

  it('NODE_ENV=production только в .env, остальное в окружении — отказ до базы и брокера', async () => {
    const f = envFile('prod.env', 'NODE_ENV=production\n');
    const db = fakeDb([{ '?column?': 1 }]);
    let mqtt = 0;
    await assert.rejects(
      main({ target: { ...FULL }, envFile: f, argv: [], makeDb: db.makeDb, connectMqtt: async () => mqtt++ }),
      /NODE_ENV=production/,
    );
    assert.equal(mqtt, 0);
    assert.deepEqual(db.calls, []);
  });

  it('нет клуба сида в базе — отказ до подключения к брокеру, соединение с базой закрыто', async () => {
    const f = envFile('dev.env', 'NODE_ENV=development\n');
    const db = fakeDb([]);
    let mqtt = 0;
    await assert.rejects(
      main({ target: { ...FULL }, envFile: f, argv: [], makeDb: db.makeDb, connectMqtt: async () => mqtt++ }),
      /нет клуба сида/,
    );
    assert.equal(mqtt, 0, 'брокер не трогали');
    assert.equal(db.calls.at(-1), 'end');
  });

  it('клуб сида есть — дальше подключение к брокеру', async () => {
    const f = envFile('dev2.env', '');
    const db = fakeDb([{ '?column?': 1 }]);
    let mqtt = 0;
    await assert.rejects(
      main({
        target: { ...FULL },
        envFile: f,
        argv: [],
        makeDb: db.makeDb,
        connectMqtt: async () => {
          mqtt++;
          throw new Error('broker down');
        },
      }),
      /broker down/,
    );
    assert.equal(mqtt, 1);
    assert.equal(db.calls.at(-1), 'end');
  });
});
