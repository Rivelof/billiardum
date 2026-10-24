// Набор данных для сверки дашборда (M5.2 №168, T29): трое закрытых рабочих суток клуба сида и
// текущие сутки. Строки пишет суперпользователь (подготовка), проверки — под app_api.
//
//   D1: игра по QR со скан → свет и продлением, игра на кассе наличными, депозит «Без лимита»,
//       бар на кассе картой, бар наличными с пакетом часов, пакет онлайн, игра через границу суток
//       (05:30–07:00 следующего утра — относится к D1), смена S1 10:00–05:59.
//   D2: возврат за бар D1 (уменьшает D2), бронь с предоплатой и игрой, бронь с неявкой, игра пакетом
//       минут (не деньги), сервисный свет, тревоги (принята за 20 и за 2 минуты, не принята),
//       смена S2 с расхождением −500 ₽.
//   D3: заморозка «Без лимита» (подтверждена D3, списывается потом — «исправление»), смена S3.
//   Сегодня: открытая смена, наличные, ручные действия (журнал — настоящее время).
// Тестовый клуб (mode test) того же владельца: платёж и игра — is_test, никуда не входят.

import { randomUUID } from 'node:crypto';
import { addDays, workingDayOf, zonedTime } from '../../time.mjs';

export const CLUB = 'c1000000-0000-4000-8000-000000000001';
export const TEST_CLUB = 'c3000000-0000-4000-8000-000000000003';
export const OWNER = 'a1000000-0000-4000-8000-000000000001';
export const MANAGER = 'a1000000-0000-4000-8000-000000000003';
export const RECEPTION = 'a1000000-0000-4000-8000-000000000004';
export const BAR = 'a1000000-0000-4000-8000-0000000000b1';
export const G1 = 'a9000000-0000-4000-8000-0000000000a1';
export const G2 = 'a9000000-0000-4000-8000-0000000000a2';
export const G3 = 'a9000000-0000-4000-8000-0000000000a3';
export const TZ = 'Asia/Yekaterinburg';
export const T = (n) => `e1000000-0000-4000-8000-00000000000${n}`;
export const DEV = (n) => `d1000000-0000-4000-8000-00000000000${n}`;

export function daysOf(now) {
  const today = workingDayOf(now, TZ, '06:00');
  return { today, D1: addDays(today, -3), D2: addDays(today, -2), D3: addDays(today, -1) };
}

export const L = (day, hhmm) => zonedTime(day, hhmm, TZ);
const plus = (d, min) => new Date(d.getTime() + min * 60_000);

