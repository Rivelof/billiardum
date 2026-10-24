// Юнит-тесты дашборда без базы: рабочие сутки и пояс, часы, часы работы, столы в работе, медиана,
// CSV для Excel, разбор периода, плитки с прошлым периодом.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addDays, dayBounds, openWindows, sliceByHour, workingDayOf, zonedTime, ruDate, daysBetween } from '../time.mjs';
import { apportionMinutes, median, operationIntervals, sourceOf } from '../day.mjs';
import { BOM, cell, rub, toCsv } from '../csv.mjs';
import { parseQuery } from '../service.mjs';

const TZ = 'Asia/Yekaterinburg';

describe('рабочие сутки клуба (№167)', () => {
  it('сутки с 06:00 по местному времени, игра 05:30 — прошлые сутки', () => {
    const b = dayBounds('2026-10-20', TZ, '06:00');
    assert.equal(b.from.toISOString(), '2026-10-20T01:00:00.000Z');
    assert.equal(b.to.toISOString(), '2026-10-21T01:00:00.000Z');
    assert.equal(workingDayOf(zonedTime('2026-10-21', '05:30', TZ), TZ, '06:00'), '2026-10-20');
    assert.equal(workingDayOf(zonedTime('2026-10-21', '06:00', TZ), TZ, '06:00'), '2026-10-21');
  });

  it('пояс с переходом на летнее время: сутки 23 и 25 часов', () => {
    const spring = dayBounds('2026-03-28', 'Europe/Berlin', '06:00');
    assert.equal((spring.to - spring.from) / 3600_000, 23);
    const autumn = dayBounds('2026-10-25', 'Europe/Berlin', '06:00');
    assert.equal((autumn.to - autumn.from) / 3600_000, 24);
    const autumnNight = dayBounds('2026-10-24', 'Europe/Berlin', '06:00');
    assert.equal((autumnNight.to - autumnNight.from) / 3600_000, 25);
  });

  it('даты, дни периода, ДД.ММ.ГГГГ', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysBetween('2026-01-01', '2026-12-31'), 365);
    assert.equal(ruDate('2026-10-05'), '05.10.2026');
  });
});

describe('часы', () => {
  it('интервал режется по местным часам', () => {
    const s = sliceByHour(zonedTime('2026-10-20', '12:40', TZ), zonedTime('2026-10-20', '14:10', TZ), TZ);
    assert.deepEqual(s.map((x) => [x.hour, x.ms / 60_000]), [[12, 20], [13, 60], [14, 10]]);
  });

  it('часы работы (№170): нет настройки — 24 часа; 10:00–02:00 — 16 часов; выходной — 0', () => {
    const all = openWindows('2026-10-20', TZ, '06:00', {});
    assert.equal((all[0].to - all[0].from) / 3600_000, 24);
    const w = openWindows('2026-10-20', TZ, '06:00', { open_hours: { open: '10:00', close: '02:00' } });
    assert.equal(w.length, 1);
    assert.equal(w[0].from.toISOString(), zonedTime('2026-10-20', '10:00', TZ).toISOString());
    assert.equal((w[0].to - w[0].from) / 3600_000, 16);
    // 2026-10-20 — вторник (2).
    assert.deepEqual(openWindows('2026-10-20', TZ, '06:00', { open_hours: { open: '10:00', close: '02:00', days: { 2: null } } }), []);
    const early = openWindows('2026-10-20', TZ, '06:00', { open_hours: { open: '05:00', close: '07:00' } });
    // Открытие 05:00 относится к следующей местной дате: 05:00–06:00 следующего утра (конец суток).
    assert.equal((early[0].to - early[0].from) / 3600_000, 1);
  });
});

