// T25 и каталог: «Добавить клуб» в новом городе (409 city_required → new_city), «Подтвердить клуб»,
// заявка гостя в клуб без программы: без контакта — сразу оператору; с контактом — ответ клуба по
// одноразовой ссылке и передача оператору через 15 минут без ответа (настоящие 15 минут, без
// ускорения). Заявки клубов на программу (leads): антиспам и уведомление Андрею.
//
// Ждёт ~16 минут. Столов не занимает. Что создаёт: синтетических гостей +7999…, город и карточки
// «E2E …» (в конце — карточки скрыты, город выключен через API оператора), заявки, lead.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  adminClient,
  api,
  auditAny,
  brief2,
  CLUB_LISTING,
  DEMO_LISTING,
  flat,
  guestPhone,
  MIN,
  newGuest,
  nick,
  ok,
  phonesIn,
  platform,
  PLATFORM_IDS,
  sleep,
  waitFor,
  waitNotification,
} from './helpers.mjs';

const T0 = Date.now();
const TAG = nick('m4').slice(4, 12);
const ESCALATE_WAIT_MS = Number(process.env.E2E_T25_WAIT_MS || 17 * MIN);
let db;
let op;
let admin;
const made = { cards: [], cityId: null };
const ctx = {};

before(async () => {
  db = await adminClient();
  op = await platform('operator');
  admin = await platform('admin');
});

after(async () => {
  // Уборка через API оператора: тестовые карточки скрыть, тестовый город выключить.
  for (const id of made.cards) {
    const r = await api('PATCH', `/api/platform/cards/${id}`, { token: op.token, body: { visible: false, reason: 'e2e: уборка' } });
    if (r.status !== 200) console.log(`карточка ${id}: скрыть — ${brief2(r)}`);
  }
  if (made.cityId) {
    const r = await api('PATCH', `/api/platform/cities/${made.cityId}`, { token: op.token, body: { active: false } });
    if (r.status !== 200) console.log(`город ${made.cityId}: выключить — ${brief2(r)}`);
  }
  await db?.end();
});

test('роли платформы: /api/me, экран оператора закрыт гостю и персоналу клуба', async (t) => {
  const meOp = await ok(api('GET', '/api/me', { token: op.token }));
  const meAdm = await ok(api('GET', '/api/me', { token: admin.token }));
  assert.equal(meOp.user.platform_role, 'platform_operator');
  assert.equal(meAdm.user.platform_role, 'platform_admin');
  const g = await newGuest();
  const { staff } = await import('./helpers.mjs');
  const owner = await staff('owner');
  for (const [who, tok] of [['гость', g.token], ['владелец клуба', owner.token], ['без входа', undefined]]) {
    for (const p of ['/api/platform/requests', '/api/platform/listings', '/api/platform/leads', '/api/platform/reports', '/api/platform/cities']) {
      const r = await api('GET', p, { token: tok });
      assert.ok([401, 403].includes(r.status), `${who} ${p}: ${r.status}`);
    }
  }
  t.diagnostic(`оператор ${meOp.user.platform_role}, Андрей ${meAdm.user.platform_role}; гость/владелец клуба/без входа на /api/platform/* — 403/401`);
});

