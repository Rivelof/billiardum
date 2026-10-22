// Журнал, тревоги, уведомления, маршруты владельца и SSE на временной базе (контракт M1 §7, §8, §13).

import assert from 'node:assert/strict';
import { createECDH, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { raise } from '../../alarms/index.mjs';
import { appendAudit } from '../../lib/audit.mjs';
import { withContext } from '../../lib/store.mjs';
import { createNotifier, send } from '../../notify/index.mjs';
import { decryptPayload, p256Scalar } from '../../notify/webpush.mjs';
import { CLUB_A, MANAGER_A, OWNER_A, RESOURCE_1, startTestApp, waitFor } from './helpers.mjs';

let t;
let owner;
let manager;
let reception;

before(async () => {
  t = await startTestApp({ notifyWorker: false });
  owner = await t.login('+70000000001');
  manager = await t.login('+70000000003');
  reception = await t.login('+70000000004');
});

after(async () => {
  await t?.stop();
});

const inClub = (fn, clubId = CLUB_A) => withContext(t.pool, { clubId, actorType: 'system' }, fn);

/** Поток SSE: читать события, пока не придёт нужное. */
async function openStream(path, token) {
  const ac = new AbortController();
  const res = await fetch(`${t.base}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
  const reader = res.status === 200 ? res.body.getReader() : null;
  let buf = '';
  return {
    status: res.status,
    headers: res.headers,
    async next(name, timeoutMs = 2000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const m = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`).exec(buf);
        if (m) {
          buf = buf.slice(m.index + m[0].length);
          return JSON.parse(m[1]);
        }
        if (Date.now() > until) throw new Error(`нет события ${name}`);
        const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), until - Date.now()))]);
        if (chunk.timeout) continue;
        if (chunk.done) throw new Error('поток закрыт');
        buf += Buffer.from(chunk.value).toString('utf8');
      }
    },
    close() {
      ac.abort();
    },
  };
}

describe('журнал: appendAudit', () => {
  it('запись в цепочку клуба из контекста: seq, hash; цепочка цела', async () => {
    const a = await inClub((db) => appendAudit(db, { action: 'test.one', objectType: 'resource', objectId: RESOURCE_1, data: { k: 1 }, actorType: 'system' }));
    const b = await inClub((db) => appendAudit(db, { action: 'test.two', data: {} }));
    assert.equal(b.seq, a.seq + 1);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    const row = (await t.admin.query('select actor_type, actor_id, prev_hash from bl.audit_log where id = $1', [b.id])).rows[0];
    assert.equal(row.actor_type, 'system', 'исполнитель по умолчанию — из контекста');
    assert.equal(row.prev_hash, a.hash);
    const v = (await t.admin.query('select * from bl.audit_verify($1)', [CLUB_A])).rows[0];
    assert.equal(v.ok, true);
  });

  it('ручное действие без причины — reason_required; с причиной — причина в reason', async () => {
    await assert.rejects(
      inClub((db) => appendAudit(db, { action: 'service.start', data: { minutes: 10 }, reason: '  ' })),
      (err) => err.code === 'reason_required' && err.status === 400,
    );
    const r = await inClub((db) => appendAudit(db, { action: 'manual.extend_free', data: { minutes: 10 }, reason: 'гость ждал' }));
    assert.equal((await t.admin.query('select reason from bl.audit_log where id = $1', [r.id])).rows[0].reason, 'гость ждал');
  });

  it('без клуба — цепочка платформы (seq и hash не видны app_api); неверные поля — ошибка', async () => {
    const r = await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => appendAudit(db, { action: 'platform.test', data: {} }));
    assert.equal(r.seq, null);
    const row = (await t.admin.query('select club_id, seq from bl.audit_log where id = $1', [r.id])).rows[0];
    assert.equal(row.club_id, null);
    assert.ok(row.seq >= 1);
    await assert.rejects(inClub((db) => appendAudit(db, { action: 'BAD', data: {} })));
    await assert.rejects(inClub((db) => appendAudit(db, { action: 'a.b', data: [] })));
  });
});

