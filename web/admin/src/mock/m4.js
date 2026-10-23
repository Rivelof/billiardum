/*
 * BL_MOCK_MARKER — заглушка M4 программы клуба только для разработки (VITE_MOCK=1): турниры клуба (создание, запись,
 * старт, сетка, исправление счёта с причиной, отмена с возвратом), ТВ-сетка (публичный турнир и событие bracket),
 * споры по партиям Бильярдум+, карточка клуба в агрегаторе и отзывы с ответами, экран оператора платформы.
 * Формы ответов — как в письме координатору (контракт M4 §4).
 *
 * Сценарии: manager/owner — турниры, споры, карточка; platform — владелец с ролью platform_admin;
 * operator — оператор платформы без клуба (platform_operator).
 */

import { applyScore, seedBracket } from '../lib/tournaments.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const uuid = () => globalThis.crypto.randomUUID();
const CLUB = { id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c', name: 'Клуб для разработки', city: 'Екатеринбург' };
const rid = (n) => `00000000-0000-4000-8000-00000000000${n}`;

const PLAYERS = [
  ['Свояк', 1834, 1500],
  ['Shark77', 1712, 1630],
  ['Ольга_8', 1405, 1180],
  ['Андрей_К', 1388, 1240],
  ['Кий_Мастер', 1352, 1210],
  ['Мария_С', 1290, 1455],
  ['Борт', 1201, 1199],
  ['Лузер_нет', 1150, 1100],
  ['Пятый_шар', 1265, 1302],
  ['Дуплет', 1477, 1390],
];

/** Состояние M4 при новом сценарии. */
export function m4State(scenario, t) {
  const empty = scenario === 'empty';
  const at = (days, h) => new Date(Math.floor((t + days * DAY) / (60 * MIN)) * 60 * MIN + h * 60 * MIN).toISOString();
  const entries = (n, discipline, paid = true) =>
    PLAYERS.slice(0, n).map(([nick, py, po], i) => ({ entry_id: uuid(), nick, rating: discipline === 'pool' ? po : py, seed: null, status: paid || i % 3 ? 'confirmed' : 'pending_payment', paid: paid || i % 3 !== 0 }));
  const live = entries(8, 'pool')
    .sort((x, y) => y.rating - x.rating)
    .map((e, i) => ({ ...e, seed: i + 1 }));
  let liveBracket = seedBracket(live, { tables: [6, 7, 8] });
  // Первый круг почти сыгран: три матча с результатом, один идёт на столе 6
  liveBracket = applyScore(liveBracket, 'r0m0', 3, 0);
  liveBracket = applyScore(liveBracket, 'r0m1', 1, 3);
  liveBracket = applyScore(liveBracket, 'r0m2', 3, 2);
  liveBracket.rounds[0].matches[3] = { ...liveBracket.rounds[0].matches[3], status: 'playing', score_a: 1, score_b: 1 };
  liveBracket.rounds[1].matches[0] = { ...liveBracket.rounds[1].matches[0], status: 'pending_confirm', table_number: 7, score_a: 2, score_b: 3 };
  const tournaments = empty
    ? []
    : [
        { id: 'd4000000-0000-4000-8000-000000000003', title: 'Вечерний пул', discipline: 'pool', format: 'single_elim', race_to: 3, rating_limit: null, fee_kopecks: 0, prize_text: '', places: 8, starts_at: new Date(t - 90 * MIN).toISOString(), ends_at: new Date(t + 4 * 60 * MIN).toISOString(), status: 'running', resource_ids: [rid(6), rid(7), rid(8)], entries: live, bracket: liveBracket },
        { id: 'd4000000-0000-4000-8000-000000000001', title: 'Кубок «Новичок»', discipline: 'pyramid', format: 'single_elim', race_to: 3, rating_limit: 1300, fee_kopecks: 50000, prize_text: 'Кий в подарок победителю', places: 16, starts_at: at(3, 0), ends_at: at(3, 6), status: 'registration', resource_ids: [rid(1), rid(2)], entries: entries(3, 'pyramid', false).map((e, i) => ({ ...e, nick: PLAYERS[6 + i]?.[0] ?? e.nick })), bracket: null },
        { id: 'd4000000-0000-4000-8000-000000000002', title: 'Субботняя пирамида', discipline: 'pyramid', format: 'single_elim', race_to: 4, rating_limit: null, fee_kopecks: 100000, prize_text: '1 место — 10 000 ₽, 2 место — 5 000 ₽', places: 32, starts_at: at(5, 0), ends_at: at(5, 8), status: 'registration', resource_ids: [rid(1), rid(2), rid(3), rid(4)], entries: entries(10, 'pyramid', false), bracket: null },
      ];
  const disputes = empty
    ? []
    : [
        { id: uuid(), discipline: 'pyramid', table_number: 3, created_at: new Date(t - 22 * MIN).toISOString(), players: [{ user_id: 'p-a', nick: 'Андрей_К', score: 8, confirmed: true }, { user_id: 'p-b', nick: 'Борт', score: 6, confirmed: false }], status: 'disputed', dispute_reason: 'Счёт был 8:7, последний шар спорный', disputed_by: 'Борт' },
        { id: uuid(), discipline: 'pool', table_number: 7, created_at: new Date(t - 3 * 60 * MIN).toISOString(), players: [{ user_id: 'p-c', nick: 'Мария_С', score: 5, confirmed: true }, { user_id: 'p-d', nick: 'Ольга_8', score: 3, confirmed: true }], status: 'disputed', dispute_reason: 'Играли не мы — кто-то внёс партию с нашего стола', disputed_by: 'Ольга_8' },
      ];
  const reviews = empty
    ? []
    : [
        { id: uuid(), rating: 5, text: 'Отличные столы, сукно свежее. Свет включился сам, как обещали. Бар — норм.', author_nick: 'Shark77', created_at: new Date(t - 2 * DAY).toISOString(), reply: { text: 'Спасибо! Ждём на субботнюю пирамиду.', at: new Date(t - DAY).toISOString() }, reported: false },
        { id: uuid(), rating: 3, text: 'Вечером в пятницу шумно, на 7-м столе кий кривой. Позвоните мне *** — расскажу подробнее.', author_nick: 'Борт', created_at: new Date(t - 5 * 60 * MIN).toISOString(), reply: null, reported: false },
        { id: uuid(), rating: 4, text: 'Удобно платить с телефона.', author_nick: 'Мария_С', created_at: new Date(t - 9 * DAY).toISOString(), reply: null, reported: false },
      ];
  return {
    tournaments,
    disputes,
    reviews,
    listing: { id: 'c1000000-0000-4000-8000-0000000000aa', status: 'platform', name: CLUB.name, slug: 'klub-dlya-razrabotki', city: CLUB.city, address: 'ул. Вайнера, 9', phone: '+7 343 000-00-00', description: 'Восемь столов: пять под пирамиду, три под пул. Бар, турниры по субботам.', hours_text: 'Ежедневно 12:00–02:00', url: '' },
    platform: platformSeed(t),
  };
}

/** Записи оператора — в формах server/directory (operatorView, leads.view, claimView, listReports). */
function platformSeed(t) {
  const ago = (m) => new Date(t - m * MIN).toISOString();
  return {
    requests: [
      { id: uuid(), status: 'operator', listing: { id: uuid(), name: 'Бильярдная «Абриколь»', city: 'Екатеринбург', status: 'listed' }, starts_at: new Date(t + 3 * 60 * MIN).toISOString(), minutes: 120, people: 2, comment: 'Стол под пирамиду', guest: { phone: '+7 912 345-67-89', phone_masked: '+7 *** ***-67-89' }, answer_text: null, answered_via: null, escalated_at: ago(7), created_at: ago(22), updated_at: ago(7) },
      { id: uuid(), status: 'sent', listing: { id: uuid(), name: 'Клуб «Свояк»', city: 'Екатеринбург', status: 'claimed' }, starts_at: new Date(t + 26 * 60 * MIN).toISOString(), minutes: 60, people: 4, comment: null, guest: { phone: '+7 922 000-11-22', phone_masked: '+7 *** ***-11-22' }, answer_text: null, answered_via: null, escalated_at: null, created_at: ago(4), updated_at: ago(4) },
    ],
    leads: [
      { id: uuid(), name: 'Сергей', club_name: '«Карамболь»', city: 'Тюмень', phone: '+7 904 555-66-77', tables_count: 12, comment: 'Хотим онлайн-бронь', status: 'new', note: null, created_at: ago(35), updated_at: ago(35) },
      { id: uuid(), name: 'Ирина', club_name: 'Бильярд-бар «Шар»', city: 'Челябинск', phone: '+7 951 123-45-67', tables_count: 6, comment: null, status: 'contacted', note: 'Перезвонить в понедельник', created_at: ago(26 * 60), updated_at: ago(60) },
    ],
    listings: [
      { id: uuid(), kind: 'add', status: 'new', listing: null, payload: { name: 'Бильярдный клуб «Луза»', city: 'Пермь', address: 'ул. Ленина, 10' }, user: { id: uuid(), phone: '+7 950 111-22-33', phone_masked: '+7 *** ***-22-33' }, reason: null, created_at: ago(90), updated_at: ago(90) },
      { id: uuid(), kind: 'claim', status: 'new', listing: { id: uuid(), name: 'Клуб «Свояк»', city: 'Екатеринбург', status: 'listed', path: '/ekaterinburg/klub-svoyak/' }, payload: null, user: { id: uuid(), phone: '+7 343 222-33-44', phone_masked: '+7 *** ***-33-44' }, reason: null, created_at: ago(300), updated_at: ago(300) },
    ],
    cities: [
      { id: uuid(), slug: 'ekaterinburg', name: 'Екатеринбург', name_in: 'в Екатеринбурге', region: 'Свердловская область', timezone: 'Asia/Yekaterinburg', active: true, clubs: 2, created_at: ago(60 * 24 * 30) },
      { id: uuid(), slug: 'moskva', name: 'Москва', name_in: 'в Москве', region: 'Москва', timezone: 'Europe/Moscow', active: true, clubs: 0, created_at: ago(60 * 24 * 30) },
    ],
    reports: [{ id: uuid(), status: 'new', reason: 'Призыв к травле сотрудника', review: { id: uuid(), rating: 1, text: 'Администратор хамит, найдите его и ругайтесь!!!', status: 'published', reply: null, club: { id: uuid(), name: 'Клуб «Свояк»' } }, decision_reason: null, created_at: ago(50) }],
  };
}

/** @param {{ state: () => object, now: () => number, me: () => object, err: Function, ok: Function, emit: Function, audit: Function, hall: () => object[] }} ctx */
export function m4Routes(ctx) {
  const { err, ok, now } = ctx;
  const S = () => ctx.state().m4;
  const role = () => ctx.me()?.role;
  const manage = () => ['manager', 'owner'].includes(role());
  const platform = () => ctx.me()?.platform_role ?? null;
  const T = (id) => S().tournaments.find((x) => x.id === id);
  // Идентификатор матча — глобальный, как у сервера: «{турнир}:{матч}»
  const bracketView = (x) => (x.bracket ? { rounds: x.bracket.rounds.map((r) => ({ ...r, matches: r.matches.map((mm) => ({ ...mm, id: `${x.id}:${mm.id}` })) })) } : null);
  const view = (x) => ({ ...x, club: CLUB, bracket: bracketView(x), entries_count: x.entries.filter((e) => e.status !== 'canceled').length });
  const publicView = (x) => ({ ...view(x), entries: x.entries.filter((e) => e.status === 'confirmed').map((e) => ({ nick: e.nick, rating: e.rating, seed: e.seed })) });
  const needManage = (fn) => (m, b, q) => (manage() ? fn(m, b, q) : err(ctx.me() ? 403 : 401, ctx.me() ? 'forbidden' : 'unauthorized'));
  const needPlatform = (fn) => (m, b, q) => (platform() ? fn(m, b, q) : err(403, 'forbidden'));
  const bracketEvent = (x) => ctx.emit('bracket', { tournament_id: x.id, rounds: bracketView(x)?.rounds ?? [] });

  const routes = [
    ['GET', /^\/api\/clubs\/([^/]+)\/tournaments$/, needManage(() => ok({ items: S().tournaments.map(view) }))],
    ['POST', /^\/api\/clubs\/([^/]+)\/tournaments$/, needManage((_m, b) => {
      if (!String(b?.title ?? '').trim() || !['pyramid', 'pool', 'snooker'].includes(b.discipline) || !(b.race_to >= 1) || !(b.places >= 4) || !Array.isArray(b.resource_ids) || !b.resource_ids.length) return err(400, 'bad_request');
      const { publish, ...rest } = b;
      const x = { id: uuid(), ...rest, status: publish ? 'registration' : 'draft', entries: [], bracket: null };
      S().tournaments.unshift(x);
      ctx.audit('tournament.create', { data: { title: b.title } });
      return { status: 201, body: view(x) };
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/tournaments\/([^/]+)$/, needManage((m) => (T(m[2]) ? ok(view(T(m[2]))) : err(404, 'not_found')))],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/tournaments\/([^/]+)$/, needManage((m, b) => {
      const x = T(m[2]);
      if (!x) return err(404, 'not_found');
      if (b?.status && !['registration', 'closed'].includes(b.status)) return err(409, 'bad_status');
      Object.assign(x, b ?? {});
      return ok(view(x));
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/tournaments\/([^/]+)\/start$/, needManage((m) => {
      const x = T(m[2]);
      if (!x) return err(404, 'not_found');
      const players = x.entries.filter((e) => e.status === 'confirmed');
      if (players.length < 2) return err(409, 'bad_request');
      const tables = x.resource_ids.map((id) => Number(id.slice(-1)));
      x.bracket = seedBracket(players, { tables });
      x.bracket.rounds[0].matches.forEach((mm) => {
        if (mm.status === 'scheduled' && mm.table_number) mm.status = 'playing';
      });
      const sorted = [...players].sort((a, b2) => b2.rating - a.rating);
      sorted.forEach((e, i) => (e.seed = i + 1));
      x.status = 'running';
      ctx.audit('tournament.start', { data: { title: x.title } });
      bracketEvent(x);
      return ok(view(x));
    })],
    ['POST', /^\/api\/clubs\/([^/]+)\/tournaments\/([^/]+)\/cancel$/, needManage((m, b) => {
      const x = T(m[2]);
      if (!x) return err(404, 'not_found');
      if (!String(b?.reason ?? '').trim()) return err(400, 'reason_required');
      const refunded = x.entries.filter((e) => e.paid).length;
      x.status = 'canceled';
      ctx.audit('tournament.cancel', { reason: b.reason, data: { refunded } });
      return ok({ ...view(x), refunded, refunded_kopecks: refunded * x.fee_kopecks });
    })],
    ['PATCH', /^\/api\/tournaments\/matches\/([^/]+)\/score$/, needManage((m, b) => {
      const [tid, mid] = decodeURIComponent(m[1]).split(':');
      const x = T(tid);
      if (!x?.bracket) return err(404, 'not_found');
      if (!String(b?.reason ?? '').trim()) return err(400, 'reason_required');
      if (!Number.isInteger(b.score_a) || !Number.isInteger(b.score_b) || b.score_a === b.score_b) return err(400, 'bad_request');
      const was = x.bracket.rounds.flatMap((r) => r.matches).find((mm) => mm.id === mid);
      if (!was) return err(404, 'not_found');
      const before = was.status === 'done' ? `${was.score_a}:${was.score_b}` : was.status === 'disputed' ? 'спор' : 'без счёта';
      x.bracket = applyScore(x.bracket, mid, b.score_a, b.score_b);
      // Как server/tournaments: журнал manual.tournament_score (до/после) и тревога manual_action владельцу (инвариант 8)
      ctx.audit('manual.tournament_score', { reason: b.reason, data: { tournament_id: x.id, match_id: `${x.id}:${mid}`, before, after: `${b.score_a}:${b.score_b}` } });
      ctx.state().alarms.unshift({ id: uuid(), type: 'manual_action', level: 'important', resource_number: was.table_number ?? null, created_at: new Date(now()).toISOString(), data: { action: 'manual.tournament_score', tournament_id: x.id, match_id: `${x.id}:${mid}`, staff_id: ctx.me()?.id ?? null, reason: b.reason, before, after: `${b.score_a}:${b.score_b}` } });
      ctx.emit('alarm', { type: 'manual_action' });
      bracketEvent(x);
      return ok(view(x));
    })],
    // ТВ-экран: публичный турнир без ПДн
    ['GET', /^\/api\/public\/tournaments\/([^/]+)$/, (m) => (T(m[1]) ? ok(publicView(T(m[1]))) : err(404, 'not_found'))],

    // ---------- споры по партиям Бильярдум+ ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/plus\/disputes$/, needManage(() => ok({ items: S().disputes.filter((d) => d.status === 'disputed') }))],
    ['POST', /^\/api\/plus\/matches\/([^/]+)\/resolve$/, needManage((m, b) => {
      const d = S().disputes.find((x) => x.id === m[1]);
      if (!d) return err(404, 'not_found');
      if (!['a', 'b', 'annul'].includes(b?.result)) return err(400, 'bad_request');
      if (!String(b.reason ?? '').trim()) return err(400, 'reason_required');
      Object.assign(d, { status: 'resolved', result: b.result, resolve_reason: b.reason });
      ctx.audit('plus.match_resolve', { reason: b.reason, data: { match_id: d.id, result: b.result } });
      // Как server/plus: решение спора — ручное действие, тревога manual_action владельцу (инвариант 8)
      ctx.state().alarms.unshift({ id: uuid(), type: 'manual_action', level: 'important', resource_number: d.table_number ?? null, created_at: new Date(now()).toISOString(), data: { action: 'plus.match_resolve', match_id: d.id, result: b.result, staff_id: ctx.me()?.id ?? null, reason: b.reason } });
      ctx.emit('alarm', { type: 'manual_action' });
      return ok(d);
    })],

    // ---------- карточка клуба и отзывы ----------
    ['GET', /^\/api\/clubs\/([^/]+)\/listing$/, needManage(() => ok(S().listing))],
    ['PATCH', /^\/api\/clubs\/([^/]+)\/listing$/, needManage((_m, b) => {
      const allowed = ['address', 'phone', 'description', 'hours_text', 'url'];
      for (const k of allowed) if (typeof b?.[k] === 'string') S().listing[k] = b[k].slice(0, k === 'description' ? 1000 : 200);
      return ok(S().listing);
    })],
    ['GET', /^\/api\/clubs\/([^/]+)\/reviews$/, needManage(() => ok({ items: S().reviews }))],
    ['POST', /^\/api\/reviews\/([^/]+)\/reply$/, needManage((m, b) => {
      const r = S().reviews.find((x) => x.id === m[1]);
      if (!r) return err(404, 'not_found');
      if (!String(b?.text ?? '').trim()) return err(400, 'bad_request');
      r.reply = { text: String(b.text).slice(0, 1000), at: new Date(now()).toISOString() };
      return ok(r);
    })],
    ['POST', /^\/api\/reviews\/([^/]+)\/report$/, needManage((m, b) => {
      const r = S().reviews.find((x) => x.id === m[1]);
      if (!r) return err(404, 'not_found');
      if (!String(b?.reason ?? '').trim()) return err(400, 'reason_required');
      r.reported = true;
      return ok(r);
    })],

    // ---------- оператор платформы ----------
    ['GET', /^\/api\/platform\/(requests|leads|listings|reports|cities)$/, needPlatform((m) => ok({ items: S().platform[m[1]] }))],
    // Справочник городов (оператор): name_in с предлогом, пояс IANA; slug только при создании
    ['POST', /^\/api\/platform\/cities$/, needPlatform((_m, b) => {
      const c = cityFrom(b);
      if (c.error) return err(c.status ?? 400, c.error);
      S().platform.cities.push(c.city);
      return { status: 201, body: c.city };
    })],
    ['PATCH', /^\/api\/platform\/cities\/([^/]+)$/, needPlatform((m, b) => {
      const c = S().platform.cities.find((x) => x.id === m[1]);
      if (!c) return err(404, 'not_found');
      if (b?.name_in !== undefined && !/^(в|во|на)\s/i.test(String(b.name_in))) return err(400, 'bad_request');
      for (const k of ['name', 'name_in', 'region', 'timezone']) if (typeof b?.[k] === 'string') c[k] = b[k];
      if (typeof b?.active === 'boolean') c.active = b.active;
      return ok(c);
    })],
    ['PATCH', /^\/api\/platform\/(requests|leads|listings|reports)\/([^/]+)$/, needPlatform((m, b) => {
      const item = S().platform[m[1]].find((x) => x.id === m[2]);
      if (!item) return err(404, 'not_found');
      const value = { approve: 'approved', reject: 'rejected', hide: 'hidden', keep: 'kept' }[b?.action] ?? b?.status ?? b?.action;
      const allowed = { requests: ['accepted', 'declined', 'closed'], leads: ['new', 'contacted', 'demo', 'won', 'lost', 'spam'], listings: ['approved', 'rejected'], reports: ['hidden', 'kept'] }[m[1]];
      if (value !== undefined && !allowed.includes(value)) return err(400, 'bad_request');
      if (m[1] === 'requests' && !['sent', 'operator'].includes(item.status)) return err(409, 'request_closed');
      if (m[1] === 'listings' && item.status !== 'new') return err(409, 'already_decided');
      if (m[1] === 'listings' && ['approved', 'approve'].includes(value) && item.kind === 'add' && !S().platform.cities.some((c) => c.name === item.payload?.city)) {
        if (!b.new_city) return err(409, 'city_required');
        const c = cityFrom(b.new_city);
        if (c.error) return err(c.status ?? 400, c.error);
        S().platform.cities.push(c.city);
      }
      if (value === 'hidden' && !String(b.reason ?? '').trim()) return err(400, 'reason_required');
      if (value !== undefined) item.status = value;
      if (m[1] === 'requests' && b.reason) Object.assign(item, { answer_text: String(b.reason).slice(0, 500), answered_via: 'operator' });
      if (m[1] === 'leads' && b.note !== undefined) item.note = b.note || null;
      if (m[1] !== 'requests' && m[1] !== 'leads' && b.reason) item[m[1] === 'reports' ? 'decision_reason' : 'reason'] = String(b.reason).slice(0, 300);
      return ok(item);
    })],
  ];
  function cityFrom(b) {
    if (!String(b?.name ?? '').trim()) return { error: 'bad_request' };
    if (!/^(в|во|на)\s/i.test(String(b?.name_in ?? ''))) return { error: 'bad_request' };
    if (!/^[A-Za-z_]+\/[A-Za-z_]+$/.test(b?.timezone ?? '')) return { error: 'bad_request' };
    const slug = b.slug || String(b.name).toLowerCase().replace(/[^a-zа-я0-9]+/g, '-');
    if (S().platform.cities.some((c) => c.slug === slug || c.name === b.name)) return { error: 'duplicate', status: 409 };
    return { city: { id: uuid(), slug, name: b.name, name_in: b.name_in, region: b.region ?? null, timezone: b.timezone, active: b.active ?? true, clubs: 0, created_at: new Date(now()).toISOString() } };
  }

  return { routes };
}
