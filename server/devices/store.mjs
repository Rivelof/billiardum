// Хранилище моста MQTT для M1 (backend-light): всё из server/lib/store.mjs (M0) плюс
// bl.device_commands и bl.device_events. Каждая транзакция — под app_api с контекстом клуба.
//
// allocateCommand — protocol v1 §6: в одной транзакции блокировка устройства, проверка, что
// команда ещё актуальна (prepare от модуля сессий: остаток по paid_until на момент отправки),
// seq, запись device.cmd в журнал, строка device_commands = sent. Публикация — после коммита.

import { createStore as createM0Store, withContext } from '../lib/store.mjs';

/** Команда не отправляется: транзакция откатывается, seq и журнал не тратятся. */
class CommandSkipped extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ clock?: { now(): Date } }} [opts]
 */
export function createLightStore(pool, { clock = { now: () => new Date() } } = {}) {
  const base = createM0Store(pool);
  const sys = (clubId) => ({ clubId, actorType: 'system' });

  return {
    ...base,

    /**
     * @returns {Promise<{ status: 'ok', seq, payload, type, body, seqSync, seqGap }
     *   | { status: 'unknown_device' | 'no_key' | 'stale' | 'cancelled', seqGap: null }>}
     */
    async allocateCommand({
      clubId,
      deviceId,
      cmdId,
      rowId = null,
      type,
      body = {},
      sessionId = null,
      paymentId = null,
      cause = 'system',
      stateLastSeq = null,
      seqGapLimit = 1_000_000,
      deviceState = null,
      prepare = null,
      build,
    }) {
      try {
        return await withContext(pool, sys(clubId), async (client) => {
          // FOR NO KEY UPDATE, а не FOR UPDATE: бизнес-транзакция ставит команду в очередь
          // (FK device_commands → devices берёт KEY SHARE) уже после записи в журнал (advisory-блокировка
          // цепочки клуба). FOR UPDATE здесь + журнал ниже давали взаимоблокировку (40P01).
          const cur = await client.query('select last_seq, device_key_enc from bl.devices where id = $1 for no key update', [deviceId]);
          if (cur.rowCount === 0) throw new CommandSkipped('unknown_device');
          const dbSeq = Number(cur.rows[0].last_seq);
          const keyEnc = cur.rows[0].device_key_enc;
          if (!keyEnc) throw new CommandSkipped('no_key');
          if (rowId) {
            const row = await client.query('select status from bl.device_commands where id = $1 and device_id = $2 for update', [rowId, deviceId]);
            if (row.rowCount === 0 || row.rows[0].status !== 'queued') throw new CommandSkipped('stale');
          }
          // Проверка оплаты и актуальности на момент отправки (контракт M1 §6).
          let final = { type, body };
          if (prepare) final = await prepare(client, { clubId, deviceId, type, body, sessionId, deviceState });
          if (!final) {
            if (rowId) await client.query("update bl.device_commands set status = 'cancelled' where id = $1", [rowId]);
            return { status: 'cancelled', seqGap: null };
          }
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
          const payload = build({ seq, keyEnc, type: final.type, body: final.body });
          const sid = sessionId ?? (typeof final.body?.session_id === 'string' ? final.body.session_id : null);
          const auditData = { cmd_id: cmdId, seq, type: final.type };
          if (sid) auditData.session_id = sid;
          await client.query(
            `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
             values ($1, 'system', null, 'device.cmd', 'device', $2, $3::jsonb)`,
            [clubId, deviceId, JSON.stringify(auditData)],
          );
          const t = clock.now();
          if (rowId) {
            await client.query(
              `update bl.device_commands set type = $2, body = $3::jsonb, seq = $4, status = 'sent', attempts = 1, sent_at = $5
                where id = $1`,
              [rowId, final.type, JSON.stringify(final.body), seq, t],
            );
          } else {
            const sessionRow = await sessionInClub(client, sid);
            await client.query(
              `insert into bl.device_commands
                 (id, club_id, device_id, seq, type, body, status, attempts, cause, session_id, payment_id, created_at, sent_at)
               values ($1, $2, $3, $4, $5, $6::jsonb, 'sent', 1, $7, $8, $9, $10, $10)`,
              [cmdId, clubId, deviceId, seq, final.type, JSON.stringify(final.body), cause, sessionRow, paymentId, t],
            );
          }
          return { status: 'ok', seq, payload, type: final.type, body: final.body, seqSync, seqGap };
        });
      } catch (err) {
        if (err instanceof CommandSkipped) {
          if (rowId && err.reason !== 'stale') {
            await withContext(pool, sys(clubId), (c) =>
              c.query("update bl.device_commands set status = 'cancelled', error = $2 where id = $1 and status = 'queued'", [rowId, err.reason]),
            ).catch(() => {});
          }
          return { status: err.reason, seqGap: null };
        }
        throw err;
      }
    },

    /** Команды в очереди устройства (status = queued) по порядку постановки. */
    async loadQueued({ clubId, deviceId }) {
      return withContext(pool, sys(clubId), async (c) => {
        const { rows } = await c.query(
          `select id, type, body, cause, session_id, payment_id from bl.device_commands
            where device_id = $1 and status = 'queued' order by queue_no`,
          [deviceId],
        );
        return rows;
      });
    },

    /** Устройство вернулось онлайн: очередь заменяет актуальное состояние (protocol §6). */
    async supersedeQueued({ clubId, deviceId }) {
      return withContext(pool, sys(clubId), async (c) => {
        const r = await c.query(
          "update bl.device_commands set status = 'superseded' where device_id = $1 and status = 'queued' and type <> 'config.set'",
          [deviceId],
        );
        return r.rowCount;
      });
    },

    /** Итог команды: acked | failed | no_ack | abandoned. */
    async markCommand({ clubId, cmdId, status, attempts = null, error = null, ackedAt = null }) {
      await withContext(pool, sys(clubId), (c) =>
        c.query(
          `update bl.device_commands
              set status = $2, attempts = coalesce($3, attempts), error = $4, acked_at = $5
            where id = $1 and status in ('sent', 'queued')`,
          [cmdId, status, attempts, error, ackedAt],
        ),
      );
    },

    /**
     * Событие контроллера один раз по (device_id, boot_id, n) и запись device.event в журнал.
     * @returns {Promise<boolean>} true — событие новое
     */
    async recordEvent({ clubId, deviceId, ev, at }) {
      return withContext(pool, sys(clubId), async (c) => {
        const ins = await c.query(
          `insert into bl.device_events (club_id, device_id, boot, boot_id, n, type, data, at_uptime_ms, received_at)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           on conflict on constraint device_events_once do nothing
           returning id`,
          [clubId, deviceId, ev.boot, ev.boot_id, ev.n, ev.type, JSON.stringify(ev.data ?? {}), ev.at_uptime_ms, at],
        );
        if (ins.rowCount === 0) return false;
        await c.query(
          `insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, data)
           values ($1, 'device', null, 'device.event', 'device', $2, $3::jsonb)`,
          [clubId, deviceId, JSON.stringify({ type: ev.type, boot: ev.boot, boot_id: ev.boot_id, n: ev.n, data: ev.data ?? {} })],
        );
        return true;
      });
    },
  };
}

/** session_id из тела команды — только если такая сессия есть в клубе (внешний ключ). */
async function sessionInClub(client, sessionId) {
  if (!sessionId) return null;
  const { rows } = await client.query('select id from bl.sessions where id = $1', [sessionId]);
  return rows[0]?.id ?? null;
}
