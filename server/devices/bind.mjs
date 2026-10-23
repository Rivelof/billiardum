// Привязка контроллера (protocol v1 §7, контракт M1 §6).
//
// 1. Владелец или монтажник: «Добавить контроллер» → скан QR на корпусе (device_id и код
//    привязки) → выбор стола → POST /api/clubs/{club}/devices/bind. Открывается окно 30 минут;
//    в базе только sha256(device_id:код).
// 2. Контроллер: POST /api/devices/claim {device_id, claim_code}. Без открытого окна код не
//    принимается; 5 неверных кодов закрывают окно. Успех: устройство привязано к столу,
//    devices.last_seq = 0, новый device_key (AES-256-GCM в базе) и пароль MQTT, клиент и роль
//    в Dynamic Security с точными топиками; код сгорает.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { createDynsec, deviceRoleAcls, deviceRoleName } from '../lib/dynsec.mjs';
import { deviceKeyContext, encryptSecret } from '../lib/secrets.mjs';
import { HttpError } from '../http/errors.mjs';
import { fail } from '../sessions/errors.mjs';
import { parseDeviceQr } from './qr.mjs';
import { enterClub, isUuid, loadResource, notifyLight, rolesIn } from '../sessions/queries.mjs';
import { claimCodeHash, ROLES } from '../sessions/service.mjs';

export const BIND_WINDOW_MS = 30 * 60_000;
export const MAX_CLAIM_ATTEMPTS = 5;
/**
 * Заводская привязка закрыта после 5 неверных кодов на 30 минут (bl.device_factory_check, 1051).
 * Срок закрытия app_api не читает (реестр — только bl_definer): Retry-After — верхняя граница.
 */
export const FACTORY_LOCK_SEC = 30 * 60;
// Код привязки — ещё и пароль точки доступа WPA2 контроллера (не длиннее 63): 8…63 символа (protocol §7).
export const CLAIM_CODE = /^[A-Za-z0-9-]{8,63}$/;

/**
 * @param {{ pool, withContext, clock, log, audit, encKey: Buffer, mqttPublicUrl: string,
 *           dynsec: () => Promise<{ ensureRole, ensureClient }>, requireFactory?: boolean }} opts
 *   requireFactory — только устройства из заводского реестра bl.device_factory (№162: NODE_ENV=production);
 *   устройство без записи — 403 и при bind, и при claim.
 */
