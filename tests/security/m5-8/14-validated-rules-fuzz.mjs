// PoC M5.8, заход 2 — Н-2: обход порога 1 ₽ подбором правил. Случайные правила проходят через НАСТОЯЩИЙ
// normalizeRules (server/setup/tariffs.mjs); принятые правила считаются НАСТОЯЩИМ amountFor (server/tariffs/index.mjs)
// на подменной базе (как в 05-engine-pricing). Для принятых наборов проверяется:
//   * платная игра: старт (minimum), продление (шаг), бронь (кратно 30 минутам, 60…240), в том числе на границе
//     двух правил — сумма не меньше 1 ₽;
//   * ранний приход и опоздание корта (exact, минуты как есть): сколько случаев даёт 0 ₽ — только статистика (малая
//     дробь слота; не плата за целую единицу).
//
// Запуск: node tests/security/m5-8/14-validated-rules-fuzz.mjs [число наборов, по умолчанию 400]

import { normalizeRules } from '../../../server/setup/tariffs.mjs';
import { amountFor } from '../../../server/tariffs/index.mjs';
import { runner } from './lib.mjs';

const r = runner('M5.8 / 14: принятые правила не дают 0 ₽ за платную единицу');
const RID = 'e1000000-0000-4000-8000-000000000103';
const CID = 'c1000000-0000-4000-8000-000000000001';
const N = Number(process.argv[2] ?? 400);

// Детерминированный генератор.
let seed = 0x9e3779b9;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x85ebca6b) + 0x7f4a7c15) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

function rawRule(slotType) {
  const from = int(0, 47) * 30;
  const len = pick([60, 120, 180, 360, 720, 1440]);
  const hhmm = (m) => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const base = { kind: slotType ? 'padel_court' : null, days: [1, 2, 3, 4, 5, 6, 7], from: hhmm(from), to: len >= 1440 ? hhmm(from) : hhmm(from + len) };
  if (slotType) return { ...base, slot_minutes: pick([60, 90, 120]), price_per_slot_kopecks: pick([1, 49, 50, 51, 99, 100, 150, 1000, int(1, 400), int(40, 60)]) };
  const step = pick([1, 2, 3, 5, 10, 15, 20, 30, 60]);
  return { ...base, price_per_hour_kopecks: pick([1, 49, 50, 99, 2999, 3000, 3001, int(1, 4000), int(40, 70)]), step_minutes: step, min_minutes: pick([0, 1, step, 2 * step, 30, 60, 1440]) };
}

function toDbRows(rules, type) {
  return rules.map((x, i) => ({
    id: `fz-${i}`, resource_type: type, resource_id: null, days: x.days, start_local: `${x.from}:00`, end_local: `${x.to}:00`,
    price_per_hour: x.price_per_hour_kopecks, step_minutes: x.step_minutes, min_minutes: x.min_minutes, priority: 0, active: true,
    created_at: '2026-10-01T00:00:00Z', slot_minutes: x.slot_minutes, price_per_slot: x.price_per_slot_kopecks,
  }));
}
const fakeDb = (rows, type) => ({
  async query(sql) {
    if (sql.includes('from bl.resources r join bl.clubs c')) return { rows: [{ id: RID, club_id: CID, type, number: 3, title: 'X', active: true, timezone: 'Europe/Moscow', settings: {}, club_name: 'F' }] };
    if (sql.includes('from bl.tariff_rules')) return { rows };
    if (sql.includes('from bl.holidays')) return { rows: [] };
    throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
  },
});

let accepted = 0;
let rejected = 0;
let checks = 0;
const violations = [];
let exactZero = 0;
let exactTotal = 0;
for (let i = 0; i < N; i += 1) {
  const slotType = rnd() < 0.5;
  const rules = [];
  for (let k = 0, count = int(1, 3); k < count; k += 1) rules.push(rawRule(slotType));
  // Все правила одной длины слота (иначе мастер отклонит по другой причине).
  if (slotType) for (const x of rules) x.slot_minutes = rules[0].slot_minutes;
  let norm;
  try {
    norm = normalizeRules(rules);
  } catch {
    rejected += 1;
    continue;
  }
  accepted += 1;
  const type = slotType ? 'padel_court' : 'billiard_pool';
  const db = fakeDb(toDbRows(norm, type), type);
  for (let j = 0; j < 12; j += 1) {
    const from = Date.UTC(2026, 9, 26, 0, 0) + int(0, 7 * 48) * 30 * 60_000 + int(0, 29) * 60_000;
    const first = slotType ? norm[0].slot_minutes : null;
    const step = first ?? pick(norm.map((x) => x.step_minutes));
    const candidates = slotType ? [first, 2 * first] : [step, 2 * step, 30, 60, 90, 120, 240].filter((m) => m >= 1);
    for (const minutes of candidates) {
      const call = amountFor(db, { resourceId: RID, from, minutes, minimum: true }).then((x) => x, (e) => ({ error: e.code }));
      const x = await call;
      if (x.error) continue; // no_tariff — клуб закрыт в это время
      checks += 1;
      if (x.amount_kopecks < 100) violations.push({ rules: JSON.stringify(norm), from: new Date(from).toISOString(), minutes, billed: x.minutes, amount: x.amount_kopecks });
    }
    if (slotType) {
      const e = int(1, first - 1);
      const x = await amountFor(db, { resourceId: RID, from, minutes: e, minimum: false, exact: true }).then((v) => v, (er) => ({ error: er.code }));
      if (!x.error) {
        exactTotal += 1;
        if (x.amount_kopecks === 0) exactZero += 1;
      }
    }
  }
}
console.log(`INFO  наборов: принято ${accepted}, отклонено ${rejected}; проверено сумм платной единицы: ${checks}`);
console.log(`INFO  ранний приход/опоздание корта по минутам (exact): ${exactZero} из ${exactTotal} дали 0 ₽ (малая доля слота при копеечной цене слота ≥ 50 коп.)`);
for (const v of violations.slice(0, 5)) console.log('НАРУШЕНИЕ', JSON.stringify(v));
r.check('принятые правила: платная единица (старт, продление, бронь) всегда ≥ 1 ₽', violations.length === 0, `${violations.length} нарушений из ${checks}`);
r.check('генератор достаточно часто попадает в принятые наборы (проверка не вхолостую)', accepted >= N / 10 && checks > 500, `${accepted}/${N}, ${checks}`);
r.done();