test('«Добавить клуб» в городе вне справочника: 409 city_required → PATCH с new_city', async (t) => {
  const adder = await newGuest();
  ctx.adder = adder;
  const noAuth = await api('POST', '/api/directory/add', { body: { city: 'Тест', name: 'X', address: 'Y' } });
  assert.equal(noAuth.status, 401);
  const cityName = `Етэгород ${TAG}`;
  const clubPhone = guestPhone();
  const add = await api('POST', '/api/directory/add', {
    token: adder.token,
    body: { city: cityName, name: `E2E Клуб ${TAG}`, address: 'ул. Синтетическая, 7', phone: clubPhone, hours_text: 'Ежедневно 12:00–02:00', disciplines: ['pyramid'], tables_count: 6, comment: 'e2e M4' },
  });
  assert.equal(add.status, 201, brief2(add));
  assert.equal(add.json.status, 'new');
  ctx.addId = add.json.id;
  const note = await waitNotification(db, PLATFORM_IDS.operator, 'platform.listing_add', { since: T0 });
  assert.match(note.text, new RegExp(`E2E Клуб ${TAG}`));
  assert.deepEqual(phonesIn(note.text), [], 'в уведомлении оператору нет телефона');

  const list = await ok(api('GET', '/api/platform/listings?status=new', { token: op.token }));
  const item = list.items.find((x) => x.id === ctx.addId);
  assert.ok(item, 'заявка видна оператору');
  assert.equal(item.kind, 'add');
  assert.notEqual(item.user.phone_masked, adder.phone);
  assert.ok(item.user.phone_masked.endsWith(adder.phone.slice(-2)), `маска ${item.user.phone_masked}`);

  const r409 = await api('PATCH', `/api/platform/listings/${ctx.addId}`, { token: op.token, body: { action: 'approve' } });
  assert.equal(r409.status, 409, brief2(r409));
  assert.equal(r409.json.error, 'city_required');

  const bad = await api('PATCH', `/api/platform/listings/${ctx.addId}`, {
    token: op.token,
    body: { action: 'approve', new_city: { name: cityName, name_in: `в Еэтогороде ${TAG}`, timezone: 'Mars/Olympus' } },
  });
  assert.equal(bad.status, 400, `неверный пояс — 400: ${brief2(bad)}`);

  const appr = await api('PATCH', `/api/platform/listings/${ctx.addId}`, {
    token: op.token,
    body: { action: 'approve', reason: 'e2e: проверено по телефону', new_city: { name: cityName, name_in: `в Еэтогороде ${TAG}`, timezone: 'Asia/Yekaterinburg', region: 'Синтетическая область' } },
  });
  assert.equal(appr.status, 200, brief2(appr));
  assert.equal(appr.json.status, 'approved');
  assert.ok(appr.json.listing?.id);
  ctx.cardId = appr.json.listing.id;
  ctx.cardPath = appr.json.listing.path;
  made.cards.push(ctx.cardId);
  const again = await api('PATCH', `/api/platform/listings/${ctx.addId}`, { token: op.token, body: { action: 'approve' } });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_decided');

  const cities = await ok(api('GET', '/api/platform/cities', { token: op.token }));
  const city = cities.items.find((c) => c.name === cityName);
  assert.ok(city, 'город создан');
  made.cityId = city.id;
  ctx.citySlug = city.slug;
  const pub = await waitFor(
    async () => {
      const r = await api('GET', `/api/public/cities/${city.slug}`);
      return r.status === 200 && r.json.items.some((c) => c.id === ctx.cardId) ? r.json : null;
    },
    { timeoutMs: 75_000, intervalMs: 3000, what: 'карточка в публичном каталоге (кэш 60 с)' },
  );
  const card = pub.items.find((c) => c.id === ctx.cardId);
  assert.equal(card.status, 'listed');
  assert.equal(card.booking, 'request');
  assert.equal(card.free_now, null);
  const decided = await waitNotification(db, adder.user.id, 'directory.claim_decision', { since: T0 });
  const au = await auditAny(db, { actions: ['platform.listing_approve'], since: T0, like: ctx.addId });
  assert.equal(au.length, 1);
  assert.equal(au[0].actor_type, 'support');
  assert.equal(au[0].reason, 'e2e: проверено по телефону');
  t.diagnostic(`add ${ctx.addId.slice(0, 8)} → 409 city_required → approve с new_city: город ${city.slug} (${city.timezone}), карточка ${ctx.cardPath} listed/booking=request; оператору «${note.text}»; заявителю «${decided.text}»; журнал platform.listing_approve actor_type=${au[0].actor_type}`);
});

