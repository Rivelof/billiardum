import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  balanceCover,
  boardSlots,
  bookingPrice,
  busyAt,
  cancelText,
  availableChannels,
  channelsOrder,
  durationsFor,
  extendLimitText,
  freeRun,
  freeTables,
  hhmm,
  holdMinutes,
  localDate,
  moveChannel,
  primaryChannel,
  normalizePhone,
  prepayFor,
  slotDurations,
  sortBookings,
  waitlistView,
  zonedMs,
} from '../booking.mjs';
import { formatMoney, formatTime } from '../format.mjs';

const TZ = 'Asia/Yekaterinburg'; // UTC+5
const MIN = 60_000;
const at = (h, m = 0) => zonedMs('2026-10-22', h * 60 + m, TZ);

const DAY = {
  club: { id: 'c', name: 'Клуб', timezone: TZ },
  date: '2026-10-22',
  open_at: new Date(at(12)).toISOString(),
  close_at: new Date(at(26)).toISOString(), // 02:00 следующего дня
  step_minutes: 30,
  min_minutes: 60,
  max_minutes: 240,
  lead_minutes: 30,
  resources: [
    { id: 'r1', number: 1, busy: [{ from: new Date(at(18)).toISOString(), to: new Date(at(20)).toISOString(), kind: 'booking' }] },
    { id: 'r2', number: 2, busy: [{ from: new Date(at(17)).toISOString(), to: new Date(at(21)).toISOString(), kind: 'booking' }] },
  ],
};

test('время по поясу клуба: 21:00 Екатеринбурга — 16:00 UTC, ночь после полуночи — тот же рабочий день', () => {
  assert.equal(new Date(at(21)).toISOString(), '2026-10-22T16:00:00.000Z');
  assert.equal(new Date(at(25, 30)).toISOString(), '2026-10-22T20:30:00.000Z');
  assert.equal(hhmm(at(25, 30), TZ), '01:30');
  assert.equal(localDate(at(25, 30), TZ), '2026-10-23');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  // Пояс с переходом на летнее время: день перехода считается верно
  assert.equal(new Date(zonedMs('2026-03-29', 12 * 60, 'Europe/Berlin')).toISOString(), '2026-03-29T10:00:00.000Z');
});

test('борт-шкала: деления по 30 минут, прошедшее недоступно, занятые закрашены', () => {
  const slots = boardSlots(DAY, { now: at(15, 10) });
  assert.equal(slots[0].label, '12:00');
  assert.equal(slots.at(-1).label, '01:00', 'последнее начало — за час до закрытия');
  assert.equal(slots.find((s) => s.label === '15:30').state, 'past', 'ближе 30 минут к «сейчас»');
  assert.equal(slots.find((s) => s.label === '16:00').state, 'free');
  assert.equal(slots.find((s) => s.label === '16:00').free, 2, 'час с 16:00 до 17:00 — оба свободны, граница не пересечение');
  assert.equal(slots.find((s) => s.label === '16:30').free, 1, 'стол 2 с 17:00 занят — с 16:30 на час только стол 1');
  assert.equal(slots.find((s) => s.label === '18:00').state, 'busy', 'оба стола заняты');
  assert.ok(slots.find((s) => s.label === '21:00').hour);
  const one = boardSlots(DAY, { resourceId: 'r2', now: at(12) });
  assert.equal(one.find((s) => s.label === '16:30').state, 'busy', 'час с 16:30 упирается в бронь в 17:00');
  assert.equal(one.find((s) => s.label === '21:00').state, 'free');
});

test('длительность брони — не дольше свободного окна и правил клуба', () => {
  assert.equal(freeRun(DAY, 'r1', at(16)), 120);
  assert.deepEqual(durationsFor(DAY, 'r1', at(16)), [60, 90, 120]);
  assert.deepEqual(durationsFor(DAY, 'r1', at(20)), [60, 90, 120, 180, 240]);
  assert.deepEqual(durationsFor(DAY, 'r1', at(23, 30)), [60, 90, 120], 'до закрытия в 02:00');
  assert.deepEqual(durationsFor(DAY, 'r1', at(19)), [], 'внутри чужой брони');
  assert.deepEqual([...freeTables(DAY, at(16, 30), 60)], ['r1']);
  assert.ok(busyAt(DAY.resources[0], at(19, 30), at(21)));
  assert.equal(busyAt(DAY.resources[0], at(20), at(21)), null, 'граница не пересечение');
});

