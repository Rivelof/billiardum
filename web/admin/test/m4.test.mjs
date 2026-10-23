import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, applyScore, cancelRefund, champion, liveMatches, seedBracket, seedOrder, tournamentActions, tournamentBody, tournamentErrors } from '../src/lib/tournaments.js';
import { ratingSummary, openCount, needsReason } from '../src/lib/platform.js';
import { createBackend } from '../src/mock/backend.js';

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
