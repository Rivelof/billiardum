import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, comparePeriod, eachDay, periodError, periodWords, presetRange, spanDays, weekday, workDate, dayDots } from '../src/lib/period.js';
import { csvCell, csvDate, csvMoney, toCsv } from '../src/lib/export.js';
import {
  allClubsScope,
  alarmReaction,
  arcPath,
  capacityRing,
  compactMoney,
  dashboardQuery,
  dashboardView,
  heatCells,
  nowView,
  reactionView,
  deltaOf,
  formatHours,
  formatPct,
  formatSeconds,
  formatValue,
  hallTotals,
  heatLevel,
  heatmapMatrix,
  isEmptyPeriod,
  kindCards,
  labelEvery,
  lineSeries,
  niceTicks,
  readFilters,
  ringArcs,
  share,
  stackedRows,
  TAB_TILES,
  TILES,
  tileViews,
  words,
  workHours,
  writeFilters,
} from '../src/lib/dashboard.js';
import { journalLink } from '../src/lib/audit.js';
import { createDashboardMock, CLUBS } from '../src/mock/dashboard.js';

const NB = '\u00a0';
const TZ = 'Asia/Yekaterinburg'; // UTC+5

// ---------- рабочие сутки и периоды (№167) ----------

test('рабочие сутки клуба: до 06:00 — ещё прошлые сутки, по поясу клуба', () => {
  // 24.10 05:30 по Екатеринбургу = 24.10 00:30 UTC
  assert.equal(workDate(Date.parse('2026-10-24T00:30:00Z'), TZ), '2026-10-23');
  assert.equal(workDate(Date.parse('2026-10-24T01:00:00Z'), TZ), '2026-10-24'); // 06:00 — уже новые
  assert.equal(workDate(Date.parse('2026-10-24T00:30:00Z'), TZ, '05:00'), '2026-10-24');
  // Москва в тот же момент — 03:30, сутки клуба в Москве ещё 23-е
  assert.equal(workDate(Date.parse('2026-10-24T00:30:00Z'), 'Europe/Moscow'), '2026-10-23');
});

