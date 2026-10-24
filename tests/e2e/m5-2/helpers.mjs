// Общее для приёмки M5.2 «Дашборд владельца» (tests/e2e/m5-2): T29, T30, браузер.
// Поверх хелперов M1–M5: API через Caddy, база — только чтение (DATABASE_ADMIN_URL), утренняя сводка и
// планировщик агрегатов — настоящий код сервера с подставными часами в транзакции с ROLLBACK
// (как m3/11 и m5/02). Состояние между файлами — E2E_M52_DIR (по умолчанию $TMPDIR/bl-e2e-m52, 0600).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMorningSummary } from '../../../server/summaries/index.mjs';
import { api, appClient, CLUB_A, login, ok, sleep } from '../m5/helpers.mjs';

export * from '../m5/helpers.mjs';

export const TZ = 'Asia/Yekaterinburg';
export const DAY_START = '06:00';
export const STATE_DIR = process.env.E2E_M52_DIR || path.join(os.tmpdir(), 'bl-e2e-m52');
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

/** Вход с паузой при 429 (лимит входа 30 в минуту на IP). */
export async function loginWait(phone, opts = { consent: false }) {
  for (let i = 0; ; i += 1) {
    const r = await api('POST', '/api/auth/dev', { body: { phone } });
    if (r.status === 429 && i < 8) {
      await sleep(15_000);
      continue;
    }
    if (r.status !== 200) throw new Error(`вход ${r.status} ${r.text.slice(0, 120)}`);
    return opts.consent ? login(phone, opts) : { token: r.json.token, user: r.json.user, phone };
  }
}

/** GET с повтором при 429 (лимит дашборда — 60 в минуту на маршрут). */
export async function get(pathname, token, headers = {}) {
  for (let i = 0; ; i += 1) {
    const r = await api('GET', pathname, { token, headers, timeoutMs: 60_000 });
    if (r.status === 429 && i < 6) {
      await sleep(Number(r.headers['retry-after'] ?? 10) * 1000 + 500);
      continue;
    }
    return r;
  }
}

export const tile = (json, id) => json?.tiles?.find((t) => t.id === id) ?? null;
export const tv = (json, id) => tile(json, id)?.value ?? null;

/** Дашборд клуба (club — UUID или 'all'). Кэш процесса обходится разными compare/kind не нужно: свежесть — паузой вызывающего. */
export async function dash(token, club, { from, to, tab = 'summary', kind, compare } = {}) {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  q.set('tab', tab);
  if (kind) q.set('kind', kind);
  if (compare !== undefined) q.set('compare', String(compare));
  return get(`/api/clubs/${club}/dashboard?${q}`, token);
}

/** Транзакция только для чтения + подставной контекст (для buildMorningSummary и computeDay). */
export async function inClubTx(db, clubId, fn, { rollback = true, actorType = 'system' } = {}) {
  await db.query('begin');
  try {
    await db.query("select set_config('app.club_id', $1, true), set_config('app.user_id', '', true), set_config('app.actor_type', $2, true)", [clubId, actorType]);
    return await fn(db);
  } finally {
    await db.query(rollback ? 'rollback' : 'commit');
  }
}

/**
 * Свежая утренняя сводка за сутки (тот же код, что у планировщика сводок), без записи. Под входом
 * app_api (как у сервера): часть запросов сводки опирается на RLS по club_id.
 */
let appDb = null;
export async function summaryOf(_db, day, clubId = CLUB_A, tz = TZ) {
  appDb ??= await appClient();
  return inClubTx(appDb, clubId, (d) => buildMorningSummary(d, { clubId, day, timezone: tz, dayStartLocal: DAY_START }));
}
export async function closeApp() {
  await appDb?.end();
  appDb = null;
}

/** Сохранённая (отправленная) утренняя сводка. */
export async function storedSummary(db, day, clubId = CLUB_A) {
  const { rows } = await db.query("select data, sent_at from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [clubId, day]);
  return rows[0] ?? null;
}

/** Границы рабочих суток day (местные 06:00 → 06:00) в UTC. */
export async function bounds(db, day, tz = TZ, ds = DAY_START) {
  const { rows } = await db.query('select ($1::date + $2::time) at time zone $3 as f, ($1::date + 1 + $2::time) at time zone $3 as t', [day, ds, tz]);
  return { from: rows[0].f, to: rows[0].t };
}

/** Рабочие сутки момента (YYYY-MM-DD). */
export function workingDay(at = new Date(), tz = TZ, ds = DAY_START) {
  const [h, m] = ds.split(':').map(Number);
  const shifted = new Date(new Date(at).getTime() - (h * 60 + m) * 60_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Отчёты смен, закрытых (у открытой — открытой) в сутках [from, to): через API владельца. */
export async function shiftReportsOfDay(db, token, day, clubId = CLUB_A) {
  const b = await bounds(db, day);
  const { rows } = await db.query(
    `select id, number from bl.shifts where club_id = $1 and not is_test and coalesce(closed_at, opened_at) >= $2 and coalesce(closed_at, opened_at) < $3 order by number`,
    [clubId, b.from, b.to],
  );
  const out = [];
  for (const s of rows) {
    const r = await get(`/api/shifts/${s.id}/report`, token, { 'x-club-id': clubId });
    if (r.status !== 200) throw new Error(`отчёт смены №${s.number}: ${r.status} ${r.text.slice(0, 200)}`);
    out.push(r.json);
  }
  return out;
}

/** Рубли «1490,50» из копеек (как CSV №172). */
export function rubCsv(k) {
  const n = Number(k);
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  return `${sign}${Math.trunc(a / 100)},${String(a % 100).padStart(2, '0')}`;
}

/** CSV (BOM, «;», CRLF) → строки ячеек. */
export function parseCsv(buf) {
  const text = buf.toString('utf8');
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (q) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += 1;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Телефоны вида +7XXXXXXXXXX или 7999… в тексте (ПДн гостя). */
export function fullPhones(text) {
  return [...String(text).matchAll(/(?<![\d*])\+?7\d{10}(?!\d)/g)].map((m) => m[0]);
}

export const ru = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
export { CLUB_A, ok };
