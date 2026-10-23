// Общее для сценариев приёмки M4 (tests/e2e/m4): Бильярдум+ (T22, T23), турниры (T24), каталог,
// заявки в клубы без программы (T25), отзывы, оператор платформы, публичный API сайта.
// Работают на поднятом `npm run dev` поверх хелперов M1–M3: API через Caddy, симулятор по HTTP,
// эмуляторы ЮKassa и АТОЛ — `docker exec`, база — только чтение (DATABASE_ADMIN_URL).
// Стенд не перенастраивают: столы tester — 1–6 (7–8 у pentester); всё создаётся через API.
// Секреты и телефоны в вывод не попадают (только маска).

import { randomBytes } from 'node:crypto';
import { api, login, ok, waitFor } from '../m3/helpers.mjs';

export * from '../m3/helpers.mjs';

export const PLATFORM = { admin: '+70000000009', operator: '+70000000010' };
export const PLATFORM_IDS = { admin: 'af000000-0000-4000-8000-000000000009', operator: 'af000000-0000-4000-8000-000000000010' };
export const DEMO_LISTING = 'cb100000-0000-4000-8000-000000000002'; // карточка сида без программы и без контакта
export const CLUB_LISTING = 'cb100000-0000-4000-8000-000000000001'; // карточка тестового клуба (platform)

export async function platform(role) {
  return login(PLATFORM[role], { consent: false });
}

/** Ник Бильярдум+: латиница, 3–20 символов, не больше 6 цифр (№145). */
export function nick(prefix = 'e2e') {
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const b = randomBytes(8);
  let s = '';
  for (const x of b) s += letters[x % letters.length];
  return `${prefix}_${s}`.slice(0, 20);
}

/** Профиль Бильярдум+ (ник). → GET /api/plus/me */
export async function plusProfile(guest, n = nick()) {
  const r = await ok(api('PATCH', '/api/plus/me', { token: guest.token, body: { nick: n } }));
  guest.nick = n;
  return r;
}

export async function plusMe(guest) {
  return ok(api('GET', '/api/plus/me', { token: guest.token }));
}

export function ratingOf(me, discipline = 'pyramid') {
  return me.ratings.find((r) => r.discipline === discipline) ?? null;
}

/** Всё содержимое ответа строкой — для проверок «нет ПДн». */
export function flat(x) {
  return typeof x === 'string' ? x : JSON.stringify(x);
}

/** Телефоны в тексте: +7…, 8 9xx…, 10+ цифр подряд. */
export function phonesIn(text) {
  text = String(text).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})/g, '<iso>');
  return [...String(text).matchAll(/(\+7|\b8)[\s\-()./\u200b\u2060]*\d{3}[\s\-()./\u200b\u2060]*\d{3}[\s\-./\u200b\u2060]*\d{2}[\s\-./\u200b\u2060]*\d{2}|\d{10,}/g)].map((m) => m[0]);
}

/** UUID пользователей (users) в тексте, из списка известных id. */
export function idsIn(text, ids) {
  return ids.filter((id) => id && String(text).includes(id));
}

export async function notificationsFor(db, userId, { kinds, since } = {}) {
  const { rows } = await db.query(
    `select id, kind, level, status, text, data, actions, created_at from bl.notifications
      where user_id = $1 and ($2::text[] is null or kind = any($2::text[])) and ($3::timestamptz is null or created_at >= $3)
      order by created_at`,
    [userId, kinds ?? null, since ? new Date(since) : null],
  );
  return rows;
}

export async function waitNotification(db, userId, kind, { since, timeoutMs = 30_000 } = {}) {
  return waitFor(
    async () => {
      const rows = await notificationsFor(db, userId, { kinds: [kind], since });
      return rows.length ? rows.at(-1) : null;
    },
    { timeoutMs, intervalMs: 500, what: `уведомление ${kind}` },
  );
}

/** Журнал платформы и клубов по действию (club_id любой), начиная с since. */
export async function auditAny(db, { actions, since, like }) {
  const { rows } = await db.query(
    `select seq, club_id, action, object_type, object_id, reason, actor_type, actor_id, data, created_at from bl.audit_log
      where action = any($1::text[]) and created_at >= $2 and ($3::text is null or data::text like $3 or object_id::text = $4)
      order by created_at, seq`,
    [[].concat(actions), new Date(since), like ? `%${like}%` : null, like ?? null],
  );
  return rows;
}

/** Короткая сводка ответа для диагностики (без телефонов). */
export function brief2(r) {
  return `${r.status} ${r.text.slice(0, 240).replace(/\+7\d{10}/g, '+7***')}`;
}

// SSE без входа (ТВ-экран турнира) -------------------------------------------------------------

import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { BASE } from '../m3/helpers.mjs';
import { CADDY_CONTAINER } from '../m0/helpers.mjs';

let ca;
function caddyCa() {
  if (!ca) ca = spawnSync('docker', ['exec', CADDY_CONTAINER, 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' }).stdout;
  return ca;
}

/** Поток SSE по пути (без входа или с token). → { events, ready, waitEvent, close } */
export function sseOpen(pathname, token) {
  const url = new URL(pathname, BASE);
  const events = [];
  let req;
  const headers = { accept: 'text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  const ready = new Promise((resolve, reject) => {
    req = https.request(url, { method: 'GET', headers, ca: caddyCa() }, (res) => {
      if (res.statusCode !== 200) {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
          }
          if (!data.length) continue;
          let parsed;
          try {
            parsed = JSON.parse(data.join('\n'));
          } catch {
            parsed = data.join('\n');
          }
          events.push({ at: Date.now(), event, data: parsed, raw: data.join('\n') });
        }
      });
      res.on('error', () => {});
      resolve({ status: 200, headers: res.headers });
    });
    req.on('error', (e) => reject(e));
    req.end();
  });
  return {
    events,
    ready,
    async waitEvent(pred, { timeoutMs = 15_000, what = 'событие SSE' } = {}) {
      return waitFor(() => events.find(pred) ?? null, { timeoutMs, intervalMs: 50, what });
    },
    close() {
      req?.destroy();
    },
  };
}

// Турниры ---------------------------------------------------------------------------------------

export const ORGANIZER_PATH = (club) => `/api/clubs/${club}/tournaments`;

/** Запись на турнир и оплата взноса в эмуляторе. → { entry, pid } */
export async function enterAndPay(guest, tournamentId, { pay = true } = {}) {
  const { emu, ykId } = await import('../m3/helpers.mjs');
  const r = await api('POST', `/api/tournaments/${tournamentId}/entries`, { token: guest.token, body: { return_url: `https://localhost:8443/app/tournaments/${tournamentId}` }, idem: true });
  if (r.status !== 201) return { r };
  if (!pay || !r.json.confirmation) return { r, entry: r.json };
  const pid = ykId(r.json.confirmation);
  emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });
  const me = await waitFor(
    async () => {
      const x = await api('GET', `/api/tournaments/${tournamentId}/me`, { token: guest.token });
      return x.status === 200 && x.json.entry?.status === 'confirmed' ? x.json : null;
    },
    { timeoutMs: 30_000, intervalMs: 300, what: 'запись подтверждена после взноса' },
  );
  return { r, entry: r.json, pid, me };
}
