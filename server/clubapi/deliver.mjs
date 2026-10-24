// Доставка вебхуков клуба (M5.7 №201): подпись, HTTPS-запрос с защитой от SSRF, повторы, журнал.
//
// Подпись: HMAC-SHA256(секрет адреса, `${t}.${body}`) в hex; заголовки
//   X-Bl-Timestamp: t (Unix, секунды), X-Bl-Signature: v1=<hex>, X-Bl-Event: тип, X-Bl-Event-Id,
//   X-Bl-Delivery: id доставки. Тело — JSON события как есть (байт в байт то, что подписано).
// Успех — ответ 2xx. Иначе — повтор через 1, 5, 15, 30 минут, 1, 2, 4, 8, 12 часов, пока не прошло
// 24 часа с события (последняя попытка — ровно в 24 часа), затем status failed. Редиректы
// не выполняются (3xx — неудача redirect). Захват строки очереди — аренда 2 минуты: после сбоя
// процесса доставка продолжается (получатель должен быть готов к повтору — X-Bl-Event-Id).

import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { formatDate, formatTime } from '@billiardum/shared/format';
import { withContext as storeWithContext } from '../lib/store.mjs';
import { sendToClubStaff } from '../notify/index.mjs';
import { checkUrlSyntax, DEFAULT_PORTS, isPublicAddress, safeLookup } from './ssrf.mjs';
import { webhookSecret } from './webhooks.mjs';

export const RETRY_DELAYS_MIN = Object.freeze([1, 5, 15, 30, 60, 120, 240, 480, 720]);
export const RETRY_WINDOW_MS = 24 * 3600_000;
export const TIMEOUT_MS = 10_000;
export const LEASE_MS = 120_000;
export const BATCH = 20;
export const CONCURRENCY = 4;
export const POLL_MS = 5_000;
export const KEEP_MS = 30 * 24 * 3600_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const USER_AGENT = 'Billiardum-Webhooks/1';
/** Уведомление «вебхук не принимает события» — не чаще раза в сутки на адрес. */
export const FAILURE_NOTIFY_EVERY_MS = 24 * 3600_000;

/**
 * Доставка перешла в failed: владельцу клуба одно уведомление на адрес (не тревога), повтор —
 * не раньше чем через сутки. В транзакции контекста клуба. Возвращает true, если уведомили.
 */
export async function notifyFailing(db, { clubId, webhookId, deliveryId, now, send = sendToClubStaff }) {
  const { rows } = await db.query(
    `update bl.webhooks w set failure_notified_at = $3
      where w.id = $1 and w.club_id = $2 and w.disabled_at is null
        and (w.failure_notified_at is null or w.failure_notified_at <= $4)
      returning w.url, (select c.timezone from bl.clubs c where c.id = w.club_id) as timezone,
                (select min(a.at) from bl.webhook_attempts a where a.delivery_id = $5) as since`,
    [webhookId, clubId, now, new Date(now.getTime() - FAILURE_NOTIFY_EVERY_MS), deliveryId],
  );
  const w = rows[0];
  if (!w) return false;
  // Адрес — только хост: в пути и запросе могут быть токены получателя.
  const host = new URL(w.url).host;
  const since = w.since ?? now;
  const tz = w.timezone ?? 'Europe/Moscow';
  await send(db, clubId, ['owner'], {
    kind: 'webhook.failing',
    level: 'important',
    text: `Вебхук ${host} не принимает события с ${formatDate(since, tz)}, ${formatTime(since, tz)}. Повторы закончились — проверьте адрес в журнале доставок.`,
    data: { webhook_id: webhookId, delivery_id: deliveryId, url: `/club/api/webhooks/${webhookId}` },
    actions: [{ id: 'open', title: 'Журнал доставок', url: `/club/api/webhooks/${webhookId}` }],
  });
  return true;
}

/** Подпись тела: hex HMAC-SHA256 `${timestamp}.${body}`. */
export function sign(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** Заголовки запроса доставки. */
export function deliveryHeaders({ secret, timestamp, body, event, eventId, deliveryId }) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': USER_AGENT,
    'x-bl-event': event,
    'x-bl-event-id': eventId,
    'x-bl-delivery': deliveryId,
    'x-bl-timestamp': String(timestamp),
    'x-bl-signature': `v1=${sign(secret, timestamp, body)}`,
  };
}

/**
 * Когда повторить после attempts неудачных попыток (attempts ≥ 1) события created; null — больше
 * не повторять (прошло 24 часа).
 */
