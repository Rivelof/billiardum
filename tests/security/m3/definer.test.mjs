// PoC для новых SECURITY DEFINER функций M3 и управления персоналом (контракт M3 §1 п. 9;
// decisions №111, №117). Функции обходят RLS, поэтому их границы проверяем отдельно:
//   bl.pos_guest           — поиск гостя по телефону только персоналу кассы клуба из контекста;
//   bl.staff_accept_invites — привязывает приглашения только на телефон вошедшего;
//   bl.staff_revoke        — гасит членство, PIN и все токены; владельца не отзывает;
//   bl.notify_route        — канал без телефона;
//   bl.booking_due / summary_clubs — межклубные id только планировщику (app_api).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:...@127.0.0.1:55460/postgres \
//   node --test tests/security/m3/definer.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { asRole, createTestDatabase, seedClubB, CLUB_A, OWNER_A, OWNER_B } from '../../../supabase/tests/helpers.mjs';

const RECEPTION_A = 'a1000000-0000-4000-8000-000000000004';
const token64 = () => Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

let db;
let pool;

/** Как app_api с контекстом, но с коммитом: для функций с побочными эффектами (принятие, отзыв). */
async function asAppCommit({ clubId = null, userId = null }, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id',$1,true), set_config('app.user_id',$2,true), set_config('app.actor_type','user',true)", [clubId ?? '', userId ?? '']);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    await c.query('reset role').catch(() => {});
    c.release();
  }
}

/** Гость с телефоном и согласием (не персонал ни одного клуба). */
async function makeGuest({ phone, consent = true, merged = false }) {
  const id = randomUUID();
  await pool.query('insert into bl.users (id, phone) values ($1, $2)', [id, phone]);
  if (consent) await pool.query("insert into bl.consents (user_id, version, accepted_at) values ($1, '2026-10-21', now())", [id]);
  if (merged) await pool.query('update bl.users set merged_into = $2 where id = $1', [id, OWNER_A]);
  return id;
}

before(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await seedClubB(pool);
});

after(async () => {
  await db?.drop();
});

// ── bl.pos_guest ────────────────────────────────────────────────────────────────────────────

test('pos_guest: ресепшн клуба находит существующего гостя по телефону', async () => {
  const phone = '+79001112233';
  const guest = await makeGuest({ phone });
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: RECEPTION_A }, async (c) => {
    const byId = await c.query('select bl.pos_guest($1,$2) id', [guest, null]);
    assert.equal(byId.rows[0].id, guest, 'по id');
    const byPhone = await c.query('select bl.pos_guest($1,$2) id', [null, phone]);
    assert.equal(byPhone.rows[0].id, guest, 'по телефону');
  });
});

test('pos_guest (НАХОДКА, низкая): межклубный оракул существования по телефону — ресепшн клуба A узнаёт гостя, не связанного с A', async () => {
  // Гость зарегистрирован на платформе, но НЕ является ни гостем, ни персоналом клуба A.
  const phone = '+79005556677';
  const guest = await makeGuest({ phone });
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: RECEPTION_A }, async (c) => {
    const r = await c.query('select bl.pos_guest($1,$2) id', [null, phone]);
    // Функция возвращает id гостя для ЛЮБОГО телефона платформы — ресепшн может перебором
    // телефонов узнавать, пользуется ли человек «Бильярдумом» (ПДн, 152-ФЗ). По дизайну №117,
    // но это межклубное раскрытие существования, ограниченное ролью персонала.
    assert.equal(r.rows[0].id, guest, 'существование чужого гостя раскрыто');
    const unknown = await c.query('select bl.pos_guest($1,$2) id', [null, '+79990008877']);
    assert.equal(unknown.rows[0].id, null, 'незарегистрированный телефон — NULL (оракул существования)');
  });
});

