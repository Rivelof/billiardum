// PoC M4: каталог, «Подтвердить клуб», заявки T25, роли платформы, отзывы, leads (№132–135, №139).
//
// НАХОДКА M4-4 (низкая): одобрение второй заявки «Подтвердить клуб» на уже подтверждённую карточку
// молча переписывает контакт карточки (server/directory/listings.mjs, patchPlatform ~стр. 230–233:
// статус карточки не перепроверяется, contact_user_id = заявитель). Заявки гостей с телефоном
// (T25) уходят новому «контакту». Проверка already_claimed есть только при подаче заявки (claim),
// поэтому заявка, поданная до одобрения настоящего владельца, остаётся «живой».
//
// НАХОДКА M4-5 (низкая): маскирование телефонов в отзыве обходится разделителями «.» и «/»
// (server/notify/index.mjs NUMBER_RUN = /\+?\d[\d\s()-]{6,}\d/): +7.912.345.67.89 публикуется
// на странице клуба как есть (server/directory/reviews.mjs upsert, ~стр. 58).
//
// ЗАМЕЧАНИЕ M4-I2: «время заполнения» leads — поле elapsed_ms от клиента; прямой POST /api/leads
// с elapsed_ms: 5000 проходит. Работает только лимит по IP (5 за 10 минут и 5 в сутки).
//
// Выдержало: токен ссылки T25 (чужая заявка, неверный, повтор, срок), лимит открытых заявок гостя,
// чужая заявка гостю — 404; экран оператора — только роли платформы (гость, владелец клуба — 403);
// bl.ctx_platform_role() не верит app.platform_role без строки platform_members; клуб не меняет
// статус, видимость, контакт и привязку карточки (триггер, 42501); отзыв — только после игры;
// ответ — только свой клуб и не ресепшн; город — slug только транслит, дубль — 409.
//
// Запуск: DATABASE_ADMIN_URL=… node --test --test-concurrency=1 tests/security/m4/directory_attacks.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CARD_A, CLUB_A, CLUB_B, MIN, PHONES, setup, T0, table } from '../../../server/directory/test/db/harness.mjs';

let h;
let operator;
before(async () => {
  h = await setup();
  operator = await h.login('+70000000010');
  await h.platformMember(operator.id, 'platform_operator');
});
after(async () => {
  await h?.close();
});

let n = 0;
const phone = () => `+7999300${String((n += 1)).padStart(4, '0')}`;

async function newCard(name) {
  const r = await h.request('POST', '/api/platform/cards', {
    token: operator.token,
    body: { city_slug: 'ekaterinburg', name, address: 'ул. Пентеста, 7', phone: '+73430000000', disciplines: ['pool'] },
  });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}