test('«Подтвердить клуб»: оператор одобряет — карточка claimed, контакт для заявок — заявитель', async (t) => {
  assert.ok(ctx.cardId, 'нужна карточка из прошлого теста');
  const owner = await newGuest();
  ctx.contact = owner;
  const c = await api('POST', '/api/directory/claim', { token: owner.token, body: { listing_id: ctx.cardId, comment: 'Я владелец (e2e)' } });
  assert.equal(c.status, 201, brief2(c));
  const rival = await newGuest();
  const cr = await ok(api('POST', '/api/directory/claim', { token: rival.token, body: { listing_id: ctx.cardId, comment: 'Тоже владелец (e2e)' } }), 201);
  const dup = await ok(api('POST', '/api/directory/claim', { token: owner.token, body: { listing_id: ctx.cardId } }), 201);
  assert.equal(dup.id, c.json.id, 'повтор — та же заявка');
  await waitNotification(db, PLATFORM_IDS.operator, 'platform.listing_claim', { since: T0 });
  const rej = await api('PATCH', `/api/platform/listings/${c.json.id}`, { token: op.token, body: { action: 'approve', reason: 'e2e: документы проверены' } });
  assert.equal(rej.status, 200, brief2(rej));
  assert.equal(rej.json.listing.status, 'claimed');
  const { rows } = await db.query('select status, contact_user_id from bl.club_public where id = $1', [ctx.cardId]);
  assert.equal(rows[0].status, 'claimed');
  assert.equal(rows[0].contact_user_id, owner.user.id);
  // M4-4: вторая заявка на ту же карточку после одобрения первой не одобряется.
  const second = await api('PATCH', `/api/platform/listings/${cr.id}`, { token: op.token, body: { action: 'approve', reason: 'e2e: вторая заявка' } });
  const { rows: after2 } = await db.query('select status, contact_user_id from bl.club_public where id = $1', [ctx.cardId]);
  const { rows: crow } = await db.query('select status, reason from bl.directory_claims where id = $1', [cr.id]);
  ctx.secondClaim = `${second.status} ${second.json?.error ?? second.json?.status}; заявка ${crow[0].status}${crow[0].reason ? ` («${crow[0].reason}»)` : ''}; контакт карточки ${after2[0].contact_user_id === owner.user.id ? 'прежний' : 'СМЕНИЛСЯ'}`;
  assert.equal(after2[0].contact_user_id, owner.user.id, 'вторая заявка не перехватила карточку');
  assert.equal(second.status, 409, `повторное одобрение: ${ctx.secondClaim}`);
  // M4-4: при одобрении первой заявки остальные на эту карточку отклоняются — повтор даёт already_decided.
  assert.ok(['already_claimed', 'already_decided'].includes(second.json.error), ctx.secondClaim);
  assert.equal(crow[0].status, 'rejected');
  const other = await newGuest();
  const c2 = await api('POST', '/api/directory/claim', { token: other.token, body: { listing_id: ctx.cardId } });
  assert.equal(c2.status, 409);
  assert.equal(c2.json.error, 'already_claimed');
  const c3 = await api('POST', '/api/directory/claim', { token: other.token, body: { listing_id: CLUB_LISTING } });
  assert.equal(c3.status, 409, 'карточка клуба на программе — already_claimed');
  t.diagnostic(`claim → approve: карточка claimed, contact_user_id = заявитель; одобрение второй заявки на ту же карточку — ${ctx.secondClaim}; повтор claim той же карточки — 409 already_claimed; карточка platform — ${c3.json.error}`);
});

