// Общее для приёмки M5.5 «Сети» и M5.8 «Падел-корт» (tests/e2e/m5-8): T41, T42, T47, T48 и браузер.
//
// Как и в tests/e2e/m5-6, эти файлы НЕ читают .env, не ходят в базу стенда и не вызывают docker к базе:
//   * API — через Caddy (E2E_BASE_URL, по умолчанию https://localhost:8443); корень CA Caddy — файл
//     E2E_CA_FILE (публичный сертификат «Caddy Local Authority»:
//     `docker compose -p billiardum exec caddy cat /data/caddy/pki/authorities/local/root.crt > root.crt`);
//   * клубы, сети, пользователи — свои, через API под входом для разработки (ALLOW_DEV_LOGIN=1),
//     телефоны синтетические +7998… (персонал) и +7999… (гости); не больше 3 тестовых клубов на владельца
//     (`clubs_limit`), поэтому у сценариев разные владельцы;
//   * клуб сида и столы 1–8 не меняются; корты сида 101 и 102 используются в T47 и освобождаются в конце;
//   * эмулятор ЮKassa (`docker exec … wget …/__emu/…`, наружу не опубликован) и симулятор контроллера
//     (http://127.0.0.1:18080) нужны только T47 — как в tests/security/m5-8/lib.mjs;
//   * расчёты, которым нужны своя база и история, — на своём временном Postgres (05-db-networks.test.mjs).
// Состояние между файлами — E2E_M58_DIR (по умолчанию $TMPDIR/bl-e2e-m58, 0600). Ключи и секреты
// в вывод не попадают.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export const BASE = process.env.E2E_BASE_URL || 'https://localhost:8443';
export const CLUB_SEED = 'c1000000-0000-4000-8000-000000000001';
export const SEED_PHONES = Object.freeze({ owner: '+70000000001', manager: '+70000000003', reception: '+70000000004' });
export const EKB_TZ = 'Asia/Yekaterinburg';
export const SCOPES = ['tables:read', 'tariffs:read', 'availability:read', 'sales:read', 'bookings:read'];

export const STATE_DIR = process.env.E2E_M58_DIR || path.join(os.tmpdir(), 'bl-e2e-m58');
mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
const STATE = path.join(STATE_DIR, 'state.json');

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}
export function saveState(patch) {
  const s = { ...loadState(), ...patch };
  writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
  chmodSync(STATE, 0o600);
  return s;
}