export function nextAttemptAt(attempts, created, now) {
  const end = new Date(created).getTime() + RETRY_WINDOW_MS;
  const t = new Date(now).getTime();
  if (t >= end) return null;
  const delay = RETRY_DELAYS_MIN[Math.min(attempts, RETRY_DELAYS_MIN.length) - 1] * 60_000;
  return new Date(Math.min(t + delay, end));
}

/** Ошибка сети → короткий код для журнала доставок (без адресов и текста). */
export function errorCode(err) {
  const c = err?.code;
  if (c === 'url_forbidden' || c === 'url_invalid' || c === 'timeout' || c === 'redirect' || c === 'too_large') return c;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NODATA') return 'dns';
  if (c === 'ECONNREFUSED') return 'connect_refused';
  if (c === 'ECONNRESET' || c === 'EPIPE') return 'connect_reset';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return 'unreachable';
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') return 'timeout';
  if (typeof c === 'string' && (c.startsWith('ERR_TLS') || c.startsWith('ERR_SSL') || /CERT|SELF_SIGNED|UNABLE_TO|HOSTNAME/.test(c))) return 'tls';
  if (typeof c === 'string' && /^[A-Z0-9_]{1,40}$/.test(c)) return `net:${c.toLowerCase()}`.slice(0, 64);
  return 'error';
}

/**
 * Один POST на адрес вебхука. Адрес проверяется синтаксически, IP имени — при соединении
 * (safeLookup): внутренний адрес → ошибка url_forbidden без соединения. Редиректы — ошибка.
 * @param {{ url: string, body: string, headers: object, timeoutMs?: number, lookup?: Function,
 *           isAllowed?: (ip: string) => boolean, ports?: readonly number[], ca?: string|Buffer }} args
 *   isAllowed, ports и ca — только для тестов (свой сервер на 127.0.0.1).
 * @returns {Promise<{ status: number }>}
 */
export function httpsSend({ url, body, headers, timeoutMs = TIMEOUT_MS, lookup = dns.lookup, isAllowed = isPublicAddress, ports = DEFAULT_PORTS, ca }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = checkUrlSyntax(url, { ports });
    } catch (err) {
      reject(err);
      return;
    }
    if (target.ip && !isAllowed(target.ip)) {
      reject(Object.assign(new Error('blocked address'), { code: 'url_forbidden' }));
      return;
    }
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = https.request({
      protocol: 'https:',
      hostname: target.host,
      port: target.port,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      agent: false,
      lookup: safeLookup(lookup, isAllowed),
      servername: net.isIP(target.host) ? undefined : target.host,
      ...(ca ? { ca } : {}),
    });
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, timeoutMs);
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) res.destroy();
      });
      res.on('error', () => {});
      res.on('close', () => {
        if (status >= 300 && status < 400) finish(reject, Object.assign(new Error('redirect'), { code: 'redirect', status }));
        else finish(resolve, { status });
      });
      res.resume();
    });
    req.on('error', (err) => finish(reject, err));
    req.end(body);
  });
}

/**
 * Воркер очереди доставок.
 * @param {{ pool: import('pg').Pool, log: object, clock?: { now(): Date }, encKey: Buffer, withContext?: Function,
 *           send?: (args: object) => Promise<{ status: number }>, batch?: number, concurrency?: number, pollMs?: number }} opts
 */
