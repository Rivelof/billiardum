// Турниры на настоящей базе: создание, запись со взносом (T24), возвраты, посев и сетки, столы,
// счёт от игроков, спор и исправление организатора, публичная афиша и ТВ.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CLUB_A, MIN, player, setup, STAFF, table, waitFor } from './harness.mjs';

let h;
before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

const eight = (base) =>
  [1800, 1700, 1650, 1600, 1500, 1400, 1300, 1250].map((rating, i) => ({ phone: player(base + i), rating, nick: `Игрок${base + i}` }));

/** Сыграть матч: оба игрока вносят один счёт (победа стороны a, если aWins). */
async function play(m, users, aWins = true) {
  const ua = users.find((u) => u.id === m.user_a);
  const ub = users.find((u) => u.id === m.user_b);
  const [a, b] = aWins ? [2, 1] : [1, 2];
  const r1 = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: a, score_b: b } });
  assert.equal(r1.status, 200, r1.text);
  const r2 = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token });
  assert.equal(r2.status, 200, r2.text);
  assert.equal(r2.json.status, 'done');
  return r2.json;
}

describe('создание и публикация', () => {
  it('управляющий создаёт черновик; на сайте его нет; публикует — появляется', async () => {
    const t = await h.createTournament({ title: 'Черновик' }, { publish: false });
    assert.equal(t.status, 'draft');
    assert.equal(t.race_to, 2);
    assert.deepEqual(t.tables.map((x) => x.number), [1, 2, 3, 4]);
    let pub = await h.request('GET', `/api/public/tournaments/${t.id}`);
    assert.equal(pub.status, 404);
    const manager = await h.login(STAFF.manager);
    const p = await h.request('PATCH', `/api/clubs/${CLUB_A}/tournaments/${t.id}`, { token: manager.token, body: { status: 'registration' } });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.status, 'registration');
    pub = await h.request('GET', `/api/public/tournaments/${t.id}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(pub.json.club.name, 'Тестовый клуб');
    assert.equal(pub.json.fee_kopecks, 100_000);
    assert.deepEqual(pub.json.bracket.rounds, []);
    assert.equal((await h.audit('tournament.publish')).length, 1);
  });

  it('столы не той дисциплины и чужого клуба — 400; ресепшн не создаёт — 403', async () => {
    const manager = await h.login(STAFF.manager);
    const body = {
      title: 'Пул',
      discipline: 'pool',
      format: 'single_elim',
      race_to: 3,
      places: 8,
      starts_at: h.at(2000),
      ends_at: h.at(2400),
      resource_ids: [table(1)],
    };
    let r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: manager.token, body });
    assert.equal(r.status, 400);
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: manager.token, body: { ...body, resource_ids: ['e2000000-0000-4000-8000-000000000001'] } });
    assert.equal(r.status, 400);
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: manager.token, body: { ...body, resource_ids: [table(6)] } });
    assert.equal(r.status, 201, r.text);
    const reception = await h.login(STAFF.reception);
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments`, { token: reception.token, body: { ...body, resource_ids: [table(7)] } });
    assert.equal(r.status, 403);
    r = await h.request('GET', `/api/clubs/${CLUB_A}/tournaments`, { token: reception.token });
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length >= 1);
  });
});

