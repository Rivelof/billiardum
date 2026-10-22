// Волна B M2 (decisions №95, №97, №98): скидка выше лимита по PIN управляющего на терминале,
// отмена неоплаченной СБП-продажи и возврат поздней оплаты, настройки кассы ресепшну на чтение,
// фискальные признаки чека в ответе продажи, роль бармена (bar).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { hashPin } from '../../../auth/pin.mjs';
import { CLUB_A, newKey, P, PHONES, setup, waitFor } from './harness.mjs';

const SKIP = !process.env.DATABASE_ADMIN_URL;
const MANAGER_ID = 'a1000000-0000-4000-8000-000000000003';
const RECEPTION_ID = 'a1000000-0000-4000-8000-000000000004';
let h;
let reception;

let bar;

before(async () => {
  if (SKIP) return;
  h = await setup();
  reception = await h.login(PHONES.reception);

  bar = await h.login('+79990000901');
  await h.q("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'bar')", [CLUB_A, bar.id]);
  const pin = await hashPin('2468', h.config.pinPepper);
  await h.q('update bl.club_members set pin_hash = $3 where club_id = $1 and user_id = $2', [CLUB_A, MANAGER_ID, pin]);
  await h.q('update bl.club_members set pin_hash = $3 where club_id = $1 and user_id = $2', [CLUB_A, RECEPTION_ID, pin]);
  await h.openShift();
});

after(async () => {
  await h?.close();
});

const post = (path, token, body, key) => h.request('POST', path, { token, body, club: CLUB_A, ...(key ? { key } : {}) });
const sale = (token, body) => post('/api/pos/sales', token, body, newKey());

