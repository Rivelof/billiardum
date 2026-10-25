// Смены и отчёт смены на настоящем Postgres: открыть с разменом (одна открытая на клуб), закрыть
// с фактом наличных, T16 (недостача 500 ₽ → расхождение, тревога владельцу), ожидаемые наличные
// по всем наличным платежам клуба, смена ККТ через мост, отчёт владельцу при закрытии,
// сервисный свет по сотрудникам и столам (№71), права.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appendAudit } from '../../../lib/audit.mjs';
import { currentShift } from '../../../shifts/api.mjs';
import { CLUB_A, CLUB_B, GUEST, RECEPTION_A, setupKkt, TABLE_1, TABLE_2, waitFor } from './harness.mjs';
import { deactivateSeedCourts } from '../../../../supabase/tests/helpers.mjs';

let t;
let reception;

before(async () => {
  t = await setupKkt();
  // Отчёт смены M2 — на 8 столах сида; разрез по видам с кортами — dashboard/test/db/padel.test.mjs.
  await deactivateSeedCourts(t.admin);
  reception = await t.login('reception');
  const reg = await t.registerBridge();
  t.startBridge(reg.token);
});
after(async () => {
  await t?.stop();
});

/** Сдвинуть начало открытой смены назад (служебная правка в обход защиты — только тест). */
async function backdateShift(id, ms) {
  const c = await t.admin.connect();
  try {
    await c.query('begin');
    await c.query('set local session_replication_role = replica');
    await c.query('update bl.shifts set opened_at = opened_at - make_interval(secs => $2::float8 / 1000) where id = $1', [id, ms]);
    await c.query('commit');
  } finally {
    c.release();
  }
}

async function kktOps(kind) {
  const { rows } = await t.admin.query('select * from bl.kkt_ops where club_id = $1 and kind = $2 order by created_at', [CLUB_A, kind]);
  return rows;
}

