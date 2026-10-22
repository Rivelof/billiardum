// Модуль light (контракт M1 §2.1, §6): сессии, мост MQTT, планировщик, привязка контроллеров.
//
//   await init(ctx)  — server/index.mjs (core) после core и до money. Создаёт мост MQTT
//                      с актуальным состоянием стола и кладёт его в ctx.bridge, подписывается
//                      на outbox (payment.confirmed, payment.refunded), слушает bl_light,
//                      запускает планировщик.
//   await stop()     — обратный порядок.
//   light()          — сервис для маршрутов api/routes/{sessions,resources,devices}.mjs.
//
// ctx: { config, log, pool, clock, outbox, alarms, notify, withContext } (§2.1); для тестов
// можно передать mqttClient (подделка клиента), timers, sse, audit, tariffs, paymentsApi.

import { createBinding, createDynsecConnector } from '../devices/bind.mjs';
import { createLightStore } from '../devices/store.mjs';
import { withContext as withContextM0 } from '../lib/store.mjs';
import { connectMqtt, createBridge } from '../mqtt.mjs';
import { createScheduler } from '../scheduler.mjs';
import { resolveDeps } from './deps.mjs';
import { createDeviceLogic } from './device-logic.mjs';
import { createListener } from './listener.mjs';
import { isUuid, loadResource, loadSession } from './queries.mjs';
import { createLightService } from './service.mjs';
import { sessionView } from './view.mjs';

let state = null;

/** Состояние модуля (для маршрутов). Бросает, если init ещё не вызван. */
export function light() {
  if (!state) throw new Error('модуль light не запущен: init(ctx)');
  return state;
}

/** Адрес брокера для контроллеров (ответ claim): MQTT_PUBLIC_URL или mqtts://{хост PUBLIC_HOST}:8883. */
export function publicMqttUrl(config, env = process.env) {
  if (config?.mqttPublicUrl) return config.mqttPublicUrl;
  if (env.MQTT_PUBLIC_URL) return env.MQTT_PUBLIC_URL;
  const host = config?.publicHost ?? env.PUBLIC_HOST;
  if (host) return `mqtts://${String(host).replace(/:\d+$/, '')}:8883`;
  return config?.mqtt?.url ?? null;
}

export async function init(ctx) {
  if (state) throw new Error('модуль light уже запущен');
  const log = ctx.log;
  const clock = ctx.clock ?? { now: () => new Date() };
  const withContext = ctx.withContext ?? withContextM0;
  const timers = ctx.timers ?? globalThis;
  const pool = ctx.pool;
  const deps = await resolveDeps(ctx, log);

  let bridge = null;
  const service = createLightService({ deps, log, clock, getBridge: () => bridge });
  const logic = createDeviceLogic({ kit: service.kit, log, withContext, pool });
  const scheduler = createScheduler({ pool, withContext, clock, log, tick: service.tick, timers });
  const store = createLightStore(pool, { clock });

  const client = ctx.mqttClient ?? connectMqtt(ctx.config.mqtt);
  bridge = createBridge({
    client,
    store,
    encKey: ctx.config.encKey,
    log,
    now: () => clock.now().getTime(),
    timers,
    actualState: logic.actualState,
    hooks: {
      prepare: logic.prepare,
      onAck: logic.onAck,
      onEvent: logic.onEvent,
      expected: logic.expected,
      onMismatch: logic.onMismatch,
      onOfflineAlarm: logic.onOfflineAlarm,
      onNoAck: logic.onNoAck,
    },
  });
  ctx.bridge = bridge;

  const admin = ctx.config?.mqttAdmin ?? {
    username: process.env.MQTT_ADMIN_USER,
    password: process.env.MQTT_ADMIN_PASSWORD,
  };
  const dynsecConn = ctx.dynsec
    ? { get: async () => ctx.dynsec, close: async () => {} }
    : createDynsecConnector({ url: ctx.config?.mqtt?.url, caFile: ctx.config?.mqtt?.caFile, username: admin.username, password: admin.password, log });
  const binding = createBinding({
    pool,
    withContext,
    clock,
    log,
    audit: service.kit.audit,
    encKey: ctx.config.encKey,
    mqttPublicUrl: publicMqttUrl(ctx.config),
    dynsec: () => dynsecConn.get(),
  });

  // SSE после коммита: session:{id} и club:{id} (контракт §7, server/http/sse.mjs).
  async function publishSession(clubId, sessionId) {
    const view = await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
      const s = await loadSession(db, sessionId);
      if (!s) return null;
      const { rows } = await db.query('select ordinal from bl.session_participants where session_id = $1 order by ordinal', [s.id]);
      // Только общие поля: is_payer зависит от зрителя, клиент берёт его из GET /api/sessions/{id}.
      const { is_payer: _viewerOnly, ...common } = sessionView(s, { now: clock.now(), participants: rows });
      return common;
    });
    if (view) deps.sse.publish(`session:${sessionId}`, 'session', view);
  }

  async function publishHall(clubId, resourceId) {
    if (!isUuid(resourceId)) return;
    const item = await withContext(pool, { clubId, actorType: 'system' }, async (db) => {
      const r = await loadResource(db, resourceId);
      return r ? service.hallItem(db, r) : null;
    });
    if (item) deps.sse.publish(`club:${clubId}`, 'hall', item);
  }

  async function onNotify(m) {
    if (!m || !isUuid(m.c)) return;
    switch (m.k) {
      case 'cmd':
        if (isUuid(m.d)) await bridge.wake(m.d);
        return;
      case 'session':
        if (!isUuid(m.s)) return;
        await scheduler.refresh(m.s, m.c);
        await publishSession(m.c, m.s);
        await publishHall(m.c, m.r);
        return;
      case 'hall':
        await publishHall(m.c, m.r);
        return;
      case 'device':
        if (isUuid(m.d)) bridge.forget(m.d);
        await publishHall(m.c, m.r);
        return;
      default:
    }
  }

  const listener = createListener({
    pool,
    log,
    timers,
    onMessage: onNotify,
    onReconnect: async () => {
      await bridge.wakeAll();
      await scheduler.sweep();
    },
  });

  let stopped = false;
  const guard = (fn) => async (payload, opts) => {
    if (stopped) throw new Error('модуль light остановлен');
    return fn(opts.db, payload);
  };
  const unsubscribe = [
    ctx.outbox.subscribe('payment.confirmed', guard(service.onPaymentConfirmed), { name: 'light.payment_confirmed' }),
    ctx.outbox.subscribe('payment.refunded', guard(service.onPaymentRefunded), { name: 'light.payment_refunded' }),
  ];

  await bridge.start();
  await listener.start();
  await scheduler.start();

  state = {
    ctx,
    deps,
    service,
    logic,
    binding,
    scheduler,
    bridge,
    store,
    clock,
    withContext,
    async stop() {
      stopped = true;
      for (const off of unsubscribe) if (typeof off === 'function') off();
      await listener.stop();
      await scheduler.stop();
      await bridge.stop();
      if (!ctx.mqttClient) await new Promise((resolve) => client.end(false, {}, resolve));
      await dynsecConn.close();
    },
  };
  log.info('light_started', { deps_stubbed: deps.missing });
  return state;
}

export async function stop() {
  if (!state) return;
  const s = state;
  state = null;
  await s.stop();
}
