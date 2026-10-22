// Вход (контракт M1 §4) на временной базе: вход для разработки, initData Telegram, вход через
// бота (вебхук на заглушке — сеть к Telegram закрыта), согласие, me, выход, CSRF,
// терминал ресепшена и PIN с блокировкой.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signInitData } from '../../auth/telegram.mjs';
import { CLUB_A, MANAGER_A, ORIGIN, OWNER_A, RECEPTION_A, startTestApp } from './helpers.mjs';

const BOT_TOKEN = '123456789:TEST-token-for-tests_only';
const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
let t;
const botCalls = [];

before(async () => {
  t = await startTestApp({
    config: { telegram: { botToken: BOT_TOKEN, botUsername: 'bl_test_bot', webhookSecret: WEBHOOK_SECRET, proxyUrl: null } },
    telegram: {
      configured: true,
      async call(method, params) {
        botCalls.push({ method, params });
        return { ok: true };
      },
    },
  });
});

after(async () => {
  await t?.stop();
});

function initData(user, authDate = Math.floor(Date.now() / 1000)) {
  return signInitData({ auth_date: String(authDate), query_id: 'AAHdF6IQAAAAAN0XohDhrOrc', user: JSON.stringify(user) }, BOT_TOKEN);
}

function cookieOf(res, name) {
  const all = res.headers.getSetCookie();
  const c = all.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
}

async function webhook(update, secret = WEBHOOK_SECRET) {
  return t.request('POST', '/api/bots/telegram/webhook', {
    body: update,
    origin: null,
    headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {},
  });
}

let updateId = 1;
const message = (from, extra) => ({ update_id: updateId++, message: { message_id: updateId, from: { id: from, is_bot: false, first_name: 'Т' }, chat: { id: from, type: 'private' }, date: 1, ...extra } });

describe('вход для разработки и сессия', () => {
  it('POST /api/auth/dev создаёт пользователя, выдаёт токен и cookie bl_session (HttpOnly, Secure, SameSite=Lax)', async () => {
    const res = await t.request('POST', '/api/auth/dev', { body: { phone: '+79990000001' } });
    assert.equal(res.status, 200);
    assert.match(res.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.json.user.phone_masked, '+7999***0001');
    assert.equal(res.json.user.needs_phone, false);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('bl_session='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/api/);
    // В базе только sha256 токена.
    const { rows } = await t.admin.query('select token_hash from bl.auth_tokens where user_id = $1', [res.json.user.id]);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, res.json.token);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    // Телефон в логах — только маской.
    assert.ok(!JSON.stringify(t.log.lines).includes('+79990000001'));
  });

  it('неверный телефон — 400 bad_request', async () => {
    const res = await t.request('POST', '/api/auth/dev', { body: { phone: '89990000001' } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'bad_request' });
  });

  it('me, согласие, выход; после выхода токен не действует', async () => {
    const { token } = await t.login('+79990000002');
    let me = await t.request('GET', '/api/me', { token });
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.clubs, []);
    assert.equal(me.json.user.consent.accepted, false);
    assert.equal((await t.request('POST', '/api/auth/consent', { token, body: { version: 'old' } })).status, 400);
    assert.deepEqual((await t.request('POST', '/api/auth/consent', { token, body: { version: '2026-10-21' } })).json, { ok: true });
    me = await t.request('GET', '/api/me', { token });
    assert.equal(me.json.user.consent.accepted, true);
    const out = await t.request('POST', '/api/auth/logout', { token });
    assert.deepEqual(out.json, { ok: true });
    assert.match(out.headers.getSetCookie()[0], /bl_session=; Path=\/api; Max-Age=0/);
    assert.equal((await t.request('GET', '/api/me', { token })).status, 401);
  });

  it('персонал при входе получает клубы с ролью и запись auth.staff_login в журнале клуба', async () => {
    const { token } = await t.login('+70000000003');
    const me = await t.request('GET', '/api/me', { token });
    assert.deepEqual(me.json.clubs, [{ club_id: CLUB_A, role: 'manager', name: 'Тестовый клуб' }]);
    const { rows } = await t.admin.query("select actor_id, data from bl.audit_log where club_id = $1 and action = 'auth.staff_login' and actor_id = $2", [
      CLUB_A,
      MANAGER_A,
    ]);
    assert.ok(rows.length >= 1);
    assert.deepEqual(rows.at(-1).data, { via: 'dev' });
  });

  it('без токена — 401, чужая роль — 403, ошибки только кодом', async () => {
    assert.deepEqual((await t.request('GET', '/api/me')).json, { error: 'unauthorized' });
    const guest = await t.login('+79990000003');
    const res = await t.request('GET', `/api/clubs/${CLUB_A}/now`, { token: guest.token });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'forbidden' });
  });
});

