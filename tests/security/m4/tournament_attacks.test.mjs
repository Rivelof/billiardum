// PoC M4: турниры — счёт игроков, исправление организатора, взносы (инварианты 7, 8; №138, №146).
//
// НАХОДКА M4-3 (низкая): подтверждение счёта без сверки с тем, что видел подтверждающий.
// POST /api/tournaments/matches/{id}/confirm (server/tournaments/service.mjs, confirm ~стр. 1222–1232)
// берёт ТЕКУЩИЙ счёт соперника из базы; тело запроса не читается. Соперник может переписать свой
// счёт (report, ~стр. 1178: повторный report в pending_confirm разрешён) между тем, как второй игрок
// увидел «соперник внёс 1:2», и нажатием «Подтвердить» — второй подтверждает чужую победу.
//
// Выдержало (тесты ниже): чужой матч — 404; свой счёт сам себе не подтвердить; исправление счёта —
// только owner/manager своего клуба, с причиной, в журнал manual.tournament_score, владельцу
// уведомление; запись без оплаты не участвует (не в публичном списке, снимается к старту);
// повторная оплата — один возврат лишнего платежа; отмена записи — возврат; оплата после старта — возврат.
//
// Запуск: DATABASE_ADMIN_URL=… node --test --test-concurrency=1 tests/security/m4/tournament_attacks.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CLUB_A, CLUB_B, MIN, player, setup, STAFF, table } from '../../../server/tournaments/test/db/harness.mjs';

let h;
let phoneN = 900;
const nextPhone = () => player((phoneN += 1));

before(async () => {
  h = await setup();
});
after(async () => {
  await h?.close();
});

function times(offsetMin = 60, lenMin = 240) {
  const base = h.clock.now().getTime();
  return { starts_at: new Date(base + offsetMin * MIN).toISOString(), ends_at: new Date(base + (offsetMin + lenMin) * MIN).toISOString() };
}

/** Турнир на двоих (пул, столы 7–8), запущен, матч идёт. */
async function liveMatch(extra = {}) {
  const manager = await h.login(STAFF.manager);
  const t = await h.createTournament({ discipline: 'pool', fee_kopecks: 0, places: 2, race_to: 2, resource_ids: [table(7), table(8)], ...times(), ...extra });
  const ps = await h.enroll(t.id, [
    { phone: nextPhone(), rating: 1300, nick: `Игрок${phoneN}a` },
    { phone: nextPhone(), rating: 1250, nick: `Игрок${phoneN}b` },
  ]);
  const s = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
  assert.equal(s.status, 200, s.text);
  await h.flush();
  const m = (await h.matches(t.id)).find((x) => !x.bye);
  const a = ps.find((p) => p.user.id === m.user_a);
  const b = ps.find((p) => p.user.id === m.user_b);
  return { t, m, a, b, manager };
}

// M4-3 закрыто в ef78f68; нужна база. Регресс — тесты backend server/tournaments/test/db/tournaments.test.mjs,
// server/plus/test/db/matches.test.mjs и server/test/db/m4-core.test.mjs (test:db): «Подтвердить» с увиденным
// счётом, иначе 409 score_changed.
test.skip('НАХОДКА M4-3 (низкая): соперник меняет счёт между просмотром и «Подтвердить» — подтверждается не тот счёт', async () => {
  const { t, m, a, b } = await liveMatch();
  // A вносит «проиграл 1:2» — B видит в приложении, что соперник признал поражение.
  let r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 1, score_b: 2 } });
  assert.equal(r.status, 200, r.text);
  const seen = await h.request('GET', `/api/tournaments/${t.id}/me`, { token: b.user.token });
  assert.deepEqual([seen.json.match.opponent_report.score_a, seen.json.match.opponent_report.score_b], [1, 2], 'B видит 1:2 в свою пользу');
  // A тут же переписывает свой счёт на «выиграл 2:1» (повторный report в pending_confirm разрешён).
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 2, score_b: 1 } });
  assert.equal(r.status, 200, r.text);
  // B нажимает «Подтвердить» — и передаёт даже то, что видел; сервер тело не читает.
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.user.token, body: { score_a: 1, score_b: 2 } });
  assert.equal(r.status, 200, r.text);
  const done = (await h.matches(t.id)).find((x) => x.id === m.id);
  console.log(`  итог: ${done.status} ${done.score_a}:${done.score_b}, победитель — ${done.winner_entry_id === m.entry_a ? 'A' : 'B'}, источник ${done.result_source}`);
  assert.equal(done.status, 'done');
  assert.equal(done.winner_entry_id, m.entry_a, 'победил A — хотя B подтверждал 1:2 в свою пользу');
  assert.equal(done.result_source, 'players', 'как согласованный обоими, без спора и без организатора');
});

test('выдержало: чужой матч — 404, свой счёт себе не подтвердить, после «сыгран» счёт игрок не меняет', async () => {
  const { m, a, b } = await liveMatch();
  const stranger = await h.login(nextPhone());
  let r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: stranger.token, body: { score_a: 2, score_b: 0 } });
  assert.equal(r.status, 404, `чужой: ${r.text}`);
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: stranger.token });
  assert.equal(r.status, 404);
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 2, score_b: 0 } });
  assert.equal(r.status, 200);
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: a.user.token });
  assert.equal(r.status, 409, 'себе не подтвердить');
  assert.equal(r.json.error, 'nothing_to_confirm');
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 7, score_b: 0 } });
  assert.equal(r.status, 409, 'счёт вне race_to');
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.user.token });
  assert.equal(r.status, 200);
  r = await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: b.user.token, body: { score_a: 0, score_b: 2 } });
  assert.equal(r.status, 409, 'сыгранный матч игрок не переписывает');
});

