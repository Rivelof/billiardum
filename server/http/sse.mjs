// Server-Sent Events (decisions №50, контракт M1 §7, §13): publish(channel, event, data).
// Каналы: club:{id} (зал, заявки ресепшена, тревоги), session:{id}, user:{id};
// tournament:{id} (M4) — публичный, без входа: только события TOURNAMENT_EVENTS без ПДн
// (сетка по никам, счёт, номера столов) — publish других событий в него отклоняется.
// Один процесс сервера: подписчики в памяти. Публиковать — после коммита
// (afterCommit из server/lib/store.mjs), чтобы событие не опережало данные.

export const KEEP_ALIVE_MS = 25_000;
export const MAX_CLIENTS = 2_000;
export const MAX_CLIENTS_PER_USER = 10;
/** Медленный клиент с таким хвостом неотправленного отключается. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

const CHANNEL = /^(club|session|user|tournament):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** События публичного канала tournament:{id} (m4-api: bracket — полная сетка). */
export const TOURNAMENT_EVENTS = Object.freeze(['bracket', 'tournament', 'match']);
const EVENT = /^[a-z][a-z0-9_]{0,40}$/;

export function isChannel(value) {
  return typeof value === 'string' && CHANNEL.test(value);
}

/** Строка события SSE. data — JSON одной строкой (переводы строк JSON экранирует сам). */
export function formatEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export function createSseHub({ log: initialLog = null, keepAliveMs = KEEP_ALIVE_MS, maxClients = MAX_CLIENTS, maxPerUser = MAX_CLIENTS_PER_USER, timers = globalThis } = {}) {
  /** @type {Set<{ res: any, channels: Set<string>, userId: string|null, close: () => void }>} */
  const clients = new Set();
  let log = initialLog;

  function write(client, text) {
    if (client.res.writableEnded || client.res.destroyed) return;
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      log?.warn('sse_slow_client', { user_id: client.userId });
      client.close();
      return;
    }
    client.res.write(text);
  }

  return {
    /**
     * Подключить ответ HTTP как поток событий. Заголовки пишет сам.
     * @param {import('node:http').ServerResponse} res
     * @param {{ channels: string[], userId?: string|null, revalidate?: () => Promise<boolean>, revalidateMs?: number,
     *           only?: Record<string, string[]> }} options
     * revalidate — периодическая проверка (токен не отозван, права на канал не отняты);
     * false — поток закрывается. only — канал → разрешённые события (бармену из club:{id}
     * только события бара, decisions №97); каналы без записи — все события.
     * @returns {{ ok: true, client: object } | { ok: false, reason: string }}
     */
    attach(res, { channels, userId = null, key = null, revalidate = null, revalidateMs = 60_000, only = null }) {
      if (!channels.every(isChannel)) throw new Error('bad channel');
      if (clients.size >= maxClients) return { ok: false, reason: 'too_many_clients' };
      // Лимит потоков на пользователя, у анонимного — на ключ (ip:… публичного канала).
      const limitKey = userId ?? key;
      if (limitKey) {
        let mine = 0;
        for (const c of clients) if ((c.userId ?? c.key) === limitKey) mine += 1;
        if (mine >= maxPerUser) return { ok: false, reason: 'too_many_clients' };
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      res.socket?.setTimeout?.(0);
      res.socket?.setNoDelay?.(true);
      let keepAlive = null;
      let check = null;
      const client = {
        res,
        userId,
        key,
        channels: new Set(channels),
        only: only ? new Map(Object.entries(only).map(([ch, evs]) => [ch, new Set(evs)])) : null,
        close() {
          if (!clients.delete(client)) return;
          timers.clearInterval(keepAlive);
          if (check) timers.clearInterval(check);
          if (!res.writableEnded) res.end();
        },
      };
      clients.add(client);
      res.on('close', () => client.close());
      res.write(`retry: 3000\n${formatEvent('ready', { channels })}`);
      keepAlive = timers.setInterval(() => write(client, ': keep-alive\n\n'), keepAliveMs);
      keepAlive.unref?.();
      if (revalidate) {
        check = timers.setInterval(() => {
          revalidate().then(
            (ok) => {
              if (!ok) client.close();
            },
            () => {},
          );
        }, revalidateMs);
        check.unref?.();
      }
      return { ok: true, client };
    },

    /** Событие всем подписчикам канала. Возвращает число получателей. */
    publish(channel, event, data) {
      if (!isChannel(channel) || !EVENT.test(event)) throw new Error('bad channel or event');
      if (channel.startsWith('tournament:') && !TOURNAMENT_EVENTS.includes(event)) throw new Error('tournament channel: event not public');
      const text = formatEvent(event, data);
      let n = 0;
      for (const c of clients) {
        if (!c.channels.has(channel)) continue;
        const allowed = c.only?.get(channel);
        if (allowed && !allowed.has(event)) continue;
        write(c, text);
        n += 1;
      }
      return n;
    },

    setLogger(next) {
      log = next;
    },

    closeAll() {
      for (const c of [...clients]) c.close();
    },

    get size() {
      return clients.size;
    },
  };
}

/** Общий хаб процесса: модули зовут publish(channel, event, data) (контракт §13). */
export const hub = createSseHub();

export function publish(channel, event, data) {
  return hub.publish(channel, event, data);
}
