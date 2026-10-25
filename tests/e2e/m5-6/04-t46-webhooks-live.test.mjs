// T46 «Вебхуки клуба» вживую на стенде: регистрация (только владелец, секрет один раз), SSRF-адреса
// отклоняются, выключение, журнал доставок, лимит 10 адресов, чужой клуб (№201).
//
// На стенде у сервера нет внешнего DNS (любое имя → url_invalid), а внутренние адреса отклоняются
// по замыслу, — поэтому настоящая доставка, подпись и повторы проверяются локально на своём Postgres
// (05-t46-webhooks-db.test.mjs). Здесь адреса-«положительный контроль» — публичные IP-литералы
// (1.1.1.1 и т. п.) с событием shift.closed в своём клубе test без смен: событий нет, запросов наружу
// не уходит; все адреса выключаются в конце; тестовое событие ping на них не отправляется.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { api, apiWait, invite, login, newClub, saveState, SEED_PHONES, short, sleep } from './lib.mjs';

const S = { hooks: [] };

async function reg(club, token, body) {
  for (let i = 0; ; i += 1) {
    const r = await api('POST', `/api/clubs/${club}/webhooks`, { token, club, body });
    if (r.status === 429 && i < 6) {
      await sleep(Number(r.headers['retry-after'] ?? 10) * 1000 + 300);
      continue;
    }
    if (r.status === 201) S.hooks.push({ club, token, id: r.json.webhook_id });
    return r;
  }
}
const disable = (club, token, id) => apiWait('POST', `/api/clubs/${club}/webhooks/${id}/disable`, { token, club, body: {} });

before(async () => {
  const a = await newClub({ name: `E2E M5.7 Вебхуки A ${Date.now() % 100000}`, tables: 1 });
  S.A = a.club;
  S.owner = a.owner;
  const b = await newClub({ name: `E2E M5.7 Вебхуки B ${Date.now() % 100000}`, tables: 1 });
  S.B = b.club;
  S.ownerB = b.owner;
  S.manager = await invite(S.A, S.owner.token, 'manager');
  S.reception = await invite(S.A, S.owner.token, 'reception');
  saveState({ hooksA: S.A, hooksB: S.B, hooksOwner: S.owner.phone });
});

after(async () => {
  for (const h of S.hooks) await disable(h.club, h.token, h.id);
});

test('T46-1: регистрация — только владелец; секрет whsec_ показан один раз; список и журнал без секрета', async (t) => {
  for (const [who, tok] of [['управляющий', S.manager.token], ['ресепшн', S.reception.token], ['чужой владелец', S.ownerB.token]]) {
    const r = await api('POST', `/api/clubs/${S.A}/webhooks`, { token: tok, club: S.A, body: { url: 'https://1.1.1.1/bl', events: ['shift.closed'] } });
    assert.equal(r.status, 403, `${who}: ${short(r)}`);
    assert.equal((await api('GET', `/api/clubs/${S.A}/webhooks`, { token: tok, club: S.A })).status, 403, `${who} список`);
  }
  const r = await reg(S.A, S.owner.token, { url: 'https://1.1.1.1/bl/in?src=e2e', events: ['shift.closed'], description: 'E2E CRM' });
  assert.equal(r.status, 201, short(r));
  S.hook = r.json;
  S.secret = r.json.secret;
  assert.match(S.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.host, '1.1.1.1');
  assert.deepEqual(r.json.events, ['shift.closed']);
  assert.equal(r.json.active, true);
  assert.equal(r.json.last_delivery, null);
  assert.ok(String(r.headers['cache-control']).includes('no-store'), `cache-control ${r.headers['cache-control']}`);
  const list = await api('GET', `/api/clubs/${S.A}/webhooks`, { token: S.owner.token, club: S.A });
  assert.equal(list.status, 200);
  assert.ok(!list.text.includes(S.secret.slice(6)), 'секрета нет в списке');
  assert.ok(!/secret/.test(Object.keys(list.json.items[0]).join(',')));
  assert.deepEqual(list.json.events, ['session.started', 'session.ended', 'booking.created', 'booking.canceled', 'shift.closed']);
  assert.equal(list.json.limit, 10);
  const au = await apiWait('GET', `/api/clubs/${S.A}/audit?action=webhook.*`, { token: S.owner.token, club: S.A });
  const c = au.json.items.find((x) => x.action === 'webhook.create');
  assert.deepEqual(c.data, { webhook_id: S.hook.webhook_id, host: '1.1.1.1', events: ['shift.closed'] });
  assert.ok(!au.text.includes(S.secret.slice(6)));
  t.diagnostic(`управляющий, ресепшн, чужой владелец — 403; владелец — 201, секрет whsec_ (длина ${S.secret.length}), Cache-Control ${r.headers['cache-control']}; в списке и журнале webhook.create {webhook_id, host, events} секрета нет`);
});

