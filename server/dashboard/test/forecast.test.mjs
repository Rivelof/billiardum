// Прогноз загрузки и подсказки по цене (M5.6 №196–197, T43): чистая логика на синтетической истории.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { basisDow, forecastForDate, forecastFrom, hintsFrom, historyWindow, hourOrder, MIN_HISTORY_DAYS, medianOf } from '../forecast.mjs';
import { addDays, isoDow } from '../time.mjs';

const ORDER = hourOrder('06:00');
const OPEN = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1]);

/** Сутки: pctOf(dow, hour, weekIndex) → загрузка %, cap — 120 минут в открытый час; queueOf → гостей в очереди. */
function day(date, { holidays = new Set(), pctOf, queueOf = () => 0, week }) {
  const dow = basisDow(date, holidays, 7);
  return {
    day: date,
    dow,
    holiday: holidays.has(date),
    hours: Array.from({ length: 24 }, (_, h) => {
      if (!OPEN.has(h)) return { play: 0, cap: 0, queue: 0 };
      return { play: Math.round((pctOf(dow, h, week) / 100) * 120), cap: 120, queue: queueOf(dow, h, week) };
    }),
  };
}

function history(n, opts) {
  const to = '2026-11-15'; // воскресенье
  const days = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = addDays(to, -i);
    days.push(day(d, { ...opts, week: Math.floor((n - 1 - i) / 7) }));
  }
  return { window: { from: days[0]?.day ?? to, to, today: addDays(to, 1) }, days, holidays: new Map([...(opts.holidays ?? [])].map((x) => [x, 'Праздник'])), holidayIsoDay: 7, order: ORDER };
}

describe('прогноз (№196)', () => {
  it('медиана по дню недели и часу совпадает с расчётом', () => {
    // Загрузка меняется по неделям: среда 18:00 — 10, 20, …, 80 % → медиана 45.
    const h = history(56, { pctOf: (dow, hour, w) => (dow === 3 && hour === 18 ? 10 * (w + 1) : dow >= 6 ? 50 : 25) });
    const f = forecastFrom(h);
    assert.equal(f.status, 'ok');
    assert.equal(f.enough, true);
    assert.equal(f.history_days, 56);
    assert.equal(f.history_weeks, 8);
    assert.equal(f.pct[2][18], 45);
    assert.equal(f.samples[2][18], 8);
    assert.equal(f.pct[5][12], 50);
    assert.equal(f.pct[0][12], 25);
    // Закрыто — null, без образцов.
    assert.equal(f.pct[0][7], null);
    assert.equal(f.samples[0][7], 0);
    // Независимый расчёт по всем ячейкам.
    for (let dow = 1; dow <= 7; dow += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const vals = h.days.filter((d) => d.dow === dow && d.hours[hour].cap > 0).map((d) => (d.hours[hour].play / d.hours[hour].cap) * 100);
        const m = medianOf(vals);
        assert.equal(f.pct[dow - 1][hour], m === null ? null : Math.round(m * 10) / 10, `${dow} ${hour}`);
      }
    }
  });

  it('праздник клуба считается выходным (воскресенье), в будни не входит', () => {
    const holiday = '2026-11-04'; // среда
    const holidays = new Set([holiday]);
    const h = history(56, { holidays, pctOf: (dow) => (dow === 7 ? 90 : 10) });
    const f = forecastFrom(h);
    assert.equal(h.days.find((d) => d.day === holiday).dow, 7);
    assert.equal(f.samples[2][12], 7, 'среда без праздника');
    assert.equal(f.samples[6][12], 9, 'воскресенье с праздником');
    const day = forecastForDate(f, { date: holiday, holidayTitle: 'День клуба', order: ORDER });
    assert.equal(day.basis_dow, 7);
    assert.equal(day.iso_dow, 3);
    assert.deepEqual(day.holiday, { title: 'День клуба' });
    assert.equal(day.hours[0].hour, 6, 'часы — в порядке рабочих суток');
    assert.equal(day.hours.find((x) => x.hour === 12).pct, 90);
    assert.equal(day.label, 'прогноз');
    const plain = forecastForDate(f, { date: '2026-11-11', order: ORDER });
    assert.equal(plain.basis_dow, 3);
    assert.equal(plain.hours.find((x) => x.hour === 12).pct, 10);
  });

  it('меньше двух недель истории — «мало данных», подсказок нет', () => {
    const h = history(MIN_HISTORY_DAYS - 1, { pctOf: () => 5 });
    const f = forecastFrom(h);
    assert.equal(f.status, 'insufficient_data');
    assert.equal(f.enough, false);
    assert.equal(f.pct, null);
    assert.deepEqual(hintsFrom(h), []);
    const d = forecastForDate(f, { date: '2026-11-16', order: ORDER });
    assert.equal(d.status, 'insufficient_data');
    assert.ok(d.hours.every((x) => x.pct === null));
    assert.equal(forecastFrom(history(MIN_HISTORY_DAYS, { pctOf: () => 5 })).status, 'ok');
  });

  it('окно истории — с перехода в live, тестовый клуб — без истории', () => {
    const now = new Date('2026-11-20T09:00:00Z');
    const club = { timezone: 'Asia/Yekaterinburg', day_start_local: '06:00', created_at: '2026-01-01T00:00:00Z', mode: 'live', went_live_at: null };
    assert.deepEqual(historyWindow(club, now), { from: '2026-09-25', to: '2026-11-19', today: '2026-11-20' });
    assert.equal(historyWindow({ ...club, went_live_at: '2026-11-01T10:00:00Z' }, now).from, '2026-11-01');
    assert.equal(historyWindow({ ...club, mode: 'test' }, now), null);
    assert.equal(historyWindow({ ...club, mode: 'suspended', mode_before_suspend: 'test' }, now), null);
    assert.equal(historyWindow({ ...club, created_at: '2026-11-10T10:00:00Z' }, now).from, '2026-11-10');
  });
});