test('pos_guest: не персоналу клуба — NULL (роль обязательна)', async () => {
  const phone = '+79001113344';
  const guest = await makeGuest({ phone });
  // Сам гость в своём личном контексте не может искать себя как «персонал».
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: guest }, async (c) => {
    const r = await c.query('select bl.pos_guest($1,$2) id', [guest, null]);
    assert.equal(r.rows[0].id, null, 'не член клуба → NULL');
  });
  // Персонал клуба B не найдёт гостя под контекстом клуба B? Найдёт (гость платформенный),
  // но реальная граница — роль в клубе КОНТЕКСТА: owner B под контекстом клуба A (не его клуб) — NULL.
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_B }, async (c) => {
    const r = await c.query('select bl.pos_guest($1,$2) id', [guest, null]);
    assert.equal(r.rows[0].id, null, 'персонал другого клуба под контекстом A → NULL');
  });
});

test('pos_guest: гость без согласия или влитый в другую учётку — NULL (152-ФЗ)', async () => {
  const noConsent = await makeGuest({ phone: '+79002220011', consent: false });
  const merged = await makeGuest({ phone: '+79002220022', merged: true });
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: RECEPTION_A }, async (c) => {
    assert.equal((await c.query('select bl.pos_guest($1,$2) id', [noConsent, null])).rows[0].id, null, 'без согласия → NULL');
    assert.equal((await c.query('select bl.pos_guest($1,$2) id', [merged, null])).rows[0].id, null, 'влитый → NULL');
  });
});

// ── приглашения персонала: эскалация роли и клуба ────────────────────────────────────────────

test('staff_invites: роль owner запрещена на уровне БД (нет эскалации до владельца)', async () => {
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) =>
      c.query(`insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,'+79007770001','owner',$2, now()+interval '7 days')`, [CLUB_A, OWNER_A])),
    (e) => e.code === '23514',
    'роль owner → check_violation',
  );
});

test('staff_accept_invites: гость принимает только приглашение на СВОЙ телефон; чужое не захватить', async () => {
  const victimPhone = '+79008880001';
  const attacker = await makeGuest({ phone: '+79008880002' });
  // Владелец A приглашает жертву (её телефон).
  await pool.query(
    `insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,$2,'reception',$3, now()+interval '7 days')`,
    [CLUB_A, victimPhone, OWNER_A],
  );
  // Атакующий (другой номер) входит и пытается привязать приглашения.
  await asRole(pool, 'app_api', { clubId: null, userId: attacker }, async (c) => {
    const bound = await c.query('select * from bl.staff_accept_invites()');
    assert.equal(bound.rowCount, 0, 'приглашение на чужой телефон не привязалось');
  });
  // Проверяем, что членство атакующему не создано.
  const m = await pool.query('select 1 from bl.club_members where user_id = $1 and club_id = $2', [attacker, CLUB_A]);
  assert.equal(m.rowCount, 0, 'членство по чужому приглашению не создано');
});

test('staff_accept_invites: привязывает приглашение на свой телефон и создаёт членство', async () => {
  const phone = '+79009990001';
  const user = await makeGuest({ phone });
  await pool.query(
    `insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,$2,'manager',$3, now()+interval '7 days')`,
    [CLUB_A, phone, OWNER_A],
  );
  const bound = await asAppCommit({ userId: user }, (c) => c.query('select * from bl.staff_accept_invites()'));
  assert.equal(bound.rowCount, 1, 'своё приглашение привязалось');
  assert.equal(bound.rows[0].role, 'manager');
  const m = await pool.query('select role, active from bl.club_members where user_id = $1 and club_id = $2', [user, CLUB_A]);
  assert.equal(m.rows[0].role, 'manager');
  assert.equal(m.rows[0].active, true);
});

test('staff_revoke: владельца отозвать нельзя (42501)', async () => {
  await assert.rejects(
    () => asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, (c) => c.query('select bl.staff_revoke($1)', [OWNER_A])),
    (e) => e.code === '42501',
    'owner → 42501',
  );
});