test('T46-2: SSRF — внутренние, локальные, зарезервированные и кодированные адреса → 400 url_forbidden', async (t) => {
  const forbidden = [
    'https://127.0.0.1/hook', 'https://127.1/', 'https://10.0.0.1/', 'https://172.16.0.1/', 'https://172.31.255.254/', 'https://192.168.0.1/',
    'https://169.254.169.254/latest/meta-data/', 'https://100.64.0.1/', 'https://0.0.0.0/', 'https://0/', 'https://224.0.0.1/', 'https://255.255.255.255/',
    'https://192.0.2.10/', 'https://198.51.100.7/', 'https://203.0.113.9/', 'https://198.18.0.1/',
    'https://2130706433/', 'https://017700000001/', 'https://0x7f000001/', 'https://0x7f.0.0.1/', 'https://0xA9.0xFE.0xA9.0xFE/',
    'https://[::1]/', 'https://[::]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a9fe:a9fe]/', 'https://[fd00::1]/', 'https://[fc00::5]/',
    'https://[fe80::1]/', 'https://[64:ff9b::7f00:1]/', 'https://[2002:7f00:1::1]/', 'https://[2001::1]/', 'https://[ff02::1]/',
    'https://localhost/', 'https://localhost./', 'https://x.localhost/', 'https://db.internal/', 'https://printer.local/', 'https://router.home.arpa/',
    'https://server/', 'https://db/', 'https://mosquitto/', 'https://caddy/', 'https://yookassa-emu/',
  ];
  const got = {};
  for (const url of forbidden) {
    const r = await reg(S.A, S.owner.token, { url, events: ['shift.closed'] });
    got[url] = r.status === 400 ? r.json.error : `${r.status}`;
  }
  const notForbidden = Object.entries(got).filter(([, v]) => v !== 'url_forbidden');
  // Имена внутренних сервисов без точки могут не резолвиться на стенде (url_invalid) — тоже отказ, но не тот код.
  const hard = notForbidden.filter(([, v]) => v !== 'url_invalid');
  assert.deepEqual(hard, [], `приняты: ${hard.map(([u, v]) => `${u} → ${v}`).join('; ')}`);
  const inv = notForbidden.map(([u]) => u);
  t.diagnostic(`${forbidden.length} адресов: url_forbidden ${forbidden.length - inv.length}; url_invalid ${inv.length}${inv.length ? ` (${inv.join(' ')})` : ''}; принятых 0`);
});

test('T46-3: адрес — только https на 443, без учётных данных; кривые — 400 url_invalid; события — из списка', async (t) => {
  const invalid = ['http://1.1.1.1/', 'https://1.1.1.1:8443/', 'https://1.1.1.1:22/', 'https://u:p@1.1.1.1/', 'https://1.1.1.1/#frag', 'ftp://1.1.1.1/', 'not a url', 'https:///x', `https://1.1.1.1/${'a'.repeat(2100)}`];
  const out = [];
  for (const url of invalid) {
    const r = await reg(S.A, S.owner.token, { url, events: ['shift.closed'] });
    out.push(`${url.slice(0, 30)} ${r.status} ${r.json?.error}`);
    assert.equal(r.status, 400, `${url.slice(0, 60)}: ${short(r)}`);
    assert.ok(['url_invalid', 'url_forbidden', 'bad_request'].includes(r.json.error), url.slice(0, 60));
  }
  for (const events of [[], ['payment.confirmed'], ['ping'], 'shift.closed']) {
    const r = await reg(S.A, S.owner.token, { url: 'https://1.0.0.1/', events });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], JSON.stringify(events));
  }
  // «\@» по WHATWG URL — путь, хост — 1.1.1.1 (публичный): адрес принят нормализованным, запрос ушёл бы на 1.1.1.1.
  const bs = await reg(S.A, S.owner.token, { url: 'https://1.1.1.1\\@127.0.0.1/', events: ['shift.closed'] });
  assert.equal(bs.status, 201, short(bs));
  assert.deepEqual([bs.json.host, bs.json.url], ['1.1.1.1', 'https://1.1.1.1/@127.0.0.1/']);
  t.diagnostic(out.join('; ') + `; события [], payment.confirmed, ping, строка — 400 bad_request; «https://1.1.1.1\\@127.0.0.1/» → 201, host ${bs.json.host}, url нормализован ${bs.json.url}`);
});