export function createDeliveryWorker({ pool, log, clock = { now: () => new Date() }, encKey, withContext = storeWithContext, send = httpsSend, batch = BATCH, concurrency = CONCURRENCY, pollMs = POLL_MS }) {
  let timer = null;
  let running = null;
  let again = false;
  let stopped = true;
  let lastCleanup = 0;

  async function claim() {
    const now = clock.now();
    return withContext(pool, { clubId: null, actorType: 'system' }, async (db) => {
      const { rows } = await db.query(
        `with due as (
           select d.id from bl.webhook_deliveries d
            where d.status = 'pending' and d.next_attempt_at <= $1 and (d.claimed_until is null or d.claimed_until <= $1)
            order by d.next_attempt_at
            limit $2
            for update skip locked)
         update bl.webhook_deliveries d set claimed_until = $3
           from due where d.id = due.id
         returning d.id, d.club_id, d.webhook_id, d.event_id, d.event, d.payload, d.attempts, d.created_at`,
        [now, batch, new Date(now.getTime() + LEASE_MS)],
      );
      if (rows.length === 0) return [];
      const { rows: hooks } = await db.query('select id, url, secret_enc, disabled_at from bl.webhooks where id = any($1::uuid[])', [[...new Set(rows.map((r) => r.webhook_id))]]);
      const byId = new Map(hooks.map((h) => [h.id, h]));
      return rows.map((r) => ({ ...r, hook: byId.get(r.webhook_id) ?? null }));
    });
  }

  async function record(d, { status = null, error = null, durationMs }) {
    const now = clock.now();
    const ok = status !== null && status >= 200 && status < 300;
    const attempts = d.attempts + 1;
    const next = ok ? null : nextAttemptAt(attempts, d.created_at, now);
    const state = ok ? 'delivered' : next ? 'pending' : 'failed';
    await withContext(pool, { clubId: d.club_id, actorType: 'system' }, async (db) => {
      await db.query(
        'insert into bl.webhook_attempts (club_id, delivery_id, attempt, at, http_status, error, duration_ms) values ($1, $2, $3, $4, $5, $6, $7)',
        [d.club_id, d.id, attempts, now, status, error, Math.max(0, Math.round(durationMs))],
      );
      await db.query(
        `update bl.webhook_deliveries set attempts = $2, status = $3, last_attempt_at = $4, last_http_status = $5, last_error = $6,
                delivered_at = $7, next_attempt_at = coalesce($8, next_attempt_at), claimed_until = null
          where id = $1 and status = 'pending'`,
        [d.id, attempts, state, now, status, error, ok ? now : null, next],
      );
      if (state === 'failed') await notifyFailing(db, { clubId: d.club_id, webhookId: d.webhook_id, deliveryId: d.id, now });
    });
    log.info('webhook_delivery', { delivery_id: d.id, club_id: d.club_id, event: d.event, attempt: attempts, status: state, http_status: status, error });
  }

  async function attempt(d) {
    if (!d.hook || d.hook.disabled_at) {
      await withContext(pool, { clubId: d.club_id, actorType: 'system' }, (db) =>
        db.query("update bl.webhook_deliveries set status = 'canceled', claimed_until = null where id = $1 and status = 'pending'", [d.id]),
      );
      return;
    }
    const started = Date.now();
    let secret;
    try {
      secret = webhookSecret(encKey, d.hook.id, d.hook.secret_enc);
    } catch {
      log.error('webhook_secret_failed', { webhook_id: d.hook.id });
      await record(d, { error: 'secret', durationMs: 0 });
      return;
    }
    const body = JSON.stringify(d.payload);
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const headers = deliveryHeaders({ secret, timestamp, body, event: d.event, eventId: d.event_id, deliveryId: d.id });
    try {
      const res = await send({ url: d.hook.url, body, headers });
      const status = Number.isInteger(res?.status) && res.status >= 100 && res.status <= 599 ? res.status : null;
      await record(d, { status, error: status === null ? 'bad_response' : status >= 300 ? 'http' : null, durationMs: Date.now() - started });
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 100 && err.status <= 599 ? err.status : null;
      await record(d, { status, error: errorCode(err), durationMs: Date.now() - started });
    }
  }

  async function cleanup() {
    const now = clock.now();
    if (now.getTime() - lastCleanup < 3600_000) return;
    lastCleanup = now.getTime();
    const r = await withContext(pool, { clubId: null, actorType: 'system' }, (db) =>
      db.query("delete from bl.webhook_deliveries where status <> 'pending' and created_at < $1", [new Date(now.getTime() - KEEP_MS)]),
    );
    if (r.rowCount) log.info('webhook_cleanup', { deleted: r.rowCount });
  }

  /** Один проход: захватить созревшие доставки и отправить (не больше concurrency сразу). */
  async function tick() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          const list = await claim();
          for (let i = 0; i < list.length; i += concurrency) {
            await Promise.all(list.slice(i, i + concurrency).map((d) => attempt(d).catch((err) => log.error('webhook_attempt_failed', { delivery_id: d.id, error: err?.code ?? err?.message }))));
          }
          if (list.length === batch) again = true;
        } while (again && !stopped);
        await cleanup();
      } catch (err) {
        log.error('webhook_worker_failed', { error: err?.code ?? err?.message });
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function schedule() {
    if (stopped || pollMs <= 0) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, pollMs);
    timer.unref?.();
  }

  return {
    tick,
    /** Разбудить воркер (после коммита новых доставок). */
    kick() {
      if (stopped) return;
      setImmediate(() => {
        tick();
      });
    },
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (running) await running;
    },
  };
}
