// Сервер ККТ (decisions №77, №78, №84): мосты на связи, раздача заданий, результаты,
// предупреждение ресепшену (SSE kkt) и тревога «Чек не пробит больше 10 минут».
//
// Один процесс сервера: соединения мостов и задание «в полёте» каждого клуба — в памяти;
// состояние очереди — в базе (queue.mjs), переживает перезапуск. На клуб — одно задание
// в работе: ККТ печатает по одному, порядок сохраняется.

import { formatMoney, plural } from '@billiardum/shared/format';
import { applyResult, claimJob, expediteRetries, queueSummary, RESEND_MS } from './queue.mjs';

export const PING_MS = 20_000;
export const TICK_MS = 2_000;
export const ALARM_TICK_MS = 30_000;
export const REVALIDATE_MS = 60_000;
/** PRODUCT §8: чек не пробит больше 10 минут — тревога владельцу. */
export const STALE_RECEIPT_MS = 10 * 60_000;
const MAX_MESSAGES_PER_WINDOW = 300;
const WINDOW_MS = 10_000;
const OUTCOMES = new Set(['done', 'error', 'skipped', 'in_progress', 'unknown']);

/**
 * @param {{ pool: any, withContext: Function, clock: { now(): Date }, log: any, outbox: any, alarms: any,
 *           audit: any, sse: any, options?: { resendMs?: number, tickMs?: number, alarmTickMs?: number,
 *           staleMs?: number, pingMs?: number, retryBaseMs?: number, retryMaxMs?: number } }} deps
 */
