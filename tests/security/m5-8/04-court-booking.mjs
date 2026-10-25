// PoC M5.8 / сценарий 4 — бронь корта: длительность не кратна слоту, начало вне сетки, цена,
// гонка за одно время, старт брони с кодом чужого ресурса.
//
// Атакующий: гость, который хочет забронировать корт на «нестандартное» время дешевле слота,
// занять один интервал дважды или начать бронь корта по QR стола.
// Корт сида 102 (TESTC00002). Все брони создаются на 3 суток вперёд и отменяются в конце.
//
// Запуск: node tests/security/m5-8/04-court-booking.mjs

import { COURT_CODES, api, login, ok, runner, sleep, tableByCode } from './lib.mjs';

const r = runner('M5.8 / 4: бронь корта');
const created = [];
const guests = [];
const guest = async () => {
  const g = await login();
  guests.push(g);
  return g;
};

try {
  const g0 = await guest();
  const court = await ok(tableByCode(COURT_CODES[102], g0.token));
  const RID = court.resource.id;
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const av = await ok(api('GET', `/api/clubs/${court.club.id}/availability?date=${day}`));
  const rates = av.resources.find((x) => x.id === RID).rates;
  const at = (h, m = 0) => new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
  const SLOT = court.resource.slot_minutes;
  // POST /api/bookings ограничен 30 запросами в минуту (api/routes/bookings.mjs:31): после 24 ждём окно.
  let sent = 0;
  const book = async (g, startsAt, minutes, extra = {}) => {
    if (sent >= 24) {
      await sleep(62_000);
      sent = 0;
    }
    sent += 1;
    return api('POST', '/api/bookings', { token: g.token, body: { resource_id: RID, starts_at: startsAt instanceof Date ? startsAt.toISOString() : startsAt, minutes, ...extra } });
  };
  const keep = (resp, g) => {
    if (resp.status === 201 && resp.json?.id) created.push({ id: resp.json.id, g });
    return resp;
  };

  // 1. Валидные: 1 и 2 слота; цена брони = цена слота × слоты (окно одной цены).
  const perSlotAt = (when) => {
    const t = when.getTime();
    const rate = rates.find((x) => new Date(x.from).getTime() <= t && t < new Date(x.to).getTime());
    return rate?.per_slot_kopecks ?? null;
  };
  let g = await guest();
  let b1 = keep(await book(g, at(9, 0), SLOT), g);
  r.check('бронь 1 слот (90 мин) создана', b1.status === 201, `${b1.status} ${b1.json?.error ?? ''}`);
  const p1 = perSlotAt(at(9, 0));
  r.check('цена брони 1 слот = цена слота из расписания', b1.json?.amount_kopecks === p1 && p1 > 0, `${b1.json?.amount_kopecks} vs ${p1}`);
  g = await guest();
  const b2 = keep(await book(g, at(12, 0), 2 * SLOT), g);
  r.check('бронь 2 слота (180 мин) создана', b2.status === 201, `${b2.status} ${b2.json?.error ?? ''}`);
  r.check('цена брони 2 слотов = 2 × слот', b2.json?.amount_kopecks === 2 * perSlotAt(at(12, 0)), `${b2.json?.amount_kopecks}`);

  // 2. Длительность не кратна слоту и вне пределов — 400, ничего не создаётся.
  const badMinutes = [60, 100, 45, 91, 89, 30, 15, 0, -90, 180.5, '90', null, true, 270, 240, 360, 1e9, 86_400_000, Number.MAX_SAFE_INTEGER];
  g = await guest();
  for (const m of badMinutes) {
    const resp = keep(await book(g, at(15, 0), m), g);
    r.check(`бронь корта minutes=${JSON.stringify(m)} — 400`, resp.status === 400, `${resp.status} ${resp.json?.error}`);
  }

  // 3. Начало вне сетки: доли шага, секунды, прошлое, слишком далеко.
  const badStarts = [
    ['на 7 минут от сетки (шаг 5)', at(15, 7)],
    ['секунды', `${day}T15:00:30.000Z`],
    ['миллисекунды', `${day}T15:00:00.500Z`],
    ['в прошлом', new Date(Date.now() - 3600_000)],
    ['через 400 суток', new Date(Date.now() + 400 * 86_400_000)],
    ['не дата', 'завтра'],
    ['null', null],
  ];
  for (const [label, s] of badStarts) {
    const resp = keep(await book(g, s, SLOT), g);
    r.check(`начало: ${label} — 400`, resp.status === 400, `${resp.status} ${resp.json?.error}`);
  }

  // 4. Пересечение: тот же интервал и частичное — 409 booking_conflict.
  const g2 = await guest();
  for (const [label, s] of [['тот же интервал', at(9, 0)], ['со сдвигом на 30 минут внутрь', at(9, 30)], ['начало за слот до конца', at(10, 25)]]) {
    const resp = keep(await book(g2, s, SLOT), g2);
    r.check(`пересечение (${label}) — 409`, resp.status === 409, `${resp.status} ${resp.json?.error}`);
  }

  // 5. Гонка: 6 гостей одновременно бронируют один и тот же интервал.
  const racers = await Promise.all(Array.from({ length: 6 }, () => guest()));
  if (sent > 20) {
    await sleep(62_000);
    sent = 0;
  }
  sent += 6;
  const race = await Promise.all(racers.map((u) => api('POST', '/api/bookings', { token: u.token, body: { resource_id: RID, starts_at: at(17, 0).toISOString(), minutes: SLOT } })));
  race.forEach((resp, i) => keep(resp, racers[i]));
  const won = race.filter((x) => x.status === 201).length;
  r.check('гонка за один интервал: ровно одна бронь', won === 1, `201×${won}, остальные ${race.filter((x) => x.status !== 201).map((x) => x.status).join(',')}`);

  // 6. Старт брони корта: код другого ресурса — forbidden; своего, но неоплаченного — payment_pending.
  const mine = created.find((c) => c.id === b1.json.id);
  const wrong = [['код стола', 'TEST000001'], ['код корта 101', COURT_CODES[101]], ['мусор', 'ZZZZZZZZZZ']];
  for (const [label, code] of wrong) {
    const st = await api('POST', `/api/bookings/${mine.id}/start`, { token: mine.g.token, body: { code } });
    r.check(`старт брони корта с ${label} — 403`, st.status === 403, `${st.status} ${st.json?.error}`);
  }
  const own = await api('POST', `/api/bookings/${mine.id}/start`, { token: mine.g.token, body: { code: COURT_CODES[102] } });
  r.check('старт своей неоплаченной брони (верный код) — не запускает свет: payment_pending/too_early', own.status === 409 || own.status === 403, `${own.status} ${own.json?.error}`);
  const alien = await api('POST', `/api/bookings/${mine.id}/start`, { token: (await guest()).token, body: { code: COURT_CODES[102] } });
  r.check('чужой гость: старт чужой брони — не 200', alien.status !== 200, `${alien.status} ${alien.json?.error}`);
  const view = await api('GET', `/api/bookings/${mine.id}`, { token: (await guest()).token });
  r.check('чужой гость: чтение чужой брони — 404/403', view.status === 404 || view.status === 403, `${view.status}`);
} catch (e) {
  r.check(`сценарий не упал: ${e.message}`, false);
} finally {
  let cancelled = 0;
  for (const c of created) {
    const x = await api('POST', `/api/bookings/${c.id}/cancel`, { token: c.g.token, body: {} });
    if (x.status === 200) cancelled += 1;
  }
  console.log(`отменено броней: ${cancelled}/${created.length}`);
  r.done();
}