// M4-4 закрыто в ef78f68; нужна база. Регресс — тест backend server/directory/test/db/directory.test.mjs
// (test:db): одобрение «Подтвердить клуб» только пока карточка listed, остальные открытые заявки отклоняются.
test.skip('НАХОДКА M4-4 (низкая): вторая одобренная заявка «Подтвердить клуб» перехватывает контакт подтверждённой карточки — телефоны гостей уходят ей', async () => {
  const card = await newCard('Клуб под захват');
  const realOwner = await h.login(phone());
  const attacker = await h.login(phone());
  // Обе заявки поданы, пока карточка listed.
  const cOwner = await h.request('POST', '/api/directory/claim', { token: realOwner.token, body: { listing_id: card, comment: 'Я владелец, ИНН …' } });
  const cAttacker = await h.request('POST', '/api/directory/claim', { token: attacker.token, body: { listing_id: card, comment: 'Управляющий' } });
  assert.equal(cOwner.status, 201);
  assert.equal(cAttacker.status, 201);
  // Оператор одобряет настоящего владельца.
  let r = await h.request('PATCH', `/api/platform/listings/${cOwner.json.id}`, { token: operator.token, body: { action: 'approve', reason: 'документы' } });
  assert.equal(r.status, 200, r.text);
  let [c] = await h.q('select status, contact_user_id from bl.club_public where id = $1', [card]);
  assert.equal(c.contact_user_id, realOwner.id);
  // Новая заявка на ту же карточку уже отклоняется…
  r = await h.request('POST', '/api/directory/claim', { token: (await h.login(phone())).token, body: { listing_id: card } });
  assert.equal(r.json.error, 'already_claimed');
  // …а старая заявка злоумышленника одобряется без ошибки (оператор разбирает очередь).
  r = await h.request('PATCH', `/api/platform/listings/${cAttacker.json.id}`, { token: operator.token, body: { action: 'approve' } });
  console.log(`  одобрение второй заявки на claimed-карточку: HTTP ${r.status}`);
  assert.equal(r.status, 200, 'ожидалось 409 already_claimed');
  [c] = await h.q('select status, contact_user_id from bl.club_public where id = $1', [card]);
  assert.equal(c.contact_user_id, attacker.id, 'контакт карточки — злоумышленник');
  // Гость оставляет заявку — ссылка с токеном приходит злоумышленнику, он видит телефон гостя.
  const guest = await h.login(phone());
  h.clock.set(T0 + 10 * MIN);
  const req = await h.request('POST', '/api/clubs/requests', { token: guest.token, body: { listing_id: card, starts_at: new Date(T0 + 200 * MIN).toISOString(), minutes: 60 } });
  assert.equal(req.status, 201, req.text);
  const [note] = await h.notifications(attacker.id, 'club.request');
  assert.ok(note, 'уведомление со ссылкой — злоумышленнику');
  assert.equal((await h.notifications(realOwner.id, 'club.request')).length, 0, 'настоящий владелец заявку не получил');
  const token = new URL(note.actions[0].url, 'https://x').searchParams.get('t');
  const v = await h.request('GET', `/api/clubs/requests/${req.json.id}/answer?t=${token}`);
  assert.equal(v.status, 200);
  assert.equal(v.json.guest_phone, guest.phone, 'телефон гостя у злоумышленника');
});

test('выдержало: ссылка T25 — только своя заявка, верный токен, один раз, 24 часа; брутфорс упирается в 30/мин', async () => {
  const contact = await h.login(phone());
  const card = await newCard('Клуб для токенов');
  await h.admin.query('update bl.club_public set contact_user_id = $2 where id = $1', [card, contact.id]);
  const guest = await h.login(phone());
  h.clock.set(T0 + 20 * MIN);
  const mk = async () => (await h.request('POST', '/api/clubs/requests', { token: guest.token, body: { listing_id: card, starts_at: new Date(T0 + 300 * MIN).toISOString(), minutes: 60 } })).json.id;
  const r1 = await mk();
  const r2 = await mk();
  const notes = await h.notifications(contact.id, 'club.request');
  const tok = (id) => new URL(notes.find((x) => x.data.request_id === id).actions[0].url, 'https://x').searchParams.get('t');
  // Токен заявки 1 к заявке 2 — нет.
  assert.equal((await h.request('GET', `/api/clubs/requests/${r2}/answer?t=${tok(r1)}`)).status, 404);
  assert.equal((await h.request('POST', `/api/clubs/requests/${r2}/answer`, { body: { t: tok(r1), decision: 'accept' } })).status, 404);
  // Третья открытая заявка ещё можно, четвёртая — лимит гостя.
  await mk();
  const r4 = await h.request('POST', '/api/clubs/requests', { token: guest.token, body: { listing_id: card, starts_at: new Date(T0 + 300 * MIN).toISOString(), minutes: 60 } });
  assert.equal(r4.json.error, 'limit_exceeded');
  // Чужой гость — 404 на заявку, отмена чужой — 404.
  const other = await h.login(phone());
  assert.equal((await h.request('GET', `/api/clubs/requests/${r1}`, { token: other.token })).status, 404);
  assert.equal((await h.request('POST', `/api/clubs/requests/${r1}/cancel`, { token: other.token })).status, 404);
  // Срок 24 часа.
  h.clock.set(T0 + 20 * MIN + 24 * 60 * MIN + 1000);
  assert.equal((await h.request('GET', `/api/clubs/requests/${r2}/answer?t=${tok(r2)}`)).status, 404, 'просрочен');
  // Перебор: 31-й запрос с одного IP — 429.
  let last = 0;
  for (let i = 0; i < 31; i += 1) last = (await h.request('GET', `/api/clubs/requests/${r1}/answer?t=${randomUUID()}${randomUUID()}`, { ip: '203.0.113.77' })).status;
  assert.equal(last, 429);
});

