import { formatDate, formatMoney, plural } from '@billiardum/shared/format';
import { parseRubles } from './cash.js';
import { dayWord, failureText } from './billingBanner.js';

/**
 * Экран «Подписка» владельца и экран платформы «Клубы и подписки» (M5.3, №180–188): состояние словами,
 * сводка, счета, формы ручной оплаты и персональной цены. Формы ответов — server/billing/README.md.
 * Деньги — целые копейки, моменты — ISO UTC, даты счёта — 'YYYY-MM-DD' по поясу клуба.
 */

export { dayWord, failureText };

const DAY = 86_400_000;
const TABLE_FORMS = ['стол', 'стола', 'столов'];
const PAYMENT_FORMS = ['оплата', 'оплаты', 'оплат'];

/** Состояние подписки словами; статус никогда не только цветом — рядом всегда слово. */
export const SUB_STATE = {
  trial: { word: 'Пробный период', tone: 'reserved' },
  active: { word: 'Активна', tone: 'free' },
  past_due: { word: 'Просрочена', tone: 'alert' },
  unpaid: { word: 'Не оплачена', tone: 'alert' },
  canceled: { word: 'Отключена', tone: 'off' },
};

export function subState(state) {
  return SUB_STATE[state] ?? { word: 'Нет данных', tone: 'reserved' };
}

/** Состояние для экрана «Подписка»: счёт выставлен, но списания ещё не было (плашка invoice_due) — «Ждёт списания», не «Просрочена». */
export function subStateOf(sub) {
  if (sub?.banner?.kind === 'invoice_due' && (sub.state === 'past_due' || sub.state === 'unpaid')) return { word: 'Ждёт списания', tone: 'reserved' };
  return subState(sub?.state);
}

export const tablesWord = (n) => `${n} ${plural(n, TABLE_FORMS)}`;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Дата для людей: ISO-момент — по поясу клуба, 'YYYY-MM-DD' — как есть. Другой год — с годом: «23 января 2027».
 * @param {string | null | undefined} value
 * @param {string} timeZone
 * @param {number} [now]
 */
export function dateText(value, timeZone, now = Date.now()) {
  if (!value) return '—';
  const dateOnly = DATE_ONLY.test(value);
  const at = dateOnly ? `${value}T12:00:00Z` : value;
  const tz = dateOnly ? 'UTC' : timeZone;
  const text = formatDate(at, tz);
  const year = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric' }).format(new Date(at)));
  const thisYear = Number(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(new Date(now)));
  return year === thisYear ? text : `${text} ${year}`;
}

/** Период счёта: «23 октября — 23 ноября». */
export function periodText(start, end, timeZone, now = Date.now()) {
  return `${dateText(start, timeZone, now)} — ${dateText(end, timeZone, now)}`;
}

/** Целых суток до момента, вверх (как server/billing/period.mjs daysLeft). */
export function daysUntil(until, now = Date.now()) {
  const ms = new Date(until).getTime() - new Date(now).getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY);
}

/** Карта словами: «MasterCard •• 4477, до 12/30». */
export function cardText(card) {
  if (!card) return null;
  return `${card.type ?? 'Карта'} ${card.mask ?? '••'}${card.expiry ? `, до ${card.expiry}` : ''}`;
}

/** С какой даты не оплачено: открытый счёт, иначе конец периода из плашки, иначе «оплачено до». */
function overdueSince(sub) {
  return sub?.open_invoice?.period_start ?? sub?.banner?.until ?? sub?.paid_until ?? sub?.trial_until ?? null;
}

/**
 * Сводка подписки одной фразой и пояснение: { title, detail }. Для владельца и управляющего
 * (у управляющего нет полей карты — пояснение про автоплатёж не пишем).
 * Подписка не трогает свет и игры — в просрочке прямо говорим, что клуб работает как обычно.
 */
