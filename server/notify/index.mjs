// Уведомления (контракт M1 §7, §13; PRODUCT §12).
//
// send(db, userId, msg) и sendToClubStaff(db, clubId, roles, msg) пишут bl.notifications
// (status queued) и событие outbox notify.deliver в транзакции вызывающего: уведомление уходит
// только о том, что закоммичено. Доставка — своим воркером вне транзакций outbox (№130:
// медленный канал не задерживает события денег и света), параллельно и с общим бюджетом
// времени, по цепочке каналов пользователя: основной канал (users.notify_channel) или
// выбранный порядок, затем max → telegram → webpush из доступных. Не доставилось — следующий
// канал; уровень critical — во все каналы.
// MAX — адаптер-заглушка до документации (skipped); Telegram — только через прокси
// (без токена или прокси — skipped); Web Push — RFC 8291/8292 (webpush.mjs).
// В тексте нет персональных данных (decisions №53): длинные последовательности цифр
// (телефоны) заменяются на ***.

import { randomUUID } from 'node:crypto';
import { enqueue } from '../outbox.mjs';
import { endpointAllowed, loadVapid, sendPush } from './webpush.mjs';

export const TOPIC = 'notify.deliver';
export const CHANNELS = ['max', 'telegram', 'webpush'];
export const LEVELS = ['critical', 'important', 'info'];
const KIND = /^[a-z][a-z0-9_.]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * Цифры с короткими (1–2 знака) разделителями между ними: пробелы (и неразрывные), точки, косые,
 * скобки, дефисы и тире, «+», «*», «_», «|» и их сочетания (M4-5: «+7.912.345.67.81», «8/912/345/67/82»);
 * вокруг разделителя допустимо по пробелу («8 - 912 - 345 - 67 - 89», как и раньше).
 * Запятая и двоеточие — не разделители: списки цен и время («21:30, 22:00») не склеиваются.
 */
const NUMBER_RUN = /\+?\d(?:\s?[\s./\\()\-‐-―+*_|]{1,2}\s?\d|\d)*/g;
/** Даты (21.10.2026, 21/10/2026, 2026-10-21) не считаются частью номера: «21.10.2026 12:30» остаётся. */
const DATE_TOKEN = /((?<!\d)(?:(?:0?[1-9]|[12]\d|3[01])[./](?:0?[1-9]|1[0-2])[./](?:19|20)\d{2}|(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?!\d))/;
export const MAX_TEXT = 1000;

function maskRuns(part) {
  return part.replace(NUMBER_RUN, (m) => (m.replace(/\D/g, '').length >= 10 ? '***' : m));
}

/**
 * Последовательности из 10 и больше цифр (телефоны, номера карт) → ***, в том числе с разделителями
 * из точек, косых, пробелов, скобок и дефисов; даты, время и суммы («1 490 ₽») остаются.
 * Хеши (32+ шестнадцатеричных знака, например голова журнала в сводке) не трогаются.
 */
export function maskPhones(text) {
  return String(text)
    .split(/([0-9a-f]{32,})/)
    .map((part, i) => (i % 2 === 1 ? part : part.split(DATE_TOKEN).map((p, j) => (j % 2 === 1 ? p : maskRuns(p))).join('')))
    .join('');
}

/** Текст без телефонов и других длинных номеров. */
export function sanitizeText(text) {
  return maskPhones(text).slice(0, MAX_TEXT);
}

function cleanValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean' || v === null) return v;
  if (typeof v === 'string' && v.length <= 200) return UUID.test(v) ? v : maskPhones(v);
  return undefined;
}

/**
 * data без вложенных объектов и длинных строк — идентификаторы, числа, короткие коды
 * и массивы из них (до 20 элементов, например actions: ['extend', 'stop']).
 */