test('T25 без контакта: заявка сразу оператору, оператор отвечает, гостю статус', async (t) => {
  const g = await newGuest();
  const starts = new Date(Date.now() + 3 * 3600_000).toISOString();
  const online = await api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: CLUB_LISTING, starts_at: starts, minutes: 60, people: 2 } });
  assert.equal(online.status, 409);
  assert.equal(online.json.error, 'online_booking');
  for (const body of [
    { listing_id: DEMO_LISTING, starts_at: starts, minutes: 10, people: 2 },
    { listing_id: DEMO_LISTING, starts_at: starts, minutes: 60, people: 0 },
    { listing_id: DEMO_LISTING, starts_at: 'завтра', minutes: 60, people: 2 },
  ]) {
    const r = await api('POST', '/api/clubs/requests', { token: g.token, body });
    assert.equal(r.status, 400, `неверные данные ${JSON.stringify(body)} → ${r.status}`);
  }
  const t1 = Date.now();
  const r = await api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: DEMO_LISTING, starts_at: starts, minutes: 90, people: 3, comment: 'Позвоните мне: +7 999 123 45 67' } });
  assert.equal(r.status, 201, brief2(r));
  await waitFor(
    async () => {
      const x = await ok(api('GET', `/api/clubs/requests/${r.json.id}`, { token: g.token }));
      return x.status === 'operator' ? x : null;
    },
    { timeoutMs: 70_000, intervalMs: 1000, what: 'заявка у оператора' },
  );
  const tOp = Date.now() - t1;
  const opNote = await waitNotification(db, PLATFORM_IDS.operator, 'platform.club_request', { since: t1 });
  const gNote = await waitNotification(db, g.user.id, 'club.request_operator', { since: t1 });
  assert.match(opNote.text, /нет контакта/);
  const stranger = await newGuest();
  const foreign = await api('GET', `/api/clubs/requests/${r.json.id}`, { token: stranger.token });
  assert.equal(foreign.status, 404, 'чужая заявка — 404');
  const list = await ok(api('GET', '/api/platform/requests?status=operator', { token: op.token }));
  const item = list.items.find((x) => x.id === r.json.id);
  assert.ok(item);
  assert.equal(item.guest.phone, g.phone, 'оператор видит телефон гостя, чтобы позвонить');
  const ans = await api('PATCH', `/api/platform/requests/${r.json.id}`, { token: op.token, body: { status: 'accepted', reason: 'Клуб подтвердил по телефону, стол 2' } });
  assert.equal(ans.status, 200, brief2(ans));
  const fin = await ok(api('GET', `/api/clubs/requests/${r.json.id}`, { token: g.token }));
  assert.equal(fin.status, 'accepted');
  assert.equal(fin.answer_text, 'Клуб подтвердил по телефону, стол 2');
  const ansNote = await waitNotification(db, g.user.id, 'club.request_answer', { since: t1 });
  const au = await auditAny(db, { actions: ['directory.request_escalate', 'platform.request_answer'], since: t1, like: r.json.id });
  assert.deepEqual(au.map((a) => a.action), ['directory.request_escalate', 'platform.request_answer']);
  t.diagnostic(`клуб на программе — 409 online_booking; минуты 10/люди 0/дата текстом — 400; заявка → operator через ${Math.round(tOp / 1000)} с (тик 30 с); оператору «${opNote.text}»; гостю «${gNote.text}»; чужой гость — 404; оператор accepted → гостю «${ansNote.text}»; журнал ${au.map((a) => a.action).join(', ')}`);
});

test('T25 с контактом: ответ клуба по ссылке с токеном (одноразовой), чужой токен — 404', async (t) => {
  assert.ok(ctx.contact, 'нужен контакт карточки');
  const g = await newGuest();
  ctx.guest = g;
  const t1 = Date.now();
  const starts = new Date(Date.now() + 26 * 3600_000).toISOString();
  const r = await ok(api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: ctx.cardId, starts_at: starts, minutes: 120, people: 4, comment: 'День рождения' } }), 201);
  const note = await waitNotification(db, ctx.contact.user.id, 'club.request', { since: t1 });
  const url = note.actions?.[0]?.url ?? '';
  const m = /^\/app\/club-request\/([0-9a-f-]{36})\?t=([A-Za-z0-9_-]+)$/.exec(url);
  assert.ok(m, `ссылка «Ответить на заявку»: ${url.replace(/t=.*/, 't=…')}`);
  assert.equal(m[1], r.id);
  const token = m[2];
  assert.match(note.text, /Ответьте в течение 15 минут/);
  assert.deepEqual(phonesIn(note.text), []);
  const wrong = await api('GET', `/api/clubs/requests/${r.id}/answer?t=${'A'.repeat(43)}`);
  assert.equal(wrong.status, 404);
  const view = await ok(api('GET', `/api/clubs/requests/${r.id}/answer?t=${token}`));
  assert.equal(view.guest_phone, g.phone, 'клуб по ссылке видит телефон гостя');
  assert.equal(view.people, 4);
  assert.equal(view.timezone, 'Asia/Yekaterinburg', 'пояс клуба в ответе по ссылке');
  const badDecision = await api('POST', `/api/clubs/requests/${r.id}/answer`, { body: { t: token, decision: 'maybe' } });
  assert.equal(badDecision.status, 400);
  const ans = await api('POST', `/api/clubs/requests/${r.id}/answer`, { body: { t: token, decision: 'accept', text: 'Ждём, стол 3' } });
  assert.equal(ans.status, 200, brief2(ans));
  assert.equal(ans.json.status, 'accepted');
  // №151/контракт: после ответа живая ссылка — 409 request_closed {status}; 404 — только неверный или истёкший токен.
  const reuse = await api('POST', `/api/clubs/requests/${r.id}/answer`, { body: { t: token, decision: 'decline' } });
  assert.equal(reuse.status, 409, `повтор ссылки: ${brief2(reuse)}`);
  assert.deepEqual(reuse.json, { error: 'request_closed', status: 'accepted' });
  const reuseGet = await api('GET', `/api/clubs/requests/${r.id}/answer?t=${token}`);
  assert.equal(reuseGet.status, 409);
  assert.equal(reuseGet.json.status, 'accepted');
  const st = await ok(api('GET', `/api/clubs/requests/${r.id}`, { token: g.token }));
  assert.equal(st.status, 'accepted');
  assert.equal(st.answer_text, 'Ждём, стол 3');
  const gNote = await waitNotification(db, g.user.id, 'club.request_answer', { since: t1 });
  const au = await auditAny(db, { actions: ['directory.request_answer'], since: t1, like: r.id });
  assert.equal(au.length, 1);
  assert.equal(au[0].data.via, 'link');
  ctx.answerLink = url;
  t.diagnostic(`контакту «${note.text}», кнопка ${url.replace(/t=.*/, 't=…')} (токен ${token.length} симв.); чужой токен — 404; по ссылке видна заявка с телефоном гостя; accept → гостю «${gNote.text}»; повтор ссылки — 409 ${JSON.stringify(reuse.json)}, GET — 409; журнал directory.request_answer via=link`);
});

