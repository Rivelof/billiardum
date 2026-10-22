// Гонка броней (decisions №105): 6 параллельных броней одного интервала одного стола — успешна
// ровно одна, остальные 409 booking_conflict; то же для пересекающихся интервалов со сдвигом и
// для броней по телефону от ресепшена. В базе у стола нет пересекающихся живых броней.
// Стол E2E_RACE_TABLE (по умолчанию 2), интервалы — через сутки и больше (ближнюю игру не трогают).

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  cancelBooking,
  createBooking,
  FAST_BOOKING,
  newGuest,
  patchClubSettings,
  phoneBooking,
  RES,
  slotAfter,
  staff,
} from './helpers.mjs';

const T = Number(process.env.E2E_RACE_TABLE || 2);
const N = 6;
let db;
let man;
let rec;
const created = [];

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  rec = await staff('reception');
  await patchClubSettings(db, { ...FAST_BOOKING, booking_prepayment: 'full' });
});

after(async () => {
  for (const id of created) await cancelBooking(man.token, id, { reason: 'e2e: уборка после гонки', staff: true }).catch(() => null);
  await db?.end();
});

function tally(results) {
  const by = {};
  for (const r of results) {
    const k = `${r.status}${r.json?.error ? ` ${r.json.error}` : ''}`;
    by[k] = (by[k] ?? 0) + 1;
  }
  return by;
}

async function overlapsInDb(from, to) {
  const { rows } = await db.query(
    `select a.id as a, b.id as b from bl.bookings a join bl.bookings b on a.resource_id = b.resource_id and a.id < b.id
      where a.resource_id = $1 and a.status in ('pending_payment','confirmed','reserved','started') and b.status in ('pending_payment','confirmed','reserved','started')
        and a.period && b.period and a.starts_at < $3 and a.ends_at > $2`,
    [RES(T), from, to],
  );
  return rows;
}

test(`${N} параллельных броней одного интервала гостями — одна успешна (стол ${T})`, async (t) => {
  const guests = await Promise.all(Array.from({ length: N }, () => newGuest()));
  const startsAt = slotAfter(30 * 3600_000, 30);
  const res = await Promise.all(guests.map((g) => createBooking(g.token, { table: T, startsAt, minutes: 60 })));
  for (const r of res) if (r.status === 201) created.push(r.json.id);
  t.diagnostic(`одинаковый интервал: ${JSON.stringify(tally(res))}`);
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error === 'booking_conflict'));
  assert.deepEqual(await overlapsInDb(startsAt, new Date(startsAt.getTime() + 3600_000)), []);
});

test(`${N} параллельных пересекающихся броней со сдвигом 5 минут — одна успешна`, async (t) => {
  const guests = await Promise.all(Array.from({ length: N }, () => newGuest()));
  const base = slotAfter(32 * 3600_000, 30);
  const res = await Promise.all(guests.map((g, i) => createBooking(g.token, { table: T, startsAt: new Date(base.getTime() + i * 5 * 60_000), minutes: 60 })));
  for (const r of res) if (r.status === 201) created.push(r.json.id);
  t.diagnostic(`сдвиг 0…25 мин: ${JSON.stringify(tally(res))}`);
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error === 'booking_conflict'));
  assert.deepEqual(await overlapsInDb(base, new Date(base.getTime() + 2 * 3600_000)), []);
});

test(`${N} параллельных броней по телефону (ресепшн) одного интервала — одна успешна`, async (t) => {
  const startsAt = slotAfter(34 * 3600_000, 30);
  const res = await Promise.all(
    Array.from({ length: N }, (_, i) => phoneBooking(rec.token, { table: T, startsAt, minutes: 60, name: `Гонка ${i + 1} (тест e2e)`, phone: `+79990000${String(100 + i)}` })),
  );
  for (const r of res) if (r.status === 201) created.push(r.json.id);
  t.diagnostic(`по телефону: ${JSON.stringify(tally(res))}`);
  assert.equal(res.filter((r) => r.status === 201).length, 1);
  assert.ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json.error === 'booking_conflict'));
});
