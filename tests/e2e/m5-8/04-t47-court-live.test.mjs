// T47 (часть 2): корты сида 101 и 102 (клуб live, Екатеринбург) — игра по QR, свет на правильном ресурсе, продление слотом,
// до 4 игроков, бронь корта и ранний приход по минутам, граница расписания внутри слота, отчёт смены и дашборд по видам.
// docs/contracts/m5-5-8.md №203–205, decisions №212, №213, №219.
//
// Деньги — эмулятор ЮKassa (docker exec …/__emu/…), контроллеры — симулятор (http://127.0.0.1:18080). Корты в начале ждут,
// пока свободны (рядом идут чужие проверки), и в конце освобождаются («Закончить игру», отмена своих броней).
// Столы 1–8 и чужая смена ресепшена не трогаются: отчёт смены читается как есть (если открытой смены нет — своя на время теста).

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  api, apiWait, CLUB_SEED, COURTS, emuPayment, emuSucceed, extendGame, localToUtc, login, newGuest, providerId, quote, roundRub, saveState, SEED_PHONES, short, sim,
  sleep, startGame, stopGame, tableByCode, TZ, waitCourtFree, waitFor,
} from './lib.mjs';

const S = { sessions: [], bookings: [] };
const SLOT = 90;

/** Состояние всех контроллеров сида: номер → { mode, relay, session_id }. */
async function simAll() {
  const out = {};
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 101, 102]) {
    const s = (await sim(n)).state;
    out[n] = { mode: s.mode, relay: s.relay, session_id: s.session_id };
  }
  return out;
}

before(async () => {
  S.owner = await login(SEED_PHONES.owner);
  S.man = await login(SEED_PHONES.manager);
  S.rec = await login(SEED_PHONES.reception);
  S.payer = await newGuest();
  S.court = await api('GET', `/api/clubs/${CLUB_SEED}/resources`, { token: S.owner.token, club: CLUB_SEED }).then((r) => r.json.resources.filter((x) => x.family === 'court'));
  await waitCourtFree(101, S.payer.token);
  await waitCourtFree(102, S.payer.token);
  S.simBefore = await simAll();
  S.shiftCur = (await api('GET', `/api/clubs/${CLUB_SEED}/shifts/current`, { token: S.man.token, club: CLUB_SEED })).json.shift;
  if (!S.shiftCur) {
    const o = await api('POST', `/api/clubs/${CLUB_SEED}/shifts`, { token: S.rec.token, club: CLUB_SEED, body: { float_kopecks: 0 } });
    if (o.status === 201) {
      S.ownShift = o.json.id;
      S.shiftCur = o.json;
    }
  }
});

after(async () => {
  for (const { guest, id } of S.sessions) await stopGame(guest, id).catch(() => {});
  for (const b of S.bookings) await api('POST', `/api/bookings/${b.id}/cancel`, { token: b.guest.token, body: {} }).catch(() => {});
  if (S.ownShift) {
    const cur = (await api('GET', `/api/clubs/${CLUB_SEED}/shifts/current`, { token: S.man.token, club: CLUB_SEED })).json.shift;
    if (cur?.id === S.ownShift) await api('POST', `/api/shifts/${S.ownShift}/close`, { token: S.rec.token, body: { actual_cash_kopecks: cur.expected_cash_kopecks ?? 0, comment: 'e2e M5.8: своя смена' } });
  }
  for (const n of [101, 102]) await waitCourtFree(n, S.payer.token, 60_000).catch(() => {});
});