test('цена брони поминутно по тарифу, округление до рублей один раз', () => {
  const rates = [
    { from: new Date(at(12)).toISOString(), to: new Date(at(17)).toISOString(), per_hour_kopecks: 50000 },
    { from: new Date(at(17)).toISOString(), to: new Date(at(26)).toISOString(), per_hour_kopecks: 80000 },
  ];
  const p = bookingPrice(rates, at(16, 30), 90);
  assert.equal(p.amount_kopecks, 25000 + 80000);
  assert.equal(p.breakdown.length, 2);
  assert.equal(bookingPrice(rates, at(16, 50), 20).amount_kopecks, Math.floor((50000 / 6 + 80000 / 6) / 100 + 0.5) * 100);
  assert.equal(bookingPrice(rates, at(25, 30), 60), null, 'нет тарифа после закрытия');
  assert.equal(prepayFor({ prepayment: 'full' }, 105000), 105000);
  assert.equal(prepayFor({ prepayment: 'deposit', deposit_kopecks: 50000 }, 30000), 30000);
  assert.equal(prepayFor({ prepayment: 'none' }, 105000), 0);
  assert.equal(holdMinutes(0), 15);
  assert.equal(holdMinutes(50000), 30);
});

test('M5.8: цена брони корта по слотам — минута стоит цену слота / длину слота, граница внутри слота по минутам', () => {
  const rates = [
    { from: new Date(at(12)).toISOString(), to: new Date(at(17)).toISOString(), per_hour_kopecks: 160000, per_slot_kopecks: 240000, slot_minutes: 90 },
    { from: new Date(at(17)).toISOString(), to: new Date(at(26)).toISOString(), per_hour_kopecks: 240000, per_slot_kopecks: 360000, slot_minutes: 90 },
  ];
  assert.equal(bookingPrice(rates, at(13), 90).amount_kopecks, 240000, 'один дневной слот');
  assert.equal(bookingPrice(rates, at(18), 270).amount_kopecks, 3 * 360000, 'три вечерних слота — ровно, без ошибки плавающей точки');
  // 16:30–18:00: 30 минут дневной цены (800 ₽) и 60 минут вечерней (2 400 ₽) — как server/payments README
  const p = bookingPrice(rates, at(16, 30), 90);
  assert.equal(p.amount_kopecks, 80000 + 240000);
  assert.deepEqual(p.breakdown.map((b) => [b.per_slot_kopecks, b.slot_minutes, b.amount_kopecks]), [[240000, 90, 80000], [360000, 90, 240000]]);
  assert.equal(p.breakdown.reduce((s, b) => s + b.amount_kopecks, 0), p.amount_kopecks, 'отрезки в сумме — итог');
  // Округление до рублей «половина вверх» один раз: 1 001 ₽ за 90 минут, 60 минут — 667,33 ₽ → 667 ₽
  const odd = [{ from: new Date(at(12)).toISOString(), to: new Date(at(26)).toISOString(), per_hour_kopecks: 66733, per_slot_kopecks: 100100, slot_minutes: 90 }];
  assert.equal(bookingPrice(odd, at(13), 60).amount_kopecks, 66700);
  assert.equal(bookingPrice(odd, at(13), 45).amount_kopecks, 50100, '500,50 ₽ — половина вверх');
  assert.equal(bookingPrice(rates, at(25, 30), 90), null, 'нет тарифа после закрытия');
  // Почасовой стол — прежний расчёт (без полей слота)
  const hourly = [{ from: new Date(at(12)).toISOString(), to: new Date(at(26)).toISOString(), per_hour_kopecks: 50000 }];
  assert.deepEqual(Object.keys(bookingPrice(hourly, at(13), 60).breakdown[0]).sort(), ['amount_kopecks', 'from', 'per_hour_kopecks', 'to']);
});