describe('смена: открытие и закрытие, T16', () => {
  let shift;
  let cashTable;

  it('ресепшн открывает смену с разменом; вторая открытая — 409 shift_open; currentShift видит смену', async () => {
    const res = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: reception, body: { float_kopecks: 500000 } });
    assert.equal(res.status, 201);
    shift = res.json;
    assert.equal(shift.status, 'open');
    assert.equal(shift.number, 1);
    assert.equal(shift.float_kopecks, 500000);
    assert.equal(shift.opened_by_name, 'Ресепшн (тест)');
    const again = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: await t.login('manager'), body: { float_kopecks: 0 } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'shift_open');
    const cur = await t.request('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: reception });
    assert.equal(cur.json.shift.id, shift.id);
    // Закрытие вслепую (№94): ресепшн ожидаемых наличных не видит, управляющий — видит.
    assert.equal('expected_cash_kopecks' in cur.json.shift, false);
    assert.equal('cash_sales_kopecks' in cur.json.shift, false);
    const curManager = await t.request('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: await t.login('manager') });
    assert.equal(curManager.json.shift.expected_cash_kopecks, 500000);
    assert.equal(curManager.json.shift.cash_sales_kopecks, 0);
    const viaApi = await t.asClub(CLUB_A, (db) => currentShift(db, CLUB_A));
    assert.equal(viaApi.id, shift.id);
    assert.equal(await t.asClub(CLUB_B, (db) => currentShift(db, CLUB_B)), null);
    // Неверный размен, чужой клуб.
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_B}/shifts`, { token: reception, body: { float_kopecks: 0 } })).status, 403);
    assert.equal((await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: reception, body: { float_kopecks: -1 } })).status, 400);
  });

  it('смена ККТ открывается через мост (open_shift)', async () => {
    await waitFor(async () => (await kktOps('open_shift'))[0]?.status === 'done', { timeoutMs: 10_000 });
    assert.equal(t.emu.control.state().shift.state, 'opened');
  });

  it('T16: недостача 500 ₽ — расхождение −50 000 коп., тревога владельцу сразу, отчёт смены владельцу', async () => {
    await backdateShift(shift.id, 3 * 3600_000);
    const now = Date.now();
    // Наличные клуба за смену: заявка стола M1, бар (касса M2); терминал и онлайн в кассу не входят.
    cashTable = await t.receptionPayment({ method: 'cash', amount: 160000 });
    await t.receptionPayment({ method: 'card_terminal', amount: 80000, resourceId: TABLE_2, number: 2 });
    const bar = await t.barSale({ method: 'cash', lines: [{ name: 'Чай', price_kopecks: 15000, quantity: 2 }] });
    await t.cashRefund({ paymentId: cashTable.paymentId, amount: 20000 });
    // Наличные до смены не считаются.
    await t.receptionPayment({ method: 'cash', amount: 99900, at: new Date(now - 5 * 3600_000) });
    await t.waitPrinted([cashTable.receiptId, bar.receiptId]);
    // Сервисный свет 70 минут (порог 60) и игра 60 минут — внутри смены.
    await t.asClub(CLUB_A, async (db) => {
      await db.query(
        `insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, reason_code, reason_text, created_at, released_at)
         values ($1, $2, 'service', $3, $5, 'cleaning', 'Уборка', $4, $5)`,
        [CLUB_A, TABLE_1, RECEPTION_A, new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000 + 70 * 60_000)],
      );
      await db.query(
        `insert into bl.sessions (club_id, resource_id, status, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
         values ($1, $2, 'closed', $3, $4, $5, $5, 'expired', $4, $5)`,
        [CLUB_A, TABLE_2, GUEST, new Date(now - 90 * 60_000), new Date(now - 30 * 60_000)],
      );
      await appendAudit(db, { action: 'service.start', objectType: 'resource', objectId: TABLE_1, reason: 'Уборка', actorType: 'user', actorId: RECEPTION_A, data: { minutes: 70, reason_code: 'cleaning', resource_id: TABLE_1 } });
      // №125 (дефект tester Д4): ручные — только manual.*; действия системы — «автоматические».
      await appendAudit(db, { action: 'manual.extend_free', objectType: 'resource', objectId: TABLE_1, reason: 'Гость ждал', actorType: 'user', actorId: RECEPTION_A, data: { minutes: 10 } });
      await appendAudit(db, { action: 'payment.forfeited', objectType: 'payment', objectId: 'f0000000-0000-4000-8000-0000000000c1', reason: 'Бронь сгорела', actorType: 'system', data: { amount_kopecks: 50000 } });
      await appendAudit(db, { action: 'payment.refunded', objectType: 'payment', objectId: 'f0000000-0000-4000-8000-0000000000c2', reason: 'Платёж прошёл после отмены', actorType: 'system', data: { amount_kopecks: 30000 } });
      await appendAudit(db, { action: 'payment.canceled', objectType: 'payment', objectId: GUEST, reason: 'not_found_at_provider', actorType: 'system', data: {} });
      await appendAudit(db, { action: 'payment.canceled', objectType: 'payment', objectId: GUEST, actorType: 'system', data: {} });
      await appendAudit(db, { action: 'session.start', objectType: 'session', objectId: GUEST, actorType: 'system', data: {} });
      // Гость сам поздно отменил бронь: возврат с причиной от гостя — не ручное действие.
      await appendAudit(db, { action: 'payment.refunded', objectType: 'payment', objectId: GUEST, reason: 'Бронь отменена гостем поздно', actorType: 'user', actorId: GUEST, data: { payment_id: GUEST, refund_id: 'f0000000-0000-4000-8000-0000000000f1', amount_kopecks: 20000 } });
      // Возврат пакета: manual.package_refund + возврат денег (money) + возврат кассы — одна строка.
      const lot = 'f0000000-0000-4000-8000-0000000000a1';
      const pay = 'f0000000-0000-4000-8000-0000000000a2';
      const ref = 'f0000000-0000-4000-8000-0000000000a3';
      await appendAudit(db, { action: 'manual.package_refund', objectType: 'payment', objectId: pay, reason: 'Ошибка продажи', actorType: 'user', actorId: RECEPTION_A, data: { lot_id: lot, payment_id: pay, amount_kopecks: 60000 } });
      await appendAudit(db, { action: 'payment.refunded', objectType: 'payment', objectId: pay, reason: 'Ошибка продажи', actorType: 'user', actorId: RECEPTION_A, data: { payment_id: pay, refund_id: ref, amount_kopecks: 60000 } });
      await appendAudit(db, { action: 'pos.refund', objectType: 'pos_sale', objectId: GUEST, reason: 'Ошибка продажи', actorType: 'user', actorId: RECEPTION_A, data: { refund_id: ref, pos_refund_id: 'f0000000-0000-4000-8000-0000000000a4', amount_kopecks: 60000, packages: [{ lot_id: lot }] } });
      // Возврат бара сотрудником: запись money и запись кассы по одному возврату — одна строка.
      const ref2 = 'f0000000-0000-4000-8000-0000000000b3';
      await appendAudit(db, { action: 'payment.refunded', objectType: 'payment', objectId: 'f0000000-0000-4000-8000-0000000000b2', reason: 'Не тот чай', actorType: 'user', actorId: RECEPTION_A, data: { payment_id: 'f0000000-0000-4000-8000-0000000000b2', refund_id: ref2, amount_kopecks: 15000 } });
      await appendAudit(db, { action: 'pos.refund', objectType: 'pos_sale', objectId: GUEST, reason: 'Не тот чай', actorType: 'user', actorId: RECEPTION_A, data: { refund_id: ref2, amount_kopecks: 15000 } });
    });
    const expected = 500000 + 160000 + 30000 - 20000;
    const live = await t.request('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: await t.login('owner') });
    assert.equal(live.json.shift.expected_cash_kopecks, expected);
    assert.equal(live.json.shift.cash_sales_kopecks, 190000);
    assert.equal('expected_cash_kopecks' in (await t.request('GET', `/api/clubs/${CLUB_A}/shifts/current`, { token: reception })).json.shift, false);
    const res = await t.request('POST', `/api/shifts/${shift.id}/close`, { token: reception, body: { actual_cash_kopecks: expected - 50000, comment: 'Пересчитали дважды' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'closed');
    assert.equal(res.json.expected_cash_kopecks, expected);
    assert.equal(res.json.actual_cash_kopecks, expected - 50000);
    assert.equal(res.json.discrepancy_kopecks, -50000);
    assert.equal(res.json.cash_sales_kopecks, 190000);
    assert.equal(res.json.cash_refunds_kopecks, 20000);

    const alarm = await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'cash_discrepancy'", [CLUB_A]);
    assert.equal(alarm.rowCount, 1);
    assert.equal(alarm.rows[0].level, 'critical');
    assert.equal(alarm.rows[0].data.discrepancy_kopecks, -50000);
    const owners = await t.admin.query(
      `select n.text from bl.notifications n join bl.club_members m on m.user_id = n.user_id and m.club_id = n.club_id
        where n.club_id = $1 and m.role = 'owner' and n.text like 'Смена №1: расхождение кассы%'`,
      [CLUB_A],
    );
    assert.equal(owners.rowCount, 1);
    assert.match(owners.rows[0].text, /расхождение кассы \u2212500\s₽ \(недостача\)/, 'минус U+2212, не дефис');

    const light = await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'service_light_threshold'", [CLUB_A]);
    assert.equal(light.rowCount, 1);
    assert.equal(light.rows[0].data.minutes, 70);

    const audit = await t.admin.query("select data, reason from bl.audit_log where club_id = $1 and action = 'shift.close'", [CLUB_A]);
    assert.equal(audit.rows[0].data.discrepancy_kopecks, -50000);
    assert.equal(audit.rows[0].reason, 'Пересчитали дважды');

    // Отчёт уходит владельцу через outbox (notify core).
    await waitFor(async () => (await t.admin.query('select report_sent_at from bl.shifts where id = $1', [shift.id])).rows[0].report_sent_at, { timeoutMs: 10_000 });
    const rep = await t.admin.query("select text, level from bl.notifications where club_id = $1 and kind = 'shift.report'", [CLUB_A]);
    assert.equal(rep.rowCount, 1, 'один владелец — одно уведомление');
    assert.equal(rep.rows[0].level, 'info');
    assert.match(rep.rows[0].text, /^Смена №1 закрыта/);
    assert.match(rep.rows[0].text, /расхождение/);
    assert.ok(!/\+7\d{10}|79990000099/.test(rep.rows[0].text), 'без телефонов');
  });

  it('смена ККТ закрывается через мост (close_shift)', async () => {
    await waitFor(async () => (await kktOps('close_shift'))[0]?.status === 'done', { timeoutMs: 10_000 });
    assert.equal(t.emu.control.state().shift.state, 'closed');
  });

  it('отчёт смены: выручка столов и бара по способам, игра, сервисный свет по сотрудникам и столам, ручные действия', async () => {
    const res = await t.request('GET', `/api/shifts/${shift.id}/report?online=0`, { token: await t.login('manager') });
    assert.equal(res.status, 200);
    const r = res.json;
    assert.equal(r.revenue.tables.by_method.cash, 160000);
    assert.equal(r.revenue.tables.by_method.card_terminal, 80000);
    assert.equal(r.revenue.bar.by_method.cash, 30000);
    assert.equal(r.revenue.total_kopecks, 270000);
    assert.equal(r.revenue.refunds.total_kopecks, 20000);
    assert.equal(r.revenue.net_kopecks, 250000);
    assert.equal(r.play.sessions, 1);
    assert.equal(r.play.minutes, 60);
    assert.ok(r.play.utilization_percent > 0);
    const byTable = Object.fromEntries(r.play.by_resource.map((x) => [x.number, x]));
    assert.equal(r.play.by_resource.length, 8, 'все столы клуба');
    assert.deepEqual([byTable[2].minutes, byTable[2].hours, byTable[2].sessions, byTable[2].revenue_kopecks], [60, 1, 1, 80000]);
    assert.deepEqual([byTable[1].minutes, byTable[1].revenue_kopecks, byTable[1].refunds_kopecks], [0, 160000, 20000]);
    assert.equal(byTable[3].revenue_kopecks, 0);
    assert.equal(r.service_light.total_minutes, 70);
    assert.equal(r.service_light.exceeded, true);
    assert.deepEqual(r.service_light.by_staff.map((s) => [s.user_id, s.name, s.minutes]), [[RECEPTION_A, 'Ресепшн (тест)', 70]]);
    assert.deepEqual(r.service_light.by_resource.map((x) => [x.number, x.minutes]), [[1, 70]]);
    // Ручные — manual.* и действия персонала (staff, №125 с уточнением); система — automatic.
    assert.equal(r.manual_actions.by_action['manual.extend_free'], 1);
    assert.ok(r.manual_actions.by_action['service.start'] >= 1);
    assert.equal(r.manual_actions.count, r.manual_actions.items.length);
    assert.equal(r.manual_actions.count, r.manual_actions.staff.count + r.manual_actions.items.filter((x) => x.kind === 'manual').length);
    assert.equal(r.manual_actions.items.find((x) => x.action === 'manual.extend_free').kind, 'manual');
    assert.equal(r.manual_actions.items.find((x) => x.action === 'service.start').kind, 'staff');
    for (const k of ['payment.forfeited', 'payment.canceled', 'session.start']) assert.equal(r.manual_actions.by_action[k], undefined, k);
    assert.ok(r.manual_actions.items.every((x) => x.kind === 'manual' || x.kind === 'staff'));
    assert.ok(r.manual_actions.automatic.items.every((x) => x.kind === 'automatic'));
    // Действия гостя — не ручные: отдельная строка guests.
    assert.ok(!r.manual_actions.items.some((x) => x.reason === 'Бронь отменена гостем поздно'));
    assert.equal(r.manual_actions.guests.count, 1);
    assert.equal(r.manual_actions.guests.items[0].kind, 'guest');
    // Возврат пакета — одна строка ручных с прикреплёнными денежными записями.
    const pkg = r.manual_actions.items.filter((x) => x.reason === 'Ошибка продажи');
    assert.equal(pkg.length, 1);
    assert.deepEqual([pkg[0].action, pkg[0].kind, pkg[0].linked], ['manual.package_refund', 'manual', ['payment.refunded', 'pos.refund']]);
    const tea = r.manual_actions.items.filter((x) => x.reason === 'Не тот чай');
    assert.equal(tea.length, 1);
    assert.deepEqual([tea[0].action, tea[0].kind, tea[0].linked], ['payment.refunded', 'staff', ['pos.refund']]);
    assert.equal(r.manual_actions.by_action['pos.refund'], undefined);
    assert.equal(r.manual_actions.automatic.by_action['payment.forfeited'], 1);
    assert.equal(r.manual_actions.automatic.by_action['payment.refunded'], 1);
    assert.equal(r.manual_actions.automatic.by_action['payment.canceled'], 1, 'отмена без причины — не действие для отчёта');
    assert.equal(r.manual_actions.automatic.by_action['session.start'], undefined);
    assert.ok(r.manual_actions.staff.by_action['service.start'] >= 1);
    const light = r.manual_actions.items.find((x) => x.action === 'service.start');
    assert.equal(light.resource_number, 1);
    assert.equal(light.resource_id, TABLE_1);
    assert.deepEqual([r.reconciliation.shift_links.status, r.reconciliation.shift_links.ok], ['checked', true]);
    assert.equal(r.cash.discrepancy_kopecks, -50000);
    assert.equal(r.reconciliation.kkt.ok, true, JSON.stringify(r.reconciliation.kkt));
    assert.equal(r.reconciliation.kkt.diff_kopecks, 0);
    assert.equal(r.reconciliation.online.status, 'skipped');
  });

  it('права: отчёт — владелец и управляющий; ресепшн — 403; чужой клуб — 404', async () => {
    assert.equal((await t.request('GET', `/api/shifts/${shift.id}/report?online=0`, { token: await t.login('owner') })).status, 200);
    assert.equal((await t.request('GET', `/api/shifts/${shift.id}/report?online=0`, { token: reception })).status, 403);
    assert.equal((await t.request('GET', `/api/shifts/${shift.id}/report?online=0`, { token: await t.login('ownerB') })).status, 404);
    assert.equal((await t.request('GET', `/api/shifts/${shift.id}`, { token: await t.login('ownerB') })).status, 404);
    assert.equal((await t.request('GET', `/api/clubs/${CLUB_A}/shifts`, { token: reception })).status, 403);
    const list = await t.request('GET', `/api/clubs/${CLUB_A}/shifts`, { token: await t.login('manager') });
    assert.equal(list.json.items[0].id, shift.id);
    assert.equal(list.json.items[0].revenue_total_kopecks, 270000);
  });

  it('закрыть ещё раз — 409 shift_closed; новую смену без факта наличных не закрыть (400)', async () => {
    const again = await t.request('POST', `/api/shifts/${shift.id}/close`, { token: reception, body: { actual_cash_kopecks: 0 } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'shift_closed');
    const open = await t.request('POST', `/api/clubs/${CLUB_A}/shifts`, { token: reception, body: { float_kopecks: 0 } });
    assert.equal(open.status, 201);
    assert.equal(open.json.number, 2);
    assert.ok(new Date(open.json.opened_at) > new Date(shift.closed_at ?? 0));
    for (const body of [{}, { actual_cash_kopecks: null }, { actual_cash_kopecks: '100' }, { actual_cash_kopecks: 1.5 }]) {
      const res = await t.request('POST', `/api/shifts/${open.json.id}/close`, { token: reception, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    // Мягкая ссылка кассы на смену (№92): продажа со ссылкой на несуществующую смену видна в сверке.
    await t.admin.query(
      `insert into bl.pos_sales (club_id, channel, method, status, created_by, shift_id, table_kopecks, received_kopecks, change_kopecks, created_at, completed_at, updated_at)
       values ($1, 'pos', 'cash', 'completed', $2, gen_random_uuid(), 100, 100, 0, now(), now(), now())`,
      [CLUB_A, RECEPTION_A],
    );
    const rep2 = await t.request('GET', `/api/shifts/${open.json.id}/report?online=0`, { token: await t.login('manager') });
    assert.equal(rep2.json.reconciliation.shift_links.ok, false);
    assert.equal(rep2.json.reconciliation.shift_links.dangling.length, 1);
    // Без расхождения — тревоги нет.
    const ok = await t.request('POST', `/api/shifts/${open.json.id}/close`, { token: reception, body: { actual_cash_kopecks: 0 } });
    assert.equal(ok.json.discrepancy_kopecks, 0);
    const alarm = await t.admin.query("select count(*)::int as n from bl.alarms where club_id = $1 and type = 'cash_discrepancy'", [CLUB_A]);
    assert.equal(alarm.rows[0].n, 1);
  });

  it('закрытая смена неизменна для app_api (триггер), размен не меняется', async () => {
    const c = await t.admin.connect();
    try {
      await c.query('begin');
      await c.query('set local role app_api');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      await assert.rejects(c.query('update bl.shifts set actual_cash_kopecks = 0 where id = $1', [shift.id]), (e) => e.code === '23514' || e.code === '42501');
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
});