describe('стол в работе (№170)', () => {
  const created = '2026-10-01T00:00:00.000Z';
  const t = (s) => new Date(s).getTime();
  it('вывод из работы и возврат — интервалы', () => {
    const r = { created_at: created, active: true };
    const ev = [
      { action: 'resource.deactivate', created_at: '2026-10-10T00:00:00.000Z' },
      { action: 'manual.resource_add', created_at: '2026-10-12T00:00:00.000Z' },
    ];
    assert.deepEqual(operationIntervals(r, ev, t('2026-10-20T00:00:00Z')), [
      { from: t(created), to: t('2026-10-10T00:00:00Z') },
      { from: t('2026-10-12T00:00:00Z'), to: t('2026-10-20T00:00:00Z') },
    ]);
  });
  it('без событий — по текущему признаку', () => {
    assert.deepEqual(operationIntervals({ created_at: created, active: false }, [], t('2026-10-20T00:00:00Z')), []);
    assert.equal(operationIntervals({ created_at: created, active: true }, [], t('2026-10-20T00:00:00Z')).length, 1);
  });
});

describe('ёмкость по часам = итогу (Н1 M5.2)', () => {
  it('сумма ячеек = округлению суммы, каждая ячейка — не дальше минуты от точной', () => {
    const M = 60_000;
    // Неполные сутки: 8 столов, у каждого первый и последний час — по 29,6 мин и 30,4 мин.
    const cells = [];
    for (let t = 0; t < 8; t += 1) cells.push(29.6 * M, 60 * M, 60 * M, 30.4 * M - 7_000);
    const out = apportionMinutes(cells);
    const total = cells.reduce((a, x) => a + x, 0);
    assert.equal(out.reduce((a, x) => a + x, 0), Math.round(total / M));
    // Поячеечное округление дало бы другое число (так и было: 1 360 против 1 358).
    assert.notEqual(cells.reduce((a, x) => a + Math.round(x / M), 0), Math.round(total / M));
    for (const [i, x] of out.entries()) assert.ok(Math.abs(x - cells[i] / M) < 1, `ячейка ${i}`);
    assert.deepEqual(apportionMinutes([]), []);
    assert.deepEqual(apportionMinutes([60 * M, 60 * M]), [60, 60]);
  });
});

describe('метрики', () => {
  it('медиана', () => {
    assert.equal(median([]), null);
    assert.equal(median([30, 10, 20]), 20);
    assert.equal(median([10, 20, 30, 40]), 25);
  });
  it('источник денег', () => {
    assert.equal(sourceOf({ provider: 'reception', kind: 'bar' }), 'reception');
    assert.equal(sourceOf({ provider: 'yookassa', kind: 'booking' }), 'booking');
    assert.equal(sourceOf({ provider: 'yookassa', kind: 'tournament' }), 'tournament');
    assert.equal(sourceOf({ provider: 'yookassa', kind: 'extend' }), 'qr');
  });
});

describe('CSV для Excel (№172)', () => {
  it('BOM, «;», CRLF, рубли с запятой, защита от формул', () => {
    const csv = toCsv(['Дата', 'Сумма'], [['01.10.2026', rub(149050)], ['=1+1', rub(-500)], ['a;b', '"x"']]);
    assert.ok(csv.startsWith(BOM));
    assert.equal(csv, `${BOM}Дата;Сумма\r\n01.10.2026;1490,50\r\n'=1+1;-5,00\r\n"a;b";"""x"""\r\n`);
    assert.equal(cell('-1+2'), "'-1+2");
    assert.equal(cell('+79991234567'), "'+79991234567");
    assert.equal(rub(0), '0,00');
  });
});

describe('период и плитки', () => {
  it('период больше 366 дней — 400, неверная вкладка и тип — 400', () => {
    assert.throws(() => parseQuery({ from: '2025-01-01', to: '2026-01-02' }, { today: '2026-01-02' }), (e) => e.status === 400);
    assert.equal(parseQuery({ from: '2025-01-02', to: '2026-01-02' }, { today: '2026-01-02' }).days, 366);
    assert.throws(() => parseQuery({ tab: 'x' }, { today: '2026-01-02' }), (e) => e.status === 400);
    assert.throws(() => parseQuery({ kind: 'darts' }, { today: '2026-01-02' }), (e) => e.status === 400);
    assert.throws(() => parseQuery({ from: '2026-02-30' }, { today: '2026-01-02' }), (e) => e.status === 400);
    const q = parseQuery({ from: '2026-10-01', to: '2026-10-07' }, { today: '2026-10-24' });
    assert.deepEqual([q.prevFrom, q.prevTo, q.compare, q.tab], ['2026-09-24', '2026-09-30', true, 'summary']);
  });
});
