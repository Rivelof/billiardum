// ТВ-экран сетки (контракт M4 §1 п. 11): публичный SSE-канал tournament:{id}, событие bracket с полной
// сеткой (без ПДн — только ники). Если хаб core (server/http/sse.mjs) принимает канал tournament:{id},
// поток идёт через него; иначе — через этот небольшой хаб с теми же правилами (keep-alive, предел
// подключений всего и с одного адреса, медленный клиент отключается).

import { formatEvent, KEEP_ALIVE_MS, MAX_BUFFERED_BYTES } from '../http/sse.mjs';

export const TV_MAX_CLIENTS = 1_000;
export const TV_MAX_PER_IP = 8;

export const tvChannel = (tournamentId) => `tournament:${tournamentId}`;

/**
 * @param {{ core?: { isChannel?: Function, attach?: Function, publish?: Function }, log?: any, timers?: any,
 *           keepAliveMs?: number, maxClients?: number, maxPerIp?: number }} options
 */
export function createTvHub({ core = null, log = null, timers = globalThis, keepAliveMs = KEEP_ALIVE_MS, maxClients = TV_MAX_CLIENTS, maxPerIp = TV_MAX_PER_IP } = {}) {
  const probe = tvChannel('00000000-0000-4000-8000-000000000000');
  const useCore = Boolean(core?.attach && core?.publish && typeof core.isChannel === 'function' && core.isChannel(probe));
  const clients = new Set();

  function write(c, text) {
    if (c.res.writableEnded || c.res.destroyed) return;
    if (c.res.writableLength > MAX_BUFFERED_BYTES) {
      log?.warn?.('tv_slow_client', {});
      c.close();
      return;
    }
    c.res.write(text);
  }

  return {
    usesCore: useCore,
    /** Подключить ответ как поток сетки; initial — первая сетка. { ok } или { ok: false, reason }. */
    attach(res, { tournamentId, ip = null, initial = null }) {
      const channel = tvChannel(tournamentId);
      if (useCore) {
        // Предел с одного адреса — ключ хаба core (ip:…); в канал — только сетка.
        const out = core.attach(res, { channels: [channel], key: ip ? `ip:${ip}` : null, only: { [channel]: ['bracket'] } });
        if (out.ok && initial) res.write(formatEvent('bracket', initial));
        return out;
      }
      if (clients.size >= maxClients) return { ok: false, reason: 'too_many_clients' };
      if (ip) {
        let mine = 0;
        for (const c of clients) if (c.ip === ip) mine += 1;
        if (mine >= maxPerIp) return { ok: false, reason: 'too_many_clients' };
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
      const c = {
        res,
        ip,
        channel,
        close() {
          if (!clients.delete(c)) return;
          timers.clearInterval(keepAlive);
          if (!res.writableEnded) res.end();
        },
      };
      clients.add(c);
      res.on('close', () => c.close());
      res.write(`retry: 3000\n${formatEvent('ready', { channels: [channel] })}`);
      if (initial) res.write(formatEvent('bracket', initial));
      keepAlive = timers.setInterval(() => write(c, ': keep-alive\n\n'), keepAliveMs);
      keepAlive.unref?.();
      return { ok: true, client: c };
    },
    /** Новая сетка всем экранам турнира. Возвращает число получателей. */
    publish(tournamentId, bracket) {
      const channel = tvChannel(tournamentId);
      if (useCore) return core.publish(channel, 'bracket', bracket);
      const text = formatEvent('bracket', bracket);
      let n = 0;
      for (const c of clients) {
        if (c.channel !== channel) continue;
        write(c, text);
        n += 1;
      }
      return n;
    },
    size() {
      return clients.size;
    },
    closeAll() {
      for (const c of [...clients]) c.close();
    },
  };
}
