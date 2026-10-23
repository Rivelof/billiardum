// Мастер подключения, часть backend-B, на временной базе (M5.1 №155–158): столы и план,
// тарифы с проверкой недели, режимы test/live (ручное действие), наклейки и функции чек-листа,
// приглашение ссылкой, импорт меню из .xlsx.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadRoutes } from '../../../../api/router.mjs';
import { withContext } from '../../../lib/store.mjs';
import { amountFor } from '../../../tariffs/index.mjs';
import { CLUB_A, MANAGER_A, OWNER_A, startTestApp } from '../../../test/db/helpers.mjs';
import { makeXlsx, makeZip } from '../../../catalog/test/zip-fixture.mjs';
import { applyTemplate } from '../../tariffs.mjs';
import { activeCount, coversWeek, printedAt, printStatus, weekCoverage } from '../../index.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const CLUB_X = 'c7000000-0000-4000-8000-000000000007';
const OWNER_X = 'a7000000-0000-4000-8000-000000000007';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let t;
let owner;
let manager;
let reception;
let ownerX;

before(async () => {
  if (SKIP) return;
  const config = { publicHost: 'bl.test' };
  const routes = await loadRoutes({ config, only: ['auth.mjs', 'setup.mjs', 'owner.mjs', 'staff.mjs', 'catalog.mjs'] });
  t = await startTestApp({ routes, notifyWorker: false });
  // Второй клуб — для изоляции.
  await t.admin.query(`
    insert into bl.users (id, phone) values ('${OWNER_X}', '+70000000777');
    insert into bl.clubs (id, name, city, timezone) values ('${CLUB_X}', 'Клуб Икс', 'Пермь', 'Asia/Yekaterinburg');
    insert into bl.club_members (club_id, user_id, role) values ('${CLUB_X}', '${OWNER_X}', 'owner');
  `);
  owner = await t.login('+70000000001');
  manager = await t.login('+70000000003');
  reception = await t.login('+70000000004');
  ownerX = await t.login('+70000000777');
});

after(async () => {
  await t?.stop();
});

const setMode = async (mode) => {
  const has = (await t.admin.query("select 1 from information_schema.columns where table_schema = 'bl' and table_name = 'clubs' and column_name = 'mode'")).rowCount;
  if (!has) return false;
  await t.admin.query('update bl.clubs set mode = $2, mode_before_suspend = null where id = $1', [CLUB_A, mode]);
  return true;
};
const audit = async (action) => (await t.admin.query('select * from bl.audit_log where club_id = $1 and action = $2 order by seq', [CLUB_A, action])).rows;
const inA = (fn) => withContext(t.pool, { clubId: CLUB_A, actorType: 'system' }, fn);
const api = (method, path, token, body) => t.request(method, path, { token, body });