test('пресеты периода и прошлый период для сравнения', () => {
  const today = '2026-10-24';
  assert.deepEqual(presetRange('today', today), { from: today, to: today });
  assert.deepEqual(presetRange('yesterday', today), { from: '2026-10-23', to: '2026-10-23' });
  assert.deepEqual(presetRange('7d', today), { from: '2026-10-18', to: today });
  assert.deepEqual(presetRange('30d', today), { from: '2026-09-25', to: today });
  assert.deepEqual(presetRange('month', today), { from: '2026-10-01', to: today });
  assert.deepEqual(comparePeriod('2026-10-18', '2026-10-24'), { from: '2026-10-11', to: '2026-10-17' });
  assert.deepEqual(comparePeriod('2026-10-01', '2026-10-24', 'month'), { from: '2026-09-01', to: '2026-09-24' });
  // 1–31 марта → 1–28 февраля
  assert.deepEqual(comparePeriod('2026-03-01', '2026-03-31', 'month'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(comparePeriod('2026-01-01', '2026-01-10', 'month'), { from: '2025-12-01', to: '2025-12-10' });
  assert.equal(spanDays('2025-10-24', '2026-10-24'), 366);
  assert.equal(eachDay('2026-02-27', '2026-03-02').length, 4);
  assert.equal(weekday('2026-10-24'), 6); // суббота
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('период: не больше 366 дней, начало раньше конца, не позже сегодня (400 bad_request у сервера)', () => {
  const today = '2026-10-24';
  assert.equal(periodError('2025-10-24', '2026-10-24', today), null);
  assert.match(periodError('2025-10-23', '2026-10-24', today), /не больше 366 дней/);
  assert.match(periodError('2026-10-24', '2026-10-01', today), /позже конца/);
  assert.match(periodError('2026-10-01', '2026-10-25', today), /позже сегодняшнего/);
  assert.match(periodError('', '2026-10-01', today), /обе даты/);
  assert.match(periodError('2026-02-30', '2026-03-01', today), /обе даты/);
});

test('период словами и даты для CSV', () => {
  assert.equal(periodWords('2026-10-01', '2026-10-24', '2026-10-24'), '1–24 октября');
  assert.equal(periodWords('2026-09-25', '2026-10-24', '2026-10-24'), '25 сентября — 24 октября');
  assert.equal(periodWords('2026-10-24', '2026-10-24', '2026-10-24'), '24 октября');
  assert.equal(periodWords('2025-12-30', '2026-01-02', '2026-10-24'), '30 декабря 2025 — 2 января');
  assert.equal(dayDots('2026-10-04'), '04.10.2026');
});

// ---------- CSV (№172) ----------

test('CSV для Excel: BOM, «;», CRLF, деньги с запятой, даты ДД.ММ.ГГГГ, без формул', () => {
  const csv = toCsv(['Дата', 'Сумма, ₽', 'Причина'], [['2026-10-04', csvMoney(149050), 'Гость; «ушёл»'], [csvDate('2026-10-04T16:30:00Z', TZ, true), csvMoney(-10000), '=HYPERLINK("x")']]);
  assert.ok(csv.startsWith('\uFEFFДата;Сумма, ₽;Причина\r\n'));
  assert.ok(csv.includes('2026-10-04;1490,50;"Гость; «ушёл»"'));
  assert.ok(csv.includes('04.10.2026 21:30;-100;"\'=HYPERLINK(""x"")"'));
  assert.equal(csvMoney(149000), '1490');
  assert.equal(csvMoney(5), '0,05');
  assert.equal(csvCell(41.5), '41,5');
  assert.equal(csvCell('+79120000000'), "'+79120000000");
  assert.equal(csvCell(null), '');
  assert.equal(csvDate('2026-10-04'), '04.10.2026');
});

// ---------- ▲▼ к прошлому периоду ----------

test('▲▼: рост выручки — хорошо, рост ручных действий и расхождений — плохо', () => {
  const up = deltaOf({ value: 112000, prev: 100000, unit: 'kopecks', good: 'up' });
  assert.equal(up.dir, 'up');
  assert.equal(up.tone, 'good');
  assert.equal(up.text, `▲ 12${NB}%`);
  assert.match(up.spoken, /Больше на 12 %, чем в прошлом периоде\. Это хорошо\./);
  const manual = deltaOf({ value: 6, prev: 4, unit: 'count', good: 'down' });
  assert.equal(manual.tone, 'bad');
  assert.equal(manual.text, `▲ 50${NB}%`);
  const less = deltaOf({ value: 2, prev: 4, unit: 'count', good: 'down' });
  assert.equal(less.dir, 'down');
  assert.equal(less.tone, 'good');
  assert.equal(less.text, `▼ 50${NB}%`);
  // меньше 10 % — с десятыми
  assert.equal(deltaOf({ value: 1045, prev: 1000, unit: 'count', good: 'up' }).text, `▲ 4,5${NB}%`);
  // без оценки (good: null) — нейтрально
  assert.equal(deltaOf({ value: 5, prev: 4, unit: 'count', good: null }).tone, 'neutral');
});

test('▲▼: доли — в процентных пунктах, от нуля — «было 0», пусто и пусто — без сравнения', () => {
  const load = deltaOf({ value: 41.2, prev: 38, unit: 'pct', good: 'up' });
  assert.equal(load.text, `▲ 3,2${NB}п.${NB}п.`);
  const fromZero = deltaOf({ value: 10000, prev: 0, unit: 'kopecks', good: 'down' });
  assert.equal(fromZero.text, '▲ было 0');
  assert.equal(fromZero.tone, 'bad');
  assert.match(fromZero.spoken, /там было 0/);
  assert.equal(deltaOf({ value: 0, prev: 0, unit: 'kopecks', good: 'up' }), null);
  assert.equal(deltaOf({ value: 100, prev: null, unit: 'kopecks', good: 'up' }), null);
  assert.equal(deltaOf({ value: 100, prev: 100, unit: 'kopecks', good: 'up' }).text, 'без изменений');
});

// ---------- форматы плиток ----------

test('форматы значений: деньги, проценты, часы, секунды; средние — целыми рублями', () => {
  assert.equal(formatValue('kopecks', 149050), `1${NB}490,50${NB}₽`);
  assert.equal(formatValue('kopecks', 123203, TILES.avg_check_game), `1${NB}232${NB}₽`);
  assert.equal(formatValue('kopecks', null), '—');
  assert.equal(formatPct(41.25), `41,3${NB}%`);
  assert.equal(formatHours(4530), `75,5${NB}ч`);
  assert.equal(formatHours(7530), `126${NB}ч`); // от 100 часов — целыми
  assert.equal(formatHours(88507), `1${NB}475${NB}ч`);
  assert.equal(formatSeconds(7), `7${NB}с`);
  assert.equal(formatSeconds(95), `1${NB}мин 35${NB}с`);
  assert.equal(formatValue('count', 1234), `1${NB}234`);
  assert.equal(compactMoney(90000), `900${NB}₽`);
  assert.equal(compactMoney(1_250_000), `12,5${NB}тыс.${NB}₽`);
  assert.equal(compactMoney(120_000_000), `1,2${NB}млн${NB}₽`);
});

test('плитки: формула словами у каждой, разбивка выручки и гостей с процентами, цель «0 игр без журнала»', () => {
  for (const ids of Object.values(TAB_TILES)) for (const id of ids) assert.ok(TILES[id]?.formula?.length > 20, `формула ${id}`);
  const tiles = tileViews(
    [
      // Формы сервера: parts — массив { id, value, pct }; pct — доля от выручки до возвратов
      { id: 'revenue', value: 100000, unit: 'kopecks', prev: 80000, parts: [{ id: 'tables', value: 70000, pct: 70 }, { id: 'bar', value: 25000, pct: 25 }, { id: 'other', value: 5000, pct: 5 }] },
      { id: 'guests', value: 40, prev: 40, parts: [{ id: 'new', value: 10 }, { id: 'repeat', value: 30 }] },
      { id: 'lights_without_journal', value: 1, prev: 0 },
      { id: 'unknown', value: 1 },
    ],
    ['revenue', 'guests', 'lights_without_journal'],
  );
  assert.equal(tiles.length, 3);
  assert.deepEqual(tiles[0].parts.map((p) => [p.label, p.pct]), [['Столы', `70${NB}%`], ['Бар', `25${NB}%`], ['Прочее', `5${NB}%`]]);
  assert.equal(tiles[0].delta.text, `▲ 25${NB}%`);
  assert.equal(tiles[0].prevText, `800${NB}₽`);
  assert.deepEqual(tiles[1].parts.map((p) => p.pct), [`25${NB}%`, `75${NB}%`]);
  assert.equal(tiles[2].offTarget, true);
  assert.equal(tiles[2].delta.tone, 'bad');
  // без сравнения — ни ▲▼, ни «было»
  const plain = tileViews([{ id: 'games', value: 3, prev: 2 }], ['games'], { compare: false });
  assert.equal(plain[0].delta, null);
  assert.equal(plain[0].prevText, null);
  // часы — в часах, доли — в п. п., у сервера unit: hours | percent
  const hall = tileViews([{ id: 'play_hours', value: 125.5, unit: 'hours', prev: 100 }, { id: 'utilization', value: 41.9, unit: 'percent', prev: 40 }], ['utilization', 'play_hours']);
  assert.deepEqual(hall.map((t) => t.text), [`41,9${NB}%`, `126${NB}ч`]);
  assert.equal(hall[0].delta.text, `▲ 1,9${NB}п.${NB}п.`);
});

// ---------- графики ----------

test('шкала: красивые деления и подписи через одну на узком графике', () => {
  assert.deepEqual(niceTicks(13700), { max: 15000, ticks: [0, 5000, 10000, 15000] });
  assert.deepEqual(niceTicks(100), { max: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(niceTicks(0), { max: 1, ticks: [0] });
  assert.equal(labelEvery(30, 300), 6);
  assert.equal(labelEvery(7, 1000), 1);
});

test('столбцы: пропущенные дни — нулями, текущий день отмечен, пустой период распознан', () => {
  const days = eachDay('2026-10-20', '2026-10-24');
  const r = stackedRows([{ date: '2026-10-21', tables: 300, bar: 100, other: 0 }, { date: '2026-10-24', tables: 50, bar: 0, other: 10 }], ['tables', 'bar', 'other'], { days, today: '2026-10-24' });
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[1].values, [300, 100, 0]);
  assert.equal(r.rows[1].total, 400);
  assert.equal(r.max, 400);
  assert.equal(r.rows[4].today, true);
  assert.equal(r.rows[0].total, 0);
  assert.equal(stackedRows([], ['a'], { days }).empty, true);
});

test('линии: день без игр — разрыв (null), а не ноль', () => {
  const s = lineSeries([{ date: '2026-10-20', a: 1000, b: null }, { date: '2026-10-22', a: 1500, b: 400 }], ['a', 'b'], { days: eachDay('2026-10-20', '2026-10-22') });
  assert.deepEqual(s.series[0].points, [1000, null, 1500]);
  assert.deepEqual(s.series[1].points, [null, null, 400]);
  assert.equal(s.max, 1500);
  assert.equal(s.empty, false);
});

test('тепловая карта: часы от начала суток клуба, закрытые часы — без загрузки, пик', () => {
  assert.deepEqual(workHours('06:00').slice(0, 3), [6, 7, 8]);
  assert.equal(workHours('06:00')[18], 0);
  const m = heatmapMatrix(
    [
      { dow: 6, hour: 21, play_minutes: 450, capacity_minutes: 480 },
      { dow: 6, hour: 21, play_minutes: 30, capacity_minutes: 0 }, // второй клуб закрыт — суммируется
      { dow: 1, hour: 13, play_minutes: 0, capacity_minutes: 480 },
      { dow: 9, hour: 1, play_minutes: 10, capacity_minutes: 10 }, // мусор — пропускаем
    ],
    '06:00',
  );
  assert.equal(m.rows.length, 7);
  assert.equal(m.rows[0].label, 'Пн');
  assert.equal(m.rows[0].cells.length, 24);
  const sat21 = m.rows[5].cells[m.hours.indexOf(21)];
  assert.equal(sat21.pct, 100); // 480 из 480, не больше 100 %
  assert.equal(sat21.level, 5);
  assert.equal(m.rows[0].cells[m.hours.indexOf(13)].pct, 0);
  assert.equal(m.rows[0].cells[m.hours.indexOf(13)].level, 0);
  assert.equal(m.rows[2].cells[0].pct, null); // нет ёмкости — закрыто
  assert.equal(m.peak.dow, 6);
  assert.equal(m.empty, false);
  assert.equal(heatLevel(null), null);
  assert.equal(heatLevel(19.9), 1);
  assert.equal(heatLevel(41), 3);
  assert.equal(heatmapMatrix([], '06:00').empty, true);
});

test('кольцо «Загрузка в часах»: нереализовано = ёмкость − сыграно − сервис (№170)', () => {
  const r = capacityRing({ capacity_minutes: 6000, played_minutes: 2500, service_minutes: 100 });
  assert.deepEqual(r.segments.map((s) => s.minutes), [2500, 100, 3400]);
  assert.equal(Math.round(r.segments[0].pct), 42);
  assert.equal(capacityRing({ capacity_minutes: 0 }), null);
  // перебор (сыграно больше ёмкости из-за округлений) не даёт отрицательного остатка
  assert.equal(capacityRing({ capacity_minutes: 100, played_minutes: 120 }).segments[2].minutes, 0);
  const arcs = ringArcs([2500, 100, 3400], 0.02);
  const total = arcs.reduce((s, a) => s + (a.end - a.start), 0) + 0.02 * 3;
  assert.ok(Math.abs(total - Math.PI * 2) < 1e-9);
  assert.match(arcPath(50, 50, 50, 40, 0, Math.PI), /^M50 0A50 50 0 0 1 50 100L50 90A40 40 0 0 0 50 10Z$/);
});

test('статус зала: «занято X / Y» по типам столов и всего', () => {
  const by = [
    { kind: 'pyramid', total: 5, busy: 3, booked: 1, service: 1, revenue_today_kopecks: 752000 },
    { kind: 'pool', total: 3, busy: 2 },
    { kind: 'snooker', total: 0, busy: 0 },
  ];
  const cards = kindCards(by);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].label, 'Пирамида');
  assert.equal(cards[0].words, 'занято 3 из 5');
  assert.equal(cards[0].pct, 60);
  assert.deepEqual(hallTotals(by), { total: 8, busy: 5, booked: 1, service: 1, pct: 62.5 });
  assert.equal(share(1, 0), null);
});

test('реакция на тревоги (№178): позже 10 минут и не принятые — проблемные; медиана по видам и сотрудникам', () => {
  const at = (m) => new Date(Date.parse('2026-10-24T15:00:00Z') + m * 60000).toISOString();
  const r = alarmReaction([
    { id: 'a', type: 'device_offline', raised_at: at(0), acked_at: at(4), acked_by_name: 'Анна К.' },
    { id: 'b', type: 'device_offline', raised_at: at(10), acked_at: at(28), acked_by_name: 'Игорь П.' },
    { id: 'c', type: 'bypass_detected', raised_at: at(20), acked_at: null },
    { id: 'd', type: 'device_offline', raised_at: at(30), acked_at: at(40), acked_by_name: 'Анна К.' }, // ровно 10 — в срок
  ]);
  assert.equal(r.problems, 2);
  assert.deepEqual(r.rows.map((x) => x.id), ['d', 'c', 'b', 'a']);
  const off = r.byType.find((g) => g.key === 'device_offline');
  assert.deepEqual([off.count, off.problems, off.median, off.max], [3, 1, 10, 18]);
  const bypass = r.byType.find((g) => g.key === 'bypass_detected');
  assert.deepEqual([bypass.unacked, bypass.median], [1, null]);
  assert.equal(r.byType.at(-1).key, 'bypass_detected'); // при равном числе проблемных — больше тревог выше
  assert.deepEqual(r.byStaff.map((g) => [g.key, g.count, g.problems]), [['Игорь П.', 1, 1], ['Анна К.', 2, 0]]);
  assert.equal(r.median, 10);
});

test('«Все мои клубы» (№166): владелец и управляющий двух и более клубов; экспорт — только если владелец во всех', () => {
  const m = (role, id) => ({ club_id: id, role });
  assert.deepEqual(allClubsScope([m('owner', 'a'), m('owner', 'b')]), { canAll: true, count: 2, exportAll: true });
  assert.deepEqual(allClubsScope([m('manager', 'a'), m('manager', 'b')]), { canAll: true, count: 2, exportAll: false });
  assert.deepEqual(allClubsScope([m('owner', 'a'), m('manager', 'b')]), { canAll: true, count: 2, exportAll: false });
  assert.deepEqual(allClubsScope([m('manager', 'a'), m('reception', 'b'), m('bar', 'c')]), { canAll: false, count: 1, exportAll: false });
  assert.equal(allClubsScope([m('owner', 'a')]).canAll, false);
  assert.equal(allClubsScope(null).canAll, false);
});

test('тексты по-русски через plural()', () => {
  assert.equal(words.games(1), '1 игра');
  assert.equal(words.games(3), '3 игры');
  assert.equal(words.games(11), '11 игр');
  assert.equal(words.tables(21), '21 стол');
  assert.equal(words.hours(2), '2 часа');
  assert.equal(words.times(5), '5 раз');
});

test('фильтры в адресе: чтение, запись, свой период проверяется; запрос к API', () => {
  const today = '2026-10-24';
  const f = readFilters('?tab=money&p=30d&kind=pool&cmp=0', today);
  assert.deepEqual(f, { tab: 'money', preset: '30d', from: '2026-09-25', to: today, kind: 'pool', compare: false, all: false });
  assert.equal(writeFilters(f), '?tab=money&p=30d&kind=pool&cmp=0');
  assert.deepEqual(readFilters('', today), { tab: 'summary', preset: '7d', from: '2026-10-18', to: today, kind: '', compare: true, all: false });
  assert.equal(writeFilters(readFilters('', today)), '');
  const custom = readFilters('?p=custom&from=2026-01-01&to=2026-01-31&all=1', today);
  assert.deepEqual([custom.from, custom.to, custom.all], ['2026-01-01', '2026-01-31', true]);
  // 367 дней или мусор — назад к 7 дням
  assert.equal(readFilters('?p=custom&from=2025-10-22&to=2026-10-24', today).preset, '7d');
  assert.equal(readFilters('?tab=hack&kind=darts', today).tab, 'summary');
  assert.deepEqual(dashboardQuery({ ...f, tab: 'hall' }), { from: '2026-09-25', to: today, tab: 'hall', kind: 'billiard_pool', compare: 0 }); // M5.8: сервер принимает тип ресурса или семью, не 'pool'
});

test('ссылка из «Контроля» в журнал: ручные действия, период, сотрудник', () => {
  const j = journalLink('?group=manual&period=week&actor=u-manager-0002');
  assert.equal(j.period, 'week');
  assert.match(j.group, /manual\.\*/);
  assert.equal(j.actor, 'u-manager-0002');
  assert.deepEqual(journalLink('?period=year&actor=<script>'), { period: 'today', group: '', actor: '' });
});

// ---------- ответы сервера → вид экрана (примеры из server/dashboard/README.md) ----------

test('сервер → вид: выручка по дням, деньги, касса, 30 дней', () => {
  const v = dashboardView({
    period: { from: '2026-10-21', to: '2026-10-23', days: 3, timezone: TZ, day_start_local: '06:00', today: '2026-10-24', includes_today: false, missing_days: [] },
    compare_period: { from: '2026-10-18', to: '2026-10-20' },
    tiles: [{ id: 'revenue', value: 1110000, unit: 'kopecks', prev: 0, delta_pct: null }],
    series: {
      revenue_daily: [{ date: '2026-10-21', total_kopecks: 1080000, net_kopecks: 1080000, tables_kopecks: 345000, bar_kopecks: 135000, other_kopecks: 600000, today: false }],
      revenue_30d: [{ date: '2026-09-24', total_kopecks: 0, net_kopecks: 0, today: false }],
    },
    tables: {
      structure: [{ id: 'tables', kopecks: 285000, pct: 25.4 }, { id: 'deposits', kopecks: 100000, pct: 8.9 }],
      methods: [{ id: 'card_terminal', kopecks: 35000, refunds_kopecks: 10000, pct: 3.1 }],
      sources: [{ id: 'booking', kopecks: 40000, pct: 3.6 }],
      refunds: { count: 1, total_kopecks: 10000, by_method: {} },
      cash: { start_kopecks: 500000, cash_sales_kopecks: 580000, cash_refunds_kopecks: 0, collections_kopecks: 580000, discrepancy_kopecks: -50000, shifts: [{ shift_id: 's1', number: 1, status: 'closed' }] },
      daily: [{ date: '2026-10-21', total_kopecks: 1080000, net_kopecks: 1080000, refunds_kopecks: 0, tables_kopecks: 345000, bar_kopecks: 135000, other_kopecks: 600000, games: 4, avg_check_game_kopecks: 86250, avg_check_bar_kopecks: 67500, utilization_pct: 4.3, today: false }],
    },
  });
  assert.equal(v.period.dayStart, '06:00');
  assert.deepEqual(v.revenueDaily[0], { date: '2026-10-21', tables: 345000, bar: 135000, other: 600000, net: 1080000, today: false });
  assert.deepEqual(v.money.structure[1], { id: 'deposits', amount: 100000, pct: 8.9 });
  assert.equal(v.money.methods[0].refunds, 10000);
  assert.deepEqual(v.money.refunds, { count: 1, amount: 10000 });
  assert.deepEqual(v.money.cash, { start: 500000, sales: 580000, refunds: 0, collections: 580000, discrepancy: -50000 });
  assert.equal(v.money.shifts.length, 1);
  assert.deepEqual([v.money.daily[0].revenue, v.money.daily[0].avg_check_game, v.money.daily[0].utilization], [1080000, 86250, 4.3]);
  assert.equal(v.revenue30.length, 1);
  // Пустой ответ — честные пустые значения, без исключений
  const e = dashboardView({});
  assert.deepEqual([e.revenueDaily, e.money.methods, e.hall.cells, e.control.manual], [[], [], [], []]);
  assert.equal(e.money.cash, null);
  assert.equal(e.control.pilot.lights, null);
});

test('сервер → вид: зал (тепловая карта 7 × 24, кольцо, по типам и столам)', () => {
  const pct = [[null, 12.5]];
  const v = dashboardView({
    period: { from: '2026-10-21', to: '2026-10-23', day_start_local: '06:00' },
    series: {
      heatmap: { rows: [1], cols: [20, 21], pct, play_minutes: [[0, 60]], capacity_minutes: [[0, 480]] },
      ring: { capacity_minutes: 23040, played_minutes: 520, service_minutes: 20, unrealized_minutes: 22500 },
      utilization_daily: [{ date: '2026-10-21', pct: 4.3, by_type: { billiard_pyramid: 5.6, billiard_pool: 2.1, billiard_snooker: null } }],
    },
    tables: {
      by_type: [{ type: 'billiard_pyramid', tables: 5, games: 4, play_minutes: 340, capacity_minutes: 14400, service_minutes: 20, utilization_pct: 2.4, revenue_kopecks: 265000 }],
      by_resource: [{ resource_id: 'e1', number: 1, title: 'Стол 1', type: 'billiard_pyramid', games: 1, play_minutes: 90, play_hours: 1.5, service_minutes: 0, revenue_kopecks: 75000, utilization_pct: 3.1, cloth_hours: null }],
    },
  });
  assert.deepEqual(v.hall.cells, [{ dow: 1, hour: 20, play_minutes: 0, capacity_minutes: 0 }, { dow: 1, hour: 21, play_minutes: 60, capacity_minutes: 480 }]);
  const m = heatmapMatrix(v.hall.cells, v.period.dayStart);
  assert.equal(m.rows[0].cells[m.hours.indexOf(21)].pct, 12.5);
  assert.equal(m.rows[0].cells[m.hours.indexOf(20)].pct, null);
  assert.equal(capacityRing(v.hall.ring).segments[2].minutes, 22500);
  assert.deepEqual(v.hall.loadDaily[0], { date: '2026-10-21', total: 4.3, pyramid: 5.6, pool: 2.1, snooker: null });
  assert.deepEqual(v.period.kinds, ['pyramid', 'pool', 'snooker']);
  assert.deepEqual(v.hall.byKind[0], { kind: 'pyramid', tables: 5, games: 4, play_minutes: 340, revenue: 265000, load: 2.4 });
  assert.equal(v.hall.resources[0].kind, 'pyramid');
  assert.equal(v.hall.resources[0].cloth_hours, null);
  // тепловая карта только с процентами — тоже читается
  assert.deepEqual(heatCells({ rows: [7], cols: [22], pct: [[50]] }), [{ dow: 7, hour: 22, play_minutes: 50, capacity_minutes: 100 }]);
});

test('сервер → вид: гости, брони, очередь, продления', () => {
  const v = dashboardView({
    tables: {
      guests: { total: 3, new: 3, repeat: 0, lost: 0, new_pct: 100, repeat_pct: 0 },
      bookings: { total: 2, came: 1, no_show: 1, canceled: 0, upcoming: 0, came_pct: 50, lead_minutes_avg: 540 },
      waitlist: { offered: 2, accepted: 1 },
      extensions: { paid: 1, from_app: 1, free: 0, total: 1, from_app_pct: 100 },
      packages: { sold: 1, sold_minutes: 300, used_minutes: 60 },
      tournaments: { fees_kopecks: 50000, participants: 12 },
      plus: { matches_counted: 7 },
    },
    series: { guests_daily: [{ date: '2026-10-21', new: 3, active: 5 }] },
  });
  assert.deepEqual([v.guests.new, v.guests.repeat, v.guests.newPct], [3, 0, 100]);
  assert.deepEqual(v.guests.bookings, { total: 2, came: 1, noShow: 1, canceled: 0, upcoming: 0, lead: 540 });
  assert.deepEqual(v.guests.waitlist, { offered: 2, accepted: 1 });
  assert.equal(v.guests.extensions.pct, 100);
  assert.equal(v.guests.plus, 7);
  assert.deepEqual(v.guests.daily, [{ date: '2026-10-21', new: 3, returning: 2 }]);
});

test('сервер → вид: контроль — ручные действия, смены, реакция на тревоги, пилот', () => {
  const v = dashboardView({
    tables: {
      manual_by_action: [{ action: 'service.start', count: 1 }],
      manual_by_staff: [{ user_id: 'u1', name: 'Ресепшн Анна', count: 1, by_action: { 'service.start': 1 } }],
      manual_items: [{ at: '2026-10-22T15:00:00Z', action: 'service.start', kind: 'staff', actor_id: 'u1', actor_name: 'Ресепшн Анна', reason: 'клиент *** пролил', resource_number: 4, amount_kopecks: null }],
      automatic: { count: 2, by_action: {} },
      shifts: [{ shift_id: 's2', number: 2, closed_at: '2026-10-22T22:00:00Z', discrepancy_kopecks: -50000, status: 'discrepancy', closed_by_name: 'Анна' }, { shift_id: 's1', number: 1, discrepancy_kopecks: 0, status: 'closed' }],
      alarms: {
        total: 3,
        by_level: { critical: 2, important: 1, info: 0 },
        slow_after_sec: 600,
        by_type: [{ type: 'service_light', count: 2, acked: 2, unacked: 0, slow: 1, avg_react_sec: 900, problem: true }, { type: 'device_offline', count: 1, acked: 0, unacked: 1, slow: 0, avg_react_sec: null, problem: true }],
        by_staff: [{ user_id: 'u2', name: 'Управляющий Олег', count: 2, slow: 1, avg_react_sec: 660, problem: true }],
        problems: [{ alarm_id: 'a1', type: 'receipt_pending', level: 'important', resource_number: null, raised_at: '2026-10-22T15:00:00Z', acked_at: null, acked_by: null, acked_by_name: null, react_sec: null }],
      },
      pilot: { lights_without_journal: { commands: 0, sessions: 1 }, scan_to_light: { median_sec: 38, count: 1, under_20_pct: 0 }, no_staff_share_pct: 71.4, extensions_from_app_pct: 100, cash_discrepancy_kopecks: -50000 },
    },
  });
  const c = v.control;
  assert.equal(c.manual[0].action, 'service.start');
  assert.equal(c.manual[0].staff_name, 'Ресепшн Анна');
  assert.deepEqual(c.byAction, [{ action: 'service.start', count: 1 }]);
  assert.deepEqual(c.byStaff[0].actions, [['service.start', 1]]);
  assert.equal(c.automatic, 2);
  assert.deepEqual(c.shifts.map((s) => [s.id, s.discrepancy, s.staff]), [['s2', -50000, 'Анна']]);
  assert.equal(c.shiftsTotal, 2);
  assert.equal(c.reaction.total, 3);
  assert.equal(c.reaction.limitMin, 10);
  assert.deepEqual(c.reaction.byType.map((g) => [g.key, g.problems, g.problem]), [['service_light', 1, true], ['device_offline', 1, true]]);
  assert.equal(c.reaction.byType[0].avg, 15);
  assert.equal(c.reaction.avg, 15); // среднее по принятым
  assert.deepEqual(c.reaction.rows.map((a) => [a.id, a.minutes, a.problem]), [['a1', null, true]]);
  assert.deepEqual([c.pilot.lights, c.pilot.scanMedian, c.pilot.noStaffPct, c.pilot.extAppPct], [1, 38, 71.4, 100]);
  // заглушка и старый ответ — список тревог, считаем сами
  const own = reactionView([{ id: 'x', type: 'lamp_fault', raised_at: '2026-10-22T15:00:00Z', acked_at: '2026-10-22T15:12:00Z', acked_by_name: 'Ольга' }]);
  assert.deepEqual([own.total, own.problems, own.byStaff[0].key, own.rows[0].problem], [1, 1, 'Ольга', true]);
});

test('сервер → вид «Сейчас»: по типам, итог, смена; «все клубы» складываются', () => {
  const one = {
    at: '2026-10-24T12:00:00Z',
    club_id: 'c1',
    day: '2026-10-24',
    totals: { total: 8, busy: 3, reserved: 1, service: 1, free: 3, offline: 0, fault: 0, utilization_now_pct: 37.5, utilization_day_pct: 20 },
    by_type: [{ type: 'billiard_pyramid', total: 5, busy: 2, reserved: 1, service: 1, free: 1, offline: 0, fault: 0 }, { type: 'billiard_pool', total: 3, busy: 1, reserved: 0, service: 0, free: 2, offline: 0, fault: 0 }],
    revenue_today: { total_kopecks: 15000, net_kopecks: 15000 },
    games_today: 1,
    shift: { shift_id: 's', number: 4, opened_at: '2026-10-24T07:00:00Z', opened_by_name: 'Ресепшн Анна' },
  };
  const v = nowView(one);
  assert.deepEqual(v.byKind[0], { kind: 'pyramid', total: 5, busy: 2, booked: 1, service: 1, offline: 0 });
  assert.deepEqual([v.loadNow, v.loadDay, v.revenueToday, v.gamesToday], [37.5, 20, 15000, 1]);
  assert.deepEqual(v.onShift, [{ name: 'Ресепшн Анна', since: '2026-10-24T07:00:00Z', number: 4, club: null }]);
  assert.deepEqual(hallTotals(v.byKind), { total: 8, busy: 3, booked: 1, service: 1, pct: 37.5 });
  const all = nowView({ at: 'x', clubs: [{ ...one, name: 'А' }, { ...one, name: 'Б', shift: null }], totals: { total: 16, busy: 6, utilization_now_pct: 37.5 } });
  assert.equal(all.byKind[0].total, 10);
  assert.deepEqual(all.onShift.map((s) => s.club), ['А']);
  assert.equal(all.revenueToday, 30000);
});

// ---------- заглушка ?mock=dashboard (отвечает в форме сервера) ----------

const OWNER = { role: 'owner' };
const MANAGER = { role: 'manager' };
const DEV = CLUBS[0].id;
const NOW = Date.parse('2026-10-24T12:00:00Z'); // 17:00 по Екатеринбургу, суббота
const q = (o) => new URLSearchParams(o);
const tileOf = (body, id) => body.tiles.find((t) => t.id === id);

test('заглушка: 90 дней синтетики на 8 столов, бар ~25 % выручки, выручка = оплаты − возвраты', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard' });
  const res = m.response(DEV, q({ from: '2026-07-27', to: '2026-10-24', tab: 'money' }), OWNER);
  assert.equal(res.status, 200);
  const b = res.body;
  assert.equal(tileOf(b, 'revenue').value, tileOf(b, 'revenue_total').value - tileOf(b, 'refunds').value);
  const bar = b.tables.structure.find((x) => x.id === 'bar').kopecks;
  const barShare = bar / tileOf(b, 'revenue_total').value;
  assert.ok(barShare > 0.2 && barShare < 0.3, `бар ${barShare}`);
  const v = dashboardView(b);
  assert.equal(v.money.daily.length, 90);
  assert.ok(v.money.daily.every((d) => d.games > 0));
  assert.equal(v.revenue30.length, 30);
  assert.equal(v.revenue30.at(-1).today, true);
  // способы оплаты складываются в оплаты до возвратов
  assert.equal(v.money.methods.reduce((s, x) => s + x.amount, 0), tileOf(b, 'revenue_total').value);
  // 91-й день назад — клуба ещё не было
  const before = m.response(DEV, q({ from: '2026-07-20', to: '2026-07-26', tab: 'summary' }), OWNER).body;
  assert.equal(tileOf(before, 'revenue').value, 0);
  // выходные громче будней, вечер громче дня, клуб закрыт 03:00–12:00
  const hall = dashboardView(m.response(DEV, q({ from: '2026-07-27', to: '2026-10-24', tab: 'hall' }), OWNER).body);
  const mx = heatmapMatrix(hall.hall.cells, hall.period.dayStart);
  const at = (dow, hour) => mx.rows[dow - 1].cells[mx.hours.indexOf(hour)].pct;
  assert.ok(at(6, 21) > at(2, 21));
  assert.ok(at(2, 21) > at(2, 13));
  assert.equal(at(2, 8), null);
  assert.equal(hall.hall.resources.length, 8);
  assert.equal(capacityRing(hall.hall.ring).capacity, hall.hall.ring.capacity_minutes);
});

test('заглушка: пара ручных действий за неделю, расхождение 100 ₽, тревоги, цель «0 без журнала»', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard' });
  m.setDiscrepancyShift({ id: 's-211', number: 211, opened_at: '2026-10-21T07:00:00Z', closed_at: '2026-10-21T22:00:00Z', closed_by_name: 'Игорь П.', expected_cash_kopecks: 1000000, actual_cash_kopecks: 990000, discrepancy_kopecks: -10000 });
  const b = m.response(DEV, q({ from: '2026-10-18', to: '2026-10-24', tab: 'control' }), OWNER).body;
  const v = dashboardView(b);
  assert.equal(v.control.manual.length, 2);
  assert.ok(v.control.manual.every((a) => a.reason && a.staff_name && a.action));
  assert.equal(tileOf(b, 'cash_discrepancy').value, -10000);
  assert.deepEqual(v.control.shifts.map((s) => [s.id, s.discrepancy]), [['s-211', -10000]]);
  assert.equal(tileOf(b, 'lights_without_journal').value, 0);
  assert.equal(v.control.pilot.lights, 0);
  assert.ok(v.control.reaction.problems >= 2);
  assert.equal(tileOf(b, 'alarms_problem').value, v.control.reaction.problems);
});

test('заглушка: «Все мои клубы» — сумма клубов владельца и управляющего; 367 дней — 400', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard' });
  const p = { from: '2026-10-18', to: '2026-10-24', tab: 'summary', compare: '0' };
  const v = (club, user = OWNER) => tileOf(m.response(club, q(p), user).body, 'revenue').value;
  assert.equal(v('all'), v(DEV) + v(CLUBS[1].id));
  const allBody = m.response('all', q(p), OWNER).body;
  assert.equal(allBody.club, 'all');
  assert.equal(allBody.period.timezone, null);
  assert.equal(allBody.tables.clubs.length, 2);
  assert.equal(v('all', MANAGER), v(DEV) + v(CLUBS[1].id)); // управляющий двух клубов — сумма двух
  assert.equal(m.response(DEV, q({ ...p, from: '2025-10-23', to: '2026-10-24' }), OWNER).status, 400);
  assert.equal(m.response(DEV, q({ ...p, from: '2025-10-24', to: '2026-10-24' }), OWNER).status, 200);
  assert.equal(m.response(DEV, q({ ...p, tab: 'hack' }), OWNER).status, 400);
  assert.equal(m.response(DEV, q(p), OWNER).body.compare_period, null);
});

