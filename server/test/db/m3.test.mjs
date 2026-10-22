// M3 core на временной базе: цепочка уведомлений (T21, порядок каналов, тайм-аут
// подтверждения, действия), утренняя сводка в 10:00 по поясу клуба для двух клубов,
// персонал: пригласить, войти по приглашению, сменить роль, отозвать.
// Telegram и MAX — заглушки (сеть к ним из этой среды закрыта): «проверено на заглушке».

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { appendAudit } from '../../lib/audit.mjs';
import { withContext } from '../../lib/store.mjs';
import { createNotifier, send } from '../../notify/index.mjs';
import { createMaxBot } from '../../notify/max.mjs';
import { localParts, shiftDate, tick } from '../../summaries/index.mjs';
import { CLUB_A, MANAGER_A, OWNER_A, RESOURCE_1, startTestApp } from './helpers.mjs';
import { CLUB_B, OWNER_B, seedClubB } from '../../../supabase/tests/helpers.mjs';

let t;
let owner;

before(async () => {
  t = await startTestApp({ config: { publicHost: 'bl.test' } });
  await seedClubB(t.admin);
  owner = await t.login('+70000000001');
});

after(async () => {
  await t?.stop();
});

const inClub = (fn, clubId = CLUB_A) => withContext(t.pool, { clubId, actorType: 'system' }, fn);
const platform = (fn) => withContext(t.pool, { clubId: null, actorType: 'system' }, fn);

describe('цепочка уведомлений (№110)', () => {
  async function guestWithChannels(phone, { channels_order = null } = {}) {
    const g = await t.login(phone);
    await t.admin.query("update bl.users set telegram_user_id = $2, max_user_id = $3, channels_order = $4 where id = $1", [
      g.user.id,
      Math.floor(Math.random() * 1e9) + 1,
      `m-${g.user.id.slice(0, 8)}`,
      channels_order,
    ]);
    return g;
  }

  const tgCalls = [];
  const telegram = { configured: true, async call(m, p) { tgCalls.push(p); return { ok: true }; } };

  it('T21: MAX не доставил — ушло в запасной канал (Telegram); попытки и итог в notifications', async () => {
    const g = await guestWithChannels('+79990007001', { channels_order: ['max', 'telegram'] });
    const max = { configured: true, async call() { throw Object.assign(new Error('бот недоступен'), { code: 'api_500' }); } };
    const notifier = createNotifier({ config: { vapid: {}, publicHost: 'bl.test' }, log: t.log, telegram, max });
    const res = await inClub((db) => send(db, g.user.id, { kind: 'session.t10', text: 'Стол 4: осталось 10 минут', actions: [{ id: 'extend', title: 'Продлить', url: '/app/s/1' }] }));
    assert.ok(res.notification_id);
    await platform((db) => notifier.deliver({ notification_id: res.notification_id }, { db }));
    const n = (await t.admin.query('select status, channel, attempts from bl.notifications where id = $1', [res.notification_id])).rows[0];
    assert.equal(n.status, 'sent');
    assert.equal(n.channel, 'telegram');
    assert.deepEqual(
      n.attempts.map((a) => `${a.channel}:${a.status}:${a.code ?? ''}`),
      ['max:failed:api_500', 'telegram:sent:'],
    );
    // Действие «Продлить» — кнопка со ссылкой на свой сайт.
    assert.deepEqual(tgCalls.at(-1).reply_markup, { inline_keyboard: [[{ text: 'Продлить', url: 'https://bl.test/app/s/1' }]] });
  });

  it('нет подтверждения от мессенджера за тайм-аут — следующий канал; MAX без документации — сразу следующий', async () => {
    const g = await guestWithChannels('+79990007002', { channels_order: ['max', 'telegram'] });
    const hang = { configured: true, call: () => new Promise(() => {}) };
    const notifier = createNotifier({ config: { vapid: {} }, log: t.log, telegram, max: hang, deliveryTimeoutMs: 100 });
    const a = await inClub((db) => send(db, g.user.id, { kind: 'info', text: 'Проверка' }));
    await platform((db) => notifier.deliver({ notification_id: a.notification_id }, { db }));
    const n = (await t.admin.query('select attempts, channel from bl.notifications where id = $1', [a.notification_id])).rows[0];
    assert.deepEqual(n.attempts.map((x) => `${x.channel}:${x.status}:${x.code ?? ''}`), ['max:failed:timeout', 'telegram:sent:']);
    const plain = createNotifier({ config: { vapid: {} }, log: t.log, telegram, max: createMaxBot({ token: 'x' }) });
    const b = await inClub((db) => send(db, g.user.id, { kind: 'info', text: 'Проверка 2' }));
    await platform((db) => plain.deliver({ notification_id: b.notification_id }, { db }));
    const nb = (await t.admin.query('select attempts from bl.notifications where id = $1', [b.notification_id])).rows[0];
    assert.deepEqual(nb.attempts.map((x) => `${x.channel}:${x.status}:${x.code ?? ''}`), ['max:skipped:not_configured', 'telegram:sent:']);
  });

  it('порядок каналов пользователя: только выбранные; PATCH /api/me channels_order', async () => {
    const g = await guestWithChannels('+79990007003');
    const bad = [['sms'], ['max', 'max'], [], ['max', 'telegram', 'webpush', 'max'], 'max'];
    for (const order of bad) assert.equal((await t.request('PATCH', '/api/me', { token: g.token, body: { channels_order: order } })).status, 400, JSON.stringify(order));
    const res = await t.request('PATCH', '/api/me', { token: g.token, body: { channels_order: ['telegram'], notify_channel: 'telegram' } });
    assert.deepEqual(res.json.user.channels_order, ['telegram']);
    const max = { configured: true, async call() { throw new Error('не должен вызываться'); } };
    const notifier = createNotifier({ config: { vapid: {} }, log: t.log, telegram, max });
    const a = await inClub((db) => send(db, g.user.id, { kind: 'info', text: 'Только Telegram' }));
    await platform((db) => notifier.deliver({ notification_id: a.notification_id }, { db }));
    const n = (await t.admin.query('select attempts from bl.notifications where id = $1', [a.notification_id])).rows[0];
    assert.deepEqual(n.attempts.map((x) => x.channel), ['telegram']);
    assert.equal((await t.request('PATCH', '/api/me', { token: g.token, body: { channels_order: null } })).json.user.channels_order, null);
  });

  it('действия: не больше 5, ссылка — только путь своего сайта', async () => {
    const g = await t.login('+79990007004');
    for (const actions of [[{ id: 'x', title: 'X', url: 'https://evil.example' }], [{ id: 'x', title: 'X', url: '//evil' }], [{ id: 'Bad', title: 'X' }], Array(6).fill({ id: 'a', title: 'A' })]) {
      await assert.rejects(inClub((db) => send(db, g.user.id, { kind: 'info', text: 'x', actions })), /notify\.send/);
    }
    const ok = await inClub((db) => send(db, g.user.id, { kind: 'waitlist.offered', text: 'Стол свободен', actions: [{ id: 'accept', title: 'Принять предложение', url: '/app/w/1' }] }));
    const row = (await t.admin.query('select actions from bl.notifications where id = $1', [ok.notification_id])).rows[0];
    assert.deepEqual(row.actions, [{ id: 'accept', title: 'Принять предложение', url: '/app/w/1' }]);
  });
});

