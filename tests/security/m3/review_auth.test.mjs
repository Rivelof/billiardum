// Перепроверка ревью бэкенда: вход через бота с кодом с экрана (0704, server/auth/botlink.mjs)
// и терминалы (0706: блокировка после 10 PIN, отзыв, разблокировка, staff_revoke).
// Атаки: подделка вебхука, перебор и гонка кода, повтор nonce, чужой Telegram, «Выйти везде»
// с чужими данными; эскалация на терминалах, отзыв не гасит, обход блокировки.
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/review_auth.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { tokenHash } from '../../../server/auth/index.mjs';
import { CLUB_A, OWNER_A, RECEPTION_A, MANAGER_A, startTestApp } from '../../../server/test/db/helpers.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;
const BOT_TOKEN = '123456789:PENTEST-token-for-tests_only';
const SECRET = 'pentest-webhook-secret-0123456789';
let t;
const botCalls = [];
let updateId = 1000;

const cookieOf = (res, name) => res.headers.getSetCookie().find((x) => x.startsWith(`${name}=`))?.split(';')[0] ?? null;
const webhook = (update, secret = SECRET) =>
  t.request('POST', '/api/bots/telegram/webhook', { body: update, origin: null, headers: secret ? { 'x-telegram-bot-api-secret-token': secret } : {} });
const message = (from, extra) => ({ update_id: updateId++, message: { message_id: updateId, from: { id: from, is_bot: false, first_name: 'Т' }, chat: { id: from, type: 'private' }, date: 1, ...extra } });
const wrong = (code, k = 1) => String((Number(code) + k) % 1_000_000).padStart(6, '0');
const newLink = async () => {
  const r = await t.request('POST', '/api/auth/bot-link', { body: { channel: 'telegram' }, origin: null, headers: { 'x-forwarded-for': `10.9.${updateId % 250}.${(updateId * 7) % 250}` } });
  assert.equal(r.status, 200, r.text);
  return { nonce: r.json.nonce, code: r.json.code, browser: cookieOf(r, 'bl_link') };
};
const poll = (l) => t.request('GET', `/api/auth/bot-link/${l.nonce}`, { cookie: l.browser });
const nonceRow = async (l) => (await t.admin.query('select * from bl.bot_link_nonces where nonce_hash = $1', [tokenHash(l.nonce)])).rows[0];

/** Гость с телефоном через бота (tg → телефон), возвращает токен входа. */
async function botUser(tg, phone) {
  const l = await newLink();
  await webhook(message(tg, { text: `/start ${l.nonce}` }));
  await webhook(message(tg, { text: l.code }));
  await webhook(message(tg, { contact: { phone_number: phone, user_id: tg } }));
  const done = await poll(l);
  assert.equal(done.json.status, 'done', JSON.stringify(done.json));
  return done.json.token;
}

