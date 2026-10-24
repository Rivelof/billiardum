// Правки после приёмки M5.2: Н1 tester (ёмкость тепловой карты = кольцу), наблюдения pentester
// (явный club_id в узких чтениях: чужой id — 404) и №189 (касса: не раньше 35 дней назад, задним
// числом — уведомление владельцу).

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { startTestApp, CORE_ROUTE_FILES } from '../../../test/db/helpers.mjs';
import { loadRoutes } from '../../../../api/router.mjs';
import { cache } from '../../../../api/routes/dashboard.mjs';
import { seedClubB, CLUB_B, OWNER_B } from '../../../../supabase/tests/helpers.mjs';
import { computeDay } from '../../day.mjs';
import { loadClub } from '../../store.mjs';
import { addDays, dayBounds, workingDayOf } from '../../time.mjs';

const CLUB = 'c1000000-0000-4000-8000-000000000001';
const OWNER = 'a1000000-0000-4000-8000-000000000001';
const MANAGER = 'a1000000-0000-4000-8000-000000000003';
const RES_B = 'e2000000-0000-4000-8000-000000000001';
const TZ = 'Asia/Yekaterinburg';
const ROUTES = [...CORE_ROUTE_FILES, 'dashboard.mjs', 'cashbook.mjs', 'who-played.mjs'];

let t;
const tok = {};
const clock = { now: () => new Date() };
const today = () => workingDayOf(clock.now(), TZ, '06:00');
const ids = {};

before(async () => {
  t = await startTestApp({ routes: await loadRoutes({ only: ROUTES }), clock });
  await seedClubB(t.admin);
  const q = (sql, p) => t.admin.query(sql, p);
  await q('update bl.clubs set created_at = $2 where id = $1', [CLUB, new Date(Date.now() - 60 * 86_400_000)]);
  await q('update bl.resources set created_at = $2 where club_id = $1', [CLUB, new Date(Date.now() - 60 * 86_400_000)]);
  // Клуб Б: игра на его столе, статья и запись кассы.
  ids.sessB = randomUUID();
  const at = new Date(Date.now() - 3 * 3600_000);
  await q(
    `insert into bl.sessions (id, club_id, resource_id, status, source, payer_user_id, started_at, paid_until, ended_at, close_reason, created_at, updated_at)
     values ($1, $2, $3, 'closed', 'qr', $4, $5, $6, $6, 'expired', $5, $6)`,
    [ids.sessB, CLUB_B, RES_B, OWNER_B, at, new Date(at.getTime() + 3600_000)],
  );
  ids.catB = (await q(`insert into bl.cashbook_categories (club_id, kind, name, sort, created_at, updated_at) values ($1, 'expense', 'Аренда Б', 10, now(), now()) returning id`, [CLUB_B])).rows[0].id;
  ids.entryB = (await q(`insert into bl.cashbook_entries (club_id, kind, amount_kopecks, category_id, occurred_on, created_at) values ($1, 'expense', 1000, $2, current_date, now()) returning id`, [CLUB_B, ids.catB])).rows[0].id;
  for (const [k, phone] of Object.entries({ owner: '+70000000001', manager: '+70000000003' })) tok[k] = (await t.login(phone)).token;
});

after(async () => {
  await t?.stop();
});

const req = (method, path, body, who = 'owner', idem = true) => {
  cache.clear();
  return t.request(method, path, { token: tok[who], body, headers: idem && method === 'POST' ? { 'idempotency-key': randomUUID() } : {} });
};
const notes = async (userId, kind) => (await t.admin.query('select text, level, data from bl.notifications where user_id = $1 and kind = $2 order by created_at', [userId, kind])).rows;

