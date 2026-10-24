// T29 «Цифры сходятся» на закрытых сутках клуба сида (docs/contracts/m5-2.md §6; №168, №169, №187).
//
// История клуба сида — настоящие игры, касса, бар, депозиты, пакеты, брони, возвраты и сервисный свет
// прогонов M1–M5 на столах 1–8 за местные сутки E2E_M52_DAYS (по умолчанию 22.10 и 23.10, плюс
// 21.10 — сутки создания клуба). Агрегаты bl.stats_daily посчитал настоящий планировщик сервера.
// Для каждых суток:
//   * дашборд (API владельца, агрегат) = свежая утренняя сводка (тот же код, что у планировщика сводок)
//     = отправленная сводка (bl.club_summaries) — выручка, возвраты, способы оплаты до копейки, игры,
//     минуты и часы игры, тревоги, ручные действия;
//   * дашборд = сумма отчётов смен (API /api/shifts/{id}/report) + оплаты вне смен (№187: ночные и
//     дневные оплаты по QR без открытой смены есть в дашборде и сводке, но не в отчёте смены);
//   * игры (количество) — по суткам начала, минуты — фактические внутри суток (№187): независимый
//     расчёт по сессиям; тепловая карта и кольцо ёмкости = расчёт по сессиям и столам в работе;
//   * таблица по столам, по дням и период = сумма суток; CSV revenue_daily, tables, hourly = экран.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  apiRaw,
  bounds,
  closeApp,
  CLUB_A,
  dash,
  get,
  loginWait,
  parseCsv,
  ru,
  rubCsv,
  shiftReportsOfDay,
  storedSummary,
  summaryOf,
  tv,
  TZ,
} from './helpers.mjs';

const DAYS = (process.env.E2E_M52_DAYS || '2026-10-21,2026-10-22,2026-10-23').split(',');
const METHODS = ['cash', 'card_terminal', 'sbp', 'card'];
const S = {};
let db;

before(async () => {
  db = await adminClient();
  S.owner = await loginWait('+70000000001');
});
after(async () => {
  await closeApp();
  await db?.end();
});

