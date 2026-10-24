import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { bannerOf } from '../src/mock/billing.js';
import { bannerHidden, bannerHideValue, bannerView, dayWord, failureText, localDay } from '../src/lib/billingBanner.js';
import {
  SUB_STATE,
  cardAction,
  cardBody,
  cardText,
  clubDate,
  dateText,
  daysUntil,
  emailError,
  filterClubs,
  invoiceStatus,
  isDebtor,
  markPaidBody,
  markPaidErrors,
  openInvoiceView,
  outcomeText,
  paidUntilText,
  periodText,
  PLAN_PRICE_WARNING,
  planImpact,
  planImpactText,
  planPriceBody,
  planPriceErrors,
  priceBody,
  priceErrors,
  pricePreview,
  receiptView,
  safeConfirmationUrl,
  stateCounts,
  subState,
  subStateOf,
  summaryOf,
} from '../src/lib/billing.js';
import { navItems } from '../src/lib/nav.js';
import { can } from '../src/lib/auth.js';

const TZ = 'Asia/Yekaterinburg';
const NOW = Date.parse('2026-10-24T10:00:00Z');
const NBSP = /\u00a0/g;
const plain = (s) => String(s).replace(NBSP, ' ');
const SCARY = /отключ(ат|им|ен|ится)|заблокир|приостанов|погаснет|выключ.*свет/i;

const memory = () => {
  let s = null;
  return { load: () => s, save: (v) => (s = structuredClone(v)) };
};
const req = (b, method, path, body) => b.handle(method, { href: `http://x${path}`, body });
const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';

test('плашка: «Пробный период заканчивается через 5 дней», срок оплаты, неуспешная оплата заметнее', () => {
  assert.equal(bannerView(null), null);
  assert.equal(bannerView({ kind: 'nonsense' }), null);
  const trial = bannerView({ kind: 'trial_ending', days_left: 5 });
  assert.equal(trial.text, 'Пробный период заканчивается через 5 дней.');
  assert.equal(trial.short, 'Подписка: осталось 5 дней');
  assert.equal(trial.strong, false);
  assert.equal(bannerView({ kind: 'period_ending', days_left: 1 }).text, 'Оплаченный период истекает через 1 день.');
  assert.equal(bannerView({ kind: 'period_ending', days_left: 3 }).text, 'Оплаченный период истекает через 3 дня.');
  assert.equal(bannerView({ kind: 'period_ending', days_left: 0 }).text, 'Оплаченный период истекает сегодня.');
  const failed = bannerView({ kind: 'payment_failed', days_overdue: 4, last_error: 'insufficient_funds' });
  assert.equal(failed.strong, true);
  assert.equal(failed.text, 'Оплата подписки не прошла: на карте не хватило денег. Просрочка — 4 дня.');
  assert.equal(failed.short, 'Подписка не оплачена');
  assert.equal(bannerView({ kind: 'payment_failed', days_overdue: 0, last_error: null }).text, 'Счёт за подписку ещё не оплачен.');
  assert.equal(bannerView({ kind: 'payment_failed', days_overdue: 0, last_error: 'general_decline' }).text, 'Оплата подписки не прошла: банк отклонил списание.');
  // Подписка не трогает свет и игры (№184) — плашка не пугает отключением
  for (const b of [{ kind: 'trial_ending', days_left: 2 }, { kind: 'period_ending', days_left: 7 }, { kind: 'payment_failed', days_overdue: 20, last_error: 'card_expired' }]) {
    const v = bannerView(b);
    assert.doesNotMatch(`${v.text} ${v.short}`, SCARY);
  }
});

