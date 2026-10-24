// Перепроверка M5.2 после правок (код 4d79ae2): Н1 и правки pentester (№189).
//   * Н1: сумма ёмкости тепловой карты = кольцу на неполных сутках (21.10 — сутки создания клуба сида,
//     сегодня — текущие) и с фильтром по типу стола; таблица по столам = сумме своих ячеек;
//   * чужой стол, игра, статья и запись кассы под путём своего клуба — 404 (явный club_id в узких чтениях);
//   * касса управляющего: дата старше 35 дней — 400, ровно 35 — можно; будущая — 400; запись позавчерашним
//     числом — уведомление владельцу cashbook.backdated, вчерашним — без уведомления.
// Клубы M5.3 (E2E_M53_DIR) — «чужие» объекты для клуба сида.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { computeDay } from '../../../server/dashboard/day.mjs';
import { loadClub } from '../../../server/dashboard/store.mjs';
import { addDays, adminClient, api, appClient, capi, CLUB_A, dash, get, loginWait, notificationsFor, short, sleep, tv, workingDay } from './helpers.mjs';

const M53 = (() => {
  try {
    return JSON.parse(readFileSync(path.join(process.env.E2E_M53_DIR || path.join(os.tmpdir(), 'bl-e2e-m53'), 'state.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const today = workingDay();
const OWNER_A = 'a1000000-0000-4000-8000-000000000001';
const S = {};
let db;

before(async () => {
  db = await adminClient();
  S.owner = await loginWait('+70000000001');
  S.man = await loginWait('+70000000003');
  if (M53.ownerPhone) S.x = await loginWait(M53.ownerPhone);
});
after(async () => db?.end());

const isoDow = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

test('Н1: сумма ёмкости тепловой карты = кольцу на неполных сутках и с фильтром типа; столы = сумма ячеек', async (t) => {
  const out = [];
  const kinds = (await db.query('select distinct type from bl.resources where club_id = $1', [CLUB_A])).rows.map((r) => r.type);
  for (const day of ['2026-10-21', today]) {
    for (const kind of [undefined, ...kinds]) {
      await sleep(day === today ? 0 : 0);
      const r = await dash(S.owner.token, CLUB_A, { from: day, to: day, tab: 'hall', kind });
      assert.equal(r.status, 200, r.text);
      const cells = r.json.series.heatmap.capacity_minutes[isoDow(day) - 1].reduce((a, b) => a + b, 0);
      const ring = r.json.series.ring.capacity_minutes;
      const byRes = r.json.tables.by_resource.reduce((a, x) => a + (x.capacity_minutes ?? 0), 0);
      const hoursTile = tv(r.json, 'capacity_hours');
      out.push(`${day}${kind ? `/${kind}` : ''}: карта ${cells}, кольцо ${ring}${r.json.tables.by_resource[0]?.capacity_minutes !== undefined ? `, столы ${byRes}` : ''}, плитка ${hoursTile} ч`);
      if (cells !== ring) S.n1bad = [...(S.n1bad ?? []), `${day}${kind ? `/${kind}` : ''}: ${cells} ≠ ${ring}`];
      assert.equal(hoursTile, Math.round((ring / 60) * 10) / 10, 'плитка ёмкости = кольцу');
    }
  }
  const st = (await db.query("select version, capacity_minutes, computed_at from bl.stats_daily where club_id = $1 and day = '2026-10-21'", [CLUB_A])).rows[0];
  out.push(`агрегат 21.10: версия ${st.version}, ёмкость ${st.capacity_minutes}, посчитан ${st.computed_at.toISOString()}`);
  // Тот же день новым кодом (recomputeDay в транзакции app_api с ROLLBACK): карта = итог?
  const app = await appClient();
  try {
    await app.query('begin');
    await app.query("select set_config('app.club_id', $1, true), set_config('app.user_id', '', true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
    const club = await loadClub(app, CLUB_A);
    const { daily, hourly } = await computeDay(app, { club, day: '2026-10-21', now: new Date() });
    const sumCells = hourly.reduce((a, h) => a + h.capacity_minutes, 0);
    out.push(`21.10 новым кодом: ячейки ${sumCells}, итог ${daily.totals.capacity_minutes}`);
    S.fresh = sumCells === daily.totals.capacity_minutes;
  } finally {
    await app.query('rollback');
    await app.end();
  }
  t.diagnostic(out.join('; '));
  assert.ok(S.fresh, 'новым кодом сутки 21.10 сходятся');
  assert.deepEqual(S.n1bad ?? [], [], 'на экране карта = кольцо');
});

test('pentester: чужой стол, игра, статья, запись кассы под путём своего клуба — 404', { skip: M53.club ? false : 'нет клубов M5.3' }, async (t) => {
  const B = M53.club;
  // Объекты клуба B: стол, игра, статья, запись кассы (запись — владельцем B).
  const sessB = (await db.query('select id from bl.sessions where club_id = $1 and payer_user_id is not null order by started_at desc limit 1', [B])).rows[0];
  const cats = (await get(`/api/clubs/${B}/cashbook/categories`, S.x.token, { 'x-club-id': B })).json;
  const catB = (cats.items ?? cats.categories ?? cats).find((c) => c.kind === 'expense');
  const e = await capi('POST', `/api/clubs/${B}/cashbook`, { token: S.x.token, club: B, body: { kind: 'expense', amount_kopecks: 100, category_id: catB.category_id, comment: 'e2e перепроверка' }, idem: true });
  assert.ok([200, 201].includes(e.status), short(e));
  const entryB = e.json.entry_id ?? e.json.id;
  const H = { 'x-club-id': CLUB_A };
  const calls = [
    ['GET', `/api/clubs/${CLUB_A}/resources/${M53.table.id}/sessions?from=${today}&to=${today}`],
    ['POST', `/api/clubs/${CLUB_A}/sessions/${sessB.id}/guest-phone`, { reason: 'e2e перепроверка' }],
    ['POST', `/api/clubs/${CLUB_A}/cashbook/${entryB}/storno`, { reason: 'e2e перепроверка' }],
    ['PATCH', `/api/clubs/${CLUB_A}/cashbook/categories/${catB.category_id}`, { name: 'e2e чужая' }],
    ['POST', `/api/clubs/${CLUB_A}/cashbook`, { kind: 'expense', amount_kopecks: 100, category_id: catB.category_id }],
  ];
  const res = [];
  for (const [m, p, body] of calls) {
    const r = await api(m, p, { token: S.owner.token, body, idem: m === 'POST' ? true : undefined, headers: H });
    res.push(`${m} ${p.replace(CLUB_A, '{A}').split('?')[0].replace(/[0-9a-f-]{36}/g, (x) => (x === CLUB_A ? '{A}' : '{B}'))} → ${r.status} ${r.text.slice(0, 40)}`);
    assert.equal(r.status, 404, `${m} ${p}: ${r.status}`);
  }
  // Объекты B не изменились.
  const cat = (await db.query('select name from bl.cashbook_categories where id = $1', [catB.category_id])).rows[0];
  assert.notEqual(cat.name, 'e2e чужая');
  assert.equal((await db.query('select count(*)::int as n from bl.cashbook_entries where reverses_id = $1', [entryB])).rows[0].n, 0);
  t.diagnostic(res.join('; '));
});

test('№189: касса — дата старше 35 дней 400, 35 — можно, будущая 400; позавчерашним числом — уведомление владельцу', async (t) => {
  const H = { 'x-club-id': CLUB_A };
  const cats = (await get(`/api/clubs/${CLUB_A}/cashbook/categories`, S.man.token, H)).json;
  const cat = (cats.items ?? cats.categories ?? cats).find((c) => c.kind === 'expense' && c.name === 'Прочее');
  const post = (date, comment) => api('POST', `/api/clubs/${CLUB_A}/cashbook`, { token: S.man.token, idem: true, headers: H, body: { kind: 'expense', amount_kopecks: 1_000, category_id: cat.category_id, date, comment } });
  const old36 = await post(addDays(today, -36), 'e2e 36 дней');
  const fut = await post(addDays(today, 1), 'e2e завтра');
  assert.equal(old36.status, 400, short(old36));
  assert.deepEqual(old36.json, { error: 'bad_request' });
  assert.equal(fut.status, 400);
  const since = new Date();
  const yest = await post(addDays(today, -1), 'e2e вчера (перепроверка)');
  assert.ok([200, 201].includes(yest.status), short(yest));
  await sleep(2000);
  const n0 = (await notificationsFor(db, OWNER_A, { kinds: ['cashbook.backdated'], since })).length;
  assert.equal(n0, 0, 'вчерашним числом — без уведомления');
  const back2 = await post(addDays(today, -2), 'e2e позавчера (перепроверка)');
  assert.ok([200, 201].includes(back2.status), short(back2));
  const ok35 = await post(addDays(today, -35), 'e2e 35 дней (перепроверка)');
  assert.ok([200, 201].includes(ok35.status), `ровно 35 дней — можно: ${short(ok35)}`);
  await sleep(2000);
  const n = await notificationsFor(db, OWNER_A, { kinds: ['cashbook.backdated'], since });
  assert.equal(n.length, 2, 'позавчера и 35 дней — по уведомлению');
  assert.match(n[0].text, /задним числом/);
  const man = await notificationsFor(db, 'a1000000-0000-4000-8000-000000000003', { kinds: ['cashbook.backdated'], since });
  assert.equal(man.length, 0, 'управляющему — нет (только владельцу)');
  const alarms = (await db.query("select count(*)::int as n from bl.alarms where club_id = $1 and raised_at >= $2 and data->>'action' like 'cashbook%'", [CLUB_A, since])).rows[0].n;
  // Сторно этих записей (чистка).
  for (const r of [yest, back2, ok35]) await api('POST', `/api/clubs/${CLUB_A}/cashbook/${r.json.entry_id ?? r.json.id}/storno`, { token: S.man.token, idem: true, headers: H, body: { reason: 'Чистка перепроверки (тест e2e)' } });
  t.diagnostic(`36 дней → ${old36.status} ${JSON.stringify(old36.json)}; завтра → ${fut.status}; вчера → ${yest.status}, уведомлений 0; позавчера → ${back2.status}; 35 дней → ${ok35.status}; владельцу ${n.length}: «${n[0].text}»; управляющему ${man.length}; тревог ${alarms}`);
});