test('T25 с контактом: без ответа 15 минут — оператору (настоящее время)', { timeout: ESCALATE_WAIT_MS + 5 * MIN }, async (t) => {
  assert.ok(ctx.contact);
  const g = await newGuest();
  const t1 = Date.now();
  const starts = new Date(Date.now() + 27 * 3600_000).toISOString();
  const r = await ok(api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: ctx.cardId, starts_at: starts, minutes: 60, people: 2 } }), 201);
  const note = await waitNotification(db, ctx.contact.user.id, 'club.request', { since: t1 });
  const { rows } = await db.query('select escalate_at, created_at from bl.club_requests where id = $1', [r.id]);
  assert.equal(new Date(rows[0].escalate_at) - new Date(rows[0].created_at), 15 * MIN);
  // На 14-й минуте ещё у клуба.
  await sleep(Math.max(0, 14 * MIN - (Date.now() - t1)));
  const mid = await ok(api('GET', `/api/clubs/requests/${r.id}`, { token: g.token }));
  assert.equal(mid.status, 'sent', 'на 14-й минуте заявка ещё у клуба');
  const st = await waitFor(
    async () => {
      const x = await ok(api('GET', `/api/clubs/requests/${r.id}`, { token: g.token }));
      return x.status === 'operator' ? x : null;
    },
    { timeoutMs: ESCALATE_WAIT_MS - 14 * MIN, intervalMs: 5000, what: 'заявка у оператора через 15 минут' },
  );
  const { rows: r2 } = await db.query('select escalated_at, created_at, status from bl.club_requests where id = $1', [r.id]);
  const after = (new Date(r2[0].escalated_at) - new Date(r2[0].created_at)) / 1000;
  assert.ok(after >= 900 && after < 960, `передача оператору через ${after} с`);
  const opNote = await waitNotification(db, PLATFORM_IDS.operator, 'platform.club_request', { since: t1 });
  assert.match(opNote.text, /за 15 минут/);
  const gNote = await waitNotification(db, g.user.id, 'club.request_operator', { since: t1 });
  // Ссылка клуба после передачи оператору: заявка открыта (operator), клуб ещё может ответить.
  const url = note.actions?.[0]?.url ?? '';
  const token = /t=([A-Za-z0-9_-]+)/.exec(url)?.[1];
  const late = await api('GET', `/api/clubs/requests/${r.id}/answer?t=${token}`);
  t.diagnostic(`escalate_at − created_at = 900 с; на 14-й минуте status=sent; передана оператору через ${after.toFixed(1)} с (status ${st.status}); оператору «${opNote.text}»; гостю «${gNote.text}»; ссылка клуба после передачи — ${late.status} (${late.json?.status ?? late.json?.error})`);
  await ok(api('PATCH', `/api/platform/requests/${r.id}`, { token: op.token, body: { status: 'closed', reason: 'e2e: закрыто после проверки' } }));
});

