/*
 * BL_MOCK_MARKER — заглушка M5.7 «API и вебхуки» (только VITE_MOCK=1), формы — server/clubapi/README.md
 * («Маршруты владельца»). Только владелец; выпуск ключа и добавление адреса — только личным входом (сценарий
 * api-pin — вход по PIN, 403 forbidden). Ключ и секрет — один раз в ответе, в состоянии заглушки их нет.
 * Тестовое событие доставляется через 3 секунды; адрес …/fail отвечает 503.
 */

import { MAX_KEYS, MAX_WEBHOOKS, SCOPES, EVENTS, webhookUrlError } from '../lib/clubapi.js';

const MIN = 60_000;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const rnd = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => B64[b % 64]).join('');
export const MOCK_WEBHOOK_ID = 'a7e10000-0000-4000-8000-0000000000a1';

export function clubapiState(t) {
  const iso = (minAgo) => new Date(t - minAgo * MIN).toISOString();
  const owner = { created_by: 'u-owner-0001', created_by_name: 'Андрей' };
  const log = (attempts) => attempts.map(([minAgo, http, error, ms], i) => ({ attempt: i + 1, at: iso(minAgo), http_status: http, error, duration_ms: ms }));
  const d = (id, event, minAgo, status, attempts, extra = {}) => {
    const l = log(attempts);
    const last = l.at(-1) ?? null;
    return { delivery_id: `d${id}000000-0000-4000-8000-00000000d00${id}`.slice(0, 36), event_id: `e${id}000000-0000-4000-8000-00000000e00${id}`.slice(0, 36), event, status, attempts: l.length, created_at: iso(minAgo), last_attempt_at: last?.at ?? null, next_attempt_at: null, delivered_at: status === 'delivered' ? last?.at : null, http_status: last?.http_status ?? null, error: last?.error ?? null, log: l, ...extra };
  };
  return {
    keys: [
      { key_id: 'b1000000-0000-4000-8000-0000000000b1', name: 'CRM клуба', prefix: 'blk_Qx7rT2mA', scopes: ['tables:read', 'sales:read', 'bookings:read'], created_at: iso(60 * 24 * 12), ...owner, last_used_at: iso(4), revoked_at: null, active: true },
      { key_id: 'b2000000-0000-4000-8000-0000000000b2', name: 'Старый сайт', prefix: 'blk_9kLpW3cZ', scopes: ['tables:read', 'tariffs:read'], created_at: iso(60 * 24 * 40), ...owner, last_used_at: iso(60 * 24 * 21), revoked_at: iso(60 * 24 * 20), active: false },
    ],
    hooks: [
      { webhook_id: MOCK_WEBHOOK_ID, url: 'https://crm.example.ru/hooks/billiardum', host: 'crm.example.ru', events: ['session.started', 'session.ended', 'booking.created'], description: 'CRM клуба', created_at: iso(60 * 24 * 12), ...owner, active: true, disabled_at: null },
      { webhook_id: 'a7e20000-0000-4000-8000-0000000000a2', url: 'https://old.example.ru/hook', host: 'old.example.ru', events: ['shift.closed'], description: null, created_at: iso(60 * 24 * 40), ...owner, active: false, disabled_at: iso(60 * 24 * 20) },
    ],
    deliveries: {
      [MOCK_WEBHOOK_ID]: [
        d(1, 'session.started', 6, 'pending', [[6, 503, 'http', 38], [5, 503, 'http', 41]], { next_attempt_at: new Date(t + 10 * MIN).toISOString() }),
        d(2, 'booking.created', 95, 'delivered', [[95, 200, null, 64]]),
        d(3, 'session.ended', 60 * 26, 'failed', [[60 * 26, null, 'timeout', 10000], [60 * 25, null, 'timeout', 10000], [60 * 2, 500, 'http', 52]]),
        d(4, 'session.started', 60 * 27, 'delivered', [[60 * 27, 204, null, 47]]),
      ],
      'a7e20000-0000-4000-8000-0000000000a2': [d(5, 'shift.closed', 60 * 24 * 21, 'canceled', [[60 * 24 * 21, null, 'dns', 12]])],
    },
  };
}