export async function seedDataset(admin, now) {
  const { today, D1, D2, D3 } = daysOf(now);
  const q = (sql, params) => admin.query(sql, params);
  const ids = {};
  // История клуба — с D1 − 5 (догоняющий пересчёт), часы работы 10:00–02:00.
  await q(`update bl.clubs set created_at = $2, settings = settings || '{"open_hours": {"open": "10:00", "close": "02:00"}}'::jsonb where id = $1`, [CLUB, L(addDays(D1, -5), '12:00')]);
  await q('update bl.resources set created_at = $2 where club_id = $1', [CLUB, L(addDays(D1, -5), '12:00')]);
  await q(`insert into bl.users (id, phone, name) values ($1, '+79990000001', 'Гость 1'), ($2, '+79990000002', 'Гость 2'), ($3, '+79990000003', 'Гость 3'), ($4, '+70000000011', 'Бармен')`, [G1, G2, G3, BAR]);
  await q(`insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar')`, [CLUB, BAR]);
  await q(`update bl.users set name = 'Ресепшн Анна' where id = $1`, [RECEPTION]);
  await q(`update bl.users set name = 'Управляющий Олег' where id = $1`, [MANAGER]);

  const pay = async (p) => {
    const id = randomUUID();
    const yk = p.provider === 'yookassa';
    await q(
      `insert into bl.payments (id, club_id, resource_id, user_id, quote_id, session_id, kind, provider, method, provider_payment_id, idempotence_key,
                                status, amount_kopecks, capture, captured_kopecks, minutes, unlimited, confirmed_at, created_at, updated_at,
                                booking_id, package_id, balance_minutes, deposit, settlement_status, accepted_by, received_kopecks, change_kopecks)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $26, $11, $12, $13, $14, $15, $16, $17, $17, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
      [
        id, p.club ?? CLUB, p.resource ?? null, p.user ?? null, p.quote ?? null, p.session ?? null, p.kind, p.provider, p.method,
        yk ? `yk-${id}` : null, p.status ?? 'succeeded', p.amount, p.capture ?? true, p.captured ?? null, p.minutes ?? null, p.unlimited ?? false,
        p.at, p.booking ?? null, p.package ?? null, p.balanceMinutes ?? 0, p.deposit ?? false, p.settlement ?? null,
        p.provider === 'reception' ? RECEPTION : null, p.method === 'cash' ? p.amount : null, p.method === 'cash' ? 0 : null, `idem-${id}`,
      ],
    );
    return id;
  };
  const session = async (s) => {
    const id = randomUUID();
    await q(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until, ended_at, close_reason,
                                created_at, updated_at, booking_id, deposit_kopecks)
       values ($1, $2, $3, 'closed', $4, $5, $6, $7, $8, $8, 'expired', $7, $8, $9, $10)`,
      [id, s.club ?? CLUB, s.resource, s.source, s.payer, s.deposit !== undefined, s.from, s.to, s.booking ?? null, s.deposit ?? null],
    );
    if (s.payer && s.participant !== false) {
      await q(`insert into bl.session_participants (session_id, club_id, user_id, role, ordinal, joined_at) values ($1, $2, $3, 'payer', 1, $4)`, [id, s.club ?? CLUB, s.payer, s.from]);
    }
    return id;
  };
  const audit = (action, objectType, objectId, data = {}, actor = null, reason = null) =>
    q(`insert into bl.audit_log (club_id, actor_type, actor_id, action, object_type, object_id, reason, data) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [CLUB, actor ? 'user' : 'system', actor, action, objectType, objectId, reason, data]);

  // ---- D1 ----
  // Игра по QR: скан (котировка) 11:59:30, оплата СБП 12:00, свет (ack) 12:00:08; продление картой.
  const quote = randomUUID();
  await q(
    `insert into bl.quotes (id, club_id, resource_id, user_id, kind, minutes, from_at, amount_kopecks, created_at, valid_until)
     values ($1, $2, $3, $4, 'start', 60, $5, 50000, $5, $6)`,
    [quote, CLUB, T(1), G1, new Date(L(D1, '12:00').getTime() - 30_000), plus(L(D1, '12:00'), 3)],
  );
  ids.qrSession = await session({ resource: T(1), source: 'qr', payer: G1, from: L(D1, '12:00'), to: L(D1, '13:30') });
  ids.qrPay = await pay({ kind: 'start', provider: 'yookassa', method: 'sbp', amount: 50000, resource: T(1), user: G1, quote, session: ids.qrSession, minutes: 60, at: L(D1, '12:00') });
  await pay({ kind: 'extend', provider: 'yookassa', method: 'card', amount: 25000, resource: T(1), user: G1, session: ids.qrSession, minutes: 30, at: L(D1, '12:55') });
  const cmd = randomUUID();
  await q(
    `insert into bl.device_commands (id, club_id, device_id, seq, type, body, status, attempts, cause, session_id, payment_id, created_at, sent_at, acked_at)
     values ($1, $2, $3, 1, 'session.start', '{}', 'acked', 1, 'payment', $4, $5, $6, $6, $7)`,
    [cmd, CLUB, DEV(1), ids.qrSession, ids.qrPay, L(D1, '12:00'), new Date(L(D1, '12:00').getTime() + 8_000)],
  );
  await audit('device.cmd', 'device', DEV(1), { cmd_id: cmd, seq: 1, type: 'session.start' });
  await audit('session.start', 'session', ids.qrSession, { session_id: ids.qrSession });
  // Игра на кассе наличными 80 000.
  const cashGame = await session({ resource: T(6), source: 'reception', payer: G2, from: L(D1, '14:00'), to: L(D1, '15:00') });
  await pay({ kind: 'start', provider: 'reception', method: 'cash', amount: 80000, resource: T(6), user: G2, session: cashGame, minutes: 60, at: L(D1, '14:00') });
  await audit('session.start', 'session', cashGame, {});
  // Бар на кассе картой 35 000.
  ids.barCard = await pay({ kind: 'bar', provider: 'reception', method: 'card_terminal', amount: 35000, at: L(D1, '15:10') });
  // Пакет онлайн 300 000 (партия 300 минут).
  const pkg = randomUUID();
  await q(`insert into bl.tariff_packages (id, club_id, title, minutes, price_kopecks, valid_days, active, created_by, created_at, updated_at) values ($1, $2, '5 часов', 300, 300000, 30, true, $3, $4, $4)`, [pkg, CLUB, OWNER, L(D1, '10:00')]);
  const pkgPay = await pay({ kind: 'package', provider: 'yookassa', method: 'sbp', amount: 300000, user: G1, package: pkg, at: L(D1, '16:00') });
  ids.lot = randomUUID();
  await q(
    `insert into bl.balance_lots (id, club_id, user_id, package_id, payment_id, minutes_total, minutes_left, price_kopecks, expires_at, source_key, created_at)
     values ($1, $2, $3, $4, $5, 300, 240, 300000, $6, $7, $8)`,
    [ids.lot, CLUB, G1, pkg, pkgPay, plus(L(D1, '16:00'), 30 * 1440), `payment:${pkgPay}`, L(D1, '16:00')],
  );
  // Депозит наличными «Без лимита» 100 000, игра 18:00–19:30, плательщик — сотрудник (не гость).
  const depGame = await session({ resource: T(2), source: 'reception', payer: RECEPTION, from: L(D1, '18:00'), to: L(D1, '19:30'), deposit: 100000 });
  await pay({ kind: 'start', provider: 'reception', method: 'cash', amount: 100000, resource: T(2), user: RECEPTION, session: depGame, unlimited: true, deposit: true, settlement: 'settled', at: L(D1, '18:00') });
  await audit('session.start', 'session', depGame, {});
  // Бар наличными 400 000, из них пакет часов 300 000.
  const barPkg = await pay({ kind: 'bar', provider: 'reception', method: 'cash', amount: 400000, at: L(D1, '20:00') });
  await q(
    `insert into bl.pos_sales (club_id, channel, method, status, payment_id, created_by, bar_subtotal_kopecks, bar_total_kopecks, package_kopecks,
                               received_kopecks, change_kopecks, created_at, completed_at, updated_at)
     values ($1, 'pos', 'cash', 'completed', $2, $3, 100000, 100000, 300000, 400000, 0, $4, $4, $4)`,
    [CLUB, barPkg, RECEPTION, L(D1, '20:00')],
  );
  // Бронь на D2 с неявкой — создана в D1 гостем 3.
  await q(
    `insert into bl.bookings (club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes,
                              created_at, updated_at, expired_at, expire_reason)
     values ($1, $2, $3, 'app', $4, $5, 'expired', 'none', 80000, 15, $6, $6, $7, 'no_show')`,
    [CLUB, T(5), G3, L(D2, '18:00'), L(D2, '19:00'), L(D1, '20:30'), L(D2, '18:15')],
  );
  // Игра через границу суток: 05:30–07:00 следующего утра — сутки D1 (по началу, №167).
  ids.crossGame = await session({ resource: T(3), source: 'qr', payer: G3, from: L(D2, '05:30'), to: L(D2, '07:00') });
  await pay({ kind: 'start', provider: 'yookassa', method: 'sbp', amount: 90000, resource: T(3), user: G3, session: ids.crossGame, minutes: 90, at: L(D2, '05:30') });
  // session.start этой игры в журнале нет — метрика «игр без журнала» = 1.
  // Смена S1: 10:00 D1 — 05:59 D2 (наличные: 80 000 + 100 000 + 400 000).
  await q(
    `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks,
                            expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
     values ($1, 1, $2, $3, 500000, $2, $4, 580000, 0, 1080000, 1080000, 0)`,
    [CLUB, RECEPTION, L(D1, '10:00'), L(D2, '05:59')],
  );

  // ---- D2 ----
  await q(
    `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks,
                            expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks, close_comment)
     values ($1, 2, $2, $3, 300000, $2, $4, 0, 0, 300000, 250000, -50000, 'не хватает')`,
    [CLUB, RECEPTION, L(D2, '06:00'), L(D2, '23:00')],
  );
  // Возврат 10 000 за бар D1 — на следующий день.
  await q(`insert into bl.refunds (club_id, payment_id, idempotence_key, amount_kopecks, status, reason, requested_by, created_at, updated_at, kind)
           values ($1, $2, 'rf-1', 10000, 'manual', 'возврат за пиво', $3, $4, $4, 'refund')`, [CLUB, ids.barCard, RECEPTION, L(D2, '12:00')]);
  // Бронь с предоплатой СБП 40 000 и игрой 19:00–20:00.
  const booking = randomUUID();
  await q(
    `insert into bl.bookings (id, club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, prepayment_kopecks,
                              prepaid_kopecks, hold_minutes, created_at, updated_at, started_at, completed_at)
     values ($1, $2, $3, $4, 'app', $5, $6, 'completed', 'full', 80000, 40000, 40000, 15, $7, $7, $5, $6)`,
    [booking, CLUB, T(7), G2, L(D2, '19:00'), L(D2, '20:00'), L(D2, '10:00')],
  );
  await pay({ kind: 'booking', provider: 'yookassa', method: 'sbp', amount: 40000, resource: T(7), user: G2, booking, settlement: 'settled', at: L(D2, '10:00') });
  const bookGame = await session({ resource: T(7), source: 'booking', payer: G2, from: L(D2, '19:00'), to: L(D2, '20:00'), booking });
  await audit('session.start', 'session', bookGame, {});
  // Игра пакетом минут (не деньги): 60 минут из партии.
  const balGame = await session({ resource: T(8), source: 'qr', payer: G1, from: L(D2, '15:00'), to: L(D2, '16:00') });
  const balPay = await pay({ kind: 'start', provider: 'balance', method: 'balance', amount: 0, resource: T(8), user: G1, session: balGame, minutes: 60, balanceMinutes: 60, at: L(D2, '15:00') });
  await q(`insert into bl.balance_debits (club_id, user_id, lot_id, payment_id, minutes, value_kopecks, created_at) values ($1, $2, $3, $4, 60, 60000, $5)`, [CLUB, G1, ids.lot, balPay, L(D2, '15:00')]);
  await audit('session.start', 'session', balGame, {});
  // Сервисный свет 13:00–13:20 на столе 4.
  await q(
    `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, reason_code, reason_text, created_at, released_at, release_reason)
     values ($1, $2, 'service', $3, $4, 'cleaning', 'чистка сукна', $5, $6, 'stopped')`,
    [CLUB, T(4), RECEPTION, plus(L(D2, '13:00'), 60), L(D2, '13:00'), L(D2, '13:20')],
  );
  // Тревоги: принята через 20 минут, через 2 минуты, не принята.
  await q(
    `insert into bl.alarms (club_id, type, level, resource_id, data, state, count, raised_at, last_raised_at, acked_at, acked_by) values
       ($1, 'service_light', 'critical', $2, '{}', 'acked', 1, $3, $3, $4, $5),
       ($1, 'device_offline', 'critical', $6, '{}', 'acked', 1, $7, $7, $8, $5),
       ($1, 'receipt_pending', 'important', null, '{}', 'open', 1, $9, $9, null, null)`,
    [CLUB, T(4), L(D2, '13:05'), L(D2, '13:25'), MANAGER, T(6), L(D2, '14:00'), L(D2, '14:02'), L(D2, '16:00')],
  );

  // ---- D3 ----
  await q(
    `insert into bl.shifts (club_id, number, opened_by, opened_at, float_kopecks, closed_by, closed_at, cash_sales_kopecks, cash_refunds_kopecks,
                            expected_cash_kopecks, actual_cash_kopecks, discrepancy_kopecks)
     values ($1, 3, $2, $3, 300000, $2, $4, 0, 0, 300000, 300000, 0)`,
    [CLUB, RECEPTION, L(D3, '09:00'), L(D3, '23:00')],
  );
  // Заморозка «Без лимита» картой 100 000: подтверждена в D3, списание — позже (исправление суток D3).
  const holdGame = await session({ resource: T(5), source: 'qr', payer: G1, from: L(D3, '12:00'), to: L(D3, '13:10') });
  await audit('session.start', 'session', holdGame, {});
  ids.holdPay = await pay({ kind: 'start', provider: 'yookassa', method: 'card', amount: 100000, capture: false, unlimited: true, status: 'waiting_for_capture', resource: T(5), user: G1, session: holdGame, at: L(D3, '12:00') });

  // ---- Сегодня ----
  const dayStart = L(today, '06:00');
  const mid = new Date(dayStart.getTime() + Math.floor((now.getTime() - dayStart.getTime()) / 2));
  ids.todayShift = randomUUID();
  await q(`insert into bl.shifts (id, club_id, number, opened_by, opened_at, float_kopecks) values ($1, $2, 4, $3, $4, 200000)`, [ids.todayShift, CLUB, RECEPTION, new Date(dayStart.getTime() + 1000)]);
  const todayGame = await session({ resource: T(6), source: 'reception', payer: G2, from: mid, to: new Date(mid.getTime() + 1000) });
  await pay({ kind: 'start', provider: 'reception', method: 'cash', amount: 15000, resource: T(6), user: G2, session: todayGame, minutes: 15, at: mid });
  await audit('session.start', 'session', todayGame, {});
  // Ручные действия персонала (журнал — настоящее время, это текущие сутки): причина с телефоном маскируется.
  await audit('service.start', 'resource', T(4), { resource_id: T(4) }, RECEPTION, 'клиент +7 999 123-45-67 пролил');
  await audit('manual.extend_free', 'session', todayGame, { session_id: todayGame }, MANAGER, 'компенсация');

  // ---- Тестовый клуб того же владельца (mode test): всё is_test ----
  await q(`insert into bl.clubs (id, name, city, timezone, mode, created_at) values ($1, 'Тестовый', 'Екатеринбург', $2, 'test', $3)`, [TEST_CLUB, TZ, L(addDays(D1, -5), '12:00')]);
  await q(`insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'owner')`, [TEST_CLUB, OWNER]);
  await q(`insert into bl.resources (id, club_id, type, number, title) values ('e3000000-0000-4000-8000-000000000001', $1, 'billiard_pool', 1, 'Стол 1')`, [TEST_CLUB]);
  const tGame = await session({ club: TEST_CLUB, resource: 'e3000000-0000-4000-8000-000000000001', source: 'reception', payer: G1, from: L(D1, '12:00'), to: L(D1, '13:00') });
  await pay({ club: TEST_CLUB, kind: 'start', provider: 'reception', method: 'cash', amount: 777700, resource: 'e3000000-0000-4000-8000-000000000001', user: G1, session: tGame, minutes: 60, at: L(D1, '12:00') });
  return { ...ids, today, D1, D2, D3 };
}
