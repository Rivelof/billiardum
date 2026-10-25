// Падел-корт и деньги (M5.8 №204, T47–T48) на настоящем Postgres и эмуляторе ЮKassa: корт по QR
// (виды ресурса, варианты — слоты), котировка слотами (граница расписания внутри слота, пояс клуба),
// продление слотом, «Без лимита» и баланс — нет, чек «Игра, корт 1, 1 ч 30 мин», изоляция RLS.
// Корты и тариф слотов — из сида (seed.d/1300_padel.sql): слот 90 минут, будни 06–17 — 2 400 ₽,
// 17–06 — 3 600 ₽, выходные — 3 900 ₽ (Asia/Yekaterinburg, UTC+5).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { routes as quoteRoutes } from '../../api/routes/quotes.mjs';
import { withContext } from '../../server/lib/store.mjs';
import { amountFor, resourceBilling } from '../../server/tariffs/index.mjs';
import { CLUB_A, CLUB_B, GUEST_1, GUEST_2, newKey, setupMoney } from './money_harness.mjs';

const route = (list, method, path) => list.find((r) => r.method === method && r.path === path);
const TABLE_ROUTE = route(quoteRoutes, 'GET', '/api/t/{code}');
const QUOTE = route(quoteRoutes, 'POST', '/api/quotes');
const PAY = route(quoteRoutes, 'POST', '/api/quotes/{id}/pay');

const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
// Вторник 20.10.2026, 13:00 в Екатеринбурге (08:00Z): дневная цена корта.
const START = '2026-10-20T08:00:00.000Z';

let h;

before(async () => {
  h = await setupMoney({ start: START });
});

after(async () => {
  await h?.close();
});

const quote = (user, body) => h.call(QUOTE, { user, body });

describe('корт по QR (T48: вид ресурса и слово)', () => {
  it('GET /api/t/{code}: корт — kind padel_court, семья court, слоты 90 минут, варианты — слоты, без «Без лимита»', async () => {
    const r = await h.call(TABLE_ROUTE, { params: { code: 'TESTC00001' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.resource, {
      id: COURT_1, number: 1, type: 'padel_court', title: 'Корт 1', kind: 'padel_court', family: 'court', billing: 'slot', slot_minutes: 90, max_players: 4,
    });
    assert.deepEqual(r.json.options, [90, 180, 270]);
    assert.deepEqual(r.json.price_now, { price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90, until_local: '17:00', until: '2026-10-20T12:00:00.000Z' });
    assert.equal(r.json.price_next.price_per_slot_kopecks, 360000);
  });
});

describe('котировка корта слотами (№204)', () => {
  it('слот — ровно цена слота; два слота; не кратно слоту, «Без лимита» и баланс — 400', async () => {
    const one = await quote(GUEST_1, { resource_id: COURT_1, kind: 'start', minutes: 90 });
    assert.equal(one.status, 200, JSON.stringify(one.json));
    assert.equal(one.json.amount_kopecks, 240000);
    assert.equal(one.json.minutes, 90);
    assert.deepEqual([one.json.slot_minutes, one.json.slots], [90, 1]);
    assert.deepEqual(one.json.breakdown, [
      { from: START, to: '2026-10-20T09:30:00.000Z', price_per_hour_kopecks: 160000, price_per_slot_kopecks: 240000, slot_minutes: 90, amount_kopecks: 240000 },
    ]);
    // Тот же гость пересчитывает: два слота — вдвое.
    assert.equal((await quote(GUEST_1, { resource_id: COURT_1, kind: 'start', minutes: 180 })).json.amount_kopecks, 480000);
    for (const body of [{ minutes: 60 }, { minutes: 120 }, { minutes: null }, { minutes: 90, use_balance: true }]) {
      const r = await quote(GUEST_1, { resource_id: COURT_1, kind: 'start', ...body });
      assert.deepEqual([r.status, r.json], [400, { error: 'bad_request' }], JSON.stringify(body));
    }
  });

  it('граница расписания внутри слота: 16:30–18:00 местного — 30 минут дневной цены и 60 вечерней', async () => {
    h.clock.set('2026-10-20T11:30:00.000Z');
    try {
      const r = await quote(GUEST_2, { resource_id: COURT_2, kind: 'start', minutes: 90 });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.amount_kopecks, 80000 + 240000);
      assert.deepEqual(r.json.breakdown.map((b) => [b.price_per_slot_kopecks, b.amount_kopecks]), [[240000, 80000], [360000, 240000]]);
    } finally {
      h.clock.set(START);
    }
  });

  it('пояс клуба: тот же момент UTC в клубе по Москве — дневная цена целиком', async () => {
    await h.pool.query("update bl.clubs set timezone = 'Europe/Moscow' where id = $1", [CLUB_A]);
    try {
      const at = new Date('2026-10-20T11:30:00.000Z'); // 14:30 по Москве, 16:30 в Екатеринбурге
      const r = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, (db) => amountFor(db, { resourceId: COURT_2, from: at, minutes: 90 }));
      assert.deepEqual([r.amount_kopecks, r.minutes, r.slot_minutes], [240000, 90, 90]);
    } finally {
      await h.pool.query("update bl.clubs set timezone = 'Asia/Yekaterinburg' where id = $1", [CLUB_A]);
    }
  });

  it('старт меньше слота по тарифу — слот (минимум), продление — вверх до слота', async () => {
    const inA = (fn) => withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, fn);
    assert.equal((await inA((db) => amountFor(db, { resourceId: COURT_1, from: new Date(START), minutes: 30 }))).minutes, 90);
    const ext = await inA((db) => amountFor(db, { resourceId: COURT_1, from: new Date(START), minutes: 1, minimum: false }));
    assert.deepEqual([ext.minutes, ext.amount_kopecks], [90, 240000]);
    assert.deepEqual(await inA((db) => resourceBilling(db, { resourceId: COURT_1 })), { type: 'padel_court', billing: 'slot', slot_minutes: 90 });
    assert.deepEqual(await inA((db) => resourceBilling(db, { resourceId: 'e1000000-0000-4000-8000-000000000001' })), { type: 'billiard_pyramid', billing: 'hourly', slot_minutes: null });
  });

  it('продление слотом: котировка от paid_until, 90 — да, 60 — 400', async () => {
    const sid = randomUUID();
    const paidUntil = new Date('2026-10-20T09:30:00.000Z');
    h.sessions.sessions.set(sid, { id: sid, resource_id: COURT_2, paid_until: paidUntil, status: 'active', participants: new Set([GUEST_2]), payer: GUEST_2, unlimited: false });
    await h.pool.query(
      `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, unlimited, started_at, paid_until, warn_ms, grace_ms, created_at, updated_at)
       values ($1, $2, $3, 'active', 'qr', $4, false, $5, $6, '{300000,60000}', 120000, $5, $5)`,
      [sid, CLUB_A, COURT_2, GUEST_2, new Date(START), paidUntil],
    );
    const ok = await quote(GUEST_2, { resource_id: COURT_2, kind: 'extend', session_id: sid, minutes: 90 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.minutes, 90);
    assert.equal(ok.json.breakdown[0].from, paidUntil.toISOString());
    assert.equal(ok.json.amount_kopecks, 240000);
    assert.equal((await quote(GUEST_2, { resource_id: COURT_2, kind: 'extend', session_id: sid, minutes: 60 })).json.error, 'bad_request');
    h.sessions.sessions.delete(sid);
    await h.pool.query("update bl.sessions set status = 'closed', ended_at = $2 where id = $1", [sid, paidUntil]);
  });

  it('оплата слота: платёж на 90 минут, чек ЮKassa «Игра, корт 1, 1 ч 30 мин»', async () => {
    h.sessions.holds.delete(COURT_1);
    const q = (await quote(GUEST_1, { resource_id: COURT_1, kind: 'start', minutes: 90 })).json;
    const r = await h.call(PAY, { user: GUEST_1, params: { id: q.quote_id }, body: { method: 'sbp' }, idempotencyKey: newKey() });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const p = (await h.q('select * from bl.payments where id = $1', [r.json.payment_id]))[0];
    assert.deepEqual([p.minutes, Number(p.amount_kopecks), p.resource_id], [90, 240000, COURT_1]);
    const emuP = await (await fetch(`${h.emuBase}/__emu/payments/${p.provider_payment_id}`)).json();
    assert.equal(emuP.receipt.items[0].description, 'Игра, корт 1, 1 ч 30 мин');
    assert.equal(emuP.receipt.items[0].amount.value, '2400.00');
  });
});

