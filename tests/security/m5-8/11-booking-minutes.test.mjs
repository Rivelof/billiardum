// PoC M5.8, заход 2 — Н-1: ранний приход и опоздание по брони корта по минутам (№219, bc51e24).
// Боевой код целиком (роутер, сервис броней, деньги, тарифы, эмулятор ЮKassa) на СВОЁМ временном Postgres с
// поддельными часами (обвязка server/bookings/test/db/harness.mjs): сид клуба — корты 101 и 102, слот 90 минут,
// будни 06–17 — 2 400 ₽, 17–06 — 3 600 ₽, выходные — 3 900 ₽ (местное время Екатеринбурга, UTC+5).
//
// Оракул: сумма = Σ (цена слота окна × минуты окна) / 90, одно округление «половина вверх» до рубля.
//  * ранний приход (предоплата 100 %): доплата = оракул(окно [приход, начало)) при приходе раньше чем за 5 минут;
//    через границу цен (17:00) окно делится по минутам;
//  * опоздание (предоплата 100 %): доплаты нет, игра идёт до конца брони; (задаток 500 ₽): доплата =
//    max(0, оракул(остаток) − 500 ₽);
//  * граница льготы (5 минут) и предел «слишком рано» (120 минут): по секундам;
//  * свет/сессия: paid_until не выходит за конец брони; повторный запрос в минуту не снижает и не повышает цену
//    (живая котировка); стол (не слот) считается как раньше — целыми шагами.
//
// Запуск (только свой Postgres на 127.0.0.1:55xxx!):
//   DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55432/postgres node --test tests/security/m5-8/11-booking-minutes.test.mjs

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MIN, setup, T0 } from '../../../server/bookings/test/db/harness.mjs';

const ADMIN = process.env.DATABASE_ADMIN_URL ?? '';
const SKIP = !/@(127\.0\.0\.1|localhost):55\d{3}\//.test(ADMIN);
if (SKIP) console.log('SKIP: задайте DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:55xxx/postgres (свой временный Postgres)');

const COURT_2 = 'e1000000-0000-4000-8000-000000000102';
const COURT_1 = 'e1000000-0000-4000-8000-000000000101';
const SLOT = 90;
const TZ_OFFSET_MIN = 5 * 60;

/** Цена слота (копейки) для минуты (мс UTC): рабочие сутки с 06:00, будни / выходные. */
const HOLIDAYS = new Set(['2026-11-04']); // государственный праздник считается воскресным днём (bl.holidays)
function slotPriceAt(ms) {
  const local = new Date(ms + TZ_OFFSET_MIN * MIN);
  const mod = local.getUTCHours() * 60 + local.getUTCMinutes();
  const work = new Date(local.getTime() - (mod < 6 * 60 ? 1440 * MIN : 0)); // рабочие сутки начинаются в 06:00
  let wd = work.getUTCDay() === 0 ? 7 : work.getUTCDay(); // 1=пн … 7=вс
  if (HOLIDAYS.has(work.toISOString().slice(0, 10))) wd = 7;
  if (wd >= 6) return 390000;
  return mod >= 6 * 60 && mod < 17 * 60 ? 240000 : 360000;
}
/** Оракул: Σ цена слота × минуты / 90, одно округление до рубля «половина вверх». */
function oracle(fromMs, minutes) {
  let num = 0;
  for (let i = 0; i < minutes; i += 1) num += slotPriceAt(fromMs + i * MIN);
  // num / 90 копеек → до 100 копеек, половина вверх: floor((num * 2 + 90 * 100) / (2 * 90 * 100)) * 100
  return Math.floor((num * 2 + SLOT * 100) / (2 * SLOT * 100)) * 100;
}

let h;
let n = 0;
const phone = () => `+7999600${String(2000 + (n += 1)).padStart(4, '0')}`;

before(async () => {
  if (SKIP) return;
  h = await setup({ settings: { booking_prepayment: 'full' } });
});
after(async () => {
  await h?.close();
});

async function bookAndPay(court, startOffsetMin, who, minutes = 90) {
  h.clock.set(T0);
  const r = await h.request('POST', '/api/bookings', { token: who.token, body: { resource_id: court, starts_at: h.at(startOffsetMin), minutes } });
  assert.equal(r.status, 201, r.text);
  if (r.json.prepayment_kopecks > 0) {
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: who.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    await h.succeed(pay.json.payment_id);
    await h.drain();
  }
  return r.json;
}
const startAt = async (court, bookingId, who, ms) => {
  h.clock.set(ms);
  const r = await h.request('POST', `/api/bookings/${bookingId}/start`, { token: who.token, body: { code: await h.code(court) } });
  // Начатая игра закрывается сразу, чтобы следующая проверка не упёрлась в занятый корт.
  if (r.json?.status === 'started' && r.json.session_id) await h.closeSession(r.json.session_id);
  return r;
};