describe('утренняя сводка (№110): 10:00 по времени клуба, два пояса', () => {
  it('Владивосток раньше Екатеринбурга; один раз; выручка, игра, тревоги, ручные действия, хеш головы журнала', async () => {
    // Рабочие сутки клуба A (Екатеринбург), в которых идёт тест (журнал пишет реальное время).
    const real = new Date();
    const lp = localParts(real, 'Asia/Yekaterinburg');
    const day = lp.minutes < 360 ? shiftDate(lp.date, -1) : lp.date;
    const dayStartUtc = new Date(`${day}T01:00:00Z`); // 06:00 по Екатеринбургу (UTC+5)
    const at = (h) => new Date(dayStartUtc.getTime() + h * 3600_000);
    const guest = await t.login('+79990008001');
    await t.admin.query(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks, confirmed_at)
       values ($1, $2, $3, 'start', 'yookassa', 'sbp', 'sum-1', 'sum-k1', 'succeeded', 160000, $4),
              ($1, $2, $3, 'start', 'reception', 'cash', null, 'sum-k2', 'succeeded', 80000, $5),
              ($1, $2, $3, 'start', 'yookassa', 'card', 'sum-3', 'sum-k3', 'succeeded', 50000, $6)`,
      [CLUB_A, RESOURCE_1, guest.user.id, at(2), at(23.5), at(24.5)],
    );
    await t.admin.query(
      `insert into bl.sessions (club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
       values ($1, $2, 'closed', $3, $4, $5, $5, 'expired', $4, $5)`,
      [CLUB_A, RESOURCE_1, guest.user.id, at(3), at(5)],
    );
    await t.admin.query("insert into bl.alarms (club_id, type, level, raised_at, last_raised_at) values ($1, 'bypass_detected', 'critical', $2, $2)", [CLUB_A, at(4)]);
    await inClub((db) => appendAudit(db, { action: 'manual.extend_free', reason: 'гость ждал', data: { minutes: 10 }, actorType: 'user', actorId: MANAGER_A }));

    const next = shiftDate(day, 1);
    const clock1 = { now: () => new Date(`${next}T00:30:00Z`) }; // Владивосток 10:30, Екатеринбург 05:30
    const r1 = await tick({ pool: t.pool, clock: clock1, log: t.log });
    assert.deepEqual(r1.sent, [{ club_id: CLUB_B, day }]);
    const clock2 = { now: () => new Date(`${next}T05:00:00Z`) }; // Екатеринбург 10:00
    const r2 = await tick({ pool: t.pool, clock: clock2, log: t.log });
    assert.deepEqual(r2.sent, [{ club_id: CLUB_A, day }]);
    assert.deepEqual((await tick({ pool: t.pool, clock: clock2, log: t.log })).sent, [], 'второй раз не отправляется');

    const s = (await t.admin.query("select data from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [CLUB_A, day])).rows[0].data;
    assert.deepEqual(s.revenue.by_method, { cash: 80000, card_terminal: 0, sbp: 160000, card: 0 }, 'платёж следующих рабочих суток не вошёл');
    assert.equal(s.revenue.net_kopecks, 240000);
    assert.equal(s.play.minutes, 120);
    assert.equal(s.alarms.critical, 1);
    assert.ok(s.manual_actions.count >= 1);
    const head = (await t.admin.query('select seq, hash from bl.audit_log where club_id = $1 order by seq desc limit 1', [CLUB_A])).rows[0];
    assert.equal(s.journal.head_hash, head.hash);

    const notes = await t.admin.query("select user_id, text from bl.notifications where kind = 'summary.morning' and club_id = $1 order by user_id", [CLUB_A]);
    assert.deepEqual(notes.rows.map((n) => n.user_id).sort(), [OWNER_A, MANAGER_A].sort());
    assert.match(notes.rows[0].text.replace(/[\u00a0\u202f]/g, ' '), /^Сводка за \d+ [а-я]+: выручка 2 400 ₽ \(СБП 1 600 ₽, наличные 800 ₽\); игра 2 ч, загрузка/);
    assert.ok(notes.rows[0].text.includes(head.hash), 'полный хеш головы журнала в тексте, без маскировки цифр');
    const bNotes = await t.admin.query("select user_id from bl.notifications where kind = 'summary.morning' and club_id = $1", [CLUB_B]);
    assert.deepEqual(bNotes.rows.map((n) => n.user_id), [OWNER_B]);
  });
});

describe('персонал (№111)', () => {
  const PHONE = '+79990009001';
  let inviteId;

  it('владелец приглашает по телефону; повтор продлевает; действующий сотрудник — duplicate; не владельцу — 403', async () => {
    const res = await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: PHONE, role: 'reception' } });
    assert.equal(res.status, 201);
    assert.equal(res.json.phone_masked, '+7999***9001');
    const days = (new Date(res.json.expires_at) - Date.now()) / 86400_000;
    assert.ok(days > 6.9 && days <= 7, `срок ${days}`);
    inviteId = res.json.id;
    const again = await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: PHONE, role: 'bar' } });
    assert.equal(again.json.id, inviteId);
    assert.equal(again.json.role, 'bar');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: '+70000000003', role: 'bar' } })).json.error, 'duplicate');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: PHONE, role: 'owner' } })).status, 400);
    const manager = await t.login('+70000000003');
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: manager.token, body: { phone: PHONE, role: 'bar' } })).status, 403);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/staff`, { token: manager.token })).status, 403);
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/staff`, { token: owner.token });
    assert.ok(list.json.invites.some((i) => i.id === inviteId && i.role === 'bar'));
    assert.ok(list.json.staff.some((s) => s.user_id === MANAGER_A && s.role === 'manager' && s.phone_masked === '+7000***0003'));
  });

  it('первый вход с этим номером привязывает приглашение; журнал', async () => {
    const staff = await t.login(PHONE);
    const me = await t.request('GET', '/api/me', { token: staff.token });
    assert.deepEqual(me.json.clubs.map((c) => [c.club_id, c.role]), [[CLUB_A, 'bar']]);
    const actions = (await t.admin.query("select action from bl.audit_log where club_id = $1 and action like 'staff.%' order by seq", [CLUB_A])).rows.map((r) => r.action);
    assert.deepEqual(actions, ['staff.invite', 'staff.invite', 'staff.invite_accepted']);
    const inv = (await t.admin.query('select accepted_user_id from bl.staff_invites where id = $1', [inviteId])).rows[0];
    assert.equal(inv.accepted_user_id, staff.user.id);
    t.staff = staff;
  });

  it('просроченное или отозванное приглашение не привязывается', async () => {
    const r1 = await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: '+79990009002', role: 'reception' } });
    await t.admin.query("update bl.staff_invites set created_at = now() - interval '8 days', expires_at = now() - interval '1 day' where id = $1", [r1.json.id]);
    const r2 = await t.request('POST', `/api/clubs/${CLUB_A}/staff`, { token: owner.token, body: { phone: '+79990009003', role: 'reception' } });
    assert.deepEqual((await t.request('DELETE', `/api/clubs/${CLUB_A}/staff/invites/${r2.json.id}`, { token: owner.token })).json, { ok: true });
    for (const phone of ['+79990009002', '+79990009003']) {
      const u = await t.login(phone);
      assert.deepEqual((await t.request('GET', '/api/me', { token: u.token })).json.clubs, [], phone);
    }
  });

  it('смена роли; владельца и себя — нельзя', async () => {
    const id = t.staff.user.id;
    assert.deepEqual((await t.request('PATCH', `/api/clubs/${CLUB_A}/staff/${id}`, { token: owner.token, body: { role: 'reception' } })).json, { ok: true, user_id: id, role: 'reception' });
    assert.equal((await t.request('PATCH', `/api/clubs/${CLUB_A}/staff/${OWNER_A}`, { token: owner.token, body: { role: 'bar' } })).status, 403);
    assert.equal((await t.request('PATCH', `/api/clubs/${CLUB_A}/staff/${id}`, { token: owner.token, body: { role: 'owner' } })).status, 400);
    assert.equal((await t.request('PATCH', `/api/clubs/${CLUB_A}/staff/${randomUUID()}`, { token: owner.token, body: { role: 'bar' } })).status, 404);
    const row = (await t.admin.query("select data from bl.audit_log where action = 'staff.role' order by seq desc limit 1")).rows[0];
    assert.deepEqual(row.data, { user_id: id, from: 'bar', to: 'reception' });
  });

  it('отзыв в один шаг: членство, PIN и токены (личный и на терминале) погашены', async () => {
    const id = t.staff.user.id;
    await t.request('PUT', '/api/staff/pin', { token: t.staff.token, body: { club_id: CLUB_A, pin: '3141' } });
    const term = await t.request('POST', '/api/staff/terminal', { token: owner.token, body: { club_id: CLUB_A, name: 'Стойка M3' } });
    const pin = await t.request('POST', '/api/staff/pin', { token: term.json.terminal_token, body: { user_id: id, pin: '3141' } });
    assert.equal(pin.status, 200);
    const res = await t.request('DELETE', `/api/clubs/${CLUB_A}/staff/${id}`, { token: owner.token });
    assert.equal(res.status, 200);
    assert.ok(res.json.tokens_revoked >= 2);
    assert.equal((await t.request('GET', '/api/me', { token: t.staff.token })).status, 401);
    assert.equal((await t.request('GET', '/api/me', { token: pin.json.token })).status, 401);
    const m = (await t.admin.query('select active, pin_hash from bl.club_members where user_id = $1', [id])).rows[0];
    assert.deepEqual(m, { active: false, pin_hash: null });
    assert.equal((await t.request('POST', '/api/staff/pin', { token: term.json.terminal_token, body: { user_id: id, pin: '3141' } })).status, 401);
    assert.equal((await t.request('DELETE', `/api/clubs/${CLUB_A}/staff/${OWNER_A}`, { token: owner.token })).status, 403);
    const j = (await t.admin.query("select data from bl.audit_log where action = 'staff.revoke' order by seq desc limit 1")).rows[0];
    assert.equal(j.data.user_id, id);
    // Повторный вход — гость без роли в клубе.
    const back = await t.login(PHONE);
    assert.deepEqual((await t.request('GET', '/api/me', { token: back.token })).json.clubs, []);
  });
});