describe('столы и план зала (№155)', { skip: SKIP }, () => {
  it('режим test: создать стол (код по умолчанию, журнал), дубль номера, права, проверка полей', async () => {
    await setMode('test');
    const r = await api('POST', `/api/clubs/${CLUB_A}/resources`, manager.token, { number: 9, kind: 'mixed', plan_x: 1500, plan_y: 1100, plan_rotation: 90 });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.kind, 'mixed');
    assert.equal(r.json.title, 'Стол 9');
    assert.match(r.json.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
    assert.equal(r.json.active, true);
    const [rec] = await audit('resource.create');
    assert.equal(rec.object_id, r.json.id);
    assert.equal(rec.data.kind, 'mixed');
    assert.equal(rec.reason, null);
    assert.deepEqual(await api('POST', `/api/clubs/${CLUB_A}/resources`, owner.token, { number: 9, kind: 'pool' }).then((x) => [x.status, x.json]), [409, { error: 'duplicate' }]);
    assert.equal((await api('POST', `/api/clubs/${CLUB_A}/resources`, reception.token, { number: 10, kind: 'pool' })).status, 403);
    for (const body of [{ number: 0, kind: 'pool' }, { number: 10, kind: 'billiard_pool' }, { number: 10, kind: 'pool', plan_rotation: 360 }, { number: 10, kind: 'pool', plan_x: -1 }, { number: 10, kind: 'pool', active: false }]) {
      assert.equal((await api('POST', `/api/clubs/${CLUB_A}/resources`, owner.token, body)).status, 400, JSON.stringify(body));
    }
    // Чужой клуб: владелец X не видит и не меняет столы клуба A.
    assert.equal((await api('POST', `/api/clubs/${CLUB_A}/resources`, ownerX.token, { number: 11, kind: 'pool' })).status, 403);
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_X}/resources/${r.json.id}`, ownerX.token, { plan_x: 1 })).status, 404);
  });

  it('позиция и размер зала — журнал; список с выведенными столами', async () => {
    const list = await api('GET', `/api/clubs/${CLUB_A}/resources`, manager.token);
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.plan, { width_cm: 1800, height_cm: 1400 });
    const nine = list.json.resources.find((x) => x.number === 9);
    const p = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${nine.id}`, manager.token, { plan_x: 1600, plan_rotation: 45, title: '  Стол   у окна ' });
    assert.equal(p.status, 200);
    assert.deepEqual([p.json.plan_x, p.json.plan_rotation, p.json.title], [1600, 45, 'Стол у окна']);
    const [u] = await audit('resource.update');
    assert.deepEqual(u.data.changed.plan_x, { from: 1500, to: 1600 });
    const hall = await api('PUT', `/api/clubs/${CLUB_A}/hall`, owner.token, { width: 2000, height: 1500 });
    assert.deepEqual(hall.json, { plan: { width_cm: 2000, height_cm: 1500 } });
    assert.equal((await audit('hall.update')).length, 1);
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/hall`, owner.token, { width: 50, height: 1500 })).status, 400);
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/hall`, reception.token, { width: 2000, height: 1500 })).status, 403);
    const settings = (await t.admin.query('select settings from bl.clubs where id = $1', [CLUB_A])).rows[0].settings;
    assert.deepEqual(settings.plan, { width_cm: 2000, height_cm: 1500 });
  });

  it('вывод стола: занятый (удержание, бронь впереди) — 409 table_busy {reason}; свободный — active=false, без удаления', async () => {
    const id = (await api('GET', `/api/clubs/${CLUB_A}/resources`, owner.token)).json.resources.find((x) => x.number === 9).id;
    const now = new Date();
    await t.admin.query("insert into bl.resource_holds (club_id, resource_id, kind, user_id, until, created_at) values ($1, $2, 'pending', $3, $4, $5)", [
      CLUB_A, id, OWNER_A, new Date(now.getTime() + 10 * 60_000), now,
    ]);
    const busy = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${id}`, owner.token, { active: false });
    assert.deepEqual([busy.status, busy.json], [409, { error: 'table_busy', reason: 'pending', resource_id: id }]);
    await t.admin.query('update bl.resource_holds set released_at = now() where resource_id = $1', [id]);
    await t.admin.query(
      `insert into bl.bookings (club_id, resource_id, user_id, source, starts_at, ends_at, status, prepayment_mode, amount_kopecks, hold_minutes, created_at, updated_at)
       values ($1, $2, $3, 'staff', $4, $5, 'confirmed', 'none', 0, 15, $6, $6)`,
      [CLUB_A, id, OWNER_A, new Date(now.getTime() + 86400_000), new Date(now.getTime() + 90000_000), now],
    );
    const booked = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${id}`, owner.token, { active: false });
    assert.equal(booked.json.reason, 'booking');
    await t.admin.query("update bl.bookings set status = 'canceled', canceled_at = now() where resource_id = $1", [id]);
    const off = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${id}`, owner.token, { active: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.active, false);
    assert.equal((await audit('resource.deactivate')).length, 1);
    assert.equal((await t.admin.query('select count(*)::int as n from bl.resources where id = $1', [id])).rows[0].n, 1);
    // Возврат в работу.
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_A}/resources/${id}`, owner.token, { active: true })).json.active, true);
  });

  it('режим live: добавление и вывод — причина, журнал manual.*, тревога владельцу; позиция — только журнал', async (ctx) => {
    if (!(await setMode('live'))) return ctx.skip('нет clubs.mode (backend-A)');
    assert.deepEqual(await api('POST', `/api/clubs/${CLUB_A}/resources`, owner.token, { number: 12, kind: 'pool' }).then((x) => [x.status, x.json]), [400, { error: 'reason_required' }]);
    const add = await api('POST', `/api/clubs/${CLUB_A}/resources`, manager.token, { number: 12, kind: 'pool', reason: 'Поставили новый стол' });
    assert.equal(add.status, 201, add.text);
    const [m] = await audit('manual.resource_add');
    assert.equal(m.reason, 'Поставили новый стол');
    assert.equal(m.actor_id, MANAGER_A);
    const alarm = (await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'manual.resource_add'", [CLUB_A])).rows;
    assert.equal(alarm.length, 1);
    const notes = (await t.admin.query("select user_id, text from bl.notifications where kind = 'alarm' and data->>'alarm_id' = $1", [alarm[0].id])).rows;
    assert.ok(notes.some((n) => n.user_id === OWNER_A && n.text.includes('Поставили новый стол')), JSON.stringify(notes));
    const move = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, owner.token, { plan_x: 100 });
    assert.equal(move.status, 200);
    assert.equal((await audit('manual.resource_kind')).length, 0, 'позиция — не ручное действие');
    // №164 (tester Д3): смена типа стола в live — ручное действие: причина, журнал, уведомление владельцу.
    const kindNo = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, owner.token, { kind: 'snooker', plan_x: 120 });
    assert.deepEqual([kindNo.status, kindNo.json], [400, { error: 'reason_required' }]);
    const still = (await t.admin.query('select type, plan_x from bl.resources where id = $1', [add.json.id])).rows[0];
    assert.deepEqual([still.type, still.plan_x], ['billiard_pool', 100], 'без причины ничего не меняется');
    const kind = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, manager.token, { kind: 'snooker', reason: 'Перетянули сукно под снукер' });
    assert.equal(kind.status, 200, kind.text);
    assert.equal(kind.json.kind, 'snooker');
    const [k] = await audit('manual.resource_kind');
    assert.equal(k.reason, 'Перетянули сукно под снукер');
    assert.equal(k.actor_id, MANAGER_A);
    assert.deepEqual(k.data.changed, { kind: { from: 'pool', to: 'snooker' } });
    const kindAlarm = (await t.admin.query("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'manual.resource_kind'", [CLUB_A])).rows;
    assert.equal(kindAlarm.length, 1);
    const kindNotes = (await t.admin.query("select user_id, text from bl.notifications where kind = 'alarm' and data->>'alarm_id' = $1", [kindAlarm[0].id])).rows;
    assert.ok(kindNotes.some((n) => n.user_id === OWNER_A && n.text.includes('пул → снукер') && n.text.includes('Перетянули сукно под снукер')), JSON.stringify(kindNotes));
    assert.equal((await audit('resource.update')).filter((r) => r.data.changed?.kind).length, 0, 'смена типа в live — не resource.update');
    assert.equal((await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, owner.token, { active: false })).json.error, 'reason_required');
    const off = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, owner.token, { active: false, reason: 'Стол на ремонте' });
    assert.equal(off.status, 200);
    assert.equal((await audit('manual.resource_remove'))[0].reason, 'Стол на ремонте');
    await setMode('test');
    // В test смена типа — только журнал resource.update, без причины.
    const testKind = await api('PATCH', `/api/clubs/${CLUB_A}/resources/${add.json.id}`, owner.token, { kind: 'pool' });
    assert.equal(testKind.status, 200, testKind.text);
    assert.equal((await audit('manual.resource_kind')).length, 1);
    assert.ok((await audit('resource.update')).some((r) => r.data.changed?.kind?.to === 'pool' && r.reason === null));
  });
});

