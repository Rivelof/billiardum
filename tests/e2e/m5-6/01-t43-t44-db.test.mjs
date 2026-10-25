// T43 (прогноз и подсказки) и порог/уведомления T44 — на СВОЁМ временном Postgres, не на стенде:
// на стенде нет 8 недель истории (клуб сида — с 21.10), а новые клубы tester без контроллеров не играют.
//
// Независимо от server/maintenance/test/db/m56.test.mjs: своя синтетическая история (другая сетка
// часов, разная загрузка по неделям — медиана не равна среднему, праздник клуба в среду, очередь в
// половине суббот, значения ровно на порогах HINTS) и свой расчёт ожидаемого — из списка своих игр
// в памяти, а не из bl.stats_hourly. Агрегаты суток считает настоящий планировщик дашборда,
// уведомления о пороге — настоящий планировщик обслуживания; ответы — настоящий HTTP API.
//
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:<порт>/postgres \
//     node --test --test-concurrency=1 tests/e2e/m5-6/01-t43-t44-db.test.mjs
//
// DATABASE_ADMIN_URL обязателен (иначе supabase/lib/db.mjs читает .env стенда — тест тогда пропускается).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STATE_DIR } from './lib.mjs';

const SKIP = process.env.DATABASE_ADMIN_URL ? false : 'нужен DATABASE_ADMIN_URL своего временного Postgres';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const MANAGER = 'a1000000-0000-4000-8000-000000000003';
const G1 = 'a9000000-0000-4000-8000-0000000000b1';
const TZ = 'Asia/Yekaterinburg';
const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
const OPEN = Array.from({ length: 12 }, (_, i) => 10 + i); // 10:00–22:00

let t;
let mods;
const tokens = {};
const now = new Date();
let today;
let winFrom;
let winTo;
let holiday;
/** Мои игры: day → hour → минуты (все игры начинаются в hh:00 и не выходят из часа). */
const plan = new Map();