/** Независимый расчёт суток по сессиям, столам и оплатам (формулы №168, №170, №187 из контракта). */
async function fromSql(day) {
  const b = await bounds(db, day);
  const to1 = new Date(b.to.getTime() - 1);
  const pays = (
    await db.query(
      `select p.id, p.method, p.kind, p.provider, p.confirmed_at, case when p.status = 'succeeded' then (case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end) else 0 end::bigint as k
         from bl.payments p
        where p.club_id = $1 and p.confirmed_at >= $2 and p.confirmed_at <= $3 and p.status in ('succeeded', 'waiting_for_capture')
          and p.provider <> 'balance' and not p.is_test and p.method = any($4::text[])`,
      [CLUB_A, b.from, to1, METHODS],
    )
  ).rows.map((r) => ({ ...r, k: Number(r.k) }));
  const refs = (
    await db.query(
      `select f.amount_kopecks, f.created_at, p.method from bl.refunds f join bl.payments p on p.id = f.payment_id
        where f.club_id = $1 and f.created_at >= $2 and f.created_at <= $3 and f.status in ('succeeded', 'manual') and f.kind = 'refund' and not f.is_test
          and p.method = any($4::text[])`,
      [CLUB_A, b.from, to1, METHODS],
    )
  ).rows.map((r) => ({ ...r, k: Number(r.amount_kopecks) }));
  const sess = (
    await db.query(
      `select s.id, s.resource_id, s.started_at, coalesce(s.ended_at, s.interrupted_at) as end_at from bl.sessions s
        where s.club_id = $1 and not s.is_test and s.status <> 'cancelled' and s.started_at < $3 and coalesce(s.ended_at, s.interrupted_at, now()) > $2`,
      [CLUB_A, b.from, b.to],
    )
  ).rows;
  const shifts = (await db.query('select opened_at, coalesce(closed_at, now()) as closed_at from bl.shifts where club_id = $1 and not is_test', [CLUB_A])).rows;
  const inShift = (t) => shifts.some((s) => t >= s.opened_at && t <= s.closed_at);
  // Минуты игры: по столу и местному часу (Екатеринбург — UTC+5 без перехода на летнее время).
  const perResHour = new Map();
  let playMs = 0;
  for (const s of sess) {
    const a = Math.max(new Date(s.started_at).getTime(), b.from.getTime());
    const z = Math.min(s.end_at ? new Date(s.end_at).getTime() : Date.now(), b.to.getTime(), Date.now());
    if (z <= a) continue;
    playMs += z - a;
    for (let t = a; t < z; ) {
      const hourStart = Math.floor(t / 3_600_000) * 3_600_000;
      const next = Math.min(z, hourStart + 3_600_000);
      const hour = (new Date(t).getUTCHours() + 5) % 24;
      const k = `${s.resource_id}|${hour}`;
      perResHour.set(k, (perResHour.get(k) ?? 0) + (next - t));
      t = next;
    }
  }
  const hourPlay = Array(24).fill(0);
  for (const [k, ms] of perResHour) hourPlay[Number(k.split('|')[1])] += Math.round(ms / 60_000);
  const byMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const outByMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  for (const p of pays) {
    byMethod[p.method] += p.k;
    if (!inShift(p.confirmed_at)) outByMethod[p.method] += p.k;
  }
  const refByMethod = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const refOut = Object.fromEntries(METHODS.map((m) => [m, 0]));
  for (const f of refs) {
    refByMethod[f.method] += f.k;
    if (!inShift(f.created_at)) refOut[f.method] += f.k;
  }
  const started = sess.filter((s) => s.started_at >= b.from && s.started_at <= to1);
  // Столы в работе: создание стола и журнал вывода (resource.deactivate / manual.resource_remove).
  const res = (await db.query('select id, number, active, created_at from bl.resources where club_id = $1', [CLUB_A])).rows;
  const ev = (
    await db.query(
      `select object_id, action, created_at from bl.audit_log where club_id = $1 and object_type = 'resource'
        and action = any('{resource.activate,resource.deactivate,manual.resource_add,manual.resource_remove}'::text[]) order by seq`,
      [CLUB_A],
    )
  ).rows;
  return {
    b,
    total: pays.reduce((a, p) => a + p.k, 0),
    refunds: refs.reduce((a, f) => a + f.k, 0),
    byMethod,
    refByMethod,
    outByMethod,
    refOut,
    outCount: pays.filter((p) => p.k > 0 && !inShift(p.confirmed_at)).length,
    games: started.length,
    gamesOutside: started.filter((s) => !inShift(s.started_at)).length,
    playMinutes: Math.round(playMs / 60_000),
    hourPlay,
    resources: res,
    resourceEvents: ev,
  };
}

const isoDow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