describe('подсказки по цене (№197)', () => {
  // Будни 14–17 — 12,5 %, пятница 20–23 — 92 %, суббота 21–23 — очередь (загрузка 60 %), остальное — 50 %.
  const pctOf = (dow, h) => {
    if (dow <= 5 && h >= 14 && h < 17) return 12.5;
    if (dow === 5 && h >= 20 && h < 23) return 92;
    if (dow === 6 && h >= 21 && h < 23) return 60;
    return 50;
  };
  const queueOf = (dow, h, w) => (dow === 6 && h >= 21 && h < 23 && w % 4 !== 0 ? 2 : 0);

  it('правила по порогам и тексты с окном, днями и цифрами', () => {
    const hints = hintsFrom(history(56, { pctOf, queueOf }));
    assert.deepEqual(hints.map((x) => [x.type, x.days, x.from_hour, x.to_hour]), [
      ['raise_price', [5], 20, 23],
      ['raise_price', [6], 21, 23],
      ['lower_price', [1, 2, 3, 4, 5], 14, 17],
    ]);
    const [fri, sat, low] = hints;
    assert.equal(low.utilization_pct, 12.5);
    assert.equal(low.text, 'В будни 14–17 загрузка 12,5 % за 8 недель — подумайте о дневной цене');
    assert.equal(fri.text, 'В пятницу 20–23 загрузка 91,7 % за 8 недель — можно поднять цену');
    assert.equal(sat.queue_days, 6);
    assert.equal(sat.sample_days, 8);
    assert.equal(sat.text, 'В субботу 21–23 очередь в 6 из 8 дней (загрузка 60 %) — можно поднять цену');
    for (const x of hints) assert.match(x.text, /^[ВвО]/);
  });

  it('пороги: 2 часа низкой загрузки и 85 % ровно — без подсказок; меньше 4 недель — без подсказок', () => {
    const edge = (dow, h) => (dow <= 5 && h >= 14 && h < 16 ? 10 : dow === 5 && h >= 20 && h < 23 ? 85 : 50);
    assert.deepEqual(hintsFrom(history(56, { pctOf: edge })), []);
    assert.deepEqual(hintsFrom(history(21, { pctOf, queueOf })), [], '3 недели');
    assert.equal(hintsFrom(history(28, { pctOf, queueOf })).filter((x) => x.type === 'lower_price').length, 1, '4 недели');
  });

  it('одинаковые окна разных дней — одна подсказка; вторник — «Во вторник»; праздник не входит в будни', () => {
    const p = (dow, h) => ((dow === 2 || dow === 3) && h >= 19 && h < 22 ? 95 : 50);
    const hints = hintsFrom(history(56, { pctOf: p }));
    assert.equal(hints.length, 1);
    assert.deepEqual(hints[0].days, [2, 3]);
    assert.match(hints[0].text, /^Во вторник и среду 19–22 загрузка 95 %/);
    // Праздник с полной загрузкой 14–17 не «портит» будни: он — воскресенье.
    const holidays = new Set(['2026-11-04']);
    const q = (dow, h) => (dow <= 5 && h >= 14 && h < 17 ? 10 : 50);
    const withHoliday = hintsFrom(history(56, { holidays, pctOf: q }));
    assert.equal(withHoliday[0].utilization_pct, 10);
  });

  it('окно через полночь — по порядку рабочих суток', () => {
    const p = (dow, h) => (dow === 6 && (h === 23 || h === 0 || h === 1) ? 90 : 50);
    const [x] = hintsFrom(history(56, { pctOf: p }));
    assert.equal(x.text, 'В субботу 23–02 загрузка 90 % за 8 недель — можно поднять цену');
    assert.equal(isoDow('2026-11-14'), 6);
  });
});