export function summaryOf(sub, { timeZone, now = Date.now() } = {}) {
  if (!sub) return null;
  const owner = 'autopay' in sub;
  const trialDays = sub.trial_days ?? 60;
  if (sub.mode === 'test' && sub.state !== 'canceled') {
    return { title: 'Пробный период ещё не начался', detail: `${trialDays} ${plural(trialDays, ['день', 'дня', 'дней'])} бесплатно начнутся, когда клуб перейдёт в боевой режим. В тестовом режиме программа бесплатна.` };
  }
  switch (sub.state) {
    case 'trial': {
      if (!sub.trial_until) return { title: 'Пробный период', detail: 'Дата окончания появится после перехода клуба в боевой режим.' };
      const left = daysUntil(sub.trial_until, now);
      const detail = left > 0 ? `Осталось ${dayWord(left)}.` : 'Пробный период заканчивается сегодня.';
      const pay = owner && !sub.autopay ? ' Привяжите карту, чтобы первый счёт оплатился сам.' : '';
      return { title: `Пробный период до ${dateText(sub.trial_until, timeZone, now)}`, detail: `${detail}${pay}` };
    }
    case 'active': {
      let detail = '';
      if (owner) detail = sub.autopay ? 'Следующий счёт оплатится с карты автоматически.' : 'Автоплатёж не настроен — привяжите карту, чтобы не оплачивать счета вручную.';
      return { title: `Оплачено до ${dateText(sub.paid_until, timeZone, now)}`, detail };
    }
    case 'past_due':
    case 'unpaid': {
      // invoice_due: счёт выставлен, списания ещё не было (или оно идёт) — это не просрочка (сервер bannerFor)
      if (sub.banner?.kind === 'invoice_due') {
        const at = sub.banner.next_attempt_at ?? sub.banner.until;
        const start = sub.open_invoice?.period_start ?? sub.banner.until;
        const title = start ? `Счёт выставлен ${dateText(start, timeZone, now)}` : 'Счёт выставлен';
        const pay = owner && !sub.card ? ' Привяжите карту — без неё списать не получится.' : at ? ` Спишем с карты автоматически ${dateText(at, timeZone, now)}.` : ' Спишем с карты автоматически.';
        return { title, detail: `${pay.trim()} Свет, игры и оплаты гостей работают как обычно.` };
      }
      const since = overdueSince(sub);
      const title = since ? `Не оплачено с ${dateText(since, timeZone, now)}` : 'Счёт не оплачен';
      const tail = sub.state === 'unpaid' ? ' Если вы платите по счёту от юрлица, напишите в поддержку Бильярдума — оплату отметят вручную.' : '';
      return { title, detail: `Свет, игры и оплаты гостей работают как обычно.${tail}` };
    }
    case 'canceled':
      return { title: 'Подписка отключена', detail: 'Клуб вернулся в тестовый режим — счета не выставляются.' };
    default:
      return { title: subState(sub.state).word, detail: '' };
  }
}

/**
 * Открытый счёт: что не так и что будет дальше.
 * @returns {{ title: string, reason: string | null, next: string } | null}
 */
export function openInvoiceView(sub, { timeZone, now = Date.now() } = {}) {
  const inv = sub?.open_invoice;
  if (!inv) return null;
  const waiting = !(inv.attempts > 0) && !inv.last_error;
  const title = `Счёт на ${formatMoney(inv.amount_kopecks)} за ${periodText(inv.period_start, inv.period_end, timeZone, now)}${waiting ? ' ждёт списания' : ' не оплачен'}`;
  const why = failureText(inv.last_error);
  const reason = why ? `${why[0].toUpperCase()}${why.slice(1)}.` : null;
  let next;
  if (!sub.card) next = 'Привяжите карту — счёт оплатится сразу, и дальше счета будут оплачиваться сами.';
  else if (inv.next_attempt_at && new Date(inv.next_attempt_at).getTime() - now < 10 * 60_000) next = 'Списываем с карты — это займёт несколько минут.';
  else if (inv.next_attempt_at && !(inv.attempts > 0) && !inv.last_error) next = `Спишем с карты автоматически ${dateText(inv.next_attempt_at, timeZone, now)}. Можно не ждать и оплатить сейчас.`;
  else if (inv.next_attempt_at) next = `Следующая попытка списания — ${dateText(inv.next_attempt_at, timeZone, now)}. Можно не ждать и оплатить сейчас.`;
  else next = 'Автоматических попыток больше не будет — оплатите счёт картой.';
  return { title, reason, next };
}

/** Что сделает кнопка карты (purpose сервера): оплата открытого счёта, смена или привязка карты. */
export function cardAction(sub) {
  if (sub?.open_invoice) return { purpose: 'invoice', label: `Оплатить ${formatMoney(sub.open_invoice.amount_kopecks)} картой`, title: 'Оплатить счёт картой' };
  if (sub?.card) return { purpose: 'bind', label: 'Сменить карту', title: 'Сменить карту' };
  return { purpose: 'bind', label: 'Привязать карту', title: 'Привязать карту' };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** Email для чека: обязателен, если раньше не сохранён (400 bad_request). */
export function emailError(value, { required }) {
  const v = String(value ?? '').trim();
  if (!v) return required ? 'Укажите email — на него ЮKassa пришлёт чек.' : null;
  if (v.length > 254 || !EMAIL.test(v)) return 'Проверьте email: например, owner@club.ru.';
  return null;
}

/** Тело POST …/subscription/card: email только если ввели (иначе сервер возьмёт сохранённый). */
export function cardBody(email) {
  const v = String(email ?? '').trim();
  return v ? { email: v } : {};
}

/**
 * Адрес страницы ЮKassa из ответа: только https или свой сайт (заглушка возвращает на /club/subscription).
 * @returns {string | null}
 */
export function safeConfirmationUrl(value, origin) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const u = new URL(value, origin);
    if (u.protocol === 'https:' || u.origin === origin) return u.href;
  } catch {
    // не адрес
  }
  return null;
}

