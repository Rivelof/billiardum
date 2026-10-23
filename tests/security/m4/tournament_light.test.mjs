// PoC M4: свет и столы турнира (инварианты 1 и 4, решения №143, №146).
//
// НАХОДКА M4-2 (средняя): матч турнира держит стол и бесплатный свет без верхнего предела.
// Планировщик турнира (server/tournaments/service.mjs, step, ~стр. 1468–1478) продлевает удержание и
// игру матча (light.extendFromTournament) каждый тик, пока матч в LIVE = playing | pending_confirm |
// disputed, — без предела по ends_at турнира и без тревоги. Два участника (взнос 0 ₽ или любой)
// получают стол со светом на сутки и дольше: достаточно не вносить счёт или внести его одному
// (pending_confirm — игра уже кончилась) или разойтись в счёте (disputed — ждёт организатора).
// Неоплаченная игра продолжается (инвариант 4), стол закрыт для QR и броней (№146).
//
// Выдержало: свет матча включает только сервер (light.startFromTournament по удержанию матча),
// игроки и персонал напрямую не продлевают (маршрута нет).
//
// Запуск: DATABASE_ADMIN_URL=postgres://supabase_admin:…@127.0.0.1:55470/postgres \
//   node --test --test-concurrency=1 tests/security/m4/tournament_light.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CLUB_A, MIN, player, setup, STAFF, table } from '../../../server/tournaments/test/db/harness.mjs';

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

async function runningMatch({ suffix }) {
  const manager = await h.login(STAFF.manager);
  const base = h.clock.now().getTime();
  const at = (min) => new Date(base + min * MIN).toISOString();
  const t = await h.createTournament({
    title: `Ночной кубок ${suffix}`,
    discipline: 'pool',
    fee_kopecks: 0,
    places: 2,
    race_to: 2,
    starts_at: at(60),
    ends_at: at(60 + 120),
    resource_ids: [table(suffix === 'a' ? 7 : 8)],
  });
  const players = await h.enroll(t.id, [
    { phone: player(suffix === 'a' ? 701 : 801), rating: 1300, nick: `Ночь${suffix}1` },
    { phone: player(suffix === 'a' ? 702 : 802), rating: 1250, nick: `Ночь${suffix}2` },
  ]);
  // Организатор запускает турнир по расписанию.
  h.clock.set(Date.parse(at(60)));
  const s = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
  assert.equal(s.status, 200, s.text);
  await h.flush();
  const [m] = (await h.matches(t.id)).filter((x) => !x.bye);
  assert.equal(m.status, 'playing', 'стол выдан, свет по команде турнира');
  return { t, m, players, endsAt: Date.parse(at(60 + 120)) };
}

/** Тики планировщика каждые stepMin минут до момента untilMs (как таймер 15 с, но реже). */
async function runTicks(untilMs, stepMin = 5) {
  for (;;) {
    const next = h.clock.now().getTime() + stepMin * MIN;
    if (next > untilMs) break;
    h.clock.set(next);
    await h.tick();
  }
  await h.flush();
}

// M4-2 закрыто в ef78f68; нужна база. Регресс — тесты backend server/tournaments/test/db/tournaments.test.mjs
// и server/test/light/m4.test.mjs (test:db): один внёс счёт — продлений нет, через 5 мин свет гаснет;
// без счёта — не дальше конца турнира + матч, одна тревога tournament_match_overdue.
test.skip('НАХОДКА M4-2 (средняя): один игрок внёс счёт, второй молчит — стол и свет бесплатно продлеваются сутками после конца турнира', async () => {
  const { t, m, players, endsAt } = await runningMatch({ suffix: 'a' });
  const [a] = players;
  const side = m.user_a === a.user.id ? { score_a: 2, score_b: 0 } : { score_a: 0, score_b: 2 };
  // Игрок A сыграл и внёс счёт: матч pending_confirm — игры уже нет, но стол в LIVE.
  const r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: side });
  assert.equal(r.status, 200, r.text);
  const before = h.calls.light.filter((c) => c.fn === 'extendFromTournament').length;

  // Сутки и 6 часов после конца турнира по расписанию.
  await runTicks(endsAt + 30 * 60 * MIN);

  const [mm] = (await h.matches(t.id)).filter((x) => x.id === m.id);
  const ext = h.calls.light.filter((c) => c.fn === 'extendFromTournament' && c.args.matchId === m.id).slice(before);
  const last = ext.at(-1);
  console.log(`  матч: ${mm.status}; продлений после счёта: ${ext.length}; удержание до ${mm.hold_until.toISOString()} (конец турнира ${new Date(endsAt).toISOString()})`);
  assert.equal(mm.status, 'pending_confirm');
  assert.ok(ext.length > 50, 'свет продлевается каждые несколько тиков');
  assert.ok(Date.parse(last.args.until) > endsAt + 29 * 60 * MIN, 'удержание и игра — через сутки после конца турнира');
  assert.ok(mm.hold_until.getTime() > endsAt + 29 * 60 * MIN);
  assert.equal(h.calls.light.filter((c) => c.fn === 'stopFromTournament' && c.args.matchId === m.id).length, 0, 'свет не гасится');
  const alarms = await h.q("select type from bl.alarms where club_id = $1 and data->>'match_id' = $2", [CLUB_A, m.id]);
  assert.equal(alarms.length, 0, 'тревоги о затянувшемся матче нет — организатор не узнаёт');
});

// M4-2 закрыто в ef78f68; нужна база. Регресс — тесты backend server/tournaments/test/db/tournaments.test.mjs
// и server/test/light/m4.test.mjs (test:db): спор не даёт продлевать свет за предел №147.
test.skip('НАХОДКА M4-2 (средняя): разный счёт (disputed) — стол со светом ждёт организатора без предела', async () => {
  const { t, m, players, endsAt } = await runningMatch({ suffix: 'b' });
  const [a, b] = players;
  const aWins = m.user_a === a.user.id ? { score_a: 2, score_b: 1 } : { score_a: 1, score_b: 2 };
  const bWins = m.user_a === b.user.id ? { score_a: 2, score_b: 1 } : { score_a: 1, score_b: 2 };
  assert.equal((await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: aWins })).status, 200);
  assert.equal((await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: b.user.token, body: bWins })).status, 200);
  assert.equal((await h.matches(t.id)).find((x) => x.id === m.id).status, 'disputed');
  await runTicks(endsAt + 12 * 60 * MIN);
  const mm = (await h.matches(t.id)).find((x) => x.id === m.id);
  console.log(`  disputed: удержание до ${mm.hold_until.toISOString()}, конец турнира ${new Date(endsAt).toISOString()}`);
  assert.equal(mm.status, 'disputed');
  assert.ok(mm.hold_until.getTime() > endsAt + 11 * 60 * MIN, 'спор, а стол горит и закрыт для QR через 11 часов после конца турнира');
});

test('выдержало: свет матча включает только сервер по удержанию турнира; у игрока нет маршрута продлить или включить', async () => {
  const startCalls = h.calls.light.filter((c) => c.fn === 'startFromTournament');
  assert.ok(startCalls.length >= 2);
  for (const c of startCalls) assert.equal(c.args.system, true, 'старт света — системой турнира, не клиентом');
  const guest = await h.login(player(799));
  for (const path of [`/api/tournaments/matches/${randomUUID()}/extend`, `/api/tournaments/matches/${randomUUID()}/start`]) {
    const r = await h.request('POST', path, { token: guest.token, body: {} });
    assert.equal(r.status, 404, `${path}: ${r.status}`);
  }
});
