// Утренняя сводка владельцу (контракт M3 §1 п. 8; decisions №110, №43, №13).
//
// 1. Живой стек: в bl.club_summaries по клубу на каждые рабочие сутки не больше одной сводки,
//    отправлена не раньше 10:00 по Екатеринбургу следующего дня; владелец и управляющий получили
//    summary.morning ровно по одному разу; хеш в тексте и data = хеш записи журнала head_seq,
//    цепочка до неё цела. Сервер ускоренных часов не даёт (dev-ручки M1 §2.3 — только
//    DEV_ALLOW_ANY_MINUTES), поэтому момент «10:00» на живом сервере проверяется только так.
// 2. Ускоренные часы: настоящий планировщик server/summaries tick() с поддельными часами на
//    живой базе в транзакции с ROLLBACK (withContext — savepoint на одном соединении):
//    09:59 по клубу — ничего; 10:00 — сводка за вчерашние рабочие сутки (06:00–06:00) владельцу и
//    управляющему, хеш головы журнала; повторный проход — ничего (один раз); следующие сутки —
//    новая сводка.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { tick } from '../../../server/summaries/index.mjs';
import { adminClient, CLUB_A, MANAGER_ID, OWNER_ID } from './helpers.mjs';

let db;

before(async () => {
  db = await adminClient();
});

after(async () => {
  await db?.end();
});

function local(d, tz = 'Asia/Yekaterinburg') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(d));
}