describe('запись (T24), взнос и возвраты', () => {
  it('рейтинг выше лимита — 409 rating_above_limit с лимитом и рейтингом, без платежа', async () => {
    const t = await h.createTournament({ title: 'До 1400', rating_limit: 1400 });
    const strong = await h.login(player(1), { rating: 1520, nick: 'Сильный' });
    const before = h.calls.money.length;
    const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: strong.token, key: randomUUID(), body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'rating_above_limit');
    assert.equal(r.json.limit, 1400);
    assert.equal(r.json.rating, 1520);
    assert.equal(h.calls.money.length, before);
    assert.equal((await h.q('select count(*)::int as n from bl.tournament_entries where tournament_id = $1', [t.id]))[0].n, 0);
    // Рейтинг в пределах — запись с оплатой.
    const ok = await h.login(player(2), { rating: 1390, nick: 'Норм' });
    const r2 = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: ok.token, key: randomUUID(), body: { return_url: '/app/tournaments' } });
    assert.equal(r2.status, 201, r2.text);
    assert.equal(r2.json.status, 'pending_payment');
    assert.match(r2.json.confirmation.url, /^https:\/\/yookassa\.test\//);
  });

  it('№150: без профиля Бильярдум+ (ника) — 409 no_profile, без записи и платежа; создал ник — запись проходит', async () => {
    const t = await h.createTournament({ title: 'Только с ником' });
    const u = await h.login(player(4), { rating: 1300, nick: null });
    const before = h.calls.money.length;
    const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: { return_url: '/app/x' } });
    assert.deepEqual([r.status, r.json], [409, { error: 'no_profile' }]);
    assert.equal(h.calls.money.length, before, 'платежа нет');
    assert.equal((await h.q('select count(*)::int as n from bl.tournament_entries where tournament_id = $1', [t.id]))[0].n, 0);
    h.nicks.set(u.id, 'СНиком');
    const ok = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: { return_url: '/app/x' } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await h.entry(ok.json.entry_id)).nick, 'СНиком');
  });

  it('взнос: платёж money вида tournament → payment.confirmed → запись подтверждена один раз', async () => {
    const t = await h.createTournament({ title: 'Взнос' });
    const u = await h.login(player(3), { rating: 1300, nick: 'Платит' });
    const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: { return_url: '/app/x' } });
    assert.equal(r.status, 201);
    const call = h.calls.money.at(-1);
    assert.equal(call.fn, 'createTournamentFee');
    assert.equal(call.args.clubId, CLUB_A);
    assert.equal(call.args.tournamentId, t.id);
    assert.equal(call.args.entryId, r.json.entry_id);
    assert.equal(call.args.amountKopecks, 100_000);
    assert.equal(call.args.returnUrl, '/app/x');
    assert.deepEqual(call.args.customer, { phone: player(3) });
    assert.equal(call.args.title, 'Взнос');
    let e = await h.entry(r.json.entry_id);
    assert.equal(e.status, 'pending_payment');
    const pid = await h.pay(e.id);
    e = await h.entry(e.id);
    assert.equal(e.status, 'confirmed');
    assert.equal(e.payment_id, pid);
    assert.equal(Number(e.paid_kopecks), 100_000);
    assert.equal((await h.tournament(t.id)).entries_count, 1);
    // Повтор события (доставка «хотя бы один раз») — ничего.
    await h.pay(e.id, { paymentId: pid });
    assert.equal((await h.tournament(t.id)).entries_count, 1);
    assert.equal((await h.q('select count(*)::int as n from bl.tournament_payments where entry_id = $1', [e.id]))[0].n, 1);
    // Повторная запись — 409.
    const again = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: {} });
    assert.equal(again.status, 409);
    assert.equal(again.json.error, 'already_registered');
    // Вторая оплата той же записи — возврат лишнего.
    // Только этот платёж: общий refund money с ключом trn-<payment_id>, основной взнос не трогается.
    const extra = await h.pay(e.id, { paymentId: randomUUID() });
    const refund = h.calls.money.filter((c) => c.fn === 'refund').at(-1);
    assert.equal(refund.args.paymentId, extra);
    assert.equal(refund.args.key, `trn-${extra}`);
    assert.equal(refund.args.amountKopecks, 100_000);
    assert.ok(!h.calls.money.some((c) => c.fn === 'refundTournamentFee' && c.args.entryId === e.id));
    assert.equal((await h.entry(e.id)).status, 'confirmed');
    const me = await h.request('GET', `/api/tournaments/${t.id}/me`, { token: u.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.entry.status, 'confirmed');
    assert.equal(me.json.match, null);
  });

  it('мест нет — 409 full; бесплатный турнир подтверждается сразу', async () => {
    const t = await h.createTournament({ title: 'Два места', places: 2, fee_kopecks: 0 });
    const [a, b, c] = [await h.login(player(10)), await h.login(player(11)), await h.login(player(12))];
    for (const u of [a, b]) {
      const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: {} });
      assert.equal(r.status, 201);
      assert.equal(r.json.status, 'confirmed');
      assert.equal(r.json.confirmation, null);
    }
    const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: c.token, key: randomUUID(), body: {} });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'full');
  });

  it('отмена игроком до закрытия записи — взнос целиком; после закрытия — 409 registration_closed', async () => {
    const t = await h.createTournament({ title: 'Отмена', registration_closes_at: h.at(60) });
    const [x] = await h.enroll(t.id, [{ phone: player(20), rating: 1300 }]);
    const r = await h.request('DELETE', `/api/tournaments/${t.id}/entries/me`, { token: x.user.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.refund, true);
    await h.drain();
    const refund = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').at(-1);
    assert.equal(refund.args.entryId, x.entry_id);
    assert.equal(refund.args.reasonCode, 'player');
    assert.match(refund.args.reason, /отменил запись/);
    const e = await h.entry(x.entry_id);
    assert.equal(e.status, 'canceled');
    assert.equal(e.refund_status, 'done');
    assert.equal((await h.tournament(t.id)).entries_count, 0);

    const [y] = await h.enroll(t.id, [{ phone: player(21), rating: 1300 }]);
    h.clock.add(61 * MIN);
    await h.tick();
    assert.equal((await h.tournament(t.id)).status, 'closed');
    const late = await h.request('DELETE', `/api/tournaments/${t.id}/entries/me`, { token: y.user.token });
    assert.equal(late.status, 409);
    assert.equal(late.json.error, 'registration_closed');
    const enroll = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: (await h.login(player(22))).token, key: randomUUID(), body: {} });
    assert.equal(enroll.json.error, 'registration_closed');
    h.clock.set(Date.parse(h.at(0)));
  });

  it('отмена турнира клубом — возврат всем оплатившим, журнал manual.tournament_cancel, тревога владельцу', async () => {
    const t = await h.createTournament({ title: 'Отменяемый' });
    const list = await h.enroll(t.id, [
      { phone: player(30), rating: 1300 },
      { phone: player(31), rating: 1310 },
    ]);
    // Третий записался, но не оплатил — возврата нет.
    const pend = await h.login(player(32));
    await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: pend.token, key: randomUUID(), body: {} });
    const manager = await h.login(STAFF.manager);
    let r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/cancel`, { token: manager.token, body: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'reason_required');
    const before = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').length;
    r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/cancel`, { token: manager.token, body: { reason: 'Не набрали участников' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { refunded: 2 });
    await h.drain();
    const refunds = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').slice(before);
    assert.deepEqual(refunds.map((c) => c.args.entryId).sort(), list.map((x) => x.entry_id).sort());
    assert.ok(refunds.every((c) => c.args.reasonCode === 'tournament_canceled' && c.args.reason === 'Турнир отменён клубом'));
    const [a] = await h.audit('manual.tournament_cancel');
    assert.equal(a.reason, 'Не набрали участников');
    const alarms = await h.q("select * from bl.alarms where type = 'manual_action' and data->>'tournament_id' = $1", [t.id]);
    assert.equal(alarms.length, 1);
    assert.equal((await h.tournament(t.id)).status, 'canceled');
  });

  it('оплата после отмены записи — автоматический возврат', async () => {
    const t = await h.createTournament({ title: 'Поздняя оплата' });
    const u = await h.login(player(40));
    const r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u.token, key: randomUUID(), body: {} });
    await h.request('DELETE', `/api/tournaments/${t.id}/entries/me`, { token: u.token });
    const pid = await h.pay(r.json.entry_id, { paymentId: randomUUID() });
    const refund = h.calls.money.filter((c) => c.fn === 'refundTournamentFee').at(-1);
    assert.equal(refund.args.paymentId, pid);
    const [p] = await h.q('select outcome from bl.tournament_payments where payment_id = $1', [pid]);
    assert.equal(p.outcome, 'refunded');
  });
});

