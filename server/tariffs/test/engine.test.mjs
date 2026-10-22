// Движок тарифов (PRODUCT §9, decisions №43, №44): чистые функции, без базы.
// Тариф — пример PRODUCT §9 (как в сиде), клуб в Asia/Yekaterinburg (UTC+5).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  actualMinutes,
  amountForMinutes,
  billedMinutes,
  compileRules,
  createCalendar,
  formatDuration,
  formatLocalTime,
  parseLocalTime,
  pricesAround,
  roundAmount,
  ruleAt,
  TariffError,
} from '../engine.mjs';

const PYRAMID = { id: 'e1000000-0000-4000-8000-000000000001', type: 'billiard_pyramid' };
const TZ = 'Asia/Yekaterinburg';

function rule(id, days, start, end, price, extra = {}) {
  return { id, resource_type: 'billiard_pyramid', resource_id: null, days, start_local: start, end_local: end, price_per_hour: price, step_minutes: 1, min_minutes: 30, priority: 0, active: true, ...extra };
}

// PRODUCT §9: 12–17 / 17–00 / 00–06; пн–чт 500/800/900, пт–вс и праздники 600/1000/1100.
const SEED_RULES = [
  rule('r1', [1, 2, 3, 4], '12:00:00', '17:00:00', 50000),
  rule('r2', [1, 2, 3, 4], '17:00:00', '00:00:00', 80000),
  rule('r3', [1, 2, 3, 4], '00:00:00', '06:00:00', 90000),
  rule('r4', [5, 6, 7], '12:00:00', '17:00:00', 60000),
  rule('r5', [5, 6, 7], '17:00:00', '00:00:00', 100000),
  rule('r6', [5, 6, 7], '00:00:00', '06:00:00', 110000),
];

// 2026: 4 ноября (ср) — праздник, 31 декабря (чт) — перенесённый выходной.
const HOLIDAYS = ['2026-11-04', '2026-12-31', '2027-01-01'];

function setup({ timezone = TZ, rules = SEED_RULES, dayStartLocal = '06:00', holidays = HOLIDAYS, holidayIsoDay = 7, resource = PYRAMID } = {}) {
  const calendar = createCalendar({ timezone, dayStartLocal, holidays, holidayIsoDay });
  return { calendar, rules: compileRules(rules, resource, calendar) };
}

/** Местное время Екатеринбурга (UTC+5) → Date. */
function ekb(local) {
  return new Date(`${local}+05:00`);
}

function amount(local, minutes, opts = {}) {
  const { calendar, rules } = setup(opts);
  return amountForMinutes({ rules, calendar, from: opts.utc ?? ekb(local), minutes, rounding: opts.rounding ?? 100, fill: opts.fill });
}

describe('время и календарь', () => {
  it('разбор и формат местного времени', () => {
    assert.equal(parseLocalTime('00:00:00'), 0);
    assert.equal(parseLocalTime('17:30'), 1050);
    assert.equal(parseLocalTime('24:00'), 0);
    assert.throws(() => parseLocalTime('25:00'), TariffError);
    assert.throws(() => parseLocalTime('7:00'), TariffError);
    assert.equal(formatLocalTime(0), '00:00');
    assert.equal(formatLocalTime(1439), '23:59');
  });

  it('Asia/Yekaterinburg: местное время UTC+5', () => {
    const { calendar } = setup();
    const l = calendar.localAt(Date.parse('2026-10-20T19:30:00Z'));
    assert.deepEqual(l, { date: '2026-10-21', minuteOfDay: 30, isoWeekday: 3 });
  });

  it('рабочие сутки: 00:00–06:00 относятся к прошлым суткам', () => {
    const { calendar } = setup();
    const sat3am = calendar.workdayAt(ekb('2026-10-24T03:00:00').getTime());
    assert.equal(sat3am.workday, '2026-10-23');
    assert.equal(sat3am.dayType, 5);
    assert.equal(sat3am.offset, 21 * 60);
    const sat6am = calendar.workdayAt(ekb('2026-10-24T06:00:00').getTime());
    assert.equal(sat6am.workday, '2026-10-24');
    assert.equal(sat6am.offset, 0);
  });

  it('праздник — день holiday_iso_day, по умолчанию воскресенье', () => {
    const { calendar } = setup();
    assert.equal(calendar.dayType('2026-11-04'), 7);
    assert.equal(calendar.dayType('2026-11-05'), 4);
    const sat = setup({ holidayIsoDay: 6 }).calendar;
    assert.equal(sat.dayType('2026-11-04'), 6);
  });

  it('неизвестный часовой пояс — ошибка', () => {
    assert.throws(() => createCalendar({ timezone: 'Mars/Olympus' }), (e) => e.code === 'bad_tariff');
  });
});

