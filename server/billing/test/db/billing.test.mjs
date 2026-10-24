// Подписка клубов (M5.3) на настоящем Postgres и эмуляторе ЮKassa: T31 «Подписка без участия
// людей» на подставных часах и T32 «Безопасность денег платформы».

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { asRole, tryQuery } from '../../../../supabase/tests/helpers.mjs';
import { getSubscription } from '../../service.mjs';
import { handlePlatformWebhook } from '../../webhook.mjs';
import { loadBillingConfig } from '../../config.mjs';
import { CLUB_A, CLUB_B, CLUB_SHOP, PHONES, PLAN_CLUB, PLATFORM_SHOP, setup } from './harness.mjs';

let h;
const MIN = 60_000;
const DAY = 86_400_000;
const EMAIL_A = 'owner-a@club.test';

before(async () => {
  h = await setup();
});
after(async () => {
  await h?.stop();
});

const sub = async (club) => (await h.q('select * from bl.club_subscriptions where club_id = $1', [club]))[0];
const invoices = (club) => h.q('select * from bl.billing_invoices where club_id = $1 order by period_start', [club]);
const notes = (userId, kind) => h.q('select text, level, data from bl.notifications where user_id = $1 and kind = $2 order by created_at', [userId, kind]);
const platformAudit = (action) => h.q('select actor_type, actor_id, reason, data from bl.audit_log where club_id is null and action = $1 order by seq', [action]);
const guestPayments = async () => (await h.q('select count(*)::int as n from bl.payments'))[0].n;

/** Привязать карту владельцем: страница ЮKassa → «Оплатить» → вебхук сохраняет способ и снимает заморозку. */
async function bindCard(owner, club, email) {
  const r = await h.request('POST', `/api/clubs/${club}/subscription/card`, { token: owner.token, body: { email } });
  assert.equal(r.status, 201, r.text);
  const [pay] = await h.q('select provider_payment_id, purpose from bl.billing_payments where id = $1', [r.json.payment_id]);
  await h.emuApi('POST', `/__emu/payments/${pay.provider_payment_id}/succeed?wait=1`);
  await h.waitFor(async () => (await sub(club))?.autopay === true);
  await h.emu.settle();
  return { ...r.json, provider_payment_id: pay.provider_payment_id };
}