describe('изоляция корта (инвариант 5)', () => {
  it('чужой клуб не видит корт и его правила тарифа', async () => {
    await withContext(h.pool, { clubId: CLUB_B, actorType: 'system' }, async (db) => {
      await db.query('set local role app_api');
      assert.equal((await db.query("select count(*)::int as n from bl.resources where type = 'padel_court'")).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int as n from bl.tariff_rules where slot_minutes is not null')).rows[0].n, 0);
      assert.equal(await resourceBilling(db, { resourceId: COURT_1 }), null);
    });
    // Котировка на корт клуба A из клуба B невозможна: клуб берётся по ресурсу, RLS — по нему же.
    const r = await withContext(h.pool, { clubId: CLUB_A, actorType: 'system' }, async (db) => {
      await db.query('set local role app_api');
      return (await db.query("select count(*)::int as n from bl.resources where type = 'padel_court'")).rows[0].n;
    });
    assert.equal(r, 2);
  });

  it('база: у корта только правила слота; у правила слота шаг и минимум — слот; цена слота > 0', async () => {
    const bad = async (sql, params) => {
      try {
        await h.pool.query(sql, params);
      } catch (err) {
        return err.code;
      }
      return 'ok';
    };
    const ins = `insert into bl.tariff_rules (club_id, resource_type, days, start_local, end_local, price_per_hour, step_minutes, min_minutes, slot_minutes, price_per_slot)
                 values ($1, $2, '{1}', '10:00', '11:00', $3, $4, $5, $6, $7)`;
    assert.equal(await bad(ins, [CLUB_A, 'padel_court', 1000, 1, 30, null, null]), '23514', 'почасовое правило корта');
    assert.equal(await bad(ins, [CLUB_A, 'padel_court', 1000, 60, 60, 60, 0]), '23514', 'цена слота 0');
    assert.equal(await bad(ins, [CLUB_A, 'padel_court', 1000, 60, 30, 60, 1000]), '23514', 'минимум не слот');
    assert.equal(await bad(ins, [CLUB_A, 'padel_court', 1000, 90, 90, 45, 1000]), '23514', 'слот 45');
    assert.equal(await bad(ins, [CLUB_A, 'billiard_pool', 1000, 90, 90, null, null]), '23514', 'почасовой шаг больше 60');
    // Номер — своя нумерация у семьи: корт 1 рядом со столом 1, второй корт 1 — нет.
    assert.equal(await bad("insert into bl.resources (club_id, type, number, title) values ($1, 'padel_court', 1, 'Корт 1')", [CLUB_A]), '23505');
    assert.equal(await bad("insert into bl.resources (club_id, type, number, title) values ($1, 'padel_court', 3, 'Корт 3')", [CLUB_A]), 'ok');
    await h.pool.query("delete from bl.resources where club_id = $1 and type = 'padel_court' and number = 3", [CLUB_A]);
  });
});
