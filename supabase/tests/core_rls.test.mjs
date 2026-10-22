// RLS и права таблиц backend-core (миграции 0100–0103, контракт M1 §13): пользователи
// платформы, токены, согласия, терминалы, nonce входа через бота, outbox, ключи
// идемпотентности, подписки Web Push, уведомления, тревоги и узкие функции входа.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { asRole, CLUB_A, CLUB_B, createTestDatabase, OWNER_A, OWNER_B, seedClubB, tryQuery } from './helpers.mjs';

const GUEST = 'a9000000-0000-4000-8000-000000000001';
const GUEST2 = 'a9000000-0000-4000-8000-000000000002';
const MANAGER_A = 'a1000000-0000-4000-8000-000000000003';
const CORE_TABLES = [
  'consents',
  'staff_terminals',
  'auth_tokens',
  'bot_link_nonces',
  'outbox',
  'outbox_done',
  'idempotency_keys',
  'push_subscriptions',
  'notifications',
  'alarms',
  'staff_invites',
  'club_summaries',
];
const sha = (s) => createHash('sha256').update(s).digest('hex');
const P256 = `B${'A'.repeat(86)}`;
const AUTH = 'A'.repeat(22);

let db;
let terminalA;

before(async () => {
  db = await createTestDatabase();
  await seedClubB(db.pool);
  await db.pool.query(`insert into bl.users (id, phone) values ($1, '+79990000001'), ($2, null)`, [GUEST, GUEST2]);
  terminalA = (
    await db.pool.query(
      `insert into bl.staff_terminals (club_id, name, token_hash, created_by, expires_at) values ($1, 'T', $2, $3, now() + interval '1 day') returning id`,
      [CLUB_A, sha('terminal-a'), OWNER_A],
    )
  ).rows[0].id;
  await db.pool.query(
    `insert into bl.staff_terminals (club_id, name, token_hash, created_by, expires_at) values ($1, 'T', $2, $3, now() + interval '1 day')`,
    [CLUB_B, sha('terminal-b'), OWNER_B],
  );
  await db.pool.query(
    `insert into bl.auth_tokens (user_id, token_hash, kind, created_at, expires_at) values
       ($1, $2, 'session', now(), now() + interval '1 day'),
       ($3, $4, 'session', now(), now() + interval '1 day'),
       ($1, $5, 'session', now() - interval '1 day', now() - interval '1 second'),
       ($1, $6, 'session', now(), now() + interval '1 day')`,
    [GUEST, sha('guest-token'), GUEST2, sha('guest2-token'), sha('expired-token'), sha('revoked-token')],
  );
  await db.pool.query(`update bl.auth_tokens set revoked_at = now() where token_hash = $1`, [sha('revoked-token')]);
  await db.pool.query(
    `insert into bl.auth_tokens (user_id, token_hash, kind, club_id, terminal_id, expires_at) values ($1, $2, 'pin', $3, $4, now() + interval '1 hour')`,
    [MANAGER_A, sha('pin-token'), CLUB_A, terminalA],
  );
  await db.pool.query(`insert into bl.consents (user_id, version) values ($1, 'v1'), ($2, 'v1')`, [GUEST, GUEST2]);
  await db.pool.query(
    `insert into bl.bot_link_nonces (nonce_hash, browser_hash, channel, expires_at) values ($1, $2, 'telegram', now() + interval '10 minutes')`,
    [sha('nonce'), sha('browser')],
  );
  await db.pool.query(
    `insert into bl.outbox (club_id, topic, payload) values ($1, 'x.a', '{}'), ($2, 'x.b', '{}'), (null, 'x.p', '{}')`,
    [CLUB_A, CLUB_B],
  );
  await db.pool.query(
    `insert into bl.idempotency_keys (user_id, key, route, request_hash, expires_at) values ($1, $2, 'POST /x', $3, now() + interval '1 day')`,
    [GUEST, randomUUID(), sha('r')],
  );
  await db.pool.query(
    `insert into bl.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://fcm.googleapis.com/fcm/send/g1', $3, $4), ($2, 'https://fcm.googleapis.com/fcm/send/g2', $3, $4)`,
    [GUEST, GUEST2, P256, AUTH],
  );
  await db.pool.query(
    `insert into bl.notifications (club_id, user_id, kind, text) values ($1, $3, 'a', 'Стол 1'), ($2, $4, 'b', 'Стол 1'), (null, $5, 'c', 'Привет')`,
    [CLUB_A, CLUB_B, OWNER_A, OWNER_B, GUEST],
  );
  await db.pool.query(`insert into bl.alarms (club_id, type, level) values ($1, 'x', 'info'), ($2, 'x', 'info')`, [CLUB_A, CLUB_B]);
});

