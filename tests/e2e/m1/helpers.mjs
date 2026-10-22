// Общее для сценариев приёмки M1 (tests/e2e/m1). Работают на поднятом `npm run dev`:
// API через Caddy (https://localhost:8443, корень CA Caddy из контейнера), симулятор по
// HTTP (127.0.0.1:18080), эмулятор ЮKassa через `docker exec` (управление /__emu/ наружу
// не опубликовано), база — только чтение (DATABASE_ADMIN_URL), логи — `docker logs`.
// Секреты не печатаются. Столы tester — 1–6 (7–8 у pentester).

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import {
  adminClient,
  CADDY_CONTAINER,
  CLUB_A,
  containerLog,
  env,
  loadDevices,
  REPO_ROOT,
  SERVER_CONTAINER,
  SIM_CONTAINER,
  sleep,
  waitFor,
} from '../m0/helpers.mjs';

export { adminClient, CLUB_A, containerLog, env, loadDevices, REPO_ROOT, SERVER_CONTAINER, SIM_CONTAINER, sleep, waitFor };

export const BASE = process.env.E2E_BASE_URL || 'https://localhost:8443';
export const SIM = process.env.E2E_SIM_URL || 'http://127.0.0.1:18080';
export const EMU_CONTAINER = process.env.E2E_EMU_CONTAINER || 'billiardum-yookassa-emu-1';
export const PHONES = { owner: '+70000000001', manager: '+70000000003', reception: '+70000000004' };
export const MY_TABLES = [1, 2, 3, 4, 5, 6];

let caddyCa;
function caddyRootCa() {
  if (caddyCa) return caddyCa;
  const res = spawnSync('docker', ['exec', CADDY_CONTAINER, 'cat', '/data/caddy/pki/authorities/local/root.crt'], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`корень CA Caddy не прочитан: ${res.stderr.trim()}`);
  caddyCa = res.stdout;
  return caddyCa;
}