test('M5.8: длительности брони корта — 1…N слотов, не дольше окна и max_minutes (округлён вниз до слота)', () => {
  const court = { id: 'r1', slot_minutes: 90 };
  assert.deepEqual(slotDurations(DAY, court, at(20)), [90, 180], 'max_minutes 240 → 180');
  assert.deepEqual(slotDurations(DAY, court, at(16)), [90], 'до брони в 18:00 — 120 минут, помещается один слот');
  assert.deepEqual(slotDurations(DAY, court, at(17)), [], 'час до брони — слот не помещается');
  assert.deepEqual(slotDurations({ ...DAY, max_minutes: 60 }, court, at(20)), [90], 'max_minutes меньше слота — один слот');
  assert.deepEqual(slotDurations(DAY, { id: 'r1', slot_minutes: null }, at(20)), [], 'у корта нет тарифа слотов');
  assert.deepEqual(slotDurations(DAY, { id: 'r1', slot_minutes: 60 }, at(20)), [60, 120, 180, 240]);
  // Борт-шкала корта: короче слота нельзя
  const slots = boardSlots(DAY, { resourceId: 'r1', now: at(12), minMinutes: 90 });
  assert.equal(slots.find((s) => s.label === '17:00').state, 'busy', '17:00 + 90 минут упирается в бронь в 18:00');
  assert.equal(slots.find((s) => s.label === '16:30').state, 'free', '16:30–18:00 — граница не пересечение');
  assert.equal(slots.at(-1).label, '00:30', 'последнее начало — за слот до закрытия');
});

test('мои брони: ближайшие сверху, прошедшие ниже; условия отмены словами', () => {
  const list = sortBookings([
    { id: 'old', status: 'expired', starts_at: new Date(at(10)).toISOString() },
    { id: 'late', status: 'confirmed', starts_at: new Date(at(22)).toISOString() },
    { id: 'soon', status: 'pending_payment', starts_at: new Date(at(19)).toISOString() },
    { id: 'done', status: 'started', starts_at: new Date(at(14)).toISOString() },
  ]);
  assert.deepEqual(list.map((b) => b.id), ['soon', 'late', 'done', 'old']);
  const fmt = { formatMoney, formatTime: (x) => formatTime(x, TZ) };
  assert.match(cancelText({ paid_kopecks: 0, cancel: { allowed: true } }, fmt).text, /бесплатная/);
  assert.match(cancelText({ paid_kopecks: 80000, cancel: { allowed: true, refund_kopecks: 80000, free_until: new Date(at(19)).toISOString() } }, fmt).text, /До 19:00 предоплата вернётся полностью — 800\s₽/);
  assert.match(cancelText({ paid_kopecks: 80000, cancel: { allowed: true, refund_kopecks: 40000 } }, fmt).text, /Вернём 400\s₽ из 800\s₽/);
  assert.match(cancelText({ paid_kopecks: 80000, cancel: { allowed: true, refund_kopecks: 0 } }, fmt).text, /не возвращается/);
  assert.equal(cancelText({ cancel: { allowed: false } }, fmt).allowed, false);
});

test('продление перед бронью: «Стол забронирован на 21:00, можно продлить до 20:55» (№106)', () => {
  const f = (x) => formatTime(x, TZ);
  const s = { paid_until: new Date(at(20)).toISOString(), extend_limit_until: new Date(at(20, 55)).toISOString(), next_booking_at: new Date(at(21)).toISOString() };
  assert.equal(extendLimitText(s, f), 'Стол забронирован на 21:00, можно продлить до 20:55.');
  assert.equal(extendLimitText({ ...s, next_booking_at: null }, f), 'Стол занят с 21:00, можно продлить до 20:55.', 'без next_booking_at — лимит плюс 5 минут, бронь или турнир — неизвестно');
  // №146: предел из окна турнира
  assert.equal(extendLimitText({ ...s, next_booking_at: null }, f, { by: 'tournament' }), 'На столе турнир с 21:00, можно продлить до 20:55.');
  assert.equal(extendLimitText({ ...s, next_booking_at: null, extend_limit_by: 'tournament', paid_until: new Date(at(20, 55)).toISOString() }, f), 'На столе турнир с 21:00, продлить игру нельзя.');
  assert.equal(extendLimitText({ ...s, paid_until: new Date(at(20, 55)).toISOString() }, f), 'Стол забронирован на 21:00, продлить игру нельзя.');
  assert.equal(extendLimitText({ ...s, unlimited: true }, f), null, 'у «Без лимита» extend_limit_until — предел заморозки');
  assert.equal(extendLimitText({ paid_until: s.paid_until }, f), null);
});