test('плашка invoice_due: «Счёт за подписку будет списан DD.MM» до первой неудачи, по поясу клуба; не заметная', () => {
  // 24.10 22:00 UTC — в Екатеринбурге уже 25.10
  const due = bannerView({ kind: 'invoice_due', days_left: 0, days_overdue: 0, until: '2026-10-23T19:00:00.000Z', next_attempt_at: '2026-10-24T22:00:00.000Z', last_error: null }, TZ);
  assert.equal(due.kind, 'invoice_due');
  assert.equal(due.strong, false, 'до отказа — не тревога');
  assert.equal(due.text, 'Счёт за подписку будет списан 25.10.');
  assert.equal(due.short, 'Подписка: списание 25.10');
  assert.deepEqual(due.link, { full: 'Открыть подписку', short: 'Подписка' });
  assert.equal(bannerView({ kind: 'invoice_due', until: '2026-10-23T19:00:00.000Z' }, TZ).text, 'Счёт за подписку будет списан 24.10.', 'без next_attempt_at — дата until');
  assert.equal(bannerView({ kind: 'invoice_due', until: '2026-10-23T19:00:00.000Z' }, 'UTC').text, 'Счёт за подписку будет списан 23.10.');
  assert.equal(bannerView({ kind: 'invoice_due' }, TZ).text, 'Счёт за подписку скоро будет списан с карты.');
  assert.equal(bannerView({ kind: 'invoice_due', until: 'нет' }, TZ).short, 'Подписка: скоро списание');
  assert.doesNotMatch(`${due.text} ${due.short}`, SCARY);
  assert.doesNotMatch(due.text, /не прошла|не оплачен/, 'до отказа не пишем о неудаче');
  // Остальные виды — ссылка «Перейти к оплате»
  assert.deepEqual(bannerView({ kind: 'payment_failed', days_overdue: 1, last_error: 'insufficient_funds' }).link, { full: 'Перейти к оплате', short: 'Оплатить' });
  // Скрытая до завтра invoice_due снова видна, когда списание не прошло
  const saved = bannerHideValue({ kind: 'invoice_due' }, '2026-10-24');
  assert.equal(bannerHidden(saved, { kind: 'invoice_due' }, '2026-10-24'), true);
  assert.equal(bannerHidden(saved, { kind: 'payment_failed' }, '2026-10-24'), false);
});

test('склонения и причины отказа', () => {
  assert.equal(dayWord(1), '1 день');
  assert.equal(dayWord(2), '2 дня');
  assert.equal(dayWord(11), '11 дней');
  assert.equal(dayWord(21), '21 день');
  assert.equal(failureText(null), null);
  assert.equal(failureText('card_required'), 'карта не привязана');
  assert.equal(failureText('something_new'), 'банк отклонил списание');
});

test('крестик скрывает плашку до завтра по суткам клуба; заметнее — показываем снова', () => {
  const banner = { kind: 'trial_ending', days_left: 5 };
  // 20:30 UTC — в Екатеринбурге уже 25 октября
  assert.equal(localDay(Date.parse('2026-10-24T20:30:00Z'), TZ), '2026-10-25');
  assert.equal(localDay(Date.parse('2026-10-24T18:30:00Z'), TZ), '2026-10-24');
  const saved = bannerHideValue(banner, '2026-10-24');
  assert.equal(bannerHidden(saved, banner, '2026-10-24'), true);
  assert.equal(bannerHidden(saved, banner, '2026-10-25'), false, 'на следующий день снова видна');
  assert.equal(bannerHidden(saved, { kind: 'payment_failed' }, '2026-10-24'), false, 'оплата не прошла — видна сразу');
  assert.equal(bannerHidden(null, banner, '2026-10-24'), false);
});

test('состояние словами: пробный, активна, просрочена, не оплачена, отключена', () => {
  assert.deepEqual(Object.values(SUB_STATE).map((s) => s.word), ['Пробный период', 'Активна', 'Просрочена', 'Не оплачена', 'Отключена']);
  assert.equal(subState('xxx').word, 'Нет данных');
});

test('сводка подписки: пробный, оплачено, просрочка без угроз, тестовый режим', () => {
  const trial = summaryOf({ mode: 'live', state: 'trial', trial_until: '2026-10-28T19:00:00.000Z', autopay: false }, { timeZone: TZ, now: NOW });
  assert.equal(trial.title, 'Пробный период до 29 октября');
  assert.match(trial.detail, /^Осталось 5 дней\. Привяжите карту/);
  const mgr = summaryOf({ mode: 'live', state: 'trial', trial_until: '2026-10-28T19:00:00.000Z' }, { timeZone: TZ, now: NOW });
  assert.equal(mgr.detail, 'Осталось 5 дней.', 'управляющему — без карты');
  const active = summaryOf({ mode: 'live', state: 'active', paid_until: '2026-11-22T19:00:00.000Z', autopay: true }, { timeZone: TZ, now: NOW });
  assert.equal(active.title, 'Оплачено до 23 ноября');
  assert.match(active.detail, /автоматически/);
  const due = summaryOf({ mode: 'live', state: 'past_due', open_invoice: { period_start: '2026-10-20' } }, { timeZone: TZ, now: NOW });
  assert.equal(due.title, 'Не оплачено с 20 октября');
  assert.match(due.detail, /работают как обычно/);
  assert.doesNotMatch(due.detail, SCARY);
  const unpaid = summaryOf({ mode: 'live', state: 'unpaid', open_invoice: { period_start: '2026-10-01' } }, { timeZone: TZ, now: NOW });
  assert.match(unpaid.detail, /юрлица/);
  assert.doesNotMatch(unpaid.detail, SCARY);
  const test0 = summaryOf({ mode: 'test', state: 'trial', trial_until: null, trial_days: 60 }, { timeZone: TZ, now: NOW });
  assert.match(test0.detail, /60 дней бесплатно начнутся/);
  assert.equal(summaryOf({ mode: 'test', state: 'canceled' }, { timeZone: TZ }).title, 'Подписка отключена');
});

