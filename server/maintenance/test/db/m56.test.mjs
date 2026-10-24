// M5.6 на базе: T43 (прогноз на синтетической истории 8 недель = расчёт, подсказки по порогам) и
// T44 (обслуживание: событие, счётчик, порог, уведомление, расход в кассе, права, изоляция клубов).
//
// История: 8 недель игр клуба сида (2 стола в работе, часы работы 10:00–02:00), агрегаты суток
// считает настоящий планировщик дашборда; свой праздник клуба — среда в окне.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache as dashCache } from '../../../../api/routes/dashboard.mjs';
import { cache as forecastCache } from '../../../../api/routes/forecast.mjs';
import { seedClubB, CLUB_B } from '../../../../supabase/tests/helpers.mjs';
import { tick as dashboardTick } from '../../../dashboard/index.mjs';
import { tick as maintenanceTick } from '../../index.mjs';
import { medianOf } from '../../../dashboard/forecast.mjs';
import { addDays, dayBounds, isoDow, workingDayOf, zonedTime } from '../../../dashboard/time.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const MANAGER = 'a1000000-0000-4000-8000-000000000003';
const G1 = 'a9000000-0000-4000-8000-0000000000a1';
const TZ = 'Asia/Yekaterinburg';
const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
const L = (day, hhmm) => zonedTime(day, hhmm, TZ);
const plus = (d, min) => new Date(d.getTime() + min * 60_000);

let t;
const tokens = {};
const now = new Date();
const today = workingDayOf(now, TZ, '06:00');
const winFrom = addDays(today, -56);
const winTo = addDays(today, -1);
let holiday;
let liveMinutes;

async function session(resource, from, to, { admin = t.admin } = {}) {
  await admin.query(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [randomUUID(), CLUB, resource, G1, from, to],
  );
}

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs', 'forecast.mjs', 'maintenance.mjs', 'cashbook.mjs'] }) });
  const q = (sql, p) => t.admin.query(sql, p);
  await seedClubB(t.admin);
  const start = L(addDays(today, -70), '12:00');
  await q(`update bl.clubs set created_at = $2, settings = settings || '{"open_hours": {"open": "10:00", "close": "02:00"}}'::jsonb where id = $1`, [CLUB, start]);
  await q('update bl.resources set created_at = $2, active = (number <= 2) where club_id = $1', [CLUB, start]);
  await q(`insert into bl.users (id, phone, name) values ($1, '+79990000001', 'Гость 1')`, [G1]);
  // Свой праздник клуба — среда в окне истории.
  holiday = addDays(today, -21);
  while (isoDow(holiday) !== 3) holiday = addDays(holiday, 1);
  await q(`insert into bl.holidays (club_id, day, kind, title) values ($1, $2, 'holiday', 'День клуба')`, [CLUB, holiday]);
  for (let d = winFrom; d <= winTo; d = addDays(d, 1)) {
    const dow = d === holiday ? 7 : isoDow(d);
    const next = addDays(d, 1);
    if (dow <= 5) {
      await session(T(1), L(d, '10:00'), L(d, '14:00'));
      for (const h of ['14', '15', '16']) await session(T(1), L(d, `${h}:00`), L(d, `${h}:15`));
      await session(T(1), L(d, '17:00'), L(next, '02:00'));
      if (dow === 5) await session(T(2), L(d, '20:00'), L(d, '23:00'));
    } else {
      await session(T(1), L(d, '10:00'), L(next, '02:00'));
    }
    if (dow === 6) {
      for (const hhmm of ['21:10', '22:10']) {
        await q(`insert into bl.waitlist (club_id, resource_id, user_id, status, closed_at, close_reason, created_at, updated_at) values ($1, $2, $3, 'canceled', $4, 'guest', $4, $4)`, [CLUB, T(2), G1, L(d, hhmm)]);
      }
    }
  }
  // Тестовая игра (клуб на минуту в test): в агрегаты и прогноз не входит.
  const wed = addDays(winTo, -((isoDow(winTo) + 4) % 7));
  await q(`update bl.clubs set mode = 'test' where id = $1`, [CLUB]);
  await session(T(2), L(wed, '14:00'), L(wed, '17:00'));
  await q(`update bl.clubs set mode = 'live' where id = $1`, [CLUB]);
  assert.equal((await q('select count(*)::int as n from bl.sessions where club_id = $1 and is_test', [CLUB])).rows[0].n, 1);
  // Игра сегодня (для счётчика текущих суток): до часа с начала суток.
  const ds = dayBounds(today, TZ, '06:00').from;
  liveMinutes = Math.max(0, Math.min(60, Math.floor((now - ds) / 60_000) - 1));
  if (liveMinutes > 0) await session(T(1), ds, plus(ds, liveMinutes));
  // Агрегаты закрытых суток — планировщиком дашборда.
  const r = await dashboardTick({ pool: t.pool, clock: { now: () => now }, daysPerClub: 200, restate: { perTick: 0 } });
  assert.ok(r.computed.filter((x) => x.club_id === CLUB).length >= 56);
  for (const [k, phone] of Object.entries({ owner: '+70000000001', ownerB: '+70000000002', manager: '+70000000003', reception: '+70000000004' })) {
    tokens[k] = (await t.login(phone)).token;
  }
});

