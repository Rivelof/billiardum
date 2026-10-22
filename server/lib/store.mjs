// Доступ сервера к базе под app_api. Каждая транзакция — с контекстом клуба
// (set_config(..., true) действует до конца транзакции), RLS отсекает чужое.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR_TYPES = ['user', 'system', 'device', 'support'];

/** Действия после коммита транзакции withContext: клиент → список функций. */
const afterCommitHooks = new WeakMap();

function checkUuid(value, name) {
  if (value !== null && !UUID.test(value)) throw new Error(`${name} не UUID`);
}

/**
 * Транзакция с контекстом запроса (контракт M0 §5).
 * После коммита выполняет функции, отложенные через afterCommit(client, fn) — например,
 * публикацию в SSE или в MQTT: событие уходит только о том, что уже записано.
 * Ошибка такой функции пишется в лог (onHookError), результат транзакции не меняет.
 * @template T
 * @param {import('pg').Pool} pool
 * @param {{ clubId: string|null, userId?: string|null, actorType: 'user'|'system'|'device'|'support' }} ctx
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ onHookError?: (err: Error) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withContext(pool, { clubId, userId = null, actorType }, fn, { onHookError } = {}) {
  checkUuid(clubId, 'clubId');
  checkUuid(userId, 'userId');
  if (!ACTOR_TYPES.includes(actorType)) throw new Error('неизвестный actorType');
  const client = await pool.connect();
  let broken = null;
  const hooks = [];
  let result;
  try {
    await client.query('begin');
    afterCommitHooks.set(client, hooks);
    await client.query(
      "select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)",
      [clubId ?? '', userId ?? '', actorType],
    );
    result = await fn(client);
    await client.query('commit');
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      broken = rollbackErr;
    }
    throw err;
  } finally {
    afterCommitHooks.delete(client);
    client.release(broken ?? undefined);
  }
  for (const hook of hooks) {
    try {
      await hook();
    } catch (err) {
      if (onHookError) onHookError(err);
      else process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: 'after_commit_failed', error: err.message })}\n`);
    }
  }
  return result;
}

/**
 * Отложить fn до коммита транзакции withContext, в которой работает client.
 * Вне такой транзакции (клиент без хуков) fn выполняется сразу.
 */
export async function afterCommit(client, fn) {
  const hooks = client ? afterCommitHooks.get(client) : undefined;
  if (hooks) hooks.push(fn);
  else await fn();
}

/**
 * Сменить контекст внутри текущей транзакции (SET LOCAL через set_config(..., true)).
 * Передаются только меняемые поля: { clubId } — клуб, { userId } — пользователь.
 */
export async function setContext(client, { clubId, userId, actorType } = {}) {
  if (clubId !== undefined) {
    checkUuid(clubId, 'clubId');
    await client.query("select set_config('app.club_id', $1, true)", [clubId ?? '']);
  }
  if (userId !== undefined) {
    checkUuid(userId, 'userId');
    await client.query("select set_config('app.user_id', $1, true)", [userId ?? '']);
  }
  if (actorType !== undefined) {
    if (!ACTOR_TYPES.includes(actorType)) throw new Error('неизвестный actorType');
    await client.query("select set_config('app.actor_type', $1, true)", [actorType]);
  }
}

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
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
     * Команда устройству (protocol §6): в одной транзакции выделяет seq, собирает и
     * подписывает команду (build) и пишет журнал. Ошибка build (например, ключ не
     * расшифровался) откатывает и seq, и журнал.
     * Сверка: seq = greatest(devices.last_seq, state.last_seq) + 1. Подъём по state
     * (база восстановлена из бэкапа) — запись device.seq_sync. Разрыв больше seqGapLimit —
     * без подъёма (seqGap для тревоги).
     * @returns {Promise<{ status: 'ok', seq: number, payload: string, seqSync: object|null, seqGap: object|null }
     *   | { status: 'unknown_device' | 'no_key', seqGap: null }>}
     */
    async allocateCommand({ clubId, deviceId, cmdId, type, stateLastSeq = null, seqGapLimit = 1_000_000, build }) {
      try {
        return await withContext(pool, { clubId, actorType: 'system' }, async (client) => {
          const cur = await client.query('select last_seq, device_key_enc from bl.devices where id = $1 for update', [deviceId]);
          if (cur.rowCount === 0) throw new CommandSkipped('unknown_device');
          const dbSeq = Number(cur.rows[0].last_seq);
          const keyEnc = cur.rows[0].device_key_enc;
          if (!keyEnc) throw new CommandSkipped('no_key');
          let base = dbSeq;
          let seqSync = null;
          let seqGap = null;
          if (Number.isSafeInteger(stateLastSeq) && stateLastSeq > dbSeq) {
            if (stateLastSeq - dbSeq > seqGapLimit) {
              seqGap = { db_seq: dbSeq, state_seq: stateLastSeq };
            } else {
              base = stateLastSeq;
              seqSync = { from: dbSeq, to: stateLastSeq };
            }
          }
          const seq = base + 1;
          await client.query('update bl.devices set last_seq = $2 where id = $1', [deviceId, seq]);
          if (seqSync) {
            await client.query(
              `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
               values ($1, 'system', null, 'device.seq_sync', 'device', $2,
                       jsonb_build_object('from', $3::bigint, 'to', $4::bigint))`,
              [clubId, deviceId, seqSync.from, seqSync.to],
            );
          }
          const payload = build({ seq, keyEnc });
          await client.query(
            `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
             values ($1, 'system', null, 'device.cmd', 'device', $2,
                     jsonb_build_object('cmd_id', $3::text, 'seq', $4::bigint, 'type', $5::text))`,
            [clubId, deviceId, cmdId, seq, type],
          );
          return { status: 'ok', seq, payload, seqSync, seqGap };
        });
      } catch (err) {
        if (err instanceof CommandSkipped) return { status: err.reason, seqGap: null };
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
