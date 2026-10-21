// Доступ сервера к базе под app_api. Каждая транзакция — с контекстом клуба
// (set_config(..., true) действует до конца транзакции), RLS отсекает чужое.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Транзакция с контекстом запроса (контракт M0 §5).
 * @template T
 * @param {import('pg').Pool} pool
 * @param {{ clubId: string|null, userId?: string|null, actorType: 'user'|'system'|'device'|'support' }} ctx
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withContext(pool, { clubId, userId = null, actorType }, fn) {
  if (clubId !== null && !UUID.test(clubId)) throw new Error('clubId не UUID');
  if (userId !== null && !UUID.test(userId)) throw new Error('userId не UUID');
  if (!['user', 'system', 'device', 'support'].includes(actorType)) throw new Error('неизвестный actorType');
  const client = await pool.connect();
  let broken = null;
  try {
    await client.query('begin');
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
      [clubId ?? '', userId ?? '', actorType],
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      broken = rollbackErr;
    }
    throw err;
  } finally {
    client.release(broken ?? undefined);
  }
}

/** Команда не отправляется: транзакция откатывается, seq и журнал не тратятся. */
class CommandSkipped extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** Хранилище моста MQTT. */
export function createStore(pool) {
  return {
    async ping() {
      await pool.query('select 1');
    },

    /** Клуб устройства по device_id (SECURITY DEFINER bl.device_club) или null. */
    async deviceClub(deviceId) {
      const { rows } = await pool.query('select bl.device_club($1) as club_id', [deviceId]);
      return rows[0]?.club_id ?? null;
    },

    /** Число устройств во всех клубах (bl.device_total). */
    async deviceTotal() {
      const { rows } = await pool.query('select bl.device_total() as total');
      return Number(rows[0].total);
    },

    /**
     * Команда устройству (protocol §6): в одной транзакции выделяет seq
     * (UPDATE … RETURNING), собирает и подписывает команду (build) и пишет журнал.
     * Ошибка build (например, ключ не расшифровался) откатывает и seq, и журнал.
     * minSeq — last_seq из state устройства: seq сервера не отстаёт от NVS
     * (например, после восстановления базы из бэкапа).
     * @returns {Promise<{ status: 'ok', seq: number, payload: string } | { status: 'unknown_device' | 'no_key' }>}
     */
    async allocateCommand({ clubId, deviceId, cmdId, type, minSeq = null, build }) {
      try {
        return await withContext(pool, { clubId, actorType: 'system' }, async (client) => {
          const upd = await client.query(
            `update bl.devices
                set last_seq = greatest(last_seq, $2::bigint) + 1
              where id = $1
          returning last_seq, device_key_enc`,
            [deviceId, minSeq],
          );
          if (upd.rowCount === 0) throw new CommandSkipped('unknown_device');
          const seq = Number(upd.rows[0].last_seq);
          const keyEnc = upd.rows[0].device_key_enc;
          if (!keyEnc) throw new CommandSkipped('no_key');
          const payload = build({ seq, keyEnc });
          await client.query(
            `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
             values ($1, 'system', null, 'device.cmd', 'device', $2,
                     jsonb_build_object('cmd_id', $3::text, 'seq', $4::bigint, 'type', $5::text))`,
            [clubId, deviceId, cmdId, seq, type],
          );
          return { status: 'ok', seq, payload };
        });
      } catch (err) {
        if (err instanceof CommandSkipped) return { status: err.reason };
        throw err;
      }
    },

    /** Отметка «видели» и прошивка/возможности из state. */
    async touchDevice({ clubId, deviceId, fw = null, caps = null }) {
      await withContext(pool, { clubId, actorType: 'system' }, (client) =>
        client.query(
          `update bl.devices
              set last_seen_at = now(), fw = coalesce($2, fw), caps = coalesce($3::text[], caps)
            where id = $1`,
          [deviceId, fw, caps],
        ),
      );
    },

    /** Запись о тревоге устройства в цепочку его клуба. */
    async auditDevice({ clubId, deviceId, action, data }) {
      await withContext(pool, { clubId, actorType: 'system' }, (client) =>
        client.query(
          `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
           values ($1, 'system', null, $2, 'device', $3, $4::jsonb)`,
          [clubId, action, deviceId, JSON.stringify(data ?? {})],
        ),
      );
    },
  };
}