test('выдержало: экран оператора — только роли платформы; ctx_platform_role не верит одному app.platform_role', async () => {
  const guest = await h.login(phone());
  const owner = await h.login(PHONES.owner);
  for (const path of ['/api/platform/requests', '/api/platform/leads', '/api/platform/listings', '/api/platform/reports', '/api/platform/cities']) {
    assert.equal((await h.request('GET', path, { token: guest.token })).status, 403, `гость ${path}`);
    assert.equal((await h.request('GET', path, { token: owner.token })).status, 403, `владелец клуба ${path}`);
    assert.equal((await h.request('GET', path, { token: owner.token, club: CLUB_A })).status, 403, `владелец клуба с x-club-id ${path}`);
  }
  await h.admin.query(
    "insert into bl.leads (name, club_name, city, phone, consent_version, ip_hash, created_at, updated_at) values ('x', 'Видимость', 'Е', '+79120000001', 'v', repeat('a', 64), now(), now())",
  );
  // База: пользователь без строки platform_members с app.platform_role = platform_admin — NULL, данных платформы нет.
  const c = await h.pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.user_id', $1, true), set_config('app.platform_role', 'platform_admin', true), set_config('app.actor_type', 'support', true)", [owner.id]);
    assert.equal((await c.query('select bl.ctx_platform_role() as r')).rows[0].r, null);
    assert.equal((await c.query('select count(*)::int as n from bl.leads')).rows[0].n, 0, 'leads не видны');
    // Контроль: настоящий оператор с ролью видит leads.
    await c.query('savepoint s');
    await c.query("select set_config('app.user_id', $1, true), set_config('app.platform_role', 'platform_operator', true)", [operator.id]);
    assert.ok((await c.query('select count(*)::int as n from bl.leads')).rows[0].n >= 1, 'оператор видит');
    await c.query('rollback to savepoint s');
    // Оператор, выдающий себя за администратора, — тоже NULL.
    await c.query("select set_config('app.user_id', $1, true)", [operator.id]);
    assert.equal((await c.query('select bl.ctx_platform_role() as r')).rows[0].r, null);
    // Платформенная роль в контексте клуба — NULL.
    await c.query("select set_config('app.platform_role', 'platform_operator', true), set_config('app.club_id', $1, true)", [CLUB_A]);
    assert.equal((await c.query('select bl.ctx_platform_role() as r')).rows[0].r, null);
    await c.query('rollback');
  } finally {
    c.release();
  }
});

test('выдержало: клуб не меняет статус, видимость, контакт и привязку своей карточки (триггер 42501)', async () => {
  const manager = await h.login(PHONES.manager);
  const r = await h.request('PATCH', `/api/clubs/${CLUB_A}/listing`, { token: manager.token, body: { status: 'listed', visible: false, club_id: CLUB_B, contact_user_id: manager.id, slug: 'x', description: 'ок' } });
  assert.equal(r.status, 200, r.text);
  const [card] = await h.q('select status, visible, club_id, slug, description from bl.club_public where id = $1', [CARD_A]);
  assert.deepEqual([card.status, card.visible, card.club_id], ['platform', true, CLUB_A], 'лишние поля тела игнорируются');
  const c = await h.pool.connect();
  try {
    for (const set of ["status = 'listed'", 'visible = false', `contact_user_id = '${manager.id}'`, "slug = 'pwn'"]) {
      await c.query('begin');
      await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [CLUB_A, manager.id]);
      await assert.rejects(c.query(`update bl.club_public set ${set} where id = $1`, [CARD_A]), (e) => e.code === '42501', set);
      await c.query('rollback');
    }
    // Чужую карточку клуб не видит для правки.
    await c.query('begin');
    await c.query("select set_config('app.club_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_type', 'user', true)", [CLUB_B, manager.id]);
    const u = await c.query("update bl.club_public set description = 'pwn' where id = $1", [CARD_A]);
    assert.equal(u.rowCount, 0);
    await c.query('rollback');
  } finally {
    c.release();
  }
});