describe('поминутный расчёт по PRODUCT §9', () => {
  it('будний день 13:00, 1 час — 500 ₽', () => {
    const r = amount('2026-10-20T13:00:00', 60);
    assert.equal(r.amount_kopecks, 50000);
    assert.equal(r.breakdown.length, 1);
    assert.deepEqual(r.breakdown[0], {
      from: '2026-10-20T08:00:00.000Z',
      to: '2026-10-20T09:00:00.000Z',
      price_per_hour_kopecks: 50000,
      minutes: 60,
      amount_kopecks: 50000,
    });
  });

  it('через смену правила 16:30–17:30: 30 мин по 500 и 30 мин по 800', () => {
    const r = amount('2026-10-20T16:30:00', 60);
    assert.equal(r.amount_kopecks, 65000);
    assert.deepEqual(r.breakdown.map((b) => [b.price_per_hour_kopecks, b.minutes, b.amount_kopecks]), [
      [50000, 30, 25000],
      [80000, 30, 40000],
    ]);
  });

  it('через полночь во вторник: 23:30–00:30 — 800 и ночь вторника 900', () => {
    const r = amount('2026-10-20T23:30:00', 60);
    assert.equal(r.amount_kopecks, 40000 + 45000);
  });

  it('ночь пятницы по рабочим суткам: Пт 23:00 – Сб 01:00 = 1000 + 1100', () => {
    assert.equal(amount('2026-10-23T23:00:00', 120).amount_kopecks, 210000);
  });

  it('ночь четверга: Пт 00:00–01:00 по календарю — ещё четверг, 900', () => {
    const r = amount('2026-10-22T23:00:00', 120);
    assert.equal(r.amount_kopecks, 80000 + 90000);
    assert.equal(r.breakdown[1].price_per_hour_kopecks, 90000);
  });

  it('ночь воскресенья: Пн 00:00–01:00 по календарю — воскресенье, 1100', () => {
    assert.equal(amount('2026-10-25T23:00:00', 120).amount_kopecks, 100000 + 110000);
  });

  it('ночь понедельника — будни, 900', () => {
    assert.equal(amount('2026-10-26T23:00:00', 120).amount_kopecks, 80000 + 90000);
  });

  it('через выходной: Пт 16:00–18:00 — цены пятницы (600 и 1000)', () => {
    assert.equal(amount('2026-10-23T16:00:00', 120).amount_kopecks, 60000 + 100000);
  });

  it('праздник в будни (ср 4 ноября) считается выходным', () => {
    assert.equal(amount('2026-11-04T13:00:00', 60).amount_kopecks, 60000);
    assert.equal(amount('2026-11-04T17:00:00', 60).amount_kopecks, 100000);
  });

  it('ночь праздника (4→5 ноября) — по праздничным суткам, 1100', () => {
    assert.equal(amount('2026-11-05T01:00:00', 60).amount_kopecks, 110000);
  });

  it('ночь накануне праздника (3→4 ноября) — ещё будний вторник, 900', () => {
    assert.equal(amount('2026-11-04T01:00:00', 60).amount_kopecks, 90000);
  });

  it('31 декабря 2026 (чт, перенесённый выходной): вечер и новогодняя ночь — праздничные', () => {
    const r = amount('2026-12-31T23:00:00', 120);
    assert.equal(r.amount_kopecks, 100000 + 110000);
  });

  it('без праздников 4 ноября — обычная среда', () => {
    assert.equal(amount('2026-11-04T13:00:00', 60, { holidays: [] }).amount_kopecks, 50000);
  });

  it('разрыв в тарифе (06:00–12:00 нет правила): котировка — no_tariff', () => {
    assert.throws(() => amount('2026-10-21T05:30:00', 60), (e) => e instanceof TariffError && e.code === 'no_tariff');
  });

  it('разрыв в тарифе при fill=carry: минуты считаются по соседнему правилу', () => {
    const r = amount('2026-10-21T05:30:00', 60, { fill: 'carry' });
    assert.equal(r.amount_kopecks, 90000);
  });

  it('несколько суток подряд при круглосуточном тарифе', () => {
    const rules = [rule('d', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 60000)];
    const r = amount('2026-10-20T10:00:00', 30 * 60, { rules });
    assert.equal(r.amount_kopecks, 30 * 60000);
    assert.equal(r.breakdown.length, 1);
  });
});

