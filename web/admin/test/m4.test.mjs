import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  applyScore,
  canRefundEntry,
  cancelBody,
  cancelErrors,
  cancelRefund,
  champion,
  editBody,
  editErrors,
  entryPayWord,
  entryRefundErrors,
  extendBody,
  extendErrors,
  liveMatches,
  seedBracket,
  seedOrder,
  tournamentActions,
  tournamentBody,
  tournamentErrors,
} from '../src/lib/tournaments.js';
import { manualDetail } from '../src/lib/shift.js';
import { errorMessage } from '@billiardum/shared/errors';
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
  // Д2: матчи отменённого турнира (canceled) — не в «Сейчас играют»
  assert.equal(liveMatches({ rounds: [{ title: 'Финал', matches: [{ a: { nick: 'x' }, b: { nick: 'y' }, status: 'canceled' }] }] }).length, 0);
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
  assert.ok(canceled.refunded >= 1, 'до старта — возврат всем оплатившим (№138), ответ { refunded }');
  assert.equal((await req(b, 'GET', `/api/clubs/c/tournaments/${paidOne.id}`)).body.status, 'canceled');
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
  assert.match(v.text, /погаснет в 21:30 — предел окна турнира/);
  assert.match(alarmView({ ...over, data: { ...over.data, limit_by: 'match' } }, { timeZone: TZ, now: Date.parse(until) - 60_000 }).text, /погаснет в 21:30 — предел матча/);
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

const TID = 'd4000000-0000-4000-8000-000000000003';
const running = (over = {}) => ({
  id: TID,
  status: 'running',
  fee_kopecks: 50000,
  ends_at: new Date(T + 2 * 3600000).toISOString(),
  starts_at: new Date(T - 3600000).toISOString(),
  match_minutes: 90,
  places: 8,
  entries_count: 3,
  title: 'Вечерний пул',
  prize_text: '',
  entries: [
    { entry_id: 'e1', nick: 'А', status: 'confirmed', paid: true, paid_kopecks: 50000, refund_status: 'none' },
    { entry_id: 'e2', nick: 'Б', status: 'confirmed', paid: true, paid_kopecks: 50000, refund_status: 'pending' },
    { entry_id: 'e3', nick: 'В', status: 'confirmed', paid: false, paid_kopecks: 0, refund_status: 'none' },
  ],
  ...over,
});

test('№149: отмена — до старта возврат всем, после старта без возврата; «вернуть всем» только по аварии', () => {
  const t = running();
  assert.deepEqual(cancelRefund(t), { players: 0, kopecks: 0 }, 'после старта по умолчанию — никому');
  assert.deepEqual(cancelRefund(t, { refundAll: true }), { players: 1, kopecks: 50000 }, 'уже возвращаемый взнос не считаем');
  assert.deepEqual(cancelRefund({ ...t, status: 'registration' }), { players: 1, kopecks: 50000 });

  assert.deepEqual(cancelBody({ started: false, reason: ' Мало игроков ' }), { reason: 'Мало игроков' });
  assert.deepEqual(cancelBody({ started: true, reason: 'Не успеваем' }), { reason: 'Не успеваем', refund: 'none' });
  assert.deepEqual(cancelBody({ started: true, reason: 'Свет отключили', refundAll: true, reasonCode: 'venue' }), { reason: 'Свет отключили', refund: 'all', reason_code: 'venue' });

  assert.deepEqual(cancelErrors({ started: true, reason: 'Не успеваем' }), {});
  assert.ok(cancelErrors({ started: true, reason: '' }).reason, 'причина обязательна всегда');
  assert.ok(cancelErrors({ started: true, reason: 'Ок, болеет', refundAll: true, reasonCode: 'health' }).reason_code, 'здоровье — не основание вернуть всем');
  assert.ok(cancelErrors({ started: true, reason: '', refundAll: true, reasonCode: 'equipment' }).reason, 'комментарий обязателен');
  assert.deepEqual(cancelErrors({ started: true, reason: 'Сломался стол', refundAll: true, reasonCode: 'equipment' }), {});
});

