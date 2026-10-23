import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, applyScore, cancelRefund, champion, liveMatches, seedBracket, seedOrder, tournamentActions, tournamentBody, tournamentErrors } from '../src/lib/tournaments.js';
import { ratingSummary, openCount, needsReason } from '../src/lib/platform.js';
import { createBackend } from '../src/mock/backend.js';
import { alarmHref, alarmLink, alarmView } from '../src/lib/alarms.js';
import { ACTION_LABEL, MANUAL_ACTIONS } from '../src/lib/audit.js';

const T = Date.parse('2026-10-23T12:00:00Z');
const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });

test('посев олимпийской системы: 1 — с последним, сильнейшие встречаются в финале; проходы у сильнейших', () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  const players = ['A', 'B', 'C', 'D', 'E', 'F'].map((nick, i) => ({ nick, rating: 1800 - i * 50 }));
  const br = seedBracket(players, { tables: [6, 7] });
  assert.deepEqual(br.rounds.map((r) => r.title), ['1/4', 'Полуфинал', 'Финал']);
  const first = br.rounds[0].matches;
  assert.equal(first[0].a.nick, 'A');
  assert.equal(first[0].b, null, 'у первого посева свободный проход');
  assert.equal(first[0].status, 'done');
  assert.equal(br.rounds[1].matches[0].a.nick, 'A', 'проход — сразу в полуфинал');
  const done = applyScore(br, first[1].id, 3, 1);
  assert.equal(done.rounds[1].matches[0].b.nick, first[1].a.nick);
  assert.equal(champion(done), null);
  assert.equal(liveMatches({ rounds: [{ title: 'Финал', matches: [{ a: { nick: 'x' }, b: { nick: 'y' }, status: 'playing' }] }] }).length, 1);
  assert.ok(advance(br).rounds.length === 3);
});

test('форма турнира: ошибки по полям, тело — копейками; действия по статусу; возврат при отмене', () => {
  const good = { title: 'Кубок', discipline: 'pyramid', format: 'single_elim', race_to: '3', rating_limit: '', fee_rub: '500', places: '16', starts_at: new Date(T + 86400000).toISOString(), ends_at: new Date(T + 90000000).toISOString(), resource_ids: ['r1'] };
  assert.deepEqual(tournamentErrors(good, T), {});
  const bad = tournamentErrors({ ...good, title: '', race_to: '0', rating_limit: '50', places: '2', resource_ids: [], ends_at: good.starts_at }, T);
  for (const k of ['title', 'race_to', 'rating_limit', 'places', 'resource_ids', 'ends_at']) assert.ok(bad[k], k);
  const body = tournamentBody(good);
  assert.equal(body.fee_kopecks, 50000);
  assert.equal(body.rating_limit, null);
  assert.equal(tournamentBody({ ...good, rating_limit: '1400' }).rating_limit, 1400);
  assert.equal(tournamentActions({ status: 'registration', entries_count: 1 }).start, false);
  assert.equal(tournamentActions({ status: 'closed', entries_count: 4 }).start, true);
  assert.equal(tournamentActions({ status: 'finished' }).cancel, false);
  assert.deepEqual(cancelRefund({ fee_kopecks: 50000, entries: [{ paid: true }, { paid: false }, { paid: true }] }), { players: 2, kopecks: 100000 });
});

test('карточка, отзывы и оператор: сводка оценок, открытые записи, причина для отказа', () => {
  assert.deepEqual(ratingSummary([{ rating: 5 }, { rating: 3 }, { rating: 4 }]), { avg: '4,0', value: 4, count: 3 });
  assert.equal(ratingSummary([]), null);
  assert.equal(openCount('requests', [{ status: 'operator' }, { status: 'closed' }]), 1);
  assert.equal(openCount('listings', [{ status: 'new' }, { status: 'approved' }]), 1);
  assert.equal(needsReason('hidden'), true);
  assert.equal(needsReason('approved'), false);
});

test('заглушка M4: турнир клуба — создание, старт с сеткой, исправление счёта с причиной, отмена с возвратом', async () => {
  const b = createBackend(memory(), () => T);
  b.scenario('manager');
  const list = (await req(b, 'GET', '/api/clubs/c/tournaments')).body.items;
  assert.ok(list.length >= 3);
  const open = list.find((t) => t.status === 'registration' && t.entries_count >= 2);
  const started = (await req(b, 'POST', `/api/clubs/c/tournaments/${open.id}/start`)).body;
  assert.equal(started.status, 'running');
  const m = started.bracket.rounds[0].matches.find((x) => x.a && x.b);
  assert.match(m.id, /:/, 'глобальный id матча');
  assert.equal((await req(b, 'PATCH', `/api/tournaments/matches/${encodeURIComponent(m.id)}/score`, { score_a: 4, score_b: 1 })).body.error, 'reason_required');
  const fixed = (await req(b, 'PATCH', `/api/tournaments/matches/${encodeURIComponent(m.id)}/score`, { score_a: 4, score_b: 1, reason: 'Проверили по видео' })).body;
  assert.equal(fixed.bracket.rounds[0].matches.find((x) => x.id === m.id).winner, 'a');
  const paidOne = list.find((t) => t.fee_kopecks && t.status === 'registration' && t.id !== open.id);
  const canceled = (await req(b, 'POST', `/api/clubs/c/tournaments/${paidOne.id}/cancel`, { reason: 'Мало участников' })).body;
  assert.equal(canceled.status, 'canceled');
  assert.ok(canceled.refunded >= 0);
  const pub = (await req(b, 'GET', `/api/public/tournaments/${open.id}`)).body;
  for (const e of pub.entries) assert.deepEqual(Object.keys(e).sort(), ['nick', 'rating', 'seed'], 'на ТВ — без ПДн');
  b.scenario('pos');
  assert.equal((await req(b, 'GET', '/api/clubs/c/tournaments')).body.error, 'forbidden');
});