let ca;
export function caPem() {
  if (ca) return ca;
  const f = process.env.E2E_CA_FILE;
  if (!f) throw new Error('нет E2E_CA_FILE — файл корня CA Caddy (см. шапку lib.mjs)');
  ca = readFileSync(f, 'utf8');
  return ca;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Запрос к API через Caddy. → { status, json, text, headers } */
export function api(method, pathname, { token, body, idem, headers = {}, club, timeoutMs = 30_000 } = {}) {
  const url = new URL(pathname, BASE);
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (club) h['x-club-id'] = club;
  let payload;
  if (body !== undefined || (method !== 'GET' && method !== 'HEAD')) {
    payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    h['content-type'] ??= 'application/json';
    h['content-length'] = String(payload.length);
  }
  if (idem) h['idempotency-key'] = idem === true ? randomUUID() : idem;
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: h, ca: caPem(), timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Запрос с повтором при 429 (лимиты маршрутов), не дольше tries раз. */
export async function apiWait(method, pathname, opts = {}, tries = 8) {
  for (let i = 0; ; i += 1) {
    const r = await api(method, pathname, opts);
    if (r.status !== 429 || i >= tries) return r;
    await sleep(Number(r.headers['retry-after'] ?? 10) * 1000 + 300);
  }
}

/** Короткая запись ответа для сообщений (ключи и секреты вырезаны). */
export function short(r) {
  return `${r.status} ${String(r.text ?? '').replace(/blk_[A-Za-z0-9_-]{8,}/g, 'blk_***').replace(/whsec_[A-Za-z0-9_-]{8,}/g, 'whsec_***').slice(0, 300)}`;
}

/** Вход для разработки (с паузой при 429). consent — принять согласие (для гостей). */
export async function login(phone, { consent = false } = {}) {
  for (let i = 0; ; i += 1) {
    const r = await api('POST', '/api/auth/dev', { body: { phone } });
    if (r.status === 429 && i < 8) {
      await sleep(Number(r.headers['retry-after'] ?? 15) * 1000 + 500);
      continue;
    }
    if (r.status !== 200) throw new Error(`вход ${r.status}`);
    const token = r.json.token;
    if (consent && !r.json.user?.consent?.accepted) {
      await api('POST', '/api/auth/consent', { token, body: { version: r.json.user.consent.version } });
    }
    return { token, user: r.json.user, phone };
  }
}

let seq = 0;
/** Синтетический телефон +7998… (персонал своих клубов). */
export function staffPhone() {
  seq += 1;
  const n = (Date.now() % 100_000) * 10 + (seq % 10);
  return `+79986${String(n).padStart(6, '0').slice(-6)}`;
}
/** Синтетический телефон гостя +7999… */
export function guestPhone() {
  seq += 1;
  const n = (Date.now() % 100_000) * 10 + (seq % 10);
  return `+79996${String(n).padStart(6, '0').slice(-6)}`;
}

/** Рабочие сутки момента (YYYY-MM-DD) клуба с поясом tz и началом суток ds. */
export function workingDay(at = new Date(), tz = EKB_TZ, ds = '06:00') {
  const [h, m] = ds.split(':').map(Number);
  const shifted = new Date(new Date(at).getTime() - (h * 60 + m) * 60_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Свой клуб: владелец (новый телефон), клуб в test (Екатеринбург), столы и корты, управляющий и ресепшн
 * по приглашению. → { club, owner, manager, reception, tables: [{id, number, type}], courts }
 */
export async function newClub({ name, tables = 2, courts = 0 }) {
  const owner = await login(staffPhone());
  const c = await api('POST', '/api/clubs', { token: owner.token, body: { name, city_name: 'Екатеринбург', timezone: EKB_TZ } });
  if (c.status !== 201) throw new Error(`клуб: ${short(c)}`);
  const club = c.json.club_id;
  await api('PUT', `/api/clubs/${club}/hall`, { token: owner.token, club, body: { width: 1600, height: 1000 } });
  for (let i = 1; i <= tables; i += 1) {
    const r = await api('POST', `/api/clubs/${club}/resources`, { token: owner.token, club, body: { number: i, kind: i % 2 ? 'pyramid' : 'pool', plan_x: 200 * i, plan_y: 300, plan_rotation: 0 } });
    if (r.status !== 201) throw new Error(`стол ${i}: ${short(r)}`);
  }
  for (let i = 1; i <= courts; i += 1) {
    const r = await api('POST', `/api/clubs/${club}/resources`, { token: owner.token, club, body: { number: i, kind: 'padel_court', plan_x: 300 * i, plan_y: 700, plan_rotation: 0 } });
    if (r.status !== 201) throw new Error(`корт ${i}: ${short(r)}`);
  }
  const list = await api('GET', `/api/clubs/${club}/resources`, { token: owner.token, club });
  const res = (list.json?.resources ?? []).map((r) => ({ id: r.id, number: r.number, type: r.type ?? r.kind, kind: r.kind }));
  return { club, owner, resources: res };
}

/** Пригласить сотрудника роли role (приглашение по телефону, №158) и войти им. → { token, user, phone } */
export async function invite(clubId, ownerToken, role) {
  const phone = staffPhone();
  const r = await api('POST', `/api/clubs/${clubId}/staff/invites`, { token: ownerToken, club: clubId, body: { phone, role } });
  if (r.status !== 201 && r.status !== 200) throw new Error(`сотрудник ${role}: ${short(r)}`);
  return login(phone);
}

/** Телефоны вида +7XXXXXXXXXX (ПДн) в тексте. */
export function fullPhones(text) {
  return [...String(text).matchAll(/(?<![\d*])\+?7\d{10}(?!\d)/g)].map((m) => m[0]);
}

// ---------------------------------------------------------------------------------------------
// M5.5 / M5.8

export const TZ = { ekb: 'Asia/Yekaterinburg', kgd: 'Europe/Kaliningrad', nsk: 'Asia/Novosibirsk', msk: 'Europe/Moscow' };
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** Правило мастера тарифов для столов (kind: null — все типы). */
export const rule = (from, to, rub, extra = {}) => ({ kind: null, days: ALL_DAYS, from, to, price_per_hour_kopecks: rub * 100, min_minutes: 30, step_minutes: 1, ...extra });
/** Правило корта: слот 60/90/120 минут, цена слота в рублях. */
export const courtRule = (from, to, slot, rub, extra = {}) => ({ kind: 'padel_court', days: ALL_DAYS, from, to, slot_minutes: slot, price_per_slot_kopecks: rub * 100, ...extra });

/** Клуб владельца owner: тестовый, в поясе tz, со столами kinds (['pyramid','pool',…]) и кортами courts. → { club, resources } */
export async function makeClub(owner, { name, city = 'Екатеринбург', tz = TZ.ekb, kinds = ['pyramid', 'pool'], courts = 0, rules = null }) {
  const c = await api('POST', '/api/clubs', { token: owner.token, body: { name, city_name: city, timezone: tz } });
  if (c.status !== 201) throw new Error(`клуб «${name}»: ${short(c)}`);
  const club = c.json.club_id;
  await api('PUT', `/api/clubs/${club}/hall`, { token: owner.token, club, body: { width: 1600, height: 1000 } });
  let n = 0;
  for (const kind of kinds) {
    n += 1;
    const r = await api('POST', `/api/clubs/${club}/resources`, { token: owner.token, club, body: { number: n, kind, plan_x: 200 * n, plan_y: 300, plan_rotation: 0 } });
    if (r.status !== 201) throw new Error(`стол ${n}: ${short(r)}`);
  }
  for (let i = 1; i <= courts; i += 1) {
    const r = await api('POST', `/api/clubs/${club}/resources`, { token: owner.token, club, body: { number: i, kind: 'padel_court', plan_x: 300 * i, plan_y: 700, plan_rotation: 0 } });
    if (r.status !== 201) throw new Error(`корт ${i}: ${short(r)}`);
  }
  if (rules) {
    const t = await api('PUT', `/api/clubs/${club}/tariffs`, { token: owner.token, club, body: { rules } });
    if (t.status !== 200) throw new Error(`тарифы «${name}»: ${short(t)}`);
  }
  const list = await api('GET', `/api/clubs/${club}/resources`, { token: owner.token, club });
  return { club, name, tz, resources: list.json.resources };
}

/** Гость +7999… с согласием. */
export const newGuest = () => login(guestPhone(), { consent: true });

/** Записи журнала клуба по действию ('network.*' — префикс). Владелец или управляющий. */
export async function auditOf(club, token, action, limit = 100) {
  const r = await api('GET', `/api/clubs/${club}/audit?action=${encodeURIComponent(action)}&limit=${limit}`, { token, club });
  if (r.status !== 200) throw new Error(`журнал ${club}: ${short(r)}`);
  return r.json.items;
}

/** Правила тарифов клуба в виде строк «дни|с|до|цена» (порядок по тексту). */
export const rulesView = (rules) =>
  rules
    .map((r) => `${r.kind ?? '*'}|${r.days.join('')}|${r.from}-${r.to}|${r.price_per_hour_kopecks}|${r.min_minutes}/${r.step_minutes}${r.slot_minutes ? `|slot${r.slot_minutes}=${r.price_per_slot_kopecks}` : ''}`)
    .sort();

/** Цена брони (копейки) ресурса: старт в UTC-момент at, minutes. Бронь потом отменяется гостем. */
export async function bookingPrice(guest, resourceId, at, minutes) {
  const r = await api('POST', '/api/bookings', { token: guest.token, body: { resource_id: resourceId, starts_at: at.toISOString(), minutes } });
  if (r.status !== 201) return { status: r.status, error: r.json?.error, amount: null };
  await api('POST', `/api/bookings/${r.json.id}/cancel`, { token: guest.token, body: {} });
  return { status: 201, amount: r.json.amount_kopecks, id: r.json.id, json: r.json };
}

/** UTC-момент: дата day (YYYY-MM-DD) + местное время hh:mm в поясе tz. */
export function localToUtc(day, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.UTC(...day.split('-').map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))), h, m);
  // Смещение пояса в этот момент: сравнение локального представления с UTC.
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (asUtc - guess));
}
/** Дата через n суток от сегодня (UTC), YYYY-MM-DD. */
export const dayPlus = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export const ru = (kopecks) => `${(kopecks / 100).toLocaleString('ru-RU')} ₽`;