describe('T47. корты сида: игра по QR', () => {
  it('QR корта: вид, слот, до 4 игроков, цена слота «сейчас» и «дальше»; «Без лимита» в вариантах нет; QR корта ≠ QR стола', async (t) => {
    const r = await tableByCode(COURTS[101].code, S.payer.token);
    assert.equal(r.status, 200, short(r));
    const x = r.json;
    assert.deepEqual([x.resource.family, x.resource.kind, x.resource.billing, x.resource.slot_minutes, x.resource.max_players, x.resource.title], ['court', 'padel_court', 'slot', SLOT, 4, 'Корт 1']);
    assert.equal(x.club.id, CLUB_SEED);
    assert.ok(Number.isInteger(x.price_now.price_per_slot_kopecks) && x.price_now.price_per_slot_kopecks > 0);
    assert.equal(x.price_now.slot_minutes, SLOT);
    assert.ok(x.options.every((m) => Number.isInteger(m) && m % SLOT === 0), `варианты — слоты: ${x.options}`);
    assert.ok(!x.options.includes('unlimited'), 'для корта нет «Без лимита»');
    assert.ok(x.options.length >= 2, 'несколько слотов на выбор');
    // Стол — по часам, «Без лимита» есть.
    const tb = (await tableByCode('TEST000001', S.payer.token)).json;
    assert.deepEqual([tb.resource.family, tb.resource.billing, tb.resource.slot_minutes], ['table', 'hourly', null]);
    assert.ok(tb.options.includes('unlimited'));
    // Короткая ссылка /t/{код} → экран гостя.
    const sl = await api('GET', `/t/${COURTS[101].code}`);
    assert.equal(sl.status, 302);
    assert.equal(sl.headers.location, `/app/t/${COURTS[101].code}`);
    t.diagnostic(`цена сейчас: ${x.price_now.price_per_slot_kopecks / 100} ₽ за слот ${SLOT} мин до ${x.price_now.until_local}; варианты ${x.options.join('/')}`);
    S.priceNow = x.price_now;
  });

  it('«Без лимита», баланс пакета и депозит наличными на корте — 400', async (t) => {
    const g = await newGuest();
    const rid = COURTS[101].id;
    const un = await quote(g.token, { resource_id: rid, kind: 'start', minutes: null });
    assert.equal(un.status, 400, short(un));
    assert.equal(un.json.error, 'bad_request');
    const bal = await quote(g.token, { resource_id: rid, kind: 'start', minutes: SLOT, use_balance: true });
    assert.equal(bal.status, 400, short(bal));
    const un2 = await quote(g.token, { resource_id: rid, kind: 'start', minutes: 'unlimited' });
    assert.equal(un2.status, 400, short(un2));
    // Депозит «Без лимита» — касса ресепшена: нужна открытая смена (чужая или своя — S.shiftCur).
    if (S.shiftCur) {
      const dep = await api('POST', '/api/reception/deposits', { token: S.rec.token, idem: true, body: { resource_id: COURTS[102].id, amount_kopecks: 500_000 } });
      assert.equal(dep.status, 400, `депозит на корт: ${short(dep)}`);
      assert.equal(dep.json.error, 'bad_request');
      t.diagnostic('депозит 5 000 ₽ «Без лимита» на корте 102 → 400; на столе того же клуба — по ТЗ (проверяется в M3)');
    } else t.diagnostic('смены нет — депозит не проверялся');
    const free = await tableByCode(COURTS[102].code, g.token);
    assert.equal(free.json.status, 'free', 'после отказов корт свободен');
    assert.equal((await sim(102)).state.relay, false);
  });

  it('оплата слота СБП: сессия, свет только на корте 101 (столы и корт 102 не тронуты), остаток ~90 мин, журнал и чек', async (t) => {
    S.before101 = await simAll();
    S.t0 = Date.now();
    const gm = await startGame(101, SLOT, S.payer);
    S.game = gm;
    S.sessions.push({ guest: S.payer, id: gm.sessionId });
    assert.deepEqual([gm.q.slots, gm.q.slot_minutes, gm.q.minutes], [1, SLOT, SLOT], `котировка ${JSON.stringify(gm.q)}`);
    assert.ok(gm.q.amount_kopecks > 0 && gm.q.amount_kopecks % 100 === 0, `сумма ${gm.q.amount_kopecks}`);
    const s101 = await waitFor(async () => {
      const s = await sim(101);
      return s.state.mode === 'active' && s.state.relay ? s : null;
    }, { what: 'свет корта 101', timeoutMs: 10_000 });
    const latency = Date.now() - S.t0;
    assert.equal(s101.state.session_id, gm.sessionId, 'сессия контроллера = сессия сервера');
    assert.ok(s101.state.remaining_ms > 89 * 60_000 && s101.state.remaining_ms <= 90 * 60_000, `остаток ${s101.state.remaining_ms}`);
    assert.equal(s101.lamp, true);
    const now = await simAll();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 102]) {
      assert.notEqual(now[n].session_id, gm.sessionId, `сессия корта 101 на ресурсе ${n}`);
    }
    assert.equal(now[102].relay, false, 'корт 102 не тронут');
    const sess = (await api('GET', `/api/sessions/${gm.sessionId}`, { token: S.payer.token })).json;
    assert.deepEqual([sess.resource.family, sess.resource.title, sess.billing ?? sess.resource.billing, sess.resource.max_players], ['court', 'Корт 1', 'slot', 4]);
    assert.equal(Date.parse(sess.paid_until) - Date.parse(sess.started_at), SLOT * 60_000, 'оплачено ровно слот');
    // Чек: «Корт 1, 90 минут»; платёж с описанием корта (находка Н-3 исправлена) — через квитанцию сессии.
    const rc = (await api('GET', `/api/sessions/${gm.sessionId}/receipt`, { token: S.payer.token })).json;
    assert.match(rc.lines[0].title, /^Корт 1, 90 минут/);
    assert.equal(rc.total_kopecks, gm.q.amount_kopecks);
    assert.ok(!/Стол/.test(JSON.stringify(rc)), 'в чеке нет слова «Стол»');
    // Тот же платёж в эмуляторе: описание и позиция чека говорят «корт».
    const em = JSON.stringify(emuPayment(gm.pid));
    assert.ok(!/Стол/.test(em), `эмулятор: ${em.slice(0, 300)}`);
    assert.match(em, /[Кк]орт/);
    t.diagnostic(`оплата → свет (с запуском оплаты): ${latency} мс; сумма ${gm.q.amount_kopecks / 100} ₽; эмулятор: ${em.match(/"description":"[^"]*"/)?.[0] ?? ''}`);
  });

  it('до 4 игроков: «Я играю» — игроки 2–4; пятый — отказ; чужой код (стол, корт 102) — 404', async (t) => {
    const id = S.game.sessionId;
    const g = [await newGuest(), await newGuest(), await newGuest(), await newGuest()];
    for (const [label, code] of [['код стола 1', 'TEST000001'], ['код корта 102', COURTS[102].code]]) {
      const j = await api('POST', `/api/sessions/${id}/join`, { token: g[0].token, body: { code } });
      assert.equal(j.status, 404, `${label}: ${short(j)}`);
    }
    for (let i = 0; i < 3; i += 1) {
      const j = await api('POST', `/api/sessions/${id}/join`, { token: g[i].token, body: { code: COURTS[101].code } });
      assert.equal(j.status, 200, `игрок ${i + 2}: ${short(j)}`);
    }
    const over = await api('POST', `/api/sessions/${id}/join`, { token: g[3].token, body: { code: COURTS[101].code } });
    assert.ok(over.status >= 400 && over.status < 500, `пятый игрок: ${short(over)}`);
    t.diagnostic(`пятый игрок: ${over.status} ${over.json?.error}`);
    const view = (await api('GET', `/api/sessions/${id}`, { token: S.payer.token })).json;
    assert.equal(view.participants.length, 4, 'в игре ровно 4');
    // Повторный «Я играю» тем же гостем не плодит игроков.
    await api('POST', `/api/sessions/${id}/join`, { token: g[0].token, body: { code: COURTS[101].code } });
    assert.equal((await api('GET', `/api/sessions/${id}`, { token: S.payer.token })).json.participants.length, 4);
    // Пятый не получает и котировку продления как участник.
    const q5 = await quote(g[3].token, { resource_id: S.game.t.resource.id, kind: 'extend', session_id: id, minutes: SLOT });
    assert.ok([403, 404].includes(q5.status), `пятый — продление: ${short(q5)}`);
  });

  it('продление слотом: +90 мин по цене слота на момент продления, свет и остаток на контроллере ~180 мин; 5-й слот не продаётся', async (t) => {
    const e = await extendGame(101, S.game.sessionId, SLOT, S.payer);
    assert.equal(e.q.status, 200, short(e.q));
    assert.deepEqual([e.q.json.slots, e.q.json.slot_minutes, e.q.json.minutes], [1, SLOT, SLOT]);
    assert.equal(Date.parse(e.after.paid_until) - Date.parse(e.before.paid_until), SLOT * 60_000);
    const s = await waitFor(async () => {
      const x = await sim(101);
      return x.state.remaining_ms > 175 * 60_000 ? x : null;
    }, { what: 'остаток ~180 мин на контроллере', timeoutMs: 10_000 });
    assert.ok(s.state.remaining_ms <= 180 * 60_000, `остаток ${s.state.remaining_ms}`);
    assert.equal(s.state.relay, true);
    // Чек двух позиций.
    const rc = (await api('GET', `/api/sessions/${S.game.sessionId}/receipt`, { token: S.payer.token })).json;
    assert.deepEqual(rc.lines.map((l) => l.kind), ['start', 'extend']);
    assert.equal(rc.total_kopecks, S.game.q.amount_kopecks + e.q.json.amount_kopecks);
    t.diagnostic(`продление: ${e.q.json.amount_kopecks / 100} ₽; остаток ${Math.round(s.state.remaining_ms / 60000)} мин`);
    // Чужой гость продлить не может.
    const stranger = await newGuest();
    const bad = await quote(stranger.token, { resource_id: S.game.t.resource.id, kind: 'extend', session_id: S.game.sessionId, minutes: SLOT });
    assert.equal(bad.status, 403, short(bad));
  });

  it('«Закончить игру»: свет гаснет, корт свободен для следующего гостя', async () => {
    const st = await stopGame(S.payer, S.game.sessionId);
    assert.equal(st.status, 200, short(st));
    S.sessions = S.sessions.filter((x) => x.id !== S.game.sessionId);
    await waitFor(async () => {
      const s = (await sim(101)).state;
      return s.mode === 'free' && s.relay === false ? s : null;
    }, { what: 'корт 101 свободен', timeoutMs: 15_000 });
    const g = await newGuest();
    assert.equal((await tableByCode(COURTS[101].code, g.token)).json.status, 'free');
  });
});