/** Запрос к API через Caddy. Возвращает { status, json, text, headers, ms }. */
export function api(method, path, { token, body, idem, headers = {}, timeoutMs = 15_000 } = {}) {
  const url = new URL(path, BASE);
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined || (method !== 'GET' && method !== 'HEAD')) {
    payload = Buffer.from(JSON.stringify(body ?? {}));
    h['content-type'] = 'application/json';
    h['content-length'] = String(payload.length);
  }
  if (idem) h['idempotency-key'] = idem === true ? randomUUID() : idem;
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: h, ca: caddyRootCa(), timeout: timeoutMs }, (res) => {
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
        resolve({ status: res.statusCode, json, text, headers: res.headers, ms: performance.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ответ с ожидаемым статусом, иначе ошибка с кодом ответа (без секретов). */
export async function ok(promise, expected = 200) {
  const r = await promise;
  if (r.status !== expected) throw new Error(`ожидали HTTP ${expected}, пришло ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

/** Синтетический телефон гостя: +7999 + 7 цифр, уникален для прогона. */
let phoneSeq = 0;
export function guestPhone() {
  phoneSeq += 1;
  const n = (Date.now() % 1_000_000) * 10 + (phoneSeq % 10);
  return `+7999${String(n).padStart(7, '0').slice(-7)}`;
}

export function maskPhone(p) {
  return `${p.slice(0, 2)}***${p.slice(-2)}`;
}

/** Вход для разработки; гостю — согласие текущей версии. → { token, user, phone } */
export async function login(phone, { consent = true } = {}) {
  const r = await ok(api('POST', '/api/auth/dev', { body: { phone } }));
  const token = r.token;
  if (consent) {
    const me = await ok(api('GET', '/api/me', { token }));
    if (!me.user.consent_version) {
      await ok(api('POST', '/api/auth/consent', { token, body: { version: me.user.consent.version } }));
    }
  }
  return { token, user: r.user, phone };
}

export async function newGuest() {
  return login(guestPhone());
}

export async function staff(role) {
  return login(PHONES[role], { consent: false });
}

export function tableCode(n) {
  return `TEST${String(n).padStart(6, '0')}`;
}

export async function table(n, token) {
  return ok(api('GET', `/api/t/${tableCode(n)}`, { token }));
}

/** Котировка start/extend. */
export async function quote(token, { resourceId, kind = 'start', minutes, sessionId }) {
  return api('POST', '/api/quotes', { token, body: { resource_id: resourceId, kind, minutes, ...(sessionId ? { session_id: sessionId } : {}) } });
}

export async function pay(token, quoteId, method = 'sbp', idem = true) {
  return api('POST', `/api/quotes/${quoteId}/pay`, { token, body: { method }, idem });
}

/** id платежа ЮKassa из confirmation.url (…/pay/{id}). */
export function providerId(payResp) {
  const url = payResp?.confirmation?.url ?? payResp?.confirmation?.confirmation_url;
  const m = /\/pay\/([^/?#]+)/.exec(url ?? '');
  if (!m) throw new Error(`нет confirmation.url в ответе оплаты: ${JSON.stringify(payResp)}`);
  return m[1];
}

// Эмулятор ЮKassa ---------------------------------------------------------------------

/** Запрос к управлению эмулятора изнутри контейнера (wget). */
export function emu(path, { post = false, body } = {}) {
  const args = ['exec', EMU_CONTAINER, 'wget', '-qO-'];
  if (post) {
    args.push(`--post-data=${body ? JSON.stringify(body) : ''}`);
    if (body) args.push('--header=Content-Type: application/json');
  }
  args.push(`http://127.0.0.1:8090${path}`);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`эмулятор ${path}: ${res.stderr.trim()}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}

/** «Оплатить» на эмуляторе; Date.now() до вызова — для грубой метрики. */
export function emuSucceed(pid, { wait = true } = {}) {
  return emu(`/__emu/payments/${pid}/succeed${wait ? '?wait=1' : ''}`, { post: true });
}

export function emuPayment(pid) {
  return emu(`/__emu/payments/${pid}`);
}

// Симулятор ---------------------------------------------------------------------------

export async function sim(n) {
  const r = await fetch(`${SIM}/sim/tables/${n}`);
  return r.json();
}

export async function simPost(n, action, body) {
  const r = await fetch(`${SIM}/sim/tables/${n}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

export function brief(t) {
  const s = t.state ?? {};
  return `mode=${s.mode} relay=${s.relay} led=${s.led} rem=${s.remaining_ms} sid=${s.session_id?.slice(0, 8) ?? null} online=${t.online} lamp=${t.lamp} last_seq=${s.last_seq}`;
}

/** Ждать состояния симулятора по предикату от стола. */
export async function waitSim(n, pred, { timeoutMs = 30_000, intervalMs = 100, what } = {}) {
  return waitFor(
    async () => {
      const t = await sim(n);
      return pred(t) ? t : null;
    },
    { timeoutMs, intervalMs, what: what ?? `симулятор стол ${n}` },
  );
}

// Сессии ------------------------------------------------------------------------------

export async function session(token, id) {
  return ok(api('GET', `/api/sessions/${id}`, { token }));
}

/** Ждать, пока платёж гостя получит session_id. */
export async function waitPaymentSession(token, paymentId, { timeoutMs = 15_000 } = {}) {
  return waitFor(
    async () => {
      const r = await api('GET', `/api/payments/${paymentId}`, { token });
      return r.status === 200 && r.json.session_id ? r.json : null;
    },
    { timeoutMs, intervalMs: 150, what: `session_id у платежа ${paymentId}` },
  );
}

/**
 * Полный старт игры гостем по СБП: стол → котировка → оплата → «Оплатить» в эмуляторе →
 * свет. → { guest, tbl, q, payResp, pid, sessionId, tPaid }
 */
export async function startGame(n, minutes, { guest, method = 'sbp' } = {}) {
  guest = guest ?? (await newGuest());
  const tbl = await table(n, guest.token);
  if (tbl.status !== 'free') throw new Error(`стол ${n} не свободен: ${tbl.status} до ${tbl.busy_until}`);
  const q = await ok(quote(guest.token, { resourceId: tbl.resource.id, minutes }));
  const payResp = await ok(pay(guest.token, q.quote_id, method));
  const pid = providerId(payResp);
  const tPaid = Date.now();
  emuSucceed(pid);
  const p = await waitPaymentSession(guest.token, payResp.payment_id);
  return { guest, tbl, q, payResp, pid, sessionId: p.session_id, tPaid };
}

/** Продление гостем по СБП. → { q, payResp, pid } */
export async function extendGame(guest, resourceId, sessionId, minutes) {
  const q = await ok(quote(guest.token, { resourceId, kind: 'extend', minutes, sessionId }));
  const payResp = await ok(pay(guest.token, q.quote_id, 'sbp'));
  const pid = providerId(payResp);
  emuSucceed(pid);
  return { q, payResp, pid };
}

/** Ждать, пока стол освободится и в симуляторе, и в API (для повторных прогонов). */
export async function waitTableFree(n, { timeoutMs = 240_000 } = {}) {
  await waitSim(n, (t) => t.online && t.state?.mode === 'free', { timeoutMs, what: `стол ${n} free в симуляторе` });
  return waitFor(
    async () => {
      const r = await api('GET', `/api/t/${tableCode(n)}`);
      return r.status === 200 && r.json.status === 'free' ? r.json : null;
    },
    { timeoutMs, intervalMs: 500, what: `стол ${n} free в API` },
  );
}

/** Строки лога контейнера с msg из списка. */
export function logLines(container, since, msgs) {
  const set = new Set([].concat(msgs));
  return containerLog(container, { since }).filter((l) => set.has(l.msg));
}

/** Журнал клуба по объекту/действию за время (база, только чтение). */
export async function auditRows(db, { since, actions, like } = {}) {
  const params = [CLUB_A];
  let where = 'club_id = $1';
  if (since) {
    params.push(new Date(since));
    where += ` and created_at >= $${params.length}`;
  }
  if (actions) {
    params.push([].concat(actions));
    where += ` and action = any($${params.length}::text[])`;
  }
  if (like) {
    params.push(`%${like}%`);
    where += ` and data::text like $${params.length}`;
  }
  const { rows } = await db.query(`select seq, action, object_type, object_id, reason, data, actor_type, created_at from bl.audit_log where ${where} order by seq`, params);
  return rows;
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