// M4-5 закрыто в ef78f68; нужна база. Регресс маски — без базы в phone_mask_recheck.test.mjs (точки, косая
// черта, невидимые символы маскируются); на пути отзыва — тест backend server/directory/test/db/directory.test.mjs
// (test:db). Утверждения «телефон с точками/косой чертой опубликован» ниже теперь ложны: номер маскируется.
test.skip('отзывы: без игры — 403; телефон с пробелами и дефисами маскируется; НАХОДКА M4-5 (низкая) — с точками и косой чертой публикуется', async () => {
  const guest = await h.login(phone());
  let r = await h.request('POST', '/api/reviews', { token: guest.token, body: { club_id: CLUB_A, rating: 1, text: 'нет игры' } });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'review_not_allowed');
  await h.session({ resourceId: table(7), payer: guest.id, startedMs: h.clock.now().getTime() - 60 * MIN });
  const text = 'Админ Ольга <script>alert(1)</script> +7 (912) 345-67-89, 8-912-345-67-80, +7.912.345.67.81, 8/912/345/67/82';
  r = await h.request('POST', '/api/reviews', { token: guest.token, body: { club_id: CLUB_A, rating: 2, text } });
  assert.equal(r.status, 200, r.text);
  const pub = await h.request('GET', '/api/public/clubs/ekaterinburg/testovyy-klub');
  const mine = pub.json.reviews.items.find((x) => x.id === r.json.id);
  console.log(`  опубликовано: ${mine.text}`);
  assert.ok(!mine.text.includes('345-67-89') && !mine.text.includes('345-67-80'), 'привычные форматы скрыты');
  assert.ok(mine.text.includes('+7.912.345.67.81'), 'НАХОДКА: телефон с точками опубликован');
  assert.ok(mine.text.includes('8/912/345/67/82'), 'НАХОДКА: телефон с косой чертой опубликован');
  assert.ok(!('user_id' in mine), 'автора-человека в публичном отзыве нет');
});

test('выдержало: ответ на отзыв — только owner/manager своего клуба', async () => {
  const [rv] = await h.q('select id from bl.reviews where club_id = $1 limit 1', [CLUB_A]);
  const ownerB = await h.login(PHONES.ownerB);
  const reception = await h.login(PHONES.reception);
  let r = await h.request('POST', `/api/reviews/${rv.id}/reply`, { token: ownerB.token, body: { text: 'чужой клуб' } });
  assert.ok([403, 404].includes(r.status), `владелец B: ${r.status}`);
  r = await h.request('POST', `/api/reviews/${rv.id}/reply`, { token: reception.token, body: { text: 'ресепшн' } });
  assert.equal(r.status, 403);
  const [after] = await h.q('select reply_text from bl.reviews where id = $1', [rv.id]);
  assert.equal(after.reply_text, null);
});

test('ЗАМЕЧАНИЕ M4-I2: «время заполнения» leads задаёт клиент; лимит по IP держит', async () => {
  const body = { name: 'Бот', club_name: 'Спам', city: 'Екатеринбург', phone: '+79120000000', consent: true, website: '', elapsed_ms: 5000 };
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await h.request('POST', '/api/leads', { body, ip: '198.51.100.9' })).status);
  console.log(`  прямой POST /api/leads x6 с одного IP: ${statuses.join(',')}`);
  assert.deepEqual(statuses.slice(0, 5), [201, 201, 201, 201, 201], 'проверка времени обходится полем от клиента');
  assert.equal(statuses[5], 429, 'лимит по IP');
  const rows = await h.q("select count(*)::int as n from bl.leads where club_name = 'Спам'");
  assert.equal(rows[0].n, 5);
});

test('выдержало: города — slug только транслит, дубль 409, название с разметкой хранится как текст', async () => {
  for (const slug of ['../admin', 'Moskva', 'a b', 'ekaterinburg/../x', 'x'.repeat(61)]) {
    const r = await h.request('POST', '/api/platform/cities', { token: operator.token, body: { slug, name: 'Город', name_in: 'в Городе', timezone: 'Europe/Moscow' } });
    assert.equal(r.status, 400, `${slug}: ${r.text}`);
  }
  const dup = await h.request('POST', '/api/platform/cities', { token: operator.token, body: { slug: 'ekaterinburg', name: 'Е', name_in: 'в Е', timezone: 'Asia/Yekaterinburg' } });
  assert.equal(dup.status, 409);
  const tz = await h.request('POST', '/api/platform/cities', { token: operator.token, body: { name: 'Город', name_in: 'в Городе', timezone: 'EST' } });
  assert.equal(tz.status, 400);
  void MIN;
});
