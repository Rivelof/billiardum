// Общее для приёмки M5.6 «Прогноз, часы пик, износ сукна» и M5.7 «Публичный API для клубов»
// (tests/e2e/m5-6): T43–T46 и браузер.
//
// В отличие от хелперов M0–M5.3, эти файлы НЕ читают .env, не ходят в базу стенда и не вызывают docker:
//   * API — через Caddy (E2E_BASE_URL, по умолчанию https://localhost:8443); корень CA Caddy — файл
//     E2E_CA_FILE (публичный сертификат «Caddy Local Authority», его один раз кладёт разработчик:
//     `docker compose -p billiardum exec caddy cat /data/caddy/pki/authorities/local/root.crt > root.crt`);
//   * клубы, пользователи, столы — свои, через API под входом для разработки (ALLOW_DEV_LOGIN=1),
//     телефоны синтетические +7998…; клуб сида и столы 1–8 не меняются (кроме ключа API в 03, который
//     там же отзывается);
//   * расчёты, которым нужна история (8 недель) и счётчики часов, — на своём временном Postgres
//     (01-t43-t44-db.test.mjs, DATABASE_ADMIN_URL своего кластера, не стенда).
// Состояние между файлами — E2E_M56_DIR (по умолчанию $TMPDIR/bl-e2e-m56, 0600). Ключи и секреты
// в вывод не попадают: только префикс и длина.

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

export const STATE_DIR = process.env.E2E_M56_DIR || path.join(os.tmpdir(), 'bl-e2e-m56');
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
