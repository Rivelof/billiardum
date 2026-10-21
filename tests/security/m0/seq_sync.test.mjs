// PoC безопасности M0 — сверка seq (объект атаки 4, protocol §6, decisions №37).
// Вопрос: устройство с украденной учёткой публикует поддельный state с большим last_seq.
// Может ли это заставить сервер поднять seq так, что НАСТОЯЩИЙ контроллер перестанет
// принимать команды? Проверяется реальной server/lib/store.mjs allocateCommand во
// временной базе + таблицей повторов симулятора (lib/replay.mjs).
//
// Вывод: подъём ограничен (gap ≤ 1e6, иначе тревога без подъёма), счётчик только растёт
// и никогда не опускается; контроллер принимает любой seq строго больше сохранённого,
// поэтому поднятый seq его не блокирует. DoS не достигается.
//
// Запуск: node --test tests/security/m0/seq_sync.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createStore } from '../../../server/lib/store.mjs';
import { decideReplay } from '../../../tools/device-sim/lib/replay.mjs';
import { CLUB_A, createTempDb } from './_db.mjs';

const DEVICE = 'd1000000-0000-4000-8000-000000000001';
let db; let store;

before(async () => {
  db = await createTempDb();
  // Дадим устройству непустой device_key_enc, чтобы allocateCommand дошёл до выделения seq
  // (build мы подменяем и ключ не расшифровываем).
  await db.pool.query("update bl.devices set device_key_enc = 'v1:dummy' where id = $1", [DEVICE]);
  store = createStore(db.pool);
});
after(async () => { if (db) await db.drop(); });

const build = () => 'payload';
async function alloc(stateLastSeq) {
  return store.allocateCommand({ clubId: CLUB_A, deviceId: DEVICE, cmdId: randomUUID(), type: 'ping', stateLastSeq, seqGapLimit: 1_000_000, build });
}
async function dbSeq() {
  const { rows } = await db.pool.query('select last_seq::bigint ls from bl.devices where id = $1', [DEVICE]);
  return Number(rows[0].ls);
}
async function seqSyncCount() {
  const { rows } = await db.pool.query(
    "select count(*)::int n from bl.audit_log where action = 'device.seq_sync' and object_id = $1",
    [DEVICE],
  );
  return rows[0].n;
}

test('базовая команда: seq растёт на 1', async () => {
  const r = await alloc(null);
  assert.equal(r.status, 'ok');
  assert.equal(r.seq, 1);
  assert.equal(await dbSeq(), 1);
});

test('поддельный большой state (в пределах gap) поднимает seq и пишет device.seq_sync', async () => {
  const before = await dbSeq();
  const attackerSeq = before + 500_000;
  const r = await alloc(attackerSeq);
  assert.equal(r.status, 'ok');
  assert.ok(r.seqSync, 'подъём по state должен фиксироваться device.seq_sync');
  assert.equal(r.seq, attackerSeq + 1, 'seq поднят до state+1');
  assert.equal(await dbSeq(), attackerSeq + 1);
  assert.equal(await seqSyncCount(), 1, 'ровно одна запись device.seq_sync');
});

test('поднятый seq НЕ блокирует настоящий контроллер (он принимает любой seq больше сохранённого)', async () => {
  // Настоящий контроллер в NVS хранит seq последней принятой им команды, например 1.
  const controllerSaved = { seq: 1, id: randomUUID() };
  const serverSeq = await dbSeq(); // уже поднят атакующим до ~500001
  assert.ok(serverSeq > controllerSaved.seq);
  // Следующая команда сервера уйдёт с seq = serverSeq+... > controllerSaved.seq → execute.
  assert.equal(decideReplay(controllerSaved, serverSeq, randomUUID()), 'execute',
    'контроллер обязан исполнить команду с seq больше сохранённого — DoS не достигается');
});

test('разрыв больше 1e6 — тревога без подъёма счётчика (seq не улетает)', async () => {
  const before = await dbSeq();
  const r = await alloc(before + 2_000_000);
  assert.equal(r.status, 'ok');
  assert.ok(r.seqGap, 'разрыв > 1e6 должен давать seqGap (тревога)');
  assert.equal(r.seqSync, null, 'при большом разрыве подъёма нет');
  assert.equal(r.seq, before + 1, 'seq вырос только на 1, не на 2 млн');
});

test('поддельный МЕНЬШИЙ state не опускает seq (счётчик только растёт)', async () => {
  const before = await dbSeq();
  const r = await alloc(1); // атакующий пытается откатить seq назад
  assert.equal(r.status, 'ok');
  assert.equal(r.seqSync, null);
  assert.equal(r.seq, before + 1, 'seq нельзя опустить чужим state');
  assert.ok(await dbSeq() > 1);
});