test('заглушка: CSV только владельцу, без телефонов и имён гостей', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard' });
  const p = { from: '2026-10-01', to: '2026-10-24' };
  assert.equal(m.exportCsv(DEV, q({ ...p, table: 'revenue_daily' }), MANAGER).status, 403);
  for (const table of ['revenue_daily', 'tables', 'hourly', 'manual', 'shifts', 'bookings']) {
    const r = m.exportCsv(DEV, q({ ...p, table }), OWNER);
    assert.equal(r.status, 200, table);
    assert.ok(r.csv.startsWith('﻿'), table);
    assert.doesNotMatch(r.csv, /\+7|\*\*\*/, `в ${table} нет телефонов`);
  }
  assert.equal(m.exportCsv(DEV, q({ ...p, table: 'guests_phones' }), OWNER).status, 400);
});

test('заглушка dashboard-empty: честные нули, средние — без значения', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard-empty' });
  const body = m.response(DEV, q({ from: '2026-10-18', to: '2026-10-24', tab: 'summary' }), OWNER).body;
  const v = dashboardView(body);
  assert.equal(isEmptyPeriod(v), true);
  assert.equal(tileOf(body, 'avg_check_game').value, null);
  assert.equal(tileOf(body, 'utilization').value, null);
  const ctl = dashboardView(m.response(DEV, q({ from: '2026-10-18', to: '2026-10-24', tab: 'control' }), OWNER).body);
  assert.equal(ctl.control.manual.length, 0);
  assert.equal(ctl.control.reaction.total, 0);
  const now = nowView(m.nowResponse(DEV, [], OWNER).body);
  assert.deepEqual(now.onShift, []);
});

test('заглушка: график на 366 дней строится быстро', () => {
  const m = createDashboardMock({ now: () => NOW, scenario: 'dashboard-year' });
  const t0 = performance.now();
  const v = dashboardView(m.response(DEV, q({ from: '2025-10-24', to: '2026-10-24', tab: 'summary' }), OWNER).body);
  const rows = stackedRows(v.revenueDaily, ['tables', 'bar', 'other'], { days: eachDay('2025-10-24', '2026-10-24'), today: '2026-10-24' });
  assert.equal(rows.rows.length, 366);
  assert.equal(rows.empty, false);
  assert.ok(performance.now() - t0 < 3000);
});