test('даты: YYYY-MM-DD как есть, ISO — по поясу клуба, другой год — с годом; период счёта', () => {
  assert.equal(dateText('2026-12-23', TZ, NOW), '23 декабря');
  assert.equal(dateText('2027-01-23', TZ, NOW), '23 января 2027');
  assert.equal(dateText('2026-12-22T19:00:00.000Z', TZ, NOW), '23 декабря', 'местная полночь клуба');
  assert.equal(dateText(null, TZ), '—');
  assert.equal(periodText('2026-11-23', '2026-12-23', TZ, NOW), '23 ноября — 23 декабря');
  assert.equal(daysUntil('2026-10-29T10:00:00Z', NOW), 5);
  assert.equal(daysUntil('2026-10-24T10:00:01Z', NOW), 1);
  assert.equal(daysUntil('2026-10-20T10:00:00Z', NOW), 0);
});

test('дата клуба на экране платформы без пояса: местная полночь любого пояса РФ — та же дата', () => {
  // 23 ноября 00:00 местного: Калининград (UTC+2), Москва, Екатеринбург, Камчатка (UTC+12)
  for (const isoAt of ['2026-11-22T22:00:00.000Z', '2026-11-22T21:00:00.000Z', '2026-11-22T19:00:00.000Z', '2026-11-22T12:00:00.000Z']) {
    assert.equal(clubDate(isoAt, undefined, NOW), '23 ноября', isoAt);
  }
  assert.equal(clubDate('2026-11-22T19:00:00.000Z', TZ, NOW), '23 ноября');
  assert.equal(clubDate(null), '—');
  assert.equal(paidUntilText({ state: 'trial', trial_until: '2026-11-22T19:00:00.000Z' }, NOW), 'пробный до 23 ноября');
  assert.equal(paidUntilText({ state: 'canceled' }, NOW), '—');
});

