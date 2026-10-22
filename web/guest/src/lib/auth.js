import { api, setBearer } from './api.js';
import { createStore, session } from './store.js';
import { telegramInitData } from './platform.js';

/** Версия текста согласия. Текст готовит юрист (docs/legal/consent.md); до него — черновая версия. */
export const CONSENT_VERSION = 'draft-2026-10';

/**
 * Состояние входа:
 *  status: 'loading' | 'anon' | 'user'
 *  user: { id, nick?, phone_masked?, consent_version? } — consent_version: null значит согласия нет
 */
export const auth = createStore({ status: 'loading', user: null });

const NONCE_KEY = 'bl-bot-link';

export async function loadMe() {
  try {
    const me = await api.me();
    auth.set({ status: 'user', user: me?.user ?? null });
    return me?.user ?? null;
  } catch (err) {
    if (err?.code === 'unauthorized' || err?.code === 'not_found') {
      auth.set({ status: 'anon', user: null });
      return null;
    }
    auth.set({ status: 'anon', user: null });
    throw err;
  }
}

/**
 * Согласие нужно, если сервер явно говорит, что его нет (consent_version: null).
 * Если поля нет вовсе — узнаем по ошибке consent_required при оплате.
 */
export function needsConsent(user) {
  return Boolean(user) && 'consent_version' in user && !user.consent_version;
}

export async function giveConsent() {
  await api.consent(CONSENT_VERSION);
  auth.set((s) => ({ user: s.user ? { ...s.user, consent_version: CONSENT_VERSION } : s.user }));
}

/**
 * Телефон в формате +7XXXXXXXXXX из того, что ввёл человек: '8 900 000-00-00', '+7 (900) 000 00 00', '9000000000'.
 * @returns {string | null}
 */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return `+7${digits.slice(1)}`;
  return null;
}

/** Вход для разработки по телефону (POST /api/auth/dev). */
export async function devLogin(phone) {
  const res = await api.devLogin(phone);
  if (res?.token) setBearer(res.token);
  return loadMe();
}

/** Начать вход через бота: ссылка открывает MAX или Telegram, бот просит «Поделиться контактом». */
export async function startBotLink(channel) {
  const link = await api.botLink(channel);
  session.set(NONCE_KEY, { nonce: link.nonce, channel, expires_at: link.expires_at, deep_link: link.deep_link });
  return link;
}

export function pendingBotLink() {
  const saved = session.get(NONCE_KEY);
  if (!saved) return null;
  if (saved.expires_at && Date.parse(saved.expires_at) < Date.now()) {
    session.set(NONCE_KEY, null);
    return null;
  }
  return saved;
}

export function cancelBotLink() {
  session.set(NONCE_KEY, null);
}

/**
 * Один опрос статуса входа через бота.
 * @returns {Promise<'pending' | 'done' | 'expired'>}
 */
export async function checkBotLink(nonce) {
  const res = await api.botLinkStatus(nonce);
  if (res.status === 'done') {
    session.set(NONCE_KEY, null);
    // PWA получает cookie от сервера; токен в теле сохраняем на случай WebView без cookie
    if (res.token) setBearer(res.token);
    await loadMe();
    return 'done';
  }
  if (res.status === 'expired') session.set(NONCE_KEY, null);
  return res.status;
}

/** Мини-приложение Telegram: вход без кнопок по подписанным данным запуска. */
export async function tryMiniAppLogin(hash) {
  const initData = telegramInitData(hash);
  if (!initData) return false;
  const res = await api.telegramLogin(initData);
  if (res?.token) setBearer(res.token);
  await loadMe();
  return true;
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    setBearer(null);
    auth.set({ status: 'anon', user: null });
  }
}