/** Статус счёта словами и тон бейджа; подробности — платёжка или сумма 0. */
export function invoiceStatus(inv) {
  if (inv?.status === 'paid') {
    if (inv.paid_via === 'manual') return { word: 'Оплачен по счёту', tone: 'free', detail: inv.document ? `Платёжное поручение № ${inv.document}` : null };
    if (inv.paid_via === 'free') return { word: 'Без оплаты', tone: 'reserved', detail: 'Сумма 0 ₽' };
    return { word: 'Оплачен картой', tone: 'free', detail: null };
  }
  return { word: 'Не оплачен', tone: 'alert', detail: failureText(inv?.last_error) };
}

/** Чек ЮKassa по счёту: { text, url? }. Ссылки на чек API пока не отдаёт — показываем, куда он ушёл. */
export function receiptView(inv) {
  if (inv?.paid_via !== 'card' || !inv.receipt) return null;
  const r = inv.receipt;
  const url = typeof r.url === 'string' && /^https:\/\//.test(r.url) ? r.url : null;
  if (r.status === 'succeeded') return { text: r.email ? `Чек отправлен на ${r.email}` : 'Чек отправлен', url };
  if (r.status === 'canceled' || r.status === 'failed') return { text: 'Чек не сформирован — напишите в поддержку Бильярдума', url: null };
  return { text: 'Чек формируется', url };
}

// ---------- платформа: «Клубы и подписки» (№186) ----------

/** Должник: есть долг или подписка просрочена. */
export function isDebtor(item) {
  return (item?.debt_kopecks ?? 0) > 0 || item?.state === 'past_due' || item?.state === 'unpaid';
}

/** Фильтр «все» или «должники»; должники — по долгу, больший сверху. */
export function filterClubs(items, filter) {
  const list = Array.isArray(items) ? items : [];
  if (filter !== 'debtors') return list;
  return list.filter(isDebtor).sort((a, b) => (b.debt_kopecks ?? 0) - (a.debt_kopecks ?? 0));
}

/**
 * Дата клуба для экрана платформы — по поясу клуба (поле timezone списка GET /api/platform/subscriptions).
 * Запасной путь, если пояса нет (ответ старого сервера): граница периода — местная полночь клуба, в России это
 * от 12:00 до 22:00 UTC предыдущих суток, и сдвиг на 13 часов даёт ту же дату для всех поясов РФ (UTC+2 … UTC+12).
 */
export function clubDate(iso, timeZone, now = Date.now()) {
  if (!iso) return '—';
  if (timeZone) return dateText(iso, timeZone, now);
  const shifted = new Date(new Date(iso).getTime() + 13 * 3_600_000).toISOString().slice(0, 10);
  return dateText(shifted, 'UTC', now);
}

/** «Оплачено до» в таблице платформы: оплачено, пробный период или прочерк. */
export function paidUntilText(item, now = Date.now()) {
  if (item?.paid_until) return clubDate(item.paid_until, item.timezone, now);
  if (item?.state === 'trial' && item.trial_until) return `пробный до ${clubDate(item.trial_until, item.timezone, now)}`;
  return '—';
}

/** Сколько оплат: «3 оплаты». */
export const paymentsWord = (n) => `${n} ${plural(n, PAYMENT_FORMS)}`;

/** Счётчики состояний для сводки: [['trial', 'Пробный период', 2], …] — только ненулевые. */
export function stateCounts(counts) {
  return Object.keys(SUB_STATE)
    .map((k) => [k, SUB_STATE[k].word, Number(counts?.[k] ?? 0)])
    .filter(([, , n]) => n > 0);
}

const MAX_PRICE = 100_000_000; // 1 000 000 ₽ за стол — защита от лишних цифр

/** Причина ручного действия платформы — непустая, до 2000 символов (server/lib/manual.mjs). */
function reasonError(reason) {
  const v = String(reason ?? '').trim();
  if (!v) return 'Укажите причину — она попадёт в журнал платформы.';
  if (v.length > 2000) return 'Причина длиннее 2000 символов — сократите её.';
  return null;
}

/** Ошибки формы «Отметить оплату»: номер платёжки и причина обязательны. */
export function markPaidErrors(form) {
  const e = {};
  const doc = String(form?.document ?? '').trim();
  if (!doc) e.document = 'Укажите номер платёжного поручения.';
  else if (doc.length > 200) e.document = 'Номер длиннее 200 символов.';
  const r = reasonError(form?.reason);
  if (r) e.reason = r;
  return e;
}