describe('Н1: ёмкость тепловой карты = кольцу в неполных сутках', () => {
  it('сумма ячеек стол × час = итог суток = сумма по столам', async () => {
    const club = await loadClub(t.admin, CLUB);
    const day = today();
    // «Сейчас» — 14:23:37 по местному: у каждого стола последний час — 23,6 мин (раньше каждая
    // ячейка округлялась отдельно и сумма уходила от кольца).
    const now = new Date(dayBounds(day, club.timezone, club.day_start_local).from.getTime() + (8 * 60 + 23) * 60_000 + 37_000);
    const { daily, hourly } = await computeDay(t.admin, { club, day, now });
    const tables = Object.keys(daily.resources).length;
    assert.ok(tables >= 2, 'у клуба сида несколько столов');
    const cells = hourly.reduce((a, h) => a + h.capacity_minutes, 0);
    const exact = Math.round((tables * ((8 * 60 + 23) * 60 + 37)) / 60);
    assert.equal(daily.totals.capacity_minutes, exact, 'итог — округление точной суммы');
    assert.equal(cells, daily.totals.capacity_minutes, 'тепловая карта = кольцо');
    assert.equal(Object.values(daily.resources).reduce((a, r) => a + r.capacity_minutes, 0), daily.totals.capacity_minutes, 'столы = итог');
    for (const h of hourly) assert.ok(h.capacity_minutes >= 0 && h.capacity_minutes <= 61, `ячейка ${h.hour}`);
  });
});

describe('явный club_id в узких чтениях: чужой id — 404', () => {
  it('«Кто играл за столом»: стол и игра клуба Б из клуба А', async () => {
    assert.equal((await req('GET', `/api/clubs/${CLUB}/resources/${RES_B}/sessions`)).status, 404);
    assert.equal((await req('POST', `/api/clubs/${CLUB}/sessions/${ids.sessB}/guest-phone`, { reason: 'проверка' }, 'owner', false)).status, 404);
  });

  it('касса: статья, запись и правка статьи клуба Б из клуба А', async () => {
    const r = await req('POST', `/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 100, category_id: ids.catB });
    assert.equal(r.status, 404, r.text);
    assert.equal((await req('POST', `/api/clubs/${CLUB}/cashbook/${ids.entryB}/storno`, { reason: 'проверка' })).status, 404);
    assert.equal((await req('PATCH', `/api/clubs/${CLUB}/cashbook/categories/${ids.catB}`, { name: 'Взлом' })).status, 404);
    const b = await t.admin.query('select name from bl.cashbook_categories where id = $1', [ids.catB]);
    assert.equal(b.rows[0].name, 'Аренда Б');
    assert.equal((await t.admin.query('select count(*)::int as n from bl.cashbook_entries where club_id = $1', [CLUB_B])).rows[0].n, 1);
  });
});

describe('№189: дата записи кассы', () => {
  it('не раньше 35 дней назад; раньше вчерашних суток — уведомление владельцу, не тревога', async () => {
    const cats = await req('GET', `/api/clubs/${CLUB}/cashbook/categories`, undefined, 'manager');
    const rent = cats.json.find((c) => c.name === 'Аренда').category_id;
    const add = (date) => req('POST', `/api/clubs/${CLUB}/cashbook`, { kind: 'expense', amount_kopecks: 150000, category_id: rent, date }, 'manager');
    const old = await add(addDays(today(), -36));
    assert.deepEqual([old.status, old.json], [400, { error: 'bad_request' }]);
    // Вчера и сегодня — без уведомления.
    assert.equal((await add(addDays(today(), -1))).status, 201);
    assert.equal((await add(today())).status, 201);
    assert.equal((await notes(OWNER, 'cashbook.backdated')).length, 0);
    // Позавчера и ровно 35 дней назад — можно, владельцу уведомление.
    const back = await add(addDays(today(), -2));
    assert.equal(back.status, 201, back.text);
    const edge = await add(addDays(today(), -35));
    assert.equal(edge.status, 201, edge.text);
    const n = await notes(OWNER, 'cashbook.backdated');
    assert.equal(n.length, 2);
    assert.match(n[0].text, /задним числом — расход 1\s500\s₽, статья «Аренда»/);
    assert.equal(n[0].data.entry_id, back.json.entry_id);
    assert.equal((await notes(MANAGER, 'cashbook.backdated')).length, 0, 'управляющему — нет');
    const al = await t.admin.query("select count(*)::int as n from bl.alarms where club_id = $1 and data->>'action' like 'cashbook%'", [CLUB]);
    assert.equal(al.rows[0].n, 0, 'не тревога');
  });
});
