// №147: свет турнирного матча без счёта продлевается только в playing и не дальше меньшего из двух
// пределов: ends_at + match_minutes и начало матча + 2 × match_minutes. Упёрся — одна тревога
// tournament_match_overdue с limit_by, затем свет гаснет сам (инвариант 4). Два бесплатных турнира
// по пулу на 2 игрока, match_minutes 10:
//   A (стол E2E_OVERDUE_TABLE, 6): окно 1 минута → предел ends_at + 10 мин (limit_by tournament),
//     ждём, пока свет погаснет без счёта (~14 минут), затем счёт — турнир завершён;
//   B (стол E2E_OVERDUE_TABLE_B, 7): окно 60 минут → предел начало матча + 20 мин (limit_by match),
//     проверяем удержание и тревогу (~6 минут), затем счёт.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { adminClient, api, brief2, CLUB_A, ensureFree, MIN, newGuest, ok, plusProfile, RES, sim, sleep, staff, waitFor, waitSim } from './helpers.mjs';

const TABLE_A = Number(process.env.E2E_OVERDUE_TABLE || 6);
const TABLE_B = Number(process.env.E2E_OVERDUE_TABLE_B || 7);
let db;
let man;
const made = [];

before(async () => {
  db = await adminClient();
  man = await staff('manager');
  await ensureFree(TABLE_A);
  await ensureFree(TABLE_B);
});

after(async () => {
  for (const c of made) if (!c.done) await api('POST', `/api/clubs/${CLUB_A}/tournaments/${c.id}/cancel`, { token: man.token, body: { reason: 'e2e: уборка' } });
  await db?.end();
});

/** Турнир на 2 игрока, старт сразу; → { id, matchId, t0, endsAt, p, q } */
async function setup(table, windowMin, title) {
  const startsAt = new Date(Math.ceil((Date.now() + 65_000) / 1000) * 1000);
  const endsAt = new Date(startsAt.getTime() + windowMin * MIN);
  const r = await api('POST', `/api/clubs/${CLUB_A}/tournaments`, {
    token: man.token,
    body: { title, discipline: 'pool', format: 'single_elim', race_to: 1, fee_kopecks: 0, places: 2, match_minutes: 10, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), resource_ids: [RES(table)], publish: true },
  });
  assert.equal(r.status, 201, brief2(r));
  const c = { id: r.json.id, endsAt };
  made.push(c);
  c.p = await newGuest();
  c.q = await newGuest();
  for (const g of [c.p, c.q]) {
    await plusProfile(g);
    const e = await ok(api('POST', `/api/tournaments/${c.id}/entries`, { token: g.token, body: {}, idem: true }), 201);
    assert.equal(e.status, 'confirmed', 'бесплатный турнир — запись сразу');
  }
  const st = await ok(api('POST', `/api/clubs/${CLUB_A}/tournaments/${c.id}/start`, { token: man.token, body: {} }));
  assert.equal(st.status, 'running');
  const { rows } = await db.query('select id, started_at from bl.tournament_matches where tournament_id = $1 and entry_a is not null and entry_b is not null', [c.id]);
  c.matchId = rows[0].id;
  c.t0 = new Date(rows[0].started_at).getTime();
  await waitSim(table, (x) => x.state?.relay === true, { what: `свет матча на столе ${table}` });
  return c;
}

async function waitLimit(c, limit, timeoutMs) {
  const ext = await waitFor(
    async () => {
      const { rows } = await db.query('select hold_until from bl.tournament_matches where id = $1', [c.matchId]);
      return new Date(rows[0].hold_until).getTime() === limit ? rows[0] : null;
    },
    { timeoutMs, intervalMs: 2000, what: 'удержание дошло до предела' },
  );
  const alarm = await waitFor(
    async () => {
      const { rows } = await db.query("select type, level, count, data from bl.alarms where club_id = $1 and type = 'tournament_match_overdue' and data->>'match_id' = $2", [CLUB_A, c.matchId]);
      return rows[0] ?? null;
    },
    { timeoutMs: 60_000, intervalMs: 1000, what: 'тревога tournament_match_overdue' },
  );
  return { ext, alarm };
}