after(async () => {
  await t?.stop();
});

const req = (method, path, who, body, key) => {
  dashCache.clear();
  forecastCache.clear();
  return t.request(method, path, { token: tokens[who], body, headers: key ? { 'idempotency-key': key } : {} });
};
const post = (path, who, body) => req('POST', path, who, body, randomUUID());

/** Независимый расчёт прогноза по stats_hourly (суперпользователь). */
async function expectedForecast() {
  const { rows } = await t.admin.query(
    `select h.day::text as day, h.hour, sum(h.play_minutes)::int as play, sum(h.capacity_minutes)::int as cap
       from bl.stats_hourly h where h.club_id = $1 and h.day between $2 and $3 group by 1, 2`,
    [CLUB, winFrom, winTo],
  );
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (const r of rows) {
    if (r.cap <= 0) continue;
    const dow = r.day === holiday ? 7 : isoDow(r.day);
    cells[dow - 1][r.hour].push(Math.min(100, (r.play / r.cap) * 100));
  }
  return cells.map((row) => row.map((l) => (l.length ? Math.round(medianOf(l) * 10) / 10 : null)));
}

describe('T43: прогноз и подсказки', () => {
  it('прогноз на вкладке «Зал» = медиана по stats_hourly за 8 недель; праздник клуба — воскресенье; is_test не входит', async () => {
    const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
    assert.equal(r.status, 200, r.text);
    const f = r.json.series.forecast;
    assert.ok(r.json.series.heatmap, 'рядом с тепловой картой');
    assert.equal(f.status, 'ok');
    assert.equal(f.label, 'прогноз');
    assert.equal(f.from, winFrom);
    assert.equal(f.to, winTo);
    assert.equal(f.history_days, 56);
    assert.deepEqual(f.pct, await expectedForecast());
    assert.equal(f.pct[2][14], 12.5, 'среда 14:00 — без тестовой игры и праздника');
    assert.equal(f.samples[2][14], 7);
    assert.equal(f.samples[6][14], 9);
    assert.equal(f.pct[4][20], 100);
    assert.equal(f.pct[6][12], 50);
    assert.equal(f.pct[0][8], null, 'клуб закрыт');
  });

  it('подсказки по порогам: будни 14–17, пятница 20–23, суббота 21–23 очередь', async () => {
    const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'manager');
    assert.deepEqual(r.json.hints.map((h) => h.text), [
      'В пятницу 20–23 загрузка 100 % за 8 недель — можно поднять цену',
      'В субботу 21–23 очередь в 8 из 8 дней (загрузка 50 %) — можно поднять цену',
      'В будни 14–17 загрузка 12,5 % за 8 недель — подумайте о дневной цене',
    ]);
    assert.deepEqual(r.json.hints.map((h) => h.type), ['raise_price', 'raise_price', 'lower_price']);
  });

  it('GET …/forecast?date= — сутки по дню недели, праздник — строка воскресенья', async () => {
    const h = await req('GET', `/api/clubs/${CLUB}/forecast?date=${holiday}`, 'owner');
    assert.equal(h.status, 200, h.text);
    assert.equal(h.json.basis_dow, 7);
    assert.deepEqual(h.json.holiday, { title: 'День клуба' });
    assert.equal(h.json.hours.find((x) => x.hour === 14).pct, 50);
    assert.equal(h.json.hours[0].hour, 6);
    let fri = today;
    while (isoDow(fri) !== 5) fri = addDays(fri, 1);
    const f = await req('GET', `/api/clubs/${CLUB}/forecast?date=${fri}`, 'manager');
    assert.equal(f.json.basis_dow, 5);
    assert.equal(f.json.hours.find((x) => x.hour === 20).pct, 100);
    assert.equal(f.json.holiday, null);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast?date=2026-02-30`, 'owner')).status, 400);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast?kind=x`, 'owner')).status, 400);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast`, 'reception')).status, 403);
    assert.equal((await req('GET', `/api/clubs/${CLUB}/forecast`, 'ownerB')).status, 403);
  });

  it('история меньше двух недель (клуб в live 10 суток) — «мало данных», подсказок нет', async () => {
    await t.admin.query('update bl.clubs set went_live_at = $2 where id = $1', [CLUB, L(addDays(today, -10), '12:00')]);
    try {
      const r = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
      assert.equal(r.json.series.forecast.status, 'insufficient_data');
      assert.equal(r.json.series.forecast.history_days, 10);
      assert.equal(r.json.series.forecast.pct, null);
      assert.deepEqual(r.json.hints, []);
      const d = await req('GET', `/api/clubs/${CLUB}/forecast`, 'owner');
      assert.equal(d.json.status, 'insufficient_data');
    } finally {
      await t.admin.query('update bl.clubs set went_live_at = null where id = $1', [CLUB]);
    }
  });
});

/** Минуты игры стола с начала суток day (агрегаты) + сегодняшняя игра. */
async function playSince(resource, day) {
  const { rows } = await t.admin.query('select coalesce(sum(play_minutes), 0)::int as m from bl.stats_hourly where club_id = $1 and resource_id = $2 and day >= $3', [CLUB, resource, day]);
  return rows[0].m + liveMinutes;
}

describe('T44: обслуживание столов', () => {
  let ev;
  const D = addDays(today, -7);

  it('ресепшн — 403, чужой клуб — 403, стол чужого клуба — 404', async () => {
    for (const [m, p] of [['GET', 'maintenance'], ['POST', 'maintenance'], ['GET', 'maintenance/thresholds'], ['PUT', 'maintenance/thresholds']]) {
      const r = m === 'POST' ? await post(`/api/clubs/${CLUB}/${p}`, 'reception', {}) : await req(m, `/api/clubs/${CLUB}/${p}`, 'reception', m === 'PUT' ? { cloth: 10 } : undefined);
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((m === 'POST' ? await post(`/api/clubs/${CLUB}/${p}`, 'ownerB', {}) : await req(m, `/api/clubs/${CLUB}/${p}`, 'ownerB', m === 'PUT' ? { cloth: 10 } : undefined)).status, 403);
    }
    const bRes = (await t.admin.query('select id from bl.resources where club_id = $1 limit 1', [CLUB_B])).rows[0].id;
    assert.equal((await post(`/api/clubs/${CLUB}/maintenance`, 'manager', { resource_id: bRes, kind: 'cloth' })).status, 404);
  });

  it('событие со стоимостью: журнал, расход «Ремонт столов» в кассе со ссылкой; счётчик с начала следующих суток', async () => {
    const r = await post(`/api/clubs/${CLUB}/maintenance`, 'manager', { resource_id: T(1), kind: 'cloth', date: D, comment: 'Сукно Iwan Simonis', cost_kopecks: 1_500_000 });
    assert.equal(r.status, 201, r.text);
    ev = r.json;
    assert.equal(ev.kind, 'cloth');
    assert.equal(ev.date, D);
    assert.equal(ev.cost_kopecks, 1_500_000);
    assert.equal(ev.created_by, MANAGER);
    assert.ok(ev.cashbook_entry_id);
    const cb = await req('GET', `/api/clubs/${CLUB}/cashbook?from=${D}&to=${today}`, 'owner');
    const e = cb.json.entries.find((x) => x.entry_id === ev.cashbook_entry_id);
    assert.equal(e.kind, 'expense');
    assert.equal(e.amount_kopecks, 1_500_000);
    assert.equal(e.category, 'Ремонт столов');
    assert.equal(e.maintenance_event_id, ev.event_id);
    assert.equal(e.date, D);
    const audit = await t.admin.query(`select action, data from bl.audit_log where club_id = $1 and action in ('maintenance.event', 'cashbook.entry') order by seq`, [CLUB]);
    assert.deepEqual(audit.rows.map((x) => x.action), ['cashbook.entry', 'maintenance.event']);
    assert.equal(audit.rows[1].data.cashbook_entry_id, ev.cashbook_entry_id);
    // Счётчик: агрегаты с D+1 и текущие сутки по сессиям.
    const m = await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner');
    assert.equal(m.status, 200);
    const c = m.json.counters.find((x) => x.resource_id === T(1)).kinds;
    assert.equal(c.cloth.minutes, await playSince(T(1), addDays(D, 1)));
    assert.equal(c.cloth.since, D);
    assert.equal(c.cloth.event_id, ev.event_id);
    assert.equal(c.cloth.threshold_hours, 1500);
    assert.equal(c.cloth.due, false);
    // Шары без событий — с начала учёта.
    assert.equal(c.balls.minutes, await playSince(T(1), '2000-01-01'));
    assert.equal(c.balls.since, null);
    assert.equal(c.cushions.threshold_hours, 5000);
    assert.equal(m.json.events[0].event_id, ev.event_id);
    // Таблица «Столы» на дашборде — часы с замены сукна.
    const hall = await req('GET', `/api/clubs/${CLUB}/dashboard?tab=hall&compare=0`, 'owner');
    const row = hall.json.tables.by_resource.find((x) => x.resource_id === T(1));
    assert.equal(row.cloth_hours, c.cloth.hours);
    assert.equal(row.cloth_since, D);
    assert.equal(row.cloth_threshold_hours, 1500);
    assert.equal(row.cloth_due, false);
  });

  it('проверки: дата в будущем, стоимость старше 35 суток, вид, причина у исправления', async () => {
    assert.equal((await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { resource_id: T(1), kind: 'cloth', date: addDays(today, 1) })).status, 400);
    assert.equal((await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { resource_id: T(1), kind: 'cloth', date: addDays(today, -40), cost_kopecks: 100 })).status, 400);
    assert.equal((await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { resource_id: T(1), kind: 'chalk' })).status, 400);
    assert.equal((await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { resource_id: T(1), kind: 'cloth', cost_kopecks: -1 })).status, 400);
    const noReason = await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: ev.event_id, cost_kopecks: 1 });
    assert.deepEqual([noReason.status, noReason.json], [400, { error: 'reason_required' }]);
    // Без стоимости — можно задним числом до года (начальное состояние стола).
    const old = await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { resource_id: T(2), kind: 'balls', date: addDays(today, -40) });
    assert.equal(old.status, 201);
    assert.equal(old.json.cashbook_entry_id, null);
  });

  it('порог достигнут — одно уведомление управляющему и владельцу (не тревога), журнал; повтор — тихо', async () => {
    const m = await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner');
    const hours = m.json.counters.find((x) => x.resource_id === T(1)).kinds.cloth.hours;
    assert.ok(hours >= 2, `часов ${hours}`);
    const put = await req('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, 'manager', { cloth: Math.floor(hours), cushions: null });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.thresholds.cloth, Math.floor(hours));
    assert.equal(put.json.thresholds.balls, 3000);
    assert.equal(put.json.thresholds.cushions, null);
    assert.deepEqual((await req('GET', `/api/clubs/${CLUB}/maintenance/thresholds`, 'owner')).json.thresholds, put.json.thresholds);
    assert.equal((await req('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, 'owner', { cloth: 0 })).status, 400);
    assert.equal((await req('PUT', `/api/clubs/${CLUB}/maintenance/thresholds`, 'owner', { chalk: 10 })).status, 400);
    const alarmsBefore = (await t.admin.query('select count(*)::int as n from bl.alarms where club_id = $1', [CLUB])).rows[0].n;
    const r1 = await maintenanceTick({ pool: t.pool, clock: { now: () => new Date() } });
    const mine = r1.notified.filter((x) => x.club_id === CLUB);
    assert.deepEqual(mine.map((x) => [x.resource_id, x.kind]), [[T(1), 'cloth']]);
    const n = await t.admin.query(`select n.user_id, n.level, n.text, m.role from bl.notifications n join bl.club_members m on m.user_id = n.user_id and m.club_id = n.club_id where n.club_id = $1 and n.kind = 'maintenance.due'`, [CLUB]);
    const want = (await t.admin.query(`select distinct user_id from bl.club_members where club_id = $1 and active and role in ('owner', 'manager')`, [CLUB])).rows.length;
    assert.equal(new Set(n.rows.map((x) => x.user_id)).size, want);
    assert.ok(n.rows.every((x) => ['owner', 'manager'].includes(x.role) && x.level === 'info'));
    assert.match(n.rows[0].text, /^Стол 1: пора — замена сукна\. Сыграно \d/);
    assert.equal((await t.admin.query('select count(*)::int as n from bl.alarms where club_id = $1', [CLUB])).rows[0].n, alarmsBefore, 'не тревога');
    assert.equal((await t.admin.query(`select count(*)::int as n from bl.audit_log where club_id = $1 and action = 'maintenance.threshold_reached'`, [CLUB])).rows[0].n, 1);
    const r2 = await maintenanceTick({ pool: t.pool, clock: { now: () => new Date() } });
    assert.equal(r2.notified.filter((x) => x.club_id === CLUB).length, 0, 'одно на порог');
    const due = (await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner')).json.counters.find((x) => x.resource_id === T(1)).kinds.cloth;
    assert.equal(due.due, true);
  });

  it('исправление: новая запись с причиной, сторно старого расхода и новый расход; повтор — 409; «события не было»', async () => {
    const r = await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: ev.event_id, reason: 'опечатка в сумме', cost_kopecks: 1_000_000 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.corrects_id, ev.event_id);
    assert.equal(r.json.resource_id, T(1));
    assert.equal(r.json.date, D);
    assert.equal(r.json.reason, 'опечатка в сумме');
    const cb = (await req('GET', `/api/clubs/${CLUB}/cashbook?from=${D}&to=${today}`, 'owner')).json;
    const linked = cb.entries.filter((x) => x.maintenance_event_id === ev.event_id || x.maintenance_event_id === r.json.event_id);
    assert.deepEqual(linked.map((x) => x.signed_kopecks).sort((a, b) => a - b), [-1_500_000, -1_000_000, 1_500_000]);
    const ac = await t.admin.query(`select reason from bl.audit_log where club_id = $1 and action = 'maintenance.correct'`, [CLUB]);
    assert.equal(ac.rows[0].reason, 'опечатка в сумме');
    const again = await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: ev.event_id, reason: 'ещё раз' });
    assert.deepEqual([again.status, again.json], [409, { error: 'duplicate' }]);
    const view = (await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner')).json;
    assert.equal(view.events.find((x) => x.event_id === ev.event_id).corrected_by, r.json.event_id);
    assert.equal(view.counters.find((x) => x.resource_id === T(1)).kinds.cloth.event_id, r.json.event_id);
    // «События не было»: счётчик — с начала учёта, расход сторнирован.
    const v = await post(`/api/clubs/${CLUB}/maintenance`, 'owner', { corrects_id: r.json.event_id, reason: 'не меняли', void: true });
    assert.equal(v.status, 201, v.text);
    assert.equal(v.json.voided, true);
    assert.equal(v.json.cost_kopecks, 0);
    const c = (await req('GET', `/api/clubs/${CLUB}/maintenance`, 'owner')).json.counters.find((x) => x.resource_id === T(1)).kinds.cloth;
    assert.equal(c.event_id, null);
    assert.equal(c.minutes, await playSince(T(1), '2000-01-01'));
    const cb2 = (await req('GET', `/api/clubs/${CLUB}/cashbook?from=${D}&to=${today}`, 'owner')).json;
    assert.equal(cb2.entries.filter((x) => x.maintenance_event_id).reduce((a, x) => a + x.signed_kopecks, 0), 0);
  });

  it('только добавление: правка и удаление событий и отметок запрещены всем ролям', async () => {
    await assert.rejects(t.admin.query('update bl.maintenance_events set cost_kopecks = 0'), /append-only/);
    await assert.rejects(t.admin.query('delete from bl.maintenance_events'), /append-only/);
    await assert.rejects(t.admin.query('truncate bl.maintenance_alerts cascade'), /append-only/);
    await assert.rejects(t.admin.query('delete from bl.maintenance_alerts'), /append-only/);
  });

  it('изоляция: у клуба B своих событий нет, чужие не видны и не исправляются', async () => {
    const view = await req('GET', `/api/clubs/${CLUB_B}/maintenance`, 'ownerB');
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.events, []);
    assert.ok(view.json.counters.every((x) => !x.resource_id.startsWith('e1000000')));
    const x = await post(`/api/clubs/${CLUB_B}/maintenance`, 'ownerB', { corrects_id: ev.event_id, reason: 'чужое' });
    assert.equal(x.status, 404);
    assert.equal((await req('GET', `/api/clubs/${CLUB_B}/maintenance`, 'owner')).status, 403);
  });
});