describe('CSRF и формат запросов', () => {
  it('cookie без Origin или с чужим Origin — 403; свой Origin — проходит; Bearer без Origin — проходит', async () => {
    const { token } = await t.login('+79990000004');
    const cookie = `bl_session=${token}`;
    const body = { version: '2026-10-21' };
    assert.equal((await t.request('POST', '/api/auth/consent', { cookie, body, origin: null })).status, 403);
    assert.equal((await t.request('POST', '/api/auth/consent', { cookie, body, origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.request('POST', '/api/auth/consent', { cookie, body, origin: ORIGIN })).status, 200);
    assert.equal((await t.request('POST', '/api/auth/consent', { token, body, origin: null })).status, 200);
    // Чужой Origin не проходит и с Bearer.
    assert.equal((await t.request('POST', '/api/auth/consent', { token, body, origin: 'https://evil.example' })).status, 403);
  });

  it('изменяющий запрос без Content-Type: application/json — 415, тело больше 64 КБ — 413, не JSON — 400', async () => {
    const { token } = await t.login('+79990000005');
    const noType = await t.request('POST', '/api/auth/consent', { token, body: '{}', raw: true, headers: { 'content-type': 'text/plain' } });
    assert.equal(noType.status, 415);
    assert.deepEqual(noType.json, { error: 'bad_request' });
    const big = await t.request('POST', '/api/auth/consent', { token, body: { version: 'x'.repeat(70_000) } });
    assert.equal(big.status, 413);
    const bad = await t.request('POST', '/api/auth/consent', { token, body: '{nope', raw: true });
    assert.equal(bad.status, 400);
  });

  it('заголовки безопасности и no-store у ответов API', async () => {
    const res = await t.request('GET', '/api/me');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  });
});

describe('Telegram: initData мини-приложения', () => {
  it('верная подпись — токен, needs_phone: true для нового пользователя', async () => {
    const res = await t.request('POST', '/api/auth/telegram', { body: { init_data: initData({ id: 5001, first_name: 'Иван' }) }, origin: null });
    assert.equal(res.status, 200);
    assert.equal(res.json.needs_phone, true);
    assert.equal(res.json.user.phone_masked, null);
    assert.equal(res.json.user.channels.telegram, true);
    // Повторный вход — тот же пользователь.
    const again = await t.request('POST', '/api/auth/telegram', { body: { init_data: initData({ id: 5001 }) }, origin: null });
    assert.equal(again.json.user.id, res.json.user.id);
  });

  it('подделка, старше 24 часов, чужой токен бота — 401', async () => {
    const good = initData({ id: 5002 });
    const tampered = good.replace('5002', '5003');
    assert.equal((await t.request('POST', '/api/auth/telegram', { body: { init_data: tampered }, origin: null })).status, 401);
    const old = initData({ id: 5002 }, Math.floor(Date.now() / 1000) - 24 * 3600 - 60);
    assert.equal((await t.request('POST', '/api/auth/telegram', { body: { init_data: old }, origin: null })).status, 401);
    const foreign = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: '{"id":5002}' }, '999:OTHER');
    assert.equal((await t.request('POST', '/api/auth/telegram', { body: { init_data: foreign }, origin: null })).status, 401);
  });

  it('MAX — 501 not_configured до документации', async () => {
    const res = await t.request('POST', '/api/auth/max', { body: { init_data: 'x' }, origin: null });
    assert.equal(res.status, 501);
    assert.deepEqual(res.json, { error: 'not_configured' });
  });
});

