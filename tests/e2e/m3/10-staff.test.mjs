// Персонал (контракт M3 §1 п. 9; decisions №99, №111). Только владелец.
//
// 1. Не владелец (управляющий, ресепшн) — 403 на список, приглашение, смену роли и отзыв.
// 2. Владелец приглашает новый номер с ролью reception: приглашение на 7 дней, телефон маской;
//    неверная роль — 400, уже сотрудник — 409 duplicate. Журнал staff.invite.
// 3. Приглашённый входит этим номером — получает роль (GET /api/me), журнал staff.invite_accepted;
//    работает как ресепшн; задаёт PIN; входит по PIN на терминале клуба.
// 4. Смена роли — staff.role. Отзыв в один шаг: личный токен и токен PIN сразу 401, вход по PIN —
//    401, после нового входа роли нет; журнал staff.revoke с числом погашенных токенов.
//    Себя и владельца отозвать нельзя.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, auditOf, CLUB_A, guestPhone, login, ok, OWNER_ID, staff } from './helpers.mjs';

let db;
let owner;
let man;
let rec;
const phone = guestPhone();
let invite;
let worker;
let pinToken;
let terminal;

before(async () => {
  db = await adminClient();
  owner = await staff('owner');
  man = await staff('manager');
  rec = await staff('reception');
});

after(async () => {
  await db?.end();
});

const STAFF = `/api/clubs/${CLUB_A}/staff`;

test('не владелец не управляет персоналом (403)', async (t) => {
  const res = [];
  for (const [who, tok] of [['управляющий', man.token], ['ресепшн', rec.token]]) {
    const l = await api('GET', STAFF, { token: tok });
    const p = await api('POST', STAFF, { token: tok, body: { phone, role: 'reception' } });
    const r = await api('PATCH', `${STAFF}/a1000000-0000-4000-8000-000000000004`, { token: tok, body: { role: 'bar' } });
    const d = await api('DELETE', `${STAFF}/a1000000-0000-4000-8000-000000000004`, { token: tok });
    res.push(`${who}: ${l.status}/${p.status}/${r.status}/${d.status}`);
    for (const x of [l, p, r, d]) assert.equal(x.status, 403, `${who}: ${x.status} ${x.text}`);
  }
  t.diagnostic(`список/приглашение/роль/отзыв: ${res.join('; ')}`);
});

test('владелец приглашает по телефону с ролью, приглашённый входит и получает роль', async (t) => {
  const bad = await api('POST', STAFF, { token: owner.token, body: { phone, role: 'owner' } });
  const dup = await api('POST', STAFF, { token: owner.token, body: { phone: '+70000000004', role: 'reception' } });
  t.diagnostic(`роль owner: ${bad.status} ${bad.text}; уже сотрудник: ${dup.status} ${dup.text}`);
  assert.equal(bad.status, 400);
  assert.equal(dup.status, 409);
  const r = await api('POST', STAFF, { token: owner.token, body: { phone, role: 'reception' } });
  assert.ok([200, 201].includes(r.status), r.text);
  invite = r.json;
  const ttl = new Date(invite.expires_at) - new Date(invite.created_at);
  t.diagnostic(`приглашение: ${JSON.stringify(invite)}; срок ${ttl / 86_400_000} дн.`);
  assert.equal(invite.role, 'reception');
  assert.equal(ttl, 7 * 86_400_000);
  assert.ok(!r.text.includes(phone.slice(2)), 'телефон только маской');
  const list = await ok(api('GET', STAFF, { token: owner.token }));
  assert.ok(list.invites.some((i) => i.id === invite.id));

  worker = await login(phone, { consent: false });
  const me = await ok(api('GET', '/api/me', { token: worker.token }));
  const role = me.clubs.find((c) => c.club_id === CLUB_A)?.role;
  t.diagnostic(`приглашённый вошёл: клубы ${JSON.stringify(me.clubs.map((c) => [c.name, c.role]))}`);
  assert.equal(role, 'reception');
  const work = await api('GET', `/api/clubs/${CLUB_A}/bookings`, { token: worker.token });
  assert.equal(work.status, 200, 'работает как ресепшн');
  const au = (await auditOf(db, invite.id)).map((a) => a.action);
  t.diagnostic(`журнал приглашения: ${au.join(', ')}`);
  assert.ok(au.includes('staff.invite'));
  assert.ok(au.includes('staff.invite_accepted'));
  const after1 = await ok(api('GET', STAFF, { token: owner.token }));
  assert.ok(!after1.invites.some((i) => i.id === invite.id), 'приглашение привязано');
  assert.ok(after1.staff.some((s) => s.user_id === worker.user.id && s.role === 'reception' && s.active));
});