export function createKktService({ pool, withContext, clock, log, outbox, alarms, audit, sse, options = {} }) {
  const opts = {
    resendMs: options.resendMs ?? RESEND_MS,
    tickMs: options.tickMs ?? TICK_MS,
    alarmTickMs: options.alarmTickMs ?? ALARM_TICK_MS,
    staleMs: options.staleMs ?? STALE_RECEIPT_MS,
    pingMs: options.pingMs ?? PING_MS,
    revalidateMs: options.revalidateMs ?? REVALIDATE_MS,
  };
  const deps = { outbox, alarms, audit, log, clock, retry: { baseMs: options.retryBaseMs, maxMs: options.retryMaxMs } };
  /** clubId → { conns: Map<bridgeId, conn>, inflight, running, again, publishTimer } */
  const clubs = new Map();
  /** bridgeId → conn */
  const conns = new Map();
  let tickTimer = null;
  let alarmTimer = null;
  let revalidateTimer = null;
  let pingTimer = null;
  let stopped = false;
  const pending = new Set();

  const inClub = (clubId, fn) => withContext(pool, { clubId, actorType: 'system' }, fn, { onHookError: (err) => log.error('kkt_after_commit_failed', { error: err.message }) });

  function track(p) {
    pending.add(p);
    p.finally(() => pending.delete(p)).catch(() => {});
    return p;
  }

  function club(clubId) {
    let c = clubs.get(clubId);
    if (!c) {
      c = { conns: new Map(), inflight: null, running: null, again: false, publishTimer: null };
      clubs.set(clubId, c);
    }
    return c;
  }

  function send(conn, msg) {
    if (conn.ws.readyState !== 1) return false;
    try {
      conn.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      log.warn('kkt_send_failed', { bridge_id: conn.bridgeId, error: err.message });
      return false;
    }
  }

  // Раздача заданий --------------------------------------------------------------------------

  function kick(clubId) {
    if (stopped) return;
    const c = club(clubId);
    if (c.running) {
      c.again = true;
      return;
    }
    c.running = track(
      (async () => {
        do {
          c.again = false;
          try {
            await pumpOnce(clubId, c);
          } catch (err) {
            log.error('kkt_pump_failed', { club_id: clubId, error: err.message });
          }
        } while (c.again && !stopped);
      })().finally(() => {
        c.running = null;
      }),
    );
  }

  async function pumpOnce(clubId, c) {
    const connected = [...c.conns.keys()];
    if (connected.length === 0) return;
    if (c.inflight && Date.now() - c.inflight.sentAtMs < opts.resendMs) return;
    const now = clock.now();
    const res = await inClub(clubId, (db) => claimJob(db, { clubId, connected, now, deps }));
    if (res.job) {
      const conn = c.conns.get(res.job.bridgeId);
      if (!conn) return;
      send(conn, { type: 'job', job_id: res.job.id, kind: res.job.kind, uuid: res.job.uuid, request: res.job.request });
      c.inflight = { uuid: res.job.uuid, bridgeId: res.job.bridgeId, sentAtMs: Date.now() };
      log.info('kkt_job_sent', { club_id: clubId, bridge_id: res.job.bridgeId, kind: res.job.kind, id: res.job.id, attempt: res.job.attempt, resend: Boolean(res.resend) });
      schedulePublish(clubId);
    } else {
      c.inflight = null;
      if (res.wait) log.debug('kkt_job_waits_bridge', { club_id: clubId, bridge_id: res.wait });
    }
  }

  // Состояние для ресепшена ---------------------------------------------------------------

  function bridgesOnline(clubId) {
    const c = clubs.get(clubId);
    return c ? [...c.conns.values()].map((x) => ({ id: x.bridgeId, name: x.name, kkt: x.kkt, connected_at: new Date(x.connectedAtMs).toISOString() })) : [];
  }

  /** Сводка: мосты на связи, ККТ, очередь. state: online | warning | offline. */
  async function statusOf(db, clubId) {
    const queue = await queueSummary(db, clubId);
    const online = bridgesOnline(clubId);
    let state = 'online';
    let reason = null;
    if (online.length === 0) {
      state = 'offline';
      reason = 'no_bridge';
    } else if (online.every((b) => b.kkt?.online === false)) {
      state = 'offline';
      reason = online[0].kkt?.reason ?? 'kkt_offline';
    } else if (online.some((b) => b.kkt?.reason === 'paper' || b.kkt?.blocked)) {
      state = 'warning';
      reason = 'paper';
    } else if (queue.unknown > 0 || queue.failed > 0) {
      state = 'warning';
      reason = queue.unknown > 0 ? 'receipt_unknown' : 'receipt_failed';
    }
    return { state, reason, bridges: online, queue };
  }

  function schedulePublish(clubId) {
    const c = club(clubId);
    if (c.publishTimer || stopped) return;
    c.publishTimer = setTimeout(() => {
      c.publishTimer = null;
      track(
        inClub(clubId, (db) => statusOf(db, clubId))
          .then((s) => {
            sse.publish(`club:${clubId}`, 'kkt', s);
            if (s.state !== c.lastState) {
              c.lastState = s.state;
              log.info('kkt_state', { club_id: clubId, state: s.state, reason: s.reason, pending: s.queue.pending });
            }
          })
          .catch((err) => log.warn('kkt_publish_failed', { club_id: clubId, error: err.message })),
      );
    }, 150);
    c.publishTimer.unref?.();
  }

  // Мосты ------------------------------------------------------------------------------------

  /**
   * Подключить мост после проверки токена (ws.mjs). bridge — строка bl.kkt_bridges.
   */
  function attach(ws, bridge, { ip = null } = {}) {
    const old = conns.get(bridge.id);
    if (old) close(old, 4000, 'replaced');
    const conn = {
      ws,
      bridgeId: bridge.id,
      clubId: bridge.club_id,
      name: bridge.name,
      connectedAtMs: Date.now(),
      kkt: { online: null, reason: 'not_checked' },
      alive: true,
      window: { start: Date.now(), count: 0 },
      seenAtMs: 0,
    };
    conns.set(bridge.id, conn);
    club(conn.clubId).conns.set(bridge.id, conn);
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary));
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('error', (err) => log.warn('kkt_ws_error', { bridge_id: conn.bridgeId, error: err.message }));
    ws.on('close', (code) => detach(conn, code));
    send(conn, { type: 'welcome', bridge_id: bridge.id, club_id: bridge.club_id, ping_ms: opts.pingMs });
    log.info('kkt_bridge_connected', { bridge_id: bridge.id, club_id: bridge.club_id, ip });
    touch(conn, {});
    kick(conn.clubId);
    schedulePublish(conn.clubId);
    return conn;
  }

  function close(conn, code, reason) {
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate?.();
    }
    detach(conn, code);
  }

  function detach(conn, code) {
    if (conns.get(conn.bridgeId) === conn) conns.delete(conn.bridgeId);
    const c = clubs.get(conn.clubId);
    if (c && c.conns.get(conn.bridgeId) === conn) {
      c.conns.delete(conn.bridgeId);
      if (c.inflight?.bridgeId === conn.bridgeId) c.inflight = null;
      log.info('kkt_bridge_disconnected', { bridge_id: conn.bridgeId, club_id: conn.clubId, code: code ?? null });
      schedulePublish(conn.clubId);
    }
  }

  function touch(conn, { version, status }) {
    const now = Date.now();
    if (!version && !status && now - conn.seenAtMs < 60_000) return;
    conn.seenAtMs = now;
    track(
      inClub(conn.clubId, (db) =>
        db.query(
          `update bl.kkt_bridges set last_seen_at = $2, bridge_version = coalesce($3, bridge_version),
                  last_status = coalesce($4, last_status), updated_at = $2
            where id = $1 and revoked_at is null`,
          [conn.bridgeId, clock.now(), version ?? null, status ?? null],
        ),
      ).catch((err) => log.warn('kkt_bridge_touch_failed', { bridge_id: conn.bridgeId, error: err.message })),
    );
  }

  function onMessage(conn, data, isBinary) {
    const now = Date.now();
    if (now - conn.window.start > WINDOW_MS) conn.window = { start: now, count: 0 };
    conn.window.count += 1;
    if (conn.window.count > MAX_MESSAGES_PER_WINDOW) {
      log.warn('kkt_bridge_flood', { bridge_id: conn.bridgeId });
      close(conn, 1008, 'rate');
      return;
    }
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      log.warn('kkt_bad_message', { bridge_id: conn.bridgeId });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    touch(conn, {});
    switch (msg.type) {
      case 'hello': {
        const version = typeof msg.version === 'string' ? msg.version.slice(0, 40) : null;
        if (typeof msg.name === 'string' && msg.name.trim()) conn.name = msg.name.trim().slice(0, 100);
        touch(conn, { version });
        break;
      }
      case 'status':
        onStatus(conn, msg.kkt);
        break;
      case 'result':
        if (typeof msg.uuid !== 'string' || msg.uuid.length > 64 || !OUTCOMES.has(msg.outcome)) {
          log.warn('kkt_bad_result', { bridge_id: conn.bridgeId });
          return;
        }
        track(onResult(conn, msg));
        break;
      case 'pong':
      default:
        break;
    }
  }

  function onStatus(conn, kkt) {
    if (!kkt || typeof kkt !== 'object') return;
    const next = {
      online: kkt.online === true ? true : kkt.online === false ? false : null,
      reason: typeof kkt.reason === 'string' ? kkt.reason.slice(0, 40) : null,
      paper: kkt.paper === false ? false : kkt.paper === true ? true : null,
      blocked: Boolean(kkt.blocked),
    };
    const cameBack = next.online === true && conn.kkt.online !== true;
    const wasPaper = conn.kkt.reason === 'paper' || conn.kkt.blocked;
    conn.kkt = next;
    touch(conn, { status: next });
    schedulePublish(conn.clubId);
    if (cameBack || (wasPaper && next.reason !== 'paper' && !next.blocked)) {
      track(
        inClub(conn.clubId, (db) => expediteRetries(db, { clubId: conn.clubId, now: clock.now() }))
          .then((n) => {
            if (n > 0) log.info('kkt_retries_expedited', { club_id: conn.clubId, count: n });
            kick(conn.clubId);
          })
          .catch((err) => log.warn('kkt_expedite_failed', { error: err.message })),
      );
    }
  }

  async function onResult(conn, msg) {
    let out;
    try {
      out = await inClub(conn.clubId, (db) => applyResult(db, deps, { clubId: conn.clubId, bridgeId: conn.bridgeId, msg, now: clock.now() }));
    } catch (err) {
      log.error('kkt_result_failed', { bridge_id: conn.bridgeId, error: err.message });
      return;
    }
    if (out.ack) send(conn, { type: 'ack', uuid: msg.uuid });
    const c = club(conn.clubId);
    if (out.done && c.inflight?.uuid === msg.uuid) c.inflight = null;
    // Ответ задания — свежее состояние ККТ: ошибка связи — offline; документ, «уже в нужном
    // состоянии» или ошибка не связи — ККТ отвечает (online), бумага — предупреждение.
    const category = msg.outcome === 'error' ? (msg.error?.category ?? 'unknown') : null;
    let next = null;
    if (msg.outcome === 'done' || msg.outcome === 'skipped') next = { online: true, reason: null, paper: true, blocked: false };
    else if (category === 'connection') next = { online: false, reason: 'kkt_offline', paper: conn.kkt.paper ?? null, blocked: false };
    else if (category === 'paper') next = { online: true, reason: 'paper', paper: false, blocked: false };
    else if (category) next = { online: true, reason: null, paper: conn.kkt.paper ?? null, blocked: false };
    if (next && (next.online !== conn.kkt.online || next.reason !== conn.kkt.reason || next.blocked !== Boolean(conn.kkt.blocked))) onStatus(conn, next);
    else schedulePublish(conn.clubId);
    kick(conn.clubId);
  }

  // Таймеры ----------------------------------------------------------------------------------

  async function alarmTick() {
    const now = clock.now();
    const cutoff = new Date(now.getTime() - opts.staleMs);
    const { rows } = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
      db.query('select club_id, receipt_id from bl.kkt_due($1, $2)', [cutoff, 500]),
    );
    const byClub = new Map();
    for (const r of rows) byClub.set(r.club_id, [...(byClub.get(r.club_id) ?? []), r.receipt_id]);
    for (const [clubId, ids] of byClub) {
      try {
        await inClub(clubId, async (db) => {
          const upd = await db.query(
            `update bl.receipts set alarmed_at = $2 where id = any($1::uuid[]) and alarmed_at is null and status = 'receipt_pending'
             returning amount_kopecks`,
            [ids, now],
          );
          if (upd.rowCount === 0) return;
          const sum = upd.rows.reduce((a, r) => a + Number(r.amount_kopecks), 0);
          const n = upd.rowCount;
          await alarms.raise(db, clubId, {
            type: 'receipt_pending',
            level: 'important',
            data: { count: n, amount_kopecks: sum },
            text: `Чек не пробит больше 10 минут: ${n} ${plural(n, ['чек', 'чека', 'чеков'])} на ${formatMoney(sum)}. Проверьте ККТ и мост на ПК ресепшена`,
          });
          log.warn('kkt_receipts_stale', { club_id: clubId, count: n, amount_kopecks: sum });
        });
        schedulePublish(clubId);
      } catch (err) {
        log.error('kkt_alarm_tick_failed', { club_id: clubId, error: err.message });
      }
    }
    return rows.length;
  }

  async function revalidate() {
    for (const conn of [...conns.values()]) {
      try {
        const ok = await inClub(conn.clubId, async (db) => {
          const { rows } = await db.query('select revoked_at from bl.kkt_bridges where id = $1', [conn.bridgeId]);
          return rows[0] && !rows[0].revoked_at;
        });
        if (!ok) {
          log.warn('kkt_bridge_revoked_closed', { bridge_id: conn.bridgeId });
          close(conn, 4001, 'revoked');
        }
      } catch (err) {
        log.warn('kkt_revalidate_failed', { error: err.message });
      }
    }
  }

  function pingAll() {
    for (const conn of [...conns.values()]) {
      if (!conn.alive) {
        log.warn('kkt_bridge_no_pong', { bridge_id: conn.bridgeId });
        conn.ws.terminate?.();
        detach(conn, 1006);
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        /* закрывается */
      }
      send(conn, { type: 'ping', t: Date.now() });
    }
  }

  return {
    attach,
    kick,
    statusOf,
    bridgesOnline,
    schedulePublish,
    alarmTick,
    revalidate,
    deps,
    /** Закрыть соединение отозванного моста. */
    disconnectBridge(bridgeId, code = 4001) {
      const conn = conns.get(bridgeId);
      if (conn) close(conn, code, 'revoked');
    },
    isOnline: (bridgeId) => conns.has(bridgeId),
    start() {
      stopped = false;
      tickTimer = setInterval(() => {
        for (const clubId of clubs.keys()) if (clubs.get(clubId).conns.size > 0) kick(clubId);
      }, opts.tickMs);
      alarmTimer = setInterval(() => track(alarmTick().catch((err) => log.error('kkt_alarm_tick_failed', { error: err.message }))), opts.alarmTickMs);
      revalidateTimer = setInterval(() => track(revalidate()), opts.revalidateMs);
      pingTimer = setInterval(pingAll, opts.pingMs);
      for (const t of [tickTimer, alarmTimer, revalidateTimer, pingTimer]) t.unref?.();
    },
    /** Закрыть соединения мостов (до server.close(), иначе он ждёт их). */
    closeConnections() {
      for (const conn of [...conns.values()]) close(conn, 1001, 'server stopping');
    },
    async stop() {
      stopped = true;
      clearInterval(tickTimer);
      clearInterval(alarmTimer);
      clearInterval(revalidateTimer);
      clearInterval(pingTimer);
      for (const c of clubs.values()) clearTimeout(c.publishTimer);
      for (const conn of [...conns.values()]) close(conn, 1001, 'server stopping');
      await Promise.allSettled([...pending]);
    },
  };
}