test('№149: возврат одному игроку — кому можно, причина из списка и комментарий, оплата словом', () => {
  const t = running();
  assert.equal(canRefundEntry(t, t.entries[0]), true);
  assert.equal(canRefundEntry(t, t.entries[1]), false, 'возврат уже оформляется');
  assert.equal(canRefundEntry(t, t.entries[2]), false, 'не платил');
  assert.equal(canRefundEntry({ ...t, status: 'registration' }, t.entries[0]), false, 'до старта — правила №138');
  assert.ok(entryRefundErrors({ reasonCode: 'personal', comment: 'Уезжает' }).reason_code);
  assert.ok(entryRefundErrors({ reasonCode: 'health', comment: '' }).comment);
  assert.deepEqual(entryRefundErrors({ reasonCode: 'health', comment: 'Травма руки' }), {});
  assert.equal(entryPayWord(t, t.entries[0]).word, 'оплачен');
  assert.equal(entryPayWord(t, t.entries[1]).word, 'возврат оформляется');
  assert.equal(entryPayWord(t, { ...t.entries[1], refund_status: 'done' }).word, 'взнос возвращён');
  assert.equal(entryPayWord(t, t.entries[2]).word, 'ждём оплату');
  assert.equal(entryPayWord({ fee_kopecks: 0 }, { paid: false }).word, 'бесплатно');
});

test('№147: продление и правка после старта — причина, пределы, время не уходит в PATCH', () => {
  const t = running();
  const later = new Date(T + 3 * 3600000).toISOString();
  assert.deepEqual(extendErrors({ ends_at: later, match_minutes: '90', reason: 'Затянулись' }, t, T), {});
  assert.ok(extendErrors({ ends_at: later, match_minutes: '90', reason: '' }, t, T).reason);
  assert.ok(extendErrors({ ends_at: new Date(T - 60000).toISOString(), match_minutes: '90', reason: 'Да' + 'ааа' }, t, T).ends_at);
  assert.ok(extendErrors({ ends_at: new Date(T + 13 * 3600000).toISOString(), match_minutes: '90', reason: 'Затянулись' }, t, T).ends_at, 'не дальше +12 ч');
  assert.ok(extendErrors({ ends_at: later, match_minutes: '300', reason: 'Затянулись' }, t, T).match_minutes);
  assert.ok(extendErrors({ ends_at: t.ends_at, match_minutes: '90', reason: 'Затянулись' }, t, T).ends_at, 'ничего не меняется');
  assert.deepEqual(extendBody({ ends_at: later, match_minutes: '90', reason: ' Затянулись ' }, t), { reason: 'Затянулись', ends_at: later });
  assert.deepEqual(extendBody({ ends_at: t.ends_at, match_minutes: '120', reason: 'Финал' }, t), { reason: 'Финал', match_minutes: 120 });

  assert.equal(tournamentActions(t).extend, true);
  assert.equal(tournamentActions({ ...t, status: 'closed' }).extend, false);
  const f = { title: 'Вечерний пул — финал', prize_text: 'Кий', places: '8', starts_at: t.starts_at, ends_at: later };
  assert.deepEqual(editBody(f, t), { title: 'Вечерний пул — финал', prize_text: 'Кий' }, 'после старта время в PATCH не уходит');
  assert.deepEqual(editErrors(f, t), {});
  const before = { ...t, status: 'registration' };
  assert.deepEqual(editBody(f, before), { title: 'Вечерний пул — финал', prize_text: 'Кий', ends_at: later });
  assert.ok(editErrors({ ...f, places: '2' }, before).places, 'мест не меньше записавшихся');
});

test('коды после старта: tournament_started, not_paid, already_refunded, limit_exceeded с extend_limit_until', () => {
  for (const code of ['tournament_started', 'not_paid', 'already_refunded']) {
    const m = errorMessage(code, { audience: 'staff' });
    assert.notEqual(m.code, 'unknown');
    assert.match(m.title, /[А-ЯЁ].*\.$/u, code);
    assert.doesNotMatch(m.text, /\b[a-z_]{4,}\b/, code);
  }
  assert.match(errorMessage('tournament_started', { audience: 'staff' }).action, /Продлить турнир/);
  assert.equal(errorMessage('limit_exceeded', { audience: 'staff', limitUntil: '03:30' }).title, 'Так далеко продлить нельзя: не позже 03:30.');
  assert.equal(errorMessage('limit_exceeded', { audience: 'guest', limitUntil: '03:30' }).title, 'Больше продлить нельзя.', 'у гостя — прежний текст');
});

