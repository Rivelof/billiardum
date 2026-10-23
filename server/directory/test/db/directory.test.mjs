// Каталог клубов на настоящем Postgres (M4): публичный API сайта без ПДн, заявки гостей в клубы
// без программы (T25), «Подтвердить/Добавить клуб», leads (антиспам, уведомление Андрею),
// отзывы (только после игры, ответ клуба, жалоба → оператору), экран оператора, RLS.
// Без DATABASE_ADMIN_URL тесты пропускаются.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { CARD_A, CARD_DEMO, CLUB_A, CLUB_B, MIN, PHONES, setup, T0, table } from './harness.mjs';

const skip = !process.env.DATABASE_ADMIN_URL;

describe('каталог клубов', { skip }, () => {
  let h;
  let guest;
  let other;
  let operator;
  let admin;
  let manager;

  before(async () => {
    h = await setup();
    guest = await h.login('+79990001001');
    other = await h.login('+79990001002');
    operator = await h.login('+79990001003');
    admin = await h.login('+79990001004');
    manager = await h.login(PHONES.manager);
    await h.platformMember(operator.id, 'platform_operator');
    await h.platformMember(admin.id, 'platform_admin');
  });
  after(async () => {
    await h?.close();
  });

  const noPii = (text) => {
    for (const u of [guest, other, operator, admin]) {
      assert.ok(!text.includes(u.id), 'id пользователя в публичном ответе');
      assert.ok(!text.includes(u.phone), 'телефон гостя в публичном ответе');
    }
  };

  it('публичные города и каталог города: без входа, фильтры, сортировка, кэш, без ПДн', async () => {
    h.clock.set(T0);
    const c = await h.request('GET', '/api/public/cities');
    assert.equal(c.status, 200, c.text);
    assert.match(c.headers.get('cache-control'), /max-age=60/);
    const ekb = c.json.items.find((x) => x.slug === 'ekaterinburg');
    assert.deepEqual({ ...ekb }, { slug: 'ekaterinburg', name: 'Екатеринбург', name_in: 'в Екатеринбурге', region: 'Свердловская область', clubs: 2, online_clubs: 1, free_now: 8 });
    assert.equal(c.json.items.find((x) => x.slug === 'moskva').free_now, 0);

    const r = await h.request('GET', '/api/public/cities/ekaterinburg');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.city.timezone, 'Asia/Yekaterinburg');
    assert.equal(r.json.items.length, 2);
    const [first, second] = r.json.items;
    assert.equal(first.id, CARD_A); // в программе — первым
    assert.equal(first.booking, 'online');
    assert.equal(first.club_id, CLUB_A);
    assert.equal(first.path, '/ekaterinburg/testovyy-klub/');
    assert.equal(first.tables_count, 8);
    assert.equal(first.free_now, 8);
    assert.equal(first.price_from_kopecks, 50_000);
    assert.deepEqual(first.disciplines.sort(), ['pool', 'pyramid']);
    assert.equal(second.booking, 'request');
    assert.equal(second.club_id, null);
    assert.equal(second.free_now, null);
    noPii(r.text);

    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?online=1')).json.items.length, 1);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=snooker')).json.items.length, 0);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?around_the_clock=1')).json.items.length, 1);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?free_now=1')).json.items.length, 1);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?price_max=40000')).json.items.length, 0);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?sort=name')).json.items[0].name, 'Демо-клуб без программы');
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?sort=bad')).status, 400);
    assert.equal((await h.request('GET', '/api/public/cities/ekaterinburg?disciplines=golf')).status, 400);
    assert.equal((await h.request('GET', '/api/public/cities/nowhere')).status, 404);
  });

  it('страница клуба: план зала и «свободно сейчас» из light, цены по тарифам, без ПДн; клуб без программы — по заявке', async () => {
    h.clock.set(T0 + 10 * MIN);
    await h.session({ resourceId: table(1), payer: guest.id, paidUntilMs: T0 + 70 * MIN });
    const r = await h.request('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
    assert.equal(r.status, 200, r.text);
    const { club, live, prices, reviews } = r.json;
    assert.equal(club.status, 'platform');
    assert.equal(club.club_id, CLUB_A);
    assert.equal(club.city.slug, 'ekaterinburg');
    assert.equal(live.total, 8);
    assert.equal(live.free_now, 7);
    const t1 = live.tables.find((x) => x.number === 1);
    assert.deepEqual(t1.status, 'busy');
    assert.equal(t1.busy_until, new Date(T0 + 70 * MIN).toISOString());
    assert.equal(t1.discipline, 'pyramid');
    assert.ok(t1.plan && Number.isInteger(t1.plan.x));
    assert.ok(prices.some((p) => p.discipline === 'pyramid' && p.from === '17:00' && p.price_per_hour_kopecks === 80_000 && p.days.includes(1)));
    assert.deepEqual(reviews, { avg: null, count: 0, items: [] });
    noPii(r.text);
    assert.ok(!/payer|participants|user_id/.test(r.text));

    const demo = await h.request('GET', '/api/public/clubs/ekaterinburg/demo-bez-programmy');
    assert.equal(demo.json.club.booking, 'request');
    assert.equal(demo.json.live, null);
    assert.equal(demo.json.club.club_id, null);
    assert.equal((await h.request('GET', '/api/public/clubs/ekaterinburg/net-takogo')).status, 404);
    const l = await h.request('GET', `/api/public/listings/${CARD_DEMO}`);
    assert.deepEqual(l.json, { id: CARD_DEMO, name: 'Демо-клуб без программы', city: 'Екатеринбург', address: 'ул. Примерная, 2', status: 'listed' });
  });

  it('T25: заявка в клуб без контакта — сразу оператору; гость видит статус; клуб в программе — онлайн-бронь', async () => {
    h.clock.set(T0 + 20 * MIN);
    const r = await h.request('POST', '/api/clubs/requests', {
      token: guest.token,
      body: { listing_id: CARD_DEMO, starts_at: new Date(T0 + 180 * MIN).toISOString(), minutes: 120, people: 4, comment: 'Пирамида, двое новичков' },
    });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json, { id: r.json.id, status: 'sent' });
    await h.tick();
    const g = await h.request('GET', `/api/clubs/requests/${r.json.id}`, { token: guest.token });
    assert.equal(g.json.status, 'operator');
    assert.deepEqual(g.json.club, { name: 'Демо-клуб без программы' });
    assert.ok((await h.notifications(operator.id, 'platform.club_request')).length >= 1);
    assert.ok((await h.notifications(guest.id, 'club.request_operator')).length >= 1);
    // Чужой гость заявку не видит.
    assert.equal((await h.request('GET', `/api/clubs/requests/${r.json.id}`, { token: other.token })).status, 404);
    // Оператор: телефон гостя виден, закрывает с ответом.
    const list = await h.request('GET', '/api/platform/requests?status=operator', { token: operator.token });
    assert.equal(list.status, 200, list.text);
    const item = list.json.items.find((x) => x.id === r.json.id);
    assert.equal(item.guest.phone, guest.phone);
    assert.equal(item.listing.name, 'Демо-клуб без программы');
    const p = await h.request('PATCH', `/api/platform/requests/${r.json.id}`, { token: operator.token, body: { status: 'accepted', reason: 'Клуб подтвердил по телефону' } });
    assert.equal(p.status, 200, p.text);
    const g2 = await h.request('GET', `/api/clubs/requests/${r.json.id}`, { token: guest.token });
    assert.equal(g2.json.status, 'accepted');
    assert.equal(g2.json.answer_text, 'Клуб подтвердил по телефону');
    assert.equal((await h.audit('platform.request_answer')).filter((a) => a.object_id === r.json.id && a.club_id === null).length, 1);
    // Клуб в программе — бронь онлайн.
    const online = await h.request('POST', '/api/clubs/requests', { token: guest.token, body: { listing_id: CARD_A, starts_at: new Date(T0 + 180 * MIN).toISOString(), minutes: 60 } });
    assert.equal(online.status, 409);
    assert.equal(online.json.error, 'online_booking');
    // Не оператор — экран оператора закрыт.
    assert.equal((await h.request('GET', '/api/platform/requests', { token: guest.token })).status, 403);
  });

  it('T25: клуб с контактом отвечает по одноразовой ссылке; без ответа 15 минут — оператору', async () => {
    const owner = await h.login('+79990001010');
    await h.admin.query('update bl.club_public set contact_user_id = $2 where id = $1', [CARD_DEMO, owner.id]);
    h.clock.set(T0 + 30 * MIN);
    const r = await h.request('POST', '/api/clubs/requests', { token: other.token, body: { listing_id: CARD_DEMO, starts_at: new Date(T0 + 240 * MIN).toISOString(), minutes: 60, people: 2 } });
    assert.equal(r.status, 201, r.text);
    const [n] = await h.notifications(owner.id, 'club.request');
    assert.ok(n);
    assert.ok(!n.text.includes(other.phone));
    const url = n.actions[0].url;
    const token = new URL(url, 'https://x').searchParams.get('t');
    assert.match(url, new RegExp(`^/app/club-request/${r.json.id}\\?t=`));
    // Неверный токен — не найдено; верный — заявка с телефоном гостя.
    assert.equal((await h.request('GET', `/api/clubs/requests/${r.json.id}/answer?t=${'x'.repeat(43)}`)).status, 404);
    const v = await h.request('GET', `/api/clubs/requests/${r.json.id}/answer?t=${token}`);
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.guest_phone, other.phone);
    const a = await h.request('POST', `/api/clubs/requests/${r.json.id}/answer`, { body: { t: token, decision: 'accept', text: 'Ждём, стол 3' } });
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.status, 'accepted');
    assert.ok((await h.notifications(other.id, 'club.request_answer')).some((x) => /принял/.test(x.text)));
    // Ссылка одноразовая.
    assert.equal((await h.request('POST', `/api/clubs/requests/${r.json.id}/answer`, { body: { t: token, decision: 'decline' } })).status, 404);

    // Вторая заявка: клуб молчит 15 минут → оператору.
    const r2 = await h.request('POST', '/api/clubs/requests', { token: other.token, body: { listing_id: CARD_DEMO, starts_at: new Date(T0 + 300 * MIN).toISOString(), minutes: 60 } });
    h.clock.set(T0 + 44 * MIN);
    await h.tick();
    assert.equal((await h.request('GET', `/api/clubs/requests/${r2.json.id}`, { token: other.token })).json.status, 'sent');
    h.clock.set(T0 + 45 * MIN);
    await h.tick();
    assert.equal((await h.request('GET', `/api/clubs/requests/${r2.json.id}`, { token: other.token })).json.status, 'operator');
    // Гость отменяет.
    const cancel = await h.request('POST', `/api/clubs/requests/${r2.json.id}/cancel`, { token: other.token, body: {} });
    assert.equal(cancel.json.status, 'closed');
    await h.admin.query('update bl.club_public set contact_user_id = null where id = $1', [CARD_DEMO]);
  });

  it('«Добавить клуб» и «Подтвердить клуб» → оператору; одобрение создаёт и подтверждает карточку', async () => {
    const owner = await h.login('+79990001020');
    const add = await h.request('POST', '/api/directory/add', {
      token: owner.token,
      body: { city: 'Екатеринбург', name: 'Клуб «Шар и кий»', address: 'пр. Ленина, 10', phone: '8 (912) 000-11-22', hours_text: '12:00–02:00', disciplines: ['pool'] },
    });
    assert.equal(add.status, 201, add.text);
    assert.ok((await h.notifications(operator.id, 'platform.listing_add')).length >= 1);
    assert.equal((await h.request('GET', '/api/platform/listings', { token: guest.token })).status, 403);
    const list = await h.request('GET', '/api/platform/listings?status=new', { token: operator.token });
    const it1 = list.json.items.find((x) => x.id === add.json.id);
    assert.equal(it1.kind, 'add');
    assert.equal(it1.user.phone, owner.phone);
    const ap = await h.request('PATCH', `/api/platform/listings/${add.json.id}`, { token: operator.token, body: { action: 'approve' } });
    assert.equal(ap.status, 200, ap.text);
    assert.equal(ap.json.status, 'approved');
    assert.equal(ap.json.listing.path, '/ekaterinburg/klub-shar-i-kiy/');
    const card = (await h.q("select * from bl.club_public where slug = 'klub-shar-i-kiy'"))[0];
    assert.equal(card.status, 'listed');
    assert.equal(card.contact_user_id, owner.id);
    assert.equal(card.phone, '+79120001122');

    const claim = await h.request('POST', '/api/directory/claim', { token: owner.token, body: { listing_id: CARD_DEMO, comment: 'Я владелец' } });
    assert.equal(claim.status, 201, claim.text);
    const rej = await h.request('PATCH', `/api/platform/listings/${claim.json.id}`, { token: operator.token, body: { action: 'approve' } });
    assert.equal(rej.status, 200, rej.text);
    const demo = (await h.q('select status, contact_user_id from bl.club_public where id = $1', [CARD_DEMO]))[0];
    assert.deepEqual(demo, { status: 'claimed', contact_user_id: owner.id });
    assert.equal((await h.request('POST', '/api/directory/claim', { token: guest.token, body: { listing_id: CARD_DEMO } })).json.error, 'already_claimed');
    assert.equal((await h.audit('platform.listing_approve')).filter((a) => a.actor_id === operator.id && a.club_id === null).length, 2);
  });

  it('leads: антиспам (скрытое поле, время заполнения, лимит IP), согласие, уведомление Андрею, воронка оператора', async () => {
    const form = { name: 'Иван', club_name: 'Клуб Лузa', city: 'Пермь', phone: '+7 912 555-66-77', tables_count: 8, consent: true, website: '', elapsed_ms: 15_000 };
    const before = (await h.q('select count(*)::int as n from bl.leads'))[0].n;
    assert.equal((await h.request('POST', '/api/leads', { body: { ...form, website: 'http://spam' }, ip: '10.1.1.1' })).status, 201);
    assert.equal((await h.request('POST', '/api/leads', { body: { ...form, elapsed_ms: 800 }, ip: '10.1.1.2' })).status, 201);
    assert.equal((await h.q('select count(*)::int as n from bl.leads'))[0].n, before, 'бот без записи');
    assert.equal((await h.request('POST', '/api/leads', { body: { ...form, consent: false }, ip: '10.1.1.3' })).json.error, 'consent_required');
    const ok = await h.request('POST', '/api/leads', { body: form, ip: '10.1.1.4' });
    assert.equal(ok.status, 201, ok.text);
    const [lead] = await h.q('select * from bl.leads order by created_at desc limit 1');
    assert.equal(lead.phone, '+79125556677');
    assert.match(lead.ip_hash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(lead).includes('10.1.1.4'));
    const n = await h.notifications(admin.id, 'platform.lead');
    assert.equal(n.length, 1);
    assert.ok(!n[0].text.includes('5556677'));
    // Лимит по IP.
    let last;
    for (let i = 0; i < 6; i += 1) last = await h.request('POST', '/api/leads', { body: form, ip: '10.1.1.9' });
    assert.equal(last.status, 429);
    // Воронка: оператор видит телефон и меняет статус; гость — нет.
    assert.equal((await h.request('GET', '/api/platform/leads', { token: guest.token })).status, 403);
    const list = await h.request('GET', '/api/platform/leads?status=new', { token: admin.token });
    assert.ok(list.json.items.some((x) => x.id === lead.id && x.phone === '+79125556677'));
    const p = await h.request('PATCH', `/api/platform/leads/${lead.id}`, { token: operator.token, body: { status: 'contacted', note: 'Созвонились' } });
    assert.equal(p.json.status, 'contacted');
    assert.equal(p.json.note, 'Созвонились');
  });

  it('отзывы: только после игры за 90 дней, один на гостя, маска телефонов, ответ клуба, жалоба → оператор скрывает', async () => {
    h.clock.set(T0 + 60 * MIN);
    const author = await h.login('+79990001030');
    const no = await h.request('POST', '/api/reviews', { token: author.token, body: { club_id: CLUB_A, rating: 5, text: 'Отлично' } });
    assert.equal(no.status, 403);
    assert.equal(no.json.error, 'review_not_allowed');
    // Старая игра (100 дней назад) — не в счёт; свежая — можно.
    await h.session({ resourceId: table(4), payer: author.id, startedMs: T0 - 100 * 24 * 60 * MIN, paidUntilMs: T0 - 100 * 24 * 60 * MIN + 60 * MIN, status: 'closed' });
    assert.equal((await h.request('POST', '/api/reviews', { token: author.token, body: { club_id: CLUB_A, rating: 5 } })).status, 403);
    await h.session({ resourceId: table(5), payer: author.id, startedMs: T0 - 2 * 24 * 60 * MIN, paidUntilMs: T0 - 2 * 24 * 60 * MIN + 60 * MIN, status: 'closed' });
    const r1 = await h.request('POST', '/api/reviews', { token: author.token, body: { club_id: CLUB_A, rating: 4, text: 'Хорошо, звоните +7 912 345-67-89' } });
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r1.json.text, 'Хорошо, звоните ***');
    const r2 = await h.request('POST', '/api/reviews', { token: author.token, body: { club_id: CLUB_A, rating: 5, text: 'Ещё лучше' } });
    assert.equal(r2.json.id, r1.json.id, 'один отзыв на гостя и клуб');
    assert.equal((await h.request('GET', `/api/reviews/mine?club_id=${CLUB_A}`, { token: author.token })).json.rating, 5);
    // Ответ клуба — управляющий; автор отвечать не может (база).
    const rep = await h.request('POST', `/api/reviews/${r1.json.id}/reply`, { token: manager.token, club: CLUB_A, body: { text: 'Спасибо!' } });
    assert.equal(rep.status, 200, rep.text);
    assert.equal(rep.json.reply.text, 'Спасибо!');
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, userId: author.id, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, "update bl.reviews set reply_text = 'Ответ себе' where id = $1", [r1.json.id]))?.code, '42501');
    });
    // Публично: отзыв, ответ, без автора-человека.
    h.clock.add(2 * MIN); // кэш публичных ответов — 60 с
    const page = await h.request('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
    assert.equal(page.json.reviews.count, 1);
    assert.equal(page.json.reviews.avg, 5);
    assert.deepEqual(page.json.reviews.items[0].reply.text, 'Спасибо!');
    assert.ok(!page.text.includes(author.id));
    const club = await h.request('GET', `/api/clubs/${CLUB_A}/reviews`, { token: manager.token, club: CLUB_A });
    assert.equal(club.json.items[0].reported, false);
    // Жалоба → оператор скрывает → публично пропал.
    const rp = await h.request('POST', `/api/reviews/${r1.json.id}/report`, { token: other.token, body: { reason: 'Реклама' } });
    assert.equal(rp.status, 200, rp.text);
    assert.ok((await h.notifications(operator.id, 'platform.review_report')).length >= 1);
    const reps = await h.request('GET', '/api/platform/reports?status=new', { token: operator.token });
    const rid = reps.json.items.find((x) => x.review.id === r1.json.id).id;
    assert.equal((await h.request('PATCH', `/api/platform/reports/${rid}`, { token: operator.token, body: { action: 'hide' } })).json.error, 'reason_required');
    const hide = await h.request('PATCH', `/api/platform/reports/${rid}`, { token: operator.token, body: { action: 'hide', reason: 'Реклама' } });
    assert.equal(hide.json.review.status, 'hidden');
    h.clock.add(2 * MIN);
    assert.equal((await h.request('GET', '/api/public/clubs/ekaterinburg/testovyy-klub')).json.reviews.count, 0);
  });

  it('карточка клуба в программе: владелец и управляющий видят и правят описание, статус — только платформа', async () => {
    const g = await h.request('GET', `/api/clubs/${CLUB_A}/listing`, { token: manager.token, club: CLUB_A });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.status, 'platform');
    const p = await h.request('PATCH', `/api/clubs/${CLUB_A}/listing`, { token: manager.token, club: CLUB_A, body: { hours_text: 'Ежедневно 10:00–04:00', url: 'https://club.example' } });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.json.hours_text, 'Ежедневно 10:00–04:00');
    assert.equal((await h.request('PATCH', `/api/clubs/${CLUB_A}/listing`, { token: manager.token, club: CLUB_A, body: { url: 'http://insecure' } })).status, 400);
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, "update bl.club_public set status = 'listed' where club_id = $1", [CLUB_A]))?.code, '42501');
    });
  });

  it('RLS: заявки, отзывы, leads и заявки на карточки не видны чужим клубам и анонимам', async () => {
    await asRole(h.admin, 'app_api', { clubId: CLUB_B, actorType: 'user' }, async (c) => {
      for (const t of ['club_requests', 'directory_claims', 'leads', 'review_reports']) {
        assert.equal((await c.query(`select count(*)::int as n from bl.${t}`)).rows[0].n, 0, t);
      }
      assert.equal((await c.query("select count(*)::int as n from bl.reviews where status = 'hidden'")).rows[0].n, 0);
      assert.equal((await tryQuery(c, "update bl.club_public set name = 'Взлом' where id = $1", [CARD_A])), null);
      assert.equal((await h.q('select name from bl.club_public where id = $1', [CARD_A]))[0].name, 'Тестовый клуб');
    });
    await asRole(h.admin, 'app_api', { actorType: 'user' }, async (c) => {
      assert.equal((await c.query('select count(*)::int as n from bl.leads')).rows[0].n, 0);
      assert.equal((await c.query('select count(*)::int as n from bl.club_requests')).rows[0].n, 0);
      assert.ok((await c.query('select count(*)::int as n from bl.club_public')).rows[0].n >= 2);
      assert.equal((await tryQuery(c, "insert into bl.leads (name, club_name, city, phone, consent_version, ip_hash, created_at, updated_at) values ('x','x','x','+79120000000','v', repeat('a',64), now(), now())"))?.code, '42501');
    });
    // Роль платформы без подтверждения базой (чужой пользователь) — не даёт доступа.
    await asRole(h.admin, 'app_api', { userId: guest.id, actorType: 'user' }, async (c) => {
      await c.query("select set_config('app.platform_role', 'platform_operator', true)");
      assert.equal((await c.query('select count(*)::int as n from bl.leads')).rows[0].n, 0);
    });
  });
});
