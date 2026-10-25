// Устройства сида для npm run provision:dev (только разработка, контракт M0 §1, §4; дефект Н1 M5.1).
//
// Обслуживаются только контроллеры клуба сида (SEED_CLUB_ID из supabase/seed.sql), у которых
// есть стол и которые не привязаны владельцем: нет ни заводской записи (bl.device_factory),
// ни принятого окна привязки (bl.device_bind_windows.claimed_at). Контроллеры остальных клубов
// и привязанные через bind/claim провижининг не читает, ключи и пароли MQTT им не меняет и в
// devices.json не пишет.
//
// Ключи сида переиспользуются: если device_key в базе расшифровывается в тот же ключ, что у
// устройства в прежнем devices.json, остаются прежние device_key и пароль MQTT, а клиента в
// брокере, который уже настроен (client id, роль, не отключён), провижининг не трогает —
// работающий симулятор не отключается. Иначе (нет файла, нет ключа, ключ другой, rotate) —
// новый ключ (32 байта) и пароль, база → брокер → файл.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { deviceRoleAcls, deviceRoleName } from '../lib/dynsec.mjs';
import { decryptSecret, deviceKeyContext, encryptSecret } from '../lib/secrets.mjs';
import { resourceName } from '../lib/resource-kinds.mjs';

/** Клуб сида (supabase/seed.sql). */
export const SEED_CLUB_ID = 'c1000000-0000-4000-8000-000000000001';
/**
 * Номер симулятора у корта (M5.8): своя нумерация кортов (корт 1, 2) пересекается со столами 1–8,
 * а симулятор различает контроллеры по table_number — корт N получает table_number 100 + N.
 */
export const COURT_SIM_OFFSET = 100;

const PASSWORD = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Клуб сида есть в базе (pentester П-3): иначе отказ до брокера — провижининг не трогает
 * Dynamic Security, если база не та (без сида).
 * @param {import('pg').ClientBase} db — суперпользователь (DATABASE_ADMIN_URL)
 */
export async function assertSeedClub(db, clubId = SEED_CLUB_ID) {
  const { rows } = await db.query('select 1 from bl.clubs where id = $1', [clubId]);
  if (rows.length === 0) throw new Error(`provision:dev: в базе нет клуба сида ${clubId} — сначала npm run db:reset`);
}

/**
 * Устройства сида со столом, без заводской записи и без принятой привязки.
 * @param {import('pg').ClientBase} db — суперпользователь (DATABASE_ADMIN_URL)
 */
export async function loadSeedDevices(db, clubId = SEED_CLUB_ID) {
  const { rows } = await db.query(
    `select d.id, d.club_id, d.resource_id, r.number as resource_number, r.type as resource_type,
            r.number + case when bl.resource_family(r.type) = 'court' then ${COURT_SIM_OFFSET} else 0 end as table_number, d.device_key_enc
       from bl.devices d
       join bl.resources r on r.club_id = d.club_id and r.id = d.resource_id
      where d.club_id = $1
        and not exists (select 1 from bl.device_factory f where f.device_id = d.id)
        and not exists (select 1 from bl.device_bind_windows w where w.device_id = d.id and w.claimed_at is not null)
      order by table_number, d.id`,
    [clubId],
  );
  return rows;
}

/** Прежний devices.json или null (нет файла, не JSON — тогда ключи выдаются заново). */
export function readDevicesFile(file) {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.devices) ? parsed : null;
  } catch {
    return null;
  }
}

/** Ключ и пароль из прежнего файла, если ключ совпадает с базой. */
function reusable(row, prev, encKey) {
  if (!prev || !row.device_key_enc) return null;
  if (prev.club_id !== row.club_id || typeof prev.mqtt_password !== 'string' || !PASSWORD.test(prev.mqtt_password)) return null;
  if (typeof prev.device_key !== 'string') return null;
  const fileKey = Buffer.from(prev.device_key, 'base64');
  if (fileKey.length !== 32) return null;
  let dbKey;
  try {
    dbKey = decryptSecret(row.device_key_enc, encKey, deviceKeyContext(row.id));
  } catch {
    return null;
  }
  return dbKey.equals(fileKey) ? { keyBytes: dbKey, password: prev.mqtt_password } : null;
}

/**
 * План ключей: прежние (reused) или новые.
 * @returns {{ id, clubId, resourceId, tableNumber, keyBytes: Buffer, password: string, reused: boolean }[]}
 */