test('открытый счёт: причина, следующая попытка, кнопка говорит, что произойдёт', () => {
  const sub = { card: { mask: '•• 4477' }, open_invoice: { id: 'i1', period_start: '2026-10-20', period_end: '2026-11-20', amount_kopecks: 632000, attempts: 2, next_attempt_at: '2026-10-26T13:00:00Z', last_error: 'insufficient_funds' } };
  const v = openInvoiceView(sub, { timeZone: TZ, now: NOW });
  assert.equal(plain(v.title), 'Счёт на 6 320 ₽ за 20 октября — 20 ноября не оплачен');
  assert.equal(v.reason, 'На карте не хватило денег.');
  assert.match(v.next, /^Следующая попытка списания — 26 октября/);
  assert.match(openInvoiceView({ ...sub, open_invoice: { ...sub.open_invoice, next_attempt_at: null } }, { timeZone: TZ, now: NOW }).next, /больше не будет/);
  assert.match(openInvoiceView({ ...sub, card: null }, { timeZone: TZ, now: NOW }).next, /^Привяжите карту/);
  assert.equal(openInvoiceView({ open_invoice: null }), null);
  // До первой попытки (invoice_due) — «ждёт списания», без «не оплачен» и «следующей попытки»
  const fresh = openInvoiceView({ ...sub, open_invoice: { ...sub.open_invoice, attempts: 0, last_error: null } }, { timeZone: TZ, now: NOW });
  assert.equal(plain(fresh.title), 'Счёт на 6 320 ₽ за 20 октября — 20 ноября ждёт списания');
  assert.equal(fresh.reason, null);
  assert.match(fresh.next, /^Спишем с карты автоматически 26 октября/);
  const sum = summaryOf({ mode: 'live', state: 'past_due', autopay: true, card: { mask: '•• 1' }, banner: { kind: 'invoice_due', until: '2026-10-19T19:00:00Z', next_attempt_at: '2026-10-24T12:00:00Z' }, open_invoice: { period_start: '2026-10-20' } }, { timeZone: TZ, now: NOW });
  assert.equal(sum.title, 'Счёт выставлен 20 октября');
  assert.equal(subStateOf({ state: 'past_due', banner: { kind: 'invoice_due' } }).word, 'Ждёт списания');
  assert.equal(subStateOf({ state: 'past_due', banner: { kind: 'payment_failed' } }).word, 'Просрочена');
  assert.equal(subStateOf({ state: 'active', banner: null }).word, 'Активна');
  assert.match(sum.detail, /^Спишем с карты автоматически 24 октября\. Свет, игры/);
  assert.match(summaryOf({ mode: 'live', state: 'past_due', autopay: false, card: null, banner: { kind: 'invoice_due', until: '2026-10-19T19:00:00Z' }, open_invoice: null }, { timeZone: TZ, now: NOW }).detail, /^Привяжите карту/);
  assert.equal(plain(cardAction(sub).label), 'Оплатить 6 320 ₽ картой');
  assert.equal(cardAction(sub).purpose, 'invoice');
  assert.equal(cardAction({ card: { mask: '•• 1' } }).label, 'Сменить карту');
  assert.equal(cardAction({ card: null }).label, 'Привязать карту');
  assert.equal(cardText({ mask: '•• 4477', type: 'MasterCard', expiry: '12/30' }), 'MasterCard •• 4477, до 12/30');
  assert.equal(cardText(null), null);
});