describe('округление один раз (№44)', () => {
  it('47 минут по 800 ₽/ч = 626,67 ₽ → 627 ₽', () => {
    assert.equal(amount('2026-10-20T18:00:00', 47).amount_kopecks, 62700);
  });

  it('округление до копейки (price_rounding_kopecks = 1)', () => {
    assert.equal(amount('2026-10-20T18:00:00', 47, { rounding: 1 }).amount_kopecks, 62667);
  });

  it('округление до 10 ₽', () => {
    assert.equal(amount('2026-10-20T18:00:00', 47, { rounding: 1000 }).amount_kopecks, 63000);
  });

  it('половина вверх: ровно 50 копеек → 1 ₽, 49 копеек → 0', () => {
    assert.equal(roundAmount(3000, 100), 100);
    assert.equal(roundAmount(2940, 100), 0);
    assert.equal(roundAmount(2999, 100), 0);
  });

  it('округляется сумма, а не каждая минута', () => {
    // 1 минута по 800 ₽/ч = 13,33 ₽; 60 минут — ровно 800 ₽, а не 60 × 13 ₽.
    assert.equal(amount('2026-10-20T18:00:00', 60).amount_kopecks, 80000);
    assert.equal(amount('2026-10-20T18:00:00', 1).amount_kopecks, 1300);
  });

  it('разбивка в сумме даёт итог, каждая часть кратна округлению', () => {
    const rules = [
      rule('a', [1, 2, 3, 4, 5, 6, 7], '00:00', '09:17', 77700),
      rule('b', [1, 2, 3, 4, 5, 6, 7], '09:17', '15:43', 33300),
      rule('c', [1, 2, 3, 4, 5, 6, 7], '15:43', '00:00', 99900),
    ];
    let seed = 7;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i += 1) {
      const from = Date.parse('2026-10-19T00:00:00Z') + rnd(7 * 1440) * 60000 + rnd(60) * 1000;
      const minutes = 1 + rnd(600);
      const rounding = [1, 100, 1000][rnd(3)];
      const r = amount(null, minutes, { rules, utc: new Date(from), rounding });
      assert.equal(r.breakdown.reduce((s, b) => s + b.amount_kopecks, 0), r.amount_kopecks);
      assert.equal(r.breakdown.reduce((s, b) => s + b.minutes, 0), minutes);
      for (const b of r.breakdown) assert.equal(b.amount_kopecks % rounding, 0);
      assert.ok(Math.abs(r.amount_kopecks - r.exact_kopecks) <= rounding / 2);
    }
  });
});

describe('шаг и минимум', () => {
  it('минимум 30 минут: 10 минут игры → 30', () => {
    assert.equal(billedMinutes(10, { step: 1, min: 30 }), 30);
    assert.equal(billedMinutes(10, { step: 1, min: 30, applyMinimum: false }), 10);
  });

  it('шаг 15 минут: 31 → 45, 45 → 45', () => {
    assert.equal(billedMinutes(31, { step: 15, min: 30 }), 45);
    assert.equal(billedMinutes(45, { step: 15, min: 30 }), 45);
    assert.equal(billedMinutes(0, { step: 15, min: 0 }), 0);
  });

  it('фактические минуты: начатая минута — целая, доли секунды отбрасываются', () => {
    const t = Date.parse('2026-10-20T10:00:00Z');
    assert.equal(actualMinutes(t, t + 60_400), 1);
    assert.equal(actualMinutes(t, t + 61_000), 2);
    assert.equal(actualMinutes(t, t + 3_600_900), 60);
    assert.equal(actualMinutes(t, t + 3_601_000), 61);
    assert.equal(actualMinutes(t, t - 5_000), 0);
  });

  it('шаг и минимум берутся из правила начала игры', () => {
    const rules = compileRules([rule('s', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 60000, { step_minutes: 15, min_minutes: 60 })], PYRAMID, setup().calendar);
    const r = ruleAt(rules, setup().calendar, Date.now());
    assert.equal(r.step, 15);
    assert.equal(r.min, 60);
  });
});