test('тревоги №147–149: продление, возврат, отмена без возврата и с аварией; имя сотрудника вместо «в журнале»', () => {
  const ext = { type: 'manual_action', data: { action: 'manual.tournament_extend', tournament_id: TID, staff_name: 'Ольга Р.', reason: 'Затянулись', before: 'до 22:00, матч 60 мин', after: 'до 23:30, матч 60 мин' } };
  const v = alarmView(ext);
  assert.equal(v.title, 'Турнир продлён');
  assert.match(v.text, /Было: до 22:00, матч 60 мин; стало: до 23:30, матч 60 мин\. Причина: «Затянулись»\. Продлил: Ольга Р\./);
  assert.deepEqual(alarmLink(ext), { screen: 'tournaments', id: TID, title: 'Открыть турнир' });

  const ref = { type: 'manual_action', data: { action: 'manual.tournament_refund', tournament_id: TID, scope: 'entry', reason_code: 'health', staff_name: 'Андрей', reason: 'Травма', amount_kopecks: 50000 } };
  assert.match(alarmView(ref).title, /^Возврат взноса 500\s₽$/u);
  assert.match(alarmView(ref).text, /возвращается игроку\. Основание: здоровье игрока\. Комментарий: «Травма»\. Вернул: Андрей\./);
  assert.match(alarmView({ ...ref, data: { ...ref.data, nick: 'Свояк' } }).text, /игроку Свояк/);
  assert.equal(alarmLink(ref).screen, 'tournaments');

  const none = { type: 'manual_action', data: { action: 'tournament_cancel', tournament_id: TID, refund: 'none', refunds: 0, amount_kopecks: 0, staff_name: 'Ольга Р.', reason: 'Не успеваем' } };
  assert.equal(alarmView(none).title, 'Турнир отменён после старта');
  assert.match(alarmView(none).text, /Взносы не возвращаются/);
  assert.match(alarmView(none).text, /Отменил: Ольга Р\./);
  const all = { type: 'manual_action', data: { action: 'tournament_cancel', tournament_id: TID, refund: 'all', reason_code: 'venue', refunds: 3, amount_kopecks: 150000, staff_name: 'Ольга Р.', reason: 'Отключили свет' } };
  assert.match(alarmView(all).text, /возвращаются 3 игрокам, всего 1\s500\s₽\. Основание: авария в клубе/u);
  assert.match(alarmView({ type: 'manual_action', data: { action: 'tournament_cancel', tournament_id: TID, refund: 'all', refunds: 1 } }).text, /1 игроку\. Кто отменил и причина — в журнале/);

  const score = { type: 'manual_action', data: { action: 'manual.tournament_score', tournament_id: TID, staff_name: 'Ольга Р.', before: '2:1', after: '3:2' } };
  assert.match(alarmView(score).text, /Исправил: Ольга Р\./);
  assert.doesNotMatch(alarmView(score).text, /в журнале/);
  const resolve = { type: 'manual_action', data: { action: 'plus.match_resolve', result: 'a', staff_name: 'Андрей' } };
  assert.match(alarmView(resolve).text, /Решил: Андрей\./);
  assert.match(alarmView({ type: 'manual_action', data: { action: 'plus.match_resolve', result: 'a' } }).text, /Кто решил — в журнале/, 'старые тревоги без имени');
  for (const a of ['manual.tournament_extend', 'manual.tournament_refund']) {
    assert.ok(ACTION_LABEL[a], a);
    assert.ok(MANUAL_ACTIONS.has(a), a);
  }
});

test('отчёт смены: было → стало словами, основание возврата и переход к турниру', () => {
  const TZ = 'Asia/Yekaterinburg';
  const ext = manualDetail({ action: 'manual.tournament_extend', data: { tournament_id: TID, before: { ends_at: '2026-10-23T17:00:00Z', match_minutes: 60 }, after: { ends_at: '2026-10-23T18:30:00Z', match_minutes: 90 } } }, TZ);
  assert.deepEqual(ext, { change: 'было до 22:00, матч 60 мин → стало до 23:30, матч 90 мин', note: null, tournamentId: TID });
  assert.equal(manualDetail({ action: 'manual.tournament_score', data: { tournament_id: TID, before: 'спор', after: '3:1' } }, TZ).change, 'было спор → стало 3:1');
  assert.equal(manualDetail({ action: 'manual.tournament_refund', data: { tournament_id: TID, scope: 'entry', reason_code: 'health' } }, TZ).note, 'одному игроку · здоровье игрока');
  assert.equal(manualDetail({ action: 'manual.tournament_refund', data: { scope: 'all', reason_code: 'venue', refunds: 5 } }, TZ).note, 'всем: 5 игроков · авария в клубе (свет, помещение)');
  assert.equal(manualDetail({ action: 'plus.match_resolve', data: { before: '8:6', after: 'отменён' } }, TZ).tournamentId, null);
  assert.equal(manualDetail({ action: 'manual.tournament_score', data: { tournament_id: '../x' } }, TZ).tournamentId, null, 'только UUID');
  assert.deepEqual(manualDetail({ action: 'service.start' }, TZ), { change: null, note: null, tournamentId: null });
});