describe('T31. Подписка без участия людей', () => {
  let ownerA;
  let managerA;
  let andrey;

  before(async () => {
    ownerA = await h.login(PHONES.ownerA);
    managerA = await h.login(PHONES.managerA);
    andrey = await h.login(PHONES.andrey);
  });

  it('клуб в test не платит; переход в live — пробный период 60 дней по поясу клуба (outbox club.went_live)', async () => {
    const owner = await h.login('+79990001101');
    const created = await h.request('POST', '/api/clubs', { token: owner.token, body: { name: 'Клуб Т', city_name: 'Пермь', timezone: 'Asia/Yekaterinburg' } });
    assert.equal(created.status, 201, created.text);
    const club = { id: created.json.club_id };
    const before = await h.request('GET', `/api/clubs/${club.id}/subscription`, { token: owner.token });
    assert.equal(before.status, 200, before.text);
    assert.deepEqual([before.json.mode, before.json.state, before.json.trial_until, before.json.next_invoice], ['test', 'trial', null, null]);
    assert.equal(await sub(club.id), undefined, 'клубы в test не платят');
    const card = await h.request('POST', `/api/clubs/${club.id}/subscription/card`, { token: owner.token, body: { email: 'o@club.test' } });
    assert.deepEqual([card.status, card.json.error], [409, 'billing_unavailable']);

    // Переход в live: владелец узкой функцией (как POST …/go-live), событие club.went_live в outbox.
    const wentLive = await h.asApp({ clubId: club.id, userId: owner.id, actorType: 'user' }, async (c) => {
      const at = (await c.query("select bl.club_go_live($1, '2026-10-23') as at", [club.id])).rows[0].at;
      await c.query("insert into bl.outbox (club_id, topic, payload) values ($1, 'club.went_live', $2)", [club.id, { club_id: club.id }]);
      return at;
    });
    const s = await h.waitFor(() => sub(club.id));
    const startLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(wentLive);
    const end = new Date(`${startLocal}T00:00:00+05:00`);
    end.setUTCDate(end.getUTCDate() + 60);
    assert.equal(s.trial_started_at.toISOString(), wentLive.toISOString());
    assert.equal(s.trial_until.toISOString(), end.toISOString(), 'конец пробного периода — местная полночь через 60 суток');
    assert.equal(s.anchor_day, Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg', day: 'numeric' }).format(end)));
    assert.equal(s.paid_until, null);
    const after = await h.request('GET', `/api/clubs/${club.id}/subscription`, { token: owner.token });
    assert.deepEqual([after.json.mode, after.json.state, after.json.trial_until], ['live', 'trial', end.toISOString()]);
  });

  it('клубы, которые работали до M5.3, — пробный период с выкатки; владелец видит план, цену, столы, следующий счёт', async () => {
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token });
    assert.equal(r.status, 200, r.text);
    const [{ released_at: released }] = await h.q('select released_at from bl.billing_settings');
    const s = await sub(CLUB_A);
    assert.equal(s.trial_started_at.toISOString(), released.toISOString());
    assert.equal(r.json.state, 'trial');
    assert.deepEqual(r.json.plan, { id: PLAN_CLUB, code: 'club', title: 'Клуб' });
    assert.equal(r.json.price_per_table_kopecks, 79000);
    assert.equal(r.json.tables, 8);
    assert.equal(r.json.trial_days, 60);
    assert.deepEqual(r.json.next_invoice, { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(s.trial_until), amount_kopecks: 8 * 79000, invoice_id: null });
    assert.deepEqual([r.json.card, r.json.autopay, r.json.banner, r.json.paid_until], [null, false, null, null]);
    // Управляющий — только состояние и плашка.
    const m = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: managerA.token });
    assert.deepEqual(Object.keys(m.json).sort(), ['banner', 'mode', 'paid_until', 'state', 'trial_until']);
  });

  it('за 7 дней до конца пробного периода без карты — плашка и уведомление владельцу и управляющему (один раз)', async () => {
    const s = await sub(CLUB_A);
    h.setNow(s.trial_until.getTime() - 6 * DAY - 3_600_000);
    await h.tick();
    await h.tick();
    const n = await notes(ownerA.id, 'billing.reminder');
    assert.equal(n.length, 1);
    assert.match(n[0].text, /Пробный период «Бильярдум» истекает через 7 дней/);
    assert.equal((await notes(managerA.id, 'billing.reminder')).length, 1);
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: managerA.token });
    assert.deepEqual([r.json.banner.kind, r.json.banner.days_left], ['trial_ending', 7]);
  });

  it('владелец привязывает карту (save_payment_method, 1 ₽ заморозкой с отменой): автоплатёж включён, плашки нет', async () => {
    const before = await guestPayments();
    const bad = await h.request('POST', `/api/clubs/${CLUB_A}/subscription/card`, { token: ownerA.token, body: {} });
    assert.deepEqual([bad.status, bad.json.error], [400, 'bad_request'], 'email для чека обязателен');
    const evil = await h.request('POST', `/api/clubs/${CLUB_A}/subscription/card`, { token: ownerA.token, body: { email: EMAIL_A, return_url: 'https://evil.test/x' } });
    assert.equal(evil.status, 400, 'return_url только на свой адрес');
    const bound = await bindCard(ownerA, CLUB_A, EMAIL_A);
    assert.equal(bound.purpose, 'bind');
    assert.equal(bound.amount_kopecks, 100);
    assert.match(bound.confirmation_url, /\/pay\//);
    const remote = await h.emuApi('GET', `/__emu/payments/${bound.provider_payment_id}`);
    assert.equal(remote.status, 'canceled', 'заморозка 1 ₽ снята — денег клуб не платил');
    assert.equal(remote.save_payment_method, undefined);
    assert.equal(remote.recipient.account_id, PLATFORM_SHOP.shopId, 'платёж — в магазин платформы');
    const s = await sub(CLUB_A);
    assert.equal(s.receipt_email, EMAIL_A);
    assert.ok(s.payment_method_enc.startsWith('v1:'), 'способ оплаты — зашифрован');
    assert.ok(!s.payment_method_enc.includes(remote.payment_method.id));
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token });
    assert.deepEqual(r.json.card, { mask: '•• 4477', type: 'MasterCard', expiry: '12/30' });
    assert.equal(r.json.autopay, true);
    assert.equal(r.json.banner, null);
    assert.ok(!r.text.includes(remote.payment_method.id), 'id способа оплаты наружу не отдаётся');
    assert.equal((await notes(ownerA.id, 'billing.card_saved')).length, 1);
    assert.equal(await guestPayments(), before, 'деньги платформы не в bl.payments');
  });

  it('конец пробного периода: счёт столы × цена в дату по поясу клуба, списание по карте, чек, paid_until +1 месяц', async () => {
    const s = await sub(CLUB_A);
    h.setNow(s.trial_until.getTime() + MIN);
    const out = await h.tick();
    assert.equal(out.errors, 0);
    const [inv] = await invoices(CLUB_A);
    const localStart = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(s.trial_until);
    const [{ start: periodStart }] = await h.q('select period_start::text as start from bl.billing_invoices where id = $1', [inv.id]);
    assert.equal(periodStart, localStart, 'дата счёта — по поясу клуба');
    assert.deepEqual([inv.tables, Number(inv.price_per_table_kopecks), Number(inv.amount_kopecks), inv.status, inv.paid_via], [8, 79000, 632000, 'paid', 'card']);
    assert.equal(inv.period_start_at.toISOString(), s.trial_until.toISOString());
    const s2 = await sub(CLUB_A);
    assert.equal(s2.paid_until.toISOString(), inv.period_end_at.toISOString());
    const days = (inv.period_end_at - inv.period_start_at) / DAY;
    assert.ok(days >= 28 && days <= 31, `период — месяц (${days})`);
    // Чек 54-ФЗ — у платежа в магазине платформы: услуга подписки, email владельца.
    const [pay] = await h.q("select * from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [inv.id]);
    assert.equal(pay.initiated_by, 'autopay');
    assert.equal(pay.idempotence_key, `bl-sub-${inv.id}-1`);
    const remote = await h.emuApi('GET', `/__emu/payments/${pay.provider_payment_id}`);
    assert.equal(remote.shop_id, PLATFORM_SHOP.shopId);
    assert.deepEqual(remote.receipt.customer, { email: EMAIL_A });
    assert.equal(remote.receipt.items[0].description, 'Подписка на программу «Бильярдум»');
    assert.equal(remote.receipt.items[0].amount.value, '6320.00');
    assert.equal(remote.receipt_registration, 'succeeded');
    // Вебхук ЮKassa пришёл после списания — второй обработки нет.
    await h.waitFor(async () => (await h.q('select webhook_at from bl.billing_payments where id = $1', [pay.id]))[0].webhook_at);
    assert.equal((await sub(CLUB_A)).paid_until.toISOString(), s2.paid_until.toISOString());
    assert.equal((await platformAudit('billing.invoice_paid')).filter((a) => a.data.club_id === CLUB_A).length, 1);
    assert.equal((await platformAudit('billing.invoice_issued')).filter((a) => a.data.club_id === CLUB_A).length, 1);
    const r = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token });
    assert.deepEqual([r.json.state, r.json.paid_until, r.json.banner], ['active', s2.paid_until.toISOString(), null]);
    const hist = await h.request('GET', `/api/clubs/${CLUB_A}/subscription/invoices`, { token: ownerA.token });
    assert.deepEqual(hist.json.items.map((i) => [i.status, i.paid_via, i.amount_kopecks, i.receipt?.status, i.receipt?.email]), [['paid', 'card', 632000, 'succeeded', EMAIL_A]]);
    assert.equal((await notes(ownerA.id, 'billing.payment_succeeded')).length, 1);
    // Повторный проход в тот же момент — ни нового счёта, ни списания.
    await h.tick();
    assert.equal((await invoices(CLUB_A)).length, 1);
  });

  it('отказ карты: повторы через 1 и 3 дня, плашка и уведомление; через 14 дней — Андрею; свет и игры работают', async () => {
    await h.emuApi('POST', '/__emu/config', { decline_recurring: true });
    try {
      const s = await sub(CLUB_A);
      const start = s.paid_until.getTime();
      h.setNow(start + MIN);
      await h.tick();
      let inv = (await invoices(CLUB_A))[1];
      assert.deepEqual([inv.status, inv.attempts, inv.last_error], ['open', 1, 'insufficient_funds']);
      assert.equal(inv.next_attempt_at.getTime(), inv.first_failed_at.getTime() + DAY);
      const failed = await notes(ownerA.id, 'billing.payment_failed');
      assert.equal(failed.length, 1);
      assert.match(failed[0].text, /Не удалось списать 6\s320\s₽ за подписку «Бильярдум»\. Повторим/);
      assert.equal((await notes(managerA.id, 'billing.payment_failed')).length, 1);
      const banner = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: managerA.token });
      assert.deepEqual([banner.json.state, banner.json.banner.kind, banner.json.banner.last_error], ['past_due', 'payment_failed', 'insufficient_funds']);

      // Ещё не время повтора — попытки нет.
      h.setNow(start + 12 * 3_600_000);
      await h.tick();
      assert.equal((await invoices(CLUB_A))[1].attempts, 1);
      // Через день — вторая, через три дня — третья и последняя.
      h.setNow(inv.first_failed_at.getTime() + DAY + MIN);
      await h.tick();
      inv = (await invoices(CLUB_A))[1];
      assert.equal(inv.attempts, 2);
      assert.equal(inv.next_attempt_at.getTime(), inv.first_failed_at.getTime() + 3 * DAY);
      h.setNow(inv.first_failed_at.getTime() + 3 * DAY + MIN);
      await h.tick();
      inv = (await invoices(CLUB_A))[1];
      assert.deepEqual([inv.attempts, inv.next_attempt_at], [3, null]);
      assert.match((await notes(ownerA.id, 'billing.payment_failed')).at(-1).text, /Автоматических попыток больше не будет/);
      h.setNow(inv.first_failed_at.getTime() + 10 * DAY);
      await h.tick();
      assert.equal((await invoices(CLUB_A))[1].attempts, 3, 'больше не списываем');
      const keys = await h.q('select idempotence_key from bl.billing_payments where invoice_id = $1 order by attempt', [inv.id]);
      assert.deepEqual(keys.map((k) => k.idempotence_key), [1, 2, 3].map((n) => `bl-sub-${inv.id}-${n}`));

      // 14 дней после конца периода — уведомление Андрею, один раз; клуб не приостановлен.
      const overdueA = async () => (await notes(andrey.id, 'platform.billing_overdue')).filter((n) => n.data.club_id === CLUB_A);
      assert.equal((await overdueA()).length, 0);
      h.setNow(start + 14 * DAY + MIN);
      await h.tick();
      await h.tick();
      const overdue = await overdueA();
      assert.equal(overdue.length, 1);
      assert.match(overdue[0].text, /Клуб «Тестовый клуб», Екатеринбург: подписка не оплачена 14 дней/);
      const st = await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token });
      assert.equal(st.json.state, 'unpaid');
      assert.equal((await h.q('select mode from bl.clubs where id = $1', [CLUB_A]))[0].mode, 'live', 'автоматически ничего не отключается');
      assert.ok((await h.q('select id from bl.public_clubs()')).some((x) => x.id === CLUB_A));
      assert.equal((await h.q("select count(*)::int as n from bl.audit_log where action in ('club.suspend', 'device.cmd') and club_id = $1", [CLUB_A]))[0].n, 0);
      // Гость начинает игру как обычно: долг по подписке котировку не трогает — решает только свет
      // (модуль света в этом приложении не запущен, поэтому стол «без связи»; часы котировки — настоящие).
      const offset = h.clock.offsetMs;
      h.clock.offsetMs = 0;
      try {
        const guest = await h.login('+79990001199');
        const q = await h.request('POST', '/api/quotes', { token: guest.token, body: { resource_id: 'e1000000-0000-4000-8000-000000000001', kind: 'start', minutes: 60 } });
        assert.ok(q.status < 300 || q.json.error === 'table_offline', q.text);
      } finally {
        h.clock.offsetMs = offset;
      }
    } finally {
      await h.emuApi('POST', '/__emu/config', { decline_recurring: false });
    }
  });

  it('Андрей отмечает оплату юрлица вручную — с причиной и номером платёжки, журнал платформы', async () => {
    const operator = await h.login(PHONES.operator);
    const inv = (await invoices(CLUB_A))[1];
    const path = `/api/platform/subscriptions/${CLUB_A}/mark-paid`;
    assert.equal((await h.request('POST', path, { token: ownerA.token, body: { invoice_id: inv.id, reason: 'x', document: '1' } })).status, 403);
    assert.equal((await h.request('POST', path, { token: operator.token, body: { invoice_id: inv.id, reason: 'x', document: '1' } })).status, 403);
    assert.equal((await h.request('POST', path, { token: andrey.token, body: { invoice_id: inv.id, document: '1' } })).json.error, 'reason_required');
    assert.equal((await h.request('POST', path, { token: andrey.token, body: { invoice_id: inv.id, reason: 'Оплата по счёту' } })).status, 400);
    assert.equal((await h.request('POST', `/api/platform/subscriptions/${CLUB_B}/mark-paid`, { token: andrey.token, body: { invoice_id: inv.id, reason: 'x', document: '1' } })).status, 404);
    const r = await h.request('POST', path, { token: andrey.token, body: { invoice_id: inv.id, reason: 'Юрлицо оплатило по счёту', document: 'п/п № 418 от 12.01' } });
    assert.equal(r.status, 200, r.text);
    const [paid] = await h.q('select * from bl.billing_invoices where id = $1', [inv.id]);
    assert.deepEqual([paid.status, paid.paid_via, paid.manual_reason, paid.manual_document, paid.manual_by], ['paid', 'manual', 'Юрлицо оплатило по счёту', 'п/п № 418 от 12.01', andrey.id]);
    assert.equal((await sub(CLUB_A)).paid_until.toISOString(), paid.period_end_at.toISOString());
    assert.equal(r.json.paid_until, paid.period_end_at.toISOString());
    const [a] = await platformAudit('manual.billing_mark_paid');
    assert.deepEqual([a.actor_type, a.actor_id, a.reason, a.data.invoice_id, a.data.document], ['support', andrey.id, 'Юрлицо оплатило по счёту', inv.id, 'п/п № 418 от 12.01']);
    const again = await h.request('POST', path, { token: andrey.token, body: { invoice_id: inv.id, reason: 'ещё', document: '2' } });
    assert.deepEqual([again.status, again.json.error], [409, 'invoice_paid']);
    assert.equal((await notes(ownerA.id, 'billing.payment_succeeded')).length, 2);
  });

  it('без карты: счёт ждёт карту (card_required), владелец оплачивает его на странице ЮKassa — карта сохраняется', async () => {
    const ownerB = await h.login(PHONES.ownerB);
    const s = await sub(CLUB_B) ?? (await h.request('GET', `/api/clubs/${CLUB_B}/subscription`, { token: ownerB.token }), await sub(CLUB_B));
    h.setNow(s.trial_until.getTime() + MIN);
    await h.tick();
    const [inv] = await invoices(CLUB_B);
    assert.deepEqual([inv.status, inv.attempts, inv.last_error, inv.next_attempt_at, inv.tables, Number(inv.amount_kopecks)], ['open', 0, 'card_required', null, 1, 79000]);
    assert.equal((await notes(ownerB.id, 'billing.card_required')).length, 1);
    await h.tick();
    assert.equal((await notes(ownerB.id, 'billing.card_required')).length, 1, 'одно уведомление на счёт');
    const nope = await h.request('DELETE', `/api/clubs/${CLUB_B}/subscription/autopay`, { token: ownerB.token, body: {} });
    assert.deepEqual([nope.status, nope.json.error], [409, 'card_required']);
    const st = await h.request('GET', `/api/clubs/${CLUB_B}/subscription`, { token: ownerB.token });
    assert.deepEqual([st.json.state, st.json.banner.kind, st.json.next_invoice.invoice_id, st.json.open_invoice.last_error], ['past_due', 'payment_failed', inv.id, 'card_required']);
    // «Оплатить картой»: оплата счёта с save_payment_method.
    const paid = await bindCard(ownerB, CLUB_B, 'owner-b@club.test');
    assert.deepEqual([paid.purpose, paid.amount_kopecks], ['invoice', 79000]);
    const [after] = await invoices(CLUB_B);
    assert.deepEqual([after.status, after.paid_via], ['paid', 'card']);
    const sb = await sub(CLUB_B);
    assert.equal(sb.paid_until.toISOString(), after.period_end_at.toISOString());
    assert.equal(sb.card.last4, '4477');
    const remote = await h.emuApi('GET', `/__emu/payments/${paid.provider_payment_id}`);
    assert.deepEqual([remote.status, remote.receipt.customer.email, remote.capture], ['succeeded', 'owner-b@club.test', true]);
    // Отключить автоплатёж: способ оплаты забыт, журнал клуба.
    const off = await h.request('DELETE', `/api/clubs/${CLUB_B}/subscription/autopay`, { token: ownerB.token, body: { reason: 'Сменим карту' } });
    assert.deepEqual([off.status, off.json], [200, { autopay: false, card: null }]);
    const sb2 = await sub(CLUB_B);
    assert.deepEqual([sb2.autopay, sb2.payment_method_enc, sb2.card], [false, null, null]);
    const [a] = await h.q("select actor_id, reason from bl.audit_log where club_id = $1 and action = 'billing.autopay_off'", [CLUB_B]);
    assert.deepEqual([a.actor_id, a.reason], [ownerB.id, 'Сменим карту']);
  });

  it('персональная цена Андреем — с причиной и журналом; действует со следующего счёта; 0 ₽ — счёт оплачен сразу', async () => {
    const ownerB = await h.login(PHONES.ownerB);
    const path = `/api/platform/subscriptions/${CLUB_B}/price`;
    assert.equal((await h.request('PUT', path, { token: ownerB.token, body: { price_per_table_kopecks: 1, reason: 'x' } })).status, 403);
    assert.equal((await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: 50000 } })).json.error, 'reason_required');
    assert.equal((await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: -1, reason: 'x' } })).status, 400);
    const r = await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: 0, reason: 'Пилотный клуб: бесплатно' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { club_id: CLUB_B, price_per_table_kopecks: 0, personal_price: true });
    const [a] = await platformAudit('manual.billing_price');
    assert.deepEqual([a.actor_id, a.reason, a.data.from, a.data.to], [andrey.id, 'Пилотный клуб: бесплатно', null, 0]);
    const s = await sub(CLUB_B);
    h.setNow(s.paid_until.getTime() + MIN);
    await h.tick();
    const inv = (await invoices(CLUB_B))[1];
    assert.deepEqual([inv.status, inv.paid_via, Number(inv.amount_kopecks)], ['paid', 'free', 0]);
    assert.equal((await sub(CLUB_B)).paid_until.toISOString(), inv.period_end_at.toISOString());
    // Вернуть цену плана.
    const back = await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: null, reason: 'Пилот закончился' } });
    assert.deepEqual(back.json, { club_id: CLUB_B, price_per_table_kopecks: 79000, personal_price: false });
  });

  it('тариф платформы меняет только Андрей; список «Клубы и подписки»: состояние, долг, MRR, оплаты за месяц', async () => {
    const operator = await h.login(PHONES.operator);
    const path = `/api/platform/plans/${PLAN_CLUB}`;
    assert.equal((await h.request('PUT', path, { token: operator.token, body: { price_per_table_kopecks: 80000 } })).status, 403);
    assert.equal((await h.request('PUT', path, { token: ownerA.token, body: { price_per_table_kopecks: 80000 } })).status, 403);
    assert.equal((await h.request('PUT', path, { token: andrey.token, body: {} })).status, 400);
    const r = await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: 89000, reason: 'Новая цена с января' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.price_per_table_kopecks, 89000);
    const [a] = await platformAudit('billing.plan_update');
    assert.deepEqual([a.actor_type, a.reason, a.data.to.price_per_table_kopecks, a.data.from.price_per_table_kopecks], ['support', 'Новая цена с января', 89000, 79000]);

    const list = await h.request('GET', '/api/platform/subscriptions', { token: operator.token });
    assert.equal(list.status, 200, list.text);
    const a1 = list.json.items.find((i) => i.club_id === CLUB_A);
    assert.deepEqual([a1.name, a1.state, a1.tables, a1.price_per_table_kopecks, a1.debt_kopecks, a1.autopay], ['Тестовый клуб', 'active', 8, 89000, 0, true]);
    assert.ok(list.json.plans.some((p) => p.id === PLAN_CLUB && p.price_per_table_kopecks === 89000));
    assert.equal(typeof list.json.totals.mrr_kopecks, 'number');
    assert.ok(list.json.totals.mrr_kopecks >= 8 * 89000);
    assert.ok(!list.text.includes(PLATFORM_SHOP.secret));
    await h.request('PUT', path, { token: andrey.token, body: { price_per_table_kopecks: 79000, reason: 'Вернули' } });
  });
});