test('staff_revoke гасит членство, PIN и ВСЕ токены сотрудника (в т.ч. PIN-токены терминалов), повторное принятие не возвращает доступ', async () => {
  const phone = '+79010000001';
  const user = await makeGuest({ phone });
  // Сотрудник принят по приглашению (членство создано).
  await pool.query(`insert into bl.staff_invites (club_id, phone, role, invited_by, expires_at) values ($1,$2,'reception',$3, now()+interval '7 days')`, [CLUB_A, phone, OWNER_A]);
  await asAppCommit({ userId: user }, (c) => c.query('select bl.staff_accept_invites()'));
  // PIN на терминале и личный токен сессии.
  await pool.query('update bl.club_members set pin_hash = $3 where club_id = $1 and user_id = $2', [CLUB_A, user, 'scrypt$16384$8$1$AAAA$BBBB']);
  const terminal = (await pool.query(`insert into bl.staff_terminals (club_id, name, token_hash, created_by, expires_at) values ($1,'касса',$2,$3, now()+interval '30 days') returning id`, [CLUB_A, token64(), OWNER_A])).rows[0].id;
  await pool.query(`insert into bl.auth_tokens (user_id, token_hash, kind, expires_at) values ($1,$2,'session', now()+interval '30 days')`, [user, token64()]);
  await pool.query(`insert into bl.auth_tokens (user_id, token_hash, kind, club_id, terminal_id, expires_at) values ($1,$2,'pin',$3,$4, now()+interval '12 hours')`, [user, token64(), CLUB_A, terminal]);

  const n = await asAppCommit({ clubId: CLUB_A, userId: OWNER_A }, async (c) => (await c.query('select bl.staff_revoke($1) n', [user])).rows[0].n);
  assert.ok(n >= 2, `отозвано токенов ${n} (сессия + PIN терминала)`);

  const m = await pool.query('select active, pin_hash from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, user]);
  assert.equal(m.rows[0].active, false, 'членство погашено');
  assert.equal(m.rows[0].pin_hash, null, 'PIN стёрт');
  const live = await pool.query('select count(*)::int n from bl.auth_tokens where user_id = $1 and revoked_at is null', [user]);
  assert.equal(live.rows[0].n, 0, 'ни одного живого токена (включая PIN-токен терминала)');

  // Повторный вход после отзыва: открытого приглашения нет (прежнее принято) — доступ не возвращается.
  const again = await asAppCommit({ userId: user }, (c) => c.query('select * from bl.staff_accept_invites()'));
  assert.equal(again.rowCount, 0, 'повторное принятие после отзыва ничего не привязывает');
  const after2 = await pool.query('select active from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, user]);
  assert.equal(after2.rows[0].active, false, 'членство осталось погашенным');
});

// ── notify_route: без телефона ───────────────────────────────────────────────────────────────

test('notify_route не отдаёт телефон пользователя', async () => {
  await asRole(pool, 'app_api', { clubId: CLUB_A, userId: OWNER_A }, async (c) => {
    const { fields } = await c.query('select * from bl.notify_route($1)', [OWNER_A]);
    const names = fields.map((f) => f.name);
    assert.ok(!names.includes('phone'), 'в результате нет столбца phone');
    assert.deepEqual(names.sort(), ['channels_order', 'max_user_id', 'notify_channel', 'telegram_user_id', 'user_id'].sort());
  });
});

// ── booking_due / summary_clubs: межклубные, только планировщику ──────────────────────────────

test('booking_due и summary_clubs доступны только app_api (планировщик) — public лишён права', async () => {
  for (const fn of ['booking_due(timestamptz,interval,interval,integer)', 'summary_clubs()', 'staff_revoke(uuid)', 'pos_guest(uuid,text)', 'staff_accept_invites()']) {
    const name = fn.split('(')[0];
    const r = await pool.query(
      `select has_function_privilege('public', 'bl.${fn}', 'execute') pub, has_function_privilege('app_api', 'bl.${fn}', 'execute') app`,
    );
    assert.equal(r.rows[0].pub, false, `${name}: public без execute`);
    assert.equal(r.rows[0].app, true, `${name}: app_api с execute`);
  }
});