test('заглушка №147–149: PATCH времени после старта, продление с пределом, возврат одному, отмена без возврата', async () => {
  const b = createBackend(memory(), () => T);
  b.scenario('manager');
  const base = '/api/clubs/c/tournaments';
  const t = (await req(b, 'GET', `${base}/${TID}`)).body;
  assert.equal(t.status, 'running');
  assert.equal((await req(b, 'PATCH', `${base}/${TID}`, { ends_at: new Date(T + 9 * 3600000).toISOString() })).body.error, 'tournament_started');
  assert.equal((await req(b, 'PATCH', `${base}/${TID}`, { title: 'Вечерний пул — финал' })).body.title, 'Вечерний пул — финал');

  assert.equal((await req(b, 'POST', `${base}/${TID}/extend`, { ends_at: new Date(T + 5 * 3600000).toISOString() })).body.error, 'reason_required');
  const far = await req(b, 'POST', `${base}/${TID}/extend`, { ends_at: new Date(T + 13 * 3600000).toISOString(), reason: 'Затянулись' });
  assert.equal(far.status, 409);
  assert.equal(far.body.error, 'limit_exceeded');
  assert.equal(far.body.extend_limit_until, new Date(T + 12 * 3600000).toISOString());
  const ext = (await req(b, 'POST', `${base}/${TID}/extend`, { ends_at: new Date(T + 5 * 3600000).toISOString(), reason: 'Затянулись' })).body;
  assert.equal(ext.ends_at, new Date(T + 5 * 3600000).toISOString());
  const alarms = () => req(b, 'GET', '/api/clubs/c/alarms').then((r) => r.body);
  const extA = (await alarms()).find((a) => a.data?.action === 'manual.tournament_extend');
  assert.equal(extA.data.staff_name, 'Ольга Р.');
  assert.match(alarmView(extA).text, /стало: до /);

  const paid = ext.entries.find((e) => e.paid);
  const url = `${base}/${TID}/entries/${paid.entry_id}/refund`;
  assert.equal((await req(b, 'POST', url, { reason_code: 'personal', comment: 'Уезжает' })).body.error, 'bad_request');
  assert.equal((await req(b, 'POST', url, { reason_code: 'health', comment: '' })).body.error, 'reason_required');
  const r = (await req(b, 'POST', url, { reason_code: 'health', comment: 'Травма руки' })).body;
  assert.deepEqual(r, { entry_id: paid.entry_id, refund_status: 'pending', reason_code: 'health', amount_kopecks: 50000 });
  assert.equal((await req(b, 'POST', url, { reason_code: 'health', comment: 'Ещё раз' })).body.error, 'already_refunded');
  const unpaid = ext.entries.find((e) => !e.paid);
  if (unpaid) assert.equal((await req(b, 'POST', `${base}/${TID}/entries/${unpaid.entry_id}/refund`, { reason_code: 'venue', comment: 'Свет' })).body.error, 'not_paid');
  const pre = (await req(b, 'GET', base)).body.items.find((x) => x.status === 'registration');
  assert.equal((await req(b, 'POST', `${base}/${pre.id}/entries/${pre.entries[0].entry_id}/refund`, { reason_code: 'health', comment: 'Травма' })).body.error, 'bad_status');

  assert.equal((await req(b, 'POST', `${base}/${TID}/cancel`, { reason: 'Болеет', refund: 'all', reason_code: 'health' })).body.error, 'bad_request', 'вернуть всем — только авария');
  const c = (await req(b, 'POST', `${base}/${TID}/cancel`, { reason: 'Не успеваем', refund: 'none' })).body;
  assert.deepEqual(c, { refunded: 0 });
  const cancelA = (await alarms()).find((a) => a.data?.action === 'tournament_cancel');
  assert.equal(cancelA.data.refund, 'none');
  assert.match(alarmView(cancelA).text, /не возвращаются/);
});
