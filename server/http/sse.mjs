// Server-Sent Events (decisions №50, контракт M1 §7, §13): publish(channel, event, data).
// Каналы: club:{id} (зал, заявки ресепшена, тревоги), session:{id}, user:{id};
// tournament:{id} (M4) — публичный, без входа: только события TOURNAMENT_EVENTS без ПДн
// (сетка по никам, счёт, номера столов) — publish других событий в него отклоняется.
// Один процесс сервера: подписчики в памяти. Публиковать — после коммита
// (afterCommit из server/lib/store.mjs), чтобы событие не опережало данные.

import { isIP } from 'node:net';

export const KEEP_ALIVE_MS = 25_000;
export const MAX_CLIENTS = 2_000;
export const MAX_CLIENTS_PER_USER = 10;
/**
 * Анонимные потоки (без входа: публичный поток и ТВ-экран турнира) — не больше четверти хаба:
 * остальное остаётся персоналу и гостям (M4-7).
 */
export const ANON_SHARE = 0.25;
export const MAX_ANON_CLIENTS = Math.floor(MAX_CLIENTS * ANON_SHARE);
/**
 * Анонимных потоков с одной сети IPv6 /56 — не больше (M4-I6): у одного абонента или хостинга
 * бывает /56 и шире, 50 сетей /64 по 10 потоков иначе заняли бы всю анонимную долю, и ТВ-экраны
 * других клубов остались бы без обновлений.
 */
export const MAX_ANON_PER_NET = 50;
/** Медленный клиент с таким хвостом неотправленного отключается. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

const CHANNEL = /^(club|session|user|tournament):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** События публичного канала tournament:{id} (m4-api: bracket — полная сетка). */
export const TOURNAMENT_EVENTS = Object.freeze(['bracket', 'tournament', 'match']);
const EVENT = /^[a-z][a-z0-9_]{0,40}$/;

export function isChannel(value) {
  return typeof value === 'string' && CHANNEL.test(value);
}

/** Восемь групп IPv6 (числа) или null; хвост IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) — две группы. */
function ipv6Groups(ip) {
  let s = ip.toLowerCase();
  const tail = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = `${s.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Источник анонимного потока для лимита: IPv4 — адрес; IPv6 — сеть /64 (у абонента обычно вся /64,
 * M4-7); IPv4 внутри IPv6 (::ffff:1.2.3.4) — как IPv4. Не адрес — строка как есть.
 */
export function sourceOf(ip) {
  if (typeof ip !== 'string' || ip === '') return null;
  const bare = ip.replace(/%.*$/, '');
  if (isIP(bare) === 4) return bare;
  if (isIP(bare) !== 6) return ip;
  const g = ipv6Groups(bare);
  if (!g) return ip;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/** Сеть /56 анонимного IPv6-адреса (M4-I6) или null: IPv4 (и IPv4 в IPv6) и не адрес — без сети. */
export function netOf(ip) {
  if (typeof ip !== 'string' || ip === '') return null;
  const bare = ip.replace(/%.*$/, '');
  if (isIP(bare) !== 6) return null;
  const g = ipv6Groups(bare);
  if (!g || (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)) return null;
  return `${g.slice(0, 3).map((x) => x.toString(16)).join(':')}:${(g[3] & 0xff00).toString(16)}::/56`;
}

/** Ключ лимита: ip:… — по источнику (IPv6 — по /64); прочие ключи — как есть. */
export function limitKeyOf(key) {
  if (typeof key !== 'string' || !key.startsWith('ip:')) return key ?? null;
  return `ip:${sourceOf(key.slice(3)) ?? ''}`;
}

/** Строка события SSE. data — JSON одной строкой (переводы строк JSON экранирует сам). */
export function formatEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

export function createSseHub({
  log: initialLog = null,
  keepAliveMs = KEEP_ALIVE_MS,
  maxClients = MAX_CLIENTS,
  maxPerUser = MAX_CLIENTS_PER_USER,
  maxAnon = Math.floor(maxClients * ANON_SHARE),
  maxAnonPerNet = MAX_ANON_PER_NET,
  timers = globalThis,
} = {}) {
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
     *           only?: Record<string, string[]>, transform?: (data: unknown) => unknown }} options
     * revalidate — периодическая проверка (токен не отозван, права на канал не отняты);
     * false — поток закрывается. only — канал → разрешённые события (бармену из club:{id}
     * только события бара, decisions №97); каналы без записи — все события. transform — данные события
     * этого клиента (управляющему сети — без денег по способам оплаты, M5.5 №192).
     * Без userId поток анонимный: общий предел анонимных (maxAnon, четверть хаба) и предел на
     * источник key (ip:… — IPv4 адрес или IPv6 сеть /64) и на сеть IPv6 /56 (maxAnonPerNet, M4-I6).
     * @returns {{ ok: true, client: object } | { ok: false, reason: string }}
     */
    attach(res, { channels, userId = null, key = null, revalidate = null, revalidateMs = 60_000, only = null, transform = null }) {
      if (!channels.every(isChannel)) throw new Error('bad channel');
      if (clients.size >= maxClients) return { ok: false, reason: 'too_many_clients' };
      // Анонимные потоки — не больше своей доли хаба (M4-7): вошедшим всегда остаётся место.
      const anon = !userId;
      // Сеть IPv6 /56 анонимного источника: своя доля (M4-I6).
      const net = anon && typeof key === 'string' && key.startsWith('ip:') ? netOf(key.slice(3)) : null;
      if (anon) {
        let n = 0;
        let inNet = 0;
        for (const c of clients) {
          if (!c.anon) continue;
          n += 1;
          if (net && c.net === net) inNet += 1;
        }
        if (n >= maxAnon) return { ok: false, reason: 'too_many_clients' };
        if (net && inNet >= maxAnonPerNet) return { ok: false, reason: 'too_many_clients' };
      }
      // Лимит потоков на пользователя, у анонимного — на источник (ip:…, IPv6 — сеть /64).
      const limitKey = userId ?? limitKeyOf(key);
      if (limitKey) {
        let mine = 0;
        for (const c of clients) if (c.limitKey === limitKey) mine += 1;
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
        anon,
        net,
        limitKey,
        channels: new Set(channels),
        only: only ? new Map(Object.entries(only).map(([ch, evs]) => [ch, new Set(evs)])) : null,
        transform,
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
        write(c, c.transform ? formatEvent(event, c.transform(data)) : text);
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