describe('тарифы (№156)', { skip: SKIP }, () => {
  it('шаблоны — любой вошедший; у смешанного стола без правил своего типа неделя не покрыта', async () => {
    const tpl = await api('GET', '/api/tariff-templates', reception.token);
    assert.equal(tpl.status, 200);
    assert.equal(tpl.json.templates.length, 5);
    assert.equal((await t.request('GET', '/api/tariff-templates')).status, 401);
    const cov = await inA((db) => weekCoverage(db, CLUB_A));
    assert.equal(cov.ok, false);
    assert.equal(cov.problem.type, 'gap');
    // Первым не покрыт смешанный стол 9: правил его типа нет совсем; у пирамиды — дыра 06:00–12:00.
    assert.deepEqual([cov.problem.kind, cov.problem.weekday, cov.problem.from, cov.problem.to], ['mixed', 1, '06:00', '06:00']);
    const g = await api('GET', `/api/clubs/${CLUB_A}/tariffs`, manager.token);
    assert.equal(g.status, 200);
    assert.equal(g.json.timezone, 'Asia/Yekaterinburg');
    assert.equal(g.json.day_start_local, '06:00');
    assert.equal(g.json.coverage.ok, false);
    assert.ok(g.json.rules.some((r) => r.kind === 'pyramid' && r.from === '17:00' && r.to === '00:00' && r.price_per_hour_kopecks === 80000));
  });

  it('дыра и пересечение — 400 с днём и временем; ничего не меняется', async () => {
    const gap = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, {
      rules: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '10:00', to: '02:00', price_per_hour_kopecks: 50000, min_minutes: 30, step_minutes: 1 }],
    });
    assert.equal(gap.status, 400);
    assert.deepEqual(gap.json, { error: 'tariff_gap', weekday: 1, from: '06:00', to: '10:00', kind: 'pyramid' });
    const seedRules = (await t.admin.query('select count(*)::int as n from bl.tariff_rules where club_id = $1 and active', [CLUB_A])).rows[0].n;
    const overlap = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, {
      rules: [...applyTemplate('single', { price: 50000 }), { kind: 'pool', days: [6], from: '12:00', to: '14:00', price_per_hour_kopecks: 1, min_minutes: 30, step_minutes: 1 }],
    });
    assert.deepEqual(overlap.json, { error: 'tariff_overlap', weekday: 6, from: '12:00', to: '14:00', kind: 'pool' });
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: [{ days: [1], from: '06:00', to: '06:00', price_per_hour_kopecks: 1 }] })).status, 400);
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, reception.token, { rules: applyTemplate('single', { price: 1 }) })).status, 403);
    // №163 (pentester Н-1): тариф 0 ₽/ч — 400 bad_request; бесплатная игра — только ручным действием.
    const zero = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules: applyTemplate('single', { price: 0 }), reason: 'Бесплатно' });
    assert.deepEqual([zero.status, zero.json], [400, { error: 'bad_request' }]);
    assert.ok(t.log.lines.some((e) => JSON.stringify(e).includes('rules[0].price_per_hour_kopecks: must be > 0')), 'поле цены — в логе сервера');
    assert.equal((await t.admin.query('select count(*)::int as n from bl.tariff_rules where club_id = $1 and active', [CLUB_A])).rows[0].n, seedRules);
  });

  it('режим test: шаблон «Будни и выходные» — журнал без причины, прежние правила гаснут, движок считает по новым', async () => {
    await setMode('test');
    const rules = applyTemplate('weekdays_weekend', { weekday: 60000, weekend: 90000 });
    const r = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, manager.token, { rules });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.coverage.ok, true);
    assert.deepEqual(
      r.json.rules.map((x) => [x.kind, x.days, x.from, x.to, x.price_per_hour_kopecks]),
      [
        [null, [1, 2, 3, 4, 5], '06:00', '06:00', 60000],
        [null, [6, 7], '06:00', '06:00', 90000],
      ],
    );
    const rows = (await t.admin.query('select active, count(*)::int as n from bl.tariff_rules where club_id = $1 group by active order by active', [CLUB_A])).rows;
    assert.equal(rows.find((x) => x.active).n, 8, 'по правилу на каждый из 4 типов');
    assert.ok(rows.find((x) => !x.active).n >= 12, 'прежние погашены, не удалены');
    const [rec] = await audit('tariff.update');
    assert.equal(rec.reason, null);
    assert.equal(rec.data.after.length, 2);
    assert.equal(await inA((db) => coversWeek(db, CLUB_A)), true);
    // Чт 22.10.2026 12:00 UTC = 17:00 Екатеринбурга — будни; Сб 24.10 07:00 местного — выходные.
    const RES1 = 'e1000000-0000-4000-8000-000000000001';
    const thu = await inA((db) => amountFor(db, { resourceId: RES1, from: '2026-10-22T12:00:00Z', minutes: 60 }));
    assert.equal(thu.amount_kopecks, 60000);
    const sat = await inA((db) => amountFor(db, { resourceId: RES1, from: '2026-10-24T02:00:00Z', minutes: 60 }));
    assert.equal(sat.amount_kopecks, 90000);
  });

  it('режим live: без причины — reason_required; с причиной — manual.tariff_change и тревога', async (ctx) => {
    if (!(await setMode('live'))) return ctx.skip('нет clubs.mode (backend-A)');
    const rules = applyTemplate('single', { price: 70000 });
    assert.equal((await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules })).json.error, 'reason_required');
    const ok = await api('PUT', `/api/clubs/${CLUB_A}/tariffs`, owner.token, { rules, reason: 'Новый прайс с ноября' });
    assert.equal(ok.status, 200, ok.text);
    const [m] = await audit('manual.tariff_change');
    assert.equal(m.reason, 'Новый прайс с ноября');
    assert.equal(m.data.before.length, 2);
    const alarm = (await t.admin.query("select id from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'action' = 'manual.tariff_change'", [CLUB_A])).rows;
    assert.equal(alarm.length, 1);
    await setMode('test');
  });
});