test('лимит открытых заявок гостя: четвёртая — 409 limit_exceeded', async (t) => {
  assert.ok(ctx.cardId);
  const g = await newGuest();
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await ok(api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: ctx.cardId, starts_at: new Date(Date.now() + (30 + i) * 3600_000).toISOString(), minutes: 60, people: 2 } }), 201);
    ids.push(r.id);
  }
  const fourth = await api('POST', '/api/clubs/requests', { token: g.token, body: { listing_id: ctx.cardId, starts_at: new Date(Date.now() + 40 * 3600_000).toISOString(), minutes: 60, people: 2 } });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.json.error, 'limit_exceeded');
  for (const id of ids) {
    const c = await ok(api('POST', `/api/clubs/requests/${id}/cancel`, { token: g.token, body: {} }));
    assert.equal(c.status, 'closed');
  }
  t.diagnostic('три открытые — 201, четвёртая — 409 limit_exceeded; гость закрыл свои — closed');
});

test('leads: антиспам (скрытое поле, быстрое заполнение), согласие, уведомление Андрею без телефона', async (t) => {
  const t1 = Date.now();
  const phone = guestPhone();
  const base = { name: 'Иван E2E', club_name: `Клуб-лид ${TAG}`, city: 'Екатеринбург', phone, tables_count: 8, comment: 'e2e', consent: true, website: '', elapsed_ms: 15_000 };
  const noConsent = await api('POST', '/api/leads', { body: { ...base, consent: false } });
  assert.equal(noConsent.status, 403);
  assert.equal(noConsent.json.error, 'consent_required');
  const bot1 = await api('POST', '/api/leads', { body: { ...base, club_name: `Бот1 ${TAG}`, website: 'http://spam' } });
  const bot2 = await api('POST', '/api/leads', { body: { ...base, club_name: `Бот2 ${TAG}`, elapsed_ms: 800 } });
  assert.equal(bot1.status, 201);
  assert.equal(bot2.status, 201);
  const okLead = await api('POST', '/api/leads', { body: base });
  assert.equal(okLead.status, 201, brief2(okLead));
  const { rows } = await db.query('select club_name, status from bl.leads where club_name like $1', [`%${TAG}`]);
  assert.deepEqual(rows.map((r) => r.club_name), [`Клуб-лид ${TAG}`], 'боты без записи');
  const note = await waitNotification(db, PLATFORM_IDS.admin, 'platform.lead', { since: t1 });
  assert.deepEqual(phonesIn(note.text), [], 'в тексте уведомления Андрею нет телефона');
  assert.ok(!flat(note.data).includes(phone.slice(2)), 'в data уведомления нет телефона');
  const opList = await ok(api('GET', '/api/platform/leads', { token: op.token }));
  const lead = opList.items.find((x) => x.club_name === `Клуб-лид ${TAG}`);
  assert.ok(lead);
  const p = await api('PATCH', `/api/platform/leads/${lead.id}`, { token: admin.token, body: { status: 'contacted', note: 'e2e: позвонили' } });
  t.diagnostic(`без согласия — 403 consent_required; скрытое поле и 0,8 с — 201 без записи; lead записан; Андрею «${note.text}»; оператор видит lead; PATCH статуса — ${p.status} ${p.json?.status ?? p.json?.error}`);
});

test('ссылка «Ответить на заявку» открывается в приложении (маршрут /app/club-request/…)', async (t) => {
  assert.ok(ctx.answerLink);
  const { readFileSync } = await import('node:fs');
  const { REPO_ROOT } = await import('./helpers.mjs');
  const routes = readFileSync(`${REPO_ROOT}/web/guest/src/lib/routes.js`, 'utf8');
  const has = /club-request/.test(routes);
  t.diagnostic(`маршрут club-request в web/guest/src/lib/routes.js: ${has ? 'есть' : 'НЕТ'} (подробно — браузерный сценарий 08)`);
  assert.ok(has, 'ссылка из уведомления клубу ведёт на маршрут, которого нет в приложении гостя');
});
