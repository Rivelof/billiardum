// Главная сверка дашборда (M5.2 №168, T29): выручка за сутки на дашборде = сумма отчётов смен =
// утренняя сводка — до копейки; игра через границу суток — по началу; тестовый клуб не входит;
// возврат на следующий день уменьшает день возврата; пересчёт закрытых суток после исправления;
// тепловая карта и кольцо ёмкости — по сессиям; CSV совпадает с экраном; запись агрегатов — только
// узкой функцией планировщика. Плюс права (T30) — в access.test.mjs.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { buildShiftReport } from '../../../reports/shift-report.mjs';
import { buildMorningSummary } from '../../../summaries/index.mjs';
import { withContext } from '../../../lib/store.mjs';
import { tick } from '../../index.mjs';
import { workingDayOf } from '../../time.mjs';
import { CLUB, G1, seedDataset, TEST_CLUB, TZ } from './harness.mjs';

let t;
let data;
let owner;

const clock = { now: () => new Date() };

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: [...CORE_ROUTE_FILES, 'dashboard.mjs'] }), clock });
  data = await seedDataset(t.admin, clock.now());
  owner = (await t.login('+70000000001')).token;
});

after(async () => {
  await t?.stop();
});

const sys = (clubId, fn) => withContext(t.pool, { clubId, actorType: 'system' }, fn);
const get = async (path, token = owner) => {
  cache.clear();
  const r = await t.request('GET', path, { token });
  return r;
};
const tileOf = (json, id) => json.tiles.find((x) => x.id === id);

async function shiftReports(day) {
  return sys(CLUB, async (db) => {
    const { rows } = await db.query('select id from bl.shifts where club_id = $1 order by number', [CLUB]);
    const out = [];
    for (const r of rows) out.push(await buildShiftReport(db, { shiftId: r.id, now: clock.now(), online: false }));
    // Сутки смены — по закрытию (у открытой — по открытию).
    return out.filter((x) => workingDayOf(new Date(x.shift.closed_at ?? x.shift.opened_at), TZ, '06:00') === day);
  });
}

async function summary(day) {
  return sys(CLUB, (db) => buildMorningSummary(db, { clubId: CLUB, day, timezone: TZ, dayStartLocal: '06:00' }));
}

describe('планировщик агрегатов', () => {
  it('считает закрытые сутки с начала истории клуба, догоняет пропущенные, идемпотентен', async () => {
    const r1 = await tick({ pool: t.pool, clock, log: t.log });
    const mine = r1.computed.filter((x) => x.club_id === CLUB).map((x) => x.day);
    assert.ok(mine.includes(data.D1) && mine.includes(data.D2) && mine.includes(data.D3), 'D1–D3 посчитаны');
    assert.ok(!mine.includes(data.today), 'текущие сутки не пишутся');
    assert.equal(mine.length, 8, 'с D1−5 по D3');
    const r2 = await tick({ pool: t.pool, clock, log: t.log });
    assert.deepEqual(r2.computed.filter((x) => x.club_id === CLUB), [], 'повтор — ничего');
    // Пропуск после простоя: стёртые сутки досчитываются (суперпользователь стирает строку как «простой»).
    await t.admin.query('delete from bl.stats_daily where club_id = $1 and day = $2', [CLUB, data.D2]);
    const r3 = await tick({ pool: t.pool, clock, log: t.log });
    assert.deepEqual(r3.computed.filter((x) => x.club_id === CLUB).map((x) => x.day), [data.D2]);
  });

  it('app_api только читает агрегаты; функция записи — только планировщику в контексте клуба', async () => {
    const c = await t.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB]);
      await assert.rejects(c.query("insert into bl.stats_daily (club_id, day, version, revenue_total_kopecks, refunds_kopecks, net_kopecks, games, play_minutes, capacity_minutes, data) values ($1, '2020-01-01', 1, 0, 0, 0, 0, 0, 0, '{}')", [CLUB]), /permission denied/);
      await c.query('rollback');
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB]);
      await assert.rejects(c.query(`select bl.stats_put_day('2020-01-01', 0, 1::smallint, '{"totals": {}}'::jsonb, '[]'::jsonb)`), /only scheduler/);
      await c.query('rollback');
      // Чужой клуб не виден.
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [TEST_CLUB]);
      const { rows } = await c.query('select count(*)::int as n from bl.stats_daily where club_id = $1', [CLUB]);
      assert.equal(rows[0].n, 0);
      await c.query('rollback');
    } finally {
      c.release();
    }
  });
});

