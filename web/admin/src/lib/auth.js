import { api, setStaffBearer, getTerminal } from './api.js';
import { createStore, session } from './store.js';

/**
 * Вход персонала: телефон через бота (как у гостя), на общем терминале — быстрая смена по PIN (PRODUCT §2, §11).
 * status: 'loading' | 'anon' | 'user'; clubs: [{ club_id, role, name?, timezone? }]
 */
export const auth = createStore({ status: 'loading', user: null, clubs: [] });

const NONCE_KEY = 'bl-staff-bot-link';

export async function loadMe() {
  try {
    const me = await api.me();
    auth.set({ status: 'user', user: me?.user ?? null, clubs: Array.isArray(me?.clubs) ? me.clubs : [] });
    return me;
  } catch (err) {
    auth.set({ status: 'anon', user: null, clubs: [] });
    if (err?.code !== 'unauthorized') throw err;
    return null;
  }
}

export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return `+7${digits.slice(1)}`;
  return null;
}

export async function devLogin(phone) {
  const res = await api.devLogin(phone);
  if (res?.token && getTerminal()) setStaffBearer(res.token);
  return loadMe();
}

export async function startBotLink(channel) {
  const link = await api.botLink(channel);
  session.set(NONCE_KEY, { ...link, channel });
  return { ...link, channel };
}

export function pendingBotLink() {
  const saved = session.get(NONCE_KEY);
  if (saved?.expires_at && Date.parse(saved.expires_at) < Date.now()) {
    session.set(NONCE_KEY, null);
    return null;
  }
  return saved;
}

export function cancelBotLink() {
  session.set(NONCE_KEY, null);
}

export async function checkBotLink(nonce) {
  const res = await api.botLinkStatus(nonce);
  if (res.status === 'done') {
    session.set(NONCE_KEY, null);
    if (res.token && getTerminal()) setStaffBearer(res.token);
    await loadMe();
  }
  if (res.status === 'expired') session.set(NONCE_KEY, null);
  return res.status;
}

/** Быстрая смена сотрудника по PIN на зарегистрированном терминале. */
export async function pinSwitch(userId, pin) {
  const res = await api.pin(userId, pin);
  setStaffBearer(res.token);
  return loadMe();
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    setStaffBearer(null);
    auth.set({ status: 'anon', user: null, clubs: [] });
  }
}

/** Права по роли в клубе (контракт §5–§7). */
export const can = {
  reception: (role) => ['reception', 'manager', 'owner'].includes(role),
  owner: (role) => role === 'owner',
  manage: (role) => ['manager', 'owner'].includes(role),
  extendFree: (role) => ['manager', 'owner'].includes(role),
  verify: (role) => role === 'owner',
};
