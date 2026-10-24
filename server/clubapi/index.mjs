// Модуль clubapi (M5.7 №199–202): публичный API клуба по ключам и исходящие вебхуки.
//
//   await init(ctx) — server/http/app.mjs (MODULES): подписки outbox на события клуба
//                     (очередь доставок пишется в транзакции события) и воркер доставки.
//   await stop()    — отписка и остановка воркера (дожидается текущего прохода).
//   clubapi()       — состояние для маршрутов (api/routes/clubapi.mjs) или null, если не запущен.
//
// ctx.clubapiOptions — подмена в тестах: { lookup, send, pollMs, ports }. В бою не задаётся.

import dns from 'node:dns';
import { withContext as storeWithContext } from '../lib/store.mjs';
import { createDeliveryWorker, POLL_MS } from './deliver.mjs';
import { DEFAULT_PORTS } from './ssrf.mjs';
import { enqueueEvent, gamePepper, TOPIC_EVENT } from './webhooks.mjs';

export const SUBSCRIBER = 'clubapi.webhooks';

let state = null;

export function clubapi() {
  return state;
}

export async function init(ctx) {
  if (state) throw new Error('модуль clubapi уже запущен');
  const encKey = ctx.config?.encKey;
  if (!Buffer.isBuffer(encKey) || encKey.length !== 32) throw new Error('clubapi: нужен config.encKey');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const opts = ctx.clubapiOptions ?? {};
  const pepper = gamePepper(encKey);
  const worker = createDeliveryWorker({
    pool: ctx.pool,
    log,
    clock,
    encKey,
    withContext: ctx.withContext ?? storeWithContext,
    ...(opts.send ? { send: opts.send } : {}),
    pollMs: opts.pollMs ?? POLL_MS,
  });
  const unsubscribe = Object.keys(TOPIC_EVENT).map((topic) =>
    ctx.outbox.subscribe(
      topic,
      async (payload, ev) => {
        const n = await enqueueEvent(ev.db, { topic, payload, clubId: ev.clubId, eventId: ev.eventId, now: clock.now(), pepper });
        if (n > 0) ev.afterCommit(() => worker.kick());
      },
      { name: `${SUBSCRIBER}.${topic}` },
    ),
  );
  worker.start();
  state = {
    worker,
    lookup: opts.lookup ?? dns.lookup,
    ports: opts.ports ?? DEFAULT_PORTS,
    kick: () => worker.kick(),
    unsubscribe,
  };
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  for (const u of s.unsubscribe) u();
  await s.worker.stop();
}