test('заглушка M4: споры, отзывы, оператор платформы', async () => {
  const b = createBackend(memory(), () => T);
  b.scenario('manager');
  const d = (await req(b, 'GET', '/api/clubs/c/plus/disputes')).body.items[0];
  assert.equal((await req(b, 'POST', `/api/plus/matches/${d.id}/resolve`, { result: 'a' })).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', `/api/plus/matches/${d.id}/resolve`, { result: 'annul', reason: 'Не играли' })).body.status, 'resolved');
  const r = (await req(b, 'GET', '/api/clubs/c/reviews')).body.items.find((x) => !x.reply);
  assert.equal((await req(b, 'POST', `/api/reviews/${r.id}/reply`, { text: 'Спасибо!' })).body.reply.text, 'Спасибо!');
  assert.equal((await req(b, 'GET', '/api/platform/requests')).body.error, 'forbidden');
  b.scenario('operator');
  const me = (await req(b, 'GET', '/api/me')).body;
  assert.equal(me.user.platform_role, 'platform_operator');
  assert.deepEqual(me.clubs, []);
  const lst = (await req(b, 'GET', '/api/platform/listings')).body.items.find((x) => x.kind === 'claim');
  assert.equal(lst.status, 'new');
  assert.equal((await req(b, 'PATCH', `/api/platform/listings/${lst.id}`, { status: 'approved' })).body.status, 'approved');
  assert.equal((await req(b, 'PATCH', `/api/platform/listings/${lst.id}`, { status: 'rejected', reason: 'x' })).body.error, 'already_decided');
  const rep = (await req(b, 'GET', '/api/platform/reports')).body.items[0];
  assert.equal((await req(b, 'PATCH', `/api/platform/reports/${rep.id}`, { status: 'hidden' })).body.error, 'reason_required');
});

test('города оператора: новый город, 409 city_required при одобрении «Добавить клуб», одобрение с new_city', async () => {
  const { cityErrors, cityBody } = await import('../src/lib/platform.js');
  assert.ok(cityErrors({ name: 'Пермь', name_in: 'Пермь', timezone: 'Asia/Yekaterinburg' }).name_in);
  assert.deepEqual(cityErrors({ name: 'Пермь', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg' }), {});
  assert.deepEqual(cityBody({ name: ' Пермь ', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg', region: '', slug: 'perm' }, { create: true }), { name: 'Пермь', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg', slug: 'perm' });
  const b = createBackend(memory(), () => T);
  b.scenario('operator');
  const add = (await req(b, 'GET', '/api/platform/listings')).body.items.find((x) => x.kind === 'add');
  assert.equal((await req(b, 'PATCH', `/api/platform/listings/${add.id}`, { action: 'approve' })).body.error, 'city_required');
  const ok = await req(b, 'PATCH', `/api/platform/listings/${add.id}`, { action: 'approve', new_city: { name: 'Пермь', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg' } });
  assert.equal(ok.body.status, 'approved');
  assert.equal((await req(b, 'POST', '/api/platform/cities', { name: 'Пермь', name_in: 'в Перми', timezone: 'Asia/Yekaterinburg' })).body.error, 'duplicate');
  assert.ok((await req(b, 'GET', '/api/platform/cities')).body.items.some((c) => c.name === 'Пермь'));
});

test('тревоги M4 (№147): матч затянулся, исправление счёта и решение спора — текст, время клуба, переход', () => {
  const TZ = 'Asia/Yekaterinburg';
  const tid = 'd4000000-0000-4000-8000-000000000003';
  const until = '2026-10-23T16:30:00Z'; // 21:30 в Екатеринбурге
  const over = { type: 'tournament_match_overdue', level: 'important', resource_number: 6, data: { tournament_id: tid, match_id: 'm1', light_until: until } };
  const v = alarmView(over, { timeZone: TZ, now: Date.parse(until) - 60_000 });
  assert.equal(v.title, 'Матч турнира затянулся');
  assert.match(v.text, /погаснет в 21:30/);
  assert.match(v.text, /предел окна турнира/);
  assert.equal(v.level, 'important');
  assert.equal(v.table, 'Стол 6');
  assert.match(alarmView(over, { timeZone: TZ, now: Date.parse(until) + 60_000 }).text, /погас в 21:30/);
  assert.match(alarmView(over).text, /погаснет\. Решите с игроками/, 'без пояса — общий текст без времени');
  assert.deepEqual(alarmLink(over), { screen: 'tournaments', id: tid, title: 'Открыть турнир' });
  assert.equal(alarmHref(alarmLink(over), 'club-1'), `/club/c/club-1/tournaments/${tid}`);
  assert.equal(alarmHref(alarmLink(over)), `/club/tournaments/${tid}`);
  assert.equal(alarmLink({ ...over, data: { tournament_id: '../platform' } }), null, 'чужой вид идентификатора — без перехода');

  const score = { type: 'manual_action', level: 'important', data: { action: 'manual.tournament_score', tournament_id: tid, match_id: 'm1', staff_id: 'u1', reason: 'Внесли наоборот', before: 'спор', after: '1:3' } };
  const s = alarmView(score);
  assert.equal(s.title, 'Счёт матча турнира исправлен');
  assert.match(s.text, /Было: спор, стало: 1:3\. Причина: «Внесли наоборот»/);
  assert.equal(alarmLink(score).screen, 'tournaments');

  const resolve = { type: 'manual_action', level: 'important', data: { action: 'plus.match_resolve', match_id: 'm2', result: 'annul', reason: 'Не играли', staff_id: 'u1' } };
  assert.equal(alarmView(resolve).title, 'Спор по партии решён');
  assert.match(alarmView(resolve).text, /не засчитана\. Причина: «Не играли»/);
  assert.match(alarmView({ ...resolve, data: { ...resolve.data, result: 'a' } }).text, /Победитель партии назначен/);
  assert.deepEqual(alarmLink(resolve), { screen: 'disputes', id: null, title: 'Открыть споры по партиям' });
  assert.equal(alarmHref(alarmLink(resolve), 'club-1'), '/club/c/club-1/disputes');
  assert.equal(alarmHref(alarmLink(resolve)), '/club/plus/disputes');

  // Ручное действие без data.action — прежний общий текст, без перехода
  assert.equal(alarmView({ type: 'manual_action' }).title, 'Ручное действие персонала');
  assert.equal(alarmLink({ type: 'manual_action', data: {} }), null);
  // В журнале и отчёте смены — подписаны и считаются ручными
  for (const a of ['manual.tournament_score', 'plus.match_resolve']) {
    assert.ok(ACTION_LABEL[a], a);
    assert.ok(MANUAL_ACTIONS.has(a), a);
  }
});

test('заглушка M4: исправление счёта и решение спора поднимают manual_action; матч затянулся — в тревогах', async () => {
  const b = createBackend(memory(), () => T);
  b.scenario('owner');
  const alarms = () => req(b, 'GET', '/api/clubs/c/alarms').then((r) => r.body);
  const overdue = (await alarms()).find((a) => a.type === 'tournament_match_overdue');
  assert.ok(overdue && alarmLink(overdue), 'тревога «матч затянулся» с переходом к турниру');

  const t = (await req(b, 'GET', '/api/clubs/c/tournaments')).body.items.find((x) => x.status === 'running');
  const m = t.bracket.rounds[1].matches[0];
  await req(b, 'PATCH', `/api/tournaments/matches/${encodeURIComponent(m.id)}/score`, { score_a: 3, score_b: 2, reason: 'Проверили по видео' });
  const fixed = (await alarms()).find((a) => a.data?.action === 'manual.tournament_score' && a.data.reason === 'Проверили по видео');
  assert.equal(fixed.type, 'manual_action');
  assert.equal(fixed.data.tournament_id, t.id);
  assert.equal(fixed.data.after, '3:2');
  assert.match(alarmView(fixed).text, /стало: 3:2/);

  const d = (await req(b, 'GET', '/api/clubs/c/plus/disputes')).body.items[0];
  await req(b, 'POST', `/api/plus/matches/${d.id}/resolve`, { result: 'b', reason: 'Посмотрели запись' });
  const res = (await alarms()).find((a) => a.data?.action === 'plus.match_resolve');
  assert.equal(res.data.match_id, d.id);
  assert.equal(res.resource_number, d.table_number);
  assert.equal(alarmLink(res).screen, 'disputes');

  // Отчёт смены: обе строки — ручные (не система и не гость), подписаны словами
  const shifts = (await req(b, 'GET', '/api/clubs/c/shifts')).body.items;
  const reports = await Promise.all(shifts.map((x) => req(b, 'GET', `/api/shifts/${x.id}/report`).then((r) => r.body)));
  const rows = reports.flatMap((r) => r.manual_actions?.items ?? []);
  for (const a of ['manual.tournament_score', 'plus.match_resolve']) {
    const row = rows.find((x) => x.action === a);
    assert.ok(row, a);
    assert.ok(!['automatic', 'guest'].includes(row.kind), a);
    assert.ok(row.reason, a);
  }
});