describe('тревоги', () => {
  it('raise: тревога, журнал alarm.raised, уведомления владельцу и управляющему, SSE после коммита', async () => {
    const stream = await openStream(`/api/stream?club=${CLUB_A}`, manager.token);
    assert.equal(stream.status, 200);
    await stream.next('ready');
    const res = await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_1, data: { current_ma: 900 } }));
    assert.equal(res.created, true);
    const ev = await stream.next('alarm');
    assert.equal(ev.id, res.id);
    assert.equal(ev.text, 'Стол 1: Свет горит без игры — проверьте стол');
    stream.close();
    const journal = await t.admin.query("select data from bl.audit_log where action = 'alarm.raised' and object_id = $1", [res.id]);
    assert.deepEqual(journal.rows[0].data, { alarm_id: res.id, type: 'bypass_detected', level: 'critical', resource_id: RESOURCE_1 });
    const notes = await t.admin.query("select user_id, level, text from bl.notifications where kind = 'alarm' and data->>'alarm_id' = $1 order by user_id", [res.id]);
    assert.deepEqual(
      notes.rows.map((n) => n.user_id),
      [OWNER_A, MANAGER_A].sort(),
    );
    assert.equal(notes.rows[0].level, 'critical');
    // Повтор, пока тревога открыта: счётчик, без новой записи журнала и уведомлений.
    const again = await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_1 }));
    assert.deepEqual({ id: again.id, created: again.created, count: again.count }, { id: res.id, created: false, count: 2 });
    assert.equal((await t.admin.query("select count(*)::int as n from bl.notifications where data->>'alarm_id' = $1", [res.id])).rows[0].n, 2);
  });

  it('откат транзакции — ни тревоги, ни события SSE', async () => {
    const got = [];
    const fake = fakeRes();
    t.sse.attach(fake, { channels: [`club:${CLUB_A}`] });
    fake.onWrite = (s) => got.push(s);
    await assert.rejects(
      inClub(async (db) => {
        await raise(db, CLUB_A, { type: 'lamp_fault', level: 'important', resourceId: RESOURCE_1 });
        throw new Error('откат');
      }),
    );
    fake.close();
    assert.equal(got.filter((s) => s.includes('event: alarm')).length, 0);
    assert.equal((await t.admin.query("select count(*)::int as n from bl.alarms where type = 'lamp_fault'")).rows[0].n, 0);
  });

  it('ручное действие уведомляет при каждом подъёме, даже при открытой тревоге; уровень по умолчанию (№66)', async () => {
    const first = await inClub((db) => raise(db, CLUB_A, { type: 'service_light', resourceId: RESOURCE_1, text: 'Стол 1: сервисный свет на 10 минут' }));
    const second = await inClub((db) => raise(db, CLUB_A, { type: 'service_light', resourceId: RESOURCE_1, text: 'Стол 1: сервисный свет на 20 минут' }));
    assert.deepEqual([first.created, second.created, second.notified, second.count], [true, false, true, 2]);
    const notes = await t.admin.query("select text, level from bl.notifications where data->>'alarm_id' = $1 and user_id = $2 order by created_at", [first.id, OWNER_A]);
    assert.deepEqual(
      notes.rows.map((n) => n.text),
      ['Стол 1: сервисный свет на 10 минут', 'Стол 1: сервисный свет на 20 минут'],
    );
    assert.equal(notes.rows[0].level, 'critical', 'ручное действие — critical по умолчанию');
    const relay = await inClub((db) => raise(db, CLUB_A, { type: 'relay_fault', resourceId: RESOURCE_1 }));
    assert.equal((await t.admin.query('select level from bl.alarms where id = $1', [relay.id])).rows[0].level, 'critical');
    const replay = await inClub((db) => raise(db, CLUB_A, { type: 'replayed_seq', resourceId: RESOURCE_1 }));
    const r = (await t.admin.query('select level from bl.alarms where id = $1', [replay.id])).rows[0];
    assert.equal(r.level, 'important');
    const again = await inClub((db) => raise(db, CLUB_A, { type: 'replayed_seq', resourceId: RESOURCE_1 }));
    assert.equal(again.notified, false, 'не ручная тревога: повтор без уведомления');
  });

  it('повтор открытой критичной тревоги: через 10 минут снова уведомляет владельца, раньше — только счётчик (№75)', async () => {
    const RESOURCE_2 = 'e1000000-0000-4000-8000-000000000002';
    const notes = async (id) =>
      (await t.admin.query("select count(*)::int as n from bl.notifications where data->>'alarm_id' = $1 and user_id = $2", [id, OWNER_A])).rows[0].n;
    const first = await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_2 }));
    assert.equal(await notes(first.id), 1);
    const soon = await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_2 }));
    assert.deepEqual([soon.created, soon.notified, soon.count], [false, false, 2]);
    assert.equal(await notes(first.id), 1, 'раньше 10 минут — без уведомления');
    // Прошло 9 минут 59 секунд — всё ещё рано.
    await t.admin.query("update bl.alarms set last_notified_at = now() - interval '599 seconds' where id = $1", [first.id]);
    assert.equal((await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_2 }))).notified, false);
    // Прошло 10 минут — снова уведомление, отсчёт заново.
    await t.admin.query("update bl.alarms set last_notified_at = now() - interval '10 minutes' where id = $1", [first.id]);
    const late = await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_2 }));
    assert.deepEqual([late.created, late.notified, late.count], [false, true, 4]);
    assert.equal(await notes(first.id), 2);
    assert.equal((await inClub((db) => raise(db, CLUB_A, { type: 'bypass_detected', level: 'critical', resourceId: RESOURCE_2 }))).notified, false);
    // Важная (не критичная) тревога через 10 минут повторно не уведомляет.
    const imp = await inClub((db) => raise(db, CLUB_A, { type: 'lamp_fault', level: 'important', resourceId: RESOURCE_2 }));
    await t.admin.query("update bl.alarms set last_notified_at = now() - interval '1 hour' where id = $1", [imp.id]);
    assert.equal((await inClub((db) => raise(db, CLUB_A, { type: 'lamp_fault', level: 'important', resourceId: RESOURCE_2 }))).notified, false);
  });

  it('тревоги по разным чекам не склеиваются: два receipt_unknown — два уведомления; повтор по тому же чеку — счётчик', async () => {
    const r1 = randomUUID();
    const r2 = randomUUID();
    const notes = async (id) =>
      (await t.admin.query("select count(*)::int as n from bl.notifications where data->>'alarm_id' = $1 and user_id = $2", [id, OWNER_A])).rows[0].n;
    const a = await inClub((db) => raise(db, CLUB_A, { type: 'receipt_unknown', data: { receipt_id: r1 } }));
    const b = await inClub((db) => raise(db, CLUB_A, { type: 'receipt_unknown', data: { receipt_id: r2 } }));
    assert.notEqual(a.id, b.id);
    assert.deepEqual([a.created, b.created, await notes(a.id), await notes(b.id)], [true, true, 1, 1]);
    const again = await inClub((db) => raise(db, CLUB_A, { type: 'receipt_unknown', data: { receipt_id: r1 } }));
    assert.deepEqual([again.id, again.created, again.count], [a.id, false, 2]);
    // Явный ключ и тип без объекта — склейка по типу и столу.
    const x = await inClub((db) => raise(db, CLUB_A, { type: 'kkt_shift_failed', dedupeKey: 'shift:1', data: {} }));
    const y = await inClub((db) => raise(db, CLUB_A, { type: 'kkt_shift_failed', dedupeKey: 'shift:2', data: {} }));
    assert.notEqual(x.id, y.id);
    const c1 = await inClub((db) => raise(db, CLUB_A, { type: 'cash_discrepancy', data: { shift_id: randomUUID() } }));
    const c2 = await inClub((db) => raise(db, CLUB_A, { type: 'cash_discrepancy', data: { shift_id: randomUUID() } }));
    assert.notEqual(c1.id, c2.id, 'расхождения разных смен — отдельные');
    const z1 = await inClub((db) => raise(db, CLUB_A, { type: 'service_light_threshold', data: { minutes: 70 } }));
    const z2 = await inClub((db) => raise(db, CLUB_A, { type: 'service_light_threshold', data: { minutes: 80 } }));
    assert.equal(z1.id, z2.id, 'без объекта — по типу и столу');
  });

  it('raise вне контекста клуба тревоги — ошибка', async () => {
    await assert.rejects(withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => raise(db, CLUB_A, { type: 'x', level: 'info' })));
  });

  it('GET alarms и POST /api/alarms/{id}/ack: управляющий подтверждает, ресепшну — 403', async () => {
    const id = (await inClub((db) => raise(db, CLUB_A, { type: 'device_offline', level: 'critical', resourceId: RESOURCE_1 }))).id;
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/alarms?state=open`, { token: manager.token });
    assert.ok(list.json.some((a) => a.id === id && a.state === 'open'));
    assert.equal((await t.request('POST', `/api/alarms/${id}/ack`, { token: reception.token })).status, 403);
    const ack = await t.request('POST', `/api/alarms/${id}/ack`, { token: manager.token });
    assert.equal(ack.status, 200);
    assert.equal(ack.json.alarm.state, 'acked');
    assert.equal((await t.request('POST', `/api/alarms/${id}/ack`, { token: manager.token })).status, 200);
    assert.equal((await t.request('POST', `/api/alarms/${randomUUID()}/ack`, { token: manager.token })).status, 404);
    const journal = await t.admin.query("select actor_id from bl.audit_log where action = 'alarm.ack' and object_id = $1", [id]);
    assert.deepEqual(journal.rows, [{ actor_id: MANAGER_A }]);
  });
});

describe('уведомления: цепочка каналов и Web Push', () => {
  it('Telegram не доставил — ушло в Web Push; тело зашифровано и без телефона; 410 — подписка отозвана', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const vapid = createECDH('prime256v1');
    vapid.generateKeys();
    const authSecret = Buffer.alloc(16, 7).toString('base64url');
    const guest = await t.login('+79990002001');
    await t.admin.query('update bl.users set telegram_user_id = 4242, notify_channel = $2 where id = $1', [guest.user.id, 'telegram']);
    const sub = await t.request('POST', '/api/push/subscribe', {
      token: guest.token,
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret } },
    });
    assert.deepEqual(sub.json, { ok: true });
    const pushes = [];
    let pushStatus = 201;
    const notifier = createNotifier({
      config: { vapid: { publicKey: vapid.getPublicKey().toString('base64url'), privateKey: p256Scalar(vapid.getPrivateKey()).toString('base64url'), subject: 'mailto:t@bl.test' } },
      log: t.log,
      telegram: {
        configured: true,
        async call() {
          throw Object.assign(new Error('прокси недоступен'), { code: 'network' });
        },
      },
      pushRequest: async (url, opts) => {
        pushes.push({ url, opts });
        return { status: pushStatus, headers: {}, body: Buffer.alloc(0) };
      },
    });
    const { id } = await inClub((db) => send(db, guest.user.id, { kind: 'session.t10', text: 'Стол 4: осталось 10 минут, +7 999 123-45-67', data: { session_id: randomUUID() } }));
    await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => notifier.deliver({ notification_id: id }, { db }));
    const n = (await t.admin.query('select status, channel, attempts, text from bl.notifications where id = $1', [id])).rows[0];
    assert.equal(n.status, 'sent');
    assert.equal(n.channel, 'webpush');
    assert.deepEqual(
      n.attempts.map((a) => `${a.channel}:${a.status}`),
      ['telegram:failed', 'webpush:sent'],
    );
    assert.ok(!n.text.includes('123-45-67'), 'телефон вырезан из текста');
    assert.equal(pushes.length, 1);
    const h = pushes[0].opts.headers;
    assert.equal(h['content-encoding'], 'aes128gcm');
    assert.match(h.authorization, /^vapid t=[^,]+, k=/);
    const body = JSON.parse(decryptPayload(pushes[0].opts.body, { uaPrivateKey: ua.getPrivateKey(), auth: authSecret }).toString('utf8'));
    assert.deepEqual(Object.keys(body).sort(), ['body', 'tag', 'title']);
    assert.equal(body.body, n.text);
    assert.equal(body.title, 'Игра');
    assert.ok(!JSON.stringify(body).includes('+7'), 'в теле push нет телефона');
    // Повтор доставки не дублирует.
    await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => notifier.deliver({ notification_id: id }, { db }));
    assert.equal(pushes.length, 1);
    // Подписка больше не действует.
    pushStatus = 410;
    const second = await inClub((db) => send(db, guest.user.id, { kind: 'session.t1', text: 'Стол 4: осталась минута' }));
    await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => notifier.deliver({ notification_id: second.id }, { db }));
    assert.equal((await t.admin.query('select status from bl.notifications where id = $1', [second.id])).rows[0].status, 'failed');
    assert.ok((await t.admin.query('select revoked_at from bl.push_subscriptions where user_id = $1', [guest.user.id])).rows[0].revoked_at);
  });

  it('нет каналов — skipped; MAX до документации — skipped; critical — во все доступные каналы', async () => {
    const guest = await t.login('+79990002002');
    const calls = [];
    const notifier = createNotifier({
      config: { vapid: {} },
      log: t.log,
      telegram: { configured: true, call: async (m, p) => calls.push(p) },
    });
    const a = await inClub((db) => send(db, guest.user.id, { kind: 'info', text: 'Привет' }));
    await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => notifier.deliver({ notification_id: a.id }, { db }));
    assert.equal((await t.admin.query('select status from bl.notifications where id = $1', [a.id])).rows[0].status, 'skipped');
    await t.admin.query("update bl.users set telegram_user_id = 4343, max_user_id = 'm-1' where id = $1", [guest.user.id]);
    const b = await inClub((db) => send(db, guest.user.id, { kind: 'alarm', level: 'critical', text: 'Стол 2: тревога' }));
    await withContext(t.pool, { clubId: null, actorType: 'system' }, (db) => notifier.deliver({ notification_id: b.id }, { db }));
    const nb = (await t.admin.query('select status, channel, attempts from bl.notifications where id = $1', [b.id])).rows[0];
    assert.equal(nb.status, 'sent');
    assert.deepEqual(
      nb.attempts.map((x) => `${x.channel}:${x.status}`),
      ['max:skipped', 'telegram:sent'],
    );
    assert.equal(calls[0].chat_id, 4343);
  });

  it('открытый ключ VAPID: без ключей — 501 not_configured', async () => {
    const res = await t.request('GET', '/api/push/vapid-public-key');
    assert.equal(res.status, 501);
    assert.deepEqual(res.json, { error: 'not_configured' });
  });

  it('push/subscribe: только https известного push-сервиса и верные ключи', async () => {
    const guest = await t.login('+79990002003');
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16).toString('base64url') };
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://fcm.googleapis.com:8443/x']) {
      assert.equal((await t.request('POST', '/api/push/subscribe', { token: guest.token, body: { endpoint, keys } })).status, 400, endpoint);
    }
    assert.equal(
      (await t.request('POST', '/api/push/subscribe', { token: guest.token, body: { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys: { ...keys, auth: 'short' } } })).status,
      400,
    );
  });
});

describe('маршруты владельца', () => {
  it('now: зал, выручка за рабочие сутки по способам оплаты, открытые тревоги', async () => {
    const guest = await t.login('+79990003001');
    await t.admin.query(
      `insert into bl.payments (club_id, resource_id, user_id, kind, provider, method, provider_payment_id, idempotence_key, status, amount_kopecks, confirmed_at)
       values ($1, $2, $3, 'start', 'yookassa', 'sbp', 'pay-1', 'k-1', 'succeeded', 160000, now()),
              ($1, $2, $3, 'start', 'reception', 'cash', null, 'k-2', 'succeeded', 80000, now()),
              ($1, $2, $3, 'start', 'yookassa', 'card', 'pay-3', 'k-3', 'pending', 50000, null),
              ($1, $2, $3, 'start', 'yookassa', 'card', 'pay-4', 'k-4', 'succeeded', 70000, now() - interval '2 days')`,
      [CLUB_A, RESOURCE_1, guest.user.id],
    );
    const res = await t.request('GET', `/api/clubs/${CLUB_A}/now`, { token: manager.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.revenue_today_kopecks, { sbp: 160000, card: 0, cash: 80000, card_terminal: 0 });
    assert.equal(res.json.hall.length, 8);
    assert.ok(Array.isArray(res.json.alarms_open));
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/now`, { token: reception.token })).status, 403);
  });

  it('audit: фильтры по действию (префикс), сотруднику, столу и курсор', async () => {
    const all = await t.request('GET', `/api/clubs/${CLUB_A}/audit?limit=200`, { token: owner.token });
    assert.equal(all.status, 200);
    assert.ok(all.json.items.length > 3);
    const seqs = all.json.items.map((i) => i.seq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => b - a),
    );
    const alarms = await t.request('GET', `/api/clubs/${CLUB_A}/audit?action=alarm.*`, { token: owner.token });
    assert.ok(alarms.json.items.length >= 2 && alarms.json.items.every((i) => i.action.startsWith('alarm.')));
    // Список через запятую: префиксы и точные имена (§14).
    const mixed = await t.request('GET', `/api/clubs/${CLUB_A}/audit?action=${encodeURIComponent('manual.*,alarm.ack,test.one')}&limit=200`, { token: owner.token });
    const kinds = new Set(mixed.json.items.map((i) => i.action));
    assert.deepEqual([...kinds].sort(), ['alarm.ack', 'manual.extend_free', 'test.one']);
    const byActor = await t.request('GET', `/api/clubs/${CLUB_A}/audit?actor=${MANAGER_A}`, { token: owner.token });
    assert.ok(byActor.json.items.every((i) => i.actor_id === MANAGER_A));
    assert.equal(byActor.json.items[0].actor_name, 'Управляющий (тест)');
    assert.equal(byActor.json.items[0].actor_type, 'user');
    for (const k of ['actor_type', 'actor_id', 'actor_name', 'resource_number', 'reason', 'hash']) assert.ok(k in byActor.json.items[0], k);
    // Стол записи: объект-ресурс, data.resource_id и стол устройства (команды контроллеру).
    await inClub((db) =>
      appendAudit(db, { action: 'device.cmd', objectType: 'device', objectId: 'd1000000-0000-4000-8000-000000000001', data: { seq: 1, type: 'ping' }, actorType: 'system' }),
    );
    const byTable = await t.request('GET', `/api/clubs/${CLUB_A}/audit?resource=${RESOURCE_1}&limit=200`, { token: owner.token });
    assert.ok(byTable.json.items.length >= 3);
    assert.ok(byTable.json.items.every((i) => i.resource_number === 1 && i.resource_id === RESOURCE_1));
    assert.ok(byTable.json.items.some((i) => i.action === 'device.cmd'), 'команда устройства стола 1');
    assert.ok(byTable.json.items.some((i) => i.action === 'test.one'), 'объект — ресурс');
    assert.ok(byTable.json.items.some((i) => i.action === 'alarm.raised'), 'data.resource_id');
    const system = (await t.request('GET', `/api/clubs/${CLUB_A}/audit?action=test.two`, { token: owner.token })).json.items[0];
    assert.deepEqual([system.actor_name, system.resource_number], [null, null]);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/audit?action=a.*b`, { token: owner.token })).status, 400);
    const page1 = await t.request('GET', `/api/clubs/${CLUB_A}/audit?limit=2`, { token: owner.token });
    assert.equal(page1.json.items.length, 2);
    const page2 = await t.request('GET', `/api/clubs/${CLUB_A}/audit?limit=2&cursor=${page1.json.next_cursor}`, { token: owner.token });
    assert.equal(page2.json.items[0].seq, page1.json.items[1].seq - 1);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/audit?action=DROP%20TABLE`, { token: owner.token })).status, 400);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/audit?from=yesterday`, { token: owner.token })).status, 400);
  });

  it('audit/verify — только владелец; цепочка цела', async () => {
    const v = await t.request('GET', `/api/clubs/${CLUB_A}/audit/verify`, { token: owner.token });
    assert.equal(v.json.ok, true);
    assert.equal(v.json.broken_seq, null);
    assert.match(v.json.head_hash, /^[0-9a-f]{64}$/);
    assert.ok(v.json.count > 3);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/audit/verify`, { token: manager.token })).status, 403);
  });

  it('qr-stickers.pdf: PDF A4 на 8 столов — 2 страницы, ссылки на https://{PUBLIC_HOST}/t/{code}', async () => {
    const res = await t.request('GET', `/api/clubs/${CLUB_A}/qr-stickers.pdf`, { token: manager.token });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /attachment/);
    assert.equal(res.buf.subarray(0, 8).toString('latin1'), '%PDF-1.7');
    assert.match(res.buf.toString('latin1'), /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2 >>/);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/qr-stickers.pdf`, { token: reception.token })).status, 403);
  });
});

describe('SSE: права на каналы', () => {
  let sessionId;

  before(async () => {
    const payer = await t.login('+79990004001');
    sessionId = randomUUID();
    await t.admin.query(
      `insert into bl.sessions (id, club_id, resource_id, status, payer_user_id, started_at, paid_until, created_at, updated_at)
       values ($1, $2, $3, 'active', $4, now(), now() + interval '1 hour', now(), now())`,
      [sessionId, CLUB_A, RESOURCE_1, payer.user.id],
    );
    await t.admin.query(
      `insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, 'payer', 1, now())`,
      [sessionId, CLUB_A, payer.user.id],
    );
    t.payer = payer;
  });

  it('канал клуба — персоналу; гостю — 403; без параметров — 400', async () => {
    const guest = await t.login('+79990004002');
    assert.equal((await openStream(`/api/stream?club=${CLUB_A}`, guest.token)).status, 403);
    assert.equal((await openStream('/api/stream', guest.token)).status, 400);
    const s = await openStream(`/api/stream?club=${CLUB_A}`, reception.token);
    assert.equal(s.status, 200);
    assert.match(s.headers.get('content-type'), /^text\/event-stream/);
    const ready = await s.next('ready');
    assert.deepEqual(ready.channels.sort(), [`club:${CLUB_A}`, `user:a1000000-0000-4000-8000-000000000004`].sort());
    s.close();
  });

  it('канал сессии — участнику и персоналу клуба; чужому гостю — 403; нет сессии — 404', async () => {
    const s = await openStream(`/api/stream?session=${sessionId}`, t.payer.token);
    assert.equal(s.status, 200);
    await s.next('ready');
    t.sse.publish(`session:${sessionId}`, 'session', { id: sessionId, status: 'active' });
    assert.deepEqual(await s.next('session'), { id: sessionId, status: 'active' });
    // Событие чужой сессии не приходит, своё пользовательское — приходит.
    t.sse.publish(`session:${randomUUID()}`, 'session', { id: 'other' });
    t.sse.publish(`user:${t.payer.user.id}`, 'reception_request', { status: 'accepted' });
    assert.deepEqual(await s.next('reception_request'), { status: 'accepted' });
    assert.doesNotMatch(JSON.stringify(await Promise.resolve('')), /other/);
    s.close();
    const stranger = await t.login('+79990004003');
    assert.equal((await openStream(`/api/stream?session=${sessionId}`, stranger.token)).status, 403);
    const staff = await openStream(`/api/stream?session=${sessionId}`, manager.token);
    assert.equal(staff.status, 200);
    staff.close();
    assert.equal((await openStream(`/api/stream?session=${randomUUID()}`, t.payer.token)).status, 404);
  });

  it('одноразовый токен SSE (§14): без cookie и Bearer, один раз, только свой канал', async () => {
    const issue = await t.request('POST', '/api/stream/token', { token: t.payer.token, body: { session: sessionId } });
    assert.equal(issue.status, 200);
    assert.match(issue.json.token, /^[A-Za-z0-9_-]{43}$/);
    const ttl = new Date(issue.json.expires_at).getTime() - Date.now();
    assert.ok(ttl > 50_000 && ttl <= 60_000, `срок ${ttl}`);
    const open = (path) => fetch(`${t.base}${path}`).then(async (res) => ({ res, status: res.status }));
    // Чужой канал с этим токеном — 401 (токен сгорает).
    const wrong = await open(`/api/stream?session=${randomUUID()}&token=${issue.json.token}`);
    assert.equal(wrong.status, 401);
    const issue2 = await t.request('POST', '/api/stream/token', { token: t.payer.token, body: { session: sessionId } });
    const ok = await open(`/api/stream?session=${sessionId}&token=${issue2.json.token}`);
    assert.equal(ok.status, 200);
    const reader = ok.res.body.getReader();
    const first = Buffer.from((await reader.read()).value).toString('utf8');
    assert.match(first, /event: ready/);
    await reader.cancel();
    const reuse = await open(`/api/stream?session=${sessionId}&token=${issue2.json.token}`);
    assert.equal(reuse.status, 401, 'повторно — нет');
    // Токен на клуб: гостю права не даёт.
    const clubTok = await t.request('POST', '/api/stream/token', { token: t.payer.token, body: { club: CLUB_A } });
    assert.equal((await open(`/api/stream?club=${CLUB_A}&token=${clubTok.json.token}`)).status, 403);
    // Персоналу — даёт.
    const staffTok = await t.request('POST', '/api/stream/token', { token: manager.token, body: { club: CLUB_A } });
    const staff = await open(`/api/stream?club=${CLUB_A}&token=${staffTok.json.token}`);
    assert.equal(staff.status, 200);
    await staff.res.body.cancel();
    assert.equal((await t.request('POST', '/api/stream/token', { token: manager.token, body: { club: CLUB_A, session: sessionId } })).status, 400);
    assert.equal((await t.request('POST', '/api/stream/token', { body: { club: CLUB_A }, origin: null })).status, 401);
    assert.equal((await open(`/api/stream?club=${CLUB_A}&token=${'A'.repeat(43)}`)).status, 401);
  });

  it('бармену (№97) из канала клуба — только события бара, без кассы, тревог и зала', async () => {
    const BAR = 'a1000000-0000-4000-8000-000000000006';
    await t.admin.query("insert into bl.users (id, phone) values ($1, '+70000000006') on conflict do nothing", [BAR]);
    await t.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar') on conflict do nothing", [CLUB_A, BAR]);
    const bar = await t.login('+70000000006');
    const s = await openStream(`/api/stream?club=${CLUB_A}`, bar.token);
    assert.equal(s.status, 200);
    await s.next('ready');
    t.sse.publish(`club:${CLUB_A}`, 'pos_sale', { total_kopecks: 100 });
    t.sse.publish(`club:${CLUB_A}`, 'hall', { status: 'busy' });
    t.sse.publish(`club:${CLUB_A}`, 'alarm', { type: 'x' });
    t.sse.publish(`club:${CLUB_A}`, 'bar', { id: 'order-1' });
    assert.deepEqual(await s.next('bar'), { id: 'order-1' });
    await assert.rejects(s.next('pos_sale', 300), /нет события/);
    s.close();
    // Ресепшн получает все события клуба.
    const r = await openStream(`/api/stream?club=${CLUB_A}`, reception.token);
    await r.next('ready');
    t.sse.publish(`club:${CLUB_A}`, 'pos_sale', { total_kopecks: 200 });
    assert.deepEqual(await r.next('pos_sale'), { total_kopecks: 200 });
    r.close();
    // Канал сессии бармену закрыт.
    assert.equal((await openStream(`/api/stream?session=${sessionId}`, bar.token)).status, 403);
  });

  it('после закрытия клиента хаб забывает подписчика', async () => {
    await waitFor(() => t.sse.size === 0, { timeoutMs: 2000 });
  });
});

/** Поддельный ответ HTTP для хаба SSE. */
function fakeRes() {
  const handlers = {};
  const res = {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    onWrite: null,
    writeHead() {},
    write(s) {
      res.onWrite?.(s);
      return true;
    },
    end() {
      res.writableEnded = true;
      handlers.close?.();
    },
    on(ev, fn) {
      handlers[ev] = fn;
    },
    close() {
      res.end();
    },
  };
  return res;
}