describe('T47. бронь корта и старт по QR', () => {
  it('граница расписания (17:00) внутри слота делит слот по минутам: 15:30 → 2 400 ₽, 16:00 → 2 800 ₽, 16:30 → 3 200 ₽, 17:00 → 3 600 ₽', async (t) => {
    const g = await newGuest();
    S.bg = g;
    const tariffs = (await api('GET', `/api/clubs/${CLUB_SEED}/tariffs`, { token: S.owner.token, club: CLUB_SEED })).json;
    const cr = tariffs.rules.filter((r) => r.kind === 'padel_court' && r.days.includes(1));
    const day = cr.find((r) => r.from === '06:00');
    const eve = cr.find((r) => r.to === '06:00' && r.from === '17:00');
    assert.ok(day && eve, `правила корта по понедельникам: ${JSON.stringify(cr.map((r) => [r.from, r.to]))}`);
    // Ближайший понедельник (>= 2 суток вперёд): локальные сутки клуба.
    const d = new Date(Date.now() + 2 * 86_400_000);
    while (new Intl.DateTimeFormat('en-US', { timeZone: TZ.ekb, weekday: 'short' }).format(d) !== 'Mon') d.setUTCDate(d.getUTCDate() + 1);
    const monday = d.toISOString().slice(0, 10);
    const perMin = (r) => r.price_per_slot_kopecks / r.slot_minutes;
    const lines = [];
    for (const [hhmm, dayMin] of [['15:30', 90], ['16:00', 60], ['16:30', 30], ['17:00', 0]]) {
      const expected = roundRub(dayMin * perMin(day) + (SLOT - dayMin) * perMin(eve));
      const r = await apiWait('POST', '/api/bookings', { token: g.token, body: { resource_id: COURTS[102].id, starts_at: localToUtc(monday, hhmm, TZ.ekb).toISOString(), minutes: SLOT } });
      assert.equal(r.status, 201, `${hhmm}: ${short(r)}`);
      S.bookings.push({ id: r.json.id, guest: g });
      await apiWait('POST', `/api/bookings/${r.json.id}/cancel`, { token: g.token, body: {} });
      assert.equal(r.json.amount_kopecks, expected, `${hhmm}: ${r.json.amount_kopecks} вместо ${expected}`);
      lines.push(`${hhmm}=${r.json.amount_kopecks / 100} ₽`);
    }
    S.bookings = [];
    t.diagnostic(`понедельник ${monday}: ${lines.join('; ')}`);
  });

  it('ранний приход по брони корта: доплата считается по минутам до начала, а не целым слотом; после доплаты — игра, свет на корте 102', async (t) => {
    const g = await newGuest();
    S.rg = g;
    const price = (await tableByCode(COURTS[102].code, g.token)).json.price_now;
    // Начало брони — ближайшая получасовая отметка не раньше чем через 50 минут.
    const start = new Date(Math.ceil((Date.now() + 50 * 60_000) / 1_800_000) * 1_800_000);
    const b = await apiWait('POST', '/api/bookings', { token: g.token, body: { resource_id: COURTS[102].id, starts_at: start.toISOString(), minutes: SLOT } });
    assert.equal(b.status, 201, short(b));
    S.bookings.push({ id: b.json.id, guest: g });
    assert.equal(b.json.prepayment_kopecks, b.json.amount_kopecks, 'предоплата 100 %');
    const pay = await apiWait('POST', `/api/bookings/${b.json.id}/pay`, { token: g.token, body: { method: 'sbp' }, idem: true });
    assert.equal(pay.status, 200, short(pay));
    emuSucceed(providerId(pay.json));
    const mine = await waitFor(async () => {
      const r = await api('GET', `/api/bookings/${b.json.id}`, { token: g.token });
      return r.json.status === 'confirmed' ? r.json : null;
    }, { what: 'бронь подтверждена предоплатой' });
    assert.equal(mine.paid_kopecks, b.json.amount_kopecks);
    const t0 = Date.now();
    const st = await apiWait('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: COURTS[102].code } });
    const t1 = Date.now();
    assert.equal(st.status, 200, short(st));
    assert.equal(st.json.status, 'payment_required', short(st));
    assert.equal((await sim(102)).state.relay, false, 'свет до доплаты не включён');
    const minutesTo = (at) => Math.floor((start.getTime() - at) / 60_000);
    const slotPrice = b.json.amount_kopecks;
    const perMinute = price.price_per_slot_kopecks / price.slot_minutes;
    const crosses = price.until && Date.parse(price.until) < start.getTime();
    const allowed = new Set();
    for (let e = minutesTo(t1) - 1; e <= minutesTo(t0) + 1; e += 1) allowed.add(roundRub(e * perMinute));
    t.diagnostic(`до начала ~${minutesTo(t0)} мин; доплата ${st.json.amount_kopecks / 100} ₽ (цена слота ${slotPrice / 100} ₽, по минутам ${[...allowed].map((x) => x / 100).join('/')} ₽)${crosses ? '; граница расписания внутри — точность не проверяется' : ''}`);
    assert.ok(st.json.amount_kopecks > 0 && st.json.amount_kopecks < slotPrice, `доплата должна быть меньше цены слота: ${st.json.amount_kopecks} ≥ ${slotPrice}`);
    if (!crosses) assert.ok(allowed.has(st.json.amount_kopecks), `доплата ${st.json.amount_kopecks} не равна расчёту по минутам ${[...allowed]}`);
    // Доплата → игра по брони.
    const q = st.json.quote;
    const pp = await payQuoteSbp(g, q.quote_id);
    S.rgPay = pp;
    const session = await waitFor(async () => {
      const r = await api('GET', `/api/bookings/${b.json.id}`, { token: g.token });
      return r.json.status === 'started' && r.json.session_id ? r.json : null;
    }, { what: 'бронь начата', timeoutMs: 20_000 });
    S.sessions.push({ guest: g, id: session.session_id });
    const s102 = await waitFor(async () => {
      const s = await sim(102);
      return s.state.mode === 'active' && s.state.relay ? s : null;
    }, { what: 'свет корта 102' });
    assert.equal(s102.state.session_id, session.session_id);
    assert.equal((await sim(101)).state.relay, false, 'корт 101 не тронут');
    const sv = (await api('GET', `/api/sessions/${session.session_id}`, { token: g.token })).json;
    assert.equal(sv.booking_id, b.json.id);
    assert.equal(sv.resource.family, 'court');
    // Игра по брони идёт до конца брони: оплачено до starts_at + слот (раньше пришёл — не дольше брони).
    assert.ok(Date.parse(sv.paid_until) <= Date.parse(mine.ends_at) + 60_000, `paid_until ${sv.paid_until} позже конца брони ${mine.ends_at}`);
    const stop = await stopGame(g, session.session_id);
    assert.equal(stop.status, 200, short(stop));
    S.sessions = S.sessions.filter((x) => x.id !== session.session_id);
    S.bookings = [];
    await waitCourtFree(102, g.token, 20_000);
  });

  it('приход раньше чем за 120 минут до начала — отказ too_early, света нет; чужой код — отказ; чужой гость не стартует чужую бронь', async (t) => {
    const g = await newGuest();
    const start = new Date(Math.ceil((Date.now() + 4 * 3600_000) / 1_800_000) * 1_800_000);
    const b = await apiWait('POST', '/api/bookings', { token: g.token, body: { resource_id: COURTS[102].id, starts_at: start.toISOString(), minutes: SLOT } });
    assert.equal(b.status, 201, short(b));
    S.bookings.push({ id: b.json.id, guest: g });
    // Без предоплаты бронь «ждёт оплаты» — старт невозможен.
    const unpaid = await apiWait('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: COURTS[102].code } });
    assert.ok(unpaid.status >= 400 && unpaid.status < 500, `без предоплаты: ${short(unpaid)}`);
    const pay = await apiWait('POST', `/api/bookings/${b.json.id}/pay`, { token: g.token, body: { method: 'sbp' }, idem: true });
    assert.equal(pay.status, 200, short(pay));
    emuSucceed(providerId(pay.json));
    await waitFor(async () => ((await api('GET', `/api/bookings/${b.json.id}`, { token: g.token })).json.status === 'confirmed' ? true : null), { what: 'бронь подтверждена' });
    const early = await apiWait('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: COURTS[102].code } });
    assert.ok(early.status >= 400 && early.status < 500, `за 4 часа до начала: ${short(early)}`);
    t.diagnostic(`за ~4 ч до начала: ${early.status} ${early.json?.error}`);
    const wrong = await apiWait('POST', `/api/bookings/${b.json.id}/start`, { token: g.token, body: { code: COURTS[101].code } });
    assert.ok([403, 404].includes(wrong.status), `чужой код: ${short(wrong)}`);
    const other = await newGuest();
    const stranger = await apiWait('POST', `/api/bookings/${b.json.id}/start`, { token: other.token, body: { code: COURTS[102].code } });
    assert.ok([403, 404].includes(stranger.status), `чужой гость: ${short(stranger)}`);
    assert.equal((await sim(102)).state.relay, false, 'света нет');
    assert.equal((await tableByCode(COURTS[102].code, g.token)).json.status, 'free');
    // Отмена менее чем за 2 часа до начала — без возврата, за 4 часа — с возвратом (№115, политика клуба).
    const c = await apiWait('POST', `/api/bookings/${b.json.id}/cancel`, { token: g.token, body: {} });
    assert.equal(c.status, 200, short(c));
    t.diagnostic(`отмена за ~4 ч: возврат ${c.json.refund_kopecks ?? '?'} коп.`);
    S.bookings = [];
  });
});

async function payQuoteSbp(g, quoteId) {
  const r = await api('POST', `/api/quotes/${quoteId}/pay`, { token: g.token, body: { method: 'sbp' }, idem: true });
  assert.ok(r.status === 200 || r.status === 201, short(r));
  emuSucceed(providerId(r.json));
  return r.json;
}

describe('T47. отчёт смены и дашборд по видам ресурсов', () => {
  it('отчёт смены: play.by_family (столы / корты) и by_type; сумма по видам = итог; корты — «Корт N»', async (t) => {
    const cur = (await api('GET', `/api/clubs/${CLUB_SEED}/shifts/current`, { token: S.man.token, club: CLUB_SEED })).json.shift;
    assert.ok(cur, 'открытая смена есть');
    const rep = (await api('GET', `/api/shifts/${cur.id}/report?online=0`, { token: S.man.token })).json;
    const p = rep.play;
    const fam = Object.fromEntries(p.by_family.map((f) => [f.family, f]));
    assert.ok(fam.table && fam.court, `семьи: ${p.by_family.map((f) => f.family)}`);
    assert.equal(fam.table.resources, 8);
    assert.equal(fam.court.resources, 2);
    assert.equal(fam.table.sessions + fam.court.sessions, p.sessions, 'сессии: столы + корты = итог');
    assert.equal(fam.table.minutes + fam.court.minutes, p.minutes);
    const types = p.by_type.reduce((a, x) => a + x.sessions, 0);
    assert.equal(types, p.sessions, 'сумма по типам = итог');
    assert.ok(p.by_type.some((x) => x.type === 'padel_court' && x.family === 'court'));
    const courts = p.by_resource.filter((r) => r.family === 'court');
    assert.deepEqual(courts.map((r) => r.title), ['Корт 1', 'Корт 2']);
    assert.ok(p.by_resource.filter((r) => r.family === 'table').every((r) => /^Стол \d+$/.test(r.title)));
    // Моя игра на корте 101 (780 000+ коп.) учтена, если смена открыта до неё.
    if (Date.parse(cur.opened_at) < S.t0) {
      assert.ok(fam.court.revenue_kopecks >= S.game.q.amount_kopecks, `выручка кортов ${fam.court.revenue_kopecks} < моя оплата ${S.game.q.amount_kopecks}`);
      const c101 = courts.find((r) => r.title === 'Корт 1');
      assert.ok(c101.sessions >= 1 && c101.revenue_kopecks >= S.game.q.amount_kopecks);
    }
    t.diagnostic(`смена №${cur.number}: столы ${fam.table.sessions} игр / ${fam.table.revenue_kopecks / 100} ₽; корты ${fam.court.sessions} игр / ${fam.court.revenue_kopecks / 100} ₽`);
  });

  it('дашборд «Зал»: фильтр «Столы / Корты» (kind=table|court): игры, часы, ёмкость складываются в «все»; by_type и by_resource несут вид', async (t) => {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: TZ.ekb, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 6 * 3600_000));
    const get = async (kind) => {
      const q = kind ? `&kind=${kind}` : '';
      const r = await api('GET', `/api/clubs/${CLUB_SEED}/dashboard?tab=hall&from=${d}&to=${d}${q}`, { token: S.man.token, club: CLUB_SEED });
      assert.equal(r.status, 200, short(r));
      return r.json;
    };
    // Сутки живые: ждём, пока кэш (15 с) не даст трёх согласованных ответов подряд.
    let all;
    let tab;
    let cou;
    for (let i = 0; i < 4; i += 1) {
      all = await get(null);
      tab = await get('table');
      cou = await get('court');
      const v = (j, id) => j.tiles.find((x) => x.id === id)?.value;
      if (Math.abs(v(all, 'games') - v(tab, 'games') - v(cou, 'games')) === 0) break;
      await sleep(16_000);
    }
    const v = (j, id) => j.tiles.find((x) => x.id === id)?.value;
    assert.equal(v(all, 'games'), v(tab, 'games') + v(cou, 'games'), 'игры: все = столы + корты');
    assert.ok(Math.abs(v(all, 'play_hours') - v(tab, 'play_hours') - v(cou, 'play_hours')) < 0.2, 'часы игры');
    assert.ok(Math.abs(v(all, 'capacity_hours') - v(tab, 'capacity_hours') - v(cou, 'capacity_hours')) < 0.2, 'ёмкость');
    assert.ok(v(cou, 'games') >= 1, 'на кортах сегодня есть игры');
    // Корт 8 столов не «рисует»: ёмкость кортов = 2 корта × часы клуба.
    assert.ok(v(cou, 'capacity_hours') < v(tab, 'capacity_hours'), 'ёмкость 2 кортов меньше ёмкости 8 столов');
    const byType = Object.fromEntries(all.tables.by_type.map((x) => [x.type, x]));
    assert.ok(byType.padel_court, `by_type: ${Object.keys(byType)}`);
    assert.ok(all.tables.by_resource.filter((r) => r.type === 'padel_court').length === 2);
    assert.ok(all.tables.by_resource.every((r) => (r.type === 'padel_court' ? /^Корт \d+$/ : /^Стол \d+$/).test(r.title)), 'названия по виду ресурса: «Корт N» / «Стол N»');
    t.diagnostic(`игры: все ${v(all, 'games')}, столы ${v(tab, 'games')}, корты ${v(cou, 'games')}; ёмкость ч: ${v(tab, 'capacity_hours')} + ${v(cou, 'capacity_hours')}`);
    saveState({ t47: { courts: 'ok' } });
  });

  it('все ресурсы свободны в конце: корты 101, 102 — свободны, реле выключены; наши игры закрыты', async () => {
    for (const n of [101, 102]) {
      const s = await waitFor(async () => {
        const x = await sim(n);
        return x.state.mode === 'free' ? x : null;
      }, { what: `корт ${n} свободен`, timeoutMs: 60_000 }).catch(() => null);
      if (s) assert.equal(s.state.relay, false, `реле корта ${n}`);
    }
  });
});