for (const day of DAYS) {
  test(`T29 ${day}: дашборд = свежая сводка = отправленная сводка (деньги, игры, часы, тревоги, ручные действия)`, async (t) => {
    const money = await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'money' });
    assert.equal(money.status, 200, money.text);
    assert.deepEqual(money.json.period.missing_days, [], 'сутки досчитаны планировщиком');
    const st = await db.query('select version, net_kopecks, games, play_minutes, computed_at from bl.stats_daily where club_id = $1 and day = $2', [CLUB_A, day]);
    assert.equal(st.rowCount, 1, 'агрегат закрытых суток есть');
    const summary = await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'summary' });
    const control = await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'control' });
    const fresh = await summaryOf(db, day);
    const sent = await storedSummary(db, day);
    const methods = Object.fromEntries(money.json.tables.methods.map((m) => [m.id, m]));
    const check = (label, s) => {
      assert.equal(tv(money.json, 'revenue'), s.revenue.net_kopecks, `${label}: чистая выручка`);
      assert.equal(tv(money.json, 'revenue_total'), s.revenue.total_kopecks, `${label}: выручка до возвратов`);
      assert.equal(tv(money.json, 'refunds'), s.revenue.refunds_kopecks, `${label}: возвраты`);
      for (const m of METHODS) assert.equal(methods[m].kopecks, s.revenue.by_method[m], `${label}: способ ${m}`);
      assert.equal(tv(summary.json, 'games'), s.play.sessions, `${label}: игры`);
      assert.equal(tv(summary.json, 'play_hours'), s.play.hours, `${label}: часы игры`);
      assert.equal(Number(st.rows[0].play_minutes), s.play.minutes, `${label}: минуты игры`);
      assert.equal(tv(summary.json, 'utilization'), s.play.utilization_percent, `${label}: загрузка %`);
      assert.equal(tv(control.json, 'alarms'), s.alarms.total, `${label}: тревоги`);
      assert.deepEqual(control.json.tables.alarms.by_level, { critical: s.alarms.critical, important: s.alarms.important, info: s.alarms.info }, `${label}: тревоги по уровням`);
      assert.equal(tv(control.json, 'manual_actions'), s.manual_actions.count, `${label}: ручные действия`);
      if (s.manual_actions.automatic) assert.equal(tv(control.json, 'automatic_actions'), s.manual_actions.automatic.count, `${label}: действия системы`);
      const byAction = Object.fromEntries(control.json.tables.manual_by_action.map((x) => [x.action, x.count]));
      assert.deepEqual(byAction, s.manual_actions.by_action, `${label}: ручные действия по видам`);
    };
    check('свежая сводка', fresh);
    if (sent) check(`отправленная сводка (${sent.sent_at.toISOString()})`, sent.data);
    t.diagnostic(
      `${day}: выручка ${tv(money.json, 'revenue')} коп. (до возвратов ${tv(money.json, 'revenue_total')}, возвраты ${tv(money.json, 'refunds')}), игр ${tv(summary.json, 'games')}, ${tv(summary.json, 'play_hours')} ч, загрузка ${tv(summary.json, 'utilization')} %, тревог ${tv(control.json, 'alarms')}, ручных ${tv(control.json, 'manual_actions')}; сводка отправлена: ${sent ? 'да' : 'нет'}`,
    );
  });

  test(`T29 ${day}: дашборд = сумма отчётов смен + оплаты вне смен (№187); игры и минуты — по сессиям`, async (t) => {
    const x = await fromSql(day);
    const reports = await shiftReportsOfDay(db, S.owner.token, day);
    const money = (await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'money' })).json;
    const summary = (await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'summary' })).json;
    const sum = (f) => reports.reduce((a, r) => a + f(r), 0);
    const methods = Object.fromEntries(money.tables.methods.map((m) => [m.id, m]));
    // Независимый расчёт = дашборд.
    assert.equal(tv(money, 'revenue_total'), x.total, 'выручка до возвратов = SQL по оплатам');
    assert.equal(tv(money, 'refunds'), x.refunds, 'возвраты = SQL');
    for (const m of METHODS) {
      assert.equal(methods[m].kopecks, x.byMethod[m], `способ ${m} = SQL`);
      // Смены + вне смен.
      assert.equal(methods[m].kopecks, sum((r) => r.revenue.by_method[m]) + x.outByMethod[m], `способ ${m} = смены + вне смен`);
      assert.equal(methods[m].refunds_kopecks, sum((r) => r.revenue.refunds.by_method[m]) + x.refOut[m], `возвраты ${m} = смены + вне смен`);
    }
    assert.equal(tv(money, 'revenue'), sum((r) => r.revenue.net_kopecks) + (Object.values(x.outByMethod).reduce((a, b) => a + b, 0) - Object.values(x.refOut).reduce((a, b) => a + b, 0)), 'чистая выручка = смены + вне смен');
    // Структура: столы+депозиты, бар, пакеты = сумма смен + вне смен по статьям (проверка по совокупности).
    const struct = Object.fromEntries(money.tables.structure.map((s) => [s.id, s.kopecks]));
    assert.equal(struct.tables + struct.deposits + struct.bar + struct.packages + struct.tournaments + struct.other, x.total, 'структура в сумме = выручка');
    // Игры: по началу; минуты — внутри суток.
    assert.equal(tv(summary, 'games'), x.games, 'игры = сессии, начатые в сутках');
    assert.equal(tv(summary, 'games'), sum((r) => r.play.sessions) + x.gamesOutside, 'игры = смены + начатые вне смен');
    const st = await db.query('select play_minutes, capacity_minutes from bl.stats_daily where club_id = $1 and day = $2', [CLUB_A, day]);
    assert.equal(Number(st.rows[0].play_minutes), x.playMinutes, 'минуты игры = сессии внутри суток');
    const covered = x.outCount === 0 && x.gamesOutside === 0;
    if (covered) assert.equal(tv(money, 'revenue'), sum((r) => r.revenue.net_kopecks), 'смены покрывают сутки: дашборд = сумма отчётов смен');
    t.diagnostic(
      `${day}: смен ${reports.length}; оплат вне смен ${x.outCount} на ${Object.values(x.outByMethod).reduce((a, b) => a + b, 0)} коп. (${JSON.stringify(x.outByMethod)}), возвратов вне смен ${Object.values(x.refOut).reduce((a, b) => a + b, 0)} коп.; игр ${x.games} (вне смен ${x.gamesOutside}); минут ${x.playMinutes}; смены покрывают сутки: ${covered ? 'да' : 'нет'}`,
    );
  });

  test(`T29 ${day}: тепловая карта, кольцо ёмкости и таблица по столам = расчёт по сессиям`, async (t) => {
    const x = await fromSql(day);
    const hall = await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'hall' });
    assert.equal(hall.status, 200);
    const hm = hall.json.series.heatmap;
    const row = hm.play_minutes[isoDow(day) - 1];
    assert.deepEqual(row, x.hourPlay, 'минуты игры по местным часам = сессии');
    // Ёмкость: столы в работе × 24 ч (часы работы клуба сида не заданы — №170); стол, выведенный из работы, — с момента вывода.
    const settings = (await db.query('select settings from bl.clubs where id = $1', [CLUB_A])).rows[0].settings;
    assert.equal(settings.open_hours ?? null, null, 'часы работы клуба сида не заданы — 24 ч');
    let capMs = 0;
    for (const r of x.resources) {
      const evs = x.resourceEvents.filter((e) => e.object_id === r.id);
      // Интервалы «в работе» стола внутри суток.
      let active = evs.length ? ['resource.deactivate', 'manual.resource_remove'].includes(evs[0].action) : r.active;
      let since = new Date(r.created_at).getTime();
      const ints = [];
      for (const e of evs) {
        const tt = Math.max(new Date(r.created_at).getTime(), new Date(e.created_at).getTime());
        const next = ['resource.activate', 'manual.resource_add'].includes(e.action);
        if (active && !next) ints.push([since, tt]);
        if (!active && next) since = tt;
        active = next;
      }
      if (active) ints.push([since, Infinity]);
      for (const [a, z] of ints) capMs += Math.max(0, Math.min(z, x.b.to.getTime()) - Math.max(a, x.b.from.getTime()));
    }
    const ring = hall.json.series.ring;
    assert.equal(ring.capacity_minutes, Math.round(capMs / 60_000), 'ёмкость = столы в работе × 24 ч');
    assert.equal(ring.played_minutes, x.playMinutes, 'сыграно = сессии');
    assert.equal(ring.unrealized_minutes, Math.max(0, ring.capacity_minutes - ring.played_minutes - ring.service_minutes), 'нереализовано = ёмкость − сыграно − сервис');
    const svc = await db.query(
      `select coalesce(sum(extract(epoch from least(coalesce(released_at, until), $3) - greatest(created_at, $2))), 0)::float8 as s
         from bl.resource_holds where club_id = $1 and kind = 'service' and created_at < $3 and coalesce(released_at, until) > $2`,
      [CLUB_A, x.b.from, x.b.to],
    );
    assert.ok(Math.abs(ring.service_minutes - svc.rows[0].s / 60) <= 8, `сервис ${ring.service_minutes} мин ≈ ${Math.round(svc.rows[0].s / 60)} по удержаниям (округление по столам)`);
    // Ёмкость в карте округляется по столу и часу, в кольце — итогом суток: допуск — по полминуты на ячейку.
    const capCells = hm.capacity_minutes[isoDow(day) - 1].reduce((a, b) => a + b, 0);
    S.capRounding = Math.max(S.capRounding ?? 0, Math.abs(capCells - ring.capacity_minutes));
    assert.ok(Math.abs(capCells - ring.capacity_minutes) <= 8 * 24 * 0.5, `карта: сумма ёмкости ${capCells} ≈ кольцо ${ring.capacity_minutes}`);
    if (capCells !== ring.capacity_minutes) t.diagnostic(`НАБЛЮДЕНИЕ: ёмкость карты ${capCells} мин ≠ кольца ${ring.capacity_minutes} мин (округление по столу и часу; сутки с неполными часами столов)`);
    for (let h = 0; h < 24; h += 1) {
      const cap = hm.capacity_minutes[isoDow(day) - 1][h];
      const pct = hm.pct[isoDow(day) - 1][h];
      if (cap > 0) assert.equal(pct, Math.min(100, Math.round((row[h] / cap) * 1000) / 10), `час ${h}: % = игра / ёмкость`);
    }
    assert.equal(tv(hall.json, 'utilization'), ring.capacity_minutes ? Math.round((ring.played_minutes / ring.capacity_minutes) * 1000) / 10 : null, 'загрузка = сыграно / ёмкость');
    // Таблица по столам: игры по началу, минуты, выручка столов − возвраты = SQL.
    const perRes = await db.query(
      `select r.number,
              (select count(*)::int from bl.sessions s where s.resource_id = r.id and not s.is_test and s.status <> 'cancelled' and s.started_at >= $2 and s.started_at < $3) as games,
              (select coalesce(sum(case when p.capture then p.amount_kopecks else coalesce(p.captured_kopecks, 0) end), 0)::bigint from bl.payments p
                where p.resource_id = r.id and p.status = 'succeeded' and p.provider <> 'balance' and not p.is_test and p.kind in ('start', 'extend', 'booking', 'booking_start')
                  and p.confirmed_at >= $2 and p.confirmed_at < $3) as rev,
              (select coalesce(sum(f.amount_kopecks), 0)::bigint from bl.refunds f join bl.payments p on p.id = f.payment_id
                where p.resource_id = r.id and f.kind = 'refund' and f.status in ('succeeded', 'manual') and not f.is_test and p.kind in ('start', 'extend', 'booking', 'booking_start')
                  and f.created_at >= $2 and f.created_at < $3) as ref
         from bl.resources r where r.club_id = $1 order by r.number`,
      [CLUB_A, x.b.from, x.b.to],
    );
    for (const r of perRes.rows) {
      const row2 = hall.json.tables.by_resource.find((y) => y.number === r.number);
      if (!row2) {
        assert.equal(r.games, 0, `стол ${r.number}`);
        continue;
      }
      assert.equal(row2.games, r.games, `стол ${r.number}: игры`);
      assert.equal(row2.revenue_kopecks, Number(r.rev) - Number(r.ref), `стол ${r.number}: выручка столов − возвраты`);
    }
    t.diagnostic(`${day}: кольцо ${JSON.stringify(ring)}; карта (минуты по часам) ${JSON.stringify(row)}`);
  });
}