test('PIN на терминале, смена роли, отзыв: токены и PIN сразу не работают', async (t) => {
  assert.ok(worker);
  await ok(api('PUT', '/api/staff/pin', { token: worker.token, body: { club_id: CLUB_A, pin: '4321' } }));
  terminal = await ok(api('POST', '/api/staff/terminal', { token: owner.token, body: { club_id: CLUB_A, name: 'Терминал e2e M3' } }));
  const sw = await ok(api('POST', '/api/staff/pin', { token: terminal.terminal_token, body: { user_id: worker.user.id, pin: '4321' } }));
  pinToken = sw.token;
  const byPin = await api('GET', `/api/clubs/${CLUB_A}/bookings`, { token: pinToken });
  t.diagnostic(`вход по PIN: роль ${sw.role}; работа по PIN ${byPin.status}`);
  assert.equal(byPin.status, 200);

  const role = await ok(api('PATCH', `${STAFF}/${worker.user.id}`, { token: owner.token, body: { role: 'bar' } }));
  assert.equal(role.role, 'bar');
  const asBar = await api('GET', `/api/clubs/${CLUB_A}/bookings`, { token: worker.token });
  t.diagnostic(`роль → bar: брони клуба ${asBar.status}`);
  assert.equal(asBar.status, 403, 'новая роль действует сразу');

  const self = await api('DELETE', `${STAFF}/${OWNER_ID}`, { token: owner.token });
  t.diagnostic(`владелец отзывает себя: ${self.status} ${self.text}`);
  assert.equal(self.status, 403);
  const rv = await ok(api('DELETE', `${STAFF}/${worker.user.id}`, { token: owner.token }));
  const me = await api('GET', '/api/me', { token: worker.token });
  const pinUse = await api('GET', `/api/clubs/${CLUB_A}/bookings`, { token: pinToken });
  const pinAgain = await api('POST', '/api/staff/pin', { token: terminal.terminal_token, body: { user_id: worker.user.id, pin: '4321' } });
  t.diagnostic(`отзыв: ${JSON.stringify(rv)}; личный токен → ${me.status}; токен PIN → ${pinUse.status}; новый вход по PIN → ${pinAgain.status}`);
  assert.equal(me.status, 401);
  assert.equal(pinUse.status, 401);
  assert.equal(pinAgain.status, 401);
  assert.ok(rv.tokens_revoked >= 2);
  const again = await login(phone, { consent: false });
  const me2 = await ok(api('GET', '/api/me', { token: again.token }));
  const work = await api('GET', `/api/clubs/${CLUB_A}/bookings`, { token: again.token });
  t.diagnostic(`новый вход после отзыва: клубы ${JSON.stringify(me2.clubs)}; брони клуба ${work.status}`);
  assert.ok(!me2.clubs.some((c) => c.club_id === CLUB_A));
  assert.equal(work.status, 403);
  const { rows } = await db.query('select pin_hash is null as no_pin, active from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, worker.user.id]);
  assert.deepEqual(rows[0], { no_pin: true, active: false });
  const au = (await auditOf(db, worker.user.id)).map((a) => a.action);
  t.diagnostic(`журнал сотрудника: ${au.join(', ')}`);
  for (const a of ['staff.role', 'staff.revoke', 'auth.pin_set', 'auth.pin_switch']) assert.ok(au.includes(a), a);
});