export function planDeviceKeys(rows, prevFile, encKey, { rotate = false } = {}) {
  const prevById = new Map((prevFile?.devices ?? []).filter((d) => d && typeof d.device_id === 'string').map((d) => [d.device_id, d]));
  const devices = rows.map((r) => {
    const keep = rotate ? null : reusable(r, prevById.get(r.id), encKey);
    return {
      id: r.id,
      clubId: r.club_id,
      resourceId: r.resource_id,
      tableNumber: r.table_number,
      resourceNumber: r.resource_number ?? r.table_number,
      resourceType: r.resource_type ?? null,
      keyBytes: keep?.keyBytes ?? randomBytes(32),
      password: keep?.password ?? randomBytes(24).toString('base64url'),
      reused: Boolean(keep),
    };
  });
  const tables = new Set(devices.map((d) => d.tableNumber));
  if (tables.size !== devices.length) throw new Error('номера столов устройств сида повторяются');
  return devices;
}

async function saveKeys(db, devices, encKey) {
  await db.query('begin');
  try {
    for (const d of devices) {
      const enc = encryptSecret(d.keyBytes, encKey, deviceKeyContext(d.id));
      const res = await db.query('update bl.devices set device_key_enc = $2, mqtt_username = id::text where id = $1 and club_id = $3', [
        d.id,
        enc,
        d.clubId,
      ]);
      if (res.rowCount !== 1) throw new Error(`устройство ${d.id} не найдено`);
    }
    await db.query('commit');
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

/** Клиент в брокере уже такой, как нужно (пароль Dynamic Security не отдаёт — не сравнивается). */
async function clientReady(dynsec, d, rolename) {
  const got = await dynsec.run({ command: 'getClient', username: d.id }, { allowErrors: ['Client not found'] });
  const c = got.error ? null : got.data?.client;
  return Boolean(c && c.clientid === d.id && c.disabled !== true && (c.roles ?? []).some((r) => r.rolename === rolename));
}

export function writeDevicesFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * База → брокер → файл, только устройства сида.
 * @param {{ db: import('pg').ClientBase, dynsec: { run, ensureRole, ensureClient }, encKey: Buffer,
 *           devicesFile: string, mqttUrl: string, caFile: string, rotate?: boolean, clubId?: string,
 *           log?: { info: Function } }} opts
 */
export async function provisionSeedDevices({ db, dynsec, encKey, devicesFile, mqttUrl, caFile, rotate = false, clubId = SEED_CLUB_ID, log }) {
  const rows = await loadSeedDevices(db, clubId);
  if (rows.length === 0) throw new Error('в bl.devices нет устройств сида: сначала npm run db:seed');
  const devices = planDeviceKeys(rows, readDevicesFile(devicesFile), encKey, { rotate });

  // База первой: сервер подписывает новым ключом, как только он записан.
  const fresh = devices.filter((d) => !d.reused);
  if (fresh.length > 0) await saveKeys(db, fresh, encKey);

  for (const d of devices) {
    const rolename = deviceRoleName(d.id);
    await dynsec.ensureRole(rolename, deviceRoleAcls(d.clubId, d.id), resourceName(d.resourceType, d.resourceNumber));
    let client = 'kept';
    if (!d.reused || !(await clientReady(dynsec, d, rolename))) {
      client = await dynsec.ensureClient({
        username: d.id,
        password: d.password,
        clientid: d.id,
        rolename,
        textname: `Контроллер ${resourceName(d.resourceType, d.resourceNumber, { case: 'gen', capital: false })}`,
      });
    }
    log?.info('provision_device', { device_id: d.id, table: d.tableNumber, key: d.reused ? 'kept' : 'new', client });
  }

  writeDevicesFile(devicesFile, {
    mqtt_url: mqttUrl,
    ca_file: caFile,
    devices: devices.map((d) => ({
      device_id: d.id,
      club_id: d.clubId,
      resource_id: d.resourceId,
      table_number: d.tableNumber,
      // M5.8: вид и номер ресурса (корт 1 — table_number 101 в симуляторе: номера симулятора уникальны).
      resource_type: d.resourceType,
      resource_number: d.resourceNumber,
      label: resourceName(d.resourceType, d.resourceNumber),
      mqtt_username: d.id,
      mqtt_password: d.password,
      device_key: d.keyBytes.toString('base64'),
    })),
  });
  return { devices: devices.length, reused: devices.length - fresh.length, issued: fresh.length };
}
