import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { dashboardView, heatmapMatrix } from '../src/lib/dashboard.js';
import { basisText, daysShort, daysWords, forecastView, hintView, hintsView, holidayText, hoursShort, median, medianForecast, notEnoughText, rangeWords, windowWords } from '../src/lib/forecast.js';
import {
  canCorrect,
  clothView,
  correctionBody,
  counterView,
  DEFAULT_THRESHOLDS,
  eventBody,
  eventEffect,
  eventFormErrors,
  eventServerError,
  eventStateWords,
  hoursText,
  maintenanceView,
  parseThresholds,
  reachedText,
} from '../src/lib/maintenance.js';
import { REPORTS } from '../src/lib/reports.js';
import { can } from '../src/lib/auth.js';

const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const memory = () => {
  let v = null;
  return { load: () => v, save: (s) => (v = JSON.parse(JSON.stringify(s))) };
};
// Время заглушки — фиксированное (сутки клуба 24 октября 2026, 17:00 в Екатеринбурге): даты в проверках не плывут
const NOW = Date.parse('2026-10-24T12:00:00Z');
const backend = (sc) => {
  const b = createBackend(memory(), () => NOW);
  b.scenario(sc);
  return (path, method = 'GET', body) => b.handle(method, { href: `http://x${path}`, body });
};
const hallOf = async (call, club = CLUB) => dashboardView((await call(`/api/clubs/${club}/dashboard?from=2026-09-25&to=2026-10-24&tab=hall`)).body);

// ---------- прогноз (№196) ----------

test('медиана: нечётное, чётное, пусто, без null', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
  assert.equal(median([null, 5, undefined, 7, Number.NaN]), 6);
});

test('медиана прогноза: 8 одинаковых недель — та же загрузка; закрытые часы не входят; ячейка без образцов — null', () => {
  const samples = [];
  for (let w = 0; w < 8; w += 1) {
    samples.push({ dow: 5, hour: 21, pct: 80 + w }); // 80..87 → медиана 83,5
    samples.push({ dow: 1, hour: 14, pct: 12.5 });
    samples.push({ dow: 1, hour: 8, pct: null }); // клуб закрыт
  }
  samples.push({ dow: 1, hour: 14, pct: null });
  const m = medianForecast(samples);
  assert.equal(m.pct[4][21], 83.5);
  assert.equal(m.pct[0][14], 12.5);
  assert.equal(m.samples[0][14], 8);
  assert.equal(m.pct[0][8], null);
  assert.equal(m.pct[6][3], null);
  assert.equal(m.pct.length, 7);
  assert.ok(m.pct.every((r) => r.length === 24));
});

test('forecastView: форма series.forecast сервера, мало данных, у «всех клубов» — null', () => {
  const pct = Array.from({ length: 7 }, () => Array.from({ length: 24 }, (_, h) => (h >= 12 ? 50 : null)));
  const ok = forecastView({ status: 'ok', enough: true, label: 'прогноз', weeks: 8, from: '2026-08-29', to: '2026-10-23', history_days: 56, history_weeks: 8, min_days: 14, holiday_iso_day: 7, rows: [1, 2, 3, 4, 5, 6, 7], cols: Array.from({ length: 24 }, (_, i) => i), pct });
  assert.equal(ok.enough, true);
  assert.equal(ok.cells.length, 7 * 24);
  const mx = heatmapMatrix(ok.cells, '06:00');
  assert.equal(mx.rows[0].cells[mx.hours.indexOf(14)].pct, 50);
  assert.equal(mx.rows[0].cells[mx.hours.indexOf(8)].pct, null);
  assert.equal(basisText(ok), 'медиана за 8 недель (29 августа – 23 октября)');
  assert.equal(holidayText(ok), 'Праздники клуба считаются как воскресенье, как в тарифах.');
  const few = forecastView({ status: 'insufficient_data', enough: false, pct: null, samples: null, history_days: 10, min_days: 14 });
  assert.equal(few.enough, false);
  assert.deepEqual(few.cells, []);
  assert.equal(notEnoughText(few), 'Мало истории для прогноза — нужно 14 дней, сейчас 10 дней. Прогноз и подсказки по цене появятся сами примерно через 4 дня.');
  assert.equal(forecastView(null), null);
  assert.equal(rangeWords({ from: '2026-10-25', to: '2026-10-31' }), '25–31 октября');
});

// ---------- подсказки по цене (№197) ----------