describe('скидка по PIN управляющего (№95)', { skip: SKIP }, () => {
  const approve = (body) => post('/api/pos/discount-approvals', reception.token, {
    user_id: MANAGER_ID, pin: '2468', reason_code: 'regular_guest', reason_text: 'Постоянный гость', amount_kopecks: 5000, subtotal_kopecks: 18000, ...body,
  });

  it('кто подтверждает: управляющие и владельцы с PIN', async () => {
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/staff/approvers`, { token: reception.token });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, [{ user_id: MANAGER_ID, name: 'Управляющий (тест)', role: 'manager' }]);
    const denied = await h.request('GET', `/api/clubs/${CLUB_A}/staff/approvers`, { token: bar.token });
    assert.equal(denied.status, 403);
  });

  it('PIN ресепшна не подтверждает (403); неверный PIN — 401; без причины — reason_required', async () => {
    assert.equal((await approve({ user_id: RECEPTION_ID })).status, 403);
    assert.equal((await approve({ pin: '1111' })).status, 401);
    const [m] = await h.q('select pin_failed_count from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, MANAGER_ID]);
    assert.equal(m.pin_failed_count, 1, 'счётчик ошибок закоммичен');
    assert.deepEqual([(await approve({ reason_text: '  ' })).json.error], ['reason_required']);
  });

  it('подтверждённая скидка выше лимита: продажа ресепшна проходит, журнал от управляющего, тревога владельцу', async () => {
    assert.equal((await approve({ subtotal_kopecks: undefined })).status, 400, 'без суммы корзины одобрения нет (№100)');
    const ap = await approve({});
    assert.equal(ap.status, 201, JSON.stringify(ap.json));
    assert.ok(ap.json.approval_id);
    assert.deepEqual([ap.json.subtotal_kopecks, ap.json.max_discount_kopecks], [18000, 5000]);
    // №100 (pentester L1): одобрение на корзину 180 ₽ не применяется к корзине крупнее.
    const big = await sale(reception.token, { items: [{ product_id: P.nuts, qty: 2 }], method: 'card_terminal', discount: { amount_kopecks: 5000, approval_id: ap.json.approval_id } });
    assert.deepEqual([big.status, big.json.error], [403, 'forbidden']);
    const [m] = await h.q('select pin_failed_count from bl.club_members where club_id = $1 and user_id = $2', [CLUB_A, MANAGER_ID]);
    assert.equal(m.pin_failed_count, 0, 'верный PIN сбрасывает счётчик');
    // Без подтверждения ресепшну — limit_exceeded.
    const body = { items: [{ product_id: P.nuts, qty: 1 }], method: 'card_terminal' };
    const no = await sale(reception.token, { ...body, discount: { amount_kopecks: 5000 } });
    assert.deepEqual([no.status, no.json.error], [400, 'limit_exceeded']);
    const other = await sale(reception.token, { ...body, discount: { amount_kopecks: 4000, approval_id: ap.json.approval_id } });
    assert.deepEqual([other.status, other.json.error], [403, 'forbidden'], 'подтверждение другой скидки');
    const ok = await sale(reception.token, { ...body, discount: { amount_kopecks: 5000, approval_id: ap.json.approval_id } });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.total_kopecks, 13000);
    const [a] = (await h.audit('manual.discount')).filter((x) => x.object_id === ok.json.sale_id);
    assert.equal(a.actor_id, MANAGER_ID);
    assert.equal(a.reason, 'Постоянный гость');
    assert.equal(a.data.cashier_id, RECEPTION_ID);
    assert.ok((await h.audit('pos.discount_approval')).some((x) => x.actor_id === MANAGER_ID));
    const [al] = await h.alarms('discount_over_limit');
    assert.ok(al);
    assert.ok((await h.q("select 1 from bl.notifications where kind = 'alarm' and text like '%подтвердил Управляющий (тест)%'")).length >= 1);
    const again = await sale(reception.token, { ...body, discount: { amount_kopecks: 5000, approval_id: ap.json.approval_id } });
    assert.deepEqual([again.status, again.json.error], [403, 'forbidden'], 'подтверждение одноразовое');
  });

  it('подтверждение истекает через 5 минут', async () => {
    const ap = await approve({ amount_kopecks: undefined, percent: 30, subtotal_kopecks: 9000 });
    assert.equal(ap.status, 201);
    await h.q("update bl.pos_discount_approvals set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1", [ap.json.approval_id]);
    const r = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'card_terminal', discount: { percent: 30, approval_id: ap.json.approval_id } });
    assert.deepEqual([r.status, r.json.error], [403, 'forbidden']);
  });

  it('5 неверных PIN подряд — блокировка 15 минут (общая с входом по PIN)', async () => {
    for (let i = 0; i < 4; i += 1) assert.equal((await approve({ pin: '0000' })).status, 401);
    const fifth = await approve({ pin: '0000' });
    assert.equal(fifth.status, 401);
    const locked = await approve({});
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 800);
    await h.q('update bl.club_members set pin_locked_until = null, pin_failed_count = 0 where club_id = $1 and user_id = $2', [CLUB_A, MANAGER_ID]);
  });
});

describe('одобрение процентом и сумма корзины (№100)', { skip: SKIP }, () => {
  it('«50 %» на маленькую корзину: к крупной — 403, к такой же или меньшей — применяется', async () => {
    const mk = () => post('/api/pos/discount-approvals', reception.token, {
      user_id: MANAGER_ID, pin: '2468', reason_code: 'promo', reason_text: 'Акция', percent: 50, subtotal_kopecks: 18000,
    });
    const a1 = await mk();
    assert.deepEqual([a1.status, a1.json.max_discount_kopecks], [201, 9000]);
    const big = await sale(reception.token, { items: [{ product_id: P.water, qty: 10 }], method: 'card_terminal', discount: { percent: 50, approval_id: a1.json.approval_id } });
    assert.deepEqual([big.status, big.json.error], [403, 'forbidden'], '90 000 коп. корзины при одобрении на 18 000');
    const small = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'card_terminal', discount: { percent: 50, approval_id: a1.json.approval_id } });
    assert.equal(small.status, 201, JSON.stringify(small.json));
    assert.equal(small.json.discount_kopecks, 4500);
  });
});

describe('отмена неоплаченной СБП-продажи (№98)', { skip: SKIP }, () => {
  it('ресепшн снимает QR; поздняя оплата возвращается автоматически, тревога', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.chips, qty: 2 }], method: 'sbp' });
    assert.equal(res.json.status, 'pending');
    const byBar = await post(`/api/pos/sales/${res.json.sale_id}/cancel`, bar.token, {});
    assert.equal(byBar.status, 403);
    const c = await post(`/api/pos/sales/${res.json.sale_id}/cancel`, reception.token, { reason: 'Гость передумал' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.status, 'canceled');
    assert.equal(c.json.confirmation, undefined, 'QR снят');
    const [o] = await h.q('select o.status from bl.orders o join bl.pos_sale_items si on si.order_id = o.id where si.sale_id = $1', [res.json.sale_id]);
    assert.equal(o.status, 'canceled');
    assert.ok((await h.audit('pos.sale_canceled')).some((a) => a.object_id === res.json.sale_id && a.actor_id === RECEPTION_ID && a.reason === 'Гость передумал'));
    // Гость всё же оплатил QR.
    await h.emuSucceed(await h.providerId(res.json.payment_id));
    await waitFor(async () => (await h.q('select refunded_kopecks from bl.pos_sales where id = $1', [res.json.sale_id]))[0].refunded_kopecks === '30000');
    const [f] = await h.q('select * from bl.refunds where payment_id = $1', [res.json.payment_id]);
    assert.equal(Number(f.amount_kopecks), 30000);
    assert.equal(f.status, 'succeeded');
    const [pr] = await h.q('select kind from bl.pos_refunds where sale_id = $1', [res.json.sale_id]);
    assert.equal(pr.kind, 'late');
    assert.equal((await h.alarms('bar_late_payment')).length, 1);
    await h.tick();
    assert.equal((await h.q('select count(*)::int as n from bl.refunds where payment_id = $1', [res.json.payment_id]))[0].n, 1, 'возврат один раз');
  });

  it('оплаченную продажу не отменить — 409 already_paid', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'sbp' });
    await h.emuSucceed(await h.providerId(res.json.payment_id));
    await waitFor(async () => (await h.q('select status from bl.pos_sales where id = $1', [res.json.sale_id]))[0].status === 'completed');
    const c = await post(`/api/pos/sales/${res.json.sale_id}/cancel`, reception.token, {});
    assert.deepEqual([c.status, c.json.error], [409, 'already_paid']);
  });
});

describe('настройки, чек, роль бармена', { skip: SKIP }, () => {
  it('настройки кассы: ресепшн читает лимит скидки, менять — только владелец', async () => {
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/pos/settings`, { token: reception.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.discount_limit_percent, 10);
    const w = await h.request('PATCH', `/api/clubs/${CLUB_A}/pos/settings`, { token: reception.token, body: { discount_limit_percent: 50 } });
    assert.equal(w.status, 403);
  });

  it('ответ продажи — receipt_status, receipt_fd, receipt_fp (после пробития ККТ)', async () => {
    const res = await sale(reception.token, { items: [{ product_id: P.water, qty: 1 }], method: 'cash', received_kopecks: 10000 });
    assert.equal(res.json.receipt_status, 'receipt_pending');
    assert.equal(res.json.receipt_fd, null);
    assert.equal(res.json.receipt_fp, null);
    await h.q("update bl.receipts set status = 'printed', fd = 12345, fp = '987654321', fn = '9999078900012345', printed_at = now() where id = $1", [res.json.receipt_id]);
    const g = await h.request('GET', `/api/pos/sales/${res.json.sale_id}`, { token: reception.token, club: CLUB_A });
    assert.deepEqual([g.json.receipt_status, g.json.receipt_fd, g.json.receipt_fp], ['printed', 12345, '987654321']);
  });

  it('бармен: очередь, статусы, стоп-лист (SSE stop_list); без отмены, кассы, возвратов и счетов', async () => {
    const guest = await h.login('+79990000902');
    const sid = await h.session({ resourceId: 'e1000000-0000-4000-8000-000000000007', payer: guest.id });
    const o = await h.request('POST', '/api/orders', { token: guest.token, body: { session_id: sid, items: [{ product_id: P.teaBlack, qty: 1 }], pay: 'tab' }, key: newKey() });
    assert.equal(o.status, 201);
    const q = await h.request('GET', `/api/clubs/${CLUB_A}/bar/queue`, { token: bar.token });
    assert.equal(q.status, 200);
    assert.ok(q.json.some((x) => x.id === o.json.order.id));
    const st = await post(`/api/orders/${o.json.order.id}/status`, bar.token, { status: 'ready' });
    assert.equal(st.json.status, 'ready');
    const cancel = await post(`/api/orders/${o.json.order.id}/status`, bar.token, { status: 'canceled', reason: 'нет' });
    assert.equal(cancel.status, 403);
    const stop = await post(`/api/catalog/products/${P.teaBlack}/stop-list`, bar.token, { stop_list: true });
    assert.equal(stop.json.stop_list, true);
    assert.ok(h.sseEvents.some((e) => e.channel === `club:${CLUB_A}` && e.event === 'stop_list' && e.data.product_id === P.teaBlack && e.data.stop_list === true));
    await post(`/api/catalog/products/${P.teaBlack}/stop-list`, bar.token, { stop_list: false });
    const menu = await h.request('GET', `/api/clubs/${CLUB_A}/menu`, { token: bar.token });
    assert.equal(menu.json.audience, 'staff');
    assert.equal((await sale(bar.token, { items: [{ product_id: P.water, qty: 1 }], method: 'card_terminal' })).status, 403);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/tabs`, { token: bar.token })).status, 403);
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/pos/sales`, { token: bar.token })).status, 403);
    assert.equal((await h.request('PATCH', `/api/catalog/products/${P.teaBlack}`, { token: bar.token, body: { price_kopecks: 1 } })).status, 403);
    const anySale = (await h.q('select id from bl.pos_sales where status = $1 limit 1', ['completed']))[0].id;
    assert.equal((await post(`/api/pos/sales/${anySale}/refund`, bar.token, { reason: 'x' }, newKey())).status, 403);
    assert.equal((await h.request('GET', `/api/sessions/${sid}/tab`, { token: bar.token })).status, 404);
  });
});