// ---------------------------------------------------------------------------------------------
// T47: корты сида (клуб live), эмулятор ЮKassa и симулятор контроллера. К базе и .env не обращаются.

export const SIM = process.env.E2E_SIM_URL || 'http://127.0.0.1:18080';
export const EMU_CONTAINER = process.env.E2E_EMU_CONTAINER || 'billiardum-yookassa-emu-1';
/** Корты сида (клуб live, Екатеринбург): номер в симуляторе, код QR, id ресурса. */
export const COURTS = Object.freeze({
  101: { code: 'TESTC00001', id: 'e1000000-0000-4000-8000-000000000101' },
  102: { code: 'TESTC00002', id: 'e1000000-0000-4000-8000-000000000102' },
});

export function emu(pathname, { post = false } = {}) {
  const args = ['exec', EMU_CONTAINER, 'wget', '-qO-'];
  if (post) args.push('--post-data=');
  args.push(`http://127.0.0.1:8090${pathname}`);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`эмулятор ЮKassa ${pathname}: ${res.stderr.trim()}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}
export const emuSucceed = (providerId) => emu(`/__emu/payments/${providerId}/succeed?wait=1`, { post: true });
export const emuPayment = (providerId) => emu(`/__emu/payments/${providerId}`);

/** id платежа ЮKassa из confirmation.url (…/pay/{id}). */
export function providerId(payResp) {
  const url = payResp?.confirmation?.url ?? payResp?.confirmation?.confirmation_url;
  const m = /\/pay\/([^/?#]+)/.exec(url ?? '');
  if (!m) throw new Error(`нет confirmation.url: ${JSON.stringify(payResp).slice(0, 200)}`);
  return m[1];
}

/** Состояние контроллера в симуляторе (стол 1–8, корт 101/102). */
export async function sim(n) {
  const r = await fetch(`${SIM}/sim/tables/${n}`);
  if (!r.ok) throw new Error(`симулятор ${n}: ${r.status}`);
  return r.json();
}

export async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 200, what = 'условие' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(intervalMs);
  }
}

export const tableByCode = (code, token) => api('GET', `/api/t/${code}`, { token });
export const quote = (token, body) => api('POST', '/api/quotes', { token, body });
export const payQuote = (token, quoteId, method = 'sbp') => api('POST', `/api/quotes/${quoteId}/pay`, { token, body: { method }, idem: true });

/** Дождаться, пока корт свободен (чужие проверки идут рядом): API гостя и контроллер. */
export function waitCourtFree(n, token, timeoutMs = 90_000) {
  return waitFor(
    async () => {
      const r = await tableByCode(COURTS[n].code, token);
      const s = await sim(n);
      return r.status === 200 && r.json.status === 'free' && s.state.mode === 'free' ? r.json : null;
    },
    { timeoutMs, intervalMs: 1000, what: `корт ${n} свободен` },
  );
}

/** Старт игры гостем по QR: котировка → СБП → «оплачено» в эмуляторе → сессия. → { t, q, payResp, pid, sessionId, paymentId } */
export async function startGame(n, minutes, guest) {
  const t = await tableByCode(COURTS[n].code, guest.token);
  if (t.status !== 200) throw new Error(`QR ${n}: ${short(t)}`);
  const q = await quote(guest.token, { resource_id: t.json.resource.id, kind: 'start', minutes });
  if (q.status !== 200) throw new Error(`котировка: ${short(q)}`);
  const payResp = await payQuote(guest.token, q.json.quote_id);
  if (payResp.status !== 200 && payResp.status !== 201) throw new Error(`оплата: ${short(payResp)}`);
  const pid = providerId(payResp.json);
  emuSucceed(pid);
  const p = await waitFor(
    async () => {
      const r = await api('GET', `/api/payments/${payResp.json.payment_id}`, { token: guest.token });
      return r.status === 200 && r.json.session_id ? r.json : null;
    },
    { what: 'session_id у платежа' },
  );
  return { t: t.json, q: q.json, payResp: payResp.json, pid, sessionId: p.session_id, paymentId: payResp.json.payment_id, payment: p };
}

/** Продление: котировка → оплата → ждём, пока paid_until вырастет. */
export async function extendGame(n, sessionId, minutes, guest) {
  const t = await tableByCode(COURTS[n].code, guest.token);
  const before = (await api('GET', `/api/sessions/${sessionId}`, { token: guest.token })).json;
  const q = await quote(guest.token, { resource_id: t.json.resource.id, kind: 'extend', session_id: sessionId, minutes });
  if (q.status !== 200) return { q };
  const payResp = await payQuote(guest.token, q.json.quote_id);
  if (payResp.status !== 200 && payResp.status !== 201) return { q, payResp };
  emuSucceed(providerId(payResp.json));
  const after = await waitFor(
    async () => {
      const r = await api('GET', `/api/sessions/${sessionId}`, { token: guest.token });
      return r.status === 200 && Date.parse(r.json.paid_until) > Date.parse(before.paid_until) ? r.json : null;
    },
    { what: 'paid_until вырос' },
  );
  return { q, payResp, before, after };
}

export const stopGame = (guest, sessionId) => api('POST', `/api/sessions/${sessionId}/stop`, { token: guest.token, body: {} });

/** Минуты, округление «половина вверх» до рубля (как движок, №44). */
export const roundRub = (kopecks) => Math.floor(kopecks / 100 + 0.5) * 100;