describe('вход через бота (bot-link)', () => {
  it('nonce → /start → контакт → токен один раз и только браузеру с cookie bl_link', async () => {
    const created = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    assert.equal(created.status, 200);
    const { nonce, deep_link: link } = created.json;
    assert.equal(link, `https://t.me/bl_test_bot?start=${nonce}`);
    const browser = cookieOf(created, 'bl_link');
    assert.ok(browser);
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser })).json, { status: 'pending' });

    botCalls.length = 0;
    assert.equal((await webhook(message(7001, { text: `/start ${nonce}` }))).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(botCalls.length, 1);
    assert.equal(botCalls[0].params.reply_markup.keyboard[0][0].request_contact, true);
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser })).json, { status: 'pending' });

    // Чужой контакт не принимается.
    await webhook(message(7001, { contact: { phone_number: '79991112233', user_id: 7002 } }));
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser })).json, { status: 'pending' });

    await webhook(message(7001, { contact: { phone_number: '79991112233', user_id: 7001 } }));
    // Без cookie браузера — как будто nonce нет.
    assert.equal((await t.request('GET', `/api/auth/bot-link/${nonce}`)).status, 404);
    assert.equal((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: 'bl_link=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).status, 404);
    const done = await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser });
    assert.equal(done.json.status, 'done');
    assert.match(done.json.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(done.json.user.phone_masked, '+7999***2233');
    assert.ok(cookieOf(done, 'bl_session'));
    // Токен выдаётся один раз.
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser })).json, { status: 'done' });
    const me = await t.request('GET', '/api/me', { token: done.json.token });
    assert.equal(me.status, 200);
    // nonce в базе только хешем.
    const { rows } = await t.admin.query('select count(*)::int as n from bl.bot_link_nonces where nonce_hash = $1', [nonce]);
    assert.equal(rows[0].n, 0);
  });

  it('вебхук без секрета или с чужим секретом — 401', async () => {
    assert.equal((await webhook(message(7001, { text: '/start' }), null)).status, 401);
    assert.equal((await webhook(message(7001, { text: '/start' }), 'wrong-secret-0123456789')).status, 401);
  });

  it('телефон сотрудника из сида: учётка мессенджера вливается в учётку сотрудника', async () => {
    // Мини-приложение: вход по initData без телефона.
    const tg = await t.request('POST', '/api/auth/telegram', { body: { init_data: initData({ id: 7100 }) }, origin: null });
    assert.equal(tg.json.needs_phone, true);
    const created = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    const browser = cookieOf(created, 'bl_link');
    await webhook(message(7100, { text: `/start ${created.json.nonce}` }));
    await webhook(message(7100, { contact: { phone_number: '+70000000004', user_id: 7100 } }));
    const done = await t.request('GET', `/api/auth/bot-link/${created.json.nonce}`, { cookie: browser });
    assert.equal(done.json.user.id, RECEPTION_A);
    // Старый токен влитой учётки больше не действует; повторный вход по initData — уже сотрудник.
    assert.equal((await t.request('GET', '/api/me', { token: tg.json.token })).status, 401);
    const again = await t.request('POST', '/api/auth/telegram', { body: { init_data: initData({ id: 7100 }) }, origin: null });
    assert.equal(again.json.user.id, RECEPTION_A);
    assert.equal(again.json.needs_phone, false);
    const merged = await t.admin.query('select merged_into, telegram_user_id from bl.users where id = $1', [tg.json.user.id]);
    assert.deepEqual(merged.rows[0], { merged_into: RECEPTION_A, telegram_user_id: null });
  });

  it('номер у другого аккаунта Telegram — phone_conflict, вход не выполняется', async () => {
    const created = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    const browser = cookieOf(created, 'bl_link');
    botCalls.length = 0;
    await webhook(message(7200, { text: `/start ${created.json.nonce}` }));
    await webhook(message(7200, { contact: { phone_number: '+70000000004', user_id: 7200 } }));
    await new Promise((r) => setTimeout(r, 50));
    assert.match(botCalls.at(-1).params.text, /уже привязан/);
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${created.json.nonce}`, { cookie: browser })).json, { status: 'pending' });
  });

  it('канал max — 501 not_configured', async () => {
    const res = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'max' }, origin: null });
    assert.equal(res.status, 501);
  });
});

describe('терминал ресепшена и PIN', () => {
  let terminalToken;
  let receptionToken;

  it('управляющий регистрирует терминал; ресепшн задаёт PIN', async () => {
    const manager = await t.login('+70000000003');
    const reg = await t.request('POST', '/api/staff/terminal', { token: manager.token, body: { club_id: CLUB_A, name: 'Стойка 1' } });
    assert.equal(reg.status, 200);
    terminalToken = reg.json.terminal_token;
    const reception = await t.login('+70000000004');
    receptionToken = reception.token;
    // Ресепшн не регистрирует терминалы.
    assert.equal((await t.request('POST', '/api/staff/terminal', { token: receptionToken, body: { club_id: CLUB_A, name: 'X' } })).status, 403);
    assert.equal((await t.request('PUT', '/api/staff/pin', { token: receptionToken, body: { club_id: CLUB_A, pin: '12a4' } })).status, 400);
    assert.deepEqual((await t.request('PUT', '/api/staff/pin', { token: receptionToken, body: { club_id: CLUB_A, pin: '4821' } })).json, { ok: true });
    const { rows } = await t.admin.query('select pin_hash from bl.club_members where user_id = $1', [RECEPTION_A]);
    assert.match(rows[0].pin_hash, /^scrypt\$16384\$8\$1\$/);
    assert.ok(!rows[0].pin_hash.includes('4821'));
  });

  it('терминал видит персонал с маской телефона; токен терминала — не вход пользователя', async () => {
    const info = await t.request('GET', '/api/staff/terminal', { token: terminalToken });
    assert.equal(info.status, 200);
    const rec = info.json.staff.find((s) => s.user_id === RECEPTION_A);
    assert.deepEqual(rec, { user_id: RECEPTION_A, role: 'reception', phone_masked: '+7000***0004', pin_set: true });
    assert.equal((await t.request('GET', '/api/me', { token: terminalToken })).status, 401);
    assert.equal((await t.request('POST', '/api/staff/pin', { token: receptionToken, body: { user_id: RECEPTION_A, pin: '4821' } })).status, 401);
  });

  it('PIN верный — токен в клубе терминала и запись auth.pin_switch с terminal_id', async () => {
    const res = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(res.status, 200);
    const pinToken = res.json.token;
    const me = await t.request('GET', '/api/me', { token: pinToken });
    assert.equal(me.json.session.kind, 'pin');
    assert.deepEqual(me.json.clubs.map((c) => c.role), ['reception']);
    const { rows } = await t.admin.query("select data, actor_id from bl.audit_log where action = 'auth.pin_switch' order by seq desc limit 1");
    assert.equal(rows[0].actor_id, RECEPTION_A);
    assert.ok(rows[0].data.terminal_id);
    // Смена на другого сотрудника отзывает токен предыдущего на этом терминале.
    const owner = await t.login('+70000000001');
    await t.request('PUT', '/api/staff/pin', { token: owner.token, body: { club_id: CLUB_A, pin: '777777' } });
    const next = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: OWNER_A, pin: '777777' } });
    assert.equal(next.status, 200);
    assert.equal((await t.request('GET', '/api/me', { token: pinToken })).status, 401);
  });

  it('5 неверных PIN подряд — блок на 15 минут: даже верный PIN получает 429', async () => {
    for (let i = 1; i <= 4; i += 1) {
      const bad = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '0000' } });
      assert.equal(bad.status, 401, `попытка ${i}`);
    }
    const fifth = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '0000' } });
    assert.equal(fifth.status, 401);
    const locked = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(locked.status, 429);
    assert.deepEqual(locked.json, { error: 'rate_limited' });
    const { rows } = await t.admin.query('select pin_locked_until - now() as left from bl.club_members where user_id = $1', [RECEPTION_A]);
    const minutes = rows[0].left.minutes ?? 0;
    assert.ok(minutes >= 14 && minutes <= 15, `блок ${JSON.stringify(rows[0].left)}`);
    // Снять блок (как будто прошло 15 минут) — верный PIN снова работает.
    await t.admin.query("update bl.club_members set pin_locked_until = now() - interval '1 second' where user_id = $1", [RECEPTION_A]);
    assert.equal((await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } })).status, 200);
  });

  it('токен PIN не действует в другом клубе (X-Club-Id чужого клуба — 403)', async () => {
    const res = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } });
    const other = await t.request('GET', '/api/me', { token: res.json.token, headers: { 'x-club-id': 'c9000000-0000-4000-8000-000000000009' } });
    assert.equal(other.status, 403);
  });
});
