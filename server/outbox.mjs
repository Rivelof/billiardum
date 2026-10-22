// Outbox (контракт M1 §2.2, decisions №48): события модулей доставляются подписчикам
// после коммита транзакции, в которой записаны.
//
// * enqueue(db, topic, payload) — только внутри транзакции вызывающего (withContext).
//   Клуб события — из контекста транзакции; { clubId: null } — событие платформы.
// * subscribe(topic, handler, { name }) — обработчик выполняется в своей транзакции
//   с контекстом клуба события (actor system); успех и отметка «обработано» (bl.outbox_done)
//   коммитятся вместе. Ошибка — повтор с паузой 1, 2, 4 … до 300 с; после 5 неудач подряд —
//   тревога outbox_failed клубу. Доставка «хотя бы один раз»: обработчики идемпотентны.
// * Задержка — LISTEN bl_outbox (NOTIFY шлёт триггер при вставке) и запасной опрос раз в 1 с.
// * У каждой темы своя очередь (№130): медленный обработчик одной темы не задерживает другие;
//   порядок гарантирован только внутри темы (между темами его не было и раньше: повтор с паузой).

import { afterCommit, withContext } from './lib/store.mjs';

export const POLL_MS = 1_000;
export const BATCH = 100;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 300_000;
export const FAILURES_BEFORE_ALARM = 5;
export const KEEP_PROCESSED_MS = 7 * 24 * 3600_000;
export const CHANNEL = 'bl_outbox';

const TOPIC = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Пауза перед повтором после attempts неудач: 1, 2, 4 … 300 с. */
export function backoffMs(attempts) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

/** Код ошибки для базы и лога: без текста, где могут быть данные (телефоны в ключах уникальности). */
export function errorCode(err) {
  if (err && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
    return `pg:${err.code}${err.constraint ? `:${err.constraint}` : ''}`.slice(0, 200);
  }
  if (err && typeof err.code === 'string') return String(err.code).slice(0, 200);
  return String(err?.message ?? err).replace(/\+?\d[\d\s()-]{6,}\d/g, '***').slice(0, 200);
}

/**
 * Событие в outbox в транзакции вызывающего.
 * @param {import('pg').ClientBase} db
 * @param {string} topic например payment.confirmed
 * @param {object} payload JSON-объект
 * @param {{ clubId?: string|null }} [options] клуб события; по умолчанию — из контекста
 */
export async function enqueue(db, topic, payload, options = {}) {
  if (typeof topic !== 'string' || topic.length > 100 || !TOPIC.test(topic)) throw new Error('outbox.enqueue: topic');
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('outbox.enqueue: payload');
  const fromContext = !('clubId' in options);
  const clubId = fromContext ? null : options.clubId;
  if (clubId !== null && !UUID.test(clubId)) throw new Error('outbox.enqueue: clubId');
  await db.query(
    `insert into bl.outbox (club_id, topic, payload)
     values (case when $1::boolean then bl.ctx_club_id() else $2::uuid end, $3, $4::jsonb)`,
    [fromContext, clubId, topic, JSON.stringify(payload)],
  );
}

/**
 * Обработчик outbox. Подписчики регистрируются до и после start(); имя подписчика —
 * ключ отметки «обработано»: { name } обязательно задавать, если у темы несколько
 * подписчиков в разных модулях (иначе — тема#порядковый номер).
 * @param {{ pollMs?: number, batch?: number, clock?: { now(): Date } }} [options]
 */