describe('посев, сетка, столы', () => {
  it('8 игроков: посев по рейтингу, пары 1–8, 4–5, 2–7, 3–6, четыре матча на четырёх столах турнира', async () => {
    const t = await h.createTournament({ title: 'Восемь', fee_kopecks: 0 });
    // Порядок записи не совпадает с рейтингом.
    const people = eight(100).reverse();
    const list = await h.enroll(t.id, people);
    const users = list.map((x) => x.user);
    const manager = await h.login(STAFF.manager);
    const lightBefore = h.calls.light.length;
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'running');
    const seeds = r.json.entries.map((e) => [e.seed, e.rating]);
    assert.deepEqual(seeds.map((s) => s[1]), [1800, 1700, 1650, 1600, 1500, 1400, 1300, 1250]);
    const rounds = r.json.bracket.rounds;
    assert.deepEqual(rounds.map((x) => x.title), ['1/4 финала', 'Полуфинал', 'Финал']);
    assert.deepEqual(rounds[0].matches.map((m) => [m.a.seed, m.b.seed]), [
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ]);
    assert.ok(rounds[0].matches.every((m) => m.status === 'playing'));
    assert.deepEqual(rounds[0].matches.map((m) => m.table_number).sort(), [1, 2, 3, 4]);
    const lc = h.calls.light.slice(lightBefore);
    const holds = lc.filter((c) => c.fn === 'setReserved');
    assert.equal(holds.length, 4);
    assert.ok(holds.every((c) => c.args.source === 'tournament'));
    assert.deepEqual(holds.map((c) => c.args.refId).sort(), rounds[0].matches.map((m) => m.id).sort());
    assert.equal(lc.filter((c) => c.fn === 'startFromTournament' && c.args.system === true).length, 4);
    // Полуфиналы ждут.
    assert.ok(rounds[1].matches.every((m) => m.status === 'scheduled' && m.a === null));
    // Матч 1–8: оба вносят один счёт → полуфинал получает первого посева, стол освобождается.
    const ms = await h.matches(t.id);
    const m18 = ms.find((m) => m.round === 1 && m.position === 0);
    const done = await play(m18, users, true);
    assert.equal(done.winner, 'a');
    const fin = await h.outboxEvents('tournament.match_finished');
    const ev = fin.at(-1).payload;
    assert.equal(ev.match_id, m18.id);
    assert.equal(ev.tournament_id, t.id);
    assert.equal(ev.discipline, 'pyramid');
    assert.equal(ev.winner_id, m18.user_a);
    assert.equal(ev.loser_id, m18.user_b);
    assert.deepEqual(ev.score, { winner: 2, loser: 1 });
    assert.equal(ev.player_a, m18.user_a);
    assert.equal(ev.player_b, m18.user_b);
    assert.equal(ev.score_a, 2);
    assert.equal(ev.score_b, 1);
    assert.equal(ev.club_id, CLUB_A);
    assert.ok(ev.finished_at);
    assert.ok(h.calls.light.some((c) => c.fn === 'stopFromTournament' && c.args.matchId === m18.id));
    assert.ok(h.calls.light.some((c) => c.fn === 'clearReserved' && c.args.refId === m18.id && c.args.source === 'tournament'));
    const semi = (await h.matches(t.id)).find((m) => m.round === 2 && m.position === 0);
    assert.equal(semi.entry_a, m18.winner_entry_id ?? (await h.matches(t.id)).find((m) => m.id === m18.id).winner_entry_id);
    assert.equal(semi.status, 'waiting');
    // Доиграть турнир: всегда побеждает a.
    for (let guard = 0; guard < 10; guard += 1) {
      const live = (await h.matches(t.id)).filter((m) => m.status === 'playing');
      if (live.length === 0) break;
      for (const m of live) await play(m, users, true);
    }
    const tt = await h.tournament(t.id);
    assert.equal(tt.status, 'finished');
    const finished = await h.outboxEvents('tournament.finished');
    assert.equal(finished.at(-1).payload.tournament_id, t.id);
    assert.equal(finished.at(-1).payload.participants.length, 8);
    const pub = await h.request('GET', `/api/public/tournaments/${t.id}`);
    assert.equal(pub.json.status, 'finished');
    assert.equal(pub.json.bracket.winner.seed, 1);
  });

  it('6 игроков: bye у посевов 1 и 2, они сразу в полуфинале; матчей с игрой — два', async () => {
    const t = await h.createTournament({ title: 'Шесть', fee_kopecks: 0 });
    const list = await h.enroll(t.id, eight(200).slice(0, 6));
    const manager = await h.login(STAFF.manager);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    const [q1, semi] = r.json.bracket.rounds;
    assert.deepEqual(q1.matches.map((m) => [m.a?.seed ?? null, m.b?.seed ?? null, m.bye, m.status]), [
      [1, null, true, 'done'],
      [4, 5, false, 'playing'],
      [2, null, true, 'done'],
      [3, 6, false, 'playing'],
    ]);
    assert.deepEqual(semi.matches.map((m) => [m.a?.seed ?? null, m.b?.seed ?? null]), [
      [1, null],
      [2, null],
    ]);
    // За bye — ни рейтинга, ни света.
    const byes = (await h.matches(t.id)).filter((m) => m.bye);
    assert.equal(byes.length, 2);
    const fin = (await h.outboxEvents('tournament.match_finished')).map((e) => e.payload.match_id);
    assert.ok(byes.every((m) => !fin.includes(m.id)));
    assert.equal(list.length, 6);
  });

  it('группы 2×4 → плей-офф 4: змейка, круговая, A1–B2 и B1–A2 в полуфиналах', async () => {
    const t = await h.createTournament({ title: 'Группы', fee_kopecks: 0, format: 'groups_playoff', group_count: 2, advance_per_group: 2, resource_ids: [table(1), table(2), table(3), table(4), table(5)] });
    const list = await h.enroll(t.id, eight(300));
    const users = list.map((x) => x.user);
    const manager = await h.login(STAFF.manager);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    const rounds = r.json.bracket.rounds;
    assert.deepEqual(rounds.map((x) => x.title), ['Группа A', 'Группа B', 'Полуфинал', 'Финал']);
    assert.deepEqual(rounds[0].standings.map((s) => s.seed).sort((a, b) => a - b), [1, 4, 5, 8]);
    assert.deepEqual(rounds[1].standings.map((s) => s.seed).sort((a, b) => a - b), [2, 3, 6, 7]);
    assert.equal(rounds[0].matches.length, 6);
    assert.equal(rounds[1].matches.length, 6);
    // Пять столов, восемь игроков: одновременно не больше 4 матчей (игрок — в одном).
    let live = (await h.matches(t.id)).filter((m) => m.status === 'playing');
    assert.equal(live.length, 4);
    // Групповой этап: побеждает более высокий посев.
    const seedOf = new Map(r.json.entries.map((e) => [e.entry_id, e.seed]));
    for (let guard = 0; guard < 20; guard += 1) {
      live = (await h.matches(t.id)).filter((m) => m.status === 'playing' && m.stage === 'group');
      if (live.length === 0) break;
      for (const m of live) await play(m, users, seedOf.get(m.entry_a) < seedOf.get(m.entry_b));
    }
    const ms = await h.matches(t.id);
    assert.ok(ms.filter((m) => m.stage === 'group').every((m) => m.status === 'done'));
    const semis = ms.filter((m) => m.stage === 'playoff' && m.round === 1);
    // A1 = посев 1, B2 = посев 3; B1 = посев 2, A2 = посев 4.
    assert.deepEqual(semis.map((m) => [seedOf.get(m.entry_a), seedOf.get(m.entry_b)]), [
      [1, 3],
      [2, 4],
    ]);
    assert.ok(semis.every((m) => m.status === 'playing'));
    assert.equal((await h.audit('tournament.groups_done')).filter((a) => a.data.tournament_id === t.id).length, 1);
    for (const m of semis) await play(m, users, true);
    const final = (await h.matches(t.id)).find((m) => m.stage === 'playoff' && m.round === 2);
    await play(final, users, false);
    const tt = await h.tournament(t.id);
    assert.equal(tt.status, 'finished');
    assert.equal(seedOf.get(tt.winner_entry_id), 2);
  });

  it('стол занят чужой игрой — матч берёт другой стол; нет свободного — ждёт тика', async () => {
    const t = await h.createTournament({ title: 'Занятый стол', fee_kopecks: 0, resource_ids: [table(4), table(5)] });
    await h.enroll(t.id, eight(400).slice(0, 4));
    h.lightHooks.setReserved = (args) => (args.resourceId === table(4) ? { ok: true, applied: false, reason: 'busy' } : { ok: true, applied: true });
    const manager = await h.login(STAFF.manager);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200);
    let live = (await h.matches(t.id)).filter((m) => m.status === 'playing');
    assert.equal(live.length, 1);
    assert.equal(live[0].resource_id, table(5));
    h.lightHooks.setReserved = null;
    await h.tick();
    live = (await h.matches(t.id)).filter((m) => m.status === 'playing');
    assert.equal(live.length, 2);
  });

  it('свет не включился (контроллер не на связи) — матч на столе, повтор на тике', async () => {
    const t = await h.createTournament({ title: 'Офлайн', fee_kopecks: 0, resource_ids: [table(5)] });
    await h.enroll(t.id, eight(450).slice(0, 2));
    h.lightHooks.startFromTournament = () => {
      const e = new Error('offline');
      e.code = 'table_offline';
      e.status = 409;
      throw e;
    };
    const manager = await h.login(STAFF.manager);
    await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    let [m] = await h.matches(t.id);
    assert.equal(m.status, 'playing');
    assert.equal(m.session_id, null);
    h.lightHooks.startFromTournament = null;
    await h.tick();
    [m] = await h.matches(t.id);
    assert.ok(m.session_id);
  });

  it('tournamentHolds: окно турнира на его столах и удержания матчей', async () => {
    const t = await h.createTournament({ title: 'Удержания', fee_kopecks: 0, resource_ids: [table(3)], starts_at: h.at(3000), ends_at: h.at(3300) });
    const { tournamentHolds } = await import('../../api.mjs');
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      const list = await tournamentHolds(c, { resourceId: table(3), from: h.at(2900), to: h.at(3100) });
      const mine = list.filter((x) => x.tournament_id === t.id);
      assert.deepEqual(mine, [{ from: h.at(3000), to: h.at(3300), tournament_id: t.id }]);
      assert.deepEqual((await tournamentHolds(c, { resourceId: table(8), from: h.at(2900), to: h.at(3100) })).filter((x) => x.tournament_id === t.id), []);
      // Другой клуб в контексте — пусто.
      await c.query("select set_config('app.club_id', $1, true)", ['c2000000-0000-4000-8000-000000000002']);
      assert.deepEqual(await tournamentHolds(c, { resourceId: table(3), from: h.at(2900), to: h.at(3100) }), []);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('tournamentHolds (№146): опубликованный держит окно, черновик и отменённый — нет; идущий матч — своё удержание', async () => {
    const { tournamentHolds } = await import('../../api.mjs');
    const window = { starts_at: h.at(4000), ends_at: h.at(4300) };
    const draftT = await h.createTournament({ title: 'Черновик-удержание', fee_kopecks: 0, resource_ids: [table(2)], ...window }, { publish: false });
    const canceledT = await h.createTournament({ title: 'Отменённый', fee_kopecks: 0, resource_ids: [table(2)], ...window });
    const manager = await h.login(STAFF.manager);
    const c1 = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${canceledT.id}/cancel`, { token: manager.token, body: { reason: 'тест' } });
    assert.equal(c1.status, 200);
    // Идущий турнир с матчем на столе 2: окно турнира и удержание матча.
    const runT = await h.createTournament({ title: 'Идёт', fee_kopecks: 0, resource_ids: [table(2)], starts_at: h.at(30), ends_at: h.at(90) });
    await h.enroll(runT.id, eight(800).slice(0, 2));
    const st = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${runT.id}/start`, { token: manager.token });
    assert.equal(st.status, 200, st.text);
    const [m] = await h.matches(runT.id);
    assert.equal(m.resource_id, table(2));
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.actor_type', 'system', true)", [CLUB_A]);
      let ids = (await tournamentHolds(c, { resourceId: table(2), from: h.at(3900), to: h.at(4400) })).map((x) => x.tournament_id);
      assert.ok(!ids.includes(draftT.id), 'черновик не держит столы');
      assert.ok(!ids.includes(canceledT.id), 'отменённый не держит');
      // Опубликовали черновик — окно держит.
      await c.query("update bl.tournaments set status = 'registration' where id = $1", [draftT.id]);
      ids = (await tournamentHolds(c, { resourceId: table(2), from: h.at(3900), to: h.at(4400) })).map((x) => x.tournament_id);
      assert.ok(ids.includes(draftT.id), 'опубликованный держит столы');
      const now = await tournamentHolds(c, { resourceId: table(2), from: h.at(0), to: h.at(200) });
      const mine = now.filter((x) => x.tournament_id === runT.id);
      assert.deepEqual(mine.map((x) => x.match_id ?? null).sort(), [m.id, null].sort());
      assert.ok(mine.some((x) => x.from === h.at(30) && x.to === h.at(90) && !x.match_id));
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('затянувшийся матч: у конца удержания — light.extendFromTournament и новое hold_until', async () => {
    const t = await h.createTournament({ title: 'Долгий матч', fee_kopecks: 0, resource_ids: [table(5)], match_minutes: 60 });
    await h.enroll(t.id, eight(850).slice(0, 2));
    const manager = await h.login(STAFF.manager);
    await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    let [m] = await h.matches(t.id);
    assert.equal(m.status, 'playing');
    const start = h.clock.now().getTime();
    // За 30 минут до конца — рано продлевать.
    h.clock.add(30 * MIN);
    await h.tick();
    assert.ok(!h.calls.light.some((x) => x.fn === 'extendFromTournament' && x.args.matchId === m.id));
    // За 5 минут до конца — продление на половину match_minutes.
    h.clock.add(25 * MIN);
    await h.tick();
    const ext = h.calls.light.filter((x) => x.fn === 'extendFromTournament' && x.args.matchId === m.id);
    assert.equal(ext.length, 1);
    assert.equal(ext[0].args.resourceId, table(5));
    assert.equal(ext[0].args.until, new Date(start + 55 * MIN + 30 * MIN).toISOString());
    [m] = await h.matches(t.id);
    assert.equal(m.hold_until.toISOString(), ext[0].args.until);
    h.clock.set(Date.parse(h.at(0)));
  });
});

describe('счёт: спор и исправление организатора', () => {
  let t;
  let users;
  before(async () => {
    t = await h.createTournament({ title: 'Спорный', fee_kopecks: 0, resource_ids: [table(1), table(2)] });
    users = (await h.enroll(t.id, eight(500).slice(0, 4))).map((x) => x.user);
    const manager = await h.login(STAFF.manager);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200);
  });

  it('счёт не по правилам «до N» — 409 bad_score; чужой матч — 403', async () => {
    const [m] = (await h.matches(t.id)).filter((x) => x.round === 1);
    const ua = users.find((u) => u.id === m.user_a);
    let r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 3, score_b: 1 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'bad_score');
    const stranger = await h.login(player(999));
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: stranger.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 404);
    // Игрок другого матча того же турнира.
    const [, other] = (await h.matches(t.id)).filter((x) => x.round === 1);
    const uOther = users.find((u) => u.id === other.user_a);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: uOther.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 404);
  });

  it('расхождение — disputed и уведомление организатору; исправление с причиной — журнал и продвижение', async () => {
    const [m] = (await h.matches(t.id)).filter((x) => x.round === 1);
    const ua = users.find((u) => u.id === m.user_a);
    const ub = users.find((u) => u.id === m.user_b);
    let r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'pending_confirm');
    const toB = await h.notifications(ub.id, 'tournament.score');
    assert.equal(toB.length, 1);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ub.token, body: { score_a: 1, score_b: 2 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'disputed');
    const manager = await h.login(STAFF.manager);
    const owner = await h.login(STAFF.owner);
    assert.equal((await h.notifications(manager.id, 'tournament.dispute')).length, 1);
    assert.equal((await h.notifications(owner.id, 'tournament.dispute')).length, 1);
    assert.equal((await h.audit('tournament.dispute')).filter((a) => a.data.match_id === m.id).length, 1);
    // Ничего не ушло в рейтинг.
    assert.ok(!(await h.outboxEvents('tournament.match_finished')).some((e) => e.payload.match_id === m.id));
    // Ресепшн не исправляет; без причины — reason_required.
    const reception = await h.login(STAFF.reception);
    r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: reception.token, body: { score_a: 2, score_b: 1, reason: 'x' } });
    assert.equal(r.status, 403);
    r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'reason_required');
    // Чужой клуб — нет матча.
    const ownerB = await h.login(STAFF.ownerB);
    r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: ownerB.token, body: { score_a: 2, score_b: 1, reason: 'чужой' } });
    assert.equal(r.status, 404);
    r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 2, score_b: 1, reason: 'Смотрели видео: выиграл первый' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.result_source, 'organizer');
    const [a] = (await h.audit('manual.tournament_score')).filter((x) => x.data.match_id === m.id);
    assert.equal(a.reason, 'Смотрели видео: выиграл первый');
    assert.equal(a.actor_id, manager.id);
    assert.deepEqual(a.data.after, { score_a: 2, score_b: 1 });
    // M4-I5: исправление счёта — ручное действие: тревога manual_action владельцу с причиной, сотрудником и сутью.
    const [al] = await h.q("select * from bl.alarms where club_id = $1 and type = 'manual_action' and data->>'match_id' = $2", [CLUB_A, m.id]);
    assert.ok(al, 'тревога manual_action');
    assert.deepEqual([al.data.action, al.data.reason, al.data.staff_id, al.data.before, al.data.after], ['manual.tournament_score', 'Смотрели видео: выиграл первый', manager.id, 'спор', '2:1']);
    const toOwner = (await h.notifications(owner.id, 'alarm')).filter((n) => n.data.alarm_id === al.id);
    assert.equal(toOwner.length, 1, 'владелец узнал сразу');
    assert.match(toOwner[0].text, /счёт матча исправлен \(спор → 2:1\) — .+: Смотрели видео: выиграл первый/);
    const ev = (await h.outboxEvents('tournament.match_finished')).filter((e) => e.payload.match_id === m.id);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.winner_id, m.user_a);
    assert.equal(ev[0].payload.revision, 1);
    const final = (await h.matches(t.id)).find((x) => x.round === 2);
    assert.equal(final.user_a, m.user_a);
  });

  it('исправление после «сыгран» меняет победителя, пока следующий матч не начат; иначе — bracket_locked', async () => {
    const [m1, m2] = (await h.matches(t.id)).filter((x) => x.round === 1);
    const manager = await h.login(STAFF.manager);
    // m1 сыгран (см. выше), финал ждёт второго полуфинала — победителя m1 можно поменять.
    let r = await h.request('PATCH', `/api/tournaments/matches/${m1.id}/score`, { token: manager.token, body: { score_a: 0, score_b: 2, reason: 'Ошибка в протоколе' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.winner, 'b');
    let final = (await h.matches(t.id)).find((x) => x.round === 2);
    assert.equal(final.user_a, m1.user_b);
    const ev = (await h.outboxEvents('tournament.match_finished')).filter((e) => e.payload.match_id === m1.id).at(-1).payload;
    assert.equal(ev.revision, 2);
    assert.equal(ev.corrected, true);
    assert.equal(ev.winner_id, m1.user_b);
    // Второй полуфинал — подтверждение соперника.
    await play(m2, users, true);
    final = (await h.matches(t.id)).find((x) => x.round === 2);
    assert.equal(final.status, 'playing');
    r = await h.request('PATCH', `/api/tournaments/matches/${m1.id}/score`, { token: manager.token, body: { score_a: 2, score_b: 0, reason: 'Ещё раз' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'bracket_locked');
  });

  it('GET /api/tournaments/{id}/me — свой матч, сторона и стол', async () => {
    const final = (await h.matches(t.id)).find((x) => x.round === 2);
    const ua = users.find((u) => u.id === final.user_a);
    const r = await h.request('GET', `/api/tournaments/${t.id}/me`, { token: ua.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.entry.status, 'confirmed');
    assert.equal(r.json.match.id, final.id);
    assert.equal(r.json.match.side, 'a');
    assert.equal(r.json.match.status, 'playing');
    assert.equal(typeof r.json.match.table_number, 'number');
    assert.equal(r.json.match.i_confirmed, false);
  });
});

describe('публичная афиша и ТВ', () => {
  it('GET /api/public/tournaments — без входа, только ники, без user_id и телефонов', async () => {
    const t = await h.createTournament({ title: 'Публичный', fee_kopecks: 0 });
    const [, second] = await h.enroll(t.id, [
      { phone: player(600), rating: 1500, nick: 'Шар' },
      { phone: player(601), rating: 1400, nick: 'Второй' },
    ]);
    // Запись, сделанная до №150 без ника, показывается «Участник».
    await h.admin.query('update bl.tournament_entries set nick = null where id = $1', [second.entry_id]);
    await h.service().flush();
    const list = await h.request('GET', '/api/public/tournaments');
    assert.equal(list.status, 200);
    const item = list.json.items.find((x) => x.id === t.id);
    assert.ok(item);
    assert.equal(item.entries_count, 2);
    assert.equal(item.club.city, 'Екатеринбург');
    // Сайт строит ссылку на клуб и время по поясу клуба без отдельных запросов.
    assert.equal(item.club.timezone, 'Asia/Yekaterinburg');
    assert.equal(item.club.path, '/ekaterinburg/testovyy-klub/');
    assert.ok(!list.json.items.some((x) => x.status === 'draft'));
    const one = await h.request('GET', `/api/public/tournaments/${t.id}`);
    assert.deepEqual(one.json.club, { id: CLUB_A, name: 'Тестовый клуб', city: 'Екатеринбург', timezone: 'Asia/Yekaterinburg', path: '/ekaterinburg/testovyy-klub/' });
    assert.deepEqual(one.json.entries, [
      { nick: 'Шар', seed: null, rating: 1500 },
      { nick: 'Участник', seed: null, rating: 1400 },
    ]);
    const text = one.text + list.text;
    assert.ok(!/\+7999/.test(text), 'телефонов нет');
    const ids = await h.q('select user_id from bl.tournament_entries where tournament_id = $1', [t.id]);
    for (const { user_id: id } of ids) assert.ok(!text.includes(id), 'user_id нет');
    const byCity = await h.request('GET', '/api/public/tournaments?city=Владивосток');
    assert.ok(!byCity.json.items.some((x) => x.id === t.id));
    // Карточку клуба скрыли в каталоге — ссылки нет, афиша и пояс есть.
    await h.admin.query('update bl.club_public set visible = false where club_id = $1', [CLUB_A]);
    try {
      const t2 = await h.createTournament({ title: 'Без карточки', fee_kopecks: 0 });
      const r = await h.request('GET', `/api/public/tournaments/${t2.id}`);
      assert.equal(r.status, 200);
      assert.equal(r.json.club.path, null);
      assert.equal(r.json.club.timezone, 'Asia/Yekaterinburg');
    } finally {
      await h.admin.query('update bl.club_public set visible = true where club_id = $1', [CLUB_A]);
    }
  });

  it('ТВ: поток SSE tournament:{id} отдаёт сетку сразу и после каждого изменения', async () => {
    const t = await h.createTournament({ title: 'ТВ', fee_kopecks: 0, resource_ids: [table(1), table(2)] });
    const list = await h.enroll(t.id, eight(700).slice(0, 4));
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/public/tournaments/${t.id}/stream`, { signal: ac.signal, headers: { 'x-forwarded-for': '10.9.9.9' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    let buf = '';
    const events = [];
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /event: (\S+)/.exec(chunk)?.[1];
          const data = /data: (.*)/.exec(chunk)?.[1];
          if (ev) events.push({ ev, data: data ? JSON.parse(data) : null });
        }
      }
    })();
    await waitFor(() => events.some((e) => e.ev === 'bracket'));
    assert.deepEqual(events.find((e) => e.ev === 'bracket').data.rounds, []);
    const manager = await h.login(STAFF.manager);
    await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    await h.flush();
    await waitFor(() => events.some((e) => e.ev === 'bracket' && e.data.rounds.length > 0));
    const last = events.filter((e) => e.ev === 'bracket').at(-1).data;
    assert.deepEqual(last.rounds.map((r) => r.title), ['Полуфинал', 'Финал']);
    assert.ok(!JSON.stringify(last).includes(list[0].user.id));
    assert.ok(h.sseEvents.some((e) => e.channel === `club:${CLUB_A}` && e.event === 'tournament' && e.data.tournament_id === t.id));
    ac.abort();
    await pump;
  });
});

describe('№147 (M4-2, M4-3): свет матча ограничен, «Подтвердить» сверяет счёт', () => {
  /** Турнир на двоих, матч идёт; окно турнира: начало через 60 минут, длина lenMin. */
  async function liveMatch(tableN, base, { lenMin = 120, matchMinutes = 60 } = {}) {
    const manager = await h.login(STAFF.manager);
    const t0 = h.clock.now().getTime();
    const at = (min) => new Date(t0 + min * MIN).toISOString();
    const t = await h.createTournament({ title: `Окно ${base}`, discipline: 'pool', fee_kopecks: 0, places: 2, match_minutes: matchMinutes, resource_ids: [table(tableN)], starts_at: at(60), ends_at: at(60 + lenMin) });
    const ps = await h.enroll(t.id, eight(base).slice(0, 2));
    h.clock.set(t0 + 60 * MIN);
    const r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
    assert.equal(r.status, 200, r.text);
    const [m] = await h.matches(t.id);
    assert.equal(m.status, 'playing');
    const users = ps.map((p) => p.user);
    return { t, m, ua: users.find((u) => u.id === m.user_a), ub: users.find((u) => u.id === m.user_b), endsAt: t0 + (60 + lenMin) * MIN };
  }
  const calls = (fn, matchId) => h.calls.light.filter((c) => c.fn === fn && c.args.matchId === matchId);
  async function ticksUntil(ms, stepMin = 5) {
    while (h.clock.now().getTime() + stepMin * MIN <= ms) {
      h.clock.add(stepMin * MIN);
      await h.tick();
    }
  }

  it('один внёс счёт — продлений нет, через 5 минут свет гаснет (tournament_end) и стол свободен', async () => {
    const { t, m, ua, endsAt } = await liveMatch(6, 900);
    const r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 0 } });
    assert.equal(r.json.status, 'pending_confirm');
    const reportedAt = h.clock.now().getTime();
    h.clock.add(4 * MIN);
    await h.tick();
    assert.equal(calls('stopFromTournament', m.id).length, 0, 'доведение 5 минут');
    h.clock.set(reportedAt + 5 * MIN);
    await h.tick();
    const stop = calls('stopFromTournament', m.id);
    assert.equal(stop.length, 1, 'свет погашен');
    assert.deepEqual([stop[0].args.resourceId, stop[0].args.system], [table(6), true]);
    assert.ok(h.calls.light.some((c) => c.fn === 'clearReserved' && c.args.refId === m.id), 'удержание стола снято');
    let [mm] = await h.matches(t.id);
    assert.equal(mm.status, 'pending_confirm');
    assert.ok(mm.hold_until.getTime() <= h.clock.now().getTime(), 'стол больше не держится матчем');
    assert.equal((await h.audit('tournament.match_light_off')).filter((a) => a.data.match_id === m.id).length, 1);
    // Сутки после конца турнира: ни продлений, ни повторных команд.
    await ticksUntil(endsAt + 24 * 60 * MIN, 60);
    assert.equal(calls('extendFromTournament', m.id).length, 0, 'внесённый счёт не продлевается');
    assert.equal(calls('stopFromTournament', m.id).length, 1);
    [mm] = await h.matches(t.id);
    assert.ok(mm.hold_until.getTime() < endsAt);
  });

  it('разный счёт (спор) — свет гаснет так же; стол не ждёт организатора', async () => {
    const { t, m, ua, ub } = await liveMatch(6, 910);
    await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    h.clock.add(2 * MIN);
    const d = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ub.token, body: { score_a: 1, score_b: 2 } });
    assert.equal(d.json.status, 'disputed');
    h.clock.add(3 * MIN);
    await h.tick();
    assert.equal(calls('stopFromTournament', m.id).length, 1, '5 минут от первого счёта, а не от спора');
    const [mm] = await h.matches(t.id);
    assert.equal(mm.status, 'disputed');
    assert.ok(mm.hold_until.getTime() <= h.clock.now().getTime());
  });

  it('игра без счёта — продление не дальше конца турнира + время матча; тревога «матч затянулся» одна на матч', async () => {
    const { t, m, endsAt } = await liveMatch(6, 920, { lenMin: 60, matchMinutes: 60 });
    const limit = endsAt + 60 * MIN;
    await ticksUntil(endsAt + 30 * 60 * MIN);
    const ext = calls('extendFromTournament', m.id);
    assert.ok(ext.length >= 1 && ext.length <= 4, `продлений: ${ext.length}`);
    for (const e of ext) assert.ok(Date.parse(e.args.until) <= limit, 'не дальше предела');
    assert.equal(Date.parse(ext.at(-1).args.until), limit);
    const [mm] = await h.matches(t.id);
    assert.equal(mm.hold_until.getTime(), limit, 'удержание кончилось на пределе');
    const alarms = await h.q("select * from bl.alarms where club_id = $1 and type = 'tournament_match_overdue' and data->>'match_id' = $2", [CLUB_A, m.id]);
    assert.equal(alarms.length, 1);
    assert.equal(alarms[0].count, 1, 'склейка по матчу: одна тревога, без повторов на каждом тике');
    const owner = await h.login(STAFF.owner);
    const manager = await h.login(STAFF.manager);
    for (const u of [owner, manager]) {
      const n = (await h.notifications(u.id, 'alarm')).filter((x) => x.data.alarm_id === alarms[0].id);
      assert.equal(n.length, 1, 'организатор и владелец знают');
      assert.match(n[0].text, /затянулся — свет погаснет в \d{2}:\d{2}/);
    }
  });

  it('M4-3: соперник переписал счёт — «Подтвердить» с увиденным счётом 409 score_changed; с новым — сыгран', async () => {
    const { t, m, ua, ub } = await liveMatch(6, 930);
    let r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 1, score_b: 2 } });
    assert.equal(r.status, 200);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: ua.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 200, 'свой счёт до подтверждения переписать можно');
    const notes = await h.notifications(ub.id, 'tournament.score');
    assert.match(notes.at(-1).text, /соперник изменил счёт на 2:1/);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token, body: { score_a: 1, score_b: 2 } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'score_changed');
    let [mm] = await h.matches(t.id);
    assert.equal(mm.status, 'pending_confirm', 'ничего не подтверждено');
    assert.equal(mm.report_b, null);
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token, body: { score_a: 2 } });
    assert.equal(r.status, 400, 'счёт — оба числа');
    r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token, body: { score_a: 2, score_b: 1 } });
    assert.equal(r.status, 200, r.text);
    [mm] = await h.matches(t.id);
    assert.deepEqual([mm.status, mm.score_a, mm.score_b, mm.result_source], ['done', 2, 1, 'players']);
    // Повтор с тем же счётом — тот же ответ; с другим — score_changed.
    assert.equal((await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token, body: { score_a: 2, score_b: 1 } })).status, 200);
    assert.equal((await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: ub.token, body: { score_a: 1, score_b: 2 } })).json.error, 'score_changed');
    // Без тела — как раньше (старый клиент).
    const x = await liveMatch(6, 940);
    await h.request('POST', `/api/tournaments/matches/${x.m.id}/score`, { token: x.ua.token, body: { score_a: 2, score_b: 0 } });
    assert.equal((await h.request('POST', `/api/tournaments/matches/${x.m.id}/confirm`, { token: x.ub.token })).json.status, 'done');
  });

  it('M4-7: публичный поток и ТВ — только у опубликованного турнира, иначе 404', async () => {
    const t0 = h.clock.now().getTime();
    const draft = await h.createTournament(
      { title: 'Черновик потока', starts_at: new Date(t0 + 600 * MIN).toISOString(), ends_at: new Date(t0 + 900 * MIN).toISOString() },
      { publish: false },
    );
    for (const id of [draft.id, randomUUID()]) {
      assert.equal((await h.request('GET', `/api/public/tournaments/${id}/stream`)).status, 404, `ТВ ${id}`);
    }
  });
});