test('T29: период = сумма суток; CSV revenue_daily, tables, hourly = экран (BOM, «;», ДД.ММ.ГГГГ, рубли)', async (t) => {
  const from = DAYS[0];
  const to = DAYS.at(-1);
  const per = [];
  for (const d of DAYS) per.push((await dash(S.owner.token, CLUB_A, { from: d, to: d, tab: 'money' })).json);
  const range = (await dash(S.owner.token, CLUB_A, { from, to, tab: 'money' })).json;
  for (const id of ['revenue', 'revenue_total', 'refunds', 'cash_net', 'cashless_net']) {
    assert.equal(tv(range, id), per.reduce((a, j) => a + tv(j, id), 0), `${id}: период = сумма суток`);
  }
  const summ = (await dash(S.owner.token, CLUB_A, { from, to, tab: 'summary' })).json;
  const perGames = [];
  for (const d of DAYS) perGames.push(tv((await dash(S.owner.token, CLUB_A, { from: d, to: d, tab: 'summary' })).json, 'games'));
  assert.equal(tv(summ, 'games'), perGames.reduce((a, b) => a + b, 0), 'игры: период = сумма суток');
  assert.deepEqual(summ.series.revenue_daily.map((d) => d.net_kopecks), per.map((j) => tv(j, 'revenue')), 'выручка по дням');

  const csv = await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${from}&to=${to}&table=revenue_daily`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } });
  assert.equal(csv.status, 200, csv.text);
  assert.match(csv.headers['content-type'], /text\/csv; charset=utf-8/);
  assert.match(csv.headers['content-disposition'], new RegExp(`dashboard-revenue_daily-${from}-${to}\\.csv`));
  assert.deepEqual([...csv.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
  assert.ok(csv.buf.toString('utf8').includes('\r\n'), 'CRLF');
  const rows = parseCsv(csv.buf);
  assert.equal(rows[0][0], 'Дата');
  for (const d of range.tables.daily) {
    const line = rows.find((r) => r[0] === ru(d.date));
    assert.ok(line, `строка ${ru(d.date)}`);
    assert.deepEqual(line.slice(1, 7), [rubCsv(d.total_kopecks), rubCsv(d.refunds_kopecks), rubCsv(d.net_kopecks), rubCsv(d.tables_kopecks), rubCsv(d.bar_kopecks), rubCsv(d.other_kopecks)], `${d.date}: деньги`);
    assert.equal(Number(line[11]), d.games, `${d.date}: игры`);
    assert.equal(line[12], d.avg_check_game_kopecks === null ? '' : rubCsv(d.avg_check_game_kopecks), `${d.date}: средний чек игры`);
  }
  const hall = (await dash(S.owner.token, CLUB_A, { from, to, tab: 'hall' })).json;
  const tcsv = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${from}&to=${to}&table=tables`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } })).buf);
  for (const r of hall.tables.by_resource) {
    const line = tcsv.find((l) => l[0] === String(r.number));
    assert.ok(line, `стол ${r.number} в CSV`);
    assert.equal(Number(line[3]), r.games, `стол ${r.number}: игры`);
    assert.equal(line[4], String(r.play_hours).replace('.', ','), `стол ${r.number}: часы`);
    assert.equal(line[6], rubCsv(r.revenue_kopecks), `стол ${r.number}: выручка`);
  }
  const hcsv = parseCsv((await apiRaw('GET', `/api/clubs/${CLUB_A}/dashboard/export.csv?from=${from}&to=${to}&table=hourly`, { token: S.owner.token, headers: { 'x-club-id': CLUB_A } })).buf);
  for (const d of DAYS) {
    const row = hall.series.heatmap.play_minutes[isoDow(d) - 1];
    for (let h = 0; h < 24; h += 1) {
      const line = hcsv.find((l) => l[0] === ru(d) && l[1] === `${String(h).padStart(2, '0')}:00`);
      assert.equal(line ? Number(line[2]) : 0, row[h], `${d} ${h}:00 — минуты игры CSV = карта`);
    }
  }
  const audit = await db.query("select data from bl.audit_log where club_id = $1 and action = 'owner.export' and created_at > now() - interval '2 minutes' order by seq", [CLUB_A]);
  assert.ok(audit.rows.some((r) => r.data.table === 'revenue_daily' && r.data.from === from && r.data.to === to && r.data.source === 'dashboard'), 'журнал owner.export');
  t.diagnostic(`период ${from}–${to}: выручка ${tv(range, 'revenue')} = ${per.map((j) => tv(j, 'revenue')).join(' + ')}; игр ${tv(summ, 'games')}; CSV: ${rows.length - 1} строк по дням, ${tcsv.length - 1} столов, ${hcsv.length - 1} часов`);
});

