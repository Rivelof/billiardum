// Вход (контракт M1 §4) на временной базе: вход для разработки, initData Telegram, вход через
// бота (вебхук на заглушке — сеть к Telegram закрыта), согласие, me, выход, CSRF,
// терминал ресепшена и PIN с блокировкой.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signInitData } from '../../auth/telegram.mjs';
import { tokenHash } from '../../auth/index.mjs';
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
/** Другой код из 6 цифр. */
const wrongCode = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
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
    assert.equal(me.json.user.consent_version, null, '§14: null без согласия');
    assert.equal(me.json.user.name, null);
    assert.equal((await t.request('POST', '/api/auth/consent', { token, body: { version: 'old' } })).status, 400);
    assert.deepEqual((await t.request('POST', '/api/auth/consent', { token, body: { version: '2026-10-21' } })).json, { ok: true });
    me = await t.request('GET', '/api/me', { token });
    assert.equal(me.json.user.consent.accepted, true);
    assert.equal(me.json.user.consent_version, '2026-10-21');
    const out = await t.request('POST', '/api/auth/logout', { token });
    assert.deepEqual(out.json, { ok: true });
    assert.match(out.headers.getSetCookie()[0], /bl_session=; Path=\/api; Max-Age=0/);
    assert.equal((await t.request('GET', '/api/me', { token })).status, 401);
  });

  it('персонал при входе получает клубы с ролью и запись auth.staff_login в журнале клуба', async () => {
    const { token } = await t.login('+70000000003');
    const me = await t.request('GET', '/api/me', { token });
    assert.deepEqual(me.json.clubs, [{ club_id: CLUB_A, role: 'manager', name: 'Тестовый клуб', timezone: 'Asia/Yekaterinburg' }]);
    assert.equal(me.json.user.name, 'Управляющий (тест)');
    assert.equal(me.json.user.phone_masked, '+7000***0003');
    const { rows } = await t.admin.query("select actor_id, data from bl.audit_log where club_id = $1 and action = 'auth.staff_login' and actor_id = $2", [
      CLUB_A,
      MANAGER_A,
    ]);
    assert.ok(rows.length >= 1);
    assert.deepEqual(rows.at(-1).data, { via: 'dev' });
  });

  it('PATCH /api/me: своё имя и канал уведомлений; неверные значения — 400', async () => {
    const { token, user } = await t.login('+79990000006');
    const res = await t.request('PATCH', '/api/me', { token, body: { name: '  Ольга  ', notify_channel: 'telegram' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.user.name, 'Ольга');
    assert.equal(res.json.user.notify_channel, 'telegram');
    // Каналы, не настроенные на сервере (MAX — заглушка, Web Push без VAPID), не принимаются (№130).
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(101) }, { name: 'a\u0007b' }, { notify_channel: 'sms' }, { notify_channel: 'max' }, { notify_channel: 'webpush' }]) {
      assert.equal((await t.request('PATCH', '/api/me', { token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await t.request('PATCH', '/api/me', { token, body: { name: null } })).json.user.name, null);
    const row = (await t.admin.query('select phone from bl.users where id = $1', [user.id])).rows[0];
    assert.equal(row.phone, '+79990000006', 'телефон не меняется');
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

    assert.match(created.json.code, /^\d{6}$/);

    botCalls.length = 0;
    assert.equal((await webhook(message(7001, { text: `/start ${nonce}` }))).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(botCalls.length, 1);
    assert.match(botCalls[0].params.text, /код из 6 цифр с экрана/);
    // Контакт до кода вход не завершает.
    await webhook(message(7001, { contact: { phone_number: '79991112233', user_id: 7001 } }));
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${nonce}`, { cookie: browser })).json, { status: 'pending' });
    botCalls.length = 0;
    await webhook(message(7001, { text: wrongCode(created.json.code) }));
    await webhook(message(7001, { text: `${created.json.code.slice(0, 3)} ${created.json.code.slice(3)}` }));
    await new Promise((r) => setTimeout(r, 50));
    assert.match(botCalls[0].params.text, /не совпал/);
    // Телефон уже сохранён контактом выше — после верного кода вход сразу.
    assert.match(botCalls[1].params.text, /Готово, вы вошли/);
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
    // В бот — «вход на новом устройстве» с кнопкой «Выйти везде»; кнопка отзывает все входы.
    await new Promise((r) => setTimeout(r, 50));
    const notice = botCalls.find((c) => /новом устройстве/.test(c.params.text ?? ''));
    assert.equal(notice.params.chat_id, 7001);
    assert.equal(notice.params.reply_markup.inline_keyboard[0][0].callback_data, 'logout_all');
    botCalls.length = 0;
    await webhook({ update_id: updateId++, callback_query: { id: 'cb1', from: { id: 7001, is_bot: false }, data: 'logout_all', message: { chat: { id: 7001 } } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(botCalls.map((c) => c.method), ['answerCallbackQuery', 'sendMessage']);
    assert.equal(botCalls[0].params.callback_query_id, 'cb1');
    assert.equal((await t.request('GET', '/api/me', { token: done.json.token })).status, 401);
    // nonce в базе только хешем.
    const { rows } = await t.admin.query('select count(*)::int as n from bl.bot_link_nonces where nonce_hash = $1', [nonce]);
    assert.equal(rows[0].n, 0);
  });

  it('новый гость: код → контакт (только свой) → вход', async () => {
    const c = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    const browser = cookieOf(c, 'bl_link');
    await webhook(message(7011, { text: `/start ${c.json.nonce}` }));
    botCalls.length = 0;
    await webhook(message(7011, { text: c.json.code }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(botCalls[0].params.reply_markup.keyboard[0][0].request_contact, true);
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${c.json.nonce}`, { cookie: browser })).json, { status: 'pending' });
    // Чужой контакт не принимается.
    await webhook(message(7011, { contact: { phone_number: '79991112244', user_id: 7012 } }));
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${c.json.nonce}`, { cookie: browser })).json, { status: 'pending' });
    await webhook(message(7011, { contact: { phone_number: '79991112244', user_id: 7011 } }));
    const done = await t.request('GET', `/api/auth/bot-link/${c.json.nonce}`, { cookie: browser });
    assert.equal(done.json.user.phone_masked, '+7999***2244');
  });

  it('чужая ссылка (фишинг): известный телефон жертвы без кода с экрана не входит; 3 неверных кода — вход отменён', async () => {
    // Жертва уже с телефоном (Telegram 7300 ↔ +79991113300).
    const v = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    await webhook(message(7300, { text: `/start ${v.json.nonce}` }));
    await webhook(message(7300, { text: v.json.code }));
    await webhook(message(7300, { contact: { phone_number: '+79991113300', user_id: 7300 } }));
    assert.equal((await t.request('GET', `/api/auth/bot-link/${v.json.nonce}`, { cookie: cookieOf(v, 'bl_link') })).json.status, 'done');

    // Злоумышленник создаёт nonce у себя и шлёт жертве ссылку; жертва жмёт Start.
    const evil = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null });
    const evilBrowser = cookieOf(evil, 'bl_link');
    botCalls.length = 0;
    await webhook(message(7300, { text: `/start ${evil.json.nonce}` }));
    await new Promise((r) => setTimeout(r, 50));
    assert.match(botCalls[0].params.text, /Если вы не начинали вход — ничего не отправляйте/);
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${evil.json.nonce}`, { cookie: evilBrowser })).json, { status: 'pending' }, 'без кода не входит');
    // Чужой Telegram не перехватывает уже привязанный nonce.
    await webhook(message(7301, { text: `/start ${evil.json.nonce}` }));
    const row = (await t.admin.query('select external_user_id from bl.bot_link_nonces where nonce_hash = $1', [tokenHash(evil.json.nonce)])).rows[0];
    assert.equal(row.external_user_id, '7300');
    // Жертва угадывает код: три неверных — вход отменён, верный после этого не помогает.
    for (let i = 0; i < 3; i += 1) await webhook(message(7300, { text: wrongCode(evil.json.code) }));
    await webhook(message(7300, { text: evil.json.code }));
    assert.deepEqual((await t.request('GET', `/api/auth/bot-link/${evil.json.nonce}`, { cookie: evilBrowser })).json, { status: 'expired' });
    const st = (await t.admin.query('select status, user_id, confirmed_at from bl.bot_link_nonces where nonce_hash = $1', [tokenHash(evil.json.nonce)])).rows[0];
    assert.deepEqual(st, { status: 'failed', user_id: null, confirmed_at: null });
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
    await webhook(message(7100, { text: created.json.code }));
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
    await webhook(message(7200, { text: created.json.code }));
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
    assert.deepEqual(rec, { user_id: RECEPTION_A, name: 'Ресепшн (тест)', role: 'reception', phone_masked: '+7000***0004', pin_set: true });
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

  it('бармен (роль bar, №97): /api/me, свой PIN, вход по PIN на терминале', async () => {
    const BAR = 'a1000000-0000-4000-8000-000000000005';
    await t.admin.query("insert into bl.users (id, phone, name) values ($1, '+70000000005', 'Бармен (тест)') on conflict do nothing", [BAR]);
    await t.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar') on conflict do nothing", [CLUB_A, BAR]);
    const bar = await t.login('+70000000005');
    const me = await t.request('GET', '/api/me', { token: bar.token });
    assert.deepEqual(me.json.clubs.map((c) => c.role), ['bar']);
    assert.deepEqual((await t.request('PUT', '/api/staff/pin', { token: bar.token, body: { club_id: CLUB_A, pin: '2580' } })).json, { ok: true });
    const info = await t.request('GET', '/api/staff/terminal', { token: terminalToken });
    assert.ok(info.json.staff.some((s) => s.user_id === BAR && s.role === 'bar'));
    const sw = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: BAR, pin: '2580' } });
    assert.equal(sw.status, 200);
    assert.equal(sw.json.role, 'bar');
    // Бармену закрыты маршруты владельца.
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/now`, { token: bar.token })).status, 403);
    const { rows } = await t.admin.query("select count(*)::int as n from bl.audit_log where action = 'auth.staff_login' and actor_id = $1", [BAR]);
    assert.equal(rows[0].n, 1, 'вход бармена — в журнале клуба');
  });

  it('checkStaffPin (№95): одобрение PIN управляющего без смены пользователя; блок общий со сменой по PIN', async () => {
    const { checkStaffPin } = await import('../../auth/index.mjs');
    const manager = await t.login('+70000000003');
    await t.request('PUT', '/api/staff/pin', { token: manager.token, body: { club_id: CLUB_A, pin: '135790' } });
    const base = { pool: t.pool, clubId: CLUB_A, pepper: t.config.pinPepper, roles: ['owner', 'manager'] };
    assert.deepEqual(await checkStaffPin({ ...base, userId: MANAGER_A, pin: '135790' }), { ok: true, role: 'manager' });
    // Ресепшн не одобряет скидки: forbidden без проверки и счёта PIN.
    assert.deepEqual(await checkStaffPin({ ...base, userId: RECEPTION_A, pin: '4821' }), { ok: false, code: 'forbidden' });
    assert.deepEqual(await checkStaffPin({ ...base, userId: MANAGER_A, pin: '12' }), { ok: false, code: 'bad_request' });
    // Ошибки считаются, даже если транзакция вызывающего откатывается.
    const { withContext } = await import('../../lib/store.mjs');
    for (let i = 1; i <= 4; i += 1) {
      await assert.rejects(
        withContext(t.pool, { clubId: CLUB_A, actorType: 'user' }, async () => {
          const r = await checkStaffPin({ ...base, userId: MANAGER_A, pin: '000000' });
          assert.deepEqual(r, { ok: false, code: 'unauthorized', locked: false });
          throw new Error('откат вызывающего');
        }),
      );
    }
    assert.equal((await t.admin.query('select pin_failed_count from bl.club_members where user_id = $1', [MANAGER_A])).rows[0].pin_failed_count, 4);
    assert.deepEqual(await checkStaffPin({ ...base, userId: MANAGER_A, pin: '000000' }), { ok: false, code: 'unauthorized', locked: true });
    const locked = await checkStaffPin({ ...base, userId: MANAGER_A, pin: '135790' });
    assert.equal(locked.code, 'rate_limited');
    assert.ok(locked.retryAfterSec > 14 * 60 && locked.retryAfterSec <= 15 * 60);
    // Тот же блок — у смены сотрудника на терминале.
    assert.equal((await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: MANAGER_A, pin: '135790' } })).status, 429);
    await t.admin.query("update bl.club_members set pin_locked_until = now() - interval '1 second' where user_id = $1", [MANAGER_A]);
    assert.equal((await checkStaffPin({ ...base, userId: MANAGER_A, pin: '135790' })).ok, true);
    assert.equal((await t.admin.query('select pin_failed_count from bl.club_members where user_id = $1', [MANAGER_A])).rows[0].pin_failed_count, 0);
  });

  it('токен PIN не действует в другом клубе (X-Club-Id чужого клуба — 403)', async () => {
    const res = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } });
    const other = await t.request('GET', '/api/me', { token: res.json.token, headers: { 'x-club-id': 'c9000000-0000-4000-8000-000000000009' } });
    assert.equal(other.status, 403);
  });

  it('PIN владельца и управляющего — 6 цифр; старый короткий — вход с просьбой сменить', async () => {
    const owner = await t.login('+70000000001');
    assert.equal((await t.request('PUT', '/api/staff/pin', { token: owner.token, body: { club_id: CLUB_A, pin: '2468' } })).status, 400);
    assert.equal((await t.request('PUT', '/api/staff/pin', { token: owner.token, body: { club_id: CLUB_A, pin: '24680' } })).status, 400);
    // Ресепшну 4 цифры можно.
    const reception = await t.login('+70000000004');
    assert.equal((await t.request('PUT', '/api/staff/pin', { token: reception.token, body: { club_id: CLUB_A, pin: '4821' } })).status, 200);
    // Короткий PIN, заданный до правила: вход по нему — с pin_change_required.
    const { hashPin } = await import('../../auth/pin.mjs');
    await t.admin.query('update bl.club_members set pin_hash = $2, pin_failed_count = 0, pin_locked_until = null where club_id = $3 and user_id = $1', [
      MANAGER_A,
      await hashPin('2468', t.config.pinPepper),
      CLUB_A,
    ]);
    const sw = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: MANAGER_A, pin: '2468' } });
    assert.equal(sw.status, 200);
    assert.equal(sw.json.pin_change_required, true);
    const rec = await t.request('POST', '/api/staff/pin', { token: terminalToken, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(rec.json.pin_change_required, undefined);
  });

  it('терминалы: 10 неверных PIN за час — терминал заблокирован (тревога), владелец видит, разблокирует и отзывает', async () => {
    const manager = await t.login('+70000000003');
    const owner = await t.login('+70000000001');
    const reg = await t.request('POST', '/api/staff/terminal', { token: manager.token, body: { club_id: CLUB_A, name: 'Стойка 2' } });
    const term = reg.json.terminal_token;
    const termId = reg.json.terminal_id;
    // Перебор по разным сотрудникам: личный блок (5) не наступает, общий счётчик терминала — да.
    t.app.router.rateLimiter.clear(); // лимит маршрута по IP — не предмет этой проверки
    const targets = [RECEPTION_A, MANAGER_A, OWNER_A];
    for (let i = 0; i < 10; i += 1) {
      const r = await t.request('POST', '/api/staff/pin', { token: term, body: { user_id: targets[i % 3], pin: '999999' } });
      assert.equal(r.status, 401, `попытка ${i + 1}`);
    }
    const blocked = await t.request('POST', '/api/staff/pin', { token: term, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(blocked.status, 429);
    const alarm = await t.admin.query("select level, data from bl.alarms where club_id = $1 and type = 'terminal_locked'", [CLUB_A]);
    assert.equal(alarm.rows.length, 1);
    assert.equal(alarm.rows[0].level, 'critical');
    assert.equal(alarm.rows[0].data.terminal_id, termId);
    // Список — только владельцу.
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/terminals`, { token: manager.token })).status, 403);
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/terminals`, { token: owner.token });
    const row = list.json.find((x) => x.id === termId);
    assert.ok(row.locked_at);
    assert.equal(row.revoked_at, null);
    assert.equal(row.created_by.user_id, MANAGER_A);
    assert.ok(!JSON.stringify(list.json).includes('token'), 'без токенов и хешей');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/terminals/${termId}/unlock`, { token: owner.token, body: {} })).status, 200);
    const ok = await t.request('POST', '/api/staff/pin', { token: term, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(ok.status, 200);
    const pinToken = ok.json.token;

    // Поток SSE по токену PIN: перепроверка через bl.auth_resolve закрывает его после отзыва терминала.
    let captured = null;
    const original = t.sse.attach;
    t.sse.attach = (res, opts) => {
      captured = opts;
      res.writeHead(200);
      res.end();
      return { ok: true };
    };
    try {
      await t.request('GET', `/api/stream?club=${CLUB_A}`, { token: pinToken });
    } finally {
      t.sse.attach = original;
    }
    assert.equal(await captured.revalidate(), true);

    // Отзыв: токен терминала и PIN-токены на нём больше не действуют.
    assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/${termId}`, { token: manager.token })).status, 403);
    assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/${termId}`, { token: owner.token })).status, 200);
    assert.equal(await captured.revalidate(), false);
    assert.equal((await t.request('GET', '/api/staff/terminal', { token: term })).status, 401);
    assert.equal((await t.request('GET', '/api/me', { token: pinToken })).status, 401);
    const after = await t.request('GET', `/api/clubs/${CLUB_A}/terminals`, { token: owner.token });
    assert.ok(after.json.find((x) => x.id === termId).revoked_at);
    assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/c9000000-0000-4000-8000-000000000009`, { token: owner.token })).status, 404);
  });
});