async function finish(c) {
  await ok(api('POST', `/api/tournaments/matches/${c.matchId}/score`, { token: c.p.token, body: { score_a: 1, score_b: 0 } }));
  const me = await ok(api('GET', `/api/tournaments/${c.id}/me`, { token: c.q.token }));
  const conf = await api('POST', `/api/tournaments/matches/${c.matchId}/confirm`, { token: c.q.token, body: { score_a: me.match?.score_a ?? 1, score_b: me.match?.score_b ?? 0 } });
  const fin = await waitFor(
    async () => {
      const x = await api('GET', `/api/clubs/${CLUB_A}/tournaments/${c.id}`, { token: man.token });
      return x.json?.status === 'finished' ? x.json : null;
    },
    { timeoutMs: 20_000, intervalMs: 500, what: 'турнир завершён' },
  ).catch(() => null);
  c.done = Boolean(fin);
  return { conf, fin };
}

test('A: окно 1 минута — предел ends_at + match_minutes (limit_by tournament), свет гаснет сам без счёта', { timeout: 22 * MIN }, async (t) => {
  const c = await setup(TABLE_A, 1, 'E2E Затянулся A');
  const limit = c.endsAt.getTime() + 10 * MIN;
  const { ext, alarm } = await waitLimit(c, limit, 90_000);
  const s1 = await sim(TABLE_A);
  t.diagnostic(`ends_at ${c.endsAt.toISOString()}, начало матча ${new Date(c.t0).toISOString()}; удержание → ${new Date(ext.hold_until).toISOString()} (= ends_at + 10 мин < начало + 20 мин); тревога ${alarm.type}/${alarm.level} limit_by=${alarm.data.limit_by}; симулятор remaining ${Math.round(s1.state.remaining_ms / 1000)} с`);
  assert.equal(alarm.data.limit_by, 'tournament');
  await sleep(Math.max(0, limit - Date.now()) + 20_000);
  const s2 = await waitSim(TABLE_A, (x) => x.state?.relay === false, { timeoutMs: 4 * MIN, intervalMs: 2000, what: 'свет погас на пределе' });
  const offAfter = Math.round((Date.now() - limit) / 1000);
  const { rows: al } = await db.query("select count(*)::int as n from bl.alarms where club_id = $1 and type = 'tournament_match_overdue' and data->>'match_id' = $2", [CLUB_A, c.matchId]);
  const { rows: m2 } = await db.query('select status from bl.tournament_matches where id = $1', [c.matchId]);
  const { rows: s } = await db.query('select status, close_reason, paid_until, ended_at from bl.sessions where match_id = $1', [c.matchId]);
  const { conf, fin } = await finish(c);
  const relay = (await sim(TABLE_A)).state.relay;
  t.diagnostic(`свет погас через ≤${offAfter} с после предела (sim ${s2.state.mode}; сессия ${s[0]?.status}/${s[0]?.close_reason}, paid_until ${s[0]?.paid_until?.toISOString?.()}, ended_at ${s[0]?.ended_at?.toISOString?.()}); матч ${m2[0].status}; тревог по матчу ${al[0].n}; счёт после — ${conf.status} ${conf.json?.status ?? conf.json?.error}, турнир ${fin?.status}; свет relay=${relay}`);
  assert.equal(al[0].n, 1, 'одна тревога на матч');
  assert.equal(relay, false);
});

test('B: окно 60 минут — предел начало матча + 2 × match_minutes (limit_by match)', { timeout: 12 * MIN }, async (t) => {
  const c = await setup(TABLE_B, 60, 'E2E Затянулся B');
  const limit = c.t0 + 20 * MIN;
  const { ext, alarm } = await waitLimit(c, limit, 8 * MIN);
  const s1 = await sim(TABLE_B);
  const { rows: ex } = await db.query("select count(*)::int as n from bl.audit_log where action = 'session.extend' and data->>'match_id' = $1", [c.matchId]);
  // Продление турнира не сдвигает предел «от начала матча».
  const { conf, fin } = await finish(c);
  t.diagnostic(`начало матча ${new Date(c.t0).toISOString()}, ends_at ${c.endsAt.toISOString()}; удержание → ${new Date(ext.hold_until).toISOString()} (= начало + 20 мин < ends_at + 10 мин); продлений ${ex[0].n}; тревога ${alarm.type}/${alarm.level} limit_by=${alarm.data.limit_by}; симулятор remaining ${Math.round(s1.state.remaining_ms / 1000)} с; счёт — ${conf.status}, турнир ${fin?.status}`);
  assert.equal(alarm.data.limit_by, 'match');
});