export function createOutbox({ pollMs = POLL_MS, batch = BATCH, clock = { now: () => new Date() } } = {}) {
  /** @type {Map<string, { name: string, handler: Function }[]>} */
  const subscribers = new Map();
  let deps = null; // { pool, log, alarms, listen }
  let running = false;
  let stopping = false;
  /** @type {Map<string, { running: Promise<void>|null, again: boolean }>} очереди по темам */
  const lanes = new Map();
  let pollTimer = null;
  let cleanupTimer = null;
  let listener = null;
  let listenRetry = null;
  let wakeScheduled = false;

  function subscribe(topic, handler, { name } = {}) {
    if (typeof topic !== 'string' || !TOPIC.test(topic)) throw new Error('outbox.subscribe: topic');
    if (typeof handler !== 'function') throw new Error('outbox.subscribe: handler');
    const list = subscribers.get(topic) ?? [];
    const subscriber = name ?? `${topic}#${list.length + 1}`;
    if (typeof subscriber !== 'string' || subscriber.length > 200) throw new Error('outbox.subscribe: name');
    if (list.some((s) => s.name === subscriber)) throw new Error(`outbox.subscribe: подписчик ${subscriber} уже есть`);
    list.push({ name: subscriber, handler });
    subscribers.set(topic, list);
    wake();
    return () => {
      const cur = subscribers.get(topic) ?? [];
      subscribers.set(
        topic,
        cur.filter((s) => s.name !== subscriber),
      );
    };
  }

  function wake() {
    if (!running || stopping || wakeScheduled) return;
    wakeScheduled = true;
    setImmediate(() => {
      wakeScheduled = false;
      drain();
    });
  }

  /**
   * Проход обработки: у каждой темы свой курсор и своя очередь (№130) — медленный подписчик
   * одной темы не держит события других тем (payment.confirmed не ждёт уведомлений).
   * Внутри темы порядок — по id. Возвращает обещание, которое ждёт все запущенные очереди.
   */
  function drain() {
    if (!running || stopping) return Promise.all([...lanes.values()].map((l) => l.running).filter(Boolean)).then(() => undefined);
    const topics = [...subscribers.entries()].filter(([, l]) => l.length > 0).map(([t]) => t);
    if (topics.length === 0) return Promise.resolve();
    // Один дешёвый запрос: темы, где есть что обрабатывать; очереди запускаются только для них.
    return withContext(deps.pool, { clubId: null, actorType: 'system' }, (db) =>
      db.query(
        `select distinct o.topic from bl.outbox o
          where o.processed_at is null and o.next_attempt_at <= greatest(now(), $2::timestamptz) and o.topic = any($1)`,
        [topics, clock.now()],
      ),
    )
      .then(({ rows }) => Promise.all(rows.map((r) => runLane(r.topic))))
      .catch((err) => deps.log.error('outbox_drain_failed', { error: errorCode(err) }))
      .then(() => undefined);
  }

  function runLane(topic) {
    let lane = lanes.get(topic);
    if (!lane) {
      lane = { running: null, again: false };
      lanes.set(topic, lane);
    }
    if (lane.running) {
      lane.again = true;
      return lane.running;
    }
    // Сначала создаётся проход, затем сбрасывается running: проход без await завершается
    // синхронно, и finally внутри него сработал бы раньше присваивания.
    const pass = (async () => {
      try {
        do {
          lane.again = false;
          if ((subscribers.get(topic) ?? []).length === 0) break;
          const { rows } = await withContext(deps.pool, { clubId: null, actorType: 'system' }, (db) =>
            db.query(
              `select o.id, o.club_id, o.topic, o.attempts,
                      array(select d.subscriber from bl.outbox_done d where d.event_id = o.id) as done
                 from bl.outbox o
                where o.processed_at is null and o.next_attempt_at <= greatest(now(), $2::timestamptz) and o.topic = $1
                order by o.id
                limit $3`,
              [topic, clock.now(), batch],
            ),
          );
          for (const ev of rows) {
            if (stopping) break;
            await processEvent(ev);
          }
          if (rows.length === batch) lane.again = true;
        } while (lane.again && !stopping);
      } catch (err) {
        deps.log.error('outbox_drain_failed', { topic, error: errorCode(err) });
      }
    })();
    lane.running = pass.then(() => {
      lane.running = null;
    });
    return lane.running;
  }

  async function processEvent(ev) {
    const subs = (subscribers.get(ev.topic) ?? []).filter((s) => !ev.done.includes(s.name));
    const total = (subscribers.get(ev.topic) ?? []).length;
    let doneCount = total - subs.length;
    let failure = null;
    for (const sub of subs) {
      const started = Date.now();
      try {
        const status = await withContext(
          deps.pool,
          { clubId: ev.club_id, actorType: 'system' },
          async (db) => {
            const lock = await db.query('select payload, processed_at from bl.outbox where id = $1 for update skip locked', [ev.id]);
            if (lock.rowCount === 0 || lock.rows[0].processed_at) return 'skipped';
            const seen = await db.query('select 1 from bl.outbox_done where event_id = $1 and subscriber = $2', [ev.id, sub.name]);
            if (seen.rowCount > 0) return 'skipped';
            await sub.handler(lock.rows[0].payload, {
              db,
              log: deps.log,
              clubId: ev.club_id,
              eventId: Number(ev.id),
              topic: ev.topic,
              attempt: ev.attempts + 1,
              afterCommit: (fn) => afterCommit(db, fn),
            });
            await db.query('insert into bl.outbox_done (event_id, subscriber, club_id) values ($1, $2, $3)', [ev.id, sub.name, ev.club_id]);
            if (doneCount + 1 >= total) {
              await db.query('update bl.outbox set processed_at = $2 where id = $1', [ev.id, clock.now()]);
            }
            return 'done';
          },
          { onHookError: (err) => deps.log.error('outbox_after_commit_failed', { topic: ev.topic, error: errorCode(err) }) },
        );
        if (status === 'done') {
          doneCount += 1;
          deps.log.debug('outbox_done', { id: Number(ev.id), topic: ev.topic, subscriber: sub.name, ms: Date.now() - started });
        } else {
          return;
        }
      } catch (err) {
        // Остальные подписчики события обрабатываются: сбой одного модуля не держит другие.
        failure ??= { sub, err };
      }
    }
    if (failure) {
      await recordFailure(ev, failure.sub, failure.err);
      return;
    }
    if (subs.length === 0 && total > 0) {
      // Все подписчики уже отметились (например, подписчик добавлен позже) — закрыть событие.
      await withContext(deps.pool, { clubId: ev.club_id, actorType: 'system' }, (db) =>
        db.query('update bl.outbox set processed_at = $2 where id = $1 and processed_at is null', [ev.id, clock.now()]),
      );
    }
  }

  async function recordFailure(ev, sub, err) {
    const code = errorCode(err);
    try {
      const attempts = ev.attempts + 1;
      const next = new Date(clock.now().getTime() + backoffMs(attempts));
      const { rows } = await withContext(deps.pool, { clubId: null, actorType: 'system' }, (db) =>
        db.query(
          `update bl.outbox set attempts = attempts + 1, next_attempt_at = $2, last_error = $3
            where id = $1
            returning attempts, alarmed_at`,
          [ev.id, next, code],
        ),
      );
      const row = rows[0];
      deps.log.warn('outbox_handler_failed', { id: Number(ev.id), topic: ev.topic, subscriber: sub.name, attempts: row?.attempts, error: code });
      if (row && row.attempts >= FAILURES_BEFORE_ALARM && !row.alarmed_at) {
        await withContext(deps.pool, { clubId: null, actorType: 'system' }, (db) =>
          db.query('update bl.outbox set alarmed_at = $2 where id = $1', [ev.id, clock.now()]),
        );
        deps.log.error('outbox_failed', { id: Number(ev.id), topic: ev.topic, subscriber: sub.name, attempts: row.attempts, error: code });
        if (ev.club_id && deps.alarms) {
          await withContext(deps.pool, { clubId: ev.club_id, actorType: 'system' }, (db) =>
            deps.alarms.raise(db, ev.club_id, {
              type: 'outbox_failed',
              level: 'critical',
              data: { topic: ev.topic, event_id: Number(ev.id), attempts: row.attempts },
            }),
          );
        }
      }
    } catch (err2) {
      deps.log.error('outbox_failure_record_failed', { id: Number(ev.id), error: errorCode(err2) });
    }
  }

  async function startListener() {
    if (!deps.listen || stopping) return;
    let client;
    try {
      client = await deps.pool.connect();
      const onError = (err) => {
        deps.log.warn('outbox_listen_lost', { error: errorCode(err) });
        if (listener?.client === client) listener = null;
        client.release(err);
        scheduleListen();
      };
      client.on('notification', (msg) => {
        if (msg.channel === CHANNEL) wake();
      });
      client.on('error', onError);
      await client.query(`listen ${CHANNEL}`);
      listener = { client, onError };
      wake();
    } catch (err) {
      deps.log.warn('outbox_listen_failed', { error: errorCode(err) });
      if (client) client.release(err);
      scheduleListen();
    }
  }

  function scheduleListen() {
    if (stopping || listenRetry) return;
    listenRetry = setTimeout(() => {
      listenRetry = null;
      startListener();
    }, 1_000);
  }

  async function cleanup() {
    try {
      const cutoff = new Date(clock.now().getTime() - KEEP_PROCESSED_MS);
      await withContext(deps.pool, { clubId: null, actorType: 'system' }, (db) =>
        db.query('delete from bl.outbox where processed_at is not null and processed_at < $1', [cutoff]),
      );
    } catch (err) {
      deps.log.warn('outbox_cleanup_failed', { error: errorCode(err) });
    }
  }

  return {
    subscribe,
    enqueue,

    /**
     * @param {{ pool: import('pg').Pool, log: any, alarms?: { raise: Function }, listen?: boolean }} options
     */
    async start({ pool, log, alarms = null, listen = true }) {
      if (running) return;
      deps = { pool, log, alarms, listen };
      running = true;
      stopping = false;
      await startListener();
      pollTimer = setInterval(() => drain(), pollMs);
      cleanupTimer = setInterval(() => cleanup(), 3600_000);
      cleanupTimer.unref?.();
      wake();
    },

    /** Один проход обработки (тесты и ожидание). */
    drain,

    async stop() {
      if (!running) return;
      stopping = true;
      clearInterval(pollTimer);
      clearInterval(cleanupTimer);
      clearTimeout(listenRetry);
      listenRetry = null;
      await Promise.all([...lanes.values()].map((l) => l.running).filter(Boolean));
      if (listener) {
        const { client, onError } = listener;
        listener = null;
        client.removeListener('error', onError);
        try {
          await client.query(`unlisten ${CHANNEL}`);
          client.release();
        } catch (err) {
          client.release(err);
        }
      }
      running = false;
    },

    get topics() {
      return [...subscribers.keys()];
    },
  };
}

/** Общий outbox процесса (контракт §13: import { enqueue, subscribe } from 'server/outbox.mjs'). */
export const outbox = createOutbox();

export function subscribe(topic, handler, options) {
  return outbox.subscribe(topic, handler, options);
}