describe('выбор правила', () => {
  it('правило конкретного стола главнее правила типа, затем priority', () => {
    const rules = [
      rule('type-hi', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 10000, { priority: 100 }),
      rule('table', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 20000, { resource_type: null, resource_id: PYRAMID.id }),
      rule('other-table', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 30000, { resource_type: null, resource_id: 'e1000000-0000-4000-8000-000000000002' }),
    ];
    assert.equal(amount('2026-10-20T13:00:00', 60, { rules }).amount_kopecks, 20000);
    const typeOnly = [rules[0], rule('type-lo', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 5000, { priority: 1 })];
    assert.equal(amount('2026-10-20T13:00:00', 60, { rules: typeOnly }).amount_kopecks, 10000);
  });

  it('правила другого типа стола и выключенные не применяются', () => {
    const rules = [
      rule('pool', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 99900, { resource_type: 'billiard_pool' }),
      rule('off', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 88800, { active: false }),
      rule('on', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 50000),
    ];
    assert.equal(amount('2026-10-20T13:00:00', 60, { rules }).amount_kopecks, 50000);
  });

  it('интервал через начало рабочих суток (04:00–08:00) принадлежит суткам, где начался', () => {
    const rules = [
      rule('fri-early', [5], '04:00', '08:00', 70000),
      rule('rest', [1, 2, 3, 4, 5, 6, 7], '00:00', '00:00', 10000, { priority: -1 }),
    ];
    // Сб 05:00 и Сб 07:00 — пятничный интервал (начался в пятничных сутках).
    assert.equal(amount('2026-10-24T05:00:00', 60, { rules }).amount_kopecks, 70000);
    assert.equal(amount('2026-10-24T07:00:00', 60, { rules }).amount_kopecks, 70000);
    // Пт 07:00 — хвост четвергового интервала, а у четверга такого правила нет.
    assert.equal(amount('2026-10-23T07:00:00', 60, { rules }).amount_kopecks, 10000);
    // Сб 08:00 — интервал закончился.
    assert.equal(amount('2026-10-24T08:00:00', 60, { rules }).amount_kopecks, 10000);
  });

  it('начало суток 00:00 (календарные сутки): ночь пятницы — субботняя', () => {
    const rules = [
      rule('wd-night', [1, 2, 3, 4, 5], '00:00', '06:00', 90000),
      rule('we-night', [6, 7], '00:00', '06:00', 110000),
    ];
    assert.equal(amount('2026-10-24T01:00:00', 60, { rules, dayStartLocal: '00:00' }).amount_kopecks, 110000);
    assert.equal(amount('2026-10-24T01:00:00', 60, { rules }).amount_kopecks, 90000);
  });
});

