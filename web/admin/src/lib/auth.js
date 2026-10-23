import { api } from './api.js';
import { createStore, session } from './store.js';

/**
 * Вход персонала: телефон через бота (как у гостя), на общем терминале — быстрая смена по PIN (PRODUCT §2, §11).
 * Сессия — cookie bl_session (§14), токены из ответов не храним.
 * status: 'loading' | 'anon' | 'user'; user: { id, phone_masked, name? }; clubs: [{ club_id, role, name?, timezone? }];
 * principal: 'session' | 'pin' | 'terminal' (GET /api/me → session.kind)
 */
export const auth = createStore({ status: 'loading', user: null, clubs: [], principal: null });

const NONCE_KEY = 'bl-staff-bot-link';

export async function loadMe() {
  try {
    const me = await api.me();
    auth.set({ status: 'user', user: me?.user ?? null, clubs: Array.isArray(me?.clubs) ? me.clubs : [], principal: me?.session?.kind ?? null });
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
  await api.devLogin(phone);
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
    await loadMe();
  }
  if (res.status === 'expired') session.set(NONCE_KEY, null);
  return res.status;
}

/**
 * Быстрая смена сотрудника по PIN на зарегистрированном терминале.
 * pinChangeRequired — у владельца или управляющего PIN короче 6 цифр (ревью входа п. 5): предложить сменить.
 * @returns {Promise<{ pinChangeRequired: boolean }>}
 */
export async function pinSwitch(userId, pin) {
  const res = await api.pin(userId, pin); // сервер ставит cookie сотрудника, прежний на терминале выходит
  await loadMe();
  return { pinChangeRequired: res?.pin_change_required === true };
}

export async function logout() {
  try {
    await api.logout();
  } finally {
    auth.set({ status: 'anon', user: null, clubs: [], principal: null });
  }
}

/** Роль платформы (M4, №135): оператор или Андрей; хранится отдельно от членства в клубе. */
export function platformRole(user) {
  return ['platform_operator', 'platform_admin'].includes(user?.platform_role) ? user.platform_role : null;
}

/** Права по роли в клубе (контракт §5–§7). */
export const can = {
  reception: (role) => ['reception', 'manager', 'owner'].includes(role),
  owner: (role) => role === 'owner',
  manage: (role) => ['manager', 'owner'].includes(role),
  extendFree: (role) => ['manager', 'owner'].includes(role),
  verify: (role) => role === 'owner',
  // Контроллеры (контракт §6): привязка — владелец и монтажник, «Подсветить» — и управляющий
  devices: (role) => ['owner', 'manager', 'installer'].includes(role),
  bind: (role) => ['owner', 'installer'].includes(role),
  identify: (role) => ['owner', 'manager', 'installer'].includes(role),
  terminal: (role) => ['owner', 'manager'].includes(role),
  setPin: (role) => ['owner', 'manager', 'reception', 'bar'].includes(role),
  // M2 (контракт m2.md §4): касса и смена — ресепшн и выше; экран бара — ещё и бармен;
  // отчёты смен, склад и меню — управляющий и владелец; мост ККТ — только владелец
  pos: (role) => ['reception', 'manager', 'owner'].includes(role),
  bar: (role) => ['bar', 'reception', 'manager', 'owner'].includes(role),
  /** Стоп-лист (№88, №97): бармен, ресепшн и выше — только флаг, без цен и состава. */
  stopList: (role) => ['bar', 'reception', 'manager', 'owner'].includes(role),
  shift: (role) => ['reception', 'manager', 'owner'].includes(role),
  reports: (role) => ['manager', 'owner'].includes(role),
  stock: (role) => ['manager', 'owner'].includes(role),
  menu: (role) => ['manager', 'owner'].includes(role),
  // Касса ККТ: очередь чеков — управляющий и владелец (повтор и «пробит» — ручные действия); мосты — только владелец
  kkt: (role) => ['manager', 'owner'].includes(role),
  kktBridges: (role) => role === 'owner',
  // M3: брони — ресепшн и выше; персонал — только владелец (№111); пакеты часов — управляющий и владелец (№112)
  bookings: (role) => ['reception', 'manager', 'owner'].includes(role),
  staff: (role) => role === 'owner',
  packages: (role) => ['manager', 'owner'].includes(role),
  // M4: турниры, споры по партиям, карточка клуба и отзывы — управляющий и владелец
  tournaments: (role) => ['manager', 'owner'].includes(role),
  disputes: (role) => ['manager', 'owner'].includes(role),
  listing: (role) => ['manager', 'owner'].includes(role),
  /** Скидку выше лимита даёт сам: управляющий и владелец (с причиной). */
  bigDiscount: (role) => ['manager', 'owner'].includes(role),
  // M5.1: мастер подключения, магазины ЮKassa и чек-лист — только владелец (T28: ресепшн их не видит)
  onboarding: (role) => role === 'owner',
  // №155–156: план зала, тарифы (и меню, наклейки) в мастере — ещё и управляющий; его шаги — stepsFor в onboarding.js
  setup: (role) => ['owner', 'manager'].includes(role),
};

/**
 * Режим клуба (№153): test | live | suspended. Берём из членства (GET /api/me → clubs[].mode, допущение M5.1);
 * сервер его не прислал — считаем клуб боевым, плашки нет.
 */
export function clubMode(membership) {
  return ['test', 'live', 'suspended'].includes(membership?.mode) ? membership.mode : 'live';
}

/** Мастер узнал новый режим клуба (onboarding, go-live) — плашка «Тестовый режим» обновляется везде. */
export function setClubMode(clubId, mode) {
  if (!['test', 'live', 'suspended'].includes(mode)) return;
  if (!auth.get().clubs.some((c) => c.club_id === clubId && c.mode !== mode)) return;
  auth.set((s) => ({ clubs: s.clubs.map((c) => (c.club_id === clubId && c.mode !== mode ? { ...c, mode } : c)) }));
}
