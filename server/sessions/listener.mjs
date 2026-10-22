// LISTEN bl_light: сигналы после коммита (pg_notify доставляется только при COMMIT).
//   {k:'cmd', c, d}            — в bl.device_commands есть команды устройства → мост
//   {k:'session', c, s, r}     — сессия изменилась → планировщик и SSE (session, hall)
//   {k:'hall', c, r}           — стол изменился (удержание, сервисный свет) → SSE hall
// Соединение отдельное и постоянное; после обрыва — переподключение и полный обход
// (мост перечитывает очереди, планировщик — идущие сессии): потерянный сигнал не теряет свет.
// Раз в HEARTBEAT_MS — select 1 на этом соединении: «молча» умершее соединение (без ошибки)
// обнаруживается и переподключается (плюс TCP keepalive пула в server/index.mjs).

import { NOTIFY_CHANNEL } from './queries.mjs';

const RECONNECT_MS = 1_000;
export const HEARTBEAT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export function createListener({ pool, log, onMessage, onReconnect, timers = globalThis }) {
  let client = null;
  let stopped = false;
  let retry = null;
  let first = true;
  let beating = false;
  // Реальные часы, а не timers: проверка — про настоящую сеть (в тестах timers ускорены).
  const heartbeat = setInterval(async () => {
    const c = client;
    if (stopped || !c || beating) return;
    beating = true;
    let timer;
    try {
      await Promise.race([
        c.query('select 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('heartbeat timeout')), HEARTBEAT_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (client === c) {
        log.warn('light_listen_dead', { error: err.message });
        reconnect();
      }
    } finally {
      clearTimeout(timer);
      beating = false;
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  async function connect() {
    if (stopped) return;
    try {
      client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== NOTIFY_CHANNEL) return;
        let payload;
        try {
          payload = JSON.parse(msg.payload);
        } catch {
          return;
        }
        Promise.resolve(onMessage(payload)).catch((err) => log.error('light_notify_failed', { error: err.message }));
      });
      client.on('error', (err) => {
        log.warn('light_listen_error', { error: err.message });
        reconnect();
      });
      await client.query(`listen ${NOTIFY_CHANNEL}`);
      log.info('light_listen', { channel: NOTIFY_CHANNEL });
      if (!first) await Promise.resolve(onReconnect()).catch((err) => log.error('light_resync_failed', { error: err.message }));
      first = false;
    } catch (err) {
      log.warn('light_listen_failed', { error: err.message });
      reconnect();
    }
  }

  function reconnect() {
    if (stopped || retry) return;
    const old = client;
    client = null;
    if (old) {
      old.removeAllListeners('notification');
      try {
        old.release(new Error('listen reconnect'));
      } catch {
        // уже отпущен
      }
    }
    retry = timers.setTimeout(() => {
      retry = null;
      first = false;
      connect();
    }, RECONNECT_MS);
  }

  return {
    start: connect,
    async stop() {
      stopped = true;
      clearInterval(heartbeat);
      if (retry) timers.clearTimeout(retry);
      if (client) {
        try {
          await client.query(`unlisten ${NOTIFY_CHANNEL}`);
        } catch {
          // соединение уже закрыто
        }
        client.removeAllListeners('notification');
        client.release();
        client = null;
      }
    },
  };
}