describe('часовые пояса и летнее время', () => {
  const ALL_DAY = [rule('n', [1, 2, 3, 4, 5, 6, 7], '00:00', '03:00', 10000), rule('d', [1, 2, 3, 4, 5, 6, 7], '03:00', '00:00', 20000)];

  it('Europe/Berlin, переход на летнее время 29.03.2026: 60 реальных минут', () => {
    // 00:30Z = 01:30 CET; 01:00Z = 03:00 CEST. 30 минут ночного тарифа, 30 — дневного.
    const r = amount(null, 60, { timezone: 'Europe/Berlin', rules: ALL_DAY, utc: new Date('2026-03-29T00:30:00Z') });
    assert.equal(r.amount_kopecks, 5000 + 10000);
    assert.equal(r.breakdown[1].from, '2026-03-29T01:00:00.000Z');
  });

  it('Europe/Berlin, обратный переход 25.10.2026: повторный час не теряется и не удваивается', () => {
    // 00:30Z = 02:30 CEST, 01:00Z = 02:00 CET, 02:00Z = 03:00 CET.
    const r = amount(null, 120, { timezone: 'Europe/Berlin', rules: ALL_DAY, utc: new Date('2026-10-25T00:30:00Z') });
    assert.equal(r.amount_kopecks, 90 * (10000 / 60) + 30 * (20000 / 60));
  });

  it('America/New_York: рабочие сутки по местному времени после перехода 08.03.2026', () => {
    const rules = [rule('sat-night', [6], '00:00', '06:00', 60000), rule('other', [1, 2, 3, 4, 5, 7], '00:00', '06:00', 30000)];
    // Вс 08.03 03:30 EDT = 07:30Z — ночь субботы по рабочим суткам.
    const r = amount(null, 60, { timezone: 'America/New_York', rules, utc: new Date('2026-03-08T07:30:00Z') });
    assert.equal(r.amount_kopecks, 60000);
  });

  it('один и тот же момент в разных поясах — разные цены', () => {
    const utc = new Date('2026-10-20T12:30:00Z'); // 17:30 в Екатеринбурге, 15:30 в Москве
    assert.equal(amount(null, 60, { utc }).amount_kopecks, 80000);
    assert.equal(amount(null, 60, { utc, timezone: 'Europe/Moscow' }).amount_kopecks, 50000);
  });

  it('минуты, не совпадающие с границей, классифицируются по началу минуты', () => {
    const r = amount(null, 2, { utc: new Date(ekb('2026-10-20T16:59:30').getTime()) });
    assert.equal(r.breakdown.length, 2);
    assert.deepEqual(r.breakdown.map((b) => b.price_per_hour_kopecks), [50000, 80000]);
  });
});

describe('pricesAround', () => {
  function around(local, opts = {}) {
    const { calendar, rules } = setup(opts);
    return pricesAround({ rules, calendar, at: ekb(local) });
  }

  it('вторник 16:00: 500 ₽ до 17:00, потом 800', () => {
    assert.deepEqual(around('2026-10-20T16:00:00'), {
      price_now: { price_per_hour_kopecks: 50000, until_local: '17:00', until: '2026-10-20T12:00:00.000Z' },
      price_next: { price_per_hour_kopecks: 80000, from_local: '17:00', from: '2026-10-20T12:00:00.000Z' },
    });
  });

  it('вторник 23:10: 800 ₽ до 00:00, потом 900 (ночь вторника)', () => {
    const p = around('2026-10-20T23:10:00');
    assert.equal(p.price_now.until_local, '00:00');
    assert.equal(p.price_next.price_per_hour_kopecks, 90000);
  });

  it('пятница 23:10: 1000 ₽ до 00:00, потом 1100', () => {
    const p = around('2026-10-23T23:10:00');
    assert.equal(p.price_now.price_per_hour_kopecks, 100000);
    assert.equal(p.price_next.price_per_hour_kopecks, 110000);
  });

  it('05:00: до 06:00, дальше тарифа нет', () => {
    const p = around('2026-10-21T05:00:00');
    assert.equal(p.price_now.price_per_hour_kopecks, 90000);
    assert.equal(p.price_now.until_local, '06:00');
    assert.equal(p.price_next, null);
  });

  it('08:00 (нет правила): сейчас цены нет, следующая с 12:00', () => {
    const p = around('2026-10-21T08:00:00');
    assert.equal(p.price_now, null);
    assert.deepEqual(p.price_next, { price_per_hour_kopecks: 50000, from_local: '12:00', from: '2026-10-21T07:00:00.000Z' });
  });

  it('одинаковая цена у соседних правил — смены цены нет', () => {
    const rules = [rule('a', [1, 2, 3, 4, 5, 6, 7], '00:00', '12:00', 50000), rule('b', [1, 2, 3, 4, 5, 6, 7], '12:00', '00:00', 50000)];
    assert.deepEqual(around('2026-10-20T10:00:00', { rules }), {
      price_now: { price_per_hour_kopecks: 50000, until_local: null, until: null },
      price_next: null,
    });
  });
});

describe('formatDuration', () => {
  it('часы и минуты', () => {
    assert.equal(formatDuration(60), '1 ч');
    assert.equal(formatDuration(120), '2 ч');
    assert.equal(formatDuration(90), '1 ч 30 мин');
    assert.equal(formatDuration(30), '30 мин');
    assert.equal(formatDuration(107), '1 ч 47 мин');
  });
});
