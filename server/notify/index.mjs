// Уведомления (контракт M1 §7, §13; PRODUCT §12).
//
// send(db, userId, msg) и sendToClubStaff(db, clubId, roles, msg) пишут bl.notifications
// и событие outbox notify.deliver в транзакции вызывающего: уведомление уходит только
// о том, что закоммичено. Доставка — обработчиком outbox в контексте платформы по цепочке
// каналов пользователя: основной канал (users.notify_channel), затем max → telegram →
// webpush из доступных. Не доставилось — следующий канал; уровень critical — во все каналы.
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
const NUMBER_RUN = /\+?\d[\d\s()-]{6,}\d/g;
export const MAX_TEXT = 1000;

/**
 * Последовательности из 10 и больше цифр (телефоны, номера карт) → ***; даты и суммы остаются.
 * Хеши (32+ шестнадцатеричных знака, например голова журнала в сводке) не трогаются.
 */
export function maskPhones(text) {
  return String(text)
    .split(/([0-9a-f]{32,})/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(NUMBER_RUN, (m) => (m.replace(/\D/g, '').length >= 10 ? '***' : m))))
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

/** Заголовок push-уведомления по виду. */
export function pushTitle(kind) {
  if (kind === 'alarm') return 'Тревога в клубе';
  if (kind.startsWith('session.')) return 'Игра';
  if (kind.startsWith('reception')) return 'Ресепшн';
  return 'Бильярдум';
}

/**
 * Цепочка каналов (№110): порядок, выбранный пользователем (channels_order), из доступных;
 * без него — основной канал (если доступен), затем max → telegram → webpush.
 */
export function channelChain(route, hasPush) {
  const available = CHANNELS.filter(
    (c) => (c === 'max' && route?.max_user_id) || (c === 'telegram' && route?.telegram_user_id) || (c === 'webpush' && hasPush),
  );
  if (Array.isArray(route?.channels_order) && route.channels_order.length > 0) {
    return route.channels_order.filter((c, i, all) => available.includes(c) && all.indexOf(c) === i);
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

/**
 * Доставка уведомлений: каналы и обработчик outbox notify.deliver.
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
    async webpush(n, _route, db, subs) {
      if (!vapid) return { status: 'skipped', code: 'not_configured' };
      // §14: тело Web Push — {title, body, url, tag}, без персональных данных (№53).
      const payload = {
        title: pushTitle(n.kind),
        body: n.text,
        tag: n.kind,
        url: localUrl(n.data?.url) ?? n.actions.find((a) => a.url)?.url ?? undefined,
        ...(n.actions.length ? { actions: n.actions.map((a) => ({ action: a.id, title: a.title, ...(a.url ? { url: a.url } : {}) })) } : {}),
      };
      let sent = 0;
      let last = 'no_subscription';
      for (const s of subs) {
        const res = await sendPush(s, payload, {
          vapid,
          urgency: n.level === 'critical' ? 'high' : 'normal',
          now: clock.now(),
          ...(pushRequest ? { request: pushRequest } : {}),
          ...(pushHosts ? { hosts: pushHosts } : {}),
        });
        last = res.code;
        if (res.status === 'sent') {
          sent += 1;
          await db.query('update bl.push_subscriptions set last_success_at = $2, failed_count = 0 where id = $1', [s.id, clock.now()]);
        } else if (res.status === 'gone') {
          await db.query('update bl.push_subscriptions set revoked_at = $2 where id = $1', [s.id, clock.now()]);
        } else {
          await db.query('update bl.push_subscriptions set failed_count = failed_count + 1 where id = $1', [s.id]);
        }
      }
      return sent > 0 ? { status: 'sent' } : { status: 'failed', code: last };
    },
  };

  /** Обработчик outbox notify.deliver (контекст платформы). Повтор доставки не дублирует. */
  async function deliver(payload, { db }) {
    const id = payload?.notification_id;
    if (typeof id !== 'string' || !UUID.test(id)) return;
    const { rows } = await db.query('select * from bl.notifications where id = $1 for update', [id]);
    const n = rows[0];
    if (!n || n.status !== 'queued') return;
    const route = (await db.query('select * from bl.notify_route($1)', [n.user_id])).rows[0] ?? null;
    const subs = (
      await db.query(
        'select id, endpoint, p256dh, auth from bl.push_subscriptions where user_id = $1 and revoked_at is null order by updated_at desc limit 10',
        [n.user_id],
      )
    ).rows.filter((s) => endpointAllowed(s.endpoint, pushHosts));
    const chain = channelChain(route, subs.length > 0);
    const all = n.level === 'critical';
    const attempts = [];
    let sentVia = null;
    n.actions = Array.isArray(n.actions) ? n.actions : [];
    for (const channel of chain) {
      // Мессенджеры: нет подтверждения за deliveryTimeoutMs — следующий канал (№110).
      const attempt = adapters[channel](n, route, db, subs);
      const res = channel === 'webpush' ? await attempt : await withTimeout(attempt, deliveryTimeoutMs);
      attempts.push({ channel, status: res.status, ...(res.code ? { code: res.code } : {}), at: clock.now().toISOString() });
      if (res.status === 'skipped') log.info('notify_skipped', { notification_id: n.id, kind: n.kind, channel, code: res.code });
      if (res.status === 'sent') {
        sentVia ??= channel;
        if (!all) break;
      }
    }
    const status = sentVia ? 'sent' : attempts.length === 0 || attempts.every((a) => a.status === 'skipped') ? 'skipped' : 'failed';
    await db.query('update bl.notifications set status = $2, channel = $3, attempts = $4::jsonb, sent_at = $5 where id = $1', [
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

  return {
    send,
    sendToClubStaff,
    deliver,
    vapidPublicKey: vapid?.publicKey ?? null,
    /** Подписать обработчик доставки на outbox. */
    register(outbox) {
      return outbox.subscribe(TOPIC, deliver, { name: 'core.notify.deliver' });
    },
  };
}