test('лист ожидания: место в очереди и предложение на 5 минут (№109)', () => {
  const now = at(20);
  assert.equal(waitlistView({ status: 'waiting', position: 1 }, now).text, 'Вы первый в очереди');
  assert.equal(waitlistView({ status: 'waiting', position: 3 }, now).text, 'Вы 3-й в очереди');
  const offer = waitlistView({ status: 'offered', offer_until: new Date(now + 4 * MIN).toISOString() }, now);
  assert.equal(offer.state, 'offered');
  assert.equal(offer.left, 4 * MIN);
  assert.equal(waitlistView({ status: 'offered', offer_until: new Date(now - 1).toISOString() }, now).state, 'missed');
  assert.equal(waitlistView(null).state, 'none');
  // close_reason сервера — точный текст гостю
  assert.equal(waitlistView({ status: 'expired', close_reason: 'released' }, now).note, 'Стол отдали гостю у стойки, вы можете снова встать в очередь');
  assert.equal(waitlistView({ status: 'expired', close_reason: 'expired' }, now).note, 'Вы не ответили за 5 минут');
  assert.equal(waitlistView({ status: 'waiting', position: 1, close_reason: 'table_taken' }, now).note, 'Стол успели занять, вы остаётесь в очереди на своём месте');
  assert.equal(waitlistView({ status: 'waiting', position: 1, close_reason: null }, now).note, null);
});

test('баланс пакета часов в котировке (use_balance): полностью или с доплатой', () => {
  assert.deepEqual(balanceCover({ amount_kopecks: 0, balance_minutes: 60, balance_available_minutes: 300 }), { usable: true, full: true, minutes: 60, rest: 0, available: 300 });
  assert.deepEqual(balanceCover({ amount_kopecks: 106700, balance_minutes: 40, balance_available_minutes: 40 }), { usable: true, full: false, minutes: 40, rest: 106700, available: 40 });
  assert.equal(balanceCover({ amount_kopecks: 80000 }).usable, false);
  assert.equal(balanceCover({ amount_kopecks: 80000, balance_minutes: 0, balance_available_minutes: 0 }).usable, false);
  assert.equal(holdMinutes(50000, { hold_prepaid_minutes: 45 }), 45);
});

test('телефон для брони по телефону и порядок каналов уведомлений', () => {
  assert.equal(normalizePhone('8 (912) 345-67-89'), '+79123456789');
  assert.equal(normalizePhone('+7 912 345 67 89'), '+79123456789');
  assert.equal(normalizePhone('9123456789'), '+79123456789');
  assert.equal(normalizePhone('12345'), null);
  assert.deepEqual(channelsOrder(['max', 'telegram', 'webpush'], 'webpush'), ['webpush', 'max', 'telegram']);
  assert.deepEqual(channelsOrder(null, 'telegram'), ['telegram', 'max', 'webpush']);
  assert.deepEqual(channelsOrder(['telegram'], 'max'), ['max', 'telegram', 'webpush'], 'недостающие каналы — в конец');
  // №126: только каналы, настроенные на сервере; основной по умолчанию — первый из них
  assert.deepEqual(channelsOrder(['max', 'telegram', 'webpush'], 'telegram', ['telegram', 'webpush']), ['telegram', 'webpush']);
  assert.deepEqual(availableChannels({ channels_available: ['webpush', 'sms'] }), ['webpush']);
  assert.deepEqual(availableChannels({}), ['max', 'telegram', 'webpush'], 'без поля — все');
  assert.equal(primaryChannel({ notify_channel: 'max', channels_available: ['telegram', 'webpush'] }), 'telegram', 'max не настроен — первый доступный');
  assert.equal(primaryChannel({ notify_channel: 'webpush', channels_available: ['telegram', 'webpush'] }), 'webpush');
  assert.equal(primaryChannel({ channels_available: [] }), null);
  assert.equal(primaryChannel({ channels_available: ['telegram', 'webpush'], channels: { webpush: true } }), 'webpush', 'подключённый — раньше неподключённого');
  assert.deepEqual(moveChannel(['max', 'telegram', 'webpush'], 'webpush', -1), ['max', 'webpush', 'telegram']);
  assert.deepEqual(moveChannel(['max', 'telegram', 'webpush'], 'max', -1), ['max', 'telegram', 'webpush']);
});