test('выдержало: исправление счёта — только owner/manager своего клуба, с причиной; журнал manual.*, владельцу уведомление', async () => {
  const { t, m, a, b } = await liveMatch();
  await h.request('POST', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 2, score_b: 1 } });
  await h.request('POST', `/api/tournaments/matches/${m.id}/confirm`, { token: b.user.token });
  const reception = await h.login(STAFF.reception);
  const ownerB = await h.login(STAFF.ownerB);
  const manager = await h.login(STAFF.manager);
  const owner = await h.login(STAFF.owner);
  let r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: reception.token, body: { score_a: 0, score_b: 2, reason: 'касса' } });
  assert.equal(r.status, 403, `ресепшн: ${r.text}`);
  r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: ownerB.token, body: { score_a: 0, score_b: 2, reason: 'чужой клуб' } });
  assert.ok([403, 404].includes(r.status), `владелец клуба B: ${r.status}`);
  r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: a.user.token, body: { score_a: 2, score_b: 0, reason: 'я игрок' } });
  assert.equal(r.status, 403, 'игрок');
  r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 0, score_b: 2 } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'reason_required');
  r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 0, score_b: 2, reason: '   ' } });
  assert.equal(r.json.error, 'reason_required');
  r = await h.request('PATCH', `/api/tournaments/matches/${m.id}/score`, { token: manager.token, body: { score_a: 1, score_b: 2, reason: 'видео матча' } });
  assert.equal(r.status, 200, r.text);
  const au = (await h.audit('manual.tournament_score')).filter((x) => x.object_id === m.id);
  assert.equal(au.length, 1);
  assert.equal(au[0].reason, 'видео матча');
  assert.equal(au[0].actor_id, manager.id);
  const n = await h.notifications(owner.id, 'tournament.score_corrected');
  assert.ok(n.length >= 1, 'владельцу ушло уведомление');
  console.log(`  уведомление владельцу: level=${n.at(-1).level} (тревоги manual_action нет — только уведомление)`);
  void t;
});

test('выдержало: деньги взноса — запись без оплаты не играет, двойная оплата — один возврат лишнего, отмена — возврат, оплата после старта — возврат', async () => {
  const manager = await h.login(STAFF.manager);
  const t = await h.createTournament({ discipline: 'pool', fee_kopecks: 50_000, places: 4, race_to: 2, resource_ids: [table(7), table(8)], ...times(120, 240) });
  // 1. Без оплаты: pending_payment, в публичной сетке нет.
  const u1 = await h.login(nextPhone(), { rating: 1200, nick: `Взнос${phoneN}` });
  let r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u1.token, key: randomUUID(), body: {} });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.status, 'pending_payment');
  const e1 = r.json.entry_id;
  const pub = await h.request('GET', `/api/public/tournaments/${t.id}`);
  assert.equal(pub.json.entries.length, 0, 'неоплаченный не участник');
  // Повтор записи тем же игроком (другой ключ) — та же запись, не вторая.
  r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: u1.token, key: randomUUID(), body: {} });
  assert.equal(r.json.entry_id, e1);
  // 2. Две оплаты одной записи: вторая — возврат 'duplicate' этим платежом, один раз даже при повторе события.
  const p1 = await h.pay(e1, { paymentId: randomUUID() });
  const p2 = randomUUID();
  await h.pay(e1, { paymentId: p2 });
  await h.pay(e1, { paymentId: p2 });
  const tp = await h.q('select payment_id, outcome from bl.tournament_payments where entry_id = $1 order by created_at', [e1]);
  assert.deepEqual(tp.map((x) => x.outcome).sort(), ['applied', 'refunded']);
  const dup = h.calls.money.filter((c) => c.fn === 'refund' && c.args.paymentId === p2);
  assert.equal(dup.length, 1, 'лишний платёж вернули один раз');
  assert.equal(h.calls.money.filter((c) => c.fn === 'refundTournamentFee' && c.args.entryId === e1).length, 0, 'основной взнос не тронут');
  void p1;
  // 3. Отмена до закрытия записи — взнос назад (одно событие возврата).
  r = await h.request('DELETE', `/api/tournaments/${t.id}/entries/me`, { token: u1.token });
  assert.equal(r.status, 200);
  assert.equal(r.json.refund, true);
  r = await h.request('DELETE', `/api/tournaments/${t.id}/entries/me`, { token: u1.token });
  assert.equal(r.status, 404, 'второй раз отменить нечего');
  await h.drain();
  assert.equal(h.calls.money.filter((c) => c.fn === 'refundTournamentFee' && c.args.entryId === e1).length, 1);
  // 4. Оплата после старта — возврат 'late'.
  const late = await h.login(nextPhone(), { rating: 1200, nick: `Поздний${phoneN}` });
  r = await h.request('POST', `/api/tournaments/${t.id}/entries`, { token: late.token, key: randomUUID(), body: {} });
  const eLate = r.json.entry_id;
  await h.enroll(t.id, [{ phone: nextPhone(), rating: 1200, nick: `Пара${phoneN}a` }, { phone: nextPhone(), rating: 1200, nick: `Пара${phoneN}b` }]);
  r = await h.request('POST', `/api/clubs/${CLUB_A}/tournaments/${t.id}/start`, { token: manager.token });
  assert.equal(r.status, 200, r.text);
  await h.pay(eLate, { paymentId: randomUUID() });
  const el = await h.entry(eLate);
  assert.equal(el.status, 'canceled');
  const refunds = h.calls.money.filter((c) => (c.fn === 'refundTournamentFee' && c.args.entryId === eLate));
  assert.equal(refunds.length, 1, 'поздняя оплата возвращена');
  void CLUB_B;
});