describe('ревью входа: бот и терминалы', { skip }, () => {
  before(async () => {
    t = await startTestApp({
      config: { telegram: { botToken: BOT_TOKEN, botUsername: 'bl_pentest_bot', webhookSecret: SECRET, proxyUrl: null } },
      telegram: { configured: true, async call(method, params) { botCalls.push({ method, params }); return { ok: true }; } },
    });
  });
  after(async () => {
    await t?.stop();
  });

  it('вебхук без секрета или с чужим секретом — 401, состояние nonce не меняется', async () => {
    const l = await newLink();
    for (const s of [null, 'x', `${SECRET}x`, SECRET.slice(0, -1)]) {
      const r = await webhook(message(8101, { text: `/start ${l.nonce}` }), s);
      assert.equal(r.status, 401, String(s));
    }
    assert.equal((await nonceRow(l)).status, 'pending');
  });

  it('гонка: 12 параллельных неверных кодов — не больше 3 попыток засчитано, nonce failed, верный код после этого не входит', async () => {
    const l = await newLink();
    await webhook(message(8102, { text: `/start ${l.nonce}` }));
    await Promise.all(Array.from({ length: 12 }, (_, i) => webhook(message(8102, { text: wrong(l.code, i + 1) }))));
    const row = await nonceRow(l);
    assert.equal(row.status, 'failed');
    assert.ok(row.code_attempts <= 3, `попыток ${row.code_attempts}`);
    await webhook(message(8102, { text: l.code }));
    assert.equal((await nonceRow(l)).confirmed_at, null);
    assert.equal((await poll(l)).json.status, 'expired');
    // Повторный /start проваленного nonce не возвращает его в игру (и не сбрасывает попытки).
    await webhook(message(8102, { text: `/start ${l.nonce}` }));
    const again = await nonceRow(l);
    assert.deepEqual([again.status, again.code_attempts <= 3], ['failed', true]);
  });

  it('код из чужого Telegram не подтверждает nonce: код применяется только к nonce, привязанному к отправителю', async () => {
    const l = await newLink();
    await webhook(message(8103, { text: `/start ${l.nonce}` }));
    // Злоумышленник (8104) знает код (например, подсмотрел), но nonce привязан к 8103.
    await webhook(message(8104, { text: l.code }));
    const row = await nonceRow(l);
    assert.equal(row.confirmed_at, null);
    assert.equal(row.external_user_id, '8103');
    // 8104 не может перепривязать nonce к себе.
    await webhook(message(8104, { text: `/start ${l.nonce}` }));
    assert.equal((await nonceRow(l)).external_user_id, '8103');
  });

  it('nonce, уже выданный токеном (consumed), повторно не выдаёт токен и не перепривязывается', async () => {
    const l = await newLink();
    await webhook(message(8105, { text: `/start ${l.nonce}` }));
    await webhook(message(8105, { text: l.code }));
    await webhook(message(8105, { contact: { phone_number: '+79991118105', user_id: 8105 } }));
    const first = await poll(l);
    assert.ok(first.json.token);
    const second = await poll(l);
    assert.deepEqual(second.json, { status: 'done' }, 'токена второй раз нет');
    await webhook(message(8106, { text: `/start ${l.nonce}` }));
    assert.equal((await nonceRow(l)).status, 'consumed');
  });

  it('код без Start, Start с мусором, код у истёкшего nonce — вход не завершается', async () => {
    const l = await newLink();
    await webhook(message(8107, { text: l.code })); // кода ждать нечему
    assert.equal((await nonceRow(l)).confirmed_at, null);
    await t.admin.query("update bl.bot_link_nonces set created_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' where nonce_hash = $1", [tokenHash(l.nonce)]);
    await webhook(message(8107, { text: `/start ${l.nonce}` }));
    await webhook(message(8107, { text: l.code }));
    assert.equal((await nonceRow(l)).confirmed_at, null);
    assert.equal((await poll(l)).json.status, 'expired');
  });

  it('«Выйти везде»: отзываются токены только того, кто нажал (from.id); данные кнопки не выбирают жертву', async () => {
    const victim = await botUser(8201, '+79991118201');
    const attackerToken = await botUser(8202, '+79991118202');
    // Атакующий жмёт кнопку с подставленными данными и чужим чатом.
    for (const data of ['logout_all', `logout_all:${8201}`, 'logout_all 8201']) {
      await webhook({ update_id: updateId++, callback_query: { id: `cb-${data}`, from: { id: 8202, is_bot: false }, data, message: { chat: { id: 8201 } } } });
    }
    assert.equal((await t.request('GET', '/api/me', { token: victim })).status, 200, 'жертва осталась в системе');
    assert.equal((await t.request('GET', '/api/me', { token: attackerToken })).status, 401, 'вышел только нажавший');
    // Кнопка от бота (is_bot) игнорируется.
    await webhook({ update_id: updateId++, callback_query: { id: 'cb-bot', from: { id: 8201, is_bot: true }, data: 'logout_all' } });
    assert.equal((await t.request('GET', '/api/me', { token: victim })).status, 200);
  });

  // ── терминалы ─────────────────────────────────────────────────────────────────────────────

  let terminal;
  let terminalId;
  it('подготовка: терминал, PIN ресепшена', async () => {
    const manager = await t.login('+70000000003');
    const reg = await t.request('POST', '/api/staff/terminal', { token: manager.token, body: { club_id: CLUB_A, name: 'Пентест' } });
    assert.equal(reg.status, 200, reg.text);
    terminal = reg.json.terminal_token;
    terminalId = reg.json.terminal_id;
    const reception = await t.login('+70000000004');
    assert.equal((await t.request('PUT', '/api/staff/pin', { token: reception.token, body: { club_id: CLUB_A, pin: '4821' } })).status, 200);
  });

  it('управляющий и ресепшн не видят, не отзывают и не разблокируют терминалы (только владелец)', async () => {
    for (const phone of ['+70000000003', '+70000000004']) {
      const u = await t.login(phone);
      assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/terminals`, { token: u.token })).status, 403);
      assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/${terminalId}`, { token: u.token })).status, 403);
      assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/terminals/${terminalId}/unlock`, { token: u.token })).status, 403);
    }
  });

  it('гонка: неверные PIN пачками по 4 параллельно разным сотрудникам — терминал заблокирован, затем и верный PIN 429', async () => {
    const targets = [RECEPTION_A, MANAGER_A, OWNER_A, randomUUID()];
    for (let b = 0; b < 4; b += 1) {
      await Promise.all(targets.map((u, i) =>
        t.request('POST', '/api/staff/pin', { token: terminal, body: { user_id: u, pin: '0000' }, headers: { 'x-forwarded-for': `10.7.${b}.${i + 1}` } })));
    }
    const row = (await t.admin.query('select locked_at, pin_failed_count from bl.staff_terminals where id = $1', [terminalId])).rows[0];
    assert.ok(row.locked_at, `терминал заблокирован (ошибок ${row.pin_failed_count})`);
    await t.admin.query('update bl.club_members set pin_locked_until = null, pin_failed_count = 0 where club_id = $1', [CLUB_A]);
    const ok = await t.request('POST', '/api/staff/pin', { token: terminal, body: { user_id: RECEPTION_A, pin: '4821' }, headers: { 'x-forwarded-for': '10.7.9.9' } });
    assert.equal(ok.status, 429, 'верный PIN на заблокированном терминале не проходит');
    const alarms = (await t.admin.query("select count(*)::int n from bl.alarms where type = 'terminal_locked' and club_id = $1", [CLUB_A])).rows[0].n;
    assert.equal(alarms, 1, 'одна тревога terminal_locked');
  });

  it('владелец разблокирует; отзыв терминала гасит и его токен, и PIN-токены на нём; чужой клуб — 404', async () => {
    const owner = await t.login('+70000000001');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/terminals/${terminalId}/unlock`, { token: owner.token })).status, 200);
    const sw = await t.request('POST', '/api/staff/pin', { token: terminal, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(sw.status, 200, sw.text);
    const pinToken = sw.json.token;
    const ownerB = await t.login('+70000000002');
    assert.notEqual((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/${terminalId}`, { token: ownerB.token })).status, 200, 'владелец другого клуба');
    assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/terminals/${terminalId}`, { token: owner.token })).status, 200);
    assert.equal((await t.request('GET', '/api/me', { token: pinToken })).status, 401, 'PIN-токен на отозванном терминале погашен');
    assert.equal((await t.request('GET', '/api/staff/terminal', { token: terminal })).status, 401, 'токен терминала погашен');
    // Разблокировать отозванный терминал нельзя.
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/terminals/${terminalId}/unlock`, { token: owner.token })).status, 404);
  });

  it('staff_revoke: PIN-токены клуба гаснут; личный токен остаётся, если есть другое членство, — но в отозванном клубе ролей нет', async () => {
    // Ресепшн A — ещё и бармен во втором клубе (создаём минимально, без seedClubB, чтобы не
    // зависеть от телефонов сид-пользователей клуба B).
    const CLUB_B = 'c2000000-0000-4000-8000-000000000002';
    await t.admin.query("insert into bl.clubs (id, name, city, timezone) values ($1, 'Клуб B (пентест)', 'Москва', 'Europe/Moscow') on conflict (id) do nothing", [CLUB_B]);
    await t.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar') on conflict do nothing", [CLUB_B, RECEPTION_A]);
    const manager = await t.login('+70000000003');
    const reg = await t.request('POST', '/api/staff/terminal', { token: manager.token, body: { club_id: CLUB_A, name: 'Пентест 2' } });
    const sw = await t.request('POST', '/api/staff/pin', { token: reg.json.terminal_token, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.equal(sw.status, 200, sw.text);
    const personal = (await t.login('+70000000004')).token;
    const owner = await t.login('+70000000001');
    const rv = await t.request('DELETE', `/api/clubs/${CLUB_A}/staff/${RECEPTION_A}`, { token: owner.token });
    assert.equal(rv.status, 200, rv.text);
    assert.equal((await t.request('GET', '/api/me', { token: sw.json.token })).status, 401, 'PIN-токен клуба погашен');
    const me = await t.request('GET', '/api/me', { token: personal });
    assert.equal(me.status, 200, 'личный вход в другом клубе сохранён');
    assert.ok(!me.json.clubs.some((c) => c.id === CLUB_A || c.club_id === CLUB_A), `ролей в клубе A нет: ${JSON.stringify(me.json.clubs)}`);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/bookings`, { token: personal, headers: { 'x-club-id': CLUB_A } })).status >= 400, true);
    // Повторный PIN этого сотрудника на терминале клуба A невозможен (PIN стёрт, членство погашено).
    const again = await t.request('POST', '/api/staff/pin', { token: reg.json.terminal_token, body: { user_id: RECEPTION_A, pin: '4821' } });
    assert.ok([401, 403, 429].includes(again.status), String(again.status));
  });
});