after(async () => {
  await db?.drop();
});

const count = async (c, table) => (await c.query(`select count(*)::int as n from bl.${table}`)).rows[0].n;

describe('таблицы core: RLS включена и принудительна, владелец bl_owner', () => {
  it('ENABLE + FORCE ROW LEVEL SECURITY на всех таблицах core', async () => {
    const { rows } = await db.pool.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
         from pg_class c where c.relnamespace = 'bl'::regnamespace and c.relname = any($1)`,
      [CORE_TABLES],
    );
    assert.equal(rows.length, CORE_TABLES.length);
    for (const r of rows) assert.deepEqual([r.relname, r.relrowsecurity, r.relforcerowsecurity, r.owner], [r.relname, true, true, 'bl_owner']);
  });

  it('без контекста app_api не видит ни одной строки', async () => {
    await asRole(db.pool, 'app_api', { clubId: null, actorType: 'user' }, async (c) => {
      for (const t of [...CORE_TABLES, 'users']) assert.equal(await count(c, t), 0, t);
    });
  });
});

describe('пользователь платформы', () => {
  it('свою строку users видит сам; гость не виден персоналу клуба; другой гость — нет', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select id from bl.users')).rows.map((r) => r.id), [GUEST]);
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, userId: MANAGER_A, actorType: 'user' }, async (c) => {
      const ids = (await c.query('select id from bl.users')).rows.map((r) => r.id);
      assert.ok(!ids.includes(GUEST) && !ids.includes(GUEST2) && !ids.includes(OWNER_B));
    });
  });

  it('меняет у себя только имя и канал уведомлений; телефон и id мессенджеров — нет', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.equal(await tryQuery(c, "update bl.users set notify_channel = 'webpush' where id = $1", [GUEST]), null);
      assert.equal(await tryQuery(c, "update bl.users set name = 'Гость' where id = $1", [GUEST]), null);
      assert.equal((await tryQuery(c, "update bl.users set name = ' пробел' where id = $1", [GUEST]))?.code, '23514');
      assert.equal((await c.query("update bl.users set name = 'Чужой' where id = $1", [GUEST2])).rowCount, 0);
      assert.equal((await tryQuery(c, "update bl.users set phone = '+79990000099' where id = $1", [GUEST]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.users set telegram_user_id = 5 where id = $1', [GUEST]))?.code, '42501');
      const other = await c.query("update bl.users set notify_channel = 'max' where id = $1", [GUEST2]);
      assert.equal(other.rowCount, 0);
      assert.equal((await tryQuery(c, "insert into bl.users (phone) values ('+79990000098')"))?.code, '42501');
    });
  });

  it('свои членства и клубы — только в личном контексте; в контексте клуба A членства в B не видно', async () => {
    await db.pool.query(`insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'reception')`, [CLUB_B, MANAGER_A]);
    try {
      await asRole(db.pool, 'app_api', { userId: MANAGER_A, actorType: 'user' }, async (c) => {
        const m = (await c.query('select club_id, role from bl.club_members order by role')).rows;
        assert.deepEqual(m, [
          { club_id: CLUB_A, role: 'manager' },
          { club_id: CLUB_B, role: 'reception' },
        ]);
        assert.equal(await count(c, 'clubs'), 2);
      });
      await asRole(db.pool, 'app_api', { clubId: CLUB_A, userId: MANAGER_A, actorType: 'user' }, async (c) => {
        const m = (await c.query('select club_id from bl.club_members where user_id = $1', [MANAGER_A])).rows;
        assert.deepEqual(m, [{ club_id: CLUB_A }]);
        assert.equal(await count(c, 'clubs'), 1);
      });
    } finally {
      await db.pool.query(`delete from bl.club_members where club_id = $1 and user_id = $2`, [CLUB_B, MANAGER_A]);
    }
  });

  it('роль bar (№97) допустима в club_members, неизвестная — нет', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      assert.equal(await tryQuery(c, "insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar')", [CLUB_A, GUEST]), null);
      assert.equal((await tryQuery(c, "insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'cashier')", [CLUB_A, GUEST2]))?.code, '23514');
    });
  });

  it('согласия: свои видны и пишутся, чужие — нет', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'consents'), 1);
      assert.match((await tryQuery(c, "insert into bl.consents (user_id, version) values ($1, 'v2')", [GUEST2]))?.message ?? '', /row-level security/);
      assert.equal(await tryQuery(c, "insert into bl.consents (user_id, version) values ($1, 'v2')", [GUEST]), null);
    });
  });
});

describe('вход: токены, терминалы, nonce', () => {
  it('токены: свои; токены PIN своего клуба — в контексте клуба; чужие — нет', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'auth_tokens'), 3);
      assert.match((await tryQuery(c, "insert into bl.auth_tokens (user_id, token_hash, kind, expires_at) values ($1, $2, 'session', now() + interval '1 hour')", [GUEST2, sha('x')]))?.message ?? '', /row-level security/);
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_B, actorType: 'system' }, async (c) => {
      assert.equal(await count(c, 'auth_tokens'), 0, 'токен PIN клуба A не виден в клубе B');
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      assert.equal(await count(c, 'auth_tokens'), 1);
    });
  });

  it('терминалы — по клубу; nonce — только в контексте платформы', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'staff_terminals'), 1);
      assert.equal(await count(c, 'bot_link_nonces'), 0);
    });
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'bot_link_nonces'), 0);
      assert.ok(await tryQuery(c, "insert into bl.bot_link_nonces (nonce_hash, browser_hash, channel, expires_at) values ($1, $1, 'telegram', now() + interval '1 minute')", [sha('n2')]));
    });
    // Анонимный запрос (actor user без пользователя) — не платформа.
    await asRole(db.pool, 'app_api', { actorType: 'user' }, async (c) => {
      assert.equal(await count(c, 'bot_link_nonces'), 0);
    });
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => {
      assert.equal(await count(c, 'bot_link_nonces'), 1);
    });
  });

  it('bl.auth_resolve: действующий токен пользователя или терминала; истёкший и отозванный — нет', async () => {
    await asRole(db.pool, 'app_api', {}, async (c) => {
      const r = async (t) => (await c.query('select * from bl.auth_resolve($1)', [sha(t)])).rows;
      const g = await r('guest-token');
      assert.equal(g.length, 1);
      assert.deepEqual([g[0].kind, g[0].user_id, g[0].has_phone, g[0].consents], ['session', GUEST, true, ['v1']]);
      assert.deepEqual(await r('expired-token'), []);
      assert.deepEqual(await r('revoked-token'), []);
      assert.deepEqual(await r('nope'), []);
      const term = await r('terminal-a');
      assert.deepEqual([term[0].kind, term[0].user_id, term[0].club_id], ['terminal', null, CLUB_A]);
      const pin = await r('pin-token');
      assert.deepEqual([pin[0].kind, pin[0].user_id, pin[0].terminal_id], ['pin', MANAGER_A, terminalA]);
    });
    // Отзыв терминала гасит токены PIN, выданные на нём.
    await db.pool.query('update bl.staff_terminals set revoked_at = now() where id = $1', [terminalA]);
    await asRole(db.pool, 'app_api', {}, async (c) => {
      assert.deepEqual((await c.query('select * from bl.auth_resolve($1)', [sha('pin-token')])).rows, []);
    });
    await db.pool.query('update bl.staff_terminals set revoked_at = null where id = $1', [terminalA]);
  });

  it('bl.auth_user_for: находит или создаёт по телефону, Telegram, MAX; неверное значение — ошибка', async () => {
    await asRole(db.pool, 'app_api', {}, async (c) => {
      const f = async (k, v) => (await c.query('select bl.auth_user_for($1, $2) as id', [k, v])).rows[0].id;
      assert.equal(await f('phone', '+79990000001'), GUEST);
      const tg = await f('telegram', '424242');
      assert.equal(await f('telegram', '424242'), tg);
      assert.ok(await f('max', 'max-user-1'));
      assert.equal((await tryQuery(c, "select bl.auth_user_for('phone', '89990000001')"))?.code, '22023');
      assert.equal((await tryQuery(c, "select bl.auth_user_for('email', 'a@b')"))?.code, '22023');
    });
  });

  it('bl.auth_attach_phone: только пользователю из контекста; слияние; конфликт — BL409', async () => {
    const tgUser = (await db.pool.query('insert into bl.users (telegram_user_id) values (9100) returning id')).rows[0].id;
    await asRole(db.pool, 'app_api', {}, async (c) => {
      assert.equal((await tryQuery(c, "select bl.auth_attach_phone('+79990000077')"))?.code, '42501');
    });
    // Номер свободен — записывается текущему.
    await asRole(db.pool, 'app_api', { userId: tgUser, actorType: 'user' }, async (c) => {
      assert.equal((await c.query("select bl.auth_attach_phone('+79990000077') as id")).rows[0].id, tgUser);
    });
    await db.pool.query("update bl.users set phone = '+79990000077', phone_verified_at = now() where id = $1", [tgUser]);
    // Номер у другой учётки без Telegram — вливание.
    const tg2 = (await db.pool.query('insert into bl.users (telegram_user_id) values (9200) returning id')).rows[0].id;
    await db.pool.query("insert into bl.consents (user_id, version) values ($1, 'v9')", [tg2]);
    // asRole откатывает транзакцию: результат слияния проверяется в ней же, после RESET ROLE.
    await asRole(db.pool, 'app_api', { userId: tg2, actorType: 'user' }, async (c) => {
      assert.equal((await c.query('select bl.auth_attach_phone($1) as id', ['+79990000001'])).rows[0].id, GUEST);
      await c.query('reset role');
      const after = await c.query('select id, telegram_user_id, merged_into from bl.users where id = any($1)', [[GUEST, tg2]]);
      const byId = Object.fromEntries(after.rows.map((r) => [r.id, [r.telegram_user_id, r.merged_into]]));
      assert.deepEqual(byId[GUEST], ['9200', null], 'Telegram перешёл к учётке с номером');
      assert.deepEqual(byId[tg2], [null, GUEST], 'учётка мессенджера влита');
      assert.equal((await c.query("select count(*)::int as n from bl.consents where user_id = $1 and version = 'v9'", [GUEST])).rows[0].n, 1);
    });
    // У учётки с номером уже другой Telegram — конфликт.
    await db.pool.query('update bl.users set telegram_user_id = 9250 where id = $1', [GUEST]);
    const tg3 = (await db.pool.query('insert into bl.users (telegram_user_id) values (9300) returning id')).rows[0].id;
    await asRole(db.pool, 'app_api', { userId: tg3, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, 'select bl.auth_attach_phone($1)', ['+79990000001']))?.code, 'BL409');
    });
  });

  it('bl.user_brief: маска телефона — только в контексте клуба или себе; bl.notify_route — без телефона', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      const r = (await c.query('select * from bl.user_brief($1)', [GUEST])).rows[0];
      assert.deepEqual(r, { user_id: GUEST, phone_masked: '+7999***0001', has_phone: true });
    });
    await asRole(db.pool, 'app_api', { userId: GUEST2, actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select * from bl.user_brief($1)', [GUEST])).rows, []);
      const route = (await c.query('select * from bl.notify_route($1)', [GUEST])).rows[0];
      assert.deepEqual(Object.keys(route).sort(), ['channels_order', 'max_user_id', 'notify_channel', 'telegram_user_id', 'user_id']);
    });
  });
});

describe('outbox, идемпотентность, push, уведомления, тревоги', () => {
  it('outbox: события своего клуба; платформа видит все; вставка в чужой клуб — RLS', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      assert.deepEqual((await c.query('select topic from bl.outbox')).rows, [{ topic: 'x.a' }]);
      assert.match((await tryQuery(c, "insert into bl.outbox (club_id, topic, payload) values ($1, 'x.c', '{}')", [CLUB_B]))?.message ?? '', /row-level security/);
      assert.equal(await tryQuery(c, "insert into bl.outbox (club_id, topic, payload) values (null, 'x.c', '{}')"), null);
      assert.equal((await tryQuery(c, 'delete from bl.outbox'))?.code ?? null, null);
      assert.equal(await count(c, 'outbox'), 1, 'удаляет только платформа');
    });
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => {
      assert.equal(await count(c, 'outbox'), 3);
    });
  });

  it('ключи идемпотентности — только свои', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => assert.equal(await count(c, 'idempotency_keys'), 1));
    await asRole(db.pool, 'app_api', { userId: GUEST2, clubId: CLUB_A, actorType: 'user' }, async (c) => assert.equal(await count(c, 'idempotency_keys'), 0));
  });

  it('подписки push: свои в личном контексте; в контексте клуба — ни одной; платформа — все', async () => {
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => assert.equal(await count(c, 'push_subscriptions'), 1));
    await asRole(db.pool, 'app_api', { userId: GUEST, clubId: CLUB_A, actorType: 'user' }, async (c) => assert.equal(await count(c, 'push_subscriptions'), 0));
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => assert.equal(await count(c, 'push_subscriptions'), 2));
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.match(
        (await tryQuery(c, "insert into bl.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://fcm.googleapis.com/x', $2, $3)", [GUEST2, P256, AUTH]))?.message ?? '',
        /row-level security/,
      );
    });
  });

  it('уведомления: клуба — в контексте клуба; свои — в личном; статус меняет только доставка', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      assert.deepEqual((await c.query('select kind from bl.notifications')).rows, [{ kind: 'a' }]);
      const upd = await c.query("update bl.notifications set status = 'sent'");
      assert.equal(upd.rowCount, 0);
      assert.match((await tryQuery(c, "insert into bl.notifications (club_id, user_id, kind, text) values ($1, $2, 'x', 't')", [CLUB_B, OWNER_B]))?.message ?? '', /row-level security/);
    });
    await asRole(db.pool, 'app_api', { userId: GUEST, actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select kind from bl.notifications')).rows, [{ kind: 'c' }]);
    });
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => {
      assert.equal((await c.query("update bl.notifications set status = 'skipped' where kind = 'c'")).rowCount, 1);
    });
  });

  it('тревоги — по клубу; одна открытая тревога типа на стол', async () => {
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'system' }, async (c) => {
      assert.equal(await count(c, 'alarms'), 1);
      assert.ok(await tryQuery(c, "insert into bl.alarms (club_id, type, level) values ($1, 'x', 'info')", [CLUB_A]), 'дубль открытой тревоги');
      assert.match((await tryQuery(c, "insert into bl.alarms (club_id, type, level) values ($1, 'y', 'info')", [CLUB_B]))?.message ?? '', /row-level security/);
    });
  });

  it('приглашения персонала и сводки — по клубу; bl.summary_clubs отдаёт пояса всех клубов', async () => {
    await db.pool.query(
      `insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1, '+79990000101', 'bar', $2, now() + interval '7 days'), ($3, '+79990000102', 'bar', $4, now() + interval '7 days')`,
      [CLUB_A, OWNER_A, CLUB_B, OWNER_B],
    );
    await db.pool.query(`insert into bl.club_summaries (club_id, kind, day, data, sent_at) values ($1, 'morning', '2026-10-21', '{}', now()), ($2, 'morning', '2026-10-21', '{}', now())`, [CLUB_A, CLUB_B]);
    await asRole(db.pool, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select phone from bl.staff_invites')).rows, [{ phone: '+79990000101' }]);
      assert.equal(await count(c, 'club_summaries'), 1);
      assert.match((await tryQuery(c, "insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1, '+79990000103', 'bar', $2, now() + interval '1 day')", [CLUB_B, OWNER_A]))?.message ?? '', /row-level security/);
    });
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => {
      const clubs = (await c.query('select club_id, timezone, day_start_local, summary_time_local from bl.summary_clubs() order by club_id')).rows;
      assert.deepEqual(clubs.map((r) => [r.club_id, r.timezone, r.day_start_local, r.summary_time_local]), [
        [CLUB_A, 'Asia/Yekaterinburg', '06:00', '10:00'],
        [CLUB_B, 'Asia/Vladivostok', '06:00', '10:00'],
      ]);
      assert.equal(await count(c, 'staff_invites'), 0, 'платформа приглашений не видит');
    });
  });

  it('bl.staff_accept_invites — только номер пользователя из контекста; bl.staff_revoke — только участник клуба из контекста, не владелец', async () => {
    const invitee = (await db.pool.query("insert into bl.users (phone) values ('+79990000101') returning id")).rows[0].id;
    await asRole(db.pool, 'app_api', { actorType: 'user' }, async (c) => {
      assert.deepEqual((await c.query('select * from bl.staff_accept_invites()')).rows, [], 'без пользователя — ничего');
    });
    await asRole(db.pool, 'app_api', { userId: invitee, actorType: 'user' }, async (c) => {
      const rows = (await c.query('select club_id, role from bl.staff_accept_invites()')).rows;
      assert.deepEqual(rows, [{ club_id: CLUB_A, role: 'bar' }]);
    });
    await asRole(db.pool, 'app_api', { clubId: CLUB_B, actorType: 'user' }, async (c) => {
      assert.equal((await c.query('select bl.staff_revoke($1) as n', [MANAGER_A])).rows[0].n, null, 'сотрудник другого клуба');
      assert.equal((await tryQuery(c, 'select bl.staff_revoke($1)', [OWNER_B]))?.code, '42501', 'владельца — нельзя');
    });
    await asRole(db.pool, 'app_api', { actorType: 'system' }, async (c) => {
      assert.equal((await tryQuery(c, 'select bl.staff_revoke($1)', [MANAGER_A]))?.code, '42501', 'без клуба в контексте');
    });
  });

  it('DELETE и TRUNCATE у app_api только там, где нужно (outbox, nonce, ключи идемпотентности)', async () => {
    const { rows } = await db.pool.query(
      `select t, has_table_privilege('app_api', 'bl.' || t, 'DELETE') as del, has_table_privilege('app_api', 'bl.' || t, 'TRUNCATE') as tr
         from unnest($1::text[]) t order by t`,
      [CORE_TABLES],
    );
    const del = rows.filter((r) => r.del).map((r) => r.t);
    assert.deepEqual(del, ['bot_link_nonces', 'idempotency_keys', 'outbox']);
    assert.ok(rows.every((r) => !r.tr));
  });
});