test('T46-4: журнал доставок — пуст до событий; кривой курсор и limit — 400; чужой клуб — 403/404', async (t) => {
  const d = await api('GET', `/api/clubs/${S.A}/webhooks/${S.hook.webhook_id}/deliveries`, { token: S.owner.token, club: S.A });
  assert.equal(d.status, 200, short(d));
  assert.deepEqual(d.json.items, []);
  assert.equal(d.json.next_cursor, null);
  for (const q of ['cursor=abc$', 'cursor=' + Buffer.from('[1,2]').toString('base64url'), 'limit=201', 'limit=0', 'status=lost']) {
    const r = await api('GET', `/api/clubs/${S.A}/webhooks/${S.hook.webhook_id}/deliveries?${q}`, { token: S.owner.token, club: S.A });
    assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], `${q}: ${short(r)}`);
  }
  const f1 = await api('GET', `/api/clubs/${S.A}/webhooks/${S.hook.webhook_id}/deliveries`, { token: S.ownerB.token, club: S.A });
  assert.equal(f1.status, 403);
  const f2 = await api('GET', `/api/clubs/${S.B}/webhooks/${S.hook.webhook_id}/deliveries`, { token: S.ownerB.token, club: S.B });
  assert.equal(f2.status, 404, short(f2));
  const f3 = await api('POST', `/api/clubs/${S.B}/webhooks/${S.hook.webhook_id}/disable`, { token: S.ownerB.token, club: S.B, body: {} });
  assert.equal(f3.status, 404, short(f3));
  const f4 = await api('POST', `/api/clubs/${S.B}/webhooks/${S.hook.webhook_id}/test`, { token: S.ownerB.token, club: S.B, body: {} });
  assert.equal(f4.status, 404, short(f4));
  const seed = await login(SEED_PHONES.owner);
  const f5 = await api('GET', `/api/clubs/${S.A}/webhooks`, { token: seed.token, club: S.A });
  assert.equal(f5.status, 403);
  t.diagnostic('журнал пуст, next_cursor null; кривой курсор, limit 201/0, status — 400; владелец B: через клуб A — 403, через свой клуб — 404 (журнал, выключение, ping); владелец сида — 403');
});

test('T46-5: выключение — необратимо, повтор — тот же ответ; ping на выключенный — 409 webhook_disabled; журнал webhook.disable', async (t) => {
  const r = await disable(S.A, S.owner.token, S.hook.webhook_id);
  assert.equal(r.status, 200, short(r));
  assert.equal(r.json.active, false);
  assert.ok(r.json.disabled_at);
  const again = await disable(S.A, S.owner.token, S.hook.webhook_id);
  assert.equal(again.status, 200);
  assert.equal(again.json.disabled_at, r.json.disabled_at);
  const p = await api('POST', `/api/clubs/${S.A}/webhooks/${S.hook.webhook_id}/test`, { token: S.owner.token, club: S.A, body: {} });
  assert.deepEqual([p.status, p.json], [409, { error: 'webhook_disabled' }]);
  const m = await api('POST', `/api/clubs/${S.A}/webhooks/${S.hook.webhook_id}/disable`, { token: S.manager.token, club: S.A, body: {} });
  assert.equal(m.status, 403);
  const au = await apiWait('GET', `/api/clubs/${S.A}/audit?action=webhook.disable`, { token: S.owner.token, club: S.A });
  assert.equal(au.json.items.length, 1);
  assert.equal(au.json.items[0].data.host, '1.1.1.1');
  t.diagnostic(`выключен ${r.json.disabled_at}; повтор — тот же; ping — 409 webhook_disabled; управляющий — 403; журнал webhook.disable ${JSON.stringify(au.json.items[0].data)}`);
});

test('T46-6: не больше 10 включённых адресов: 11-й — 409 webhooks_limit; выключенный место освобождает', async (t) => {
  const ips = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112', '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15', '76.76.2.0'];
  const made = [];
  for (let i = 0; i < 10; i += 1) {
    const r = await reg(S.B, S.ownerB.token, { url: `https://${ips[i]}/e2e/${i}`, events: ['shift.closed'] });
    assert.equal(r.status, 201, `${i}: ${short(r)}`);
    made.push(r.json.webhook_id);
  }
  const eleventh = await reg(S.B, S.ownerB.token, { url: `https://${ips[10]}/e2e/10`, events: ['shift.closed'] });
  assert.deepEqual([eleventh.status, eleventh.json], [409, { error: 'webhooks_limit' }]);
  assert.equal((await disable(S.B, S.ownerB.token, made[0])).status, 200);
  const again = await reg(S.B, S.ownerB.token, { url: `https://${ips[10]}/e2e/10`, events: ['shift.closed'] });
  assert.equal(again.status, 201, short(again));
  const list = (await apiWait('GET', `/api/clubs/${S.B}/webhooks`, { token: S.ownerB.token, club: S.B })).json;
  assert.equal(list.active, 10);
  t.diagnostic('10 × 201, 11-й — 409 webhooks_limit; после выключения одного — 201; включённых 10 (все выключаются в after)');
});

test('T46-7: стенд не резолвит внешние имена — url_invalid (для сведения: настоящая доставка — в 05)', async (t) => {
  const r = await reg(S.A, S.owner.token, { url: 'https://example.com/bl-e2e', events: ['shift.closed'] });
  t.diagnostic(`https://example.com/… → ${r.status} ${r.json?.error ?? ''}`);
  assert.ok([201, 400].includes(r.status));
});