test('дни и окно подсказки словами', () => {
  assert.equal(daysWords([1, 2, 3, 4, 5]), 'В будни');
  assert.equal(daysWords([6, 7]), 'В выходные');
  assert.equal(daysWords([5]), 'В пятницу');
  assert.equal(daysWords([2]), 'Во вторник');
  assert.equal(daysWords([5, 6]), 'В пятницу и субботу');
  assert.equal(daysWords([1, 3, 5]), 'Пн, ср, пт');
  assert.equal(daysShort([1, 2, 3, 5]), 'пн–ср, пт');
  assert.equal(hoursShort(14, 17), '14–17');
  assert.equal(hoursShort(20, 0), '20–24');
  assert.equal(hoursShort(23, 2), '23–02');
  assert.equal(windowWords([1, 2, 3, 4, 5], 14, 17), 'Пн–пт, 14:00–17:00');
});

test('hintView: текст сервера, тон, цифры, клуб у «всех клубов»; чужой тип — пропуск', () => {
  const raise = hintView({ id: 'raise_price:5:20-23', type: 'raise_price', days: [5], from_hour: 20, to_hour: 23, hours: 3, utilization_pct: 91.7, queue_days: 0, sample_days: 8, weeks: 8, text: 'В пятницу 20–23 загрузка 91,7 % за 8 недель — можно поднять цену' });
  assert.equal(raise.tone, 'raise');
  assert.equal(raise.text, 'В пятницу 20–23 загрузка 91,7 % за 8 недель — можно поднять цену');
  assert.equal(raise.window, 'Пт, 20:00–23:00');
  assert.deepEqual(raise.numbers.map((n) => n.value), ['91,7 %', '8 недель']);
  const low = hintView({ type: 'lower_price', days: [1, 2, 3, 4, 5], from_hour: 14, to_hour: 17, utilization_pct: 12.5, queue_days: null, weeks: 8, club_id: 'c2', club_name: 'Второй клуб' });
  assert.equal(low.tone, 'lower');
  assert.equal(low.text, 'В будни 14–17 загрузка 12,5 % за 8 недель — подумайте о дневной цене');
  assert.equal(low.clubName, 'Второй клуб');
  const queue = hintView({ type: 'raise_price', days: [6], from_hour: 21, to_hour: 23, utilization_pct: 60, queue_days: 6, sample_days: 8, weeks: 8 });
  assert.equal(queue.text, 'В субботу 21–23 очередь в 6 из 8 дней — можно поднять цену');
  assert.ok(queue.numbers.some((n) => n.value === 'в 6 из 8 дней'));
  assert.equal(hintView({ type: 'auto_change_price', text: 'x' }), null);
  assert.equal(hintsView([null, { type: 'lower_price', days: [], text: '' }]).length, 0);
});

test('заглушка ?mock=forecast: прогноз во вкладке «Зал», подсказки по порогам сервера, у «всех клубов» прогноза нет', async () => {
  const call = backend('forecast');
  const v = await hallOf(call);
  const f = forecastView(v.hall.forecast);
  assert.equal(f.status, 'ok');
  assert.equal(f.days, 56);
  assert.equal(f.label, 'прогноз');
  const mx = heatmapMatrix(f.cells, v.period.dayStart);
  const at = (dow, h) => mx.rows[dow - 1].cells[mx.hours.indexOf(h)].pct;
  assert.ok(at(6, 21) > at(2, 21), 'суббота вечером громче вторника');
  assert.equal(at(2, 8), null, 'клуб закрыт утром');
  const hints = hintsView(v.hall.hints);
  assert.ok(hints.some((h) => h.tone === 'lower' && /^В будни \d+–\d+ загрузка/.test(h.text)));
  assert.ok(hints.some((h) => h.tone === 'raise' && /^В (пятницу|субботу) 20–23/.test(h.text)));
  assert.equal(hints[0].tone, 'raise', 'сначала «поднять цену»');
  const all = await hallOf(call, 'all');
  assert.equal(all.hall.forecast, null);
  assert.ok(hintsView(all.hall.hints).every((h) => h.clubId && h.clubName));
  // прогноз на сутки: часы в порядке рабочих суток
  const day = (await call(`/api/clubs/${CLUB}/forecast?date=2026-10-30`)).body;
  assert.equal(day.hours.length, 24);
  assert.equal(day.hours[0].hour, 6);
  assert.equal(day.label, 'прогноз');
});

test('заглушка ?mock=forecast-empty: 10 дней истории — insufficient_data, подсказок нет', async () => {
  const v = await hallOf(backend('forecast-empty'));
  const f = forecastView(v.hall.forecast);
  assert.equal(f.status, 'insufficient_data');
  assert.equal(f.enough, false);
  assert.ok(f.days < 14);
  assert.deepEqual(hintsView(v.hall.hints), []);
});

// ---------- обслуживание столов (№198) ----------