const r1 = (x) => Math.round(x * 10) / 10;
function median(list) {
  const a = [...list].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Мой план загрузки (минуты в часе h суток d). */
function minutesOf(d, weekIdx, dow, isHoliday) {
  const out = {};
  if (isHoliday || dow === 7) {
    for (const h of OPEN) out[h] = 30;
    out[21] = 60;
    if (isHoliday) out[14] = 45;
    return out;
  }
  if (dow === 6) {
    for (const h of OPEN) out[h] = 30;
    out[20] = 51; // 85,0 % — ровно порог HIGH_PCT, подсказки нет
    out[21] = 51;
    return out;
  }
  out[10] = 5 * weekIdx; // 0…35 минут по неделям — медиана не равна среднему
  out[11] = 10; // 16,7 % — но только 2 часа подряд (LOW_MIN_HOURS = 3), подсказки нет
  out[12] = 10;
  out[13] = 30;
  out[14] = 11; // 18,3 % три часа подряд — «дневная цена»
  out[15] = 11;
  out[16] = 11;
  out[17] = 12; // 20,0 % — ровно порог LOW_PCT, не входит
  out[18] = 12;
  out[19] = 40;
  out[20] = dow === 5 ? 52 : 40; // пятница 86,7 % два часа — «можно поднять цену»
  out[21] = dow === 5 ? 52 : 40;
  return out;
}

async function session(resource, from, to, { status = 'closed' } = {}) {
  await t.admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, $4, 'qr', $5, $6, $7, $7, 'expired', $6, $7)`,
    [randomUUID(), CLUB, resource, status, G1, from, to],
  );
}

before(async () => {
  if (SKIP) return;
  const helpers = await import('../../../server/test/db/helpers.mjs');
  const { loadRoutes } = await import('../../../api/router.mjs');
  mods = {
    dashCache: (await import('../../../api/routes/dashboard.mjs')).cache,
    forecastCache: (await import('../../../api/routes/forecast.mjs')).cache,
    dashboardTick: (await import('../../../server/dashboard/index.mjs')).tick,
    maintenanceTick: (await import('../../../server/maintenance/index.mjs')).tick,
    time: await import('../../../server/dashboard/time.mjs'),
  };
  const { addDays, isoDow, workingDayOf, zonedTime } = mods.time;
  today = workingDayOf(now, TZ, '06:00');
  winFrom = addDays(today, -56);
  winTo = addDays(today, -1);
  t = await helpers.startTestApp({ routes: await loadRoutes({ only: [...helpers.CORE_ROUTE_FILES, 'dashboard.mjs', 'forecast.mjs', 'maintenance.mjs', 'cashbook.mjs'] }) });
  const q = (sql, p) => t.admin.query(sql, p);
  const L = (day, hhmm) => zonedTime(day, hhmm, TZ);
  const start = L(addDays(today, -80), '09:00');
  await q(`update bl.clubs set created_at = $2, went_live_at = null, settings = settings || '{"open_hours": {"open": "10:00", "close": "22:00"}}'::jsonb where id = $1`, [CLUB, start]);
  await q('update bl.resources set created_at = $2, active = (id = $3) where club_id = $1', [CLUB, start, T(1)]);
  await q(`insert into bl.users (id, phone, name) values ($1, '+79990000771', 'Гость E2E')`, [G1]);
  // Свой праздник клуба — среда в середине окна (идёт как воскресенье).
  holiday = addDays(today, -28);
  while (isoDow(holiday) !== 3) holiday = addDays(holiday, 1);
  await q(`insert into bl.holidays (club_id, day, kind, title) values ($1, $2, 'holiday', 'E2E день клуба')`, [CLUB, holiday]);
  const fed = await q('select day::text as day from bl.holidays where club_id is null and day between $1 and $2', [winFrom, winTo]);
  assert.deepEqual(fed.rows, [], 'в окне нет федеральных праздников (иначе ожидаемое — с их учётом)');
  for (let d = winFrom, i = 0; d <= winTo; d = addDays(d, 1), i += 1) {
    const weekIdx = Math.floor(i / 7);
    const dow = isoDow(d);
    const mins = minutesOf(d, weekIdx, dow, d === holiday);
    plan.set(d, mins);
    for (const [h, m] of Object.entries(mins)) {
      if (m <= 0) continue;
      const from = L(d, `${String(h).padStart(2, '0')}:00`);
      await session(T(1), from, new Date(from.getTime() + m * 60_000));
    }
    if (dow === 6 && weekIdx % 2 === 0) {
      for (const hhmm of ['18:10', '19:10']) {
        await q(`insert into bl.waitlist (club_id, resource_id, user_id, status, closed_at, close_reason, created_at, updated_at) values ($1, $2, $3, 'canceled', $4, 'guest', $4, $4)`, [CLUB, T(1), G1, L(d, hhmm)]);
      }
    }
  }
  // Для T44: игры столов 2–7 по 90 минут за 60 суток до сегодня — вне окна прогноза (56 суток).
  const early = addDays(today, -60);
  for (const n of [2, 3, 4, 5, 6, 7]) await session(T(n), L(early, '10:00'), L(early, '11:30'));
  const r = await mods.dashboardTick({ pool: t.pool, clock: { now: () => now }, daysPerClub: 200, restate: { perTick: 0 } });
  assert.ok(r.computed.filter((x) => x.club_id === CLUB).length >= 56, 'агрегаты 56 суток посчитаны');
  for (const [k, phone] of Object.entries({ owner: '+70000000001', manager: '+70000000003', reception: '+70000000004', ownerB: '+70000000002' })) {
    tokens[k] = (await t.login(phone)).token;
  }
});

after(async () => {
  await t?.stop();
});

const req = (method, path, who, body) => {
  mods.dashCache.clear();
  mods.forecastCache.clear();
  return t.request(method, path, { token: tokens[who], body, headers: method === 'POST' ? { 'idempotency-key': randomUUID() } : {} });
};

/** Мой прогноз из плана игр: ячейки 7×24 и сутки по дню недели. */
function expected() {
  const { isoDow } = mods.time;
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  const days = Array.from({ length: 7 }, () => []);
  for (const [d, mins] of plan) {
    const dow = d === holiday ? 7 : isoDow(d);
    let p = 0;
    for (const h of OPEN) {
      const m = mins[h] ?? 0;
      cells[dow - 1][h].push(Math.min(100, (m / 60) * 100));
      p += m;
    }
    days[dow - 1].push((p / (OPEN.length * 60)) * 100);
  }
  return {
    pct: cells.map((row) => row.map((l) => (l.length ? r1(median(l)) : null))),
    samples: cells.map((row) => row.map((l) => l.length)),
    days_pct: days.map((l) => r1(median(l))),
  };
}

describe('T43: прогноз и подсказки на синтетической истории 8 недель', { skip: SKIP }, () => {
  it('агрегаты планировщика = мой план игр (минуты по часам, ёмкость 60 в часы работы)', async (tt) => {
    const { rows } = await t.admin.query(
      'select day::text as day, hour, sum(play_minutes)::int as play, sum(capacity_minutes)::int as cap from bl.stats_hourly where club_id = $1 and day between $2 and $3 group by 1, 2',
      [CLUB, winFrom, winTo],
    );
    let bad = 0;
    for (const r of rows) {
      const m = plan.get(r.day)?.[r.hour] ?? 0;
      const cap = OPEN.includes(r.hour) ? 60 : 0;
      if (r.play !== m || r.cap !== cap) bad += 1;
    }
    assert.equal(bad, 0, 'расхождений по часам');
    assert.equal(rows.filter((r) => r.cap > 0).length, 56 * 12);
    tt.diagnostic(`stats_hourly: ${rows.length} строк, ёмкость 60 мин в 12 часах × 56 суток, минуты игры = план`);
  });

  it('прогноз «Зала» = медиана по дню недели × часу; праздник — в воскресенье; закрытые часы — null', async (tt) => {
    const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
    assert.equal(r.status, 200, r.text);
    const f = r.json.series.forecast;
    assert.ok(r.json.series.heatmap, 'тепловая карта рядом');
    assert.equal(f.status, 'ok');
    assert.equal(f.label, 'прогноз');
    assert.equal(f.from, winFrom);
    assert.equal(f.to, winTo);
    assert.equal(f.history_days, 56);
    const e = expected();
    assert.deepEqual(f.pct, e.pct);
    assert.deepEqual(f.samples, e.samples);
    assert.deepEqual(f.days_pct, e.days_pct);
    // Ручная сверка одной ячейки: будни, 10:00 — минуты 5 × номер недели.
    const { isoDow, addDays } = mods.time;
    const wed10 = [];
    for (let d = winFrom, i = 0; d <= winTo; d = addDays(d, 1), i += 1) if (isoDow(d) === 3 && d !== holiday) wed10.push(5 * Math.floor(i / 7));
    const manual = r1(median(wed10.map((m) => (m / 60) * 100)));
    assert.equal(f.pct[2][10], manual);
    assert.equal(f.samples[2][14], 7, 'среда без праздника — 7 суток');
    assert.equal(f.samples[6][14], 9, 'воскресенье + праздник — 9 суток');
    assert.equal(f.pct[2][14], 18.3);
    assert.equal(f.pct[6][14], 50, 'медиана 8 × 30 мин и 45 мин праздника');
    assert.equal(f.pct[0][9], null, 'клуб закрыт');
    assert.equal(f.pct[0][22], null, 'клуб закрыт');
    tt.diagnostic(`среда 10:00: минуты ${wed10.join(',')} → медиана ${manual} % = API ${f.pct[2][10]}; среда 14:00 ${f.pct[2][14]} % (7 суток), воскресенье 14:00 ${f.pct[6][14]} % (9 суток, с праздником ${holiday}); days_pct ${JSON.stringify(f.days_pct)}`);
  });

  it('подсказки по порогам HINTS: ровно на пороге — нет, за порогом — есть; порядок и тексты', async (tt) => {
    const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'manager');
    assert.equal(r.status, 200);
    const { isoDow, addDays } = mods.time;
    const weekStarts = new Set();
    for (let d = winFrom; d <= winTo; d = addDays(d, 1)) if (isoDow(d) <= 5 && d !== holiday) weekStarts.add(addDays(d, 1 - isoDow(d)));
    const wk = weekStarts.size;
    const wkWord = wk % 10 === 1 && wk % 100 !== 11 ? 'неделю' : [2, 3, 4].includes(wk % 10) && ![12, 13, 14].includes(wk % 100) ? 'недели' : 'недель';
    assert.deepEqual(
      r.json.hints.map((h) => h.text),
      [
        'В пятницу 20–22 загрузка 86,7 % за 8 недель — можно поднять цену',
        'В субботу 18–20 очередь в 4 из 8 дней (загрузка 50 %) — можно поднять цену',
        `В будни 14–17 загрузка 18,3 % за ${wk} ${wkWord} — подумайте о дневной цене`,
      ],
    );
    // Образец для браузерного сценария 06 (вкладка «Зал» с прогнозом и подсказками): ответ настоящего сервера.
    writeFileSync(path.join(STATE_DIR, 'forecast-fixture.json'), JSON.stringify({ forecast: r.json.series.forecast, hints: r.json.hints }), { mode: 0o600 });
    const [fri, sat, low] = r.json.hints;
    assert.deepEqual([fri.type, fri.days, fri.from_hour, fri.to_hour, fri.hours], ['raise_price', [5], 20, 22, 2]);
    assert.deepEqual([sat.days, sat.queue_days, sat.sample_days, sat.from_hour, sat.to_hour], [[6], 4, 8, 18, 20]);
    assert.deepEqual([low.type, low.days, low.from_hour, low.to_hour, low.utilization_pct], ['lower_price', [1, 2, 3, 4, 5], 14, 17, 18.3]);
    tt.diagnostic(`подсказки: ${r.json.hints.map((h) => `«${h.text}»`).join('; ')}. Нет: будни 11–13 (16,7 %, 2 часа < 3), будни 17–19 (20,0 % — не ниже 20), суббота 20–22 (85,0 % — не выше 85), воскресенье 21 (100 %, 1 час < 2)`);
  });

  it('цены не меняются: правила тарифа те же до и после расчёта подсказок', async () => {
    const a = await t.admin.query('select to_jsonb(r) as row from bl.tariff_rules r where club_id = $1 order by id', [CLUB]);
    assert.ok(a.rows.length > 0, 'у клуба есть правила тарифа');
    await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
    await req('GET', `/api/clubs/${CLUB}/forecast`, 'owner');
    const b = await t.admin.query('select to_jsonb(r) as row from bl.tariff_rules r where club_id = $1 order by id', [CLUB]);
    const audit = await t.admin.query("select count(*)::int as n from bl.audit_log where club_id = $1 and action like 'tariff%'", [CLUB]);
    assert.equal(audit.rows[0].n, 0, 'в журнале нет изменений тарифа');
    assert.deepEqual(b.rows, a.rows);
  });

  it('GET …/forecast?date= — праздник идёт строкой воскресенья; часы в порядке суток с 06:00; права', async () => {
    const h = await req('GET', `/api/clubs/${CLUB}/forecast?date=${holiday}`, 'owner');
    assert.equal(h.status, 200, h.text);
    assert.equal(h.json.iso_dow, 3);
    assert.equal(h.json.basis_dow, 7);
    assert.deepEqual(h.json.holiday, { title: 'E2E день клуба' });
    assert.equal(h.json.hours.length, 24);
    assert.equal(h.json.hours[0].hour, 6);
    assert.equal(h.json.hours.find((x) => x.hour === 21).pct, 100, 'воскресенье 21:00');
    assert.equal(h.json.day_pct, expected().days_pct[6]);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast?date=2026-13-01`, 'owner')).status, 400);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast?date=${mods.time.addDays(today, 400)}`, 'owner')).status, 400);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast`, 'reception')).status, 403);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast`, 'ownerB')).status, 403);
  });

  it('граница «мало данных»: 13 суток после go-live — insufficient_data и без подсказок, 14 — прогноз', async (tt) => {
    const { addDays, zonedTime } = mods.time;
    const out = [];
    try {
      for (const n of [13, 14]) {
        await t.admin.query('update bl.clubs set went_live_at = $2 where id = $1', [CLUB, zonedTime(addDays(today, -n), '12:00', TZ)]);
        const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
        const f = r.json.series.forecast;
        out.push(`${n} суток → ${f.status}, history_days ${f.history_days}, подсказок ${r.json.hints.length}`);
        assert.equal(f.history_days, n);
        if (n === 13) {
          assert.equal(f.status, 'insufficient_data');
          assert.equal(f.enough, false);
          assert.equal(f.pct, null);
          assert.deepEqual(r.json.hints, []);
          const d = await req('GET', `/api/clubs/${CLUB}/forecast`, 'owner');
          assert.equal(d.json.status, 'insufficient_data');
          assert.ok(d.json.hours.every((x) => x.pct === null));
        } else {
          assert.equal(f.status, 'ok');
          assert.equal(f.from, addDays(today, -14));
        }
      }
    } finally {
      await t.admin.query('update bl.clubs set went_live_at = null where id = $1', [CLUB]);
    }
    tt.diagnostic(out.join('; '));
  });

  it('клуб в режиме test — прогноза нет (insufficient_data, окна нет)', async () => {
    await t.admin.query("update bl.clubs set mode = 'test' where id = $1", [CLUB]);
    try {
      const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
      assert.equal(r.json.series.forecast.status, 'insufficient_data');
      assert.equal(r.json.series.forecast.history_days, 0);
      assert.deepEqual(r.json.hints, []);
    } finally {
      await t.admin.query("update bl.clubs set mode = 'live' where id = $1", [CLUB]);
    }
  });
});

describe('T44: порог, уведомления (не больше 5 в сутки), не тревога', { skip: SKIP }, () => {
  it('7 столов за порогом: 4 отдельных уведомления + 1 свёрнутое «ещё у 3 столов» владельцу и управляющему; тревог нет; повтор — тихо', async (tt) => {
    const mins = 90;
    // Столы 2–7 в работу (их игры — за 60 суток до сегодня, в агрегатах закрытых суток).
    await t.admin.query('update bl.resources set active = true where club_id = $1 and id = any($2::uuid[])', [CLUB, [2, 3, 4, 5, 6, 7].map(T)]);
    const m0 = (await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner')).json;
    const c2 = m0.counters.find((x) => x.resource_id === T(2)).kinds.cloth;
    assert.equal(c2.minutes, mins, 'счётчик стола 2 = минуты его игры (stats_hourly закрытых суток)');
    assert.equal(c2.since, null);
    const c1 = m0.counters.find((x) => x.resource_id === T(1)).kinds.cloth;
    const planned = [...plan.values()].reduce((a, h) => a + Object.values(h).reduce((x, y) => x + y, 0), 0);
    assert.equal(c1.minutes, planned, 'счётчик стола 1 = все минуты 8 недель');
    const put = await req('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, 'owner', { cloth: 1 });
    assert.equal(put.status, 200, put.text);
    const alarms0 = (await t.admin.query('select count(*)::int as n from bl.alarms where club_id = $1', [CLUB])).rows[0].n;
    const r = await mods.maintenanceTick({ pool: t.pool, clock: { now: () => new Date() } });
    const mine = r.notified.filter((x) => x.club_id === CLUB);
    const notes = async (user) => (await t.admin.query("select text, level from bl.notifications where club_id = $1 and user_id = $2 and kind = 'maintenance.due' order by created_at, text", [CLUB, user])).rows;
    const o = await notes(OWNER);
    const m = await notes(MANAGER);
    assert.equal(o.length, 5, `владельцу: ${o.map((x) => x.text).join(' | ')}`);
    assert.equal(m.length, 5);
    const folded = o.filter((x) => /^Обслуживание: порог достигнут ещё у 3 столов — /.test(x.text));
    assert.equal(folded.length, 1, 'одно свёрнутое на 3 стола');
    assert.equal(o.filter((x) => /^Стол \d: пора — замена сукна\. Сыграно /.test(x.text)).length, 4);
    assert.ok(o.every((x) => x.level === 'info'), 'уровень info');
    assert.equal((await t.admin.query('select count(*)::int as n from bl.alarms where club_id = $1', [CLUB])).rows[0].n, alarms0, 'не тревога');
    const alerts = (await t.admin.query("select count(*)::int as n, count(*) filter (where notified)::int as nn from bl.maintenance_alerts where club_id = $1 and kind = 'cloth'", [CLUB])).rows[0];
    assert.equal(alerts.n, 7, 'отметки у всех 7 столов');
    const recep = (await t.admin.query("select count(*)::int as n from bl.notifications where club_id = $1 and user_id = 'a1000000-0000-4000-8000-000000000004' and kind like 'maintenance.%'", [CLUB])).rows[0].n;
    assert.equal(recep, 0, 'ресепшну — нет');
    const r2 = await mods.maintenanceTick({ pool: t.pool, clock: { now: () => new Date() } });
    assert.equal(r2.notified.filter((x) => x.club_id === CLUB).length, 0);
    assert.equal((await notes(OWNER)).length, 5);
    const due = (await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner')).json.counters.filter((x) => x.kinds.cloth.due).map((x) => x.number);
    assert.deepEqual(due, [1, 2, 3, 4, 5, 6, 7]);
    // Период — прошлая неделя: за «сегодня» до открытия клуба (10:00) в «Столах» строк нет (нет ёмкости и игр).
    const hallToday = (await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner')).json.tables.by_resource;
    const hall = (await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0&from=${mods.time.addDays(today, -7)}&to=${mods.time.addDays(today, -1)}`, 'owner')).json.tables.by_resource;
    tt.diagnostic(`«Столы» за сегодня: строк ${hallToday.length}, за прошлую неделю: ${hall.length}`);
    assert.equal(hall.find((x) => x.resource_id === T(1)).cloth_due, true);
    assert.equal(hall.find((x) => x.resource_id === T(1)).cloth_hours, c1.hours);
    tt.diagnostic(`отметок ${alerts.n}, с уведомлением ${alerts.nn}, событий ${mine.length}; владельцу 5: ${o.map((x) => `«${x.text.slice(0, 70)}»`).join(' ')}`);
  });

  it('смена порогов управляющим — уведомление владельцу (important, не тревога) с «было → стало»', async () => {
    const before = (await t.admin.query("select count(*)::int as n from bl.notifications where club_id = $1 and user_id = $2 and kind = 'maintenance.thresholds'", [CLUB, OWNER])).rows[0].n;
    const r = await req('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, 'manager', { cloth: 1500, leveling: 200 });
    assert.equal(r.status, 200, r.text);
    const n = (await t.admin.query("select text, level from bl.notifications where club_id = $1 and user_id = $2 and kind = 'maintenance.thresholds' order by created_at", [CLUB, OWNER])).rows;
    assert.equal(n.length, before + 1);
    assert.match(n.at(-1).text, /^Обслуживание: .+ изменил пороги — сукно 1 ч → 1\s500 ч, выравнивание без порога → 200 ч\.$/u);
    assert.equal(n.at(-1).level, 'important');
    const audit = (await t.admin.query("select data from bl.audit_log where club_id = $1 and action = 'maintenance.thresholds_update' order by seq desc limit 1", [CLUB])).rows[0].data;
    assert.equal(audit.before.cloth, 1);
    assert.equal(audit.after.cloth, 1500);
  });
});
