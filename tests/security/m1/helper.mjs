// Общий помощник PoC M1 (pentester): HTTP к живому стеку через Caddy (https://localhost:8443,
// самоподписанный внутренний CA Caddy — rejectUnauthorized:false только для localhost) и
// чтение живой базы под supabase_admin. Секреты не печатаются.
//
// Запуск тестов: из корня репозитория
//   node --test --test-concurrency=1 tests/security/m1/*.test.mjs
// Переменные берутся из deploy/dev/.env через deploy; здесь нужен только BASE и ADMIN_URL.

import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASE = process.env.BL_BASE ?? 'https://localhost:8443';

/** Прочитать .env корня (только для адреса базы админа; значения не печатаем). */
export function readEnv() {
  const out = {};
  try {
    const text = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* нет файла — переменные из окружения */
  }
  return { ...out, ...process.env };
}

/** DATABASE_ADMIN_URL с хостовым доступом (db:5432 → 127.0.0.1:54322). */
export function adminUrl() {
  const env = readEnv();
  const u = env.DATABASE_ADMIN_URL ?? '';
  return u.replace('@db:5432/', '@127.0.0.1:54322/').replace('@localhost:54322/', '@127.0.0.1:54322/');
}

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

/**
 * HTTP-запрос к стеку. Возвращает { status, headers, json, text }.
 * @param {string} method
 * @param {string} p путь (начинается с /)
 * @param {{ token?: string, cookie?: string, origin?: string|null, idem?: string, body?: object|string,
 *   headers?: object, raw?: boolean }} [opts]
 */
export function req(method, p, opts = {}) {
  const url = new URL(p, BASE);
  const headers = { ...(opts.headers ?? {}) };
  let payload;
  if (opts.body !== undefined) {
    payload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (!('content-type' in headers) && opts.rawContentType === undefined) headers['content-type'] = 'application/json';
    if (opts.rawContentType) headers['content-type'] = opts.rawContentType;
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== undefined && opts.origin !== null) headers.origin = opts.origin;
  if (opts.idem) headers['idempotency-key'] = opts.idem;
  return new Promise((resolve, reject) => {
    const r = https.request(
      url,
      { method, agent, headers, timeout: 15000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* не JSON */
          }
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

export const uuid = () => randomUUID();
export const ORIGIN = BASE;

/** Вход для разработки: вернуть { token, user }. */
export async function devLogin(phone) {
  const r = await req('POST', '/api/auth/dev', { body: { phone }, origin: ORIGIN });
  if (r.status !== 200) throw new Error(`dev login ${phone}: ${r.status} ${r.text}`);
  return r.json;
}

/** Гость с согласием: вернуть token. */
export async function guest(phone) {
  const { token } = await devLogin(phone);
  const c = await req('POST', '/api/auth/consent', { token, body: { version: '2026-10-21' }, origin: ORIGIN });
  if (c.status !== 200) throw new Error(`consent: ${c.status} ${c.text}`);
  return token;
}

/** Запрос к живой базе под supabase_admin (read-only PoC). Возвращает массив строк (json). */
export async function sql(query, params = [], url = adminUrl()) {
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client ?? pg.default;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query(query, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/** Снять активные удержания стола (pending/reserved/service) — подготовка своего стола к PoC. */
export async function clearHolds(resourceId) {
  await sql("update bl.resource_holds set released_at = now(), release_reason = 'pentest_setup' where resource_id = $1 and released_at is null", [resourceId]);
}

/** Освободить свой стол для PoC: закрыть идущие сессии и снять удержания (teardown на своих столах). */
export async function resetTable(resourceId) {
  await sql(
    "update bl.sessions set status = 'closed', ended_at = coalesce(ended_at, now()), close_reason = coalesce(close_reason, 'stopped'), updated_at = now() where resource_id = $1 and status in ('active','ending','grace','interrupted')",
    [resourceId],
  );
  await clearHolds(resourceId);
}

export const TABLE7 = 'e1000000-0000-4000-8000-000000000007';
export const TABLE8 = 'e1000000-0000-4000-8000-000000000008';
export const CLUB = 'c1000000-0000-4000-8000-000000000001';
export const CODE7 = 'TEST000007';
export const CODE8 = 'TEST000008';
