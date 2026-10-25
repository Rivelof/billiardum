// ЗАХОД 2: сценарий воспроизводил находку Н-1 на кортах сида; после bc51e24 его не запускают на стенде (корты сида
// заняты tester, клуб сида вне зоны повторной проверки). Заменён сценариями на своём Postgres: 11-booking-minutes.test.mjs,
// 15-payment-labels.test.mjs.
// PoC M5.8 / сценарий 10 — ранний приход по брони корта: доплата считается целым слотом (находка Н-1).
//
// Гость бронирует корт сида 102 на ~60 минут вперёд (1 слот, предоплата 100 %), оплачивает предоплату в
// эмуляторе и сразу нажимает «Начать игру» у корта (код из QR). До начала брони ещё около часа, поэтому
// сервер просит доплату за ранний приход (bookings/service.mjs:737–741: `priceOf(.., минуты до начала, false)`).
// У правила слота шаг равен слоту, и минуты округляются вверх до целого слота: ~60 минут стоят как 90.
// Деньги доплаты не платятся, бронь отменяется в конце, корт свободен.
//
// Запуск: node tests/security/m5-8/10-booking-early-arrival.mjs

import { COURT_CODES, api, emuSucceed, login, ok, providerId, runner, tableByCode } from './lib.mjs';

const r = runner('M5.8 / 10: ранний приход по брони корта');
const CODE = COURT_CODES[102];
const g = await login();
let bookingId = null;
try {
  const t = await ok(tableByCode(CODE, g.token));
  const RID = t.resource.id;
  const start = new Date(Math.ceil((Date.now() + 60 * 60_000) / 300_000) * 300_000);
  const b = await api('POST', '/api/bookings', { token: g.token, body: { resource_id: RID, starts_at: start.toISOString(), minutes: 90 } });
  r.check('бронь корта на час вперёд создана', b.status === 201, `${b.status} ${b.json?.error ?? ''}`);
  bookingId = b.json?.id;
  r.check('предоплата 100 % = цена слота', b.json?.prepayment_kopecks === b.json?.amount_kopecks && b.json?.amount_kopecks > 0, `${b.json?.amount_kopecks}`);
  const pp = await ok(api('POST', `/api/bookings/${bookingId}/pay`, { token: g.token, body: { method: 'sbp' }, idem: true }));
  emuSucceed(providerId(pp));
  await new Promise((res) => setTimeout(res, 1500));
  const mine = await ok(api('GET', `/api/bookings/${bookingId}`, { token: g.token }));
  r.check('предоплата принята, бронь подтверждена', mine.status === 'confirmed', mine.status);

  const st = await api('POST', `/api/bookings/${bookingId}/start`, { token: g.token, body: { code: CODE } });
  console.log(`старт по брони: ${st.status} ${st.text.slice(0, 220)}`);
  const minutesEarly = Math.floor((start.getTime() - Date.now()) / 60_000);
  const slotPrice = b.json.amount_kopecks;
  const prorata = Math.round((minutesEarly * slotPrice) / 90);
  r.check('сервер просит доплату за ранний приход', st.status === 200 && st.json?.status === 'payment_required', `${st.status} ${st.json?.status ?? st.json?.error}`);
  if (st.json?.status === 'payment_required') {
    const due = st.json.amount_kopecks;
    r.finding(
      'доплата за ~час раннего прихода = цена целого слота (90 мин), а не часа',
      due >= slotPrice,
      `доплата ${due / 100} ₽ за ${minutesEarly} мин до начала; по минутам было бы ≈ ${prorata / 100} ₽ (цена слота ${slotPrice / 100} ₽)`,
    );
    r.check('свет до доплаты не включился', (await api('GET', `/api/t/${CODE}`, { token: g.token })).json?.status !== 'busy');
  }
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  if (bookingId) {
    const c = await api('POST', `/api/bookings/${bookingId}/cancel`, { token: g.token, body: {} });
    console.log(`бронь отменена: ${c.status} ${c.json?.refund_kopecks !== undefined ? `возврат ${c.json.refund_kopecks / 100} ₽` : ''}`);
  }
  r.done();
}
