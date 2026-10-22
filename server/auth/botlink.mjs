// Вход в PWA через бота (decisions №49, контракт M1 §4).
//
// 1. POST /api/auth/bot-link {channel} → nonce (32 байта), deep link https://t.me/<бот>?start=<nonce>
//    и cookie bl_link с секретом браузера: токен потом получит только этот браузер.
// 2. Гость открывает бота, тот получает «/start <nonce>» → nonce связывается с аккаунтом
//    мессенджера; бот просит «Поделиться контактом» (если телефон уже известен — сразу готово).
// 3. Контакт (только свой: contact.user_id = from.id) → пользователь найден или создан,
//    телефон привязан (bl.auth_attach_phone), nonce → done.
// 4. GET /api/auth/bot-link/{nonce} с cookie → {status: done, token} один раз, затем consumed.
// Срок nonce — 10 минут. В базе только sha256 nonce и секрета браузера.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setContext } from '../lib/store.mjs';
import { normalizePhone, tokenHash } from './index.mjs';

export const NONCE_TTL_MS = 10 * 60_000;
export const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function newNonce() {
  return randomBytes(32).toString('base64url');
}

/** Секрет вебхука Telegram (X-Telegram-Bot-Api-Secret-Token) — сравнение за постоянное время. */
export function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Создать nonce (контекст платформы). */
export async function createLink(db, { channel, browserSecret, now }) {
  const nonce = newNonce();
  const expiresAt = new Date(now.getTime() + NONCE_TTL_MS);
  await db.query(
    `insert into bl.bot_link_nonces (nonce_hash, browser_hash, channel, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [tokenHash(nonce), tokenHash(browserSecret), channel, now, expiresAt],
  );
  return { nonce, expiresAt };
}

/**
 * Состояние nonce для браузера с секретом browserSecret (контекст платформы).
 * @returns {Promise<null | { status: 'pending'|'done'|'expired'|'consumed', userId?: string, id: string }>}
 */
export async function pollLink(db, { nonce, browserSecret, now }) {
  if (!NONCE.test(nonce) || typeof browserSecret !== 'string' || !NONCE.test(browserSecret)) return null;
  const { rows } = await db.query(
    'select id, browser_hash, status, user_id, expires_at from bl.bot_link_nonces where nonce_hash = $1 for update',
    [tokenHash(nonce)],
  );
  const r = rows[0];
  if (!r || !secretMatches(r.browser_hash, tokenHash(browserSecret))) return null;
  if (r.status === 'consumed') return { id: r.id, status: 'consumed' };
  if (r.status === 'done') {
    await db.query("update bl.bot_link_nonces set status = 'consumed', consumed_at = $2 where id = $1", [r.id, now]);
    return { id: r.id, status: 'done', userId: r.user_id };
  }
  if (r.expires_at <= now) return { id: r.id, status: 'expired' };
  return { id: r.id, status: 'pending' };
}

/**
 * Апдейт Telegram (вебхук): /start <nonce> и контакт. Транзакция db — в контексте платформы,
 * контекст пользователя ставится на время привязки телефона и возвращается.
 * Ответы бота — в replies (отправляются после коммита).
 * @returns {Promise<{ replies: { chat_id: number, text: string, reply_markup?: object }[], event: string }>}
 */
export async function handleTelegramUpdate(db, update, { now }) {
  const replies = [];
  const msg = update?.message;
  const from = msg?.from;
  if (!msg || !from || !Number.isSafeInteger(from.id) || from.id <= 0 || from.is_bot) return { replies, event: 'ignored' };
  const chatId = msg.chat?.id ?? from.id;
  // Только личный чат с ботом.
  if (msg.chat && msg.chat.type !== 'private') return { replies, event: 'ignored' };
  const tgId = String(from.id);

  if (typeof msg.text === 'string' && /^\/start(\s|$)/.test(msg.text)) {
    const param = msg.text.slice(6).trim();
    if (!NONCE.test(param)) {
      replies.push({ chat_id: chatId, text: 'Здравствуйте! Это бот «Бильярдума». Чтобы войти, нажмите «Войти через Telegram» в приложении.' });
      return { replies, event: 'start_plain' };
    }
    const { rows } = await db.query(
      `update bl.bot_link_nonces set status = 'linked', external_user_id = $2, linked_at = $3
        where nonce_hash = $1 and channel = 'telegram' and status in ('pending', 'linked') and expires_at > $3
        returning id`,
      [tokenHash(param), tgId, now],
    );
    if (rows.length === 0) {
      replies.push({ chat_id: chatId, text: 'Ссылка для входа устарела. Вернитесь в приложение и нажмите «Войти через Telegram» ещё раз.' });
      return { replies, event: 'start_expired' };
    }
    // Телефон уже известен — вход сразу, без контакта.
    const known = (await db.query("select * from bl.auth_user_for('telegram', $1) as id", [tgId])).rows[0].id;
    await setContext(db, { userId: known });
    const me = await db.query('select phone is not null as has_phone from bl.users where id = $1', [known]);
    await setContext(db, { userId: null });
    if (me.rows[0]?.has_phone) {
      await db.query("update bl.bot_link_nonces set status = 'done', user_id = $2, done_at = $3 where id = $1", [rows[0].id, known, now]);
      replies.push({ chat_id: chatId, text: 'Готово, вы вошли. Вернитесь в приложение.', reply_markup: { remove_keyboard: true } });
      return { replies, event: 'link_done' };
    }
    replies.push({
      chat_id: chatId,
      text: 'Чтобы войти, поделитесь номером телефона — кнопка ниже. Номер нужен для чеков и связи с клубом.',
      reply_markup: { keyboard: [[{ text: 'Поделиться контактом', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return { replies, event: 'link_pending_contact' };
  }

  if (msg.contact) {
    const contact = msg.contact;
    if (contact.user_id !== from.id) {
      replies.push({ chat_id: chatId, text: 'Отправьте свой номер кнопкой «Поделиться контактом».' });
      return { replies, event: 'contact_foreign' };
    }
    const phone = normalizePhone(contact.phone_number);
    if (!phone) {
      replies.push({ chat_id: chatId, text: 'Не получилось прочитать номер. Попробуйте ещё раз.' });
      return { replies, event: 'contact_bad' };
    }
    const userId = (await db.query("select * from bl.auth_user_for('telegram', $1) as id", [tgId])).rows[0].id;
    let owner;
    await setContext(db, { userId });
    try {
      await db.query('savepoint attach_phone');
      owner = (await db.query('select bl.auth_attach_phone($1) as id', [phone])).rows[0].id;
      await db.query('release savepoint attach_phone');
    } catch (err) {
      await db.query('rollback to savepoint attach_phone');
      if (err.code !== 'BL409') throw err;
      await setContext(db, { userId: null });
      replies.push({ chat_id: chatId, text: 'Этот номер уже привязан к другому аккаунту Telegram. Обратитесь в клуб.', reply_markup: { remove_keyboard: true } });
      return { replies, event: 'phone_conflict' };
    }
    await setContext(db, { userId: null });
    const { rowCount } = await db.query(
      `update bl.bot_link_nonces set status = 'done', user_id = $2, done_at = $3
        where channel = 'telegram' and status = 'linked' and external_user_id = $1 and expires_at > $3`,
      [tgId, owner, now],
    );
    replies.push({
      chat_id: chatId,
      text: rowCount > 0 ? 'Готово, вы вошли. Вернитесь в приложение.' : 'Номер сохранён. Вернитесь в приложение.',
      reply_markup: { remove_keyboard: true },
    });
    return { replies, event: rowCount > 0 ? 'link_done' : 'phone_saved' };
  }

  return { replies, event: 'ignored' };
}