describe('наклейки и функции чек-листа (№159, §3)', { skip: SKIP }, () => {
  it('activeCount, printedAt до и после выгрузки; выбор столов ?resources=', async () => {
    const n = await inA((db) => activeCount(db, CLUB_A));
    assert.equal(n, (await t.admin.query('select count(*)::int as n from bl.resources where club_id = $1 and active', [CLUB_A])).rows[0].n);
    assert.equal(await inA((db) => printedAt(db, CLUB_A)), null);
    const ids = (await t.admin.query('select id from bl.resources where club_id = $1 and active order by number limit 2', [CLUB_A])).rows.map((r) => r.id);
    const pdf = await api('GET', `/api/clubs/${CLUB_A}/qr-stickers.pdf?resources=${ids.join(',')}`, manager.token);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.ok(pdf.buf.toString('latin1').startsWith('%PDF'));
    const at = await inA((db) => printedAt(db, CLUB_A));
    assert.ok(at instanceof Date);
    const st = await inA((db) => printStatus(db, CLUB_A));
    assert.equal(st.printed, 2);
    const [rec] = await audit('qr.stickers_printed');
    assert.deepEqual(rec.data.resource_ids.sort(), [...ids].sort());
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/qr-stickers.pdf?resources=x`, manager.token)).status, 400);
    assert.equal((await api('GET', `/api/clubs/${CLUB_A}/qr-stickers.pdf?resources=e2000000-0000-4000-8000-000000000001`, manager.token)).status, 404);
    // Чужой клуб: в клубе X столов нет, функции видят только свой клуб.
    assert.equal(await withContext(t.pool, { clubId: CLUB_X, actorType: 'system' }, (db) => activeCount(db, CLUB_A)), 0);
  });
});

describe('приглашение ссылкой (№158)', { skip: SKIP }, () => {
  it('POST …/staff/invites: invite_url на /club/, текст без телефона', async () => {
    const r = await api('POST', `/api/clubs/${CLUB_A}/staff/invites`, owner.token, { phone: '+79990005566', role: 'reception' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.invite_url, 'https://bl.test/club/');
    assert.ok(r.json.invite_text.includes('https://bl.test/club/'));
    assert.ok(r.json.invite_text.includes('администратора ресепшена'));
    assert.ok(r.json.invite_text.includes('«Тестовый клуб»'));
    assert.ok(!/5566|9990005/.test(r.json.invite_text), 'телефона нет');
    assert.match(r.json.phone_masked, /\*/);
    const old = await api('POST', `/api/clubs/${CLUB_A}/staff`, owner.token, { phone: '+79990005567', role: 'bar' });
    assert.equal(old.json.invite_url, 'https://bl.test/club/');
    assert.equal((await api('POST', `/api/clubs/${CLUB_A}/staff/invites`, manager.token, { phone: '+79990005568', role: 'bar' })).status, 403);
  });
});

describe('импорт меню из .xlsx (№157)', { skip: SKIP }, () => {
  const upload = (body, { type = XLSX, query = '', token = manager.token } = {}) =>
    t.request('POST', `/api/clubs/${CLUB_A}/catalog/import${query}`, { token, body, raw: true, headers: { 'content-type': type } });

  it('тело .xlsx: предпросмотр (dry_run) без записи, затем импорт; журнал catalog.import', async () => {
    const file = makeXlsx([
      ['Категория', 'Название', 'Цена', 'Артикул'],
      ['Мастер', 'Лимонад', 150, 'LIM'],
      ['Мастер', 'Орешки', '99,90', null],
    ]);
    const dry = await upload(file, { query: '?dry_run=1' });
    assert.equal(dry.status, 200, dry.text);
    assert.deepEqual([dry.json.applied, dry.json.source, dry.json.created, dry.json.categories_created], [false, 'xlsx', 2, ['Мастер']]);
    assert.deepEqual(dry.json.rows.map((p) => [p.line, p.action, p.name, p.price_kopecks]), [[2, 'create', 'Лимонад', 15000], [3, 'create', 'Орешки', 9990]]);
    assert.equal((await t.admin.query("select count(*)::int as n from bl.products where club_id = $1 and name = 'Лимонад'", [CLUB_A])).rows[0].n, 0);
    const done = await upload(file);
    assert.equal(done.json.applied, true);
    assert.equal(done.json.rows, undefined, 'строки — только в предпросмотре');
    assert.equal(done.json.created, 2);
    const [rec] = await audit('catalog.import');
    assert.equal(rec.data.source, 'xlsx');
    // multipart: тот же файл с dry_run — всё «update»/«unchanged».
    const b = 'blB0undary';
    const mp = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\ntrue\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="menu.xlsx"\r\nContent-Type: ${XLSX}\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const m = await upload(mp, { type: `multipart/form-data; boundary=${b}` });
    assert.equal(m.status, 200, m.text);
    assert.deepEqual([m.json.applied, m.json.created, m.json.rows[0].action], [false, 0, 'update']);
  });

  it('испорченный файл и zip-бомба — 400 xlsx_invalid; больше 2 МБ — 413; CSV в JSON работает как раньше; права', async () => {
    assert.deepEqual(await upload(Buffer.from('PK\u0003\u0004garbage')).then((x) => [x.status, x.json]), [400, { error: 'xlsx_invalid' }]);
    assert.deepEqual(await upload(Buffer.from('not a zip at all')).then((x) => [x.status, x.json]), [400, { error: 'xlsx_invalid' }]);
    const bomb = makeZip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(25 * 1024 * 1024, 0x20) }]);
    assert.deepEqual(await upload(bomb).then((x) => [x.status, x.json]), [400, { error: 'xlsx_invalid' }]);
    const big = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(2 * 1024 * 1024 + 100 * 1024)]);
    assert.equal((await upload(big)).status, 413);
    const csv = await api('POST', `/api/clubs/${CLUB_A}/catalog/import`, manager.token, { csv: 'name;price\nВода;60', dry_run: true });
    assert.equal(csv.status, 200);
    assert.equal(csv.json.source, 'csv');
    assert.deepEqual(csv.json.rows.map((r) => [r.name, r.price_kopecks]), [['Вода', 6000]]);
    assert.equal((await upload(makeXlsx([['name', 'price'], ['Вода', 60]]), { token: reception.token })).status, 403);
    assert.equal((await upload(Buffer.from('x'), { type: 'image/png' })).status, 415);
  });
});