test('счётчик: порог, «скоро», без порога, с какой даты', () => {
  const c = counterView({ hours: 1628.7, since: null, threshold_hours: 1500, due: true });
  assert.equal(c.state, 'reached');
  assert.equal(c.pct, 100);
  assert.equal(c.words, '1 629 ч из 1 500 ч');
  assert.equal(c.sinceWords, 'замена не отмечена — с начала учёта');
  const near = counterView({ hours: 1400, since: '2026-03-01', threshold_hours: 1500, due: false });
  assert.equal(near.state, 'near');
  assert.equal(near.stateWord, 'скоро порог');
  assert.equal(near.sinceWords, 'с 1 марта');
  const none = counterView({ hours: 50, since: null, threshold_hours: null });
  assert.equal(none.state, 'none');
  assert.equal(none.pct, null);
  assert.equal(hoursText(12345.6), '12 346 ч');
  assert.deepEqual(DEFAULT_THRESHOLDS, { cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null });
});

test('форма события: даты 366 и 35 суток, стоимость, исправление с причиной и «не было»', () => {
  const today = '2026-10-24';
  const base = { resourceId: 'r1', kind: 'cloth', date: today, cost: null, comment: '' };
  assert.deepEqual(eventFormErrors(base, today), {});
  assert.ok(eventFormErrors({ ...base, resourceId: '' }, today).resource);
  assert.ok(eventFormErrors({ ...base, date: '2026-10-25' }, today).date);
  assert.ok(eventFormErrors({ ...base, date: '2025-10-22' }, today).date, 'старше 366 суток');
  assert.deepEqual(eventFormErrors({ ...base, date: '2025-10-23' }, today), {}, 'ровно 366 суток без стоимости');
  assert.ok(eventFormErrors({ ...base, date: '2026-09-18', cost: 100000 }, today).cost, 'со стоимостью — не старше 35 суток');
  assert.deepEqual(eventFormErrors({ ...base, date: '2026-09-19', cost: 100000 }, today), {});
  assert.ok(eventFormErrors({ ...base, cost: Number.NaN }, today).cost);
  assert.ok(eventFormErrors({ ...base, comment: 'x'.repeat(501) }, today).comment);
  assert.ok(eventFormErrors(base, today, { correction: true }).reason);
  assert.deepEqual(eventFormErrors({ resourceId: '', reason: 'не меняли', voided: true }, today, { correction: true }), {});
  assert.deepEqual(eventBody({ ...base, cost: 1800000, comment: ' сукно ' }), { resource_id: 'r1', kind: 'cloth', date: today, cost_kopecks: 1800000, comment: 'сукно' });
  assert.deepEqual(eventBody(base), { resource_id: 'r1', kind: 'cloth', date: today, cost_kopecks: 0 });
  const orig = { id: 'e1', resourceId: 'r1', kind: 'cloth', date: '2026-10-20', cost: 1800000, comment: 'сукно' };
  assert.deepEqual(correctionBody(orig, { ...orig, resourceId: 'r1', cost: 1500000, comment: 'сукно', reason: ' опечатка ' }), { corrects_id: 'e1', reason: 'опечатка', cost_kopecks: 1500000 });
  assert.deepEqual(correctionBody(orig, { reason: 'не меняли', voided: true }), { corrects_id: 'e1', reason: 'не меняли', void: true });
  assert.ok(eventServerError({ code: 'reason_required' }).reason);
  assert.ok(eventServerError({ code: 'duplicate' }).form);
  assert.equal(eventServerError({ code: 'network' }), null);
  assert.deepEqual(eventEffect({ kind: 'cloth', cost: 1800000, number: 4 }).length, 2);
});

test('пороги: целые часы 1–100 000, пусто — без порога, в PUT — только изменённые', () => {
  const cur = { cloth: 1500, balls: 3000, cushions: 5000, leveling: null, other: null };
  const r = parseThresholds({ cloth: '1 500', balls: '2500', cushions: '', leveling: '', other: '' }, cur);
  assert.deepEqual(r.errors, {});
  assert.deepEqual(r.changed, { balls: 2500, cushions: null });
  assert.ok(parseThresholds({ cloth: '0' }, cur).errors.cloth);
  assert.ok(parseThresholds({ cloth: '1,5' }, cur).errors.cloth);
  assert.ok(parseThresholds({ cloth: '100001' }, cur).errors.cloth);
});

test('таблица «По столам»: cloth_hours, cloth_since, cloth_threshold_hours, cloth_due', () => {
  assert.deepEqual(clothView({ cloth_hours: 1628.7, cloth_since: null, cloth_threshold_hours: 1500, cloth_due: true }), { hours: 1629, since: null, threshold: 1500, due: true });
  assert.equal(clothView({ cloth_hours: null }), null);
  assert.equal(clothView({ cloth_hours: 10, cloth_since: '2026-10-17', cloth_threshold_hours: 1500, cloth_due: false }).due, false);
});