export function clubapiRoutes({ state, me, err, ok, audit, now }) {
  const S = () => {
    const st = state();
    if (!st.clubapi) st.clubapi = clubapiState(now());
    return st.clubapi;
  };
  const owner = (fn) => (m, b, q) => (!me() ? err(401, 'unauthorized') : me().role === 'owner' ? fn(m, b, q) : err(403, 'forbidden'));
  const personal = () => state().sessionKind !== 'pin';

  /** Тестовое событие доставляется через 3 секунды (как воркер раз в 5 с и сразу после новой доставки). */
  function advance() {
    for (const [id, list] of Object.entries(S().deliveries)) {
      const hook = S().hooks.find((h) => h.webhook_id === id);
      for (const x of list) {
        if (x.status !== 'pending' || !x.ready_at || now() < x.ready_at) continue;
        const fail = hook.url.endsWith('/fail');
        const at = new Date(x.ready_at).toISOString();
        x.log.push({ attempt: x.log.length + 1, at, http_status: fail ? 503 : 200, error: fail ? 'http' : null, duration_ms: 57 });
        Object.assign(x, { attempts: x.log.length, last_attempt_at: at, http_status: fail ? 503 : 200, error: fail ? 'http' : null, status: fail ? 'pending' : 'delivered', delivered_at: fail ? null : at, next_attempt_at: fail ? new Date(x.ready_at + MIN).toISOString() : null, ready_at: null });
      }
    }
  }

  const hookView = (h) => {
    advance();
    const list = S().deliveries[h.webhook_id] ?? [];
    const last = list.find((x) => x.attempts > 0) ?? null;
    return { ...h, last_delivery: last ? { status: last.status, http_status: last.http_status, error: last.error, at: last.last_attempt_at } : null, pending: list.filter((x) => x.status === 'pending').length, failed: list.filter((x) => x.status === 'failed').length };
  };
  const strip = ({ ready_at: _r, ...x }) => x;

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/api-keys$/, owner(() => ok({ items: S().keys, active: S().keys.filter((k) => k.active).length, limit: MAX_KEYS, scopes: [...SCOPES] }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/api-keys$/, owner((_m, b) => {
      if (!personal()) return err(403, 'forbidden');
      const name = typeof b?.name === 'string' ? b.name.replace(/\s+/g, ' ').trim() : '';
      if (!name || name.length > 100 || !Array.isArray(b.scopes) || !b.scopes.length || b.scopes.some((s) => !SCOPES.includes(s))) return err(400, 'bad_request');
      if (S().keys.filter((k) => k.active).length >= MAX_KEYS) return err(409, 'api_keys_limit');
      const key = `blk_${rnd(43)}`;
      const item = { key_id: globalThis.crypto.randomUUID(), name, prefix: key.slice(0, 12), scopes: SCOPES.filter((s) => b.scopes.includes(s)), created_at: new Date(now()).toISOString(), created_by: me().id, created_by_name: me().name, last_used_at: null, revoked_at: null, active: true };
      S().keys.unshift(item);
      audit('api_key.create', { data: { key_id: item.key_id, name, prefix: item.prefix, scopes: item.scopes } });
      return { status: 201, body: { ...item, key } };
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/api-keys\/([^/]+)\/revoke$/, owner((m) => {
      const k = S().keys.find((x) => x.key_id === m[2]);
      if (!k) return err(404, 'not_found');
      if (k.active) {
        Object.assign(k, { active: false, revoked_at: new Date(now()).toISOString() });
        audit('api_key.revoke', { data: { key_id: k.key_id, name: k.name, prefix: k.prefix } });
      }
      return ok(k);
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/webhooks$/, owner(() => ok({ items: S().hooks.map(hookView), active: S().hooks.filter((h) => h.active).length, limit: MAX_WEBHOOKS, events: [...EVENTS] }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/webhooks$/, owner((_m, b) => {
      if (!personal()) return err(403, 'forbidden');
      if (typeof b?.url !== 'string') return err(400, 'bad_request');
      if (webhookUrlError(b.url)) return err(400, 'url_invalid');
      const host = new URL(b.url).hostname;
      if (/^(internal|intranet)\./.test(host)) return err(400, 'url_forbidden');
      if (!Array.isArray(b.events) || !b.events.length || b.events.some((e) => !EVENTS.includes(e))) return err(400, 'bad_request');
      if (S().hooks.filter((h) => h.active).length >= MAX_WEBHOOKS) return err(409, 'webhooks_limit');
      const h = { webhook_id: globalThis.crypto.randomUUID(), url: b.url.trim(), host, events: EVENTS.filter((e) => b.events.includes(e)), description: b.description?.trim() || null, created_at: new Date(now()).toISOString(), created_by: me().id, created_by_name: me().name, active: true, disabled_at: null };
      S().hooks.unshift(h);
      S().deliveries[h.webhook_id] = [];
      audit('webhook.create', { data: { webhook_id: h.webhook_id, host, events: h.events } });
      return { status: 201, body: { ...hookView(h), secret: `whsec_${rnd(43)}` } };
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/webhooks\/([^/]+)\/disable$/, owner((m) => {
      const h = S().hooks.find((x) => x.webhook_id === m[2]);
      if (!h) return err(404, 'not_found');
      if (h.active) {
        Object.assign(h, { active: false, disabled_at: new Date(now()).toISOString() });
        let canceled = 0;
        for (const x of S().deliveries[h.webhook_id] ?? []) if (x.status === 'pending') ((x.status = 'canceled'), (x.next_attempt_at = null), (x.ready_at = null), (canceled += 1));
        audit('webhook.disable', { data: { webhook_id: h.webhook_id, host: h.host, canceled } });
      }
      return ok(hookView(h));
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/webhooks\/([^/]+)\/deliveries$/, owner((m, _b, q) => {
      if (!S().hooks.some((x) => x.webhook_id === m[2])) return err(404, 'not_found');
      advance();
      const status = q.get('status');
      const list = (S().deliveries[m[2]] ?? []).filter((x) => !status || x.status === status);
      return ok({ webhook_id: m[2], items: list.map(strip), next_cursor: null });
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/webhooks\/([^/]+)\/test$/, owner((m) => {
      const h = S().hooks.find((x) => x.webhook_id === m[2]);
      if (!h) return err(404, 'not_found');
      if (!h.active) return err(409, 'webhook_disabled');
      const x = { delivery_id: globalThis.crypto.randomUUID(), event_id: globalThis.crypto.randomUUID(), event: 'ping', status: 'pending', attempts: 0, created_at: new Date(now()).toISOString(), last_attempt_at: null, next_attempt_at: new Date(now()).toISOString(), delivered_at: null, http_status: null, error: null, log: [], ready_at: now() + 3000 };
      S().deliveries[h.webhook_id].unshift(x);
      return { status: 202, body: { delivery_id: x.delivery_id, event_id: x.event_id, event: 'ping', status: 'pending' } };
    })],
  ];
  return { routes };
}