test('T29: тестовые записи (клубы в test) в дашборд клуба сида и их собственный дашборд не входят', async (t) => {
  // Тестовые записи прогонов M5.1 — в клубах «E2E M5» (режим test или до перехода в live, is_test).
  const { rows } = await db.query(
    `select p.club_id, c.mode, count(*)::int as n, sum(p.amount_kopecks)::bigint as k, min(p.confirmed_at) as at
       from bl.payments p join bl.clubs c on c.id = p.club_id
      where p.is_test and p.status = 'succeeded' group by 1, 2 order by n desc limit 5`,
  );
  assert.ok(rows.length > 0, 'есть тестовые оплаты в отдельных клубах');
  // Ни одной тестовой записи в клубе сида.
  const seed = await db.query("select (select count(*) from bl.payments where club_id = $1 and is_test)::int as p, (select count(*) from bl.sessions where club_id = $1 and is_test)::int as s", [CLUB_A]);
  assert.deepEqual(seed.rows[0], { p: 0, s: 0 });
  // У клуба с тестовыми оплатами агрегат суток этих оплат — 0 (планировщик считает все активные клубы).
  const test0 = rows[0];
  const day = (await db.query("select to_char((($1::timestamptz at time zone c.timezone) - interval '6 hours')::date, 'YYYY-MM-DD') as d from bl.clubs c where c.id = $2", [test0.at, test0.club_id])).rows[0].d;
  const agg = await db.query('select net_kopecks, revenue_total_kopecks, games from bl.stats_daily where club_id = $1 and day = $2', [test0.club_id, day]);
  const live = await db.query(
    "select coalesce(sum(amount_kopecks), 0)::bigint as k from bl.payments p join bl.clubs c on c.id = p.club_id where p.club_id = $1 and not p.is_test and p.status = 'succeeded' and to_char(((p.confirmed_at at time zone c.timezone) - interval '6 hours')::date, 'YYYY-MM-DD') = $2",
    [test0.club_id, day],
  );
  if (agg.rowCount) {
    assert.equal(Number(agg.rows[0].revenue_total_kopecks), Number(live.rows[0].k), 'в агрегате — только боевые оплаты');
  }
  t.diagnostic(`тестовые оплаты: ${rows.map((r) => `${r.club_id.slice(0, 8)} (${r.mode}) ${r.n} шт. ${r.k} коп.`).join('; ')}; клуб ${test0.club_id.slice(0, 8)} сутки ${day}: агрегат ${agg.rowCount ? JSON.stringify(agg.rows[0]) : 'нет'}, боевых ${live.rows[0].k} коп.`);
});