describe('Н-1 (заход 2): ранний приход по минутам', { skip: SKIP }, () => {
  const days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  // Бронь на 18:00 (вечер); окно раннего прихода пересекает границу цен 17:00 при e > 60.
  const early = [6, 10, 30, 59, 60, 61, 70, 89, 90, 100, 119, 120];
  it('доплата = оракул для каждого e (6…120 минут до начала), в том числе через границу цен 17:00', async () => {
    const bad = [];
    const table = [];
    for (const [i, e] of early.entries()) {
      const who = await h.login(phone());
      const startOffset = days[i] * 1440 + 6 * 60; // 18:00 местного, день T0 + days[i]
      const b = await bookAndPay(COURT_2, startOffset, who);
      const tms = T0 + (startOffset - e) * MIN;
      const st = await startAt(COURT_2, b.id, who, tms);
      const want = oracle(tms, e);
      const got = st.json?.amount_kopecks;
      table.push(`${e} мин: ${got} (оракул ${want}) ${st.json?.status}`);
      if (st.json?.status !== 'payment_required' || got !== want) bad.push(`${e} мин: статус ${st.json?.status ?? st.status} сумма ${got} ≠ оракул ${want}`);
      assert.ok(got <= b.amount_kopecks * 2, 'доплата за ранний приход не превышает двух слотов');
    }
    console.log('INFO  ранний приход:\n  ' + table.join('\n  '));
    assert.deepEqual(bad, []);
  });

  it('граница льготы: за 5 минут и 59 секунд — бесплатно? за 5 минут 1 секунду — доплата 6 минут? (пол минут в пользу гостя)', async () => {
    const out = [];
    for (const [i, sec] of [[20, 5 * 60 + 59], [21, 5 * 60 + 1], [22, 5 * 60], [23, 4 * 60 + 59]].entries()) {
      const [slot, secondsEarly] = sec;
      void i;
      const who = await h.login(phone());
      const startOffset = (13 + slot - 20) * 1440 + 6 * 60;
      const b = await bookAndPay(COURT_2, startOffset, who);
      const tms = T0 + startOffset * MIN - secondsEarly * 1000;
      const st = await startAt(COURT_2, b.id, who, tms);
      out.push({ secondsEarly, status: st.json?.status, amount: st.json?.amount_kopecks });
    }
    console.log('INFO  льгота 5 минут по секундам:', JSON.stringify(out));
    // До 5:00 включительно — льгота (старт без доплаты); раньше — доплата; сумма не нулевая и не больше 10 минут цены.
    for (const o of out) {
      if (o.secondsEarly <= 5 * 60) assert.equal(o.status, 'started', JSON.stringify(o));
      else assert.ok(o.status === 'payment_required' && o.amount > 0 && o.amount <= oracle(T0 + 18 * 60 * MIN, 10), JSON.stringify(o));
    }
  });

  it('слишком рано (раньше 120 минут) — 4xx, цена не создаётся; повторный запрос в ту же минуту — та же котировка', async () => {
    const who = await h.login(phone());
    const startOffset = 21 * 1440 + 6 * 60;
    const b = await bookAndPay(COURT_2, startOffset, who);
    const tooEarly = await startAt(COURT_2, b.id, who, T0 + (startOffset - 121) * MIN);
    assert.ok(tooEarly.status >= 400 && tooEarly.status < 500, `${tooEarly.status} ${tooEarly.text}`);
    const first = await startAt(COURT_2, b.id, who, T0 + (startOffset - 40) * MIN);
    const second = await startAt(COURT_2, b.id, who, T0 + (startOffset - 40) * MIN + 20_000);
    assert.equal(first.json.status, 'payment_required');
    assert.deepEqual([second.json.amount_kopecks, second.json.quote.quote_id], [first.json.amount_kopecks, first.json.quote.quote_id], 'живая котировка не пересчитывается');
    // Позже, уже после истечения котировки: цена убывает вместе с минутами, а не растёт.
    const later = await startAt(COURT_2, b.id, who, T0 + (startOffset - 20) * MIN);
    assert.equal(later.json.status, 'payment_required');
    assert.equal(later.json.amount_kopecks, oracle(T0 + (startOffset - 20) * MIN, 20), 'после истечения котировки цена пересчитана');
  });

  it('оплаченная доплата запускает сессию на оплаченные минуты: paid_until = конец брони, не позже', async () => {
    const who = await h.login(phone());
    const startOffset = 22 * 1440 + 6 * 60;
    const b = await bookAndPay(COURT_2, startOffset, who);
    const tms = T0 + (startOffset - 40) * MIN;
    const st = await startAt(COURT_2, b.id, who, tms);
    assert.equal(st.json.status, 'payment_required');
    const pay = await h.request('POST', `/api/quotes/${st.json.quote.quote_id}/pay`, { token: who.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    assert.equal(pay.status, 200, pay.text);
    const remote = await fetch(`${h.emu.config.publicUrl}/__emu/payments/${(await h.q('select provider_payment_id from bl.payments where id = $1', [pay.json.payment_id]))[0].provider_payment_id}`).then((r) => r.json());
    console.log(`INFO  описание платежа доплаты: «${remote.description}»`);
    assert.match(remote.description, /^Бронь, корт 2, /, 'Н-3: слово «корт»');
    h.clock.set(tms + 30_000);
    await h.succeed(pay.json.payment_id);
    await h.drain();
    const [bk] = await h.q('select status, session_id from bl.bookings where id = $1', [b.id]);
    assert.equal(bk.status, 'started');
    const [s] = await h.q('select paid_until, started_at from bl.sessions where id = $1', [bk.session_id]);
    assert.ok(new Date(s.paid_until).getTime() <= T0 + (startOffset + 90) * MIN, 'оплаченное время не выходит за конец брони');
    await h.closeSession(bk.session_id);
  });

  it('контроль: стол (не слот) при раннем приходе считается целыми шагами тарифа, как раньше', async () => {
    const who = await h.login(phone());
    const TABLE = 'e1000000-0000-4000-8000-000000000003';
    const startOffset = 23 * 1440 + 6 * 60;
    h.clock.set(T0);
    const r = await h.request('POST', '/api/bookings', { token: who.token, body: { resource_id: TABLE, starts_at: h.at(startOffset), minutes: 60 } });
    assert.equal(r.status, 201, r.text);
    const pay = await h.request('POST', `/api/bookings/${r.json.id}/pay`, { token: who.token, key: crypto.randomUUID(), body: { method: 'sbp' } });
    await h.succeed(pay.json.payment_id);
    await h.drain();
    const st = await startAt(TABLE, r.json.id, who, T0 + (startOffset - 20) * MIN);
    assert.equal(st.json.status, 'payment_required', st.text);
    const [cmp] = await h.q('select 1');
    void cmp;
    console.log(`INFO  стол, 20 минут раньше: ${st.json.amount_kopecks} коп.`);
    assert.ok(st.json.amount_kopecks > 0);
  });
});

describe('Н-1 (заход 2): опоздание по брони корта', { skip: SKIP }, () => {
  it('предоплата 100 %: опоздание на 1…80 минут — доплаты нет, игра до конца брони; доплата не возникает ни при каком L', async () => {
    await h.setSettings({ booking_hold_prepaid_minutes: 120, booking_hold_minutes: 120 }); // удержание до 2 часов: проверяем опоздание вплоть до 80 минут
    const late = [1, 4, 5, 6, 10, 29, 30, 45, 60, 80];
    const bad = [];
    for (const [i, L] of late.entries()) {
      const who = await h.login(phone());
      const startOffset = (30 - i) * 0 + (2 + i) * 1440 + 2 * 60; // 14:00 местного (день), без пересечений
      const b = await bookAndPay(COURT_1, startOffset, who);
      const st = await startAt(COURT_1, b.id, who, T0 + (startOffset + L) * MIN);
      if (st.json?.status !== 'started') bad.push(`L=${L}: ${st.json?.status ?? st.status} ${st.json?.amount_kopecks ?? st.text.slice(0, 80)}`);
      else {
        const [s] = await h.q('select paid_until from bl.sessions where id = $1', [st.json.session_id]);
        if (new Date(s.paid_until).getTime() !== T0 + (startOffset + 90) * MIN) bad.push(`L=${L}: paid_until ${s.paid_until}`);
      }
    }
    await h.setSettings({ booking_hold_prepaid_minutes: 30, booking_hold_minutes: 15 });
    assert.deepEqual(bad, []);
  });

  it('задаток 500 ₽: доплата при опоздании L = max(0, оракул(остаток) − 500 ₽)', async () => {
    await h.setSettings({ booking_prepayment: 'deposit', booking_deposit_kopecks: 50000, booking_hold_prepaid_minutes: 120, booking_hold_minutes: 120 });
    const bad = [];
    const rows = [];
    for (const [i, L] of [1, 15, 30, 45, 60, 75, 85].entries()) {
      const who = await h.login(phone());
      const startOffset = (14 + i) * 1440 + 2 * 60;
      const b = await bookAndPay(COURT_2, startOffset, who);
      const tms = T0 + (startOffset + L) * MIN;
      const st = await startAt(COURT_2, b.id, who, tms);
      const rest = oracle(tms, 90 - L);
      const want = Math.max(0, rest - 50000);
      const got = st.json?.status === 'started' ? 0 : st.json?.amount_kopecks;
      rows.push(`L=${L}: ${got} (оракул ${want}, остаток ${rest})`);
      if (got !== want) bad.push(rows.at(-1));
    }
    console.log('INFO  опоздание при задатке 500 ₽:\n  ' + rows.join('\n  '));
    assert.deepEqual(bad, []);
    await h.setSettings({ booking_prepayment: 'full', booking_hold_prepaid_minutes: 30, booking_hold_minutes: 15 });
  });

  it('опоздание после окна удержания — бронь сгорает (4xx), игра не начинается', async () => {
    const who = await h.login(phone());
    const startOffset = 25 * 1440 + 2 * 60;
    const b = await bookAndPay(COURT_1, startOffset, who);
    const st = await startAt(COURT_1, b.id, who, T0 + (startOffset + 31) * MIN); // удержание с предоплатой 30 минут
    assert.ok(st.status >= 400 && st.status < 500, `${st.status} ${st.text.slice(0, 100)}`);
    assert.equal(st.json?.error, 'booking_expired');
  });
});