export function markPaidBody(invoiceId, form) {
  return { invoice_id: invoiceId, reason: String(form.reason).trim(), document: String(form.document).trim() };
}

/** Ошибки формы «Персональная цена»: цена в рублях (0 — бесплатно) или возврат к цене плана; причина. */
export function priceErrors(form) {
  const e = {};
  if (!form?.reset) {
    const k = parseRubles(String(form?.rubles ?? ''));
    if (k === null) e.rubles = 'Введите цену за стол в рублях, например 590.';
    else if (k > MAX_PRICE) e.rubles = 'Слишком большая цена — проверьте цифры.';
  }
  const r = reasonError(form?.reason);
  if (r) e.reason = r;
  return e;
}

export function priceBody(form) {
  return { price_per_table_kopecks: form.reset ? null : parseRubles(String(form.rubles)), reason: String(form.reason).trim() };
}

/** Предпросмотр новой цены: «8 столов × 590 ₽ = 4 720 ₽ в месяц, со следующего счёта». */
export function pricePreview(form, item, plan) {
  const price = form?.reset ? (plan?.price_per_table_kopecks ?? null) : parseRubles(String(form?.rubles ?? ''));
  if (price === null || !Number.isSafeInteger(price)) return null;
  const tables = item?.tables ?? 0;
  return `${tablesWord(tables)} × ${formatMoney(price)} = ${formatMoney(tables * price)} в месяц, со следующего счёта.`;
}

// ---------- цена плана (PUT /api/platform/plans/{id}, только platform_admin) ----------

/** Предупреждение в окне цены плана: кого коснётся и когда. */
export const PLAN_PRICE_WARNING = 'Изменится со следующего счёта у всех клубов без персональной цены.';

/** Ошибки формы цены плана: цена в рублях (0 — бесплатно), отличается от текущей; причина обязательна. */
export function planPriceErrors(form, plan) {
  const e = {};
  const k = parseRubles(String(form?.rubles ?? ''));
  if (k === null) e.rubles = 'Введите цену за стол в рублях, например 790.';
  else if (k > MAX_PRICE) e.rubles = 'Слишком большая цена — проверьте цифры.';
  else if (plan && k === plan.price_per_table_kopecks) e.rubles = 'Это текущая цена плана — введите новую.';
  const r = reasonError(form?.reason);
  if (r) e.reason = r;
  return e;
}

export function planPriceBody(form) {
  return { price_per_table_kopecks: parseRubles(String(form.rubles)), reason: String(form.reason).trim() };
}

/**
 * Кого коснётся новая цена плана: клубы на этом плане без персональной цены (кроме отключённых).
 * @returns {{ clubs: number, tables: number, before: number, after: number | null }} — суммы в копейках за месяц
 */
export function planImpact(items, plan, form) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x?.plan?.id === plan?.id && !x.personal_price && x.state !== 'canceled');
  const tables = list.reduce((a, x) => a + (x.tables ?? 0), 0);
  const price = parseRubles(String(form?.rubles ?? ''));
  return { clubs: list.length, tables, before: tables * (plan?.price_per_table_kopecks ?? 0), after: price === null ? null : tables * price };
}

const CLUB_FORMS = ['клуб', 'клуба', 'клубов'];

/** «Затронет 3 клуба, 18 столов: 14 220 ₽ → 16 020 ₽ в месяц.» или «Сейчас на плане нет клубов без персональной цены.» */
export function planImpactText(impact) {
  if (!impact?.clubs) return 'Сейчас на этом плане нет клубов без персональной цены — новая цена достанется новым клубам.';
  const head = `Затронет ${impact.clubs} ${plural(impact.clubs, CLUB_FORMS)}, ${tablesWord(impact.tables)}`;
  return impact.after === null ? `${head}.` : `${head}: ${formatMoney(impact.before)} → ${formatMoney(impact.after)} в месяц.`;
}

/**
 * Итог после страницы ЮKassa (card_pending погас): before — карта и открытый счёт до ухода, sub — ответ сервера.
 * Повторная привязка той же карты итога не меняет — тогда ничего не пишем.
 */
export function outcomeText(before, sub) {
  if (!sub) return null;
  if (before?.invoice_id && sub.open_invoice?.id !== before.invoice_id) return 'Счёт оплачен. Чек ЮKassa пришлёт на email.';
  if (sub.card && sub.card.mask !== (before?.mask ?? null)) return `Готово: карта ${cardText(sub.card)} привязана, автоплатёж включён.`;
  if (before?.invoice_id || !sub.card) return 'Оплата не завершилась. Попробуйте ещё раз или выберите другую карту.';
  return null;
}
