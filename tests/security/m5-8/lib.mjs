// Общий помощник PoC M5.8 (pentester). Только то, что доступно атакующему и тестовой обвязке:
// HTTP API через Caddy (https://localhost:8443), управление эмулятором ЮKassa через `docker exec`
// (как в tests/e2e/m1/helpers.mjs), состояние симулятора контроллера по HTTP (127.0.0.1:18080).
// К базе стенда, .env и секретам не обращается. Телефоны гостей — +7999676xxxx.

import https from 'node:https';
import { spawnSync } from 'node:child_process';

export const BASE = process.env.BL_BASE ?? 'https://localhost:8443';
export const SIM = process.env.E2E_SIM_URL ?? 'http://127.0.0.1:18080';
export const EMU_CONTAINER = process.env.E2E_EMU_CONTAINER ?? 'billiardum-yookassa-emu-1';

// Корты сида (клуб live, Asia/Yekaterinburg): коды QR и устройства симулятора.
export const COURT_CODES = { 101: 'TESTC00001', 102: 'TESTC00002' };

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false }); // только localhost

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Запрос к API. → { status, json, text }. */
export function api(method, path, { token, body, idem, headers = {} } = {}) {
  const url = new URL(path, BASE);
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined || (method !== 'GET' && method !== 'HEAD')) {
    payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    h['content-type'] = 'application/json';
    h['content-length'] = String(payload.length);
  }
  if (idem) h['idempotency-key'] = idem === true ? crypto.randomUUID() : idem;
  return new Promise((resolve, reject) => {
    const r = https.request(url, { method, headers: h, agent, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* не JSON */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('timeout', () => r.destroy(new Error(`timeout ${method} ${path}`)));
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

export async function ok(promise, expected = 200) {
  const r = await promise;
  if (r.status !== expected) throw new Error(`ожидали ${expected}, пришло ${r.status} ${r.text.slice(0, 300)}`);
  return r.json;
}

/** Телефоны +7999676NNNN (заход 2; заход 1 — +7999674NNNN): уникальны на прогон (минуты и счётчик). */
let seq = 0;
export function phone() {
  seq += 1;
  const n = (Math.floor(Date.now() / 1000) % 9000) + seq;
  return `+7999676${String(n % 10000).padStart(4, '0')}`;
}

/** Вход для разработки; гостю принимается согласие. → { token, user, phone } */
export async function login(ph = phone(), { consent = true } = {}) {
  const r = await ok(api('POST', '/api/auth/dev', { body: { phone: ph } }));
  if (consent) {
    const me = await ok(api('GET', '/api/me', { token: r.token }));
    if (!me.user.consent_version) await ok(api('POST', '/api/auth/consent', { token: r.token, body: { version: me.user.consent.version } }));
  }
  return { token: r.token, user: r.user, phone: ph };
}

export const tableByCode = (code, token) => api('GET', `/api/t/${code}`, { token });
export const quote = (token, body) => api('POST', '/api/quotes', { token, body });
export const pay = (token, quoteId, method = 'sbp', idem = true) => api('POST', `/api/quotes/${quoteId}/pay`, { token, body: { method }, idem });

/** id платежа ЮKassa из confirmation.url (…/pay/{id}). */
export function providerId(payResp) {
  const url = payResp?.confirmation?.url ?? payResp?.confirmation?.confirmation_url;
  const m = /\/pay\/([^/?#]+)/.exec(url ?? '');
  if (!m) throw new Error(`нет confirmation.url: ${JSON.stringify(payResp)}`);
  return m[1];
}

// Эмулятор ЮKassa ---------------------------------------------------------------------------

export function emu(path, { post = false } = {}) {
  const args = ['exec', EMU_CONTAINER, 'wget', '-qO-'];
  if (post) args.push('--post-data=');
  args.push(`http://127.0.0.1:8090${path}`);
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`эмулятор ${path}: ${res.stderr.trim()}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}
export const emuSucceed = (pid) => emu(`/__emu/payments/${pid}/succeed?wait=1`, { post: true });

/** Повтор вебхука N раз; override подменяет поля объекта (подделка суммы и т. п.). */
export function emuWebhook(pid, { repeat = 1, override } = {}) {
  const args = ['exec', EMU_CONTAINER, 'wget', '-qO-', '--header=Content-Type: application/json', `--post-data=${JSON.stringify(override ? { override } : {})}`];
  args.push(`http://127.0.0.1:8090/__emu/payments/${pid}/webhook?repeat=${repeat}`);
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`эмулятор webhook: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}
export const emuPayment = (pid) => emu(`/__emu/payments/${pid}`);

// Симулятор контроллера -----------------------------------------------------------------------

export async function sim(n) {
  const r = await fetch(`${SIM}/sim/tables/${n}`);
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

/** Ждать, пока корт/стол свободен в API (после чужих проверок). */
export const waitFree = (code, token, timeoutMs = 20_000) =>
  waitFor(async () => {
    const r = await tableByCode(code, token);
    return r.status === 200 && r.json.status === 'free' ? r.json : null;
  }, { timeoutMs, intervalMs: 1000, what: `${code} free` });

/** Старт игры гостем: QR-код → котировка → СБП → «оплачено» в эмуляторе → сессия. */
export async function startGame(code, minutes, guest) {
  const t = await ok(tableByCode(code, guest.token));
  const q = await ok(quote(guest.token, { resource_id: t.resource.id, kind: 'start', minutes }));
  const payResp = await ok(pay(guest.token, q.quote_id, 'sbp'));
  const pid = providerId(payResp);
  emuSucceed(pid);
  const p = await waitFor(async () => {
    const r = await api('GET', `/api/payments/${payResp.payment_id}`, { token: guest.token });
    return r.status === 200 && r.json.session_id ? r.json : null;
  }, { what: 'session_id у платежа' });
  return { t, q, payResp, pid, sessionId: p.session_id };
}

/** «Закончить игру» — освободить ресурс в конце проверки. */
export const stopGame = (guest, sessionId) => api('POST', `/api/sessions/${sessionId}/stop`, { token: guest.token, body: {} });

// Мини-раннер проверок: печатает ОК/FAIL и возвращает код выхода ----------------------------------

export function runner(title) {
  const results = [];
  const findings = [];
  console.log(`== ${title}`);
  return {
    check(name, cond, extra = '') {
      results.push(Boolean(cond));
      console.log(`${cond ? 'ОК  ' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
    },
    // Находка: reproduced = true означает, что вредное поведение воспроизводится (защиты нет).
    // На код выхода не влияет: PoC находки «проходит», пока дефект жив.
    finding(name, reproduced, extra = '') {
      findings.push(Boolean(reproduced));
      console.log(`${reproduced ? 'НАХОДКА воспроизведена' : 'находка не воспроизводится'}: ${name}${extra ? ` — ${extra}` : ''}`);
    },
    done() {
      const bad = results.filter((x) => !x).length;
      const live = findings.filter(Boolean).length;
      console.log(`${results.length - bad}/${results.length} ОК${bad ? `, ${bad} FAIL` : ''}${findings.length ? `; находок воспроизведено ${live}/${findings.length}` : ''}`);
      process.exitCode = bad ? 1 : 0;
    },
  };
}