export function createBinding({ pool, withContext, clock, log, audit, encKey, mqttPublicUrl, dynsec, requireFactory = false }) {
  const now = () => clock.now();

  /**
   * POST /api/clubs/{club}/devices/bind — окно привязки 30 минут.
   * qr — текст QR с корпуса «BLD1:{device_id}:{claim_code}» (M5.1 №159) вместо device_id и claim_code;
   * неверный формат — 400 qr_invalid. Устройство из заводского реестра (bl.device_factory) — код
   * сверяется сразу: неверный — 403 (попытка засчитана, ответ возвращается без отката),
   * после 5 неверных привязка устройства закрыта на 30 минут — 429 rate_limited.
   * Возвращает { bind_until } или { __response } — готовый ответ, который фиксирует транзакцию.
   */
  async function bind(db, { clubId, userId, deviceId: rawDeviceId, resourceId, claimCode: rawClaimCode, qr }) {
    let deviceId = rawDeviceId;
    let claimCode = rawClaimCode;
    if (qr !== undefined && qr !== null) {
      const parsed = parseDeviceQr(qr);
      if (!parsed) throw new HttpError(400, 'qr_invalid');
      if ((deviceId !== undefined && deviceId !== null && String(deviceId).toLowerCase() !== parsed.deviceId) || (claimCode !== undefined && claimCode !== null && claimCode !== parsed.claimCode)) {
        throw new HttpError(400, 'qr_invalid', { detail: 'qr и device_id/claim_code различаются' });
      }
      ({ deviceId, claimCode } = parsed);
    }
    if (!isUuid(deviceId) || !isUuid(resourceId)) fail('bad_request', 'ids');
    if (typeof claimCode !== 'string' || !CLAIM_CODE.test(claimCode)) fail('bad_request', 'claim_code');
    await enterClub(db, clubId);
    const roles = await rolesIn(db, clubId, userId);
    if (!roles.some((r) => ROLES.installer.includes(r))) fail('forbidden', 'role');
    const r = await loadResource(db, resourceId);
    if (!r || r.club_id !== clubId || !r.active) fail('not_found', 'resource');
    const owner = await db.query('select bl.device_club($1) as club_id', [deviceId]);
    if (owner.rows[0].club_id && owner.rows[0].club_id !== clubId) fail('forbidden', 'device in another club');
    const t = now();
    // Заводской реестр (M5.1 №159): код с наклейки сверяется до открытия окна.
    const factory = (await db.query('select bl.device_factory_check($1, $2, $3) as r', [deviceId, claimCodeHash(deviceId, claimCode), t])).rows[0].r;
    if (factory === 'unknown' && requireFactory) fail('forbidden', 'device not in factory registry');
    if (factory === 'locked') throw new HttpError(429, 'rate_limited', { detail: 'factory bind locked', headers: { 'retry-after': String(FACTORY_LOCK_SEC) } });
    if (factory === 'bad') {
      log.warn('device_bind_bad_code', { device_id: deviceId });
      // Счётчик неверных кодов должен сохраниться: ответ без исключения фиксирует транзакцию.
      return { __response: { status: 403, json: { error: 'forbidden' } } };
    }
    const until = new Date(t.getTime() + BIND_WINDOW_MS);
    await db.query(
      'update bl.device_bind_windows set closed_at = $2 where device_id = $1 and claimed_at is null and closed_at is null',
      [deviceId, t],
    );
    await db.query(
      `insert into bl.device_bind_windows (club_id, device_id, resource_id, claim_code_hash, created_by, created_at, until)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [clubId, deviceId, resourceId, claimCodeHash(deviceId, claimCode), userId, t, until],
    );
    await audit(db, {
      action: 'device.bind',
      objectType: 'device',
      objectId: deviceId,
      actorType: 'user',
      actorId: userId,
      data: { device_id: deviceId, resource_id: resourceId, until: until.toISOString(), factory: factory === 'ok', via: qr ? 'qr' : 'code' },
    });
    return { bind_until: until.toISOString(), device_id: deviceId };
  }

  async function countFailure(clubId, windowId) {
    await withContext(pool, { clubId, actorType: 'device' }, (c) =>
      c.query(
        `update bl.device_bind_windows
            set failed_attempts = failed_attempts + 1,
                closed_at = case when failed_attempts + 1 >= $2 then $3::timestamptz else closed_at end
          where id = $1`,
        [windowId, MAX_CLAIM_ATTEMPTS, now()],
      ),
    );
  }

  /** POST /api/devices/claim — контроллер получает ключи; код сгорает. */
  async function claim(db, { deviceId, claimCode }) {
    if (!isUuid(deviceId) || typeof claimCode !== 'string' || !CLAIM_CODE.test(claimCode)) fail('bad_request', 'claim');
    const t = now();
    if (requireFactory && !(await db.query('select bl.device_factory_known($1) as ok', [deviceId])).rows[0].ok) {
      log.warn('device_claim_not_in_factory', { device_id: deviceId });
      fail('forbidden', 'device not in factory registry');
    }
    const w = await db.query('select window_id, club_id from bl.device_bind_window($1, $2)', [deviceId, t]);
    if (w.rowCount === 0) fail('forbidden', 'no bind window');
    const { window_id: windowId, club_id: clubId } = w.rows[0];
    await enterClub(db, clubId);
    await db.query("select set_config('app.actor_type', 'device', true)");
    // Код проверяется до блокировки окна: неверная попытка считается в отдельной транзакции
    // (ответ с ошибкой откатывает эту), и ей не мешает блокировка строки.
    const peek = await db.query('select claim_code_hash from bl.device_bind_windows where id = $1', [windowId]);
    const expected = Buffer.from(peek.rows[0]?.claim_code_hash ?? '', 'hex');
    const got = Buffer.from(claimCodeHash(deviceId, claimCode), 'hex');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      await countFailure(clubId, windowId);
      log.warn('device_claim_bad_code', { device_id: deviceId });
      fail('forbidden', 'bad claim code');
    }
    const row = await db.query(
      'select id, resource_id from bl.device_bind_windows where id = $1 and claimed_at is null and closed_at is null and until > $2 for update',
      [windowId, t],
    );
    if (row.rowCount === 0) fail('forbidden', 'window closed');
    const win = row.rows[0];
    const other = await db.query('select bl.device_club($1) as club_id', [deviceId]);
    if (other.rows[0].club_id && other.rows[0].club_id !== clubId) fail('forbidden', 'device in another club');

    const key = randomBytes(32);
    const password = randomBytes(24).toString('base64url');
    const keyEnc = encryptSecret(key, encKey, deviceKeyContext(deviceId));
    // Стол получает новое устройство: старое отвязывается (замена контроллера).
    await db.query('update bl.devices set resource_id = null where resource_id = $1 and id <> $2', [win.resource_id, deviceId]);
    const upd = await db.query('update bl.devices set resource_id = $2, device_key_enc = $3, last_seq = 0 where id = $1', [
      deviceId,
      win.resource_id,
      keyEnc,
    ]);
    if (upd.rowCount === 0) {
      await db.query(
        `insert into bl.devices (id, club_id, resource_id, device_key_enc, mqtt_username, last_seq) values ($1, $2, $3, $4, $5, 0)`,
        [deviceId, clubId, win.resource_id, keyEnc, deviceId],
      );
    }
    await db.query('update bl.device_bind_windows set claimed_at = $2 where id = $1', [windowId, t]);
    await audit(db, {
      action: 'device.claim',
      objectType: 'device',
      objectId: deviceId,
      actorType: 'device',
      data: { device_id: deviceId, resource_id: win.resource_id, window_id: windowId },
    });
    // Брокер последним: ошибка Dynamic Security откатывает транзакцию, окно остаётся открытым.
    const ds = await dynsec();
    await ds.ensureRole(deviceRoleName(deviceId), deviceRoleAcls(clubId, deviceId), `Контроллер ${deviceId}`);
    await ds.ensureClient({ username: deviceId, password, clientid: deviceId, rolename: deviceRoleName(deviceId), textname: 'Контроллер стола' });
    await notifyLight(db, { k: 'device', c: clubId, d: deviceId, r: win.resource_id });
    log.info('device_claimed', { device_id: deviceId, resource_id: win.resource_id });
    return { mqtt_username: deviceId, mqtt_password: password, device_key: key.toString('base64'), mqtt_url: mqttPublicUrl, club_id: clubId };
  }

  return { bind, claim };
}

/**
 * Соединение администратора Dynamic Security (лениво, одно на процесс). Учётка сервера
 * bl-server прав на $CONTROL не имеет (M0), поэтому привязка ходит под MQTT_ADMIN_USER.
 */
export function createDynsecConnector({ url, caFile, username, password, log }) {
  let pending = null;
  let client = null;
  async function open() {
    if (!username || !password) throw new Error('MQTT_ADMIN_USER и MQTT_ADMIN_PASSWORD нужны для привязки контроллеров');
    client = await mqtt.connectAsync(url, {
      clientId: `bl-server-dynsec-${randomBytes(4).toString('hex')}`,
      username,
      password,
      ca: caFile ? readFileSync(caFile) : undefined,
      rejectUnauthorized: true,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
    });
    client.on('error', (err) => log.warn('dynsec_mqtt_error', { error: err.message }));
    return createDynsec(client);
  }
  return {
    get() {
      if (!pending) {
        pending = open().catch((err) => {
          pending = null;
          throw err;
        });
      }
      return pending;
    },
    async close() {
      if (client) await client.endAsync().catch(() => {});
      client = null;
      pending = null;
    },
  };
}