test('email для чека: обязателен при первой привязке; тело запроса и адрес ЮKassa', () => {
  assert.match(emailError('', { required: true }), /Укажите email/);
  assert.equal(emailError('', { required: false }), null);
  assert.match(emailError('owner@', { required: true }), /Проверьте email/);
  assert.equal(emailError(' owner@club.ru ', { required: true }), null);
  assert.deepEqual(cardBody(' owner@club.ru '), { email: 'owner@club.ru' });
  assert.deepEqual(cardBody(''), {});
  const origin = 'https://billiardum.ru';
  assert.equal(safeConfirmationUrl('https://yoomoney.ru/checkout/payments/v2/contract?orderId=1', origin), 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=1');
  assert.equal(safeConfirmationUrl('/club/subscription', origin), 'https://billiardum.ru/club/subscription');
  assert.equal(safeConfirmationUrl('javascript:alert(1)', origin), null);
  assert.equal(safeConfirmationUrl('http://evil.example/x', origin), null);
  assert.equal(safeConfirmationUrl(null, origin), null);
});

test('итог после страницы ЮKassa', () => {
  assert.equal(outcomeText({ mask: null, invoice_id: null }, { card: { mask: '•• 4477', type: 'MasterCard' }, open_invoice: null }), 'Готово: карта MasterCard •• 4477 привязана, автоплатёж включён.');
  assert.match(outcomeText({ mask: '•• 4477', invoice_id: 'i1' }, { card: { mask: '•• 4477' }, open_invoice: null }), /Счёт оплачен/);
  assert.match(outcomeText({ mask: '•• 4477', invoice_id: 'i1' }, { card: { mask: '•• 4477' }, open_invoice: { id: 'i1' } }), /не завершилась/);
  assert.match(outcomeText({ mask: null, invoice_id: null }, { card: null, open_invoice: null }), /не завершилась/);
  assert.equal(outcomeText({ mask: '•• 4477', invoice_id: null }, { card: { mask: '•• 4477' }, open_invoice: null }), null);
});

test('счета: статус словами, чек — куда ушёл (ссылка — только https)', () => {
  assert.equal(invoiceStatus({ status: 'paid', paid_via: 'card' }).word, 'Оплачен картой');
  assert.equal(invoiceStatus({ status: 'paid', paid_via: 'manual', document: '1842' }).detail, 'Платёжное поручение № 1842');
  assert.equal(invoiceStatus({ status: 'paid', paid_via: 'free' }).word, 'Без оплаты');
  assert.equal(invoiceStatus({ status: 'open', last_error: 'insufficient_funds' }).detail, 'на карте не хватило денег');
  assert.deepEqual(receiptView({ paid_via: 'card', receipt: { status: 'succeeded', email: 'o@c.ru' } }), { text: 'Чек отправлен на o@c.ru', url: null });
  assert.equal(receiptView({ paid_via: 'card', receipt: { status: 'succeeded', email: 'o@c.ru', url: 'https://yookassa.ru/r/1' } }).url, 'https://yookassa.ru/r/1');
  assert.equal(receiptView({ paid_via: 'card', receipt: { status: 'succeeded', url: 'javascript:x' } }).url, null);
  assert.equal(receiptView({ paid_via: 'card', receipt: { status: 'pending' } }).text, 'Чек формируется');
  assert.equal(receiptView({ paid_via: 'manual', receipt: null }), null);
});

test('платформа: должники, фильтр, счётчики, формы ручной оплаты и цены', () => {
  const items = [
    { club_id: 'a', state: 'active', debt_kopecks: 0 },
    { club_id: 'b', state: 'past_due', debt_kopecks: 100 },
    { club_id: 'c', state: 'unpaid', debt_kopecks: 900 },
    { club_id: 'd', state: 'trial', debt_kopecks: 0 },
  ];
  assert.equal(isDebtor(items[0]), false);
  assert.deepEqual(filterClubs(items, 'debtors').map((x) => x.club_id), ['c', 'b']);
  assert.equal(filterClubs(items, 'all').length, 4);
  assert.deepEqual(stateCounts({ trial: 2, active: 0, past_due: 1 }), [['trial', 'Пробный период', 2], ['past_due', 'Просрочена', 1]]);
  assert.deepEqual(Object.keys(markPaidErrors({ document: '', reason: ' ' })), ['document', 'reason']);
  assert.deepEqual(markPaidErrors({ document: '1842', reason: 'Оплата по счёту' }), {});
  assert.deepEqual(markPaidBody('inv', { document: ' 1842 ', reason: ' Оплата по счёту ' }), { invoice_id: 'inv', reason: 'Оплата по счёту', document: '1842' });
  assert.ok(priceErrors({ rubles: 'abc', reason: 'x' }).rubles);
  assert.ok(priceErrors({ rubles: '590', reason: '' }).reason);
  assert.deepEqual(priceErrors({ rubles: '0', reason: 'Пилот' }), {});
  assert.deepEqual(priceErrors({ reset: true, rubles: '', reason: 'Пилот закончился' }), {});
  assert.deepEqual(priceBody({ rubles: '590', reason: ' Пилот ' }), { price_per_table_kopecks: 59000, reason: 'Пилот' });
  assert.deepEqual(priceBody({ reset: true, rubles: '590', reason: 'Конец пилота' }), { price_per_table_kopecks: null, reason: 'Конец пилота' });
  assert.equal(plain(pricePreview({ rubles: '590' }, { tables: 8 }, null)), '8 столов × 590 ₽ = 4 720 ₽ в месяц, со следующего счёта.');
  assert.equal(plain(pricePreview({ reset: true }, { tables: 1 }, { price_per_table_kopecks: 79000 })), '1 стол × 790 ₽ = 790 ₽ в месяц, со следующего счёта.');
  assert.equal(pricePreview({ rubles: '' }, { tables: 1 }, null), null);
});

test('цена плана: форма с причиной, тело запроса, кого коснётся, предупреждение', () => {
  const plan = { id: 'p1', title: 'Клуб', price_per_table_kopecks: 79000 };
  assert.equal(PLAN_PRICE_WARNING, 'Изменится со следующего счёта у всех клубов без персональной цены.');
  assert.deepEqual(planPriceErrors({ rubles: '890', reason: 'Индексация' }, plan), {});
  const bad = planPriceErrors({ rubles: 'абв', reason: ' ' }, plan);
  assert.match(bad.rubles, /в рублях/);
  assert.match(bad.reason, /причину/);
  assert.match(planPriceErrors({ rubles: '790', reason: 'x' }, plan).rubles, /текущая цена/);
  assert.match(planPriceErrors({ rubles: '2000000', reason: 'x' }, plan).rubles, /Слишком большая/);
  assert.deepEqual(planPriceErrors({ rubles: '0', reason: 'Акция' }, plan), {}, '0 — бесплатно');
  assert.deepEqual(planPriceBody({ rubles: '890,50', reason: '  Индексация ' }), { price_per_table_kopecks: 89050, reason: 'Индексация' });
  const items = [
    { plan: { id: 'p1' }, personal_price: false, state: 'active', tables: 8 },
    { plan: { id: 'p1' }, personal_price: false, state: 'trial', tables: 4 },
    { plan: { id: 'p1' }, personal_price: true, state: 'active', tables: 10 },
    { plan: { id: 'p1' }, personal_price: false, state: 'canceled', tables: 5 },
    { plan: { id: 'p2' }, personal_price: false, state: 'active', tables: 6 },
  ];
  const impact = planImpact(items, plan, { rubles: '890' });
  assert.deepEqual(impact, { clubs: 2, tables: 12, before: 12 * 79000, after: 12 * 89000 });
  assert.equal(plain(planImpactText(impact)), 'Затронет 2 клуба, 12 столов: 9 480 ₽ → 10 680 ₽ в месяц.');
  assert.equal(plain(planImpactText(planImpact(items, plan, { rubles: '' }))), 'Затронет 2 клуба, 12 столов.');
  assert.match(planImpactText(planImpact([], plan, { rubles: '890' })), /нет клубов без персональной цены/);
});

test('права и разделы: «Подписка» — владельцу и управляющему, ресепшн и бар не видят', () => {
  assert.ok(navItems('owner', CLUB).some((i) => i.key === 'subscription'));
  assert.ok(navItems('manager', CLUB).some((i) => i.key === 'subscription'));
  assert.ok(!navItems('reception', CLUB).some((i) => i.key === 'subscription'));
  assert.ok(!navItems('bar', CLUB).some((i) => i.key === 'subscription'));
  assert.equal(can.subscriptionManage('manager'), false);
  assert.equal(can.subscriptionManage('owner'), true);
  // На телефоне в нижней панели «Подписки» нет — она в «Ещё» и в боковой панели планшета
  assert.ok(navItems('owner', CLUB).find((i) => i.key === 'subscription').wideOnly);
});

test('заглушка ?mock=billing: пробный период, 5 дней, плашка; привязка карты с email', async () => {
  const b = createBackend(memory());
  b.scenario('billing');
  const s = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body;
  assert.equal(s.state, 'trial');
  assert.equal(s.banner.kind, 'trial_ending');
  assert.equal(s.banner.days_left, 5);
  assert.equal(s.card, null);
  assert.equal(s.price_per_table_kopecks, 79000);
  assert.equal(s.tables, 8);
  assert.equal(s.next_invoice.amount_kopecks, 8 * 79000);
  for (const k of ['mode', 'state', 'trial_until', 'paid_until', 'banner', 'plan', 'personal_price', 'trial_days', 'next_invoice', 'open_invoice', 'card', 'autopay', 'receipt_email', 'card_pending']) assert.ok(k in s, k);
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/subscription/card`, {})).body.error, 'bad_request', 'email обязателен при первой привязке');
  const card = await req(b, 'POST', `/api/clubs/${CLUB}/subscription/card`, { email: 'owner@club.ru' });
  assert.equal(card.status, 201);
  assert.equal(card.body.purpose, 'bind');
  assert.equal(card.body.amount_kopecks, 100);
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body.card_pending, true);
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription/invoices`)).body.items.length, 0);
});