test('живой стек: сводка за сутки одна, после 10:00 по поясу клуба, с хешем головы журнала', async (t) => {
  const { rows: tz } = await db.query('select timezone from bl.clubs where id = $1', [CLUB_A]);
  assert.equal(tz[0].timezone, 'Asia/Yekaterinburg');
  const { rows } = await db.query("select day::text as day, sent_at, data from bl.club_summaries where club_id = $1 and kind = 'morning' order by day", [CLUB_A]);
  assert.ok(rows.length >= 1, 'хотя бы одна сводка отправлена');
  for (const r of rows) {
    const sentLocal = local(r.sent_at);
    const head = r.data.journal;
    const { rows: a } = await db.query('select hash from bl.audit_log where club_id = $1 and seq = $2', [CLUB_A, head.head_seq]);
    const { rows: n } = await db.query(
      "select user_id, count(*)::int as n, min(text) as text from bl.notifications where kind = 'summary.morning' and data->>'day' = $1 and user_id = any($2::uuid[]) group by user_id",
      [r.day, [OWNER_ID, MANAGER_ID]],
    );
    t.diagnostic(`сутки ${r.day}: отправлена ${sentLocal} по клубу; голова журнала ${head.head_seq} ${head.head_hash.slice(0, 16)}…; уведомления ${JSON.stringify(n.map((x) => [x.user_id.slice(-1), x.n]))}; «${n[0]?.text}»`);
    const next = new Date(`${r.day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.ok(sentLocal >= `${next.toISOString().slice(0, 10)} 10:00:00`, 'не раньше 10:00 следующего дня по поясу клуба');
    assert.equal(a[0].hash, head.head_hash, 'хеш головы = хеш записи журнала');
    assert.equal(n.length, 2, 'владелец и управляющий');
    assert.ok(n.every((x) => x.n === 1), 'ровно по одному разу');
    assert.ok(n[0].text.includes(head.head_hash), 'полный хеш в тексте');
  }
  const { rows: dup } = await db.query("select day, count(*)::int as n from bl.club_summaries where club_id = $1 and kind = 'morning' group by day having count(*) > 1", [CLUB_A]);
  assert.deepEqual(dup, []);
  const { rows: v } = await db.query('select * from bl.audit_verify($1)', [CLUB_A]);
  t.diagnostic(`bl.audit_verify: ${JSON.stringify(v[0])}`);
  assert.equal(v[0].ok, true);
});

test('ускоренные часы: 09:59 — нет, 10:00 — сводка за вчера один раз, следующие сутки — новая (живая база, откат)', async (t) => {
  const errors = [];
  const log = { info() {}, warn() {}, error: (msg, f) => errors.push(`${msg} ${JSON.stringify(f)}`) };
  const withContext = async (_pool, { clubId, userId = null, actorType }, fn) => {
    await db.query('savepoint e2e_ctx');
    try {
      await db.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)", [clubId ?? '', userId ?? '', actorType]);
      const r = await fn(db);
      await db.query('release savepoint e2e_ctx');
      return r;
    } catch (err) {
      await db.query('rollback to savepoint e2e_ctx');
      throw err;
    }
  };
  // Будущие сутки: сводок за них ещё нет. 05:00 UTC = 10:00 Екатеринбурга (UTC+5).
  const at = (iso) => ({ now: () => new Date(iso) });
  const run = async (iso) => (await tick({ pool: null, withContext, clock: at(iso), log })).sent.filter((s) => s.club_id === CLUB_A).map((s) => s.day);
  await db.query('begin');
  try {
    const { rows: hb } = await db.query('select seq, hash from bl.audit_log where club_id = $1 order by seq desc limit 1', [CLUB_A]);
    const r0959 = await run('2026-11-05T04:59:00Z');
    const r1000 = await run('2026-11-05T05:00:00Z');
    const r1001 = await run('2026-11-05T05:01:00Z');
    const r1500 = await run('2026-11-05T10:00:00Z');
    const next = await run('2026-11-06T05:00:30Z');
    t.diagnostic(`09:59 → ${JSON.stringify(r0959)}; 10:00 → ${JSON.stringify(r1000)}; 10:01 → ${JSON.stringify(r1001)}; 15:00 → ${JSON.stringify(r1500)}; завтра 10:00 → ${JSON.stringify(next)}`);
    assert.deepEqual(r0959, []);
    assert.deepEqual(r1000, ['2026-11-04']);
    assert.deepEqual(r1001, []);
    assert.deepEqual(r1500, []);
    assert.deepEqual(next, ['2026-11-05']);
    const { rows: s } = await db.query("select day::text as day, data from bl.club_summaries where club_id = $1 and kind = 'morning' and day = '2026-11-04'", [CLUB_A]);
    assert.equal(s.length, 1);
    const d = s[0].data;
    t.diagnostic(`окно сводки ${d.from} – ${d.to}; выручка ${JSON.stringify(d.revenue)}; игра ${JSON.stringify({ h: d.play.hours, u: d.play.utilization_percent })}; тревоги ${JSON.stringify(d.alarms)}; ручных ${d.manual_actions.count}; журнал ${JSON.stringify(d.journal)}`);
    assert.equal(d.from, '2026-11-04T01:00:00.000Z', 'рабочие сутки с 06:00 по клубу');
    assert.equal(d.to, '2026-11-05T01:00:00.000Z');
    assert.equal(d.journal.head_seq, Number(hb[0].seq));
    assert.equal(d.journal.head_hash, hb[0].hash);
    const { rows: n } = await db.query("select user_id, text, data from bl.notifications where kind = 'summary.morning' and data->>'day' = '2026-11-04'");
    t.diagnostic(`уведомления: ${n.length}; «${n[0]?.text}»`);
    assert.deepEqual(n.map((x) => x.user_id).sort(), [OWNER_ID, MANAGER_ID].sort());
    assert.ok(n.every((x) => x.text.includes(hb[0].hash) && x.data.head_hash === hb[0].hash));
  } finally {
    await db.query('rollback');
  }
  assert.deepEqual(errors, []);
  const { rows: left } = await db.query("select count(*)::int as n from bl.club_summaries where day >= '2026-11-04'");
  assert.equal(left[0].n, 0, 'откат: на стенде ничего не осталось');
});

test('содержимое сводки за сегодняшние рабочие сутки (ускоренные часы на завтра 10:00) сходится с базой', async (t) => {
  const withContext = async (_pool, { clubId, userId = null, actorType }, fn) => {
    await db.query('savepoint e2e_ctx');
    try {
      await db.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', $3, true)", [clubId ?? '', userId ?? '', actorType]);
      const r = await fn(db);
      await db.query('release savepoint e2e_ctx');
      return r;
    } catch (err) {
      await db.query('rollback to savepoint e2e_ctx');
      throw err;
    }
  };
  // Рабочие сутки «сегодня» по клубу начались в 06:00 Екатеринбурга (01:00 UTC).
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0));
  if (now < start) start.setUTCDate(start.getUTCDate() - 1);
  const day = local(start).slice(0, 10);
  const tomorrow10 = new Date(start.getTime() + 28 * 3600_000); // 06:00 + 28 ч = 10:00 следующего дня
  await db.query('begin');
  try {
    const { sent } = await tick({ pool: null, withContext, clock: { now: () => tomorrow10 }, log: { info() {}, warn() {}, error() {} } });
    assert.ok(sent.some((s) => s.club_id === CLUB_A && s.day === day), `сводка за ${day}`);
    const { rows } = await db.query("select data from bl.club_summaries where club_id = $1 and kind = 'morning' and day = $2", [CLUB_A, day]);
    const d = rows[0].data;
    const to = new Date(d.to);
    const { rows: pay } = await db.query(
      `select method, sum(case when capture then amount_kopecks else coalesce(captured_kopecks, 0) end)::bigint as s from bl.payments
        where club_id = $1 and status = 'succeeded' and provider <> 'balance' and confirmed_at >= $2 and confirmed_at < $3 group by method`,
      [CLUB_A, start, to],
    );
    const { rows: rf } = await db.query("select coalesce(sum(amount_kopecks), 0)::bigint as s from bl.refunds where club_id = $1 and status in ('succeeded', 'manual') and created_at >= $2 and created_at < $3", [CLUB_A, start, to]);
    const { rows: al } = await db.query('select level, count(*)::int as n from bl.alarms where club_id = $1 and raised_at >= $2 and raised_at < $3 group by level', [CLUB_A, start, to]);
    const { rows: man } = await db.query("select count(*)::int as n from bl.audit_log where club_id = $1 and action like 'manual.%' and created_at >= $2 and created_at < $3", [CLUB_A, start, to]);
    const mine = Object.fromEntries(pay.map((p) => [p.method, Number(p.s)]));
    t.diagnostic(`сутки ${day}: сводка ${JSON.stringify(d.revenue)}, игра ${d.play.sessions} сессий ${d.play.hours} ч ${d.play.utilization_percent} %, тревоги ${JSON.stringify(d.alarms)}, ручных ${d.manual_actions.count} (${JSON.stringify(d.manual_actions.by_action)})`);
    t.diagnostic(`база: платежи по способам ${JSON.stringify(mine)}, возвраты ${rf[0].s}, тревоги ${JSON.stringify(al)}, записей manual.* ${man[0].n}`);
    for (const m of ['sbp', 'card', 'cash', 'card_terminal']) assert.equal(d.revenue.by_method[m], mine[m] ?? 0, m);
    assert.equal(d.revenue.refunds_kopecks, Number(rf[0].s));
    assert.equal(d.revenue.net_kopecks, d.revenue.total_kopecks - d.revenue.refunds_kopecks);
    for (const r of al) assert.equal(d.alarms[r.level], r.n, r.level);
    assert.ok(d.manual_actions.count >= man[0].n, 'все manual.* в сводке');
    // №125: действия системы — отдельно (automatic), не в «ручных».
    const { rows: sys } = await db.query(
      "select action, count(*)::int as n from bl.audit_log where club_id = $1 and created_at >= $2 and created_at < $3 and actor_type <> 'user' and action = 'payment.forfeited' group by action",
      [CLUB_A, start, to],
    );
    t.diagnostic(`автоматические в сводке: ${JSON.stringify(d.manual_actions.automatic)}; системных payment.forfeited в журнале ${sys[0]?.n ?? 0}`);
    assert.ok(d.manual_actions.automatic, 'есть раздел automatic');
    assert.equal(d.manual_actions.by_action['payment.forfeited'], undefined, 'сгорание брони не в ручных');
    if (sys.length) assert.equal(d.manual_actions.automatic.by_action['payment.forfeited'], sys[0].n);
  } finally {
    await db.query('rollback');
  }
});