test('заглушка ?mock=maintenance: счётчики, порог, событие с расходом в кассе, исправление со сторно, «не было», 409 и 400', async () => {
  const call = backend('maintenance');
  const path = `/api/clubs/${CLUB}/maintenance`;
  let v = maintenanceView((await call(path)).body);
  assert.equal(v.resources.length, 8);
  assert.equal(reachedText(v), 'Порог достигнут у 2 столов: стол 1 — сукно; стол 4 — шары.');
  assert.equal(v.thresholds.cushions, 5000);
  // таблица дашборда — те же часы сукна
  const hall = await hallOf(call);
  const t1 = hall.hall.resources.find((r) => r.number === 1);
  assert.equal(t1.cloth_due, true);
  assert.equal(t1.cloth_threshold_hours, 1500);
  // событие со стоимостью — расход «Ремонт столов»
  const ev = await call(path, 'POST', { resource_id: v.resources[0].id, kind: 'cloth', date: '2026-10-20', cost_kopecks: 1800000, comment: 'сукно' });
  assert.equal(ev.status, 201);
  assert.ok(ev.body.cashbook_entry_id);
  v = maintenanceView((await call(path)).body);
  assert.ok(v.resources[0].counters.cloth.hours < 100, 'счётчик сукна стола 1 начался заново');
  assert.equal(v.resources[0].counters.cloth.since, '2026-10-20');
  // исправление: без причины — 400, с причиной — 201, второй раз — 409
  assert.deepEqual((await call(path, 'POST', { corrects_id: ev.body.event_id })).body, { error: 'reason_required' });
  const fix = await call(path, 'POST', { corrects_id: ev.body.event_id, reason: 'опечатка в сумме', cost_kopecks: 1500000 });
  assert.equal(fix.status, 201);
  assert.equal((await call(path, 'POST', { corrects_id: ev.body.event_id, reason: 'ещё раз' })).status, 409);
  v = maintenanceView((await call(path)).body);
  const states = Object.fromEntries(v.events.map((e) => [e.id, e.state]));
  assert.equal(states[ev.body.event_id], 'corrected');
  assert.equal(states[fix.body.event_id], 'correction');
  assert.equal(canCorrect(v.events.find((e) => e.id === ev.body.event_id)), false);
  assert.match(eventStateWords(v.events.find((e) => e.id === fix.body.event_id)), /^Исправление: опечатка/);
  const cash = (await call(`/api/clubs/${CLUB}/cashbook?from=2026-10-01&to=2026-10-24`)).body.entries.filter((x) => x.category === 'Ремонт столов');
  assert.deepEqual(cash.map((x) => x.amount_kopecks).sort((a, b) => a - b), [-1800000, 1500000, 1800000], 'прежний расход сторнирован, новый внесён');
  // «события не было» — счётчик снова с начала учёта
  const gone = await call(path, 'POST', { corrects_id: fix.body.event_id, reason: 'сукно меняли на другом столе', void: true });
  assert.equal(gone.status, 201);
  v = maintenanceView((await call(path)).body);
  assert.equal(v.resources[0].counters.cloth.since, null);
  // проверки даты: со стоимостью — не старше 35 суток
  assert.equal((await call(path, 'POST', { resource_id: v.resources[1].id, kind: 'balls', date: '2026-09-01', cost_kopecks: 100 })).status, 400);
  assert.equal((await call(path, 'POST', { resource_id: v.resources[1].id, kind: 'balls', date: '2026-09-01', cost_kopecks: 0 })).status, 201);
  // пороги — только переданные виды
  const put = await call(`${path}/thresholds`, 'PUT', { cushions: 4000 });
  assert.deepEqual(put.body.thresholds, { cloth: 1500, balls: 3000, cushions: 4000, leveling: null, other: null });
  assert.equal((await call(`${path}/thresholds`, 'PUT', { cloth: 0 })).status, 400);
});

test('обслуживание: управляющий может, ресепшн — 403 и раздела не видит', async () => {
  const mgr = backend('maintenance-manager');
  assert.equal((await mgr(`/api/clubs/${CLUB}/maintenance`)).status, 200);
  assert.equal((await mgr(`/api/clubs/${CLUB}/maintenance/thresholds`, 'PUT', { cloth: 1400 })).status, 200);
  const rec = backend('reception');
  assert.equal((await rec(`/api/clubs/${CLUB}/maintenance`)).status, 403);
  assert.equal(can.reportsView('reception'), false);
  assert.ok(REPORTS.some((r) => r.key === 'maintenance'));
});