test('заглушка: просрочка — счёт, попытки, плашка payment_failed; управляющему — только состояние', async () => {
  const b = createBackend(memory());
  b.scenario('billing-overdue');
  const s = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body;
  assert.equal(s.state, 'past_due');
  assert.equal(s.banner.kind, 'payment_failed');
  assert.equal(s.banner.days_overdue, 4);
  assert.equal(s.open_invoice.last_error, 'insufficient_funds');
  assert.equal(s.open_invoice.attempts, 2);
  const card = await req(b, 'POST', `/api/clubs/${CLUB}/subscription/card`, {});
  assert.equal(card.body.purpose, 'invoice');
  assert.equal(card.body.amount_kopecks, s.open_invoice.amount_kopecks);
  b.scenario('billing-manager');
  const m = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body;
  assert.deepEqual(Object.keys(m).sort(), ['banner', 'mode', 'paid_until', 'state', 'trial_until']);
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription/invoices`)).body.error, 'forbidden');
  assert.equal((await req(b, 'POST', `/api/clubs/${CLUB}/subscription/card`, {})).body.error, 'forbidden');
  b.scenario('reception');
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body.error, 'forbidden', 'ресепшн подписку не видит');
});

test('заглушка ?mock=billing-due: счёт выставлен, попыток не было — invoice_due; отказ — payment_failed', async () => {
  const b = createBackend(memory());
  b.scenario('billing-due');
  const s = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body;
  assert.equal(s.banner.kind, 'invoice_due');
  assert.equal(s.open_invoice.attempts, 0);
  assert.equal(s.open_invoice.last_error, null);
  assert.equal(s.banner.next_attempt_at, s.open_invoice.next_attempt_at);
  assert.match(bannerView(s.banner, TZ).text, /^Счёт за подписку будет списан \d{2}\.\d{2}\.$/);
  // Остальные сценарии с открытым счётом — после отказа (попытки были или карты нет)
  b.scenario('billing-overdue');
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body.banner.kind, 'payment_failed');
});

test('заглушка = сервер (bannerFor): счёта ещё нет — invoice_due; card_required — отказ; days_overdue считается', () => {
  const DAY = 86_400_000;
  const T = NOW;
  const ended = { trial_until: T - 2 * DAY, paid_until: null, card: { mask: '•• 1' }, autopay: true, invoices: [] };
  const a = bannerOf(ended, { now: T, live: true });
  assert.equal(a.kind, 'invoice_due', 'период кончился, счёта нет — ещё не отказ');
  assert.equal(a.days_overdue, 2);
  assert.equal(a.next_attempt_at, new Date(T).toISOString(), 'срок попытки в прошлом — «сейчас»');
  const inv = (extra) => ({ status: 'open', period_start_at: T - DAY, attempts: 0, next_attempt_at: T + 3600_000, last_error: null, ...extra });
  const due = bannerOf({ ...ended, invoices: [inv()] }, { now: T, live: true });
  assert.equal(due.kind, 'invoice_due');
  assert.equal(due.days_overdue, 1);
  assert.equal(due.next_attempt_at, new Date(T + 3600_000).toISOString());
  assert.equal(bannerOf({ ...ended, invoices: [inv({ last_error: 'card_required', next_attempt_at: null })] }, { now: T, live: true }).kind, 'payment_failed', 'card_required — отказ');
  assert.equal(bannerOf({ ...ended, invoices: [inv({ attempts: 1 })] }, { now: T, live: true }).kind, 'payment_failed');
  assert.equal(bannerOf(ended, { now: T, live: false }), null);
});

test('заглушка: активна — история счетов с чеками, отключение автоплатежа, card_required', async () => {
  const b = createBackend(memory());
  b.scenario('billing-active');
  const s = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body;
  assert.equal(s.state, 'active');
  assert.equal(s.banner, null, 'автоплатёж настроен — плашки нет');
  assert.equal(s.autopay, true);
  const inv = (await req(b, 'GET', `/api/clubs/${CLUB}/subscription/invoices`)).body.items;
  assert.equal(inv.length, 2);
  assert.equal(inv[0].receipt.status, 'succeeded');
  assert.ok(inv[0].period_start > inv[1].period_start, 'новые сверху');
  assert.deepEqual((await req(b, 'DELETE', `/api/clubs/${CLUB}/subscription/autopay`, {})).body, { autopay: false, card: null });
  assert.equal((await req(b, 'DELETE', `/api/clubs/${CLUB}/subscription/autopay`, {})).body.error, 'card_required');
  // По умолчанию (другие сценарии) — пробный период без плашки, экраны тестера не меняются
  b.scenario('owner');
  assert.equal((await req(b, 'GET', `/api/clubs/${CLUB}/subscription`)).body.banner, null);
});

test('заглушка: без ключей платформы — 503 billing_unavailable', async () => {
  const b = createBackend(memory());
  b.scenario('billing-off');
  const r = await req(b, 'GET', `/api/clubs/${CLUB}/subscription`);
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'billing_unavailable');
});

test('заглушка ?mock=platform-billing: MRR, долг, ручная оплата с причиной и платёжкой, персональная цена; оператор — чтение', async () => {
  const b = createBackend(memory());
  b.scenario('platform-billing');
  const list = (await req(b, 'GET', '/api/platform/subscriptions')).body;
  assert.equal(list.items.length, 6);
  for (const k of ['club_id', 'name', 'city', 'mode', 'state', 'plan', 'price_per_table_kopecks', 'personal_price', 'tables', 'monthly_kopecks', 'trial_until', 'paid_until', 'debt_kopecks', 'open_invoice', 'autopay', 'card']) assert.ok(k in list.items[0], k);
  assert.ok(!('__sub' in list.items[0]));
  assert.ok(list.items.every((x) => typeof x.timezone === 'string' && x.timezone), 'у каждого клуба пояс');
  assert.ok(list.totals.mrr_kopecks > 0);
  assert.ok(list.totals.debt_kopecks > 0);
  assert.equal(Object.values(list.totals.clubs).reduce((a, n) => a + n, 0), 6);
  const dev = list.items.find((x) => x.club_id === CLUB);
  assert.equal(dev.state, 'past_due');
  const url = `/api/platform/subscriptions/${CLUB}/mark-paid`;
  assert.equal((await req(b, 'POST', url, { invoice_id: dev.open_invoice.id, document: '77' })).body.error, 'reason_required');
  assert.equal((await req(b, 'POST', url, { invoice_id: dev.open_invoice.id, reason: 'Оплата по счёту' })).body.error, 'bad_request');
  const paid = (await req(b, 'POST', url, { invoice_id: dev.open_invoice.id, reason: 'Оплата по счёту', document: '77' })).body;
  assert.equal(paid.paid_via, 'manual');
  assert.equal((await req(b, 'POST', url, { invoice_id: dev.open_invoice.id, reason: 'Ещё раз', document: '77' })).body.error, 'invoice_paid');
  const after = (await req(b, 'GET', '/api/platform/subscriptions')).body;
  assert.equal(after.items.find((x) => x.club_id === CLUB).state, 'active');
  assert.ok(after.totals.debt_kopecks < list.totals.debt_kopecks);
  const price = await req(b, 'PUT', `/api/platform/subscriptions/${CLUB}/price`, { price_per_table_kopecks: 59000, reason: 'Пилот' });
  assert.deepEqual(price.body, { club_id: CLUB, price_per_table_kopecks: 59000, personal_price: true });
  assert.equal((await req(b, 'PUT', `/api/platform/subscriptions/${CLUB}/price`, { price_per_table_kopecks: null })).body.error, 'reason_required');
  // Цена плана (PUT /api/platform/plans/{id}) — со следующего счёта у клубов без персональной цены
  const planId = list.plans[0].id;
  assert.equal((await req(b, 'PUT', `/api/platform/plans/${planId}`, { price_per_table_kopecks: -1 })).body.error, 'bad_request');
  assert.equal((await req(b, 'PUT', `/api/platform/plans/${planId}`, {})).body.error, 'bad_request');
  assert.equal((await req(b, 'PUT', '/api/platform/plans/bf000000-0000-4000-8000-00000000ffff', { price_per_table_kopecks: 1 })).body.error, 'not_found');
  const plan = (await req(b, 'PUT', `/api/platform/plans/${planId}`, { price_per_table_kopecks: 89000, reason: 'Индексация' })).body;
  assert.equal(plan.price_per_table_kopecks, 89000);
  for (const k of ['id', 'code', 'title', 'price_per_table_kopecks', 'trial_days', 'active']) assert.ok(k in plan, k);
  const repriced = (await req(b, 'GET', '/api/platform/subscriptions')).body;
  assert.equal(repriced.plans[0].price_per_table_kopecks, 89000);
  assert.equal(repriced.items.find((x) => x.club_id === CLUB).price_per_table_kopecks, 59000, 'персональная цена не меняется');
  const second = repriced.items.find((x) => x.club_id === 'bc000000-0000-4000-8000-000000000002');
  assert.equal(second.price_per_table_kopecks, 89000, 'клуб без персональной цены — новая цена');
  b.scenario('platform-billing-operator');
  assert.equal((await req(b, 'GET', '/api/platform/subscriptions')).status, 200);
  assert.equal((await req(b, 'PUT', `/api/platform/plans/${planId}`, { price_per_table_kopecks: 1, reason: 'r' })).body.error, 'forbidden', 'оператор цену плана не меняет');
  assert.equal((await req(b, 'POST', url, { invoice_id: 'x', reason: 'r', document: '1' })).body.error, 'forbidden', 'оператор — только чтение');
  b.scenario('owner');
  assert.equal((await req(b, 'GET', '/api/platform/subscriptions')).body.error, 'forbidden');
});