describe('T32. Безопасность денег платформы', () => {
  it('права: ресепшн — 403; управляющий — только состояние; чужой клуб не видит подписку', async () => {
    const reception = await h.login(PHONES.receptionA);
    const manager = await h.login(PHONES.managerA);
    const ownerB = await h.login(PHONES.ownerB);
    for (const [m, p] of [['GET', ''], ['GET', '/invoices'], ['POST', '/card'], ['DELETE', '/autopay']]) {
      assert.equal((await h.request(m, `/api/clubs/${CLUB_A}/subscription${p}`, { token: reception.token, body: {} })).status, 403, `ресепшн ${m} ${p}`);
      assert.equal((await h.request(m, `/api/clubs/${CLUB_A}/subscription${p}`, { token: ownerB.token, body: {} })).status, 403, `чужой владелец ${m} ${p}`);
    }
    assert.equal((await h.request('GET', `/api/clubs/${CLUB_A}/subscription/invoices`, { token: manager.token })).status, 403);
    assert.equal((await h.request('POST', `/api/clubs/${CLUB_A}/subscription/card`, { token: manager.token, body: { email: 'm@club.test' } })).status, 403);
    assert.equal((await h.request('GET', '/api/platform/subscriptions', { token: ownerB.token })).status, 403);
    assert.equal((await h.request('GET', '/api/platform/subscriptions')).status, 401);
    // RLS: в контексте клуба B строк клуба A нет.
    await asRole(h.admin, 'app_api', { clubId: CLUB_B, userId: null, actorType: 'system' }, async (c) => {
      for (const t of ['club_subscriptions', 'billing_invoices', 'billing_payments']) {
        assert.equal((await c.query(`select count(*)::int as n from bl.${t} where club_id = $1`, [CLUB_A])).rows[0].n, 0, t);
      }
      assert.equal((await tryQuery(c, 'select * from bl.billing_clubs()'))?.code, '42501');
    });
  });

  it('клуб не меняет себе цену, paid_until и счета — ни через API, ни в базе', async () => {
    const ownerA = await h.login(PHONES.ownerA);
    const before = await sub(CLUB_A);
    const [inv] = await h.q("select id from bl.billing_invoices where club_id = $1 order by period_start limit 1", [CLUB_A]);
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, userId: ownerA.id, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, "update bl.club_subscriptions set paid_until = now() + interval '1 year' where club_id = $1", [CLUB_A]))?.code, '42501');
      assert.equal((await tryQuery(c, 'update bl.club_subscriptions set personal_price_kopecks = 1 where club_id = $1', [CLUB_A]))?.code, '42501');
      assert.equal((await tryQuery(c, "update bl.club_subscriptions set trial_until = now() + interval '1 year' where club_id = $1", [CLUB_A]))?.code, '42501');
      const upd = await c.query('update bl.club_subscriptions set autopay = false where club_id = $1', [CLUB_A]);
      assert.equal(upd.rowCount, 0, 'служебные поля пишет только контекст платформы');
      assert.equal((await tryQuery(c, "update bl.billing_invoices set status = 'paid' where id = $1", [inv.id]))?.code, '42501');
      assert.equal((await c.query('update bl.billing_invoices set attempts = 0 where id = $1', [inv.id])).rowCount, 0);
      assert.equal((await tryQuery(c, 'update bl.billing_plans set price_per_table_kopecks = 1')), null);
      assert.equal((await c.query('update bl.billing_plans set price_per_table_kopecks = 1')).rowCount, 0, 'план меняет только platform_admin');
      assert.equal((await tryQuery(c, 'select bl.billing_set_price($1, 1, $2, now())', [CLUB_A, 'себе скидку']))?.code, '42501');
      assert.equal((await tryQuery(c, "select bl.billing_settle_invoice($1, 'manual', null, 'x', 'y', now())", [inv.id]))?.code, '42501');
      assert.equal((await tryQuery(c, "select bl.billing_settle_invoice($1, 'card', null, null, null, now())", [inv.id]))?.code, '42501');
      assert.equal((await tryQuery(c, "select bl.billing_settle_invoice($1, 'free', null, null, null, now())", [inv.id]))?.code, '42501');
      const ins = await tryQuery(
        c,
        "insert into bl.billing_invoices (club_id, period_start, period_end, period_start_at, period_end_at, tables, price_per_table_kopecks, amount_kopecks) values ($1, '2030-01-01', '2030-02-01', now(), now() + interval '1 month', 0, 0, 0)",
        [CLUB_A],
      );
      assert.equal(ins?.code, '42501');
      const pay = await tryQuery(
        c,
        "insert into bl.billing_payments (id, club_id, purpose, initiated_by, shop_id, idempotence_key, amount_kopecks, status) values (gen_random_uuid(), $1, 'bind', 'owner', '700001', 'k-forged', 100, 'succeeded')",
        [CLUB_A],
      );
      assert.equal(pay?.code, '42501', 'клуб не записывает итог платежа');
      assert.equal((await tryQuery(c, 'delete from bl.club_subscriptions where club_id = $1', [CLUB_A]))?.code, '42501');
    });
    // Управляющий не отключает автоплатёж даже узкой функцией.
    const manager = await h.login(PHONES.managerA);
    await asRole(h.admin, 'app_api', { clubId: CLUB_A, userId: manager.id, actorType: 'user' }, async (c) => {
      assert.equal((await tryQuery(c, 'select bl.billing_disable_autopay($1, now())', [CLUB_A]))?.code, '42501');
    });
    const afterRow = await sub(CLUB_A);
    assert.equal(afterRow.paid_until.toISOString(), before.paid_until.toISOString());
    assert.equal(afterRow.personal_price_kopecks, null);
  });

  it('вебхук платформы нельзя подделать: итог берётся только из магазина платформы', async () => {
    const before = await sub(CLUB_A);
    // Отказ списания, затем подменённый вебхук «succeeded» с той же суммой.
    await h.emuApi('POST', '/__emu/config', { decline_recurring: 1 });
    h.setNow(before.paid_until.getTime() + MIN);
    await h.tick();
    const inv = (await invoices(CLUB_A)).at(-1);
    assert.equal(inv.status, 'open');
    const [failed] = await h.q("select * from bl.billing_payments where invoice_id = $1 and status = 'canceled'", [inv.id]);
    const forged = await h.emuApi('POST', `/__emu/payments/${failed.provider_payment_id}/webhook?repeat=3`, { override: { status: 'succeeded', paid: true }, event: 'payment.succeeded' });
    assert.ok(forged.deliveries.every((d) => d.delivered));
    const raw = await fetch(`${h.base}/api/webhooks/yookassa-platform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'notification', event: 'payment.succeeded', object: { id: failed.provider_payment_id, status: 'succeeded', amount: { value: '6320.00', currency: 'RUB' }, metadata: { club_id: CLUB_A, invoice_id: inv.id } } }),
    });
    assert.equal(raw.status, 200);
    const unknown = await fetch(`${h.base}/api/webhooks/yookassa-platform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded', object: { id: '2f3e1a5c-000f-5000-8000-1d2c3b4a5f6e', status: 'succeeded' } }),
    });
    assert.equal(unknown.status, 200);
    const bad = await fetch(`${h.base}/api/webhooks/yookassa-platform`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ object: { id: '../x' } }) });
    assert.equal(bad.status, 400);
    assert.equal((await h.q('select status from bl.billing_invoices where id = $1', [inv.id]))[0].status, 'open');
    assert.equal((await sub(CLUB_A)).paid_until.toISOString(), before.paid_until.toISOString());
    assert.equal((await h.q('select status from bl.billing_payments where id = $1', [failed.id]))[0].status, 'canceled');
  });

  it('двойной вебхук — одно списание и одно продление', async () => {
    const before = await sub(CLUB_A);
    const inv = (await invoices(CLUB_A)).at(-1);
    h.setNow(new Date(inv.next_attempt_at).getTime() + MIN);
    await h.tick();
    const [ok] = await h.q("select * from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [inv.id]);
    assert.ok(ok, 'второе списание прошло');
    const paidUntil = (await sub(CLUB_A)).paid_until;
    assert.ok(paidUntil > before.paid_until);
    const repeat = await h.emuApi('POST', `/__emu/payments/${ok.provider_payment_id}/webhook?repeat=8`, {});
    assert.ok(repeat.deliveries.every((d) => d.delivered));
    // Параллельно — тот же вебхук прямо обработчиком.
    await Promise.all(Array.from({ length: 4 }, () => fetch(`${h.base}/api/webhooks/yookassa-platform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded', object: { id: ok.provider_payment_id } }),
    })));
    assert.equal((await sub(CLUB_A)).paid_until.toISOString(), paidUntil.toISOString());
    assert.equal((await h.q("select count(*)::int as n from bl.billing_payments where invoice_id = $1 and status = 'succeeded'", [inv.id]))[0].n, 1);
    const paidAudit = (await platformAudit('billing.invoice_paid')).filter((a) => a.data.invoice_id === inv.id);
    assert.equal(paidAudit.length, 1);
    const charges = (await h.emuApi('GET', '/__emu/payments')).filter((p) => p.metadata?.invoice_id === inv.id && p.status === 'succeeded');
    assert.equal(charges.length, 1, 'у ЮKassa — одно списание');
  });

  it('деньги гостей и платформы не пересекаются: разные магазины, разные таблицы, разные вебхуки', async () => {
    const guestBefore = await guestPayments();
    const billingBefore = (await h.q('select count(*)::int as n from bl.billing_payments'))[0].n;
    // Платёж гостя в магазине клуба: по адресу платформы — не найден у магазина платформы.
    const auth = `Basic ${Buffer.from(`${CLUB_SHOP.shopId}:${CLUB_SHOP.secret}`).toString('base64')}`;
    const guest = await (await fetch(`${h.emuBase}/v3/payments`, {
      method: 'POST',
      headers: { authorization: auth, 'idempotence-key': h.newKey(), 'content-type': 'application/json' },
      body: JSON.stringify({
        amount: { value: '500.00', currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: 'https://bl.test/app' },
        metadata: { club_id: CLUB_A, kind: 'start' },
        receipt: { customer: { phone: '79990000001' }, items: [{ description: 'Игра', quantity: 1, amount: { value: '500.00', currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }] },
      }),
    })).json();
    await h.emuApi('POST', `/__emu/payments/${guest.id}/succeed?wait=1`);
    const toPlatform = await fetch(`${h.base}/api/webhooks/yookassa-platform`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded', object: { id: guest.id } }),
    });
    assert.equal(toPlatform.status, 200);
    // Платёж платформы по адресу клуба — не найден у магазина клуба.
    const [platformPay] = await h.q("select provider_payment_id from bl.billing_payments where club_id = $1 and status = 'succeeded' limit 1", [CLUB_A]);
    const toClub = await fetch(`${h.base}/api/webhooks/yookassa/${CLUB_A}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'payment.succeeded', object: { id: platformPay.provider_payment_id } }),
    });
    assert.equal(toClub.status, 200);
    assert.equal(await guestPayments(), guestBefore, 'платёж платформы не стал платежом гостя');
    assert.equal((await h.q('select count(*)::int as n from bl.billing_payments'))[0].n, billingBefore, 'платёж гостя не стал платежом платформы');
    // Все платежи подписки — только в магазине платформы; в магазине клуба их нет.
    const all = await h.emuApi('GET', '/__emu/payments');
    const subscription = all.filter((p) => p.metadata?.kind === 'subscription');
    assert.ok(subscription.length > 0);
    assert.ok(subscription.every((p) => p.recipient.account_id === PLATFORM_SHOP.shopId));
    assert.ok(all.filter((p) => p.recipient.account_id === PLATFORM_SHOP.shopId).every((p) => p.metadata?.kind === 'subscription'));
    // Ключей магазина платформы нет в базе: только .env.
    const dump = await h.q("select to_jsonb(t)::text as row from bl.club_payment_settings t union all select to_jsonb(s)::text from bl.club_subscriptions s union all select to_jsonb(p)::text from bl.billing_payments p");
    assert.ok(dump.every((r) => !r.row.includes(PLATFORM_SHOP.secret)));
  });

  it('секреты магазина платформы и id способа оплаты нигде не выводятся (ответы, лог, уведомления)', async () => {
    const ownerA = await h.login(PHONES.ownerA);
    const andrey = await h.login(PHONES.andrey);
    const methods = (await h.emuApi('GET', '/__emu/payment-methods')).map((m) => m.id);
    const texts = [
      (await h.request('GET', `/api/clubs/${CLUB_A}/subscription`, { token: ownerA.token })).text,
      (await h.request('GET', `/api/clubs/${CLUB_A}/subscription/invoices`, { token: ownerA.token })).text,
      (await h.request('GET', '/api/platform/subscriptions', { token: andrey.token })).text,
      JSON.stringify(h.log.lines),
      JSON.stringify(await h.q('select text, data from bl.notifications')),
      JSON.stringify(await h.q('select reason, data from bl.audit_log')),
      JSON.stringify(h.billingConfig),
    ];
    for (const t of texts) {
      assert.ok(!t.includes(PLATFORM_SHOP.secret), 'секрет магазина платформы');
      for (const id of methods) assert.ok(!t.includes(id), 'id способа оплаты');
    }
  });

  it('без ключей магазина платформы — 503 billing_unavailable, вебхук — 503', async () => {
    const off = loadBillingConfig({}, { ...h.moneyConfig, publicHost: 'bl.test' });
    const client = await h.pool.connect();
    try {
      await client.query('begin');
      await assert.rejects(getSubscription(client, { clubId: CLUB_A, owner: true, now: new Date(), config: off }), (e) => e.status === 503 && e.code === 'billing_unavailable');
      const w = await handlePlatformWebhook(client, { clock: h.clock }, off, { body: { event: 'payment.succeeded', object: { id: 'x' } } });
      assert.deepEqual(w, { status: 503, json: { error: 'billing_unavailable' } });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('№188: приостановка не оплачивается задним числом; магазин клуба ≠ магазин платформы', () => {
  const localDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(d);
  const midnight = (date) => new Date(`${date}T00:00:00+05:00`);
  const addDays = (date, n) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** Боевой клуб с одним столом, перешедший в live «сейчас» по подставным часам. */
  async function liveClub(name) {
    const owner = await h.login(`+7999000${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`);
    const [club] = await h.q("insert into bl.clubs (name, city, timezone, mode, went_live_at) values ($1, 'Пермь', 'Asia/Yekaterinburg', 'live', $2) returning id", [name, h.clock.now()]);
    await h.admin.query("insert into bl.club_members (club_id, user_id, role) values ($1, $2, 'owner')", [club.id, owner.id]);
    await h.admin.query("insert into bl.resources (club_id, type, number, title) values ($1, 'billiard_pool', 1, 'Стол 1')", [club.id]);
    await h.request('GET', `/api/clubs/${club.id}/subscription`, { token: owner.token });
    return { id: club.id, owner };
  }

  async function suspend(club, suspendIt) {
    const andrey = await h.login(PHONES.andrey);
    const r = await h.request('POST', `/api/platform/clubs/${club}/${suspendIt ? 'suspend' : 'resume'}`, { token: andrey.token, body: { reason: suspendIt ? 'Проверка' : 'Готово' } });
    assert.equal(r.status, 200, r.text);
  }

  it('срок шёл во время приостановки — сдвигается на её длительность, счетов за приостановку нет', async () => {
    const c = await liveClub('Клуб «Сдвиг»');
    const s0 = await sub(c.id);
    h.setNow(s0.trial_until.getTime() - 10 * DAY);
    await suspend(c.id, true);
    await h.tick();
    assert.equal((await sub(c.id)).suspended_since.getTime() <= h.clock.now().getTime(), true);
    // Пробный период «кончился» во время приостановки — счёта нет.
    h.setNow(s0.trial_until.getTime() + 20 * DAY);
    await h.tick();
    assert.equal((await invoices(c.id)).length, 0);
    await suspend(c.id, false);
    const since = (await sub(c.id)).suspended_since;
    h.setNow(s0.trial_until.getTime() + 20 * DAY + 3_600_000);
    await h.tick();
    const s1 = await sub(c.id);
    const days = Math.ceil((h.clock.now().getTime() - since.getTime()) / DAY);
    assert.equal(s1.suspended_since, null);
    assert.equal(s1.paid_until, null);
    assert.equal(s1.trial_until.toISOString(), midnight(addDays(localDay(s0.trial_until), days)).toISOString());
    assert.equal(s1.anchor_day, Number(addDays(localDay(s0.trial_until), days).slice(8)));
    assert.equal((await invoices(c.id)).length, 0, 'пробный период ещё идёт');
    const r = await h.request('GET', `/api/clubs/${c.id}/subscription`, { token: c.owner.token });
    assert.deepEqual([r.json.state, r.json.trial_until], ['trial', s1.trial_until.toISOString()]);
    const [a] = (await platformAudit('billing.resumed')).filter((x) => x.data.club_id === c.id);
    assert.equal(a.data.kind, 'shift');
    // После сдвинутого конца — обычный счёт.
    h.setNow(s1.trial_until.getTime() + MIN);
    await h.tick();
    const [inv] = await invoices(c.id);
    assert.equal(inv.period_start_at.toISOString(), s1.trial_until.toISOString());
  });

  it('срок кончился до приостановки — долг остаётся, следующий счёт с даты возобновления', async () => {
    const c = await liveClub('Клуб «Долг»');
    const s0 = await sub(c.id);
    h.setNow(s0.trial_until.getTime() + MIN);
    await h.tick();
    const [debt] = await invoices(c.id);
    assert.deepEqual([debt.status, debt.last_error], ['open', 'card_required']);
    h.setNow(s0.trial_until.getTime() + 2 * DAY);
    await suspend(c.id, true);
    await h.tick();
    h.setNow(s0.trial_until.getTime() + 75 * DAY);
    await h.tick();
    assert.equal((await invoices(c.id)).length, 1, 'за приостановку счетов нет');
    await suspend(c.id, false);
    const resumedAt = s0.trial_until.getTime() + 75 * DAY + 3_600_000;
    h.setNow(resumedAt);
    await h.tick();
    const list = await invoices(c.id);
    assert.equal(list.length, 2);
    assert.deepEqual([list[0].id, list[0].status], [debt.id, 'open'], 'долг до приостановки остался');
    const [{ start }] = await h.q('select period_start::text as start from bl.billing_invoices where id = $1', [list[1].id]);
    assert.equal(start, localDay(new Date(resumedAt)), 'следующий счёт — с даты возобновления');
    assert.equal(list[1].status, 'open');
    const s1 = await sub(c.id);
    assert.equal(s1.paid_until.toISOString(), midnight(localDay(new Date(resumedAt))).toISOString());
    assert.equal(s1.anchor_day, Number(localDay(new Date(resumedAt)).slice(8)));
    const [a] = (await platformAudit('billing.resumed')).filter((x) => x.data.club_id === c.id);
    assert.equal(a.data.kind, 'restart');
    const r = await h.request('GET', `/api/clubs/${c.id}/subscription`, { token: c.owner.token });
    assert.deepEqual([r.json.state, r.json.open_invoice.id, r.json.banner.kind], ['unpaid', debt.id, 'payment_failed']);
  });

  it('магазин клуба с shop_id магазина платформы — 400 shop_invalid', async () => {
    const owner = await h.login(PHONES.ownerA);
    const before = process.env.PLATFORM_YOOKASSA_SHOP_ID;
    process.env.PLATFORM_YOOKASSA_SHOP_ID = PLATFORM_SHOP.shopId;
    try {
      for (const mode of ['live', 'test']) {
        const r = await h.request('PUT', `/api/clubs/${CLUB_A}/payment-settings/${mode}`, {
          token: owner.token,
          body: { shop_id: PLATFORM_SHOP.shopId, secret_key: PLATFORM_SHOP.secret, reason: 'Новый магазин' },
        });
        assert.deepEqual([r.status, r.json.error], [400, 'shop_invalid'], mode);
      }
    } finally {
      if (before === undefined) delete process.env.PLATFORM_YOOKASSA_SHOP_ID;
      else process.env.PLATFORM_YOOKASSA_SHOP_ID = before;
    }
    const [s] = await h.q('select shop_id, test_shop_id from bl.club_payment_settings where club_id = $1', [CLUB_A]);
    assert.deepEqual([s.shop_id, s.test_shop_id], [CLUB_SHOP.shopId, null]);
    assert.ok(!(await h.emuApi('GET', '/__emu/requests')).some((x) => x.path === '/v3/me'), 'до ЮKassa не дошло');
  });
});