test('T29: агрегаты закрытых суток — только чтение для app_api, запись — только планировщику', async () => {
  const { appClient } = await import('./helpers.mjs');
  const app = await appClient();
  try {
    await app.query('begin');
    await app.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB_A]);
    const r = await app.query('select count(*)::int as n from bl.stats_daily where club_id = $1', [CLUB_A]);
    assert.ok(r.rows[0].n >= 3, 'свой клуб читается');
    await assert.rejects(app.query("update bl.stats_daily set net_kopecks = 0 where club_id = $1", [CLUB_A]), /permission denied/);
    await app.query('rollback');
    await app.query('begin');
    await app.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'user', true)", [CLUB_A]);
    await assert.rejects(app.query(`select bl.stats_put_day('2026-10-22', 0, 1::smallint, '{"totals": {}}'::jsonb, '[]'::jsonb)`), /only scheduler|permission denied/);
    await app.query('rollback');
    await app.query('begin');
    await app.query("select set_config('app.club_id', 'c1000000-0000-4000-8000-0000000000ff', true), set_config('app.actor_type', 'system', true)");
    const other = await app.query('select count(*)::int as n from bl.stats_daily where club_id = $1', [CLUB_A]);
    assert.equal(other.rows[0].n, 0, 'чужой клуб не виден');
    await app.query('rollback');
  } finally {
    await app.end();
  }
});

export { TZ, get };
