// PoC уведомлений и доступности без входа (контракт M3 §1 п. 7, §4; decisions №53, №110):
//   * actions в уведомлении: url — только путь своего сайта; javascript:, внешний хост,
//     протокол-относительный //, обратный слэш, CRLF — отвергаются (нет открытого редиректа
//     и XSS через кнопку уведомления);
//   * тексты и сводка — без телефонов (маскирование длинных номеров);
//   * GET /api/clubs/{club}/availability (без входа) не содержит ПДн брони (имя/телефон).
//
// Запуск notify-части (без БД): node --test tests/security/m3/notify_actions.test.mjs
// Availability требует DATABASE_ADMIN_URL.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cleanActions, maskPhones, sanitizeText } from '../../../server/notify/index.mjs';
import { summaryText } from '../../../server/summaries/index.mjs';

// ── actions: только безопасные локальные ссылки ──────────────────────────────────────────────

test('cleanActions принимает только относительный путь своего сайта', () => {
  const ok = cleanActions([{ id: 'open', title: 'Моя бронь', url: '/app/bookings/x' }]);
  assert.equal(ok[0].url, '/app/bookings/x');
  const noUrl = cleanActions([{ id: 'accept', title: 'Занять стол' }]);
  assert.equal(noUrl[0].url, undefined, 'действие без url допустимо');
});

test('cleanActions отвергает javascript:, внешние и обманные URL (нет XSS/открытого редиректа)', () => {
  const evil = [
    'javascript:alert(1)',
    'https://evil.example/phish',
    'http://evil.example',
    '//evil.example',
    '/\\evil.example',
    '/app ', // пробел
    '/app"onmouseover=1',
    '/app<script>',
    'data:text/html,abc',
    'app/relative-no-slash',
    '\n/app',
  ];
  for (const url of evil) {
    assert.throws(
      () => cleanActions([{ id: 'open', title: 'Клик', url }]),
      /action url/,
      `URL должен быть отвергнут: ${JSON.stringify(url)}`,
    );
  }
});

test('cleanActions ограничивает число и форму действий', () => {
  assert.throws(() => cleanActions(Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: 't' }))), /actions/);
  assert.throws(() => cleanActions([{ id: 'ПЛОХОЙ ID', title: 't' }]), /action/);
  assert.throws(() => cleanActions([{ id: 'ok', title: '' }]), /action/);
});

test('cleanActions маскирует телефон в заголовке действия', () => {
  const a = cleanActions([{ id: 'open', title: 'Звоните +7 912 345-67-89' }]);
  assert.ok(!/\d{10}/.test(a[0].title.replace(/\D/g, '')) || a[0].title.includes('***'), 'номер в title замаскирован');
  assert.ok(a[0].title.includes('***'));
});

// ── тексты и сводка без ПДн ───────────────────────────────────────────────────────────────────

test('sanitizeText и maskPhones скрывают телефоны, но не суммы/даты/хеши', () => {
  assert.equal(maskPhones('Звонок с +7 912 345-67-89 сегодня'), 'Звонок с *** сегодня');
  assert.equal(maskPhones('Выручка 1 490 ₽'), 'Выручка 1 490 ₽', 'короткие числа (суммы) не трогаются');
  const hash = 'a'.repeat(64);
  assert.ok(sanitizeText(`Журнал: хеш ${hash}`).includes(hash), 'хеш головы журнала не маскируется');
});

test('summaryText владельцу не содержит ПДн (только агрегаты и хеш)', () => {
  const data = {
    day: '2026-10-21', timezone: 'Asia/Yekaterinburg',
    revenue: { by_method: { sbp: 120000, cash: 50000 }, total_kopecks: 170000, refunds_kopecks: 0, net_kopecks: 170000 },
    play: { sessions: 12, minutes: 600, hours: 10, utilization_percent: 42, resources: 8 },
    alarms: { critical: 0, important: 1, info: 2, total: 3 },
    manual_actions: { count: 2, by_action: {} },
    journal: { head_seq: 390, head_hash: 'f'.repeat(64) },
  };
  const txt = summaryText(data);
  assert.ok(!/\+?\d{10,}/.test(txt.replace(/[a-f]{64}/g, '')), 'в сводке нет телефонов');
  assert.ok(txt.includes('f'.repeat(64)), 'хеш головы журнала есть');
  assert.ok(txt.includes('выручка'));
});

// ── availability без входа: нет ПДн брони ─────────────────────────────────────────────────────

let mod = null;
let db = null;
let pool = null;

before(async () => {
  if (!process.env.DATABASE_ADMIN_URL) return;
  const helpers = await import('../../../supabase/tests/helpers.mjs');
  const tariffs = await import('../../../server/tariffs/index.mjs');
  const engine = await import('../../../server/tariffs/engine.mjs');
  const avail = await import('../../../server/bookings/availability.mjs');
  db = await helpers.createTestDatabase();
  pool = db.pool;
  const CLUB_A = helpers.CLUB_A;
  const RES_A = 'e1000000-0000-4000-8000-000000000001';
  // Бронь по телефону с ПДн (имя и телефон) в ближайшие часы.
  await pool.query(
    `insert into bl.bookings (club_id, resource_id, guest_name, guest_phone, source, starts_at, ends_at, status,
                              prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at)
     values ($1,$2,'Иван Секретный','+79991234567','phone', now()+interval '2 hours', now()+interval '3 hours',
             'confirmed','none',150000,15,now(),now())`,
    [CLUB_A, RES_A],
  );
  const deps = { tariffs: { tariffContext: tariffs.tariffContext }, engine: { ruleAt: engine.ruleAt } };
  const env = { deps, clock: { now: () => new Date() }, log: { warn() {} } };
  // Контекст клуба (как у анонимного маршрута с {club}) через короткую транзакцию app_api.
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role app_api');
    await c.query("select set_config('app.club_id',$1,true)", [CLUB_A]);
    mod = await avail.availability(c, env, { clubId: CLUB_A });
    await c.query('commit');
  } finally {
    await c.query('reset role').catch(() => {});
    c.release();
  }
});

after(async () => {
  await db?.drop();
});

test('availability (без входа) не раскрывает имя или телефон брони', { skip: !process.env.DATABASE_ADMIN_URL ? 'нужен DATABASE_ADMIN_URL' : false }, () => {
  assert.ok(mod, 'availability вернул результат');
  const json = JSON.stringify(mod);
  assert.ok(!json.includes('Иван Секретный'), 'имени гостя нет в ответе');
  assert.ok(!json.includes('79991234567') && !json.includes('+7999'), 'телефона гостя нет в ответе');
  // Если бронь попала в окно рабочих суток, она видна как занятость — но только {from,to,kind},
  // без ПДн (попадание зависит от времени суток клуба; главное — отсутствие ПДн выше, оно строго).
  for (const r of mod.resources) {
    for (const b of r.busy) assert.deepEqual(Object.keys(b).sort(), ['from', 'kind', 'to'], 'в занятости только from/to/kind');
  }
});
