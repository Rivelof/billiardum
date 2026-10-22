import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameView, clockSkew, timerTexts, maxExtendMinutes, lampState, WARN_MS, GRACE_MS } from '../src/lib/game.js';

const T0 = Date.parse('2026-10-21T16:00:00Z'); // 21:00 в Екатеринбурге
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000;
const session = (over = {}) => ({
  id: 's1',
  status: 'active',
  started_at: iso(T0 - 55 * MIN),
  paid_until: iso(T0 + 65 * MIN),
  grace_until: null,
  remaining_ms: 65 * MIN,
  unlimited: false,
  is_payer: true,
  ...over,
});
const TZ = 'Asia/Yekaterinburg';

test('игра идёт: больше 5 минут — обычный таймер', () => {
  const v = gameView(session(), T0);
  assert.deepEqual(v, { phase: 'play', ms: 65 * MIN, until: T0 + 65 * MIN });
  const t = timerTexts(v, { timeZone: TZ });
  assert.equal(t.label, 'Осталось');
  assert.equal(t.note, 'Игра до 22:05');
  assert.equal(t.aria, 'Осталось 1 час 5 минут');
});

test('за 5 минут — янтарный (warn), граница включительно', () => {
  const s = session({ paid_until: iso(T0 + WARN_MS) });
  assert.equal(gameView(s, T0).phase, 'warn');
  assert.equal(gameView(s, T0 - 1).phase, 'play');
  // сервер сказал ending, а часы телефона отстают — всё равно янтарный
  assert.equal(gameView(session({ status: 'ending' }), T0).phase, 'warn');
  const t = timerTexts(gameView(s, T0 + 1000), { timeZone: TZ });
  assert.equal(t.label, 'Меньше 5 минут');
  assert.equal(t.aria, 'Меньше 5 минут: осталось 4 минуты 59 секунд');
});

test('льгота: по grace_until сервера или 2 минуты от paid_until', () => {
  const paid = T0 - 18_000;
  const fromServer = gameView(session({ status: 'grace', paid_until: iso(paid), grace_until: iso(paid + 90_000) }), T0);
  assert.deepEqual(fromServer, { phase: 'grace', ms: 72_000, until: paid + 90_000 });
  // сервер ещё не прислал grace, а время вышло — считаем 2 минуты сами
  const local = gameView(session({ paid_until: iso(paid) }), T0);
  assert.deepEqual(local, { phase: 'grace', ms: GRACE_MS - 18_000, until: paid + GRACE_MS });
  const t = timerTexts(local, { timeZone: TZ });
  assert.equal(t.label, 'Время вышло, льгота');
  assert.equal(t.note, 'Продлите до 21:01, иначе свет погаснет');
  assert.equal(gameView(session({ paid_until: iso(T0 - GRACE_MS) }), T0).phase, 'over');
});

test('«Без лимита» считает вверх, остальные состояния', () => {
  const v = gameView(session({ unlimited: true, started_at: iso(T0 - 72 * MIN), paid_until: iso(T0 + 48 * MIN) }), T0);
  assert.deepEqual(v, { phase: 'unlimited', ms: 72 * MIN, until: T0 + 48 * MIN });
  assert.equal(timerTexts(v, { timeZone: TZ, startedAt: iso(T0 - 72 * MIN) }).note, 'С 19:48, оплачено до 21:48');
  // заморозка или блок СБП кончается — янтарный и льгота, как у обычной игры
  const near = gameView(session({ unlimited: true, started_at: iso(T0 - 115 * MIN), paid_until: iso(T0 + 4 * MIN) }), T0);
  assert.deepEqual(near, { phase: 'warn', ms: 4 * MIN, until: T0 + 4 * MIN });
  assert.match(timerTexts(near, { timeZone: TZ, unlimited: true }).note, /блок кончается/);
  assert.equal(gameView(session({ unlimited: true, paid_until: iso(T0 - 1000) }), T0).phase, 'grace');
  assert.equal(maxExtendMinutes(session({ unlimited: true, extend_limit_until: iso(T0 + 65 * MIN) })), null);
  assert.deepEqual(gameView(session({ status: 'interrupted', remaining_ms: 18 * MIN }), T0), { phase: 'interrupted', ms: 18 * MIN, until: null });
  assert.equal(gameView(session({ status: 'closed' }), T0).phase, 'closed');
  assert.equal(gameView(session({ status: 'cancelled' }), T0).phase, 'cancelled');
  assert.equal(gameView(session({ paid_until: 'мусор' }), T0).phase, 'play');
});

test('поправка часов телефона по remaining_ms', () => {
  // телефон спешит на 90 с: сервер говорит «осталось 65 минут», а по часам телефона — 63,5
  const s = session();
  assert.equal(clockSkew(s, T0 + 90_000), -90_000);
  assert.equal(gameView(s, T0 + 90_000 + clockSkew(s, T0 + 90_000)).ms, 65 * MIN);
  assert.equal(clockSkew({ ...s, status: 'grace' }, T0), 0);
  assert.equal(clockSkew({ ...s, unlimited: true }, T0 + 1000), -1000, 'у «Без лимита» тоже есть paid_until');
  assert.equal(clockSkew({ ...s, remaining_ms: undefined }, T0), 0);
  assert.equal(clockSkew(s, T0 + 3 * 86_400_000), 0, 'сутки и больше — ошибка данных, не поправка');
});

test('продление перед бронью ограничено extend_limit_until', () => {
  assert.equal(maxExtendMinutes(session()), null);
  assert.equal(maxExtendMinutes(session({ extend_limit_until: iso(T0 + 65 * MIN + 75 * MIN) })), 75);
  assert.equal(maxExtendMinutes(session({ extend_limit_until: iso(T0) })), 0);
});

test('лампа на экране: горит, приглушена в льготу, выключена', () => {
  assert.equal(lampState('play'), 'true');
  assert.equal(lampState('warn'), 'true');
  assert.equal(lampState('unlimited'), 'true');
  assert.equal(lampState('grace'), 'dim');
  assert.equal(lampState('over'), 'false');
  assert.equal(lampState('interrupted'), 'false');
});