export function cleanData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(k)) continue;
    if (Array.isArray(v)) {
      if (v.length > 20) continue;
      const items = v.map(cleanValue);
      if (items.every((x) => x !== undefined)) out[k] = items;
      continue;
    }
    const c = cleanValue(v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/**
 * Уведомление пользователю в транзакции вызывающего.
 * @param {import('pg').ClientBase} db
 * @param {string} userId
 * @param {{ kind: string, text: string, data?: object, level?: 'critical'|'important'|'info' }} msg
 * @returns {Promise<{ id: string }>}
 */
const ACTION_ID = /^[a-z][a-z0-9_]{0,30}$/;
export const MAX_ACTIONS = 5;

/** Относительный путь своего сайта (без схемы и хоста) или null. */
function localUrl(url) {
  return typeof url === 'string' && url.length <= 300 && /^\/[^/\\]/.test(url) && !/[\s<>"]/.test(url) ? url : null;
}

/**
 * Действия уведомления: [{id, title, url?}] — «Продлить», «Принять предложение».
 * url — только путь своего сайта; title — до 40 символов без длинных номеров.
 */
export function cleanActions(actions) {
  if (actions === undefined || actions === null) return [];
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) throw new Error('notify.send: actions');
  return actions.map((a) => {
    if (!a || typeof a !== 'object' || !ACTION_ID.test(a.id) || typeof a.title !== 'string' || a.title.trim() === '' || a.title.length > 40) {
      throw new Error('notify.send: action');
    }
    const url = a.url === undefined ? null : localUrl(a.url);
    if (a.url !== undefined && !url) throw new Error('notify.send: action url');
    return url ? { id: a.id, title: maskPhones(a.title.trim()), url } : { id: a.id, title: maskPhones(a.title.trim()) };
  });
}

/**
 * Уведомление пользователю в транзакции вызывающего (контракт M3 §3). Доставка — после
 * коммита по цепочке каналов (обработчик outbox notify.deliver).
 * @param {import('pg').ClientBase} db
 * @param {string} userId
 * @param {{ kind: string, text: string, data?: object, level?: 'critical'|'important'|'info',
 *           actions?: { id: string, title: string, url?: string }[] }} msg
 * @returns {Promise<{ notification_id: string, id: string }>}
 */
export async function send(db, userId, { kind, text, data = {}, level = 'info', actions }) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('notify.send: userId');
  if (typeof kind !== 'string' || !KIND.test(kind)) throw new Error('notify.send: kind');
  if (typeof text !== 'string' || text.trim() === '') throw new Error('notify.send: text');
  if (!LEVELS.includes(level)) throw new Error('notify.send: level');
  const acts = cleanActions(actions);
  const id = randomUUID();
  await db.query(
    `insert into bl.notifications (id, club_id, user_id, kind, level, text, data, actions)
     values ($1, bl.ctx_club_id(), $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [id, userId, kind, level, sanitizeText(text), JSON.stringify(cleanData(data)), JSON.stringify(acts)],
  );
  await enqueue(db, TOPIC, { notification_id: id }, { clubId: null });
  return { notification_id: id, id };
}

/**
 * Уведомление персоналу клуба с ролями roles. Вызывается в контексте этого клуба.
 * @returns {Promise<{ ids: string[] }>}
 */
export async function sendToClubStaff(db, clubId, roles, msg) {
  const { rows } = await db.query(
    'select distinct user_id from bl.club_members where club_id = $1 and role = any($2::text[]) and active order by user_id',
    [clubId, roles],
  );
  const ids = [];
  for (const r of rows) ids.push((await send(db, r.user_id, msg)).id);
  return { ids };
}

/** Роли получателей уведомлений платформы (№134). */
export const PLATFORM_RECIPIENTS = ['platform_operator', 'platform_admin'];

/**
 * Уведомление платформе (M4): всем операторам (role 'platform_operator'; операторов нет —
 * администраторам) или Андрею (role 'platform_admin'). В транзакции вызывающего, в любом
 * контексте (получатели — bl.platform_recipients). Остальное — как send.
 * @returns {Promise<{ ids: string[] }>}
 */
export async function sendPlatform(db, { role, ...msg }) {
  if (!PLATFORM_RECIPIENTS.includes(role)) throw new Error('notify.sendPlatform: role');
  const { rows } = await db.query('select r as user_id from bl.platform_recipients($1) r order by r', [role]);
  const ids = [];
  for (const r of rows) ids.push((await send(db, r.user_id, msg)).id);
  return { ids };
}

/** Заголовок push-уведомления по виду. */
export function pushTitle(kind) {
  if (kind === 'alarm') return 'Тревога в клубе';
  if (kind.startsWith('session.')) return 'Игра';
  if (kind.startsWith('reception')) return 'Ресепшн';
  if (kind.startsWith('platform.')) return 'Бильярдум: платформа';
  return 'Бильярдум';
}

/**
 * Цепочка каналов (№110): порядок, выбранный пользователем (channels_order), из доступных;
 * без него — основной канал (если доступен), затем max → telegram → webpush.
 * Уровни critical и important после выбранных каналов уходят и в остальные доступные (№130):
 * выбор порядка не отрезает запасные каналы.
 */
export function channelChain(route, hasPush, level = 'info') {
  const available = CHANNELS.filter(
    (c) => (c === 'max' && route?.max_user_id) || (c === 'telegram' && route?.telegram_user_id) || (c === 'webpush' && hasPush),
  );
  if (Array.isArray(route?.channels_order) && route.channels_order.length > 0) {
    const chosen = route.channels_order.filter((c, i, all) => available.includes(c) && all.indexOf(c) === i);
    if (level === 'critical' || level === 'important') return [...chosen, ...available.filter((c) => !chosen.includes(c))];
    return chosen;
  }
  const preferred = route?.notify_channel;
  if (preferred && available.includes(preferred)) return [preferred, ...available.filter((c) => c !== preferred)];
  return available;
}

/**
 * Доставка уведомлений: каналы и обработчик outbox notify.deliver.
 * @param {{ config: object, log: any, telegram?: { configured: boolean, call: Function }, clock?: { now(): Date },
 *           pushRequest?: Function, maxSend?: Function }} deps
 */
/** Нет подтверждения доставки мессенджером за это время — следующий канал (№110). */
export const DELIVERY_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'failed', code: 'timeout' }), ms);
      timer.unref?.();
    }),
  ]);
}

/** Общий бюджет времени на одно уведомление (все каналы цепочки, №130). */
export const NOTIFY_BUDGET_MS = 60_000;
/** Сколько уведомлений доставляется одновременно (№130). */
export const NOTIFY_CONCURRENCY = 4;
/** Захват «sending» старше этого — процесс упал во время доставки: продолжить с непройденных каналов. */
export const NOTIFY_LEASE_MS = NOTIFY_BUDGET_MS + 30_000;
export const NOTIFY_POLL_MS = 1_000;

/**
 * Доставка уведомлений: каналы, своя очередь и воркер (№130).
 * send() пишет bl.notifications (status queued) и событие outbox notify.deliver; обработчик
 * outbox только будит воркер. Воркер вне транзакций outbox захватывает уведомление
 * (status sending, claimed_at), ходит в каналы с параллелизмом NOTIFY_CONCURRENCY и общим
 * бюджетом NOTIFY_BUDGET_MS, каждую попытку отмечает до вызова канала (started) и после:
 * повтор после сбоя процесса не шлёт второй раз в канал, где попытка уже была.
 * telegram и max — клиенты одной формы { configured, call(method, params) }; MAX до
 * документации не настроен (not_configured → сразу следующий канал).
 */
export function createNotifier({
  config,
  log,
  telegram = null,
  max = null,
  clock = { now: () => new Date() },
  pushRequest,
  deliveryTimeoutMs = DELIVERY_TIMEOUT_MS,
  budgetMs = NOTIFY_BUDGET_MS,
  concurrency = NOTIFY_CONCURRENCY,
  pollMs = NOTIFY_POLL_MS,
}) {
  const site = config.publicHost ? `https://${config.publicHost}` : null;
  const absolute = (url) => (site && url ? `${site}${url}` : null);
  let vapid = null;
  if (config.vapid?.publicKey && config.vapid?.privateKey) {
    try {
      vapid = loadVapid(config.vapid);
    } catch (err) {
      log.error('vapid_invalid', { error: err.message });
    }
  }
  const pushHosts = config.pushHosts;

  // Адаптеры каналов: q(sql, params) — короткий запрос к базе (вне сетевого ожидания в воркере).
  const adapters = {
    async max(n, route) {
      if (!max?.configured) return { status: 'skipped', code: 'not_configured' };
      try {
        const buttons = n.actions.filter((a) => a.url && absolute(a.url)).map((a) => ({ type: 'link', text: a.title, url: absolute(a.url) }));
        await max.call('sendMessage', { user_id: route.max_user_id, text: n.text, ...(buttons.length ? { buttons } : {}) });
        return { status: 'sent' };
      } catch (err) {
        return { status: 'failed', code: err.code ?? 'error' };
      }
    },
    async telegram(n, route) {
      if (!telegram?.configured) return { status: 'skipped', code: 'not_configured' };
      try {
        // Действия — кнопки со ссылкой на свой сайт (callback-кнопки без обработчика не нужны).
        const buttons = n.actions.filter((a) => a.url && absolute(a.url)).map((a) => [{ text: a.title, url: absolute(a.url) }]);
        await telegram.call('sendMessage', {
          chat_id: Number(route.telegram_user_id),
          text: n.text,
          disable_web_page_preview: true,
          ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
        });
        return { status: 'sent' };
      } catch (err) {
        return { status: 'failed', code: err.code ?? 'error' };
      }
    },
    async webpush(n, _route, q, subs) {
      if (!vapid) return { status: 'skipped', code: 'not_configured' };
      // §14: тело Web Push — {title, body, url, tag}, без персональных данных (№53).
      const payload = {
        title: pushTitle(n.kind),
        body: n.text,
        tag: n.kind,
        url: localUrl(n.data?.url) ?? n.actions.find((a) => a.url)?.url ?? undefined,
        ...(n.actions.length ? { actions: n.actions.map((a) => ({ action: a.id, title: a.title, ...(a.url ? { url: a.url } : {}) })) } : {}),
      };
      // Подписки — параллельно: одна медленная не держит остальные.
      const results = await Promise.all(
        subs.map((s) =>
          sendPush(s, payload, {
            vapid,
            urgency: n.level === 'critical' ? 'high' : 'normal',
            now: clock.now(),
            ...(pushRequest ? { request: pushRequest } : {}),
            ...(pushHosts ? { hosts: pushHosts } : {}),
          }).catch(() => ({ status: 'failed', code: 'error' })),
        ),
      );
      let sent = 0;
      let last = 'no_subscription';
      for (const [i, res] of results.entries()) {
        const s = subs[i];
        last = res.code;
        if (res.status === 'sent') {
          sent += 1;
          await q('update bl.push_subscriptions set last_success_at = $2, failed_count = 0 where id = $1', [s.id, clock.now()]);
        } else if (res.status === 'gone') {
          await q('update bl.push_subscriptions set revoked_at = $2 where id = $1', [s.id, clock.now()]);
        } else {
          await q('update bl.push_subscriptions set failed_count = failed_count + 1 where id = $1', [s.id]);
        }
      }
      return sent > 0 ? { status: 'sent' } : { status: 'failed', code: last };
    },
  };

  /**
   * Доставка одного уведомления по цепочке каналов. n — строка bl.notifications (её attempts —
   * попытки прошлого захвата: каналы, где попытка начата или прошла, не повторяются).
   */
  async function deliverRow(n, q) {
    const started = Date.now();
    const route = (await q('select * from bl.notify_route($1)', [n.user_id])).rows[0] ?? null;
    const subs = (
      await q(
        'select id, endpoint, p256dh, auth from bl.push_subscriptions where user_id = $1 and revoked_at is null order by updated_at desc limit 10',
        [n.user_id],
      )
    ).rows.filter((s) => endpointAllowed(s.endpoint, pushHosts));
    const chain = channelChain(route, subs.length > 0, n.level);
    const all = n.level === 'critical';
    const attempts = Array.isArray(n.attempts) ? [...n.attempts] : [];
    // Прошлый захват: «started» без результата — исход неизвестен, канал не повторяется (не слать дважды).
    for (const a of attempts) if (a.status === 'started') a.status = 'unknown';
    let sentVia = attempts.find((a) => a.status === 'sent')?.channel ?? null;
    const tried = new Set(attempts.map((a) => a.channel));
    n.actions = Array.isArray(n.actions) ? n.actions : [];
    const save = () => q('update bl.notifications set attempts = $2::jsonb where id = $1', [n.id, JSON.stringify(attempts)]);
    for (const channel of chain) {
      if (sentVia && !all) break;
      if (tried.has(channel)) continue;
      const left = budgetMs - (Date.now() - started);
      if (left <= 0) {
        attempts.push({ channel, status: 'failed', code: 'budget', at: clock.now().toISOString() });
        continue;
      }
      const entry = { channel, status: 'started', at: clock.now().toISOString() };
      attempts.push(entry);
      await save();
      // Мессенджеры: нет подтверждения за deliveryTimeoutMs — следующий канал (№110); всё — в пределах бюджета.
      const limit = channel === 'webpush' ? left : Math.min(deliveryTimeoutMs, left);
      const res = await withTimeout(adapters[channel](n, route, q, subs), limit);
      entry.status = res.status;
      if (res.code) entry.code = res.code;
      entry.at = clock.now().toISOString();
      await save();
      if (res.status === 'skipped') log.info('notify_skipped', { notification_id: n.id, kind: n.kind, channel, code: res.code });
      if (res.status === 'sent') sentVia ??= channel;
    }
    const status = sentVia ? 'sent' : attempts.length === 0 || attempts.every((a) => a.status === 'skipped') ? 'skipped' : 'failed';
    await q('update bl.notifications set status = $2, channel = $3, attempts = $4::jsonb, sent_at = $5, claimed_at = null where id = $1', [
      n.id,
      status,
      sentVia,
      JSON.stringify(attempts),
      sentVia ? clock.now() : null,
    ]);
    const fields = { notification_id: n.id, kind: n.kind, level: n.level, channel: sentVia, tried: attempts.map((a) => `${a.channel}:${a.status}`) };
    if (status === 'sent') log.info('notify_sent', fields);
    else if (status === 'skipped') log.info('notify_skipped', fields);
    else log.warn('notify_failed', fields);
  }

  /**
   * Доставить уведомление в транзакции db (контекст платформы) — для проверок и ручного
   * повтора; в работе доставляет воркер. Повтор доставки не дублирует.
   */
  async function deliver(payload, { db }) {
    const id = payload?.notification_id;
    if (typeof id !== 'string' || !UUID.test(id)) return;
    const { rows } = await db.query('select * from bl.notifications where id = $1 for update', [id]);
    const n = rows[0];
    if (!n || n.status !== 'queued') return;
    await deliverRow(n, (sql, params) => db.query(sql, params));
  }

  // Воркер очереди уведомлений.
  let pool = null;
  let withCtx = null;
  let active = 0;
  let pumping = false;
  let pumpAgain = false;
  let timer = null;
  let stopping = false;
  const inflight = new Set();
  const platformQuery = (sql, params) => withCtx(pool, { clubId: null, actorType: 'system' }, (db) => db.query(sql, params));

  async function claim(id = null) {
    const lease = new Date(clock.now().getTime() - NOTIFY_LEASE_MS);
    const { rows } = await platformQuery(
      `update bl.notifications set status = 'sending', claimed_at = $1
        where id = (select id from bl.notifications
                     where (status = 'queued' or (status = 'sending' and claimed_at < $2))
                       and ($3::uuid is null or id = $3::uuid)
                     order by created_at
                     limit 1
                     for update skip locked)
        returning *`,
      [clock.now(), lease, id],
    );
    return rows[0] ?? null;
  }

  function run(n) {
    active += 1;
    const p = deliverRow(n, platformQuery)
      .catch(async (err) => {
        log.error('notify_deliver_failed', { notification_id: n.id, error: err.code ?? err.message });
        // Захват снимается: следующий проход продолжит с непройденных каналов (после аренды).
      })
      .finally(() => {
        active -= 1;
        inflight.delete(p);
        pump();
      });
    inflight.add(p);
    return p;
  }

  async function pump() {
    if (!pool || stopping) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        while (active < concurrency && !stopping) {
          const n = await claim();
          if (!n) break;
          run(n);
        }
      } while (pumpAgain && !stopping);
    } catch (err) {
      log.error('notify_claim_failed', { error: err.code ?? err.message });
    } finally {
      pumping = false;
    }
  }

  return {
    send,
    sendToClubStaff,
    sendPlatform,
    deliver,
    vapidPublicKey: vapid?.publicKey ?? null,
    /** Какие каналы настроены на сервере (№126): MAX — заглушка, Telegram — токен и прокси, Web Push — VAPID. */
    configured() {
      return { max: Boolean(max?.configured), telegram: Boolean(telegram?.configured), webpush: Boolean(vapid) };
    },
    /** Подписать на outbox: обработчик только будит воркер после коммита (сеть — вне транзакций outbox). */
    register(outbox) {
      return outbox.subscribe(TOPIC, (_payload, { afterCommit } = {}) => (afterCommit ? afterCommit(() => pump()) : pump()), {
        name: 'core.notify.deliver',
      });
    },
    /** Запустить воркер очереди. */
    start({ pool: p, withContext }) {
      if (pool) return;
      pool = p;
      withCtx = withContext;
      stopping = false;
      timer = setInterval(() => pump(), pollMs);
      timer.unref?.();
      pump();
    },
    /** Доставить одно уведомление воркером сейчас (проверки): захват, каналы, итог. */
    async deliverNow(id) {
      const n = await claim(id);
      if (n) await run(n);
    },
    /** Дождаться текущих доставок (проверки). */
    async idle() {
      while (inflight.size > 0 || pumping) await Promise.all([...inflight, new Promise((r) => setTimeout(r, 5))]);
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await Promise.allSettled([...inflight]);
      pool = null;
    },
  };
}