describe('сверка «дашборд = отчёты смен = утренняя сводка» (№168)', () => {
  for (const key of ['D1', 'D2', 'D3']) {
    it(`сутки ${key}: выручка, возвраты, способы оплаты до копейки`, async () => {
      const day = data[key];
      const s = await summary(day);
      const reports = await shiftReports(day);
      assert.ok(reports.length >= 1, 'есть смены суток');
      const sum = (f) => reports.reduce((a, r) => a + f(r), 0);
      const r = await get(`/api/clubs/${CLUB}/dashboard?from=${day}&to=${day}&tab=money`);
      assert.equal(r.status, 200, r.text);
      const tile = tileOf(r.json, 'revenue');
      assert.equal(tile.value, s.revenue.net_kopecks, 'дашборд = сводка (чистая выручка)');
      assert.equal(tile.value, sum((x) => x.revenue.total_kopecks - x.revenue.refunds.total_kopecks), 'дашборд = сумма отчётов смен');
      assert.equal(tileOf(r.json, 'revenue_total').value, s.revenue.total_kopecks);
      assert.equal(tileOf(r.json, 'refunds').value, s.revenue.refunds_kopecks);
      for (const m of r.json.tables.methods) {
        assert.equal(m.kopecks, s.revenue.by_method[m.id], `способ ${m.id}: сводка`);
        assert.equal(m.kopecks, sum((x) => x.revenue.by_method[m.id]), `способ ${m.id}: смены`);
      }
      const struct = Object.fromEntries(r.json.tables.structure.map((x) => [x.id, x.kopecks]));
      assert.equal(struct.tables + struct.deposits, sum((x) => x.revenue.tables.total_kopecks), 'столы');
      assert.equal(struct.bar, sum((x) => x.revenue.bar.total_kopecks), 'бар');
      assert.equal(struct.packages, sum((x) => x.revenue.packages.total_kopecks), 'пакеты');
      // Агрегат в базе — то же число.
      const st = await t.admin.query('select net_kopecks from bl.stats_daily where club_id = $1 and day = $2', [CLUB, day]);
      assert.equal(Number(st.rows[0].net_kopecks), s.revenue.net_kopecks);
    });
  }

  it('D1: точные суммы набора (QR, продление, касса, бар, депозит, пакет, игра через границу суток)', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}&tab=money`);
    const struct = Object.fromEntries(r.json.tables.structure.map((x) => [x.id, x.kopecks]));
    // Столы: 50 000 + 25 000 + 80 000 + 90 000 (игра 05:30 следующего утра); депозит 100 000;
    // бар 35 000 + 100 000; пакеты 300 000 онлайн + 300 000 на кассе.
    assert.deepEqual(struct, { tables: 245000, deposits: 100000, bar: 135000, packages: 600000, tournaments: 0, other: 0 });
    assert.equal(tileOf(r.json, 'revenue').value, 1080000);
    const src = Object.fromEntries(r.json.tables.sources.map((x) => [x.id, x.kopecks]));
    assert.deepEqual(src, { qr: 465000, reception: 615000, booking: 0, tournament: 0 });
    assert.equal(tileOf(r.json, 'avg_check_bar').value, 67500, 'бар: 135 000 / 2 продажи');
  });

  it('№187: игра 05:30–07:00 — одна игра в сутках начала, минуты — внутри каждых суток; совпадает со сводкой и сменами', async () => {
    const d1 = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}&tab=summary`);
    const d2 = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D2}&to=${data.D2}&tab=summary`);
    assert.equal(tileOf(d1.json, 'games').value, 4, 'игра 05:30 — в D1');
    assert.equal(tileOf(d1.json, 'play_hours').value, 4.5, '90 + 60 + 90 + 30 минут (05:30–06:00)');
    assert.equal(tileOf(d2.json, 'games').value, 2, 'бронь и игра пакетом');
    assert.equal(tileOf(d2.json, 'play_hours').value, 3, '60 + 60 + 60 минут (06:00–07:00 игры из D1)');
    for (const [day, json] of [[data.D1, d1.json], [data.D2, d2.json], [data.D3, (await get(`/api/clubs/${CLUB}/dashboard?from=${data.D3}&to=${data.D3}&tab=hall`)).json]]) {
      const s = await summary(day);
      const reports = await shiftReports(day);
      const games = tileOf(json, 'games').value;
      assert.equal(games, s.play.sessions, `${day}: игры = сводка`);
      assert.equal(games, reports.reduce((a, r) => a + r.play.sessions, 0), `${day}: игры = сумма отчётов смен`);
      const st = await t.admin.query('select play_minutes from bl.stats_daily where club_id = $1 and day = $2', [CLUB, day]);
      assert.equal(st.rows[0].play_minutes, s.play.minutes, `${day}: минуты игры = сводка`);
      assert.equal(tileOf(json, 'play_hours').value, s.play.hours, `${day}: часы = сводка`);
    }
    // Средний чек игры: столы 245 000 + депозит 100 000 на 4 игры.
    assert.equal(tileOf(d1.json, 'avg_check_game').value, 86250);
  });

  it('возврат на следующий день уменьшает день возврата, а не день оплаты', async () => {
    const d1 = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}&tab=money`);
    const d2 = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D2}&to=${data.D2}&tab=money`);
    assert.equal(tileOf(d1.json, 'refunds').value, 0);
    assert.equal(tileOf(d2.json, 'refunds').value, 10000);
    assert.equal(tileOf(d2.json, 'revenue').value, 40000 - 10000, 'предоплата брони − возврат за бар');
    assert.equal(d2.json.tables.refunds.by_method.card_terminal, 10000);
  });

  it('период D1–D3 = сумма суток; сравнение с прошлым периодом', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D3}&tab=summary`);
    const parts = [];
    for (const d of [data.D1, data.D2, data.D3]) parts.push((await summary(d)).revenue.net_kopecks);
    assert.equal(tileOf(r.json, 'revenue').value, parts.reduce((a, b) => a + b, 0));
    assert.equal(tileOf(r.json, 'revenue').prev, 0, 'прошлый такой же период — пусто');
    assert.equal(tileOf(r.json, 'revenue').delta_pct, null);
    assert.equal(r.json.series.revenue_daily.length, 3);
    // Гости: новые 3 (первая игра или бронь в D1), повторных нет.
    const g = tileOf(r.json, 'guests');
    assert.equal(g.value, 3);
    assert.deepEqual(g.parts.map((x) => [x.id, x.value]), [['new', 3], ['repeat', 0]]);
    const only2 = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D2}&to=${data.D2}&tab=guests`);
    assert.deepEqual(only2.json.tables.guests, { total: 2, new: 0, repeat: 2, lost: 0, new_pct: 0, repeat_pct: 100 });
    assert.deepEqual(only2.json.tables.bookings, { total: 2, came: 1, no_show: 1, canceled: 0, upcoming: 0, came_pct: 50, lead_minutes_avg: 540 });
    assert.deepEqual(only2.json.tables.packages, { sold: 0, sold_minutes: 0, used_minutes: 60 });
  });

  it('тепловая карта и кольцо ёмкости — по сессиям; часы работы 10:00–02:00', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}&tab=hall`);
    const ring = r.json.series.ring;
    assert.equal(ring.capacity_minutes, 8 * 16 * 60, '8 столов × 16 часов');
    assert.equal(ring.played_minutes, 270);
    assert.equal(ring.unrealized_minutes, 8 * 16 * 60 - 270);
    const hm = r.json.series.heatmap;
    const dow = new Date(`${data.D1}T00:00:00Z`).getUTCDay() || 7;
    const row = hm.play_minutes[dow - 1];
    assert.equal(row.reduce((a, b) => a + b, 0), 270, 'сумма карты = сыграно');
    assert.equal(row[12], 60);
    assert.equal(row[13], 30);
    assert.equal(row[5], 30, '05:30–06:00 — последние часы D1');
    assert.equal(row[6], 0, '06:00–07:00 — уже D2');
    const two = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D2}&tab=hall`);
    const dow2 = new Date(`${data.D2}T00:00:00Z`).getUTCDay() || 7;
    assert.equal(two.json.series.heatmap.play_minutes[dow2 - 1][6], 60);
    assert.equal(two.json.series.ring.played_minutes, 270 + 180);
    assert.equal(hm.capacity_minutes[dow - 1][12], 8 * 60);
    assert.equal(hm.pct[dow - 1][12], 12.5);
    assert.equal(hm.pct[dow - 1][7], null, 'клуб закрыт — пусто');
    const t1 = r.json.tables.by_resource.find((x) => x.number === 1);
    assert.equal(t1.play_minutes, 90);
    assert.equal(t1.revenue_kopecks, 75000);
  });

  it('пересчёт закрытых суток после исправления (списание заморозки) меняет агрегат', async () => {
    const before = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D3}&to=${data.D3}&tab=money`);
    assert.equal(tileOf(before.json, 'revenue').value, 0, 'заморозка ещё не списана');
    await t.admin.query("update bl.payments set status = 'succeeded', captured_kopecks = 70000, captured_at = now() where id = $1", [data.holdPay]);
    const dirty = await t.admin.query('select gen from bl.stats_dirty where club_id = $1 and day = $2', [CLUB, data.D3]);
    assert.equal(dirty.rowCount, 1, 'сутки отмечены «грязными»');
    const r = await tick({ pool: t.pool, clock, log: t.log });
    assert.deepEqual(r.computed.filter((x) => x.club_id === CLUB).map((x) => x.day), [data.D3]);
    assert.equal((await t.admin.query('select 1 from bl.stats_dirty where club_id = $1', [CLUB])).rowCount, 0, 'отметка снята');
    const after = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D3}&to=${data.D3}&tab=money`);
    assert.equal(tileOf(after.json, 'revenue').value, 70000);
    assert.equal(tileOf(after.json, 'revenue').value, (await summary(data.D3)).revenue.net_kopecks);
  });

  it('текущие сутки — на лету: выручка = открытая смена = сводка; ручные действия = отчёт смены = сводка', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.today}&to=${data.today}&tab=control`);
    assert.equal(r.status, 200);
    const report = await sys(CLUB, (db) => buildShiftReport(db, { shiftId: data.todayShift, now: clock.now(), online: false }));
    const s = await summary(data.today);
    const m = await get(`/api/clubs/${CLUB}/dashboard?from=${data.today}&to=${data.today}&tab=money`);
    assert.equal(tileOf(m.json, 'revenue').value, 15000);
    assert.equal(tileOf(m.json, 'revenue').value, report.revenue.total_kopecks - report.revenue.refunds.total_kopecks);
    assert.equal(tileOf(m.json, 'revenue').value, s.revenue.net_kopecks);
    assert.equal(tileOf(r.json, 'manual_actions').value, 2);
    assert.equal(tileOf(r.json, 'manual_actions').value, report.manual_actions.count);
    assert.equal(tileOf(r.json, 'manual_actions').value, s.manual_actions.count);
    const items = r.json.tables.manual_items;
    assert.ok(items.some((i) => i.action === 'service.start' && i.actor_name === 'Ресепшн Анна' && !/123-45-67/.test(i.reason)), 'телефон в причине замаскирован');
    assert.ok(r.json.period.includes_today);
  });

  it('контроль: реакция на тревоги, расхождение кассы, скан → свет, свет без журнала', async () => {
    const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D2}&tab=control`);
    const a = r.json.tables.alarms;
    assert.equal(a.total, 3);
    const byType = Object.fromEntries(a.by_type.map((x) => [x.type, x]));
    assert.equal(byType.service_light.slow, 1);
    assert.equal(byType.service_light.avg_react_sec, 1200);
    assert.equal(byType.device_offline.slow, 0);
    assert.equal(byType.receipt_pending.unacked, 1);
    assert.deepEqual(a.by_staff.map((x) => [x.name, x.count, x.slow, x.avg_react_sec]), [['Управляющий Олег', 2, 1, 660]]);
    assert.equal(a.problems.length, 2, 'принята позже 10 минут и не принята');
    assert.equal(tileOf(r.json, 'alarms_problem').value, 2);
    assert.equal(tileOf(r.json, 'cash_discrepancy').value, -50000);
    assert.deepEqual(r.json.tables.shifts.map((x) => [x.number, x.status]), [[1, 'closed'], [2, 'discrepancy']]);
    const p = r.json.tables.pilot;
    assert.equal(p.scan_to_light.median_sec, 38, 'котировка 11:59:30 → ack 12:00:08');
    assert.deepEqual(p.lights_without_journal, { commands: 0, sessions: 1 }, 'игра 05:30 без session.start');
    assert.equal(p.no_staff_share_pct, 66.7, '4 из 6 игр без персонала (QR и бронь)');
  });

  it('тестовый клуб не учитывается; «Все мои клубы» = сумма клубов владельца', async () => {
    const tc = await get(`/api/clubs/${TEST_CLUB}/dashboard?from=${data.D1}&to=${data.D1}&tab=summary`);
    assert.equal(tc.status, 200);
    assert.equal(tileOf(tc.json, 'revenue').value, 0, 'платёж тестового клуба — is_test');
    assert.equal(tileOf(tc.json, 'games').value, 0);
    const all = await get(`/api/clubs/all/dashboard?from=${data.D1}&to=${data.D3}&tab=summary`);
    const one = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D3}&tab=summary`);
    assert.equal(all.status, 200, all.text);
    assert.equal(tileOf(all.json, 'revenue').value, tileOf(one.json, 'revenue').value);
    assert.deepEqual(all.json.tables.clubs.map((c) => c.club_id).sort(), [CLUB, TEST_CLUB].sort());
    assert.equal(all.json.club, 'all');
  });

  it('CSV совпадает с экраном: BOM, «;», ДД.ММ.ГГГГ, рубли; журнал owner.export; без ПДн гостей', async () => {
    const r = await t.request('GET', `/api/clubs/${CLUB}/dashboard/export.csv?from=${data.D1}&to=${data.D3}&table=revenue_daily`, { token: owner });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="dashboard-revenue_daily-/);
    assert.deepEqual([...r.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const lines = r.text.slice(1).trim().split('\r\n').map((l) => l.split(';'));
    assert.equal(lines[0][0], 'Дата');
    const screen = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D3}&tab=money`);
    for (const d of screen.json.tables.daily) {
      const ru = `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}.${d.date.slice(0, 4)}`;
      const line = lines.find((l) => l[0] === ru);
      assert.ok(line, ru);
      assert.equal(line[3], `${Math.trunc(d.net_kopecks / 100)},${String(Math.abs(d.net_kopecks) % 100).padStart(2, '0')}`);
    }
    for (const table of ['tables', 'hourly', 'manual', 'shifts', 'bookings']) {
      const x = await t.request('GET', `/api/clubs/${CLUB}/dashboard/export.csv?from=${data.D1}&to=${data.today}&table=${table}`, { token: owner });
      assert.equal(x.status, 200, table);
      assert.doesNotMatch(x.text, /\+?7\s?999|Гость/, `${table}: нет телефонов и имён гостей`);
    }
    const audit = await t.admin.query("select data from bl.audit_log where club_id = $1 and action = 'owner.export' order by seq", [CLUB]);
    assert.equal(audit.rowCount, 6);
    assert.deepEqual(audit.rows[0].data, { all: false, from: data.D1, kind: null, rows: 3, source: 'dashboard', table: 'revenue_daily', to: data.D3 });
  });

  it('ответы дашборда без телефонов и имён гостей', async () => {
    for (const tab of ['summary', 'money', 'hall', 'guests', 'control']) {
      const r = await get(`/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.today}&tab=${tab}`);
      assert.equal(r.status, 200, tab);
      assert.doesNotMatch(r.text, /\+7999|79990000|Гость|a9000000-0000-4000-8000/, `${tab}`);
    }
    const now = await get(`/api/clubs/${CLUB}/dashboard/now`);
    assert.equal(now.status, 200, now.text);
    assert.equal(now.json.totals.total, 8);
    assert.ok(now.json.shift && now.json.shift.number === 4);
    assert.doesNotMatch(now.text, new RegExp(G1));
  });

  it('кэш: повтор за 15 с — из кэша процесса', async () => {
    cache.clear();
    const a = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}`, { token: owner });
    const b = await t.request('GET', `/api/clubs/${CLUB}/dashboard?from=${data.D1}&to=${data.D1}`, { token: owner });
    assert.equal(a.headers.get('x-cache'), null);
    assert.equal(b.headers.get('x-cache'), 'hit');
    assert.deepEqual(a.json, b.json);
  });
});

