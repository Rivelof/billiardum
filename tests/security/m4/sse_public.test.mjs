// PoC M4: публичные потоки турнира (ТВ-экран, страница турнира) и общий хаб SSE.
//
// M4-7 (низкая, доступность) — перепроверка после исправления (код ef78f68). Было: анонимные потоки
// tournament:{id} делили с персоналом и гостями общий предел хаба MAX_CLIENTS, 10 потоков с IP; 200 адресов
// одной сети /64 занимали весь хаб, ресепшн и гость получали too_many_clients.
// Стало (server/http/sse.mjs attach, sourceOf, limitKeyOf; server/tournaments/tv.mjs): предел на источник
// — IPv4-адрес или сеть /64 IPv6, `::ffff:a.b.c.d` считается как IPv4; анонимные потоки — не больше
// ANON_SHARE (25 %) хаба; вошедшие подключаются, когда анонимные упёрлись в предел. Проверка, что
// турнир существует и опубликован, — в api/routes/stream.mjs publicStream (нужна база, покрыта test:db).
//
// Здесь — проверки, что защита держит: каждая попытка обхода должна провалиться. Плюс замечание M4-I6:
// доля анонимных общая для всех турниров, и её занимает одна сеть /56 (50 сетей /64 по 10 потоков).
//
// Запуск: node --test tests/security/m4/sse_public.test.mjs   (без базы, хаб в памяти)

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import {
  ANON_SHARE,
  createSseHub,
  isChannel,
  MAX_ANON_CLIENTS,
  MAX_CLIENTS,
  MAX_CLIENTS_PER_USER,
  sourceOf,
} from '../../../server/http/sse.mjs';
import { createTvHub, TV_MAX_PER_IP } from '../../../server/tournaments/tv.mjs';

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.writableLength = 0;
  res.writeHead = (status) => {
    res.status = status;
  };
  res.write = (s) => {
    res.chunks.push(String(s));
    return true;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  res.socket = { setTimeout() {}, setNoDelay() {} };
  return res;
}

const timers = { setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} };
const T = '11111111-1111-4111-8111-111111111111';
const CH = `tournament:${T}`;
const PUBLIC_ONLY = { [CH]: ['bracket', 'tournament', 'match'] };
const STAFF = 'a1000000-0000-4000-8000-000000000004';
const CLUB = 'c1000000-0000-4000-8000-000000000001';

/** Анонимный поток так, как его подключает api/routes/stream.mjs publicStream: key `ip:${req.ip}`. */
const anon = (hub, ip) => hub.attach(fakeRes(), { channels: [CH], key: `ip:${ip}`, only: PUBLIC_ONLY });
/** Ядро для ТВ-хаба — как в server/tournaments/index.mjs init: core = { ...ctx.sse, isChannel }. */
const tvOver = (hub) => createTvHub({ core: { attach: hub.attach, publish: hub.publish, isChannel }, timers });

/** UUID n-го пользователя (n < 2^32). */
const userId = (n) => `b2000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

test('M4-7 выдержало: с одной сети /64 — не больше лимита на источник (разные адреса и записи одного /64)', () => {
  const hub = createSseHub({ timers });
  // Атакующий перебирает адреса внутри своей /64 и меняет запись адреса: сжатая, полная, верхний регистр, зона.
  const net = '2001:db8:aa:bb';
  const spellings = [
    (i) => `${net}::${i.toString(16)}`,
    (i) => `${net}:${i.toString(16)}:0:0:1`,
    (i) => `2001:0DB8:00AA:00BB::${(i + 0xa000).toString(16).toUpperCase()}`,
    (i) => `${net}::${i.toString(16)}%eth0`,
    (i) => `${net}:ffff:ffff:ffff:${i.toString(16)}`,
  ];
  let ok = 0;
  for (let i = 0; i < 200; i += 1) if (anon(hub, spellings[i % spellings.length](i + 1)).ok) ok += 1;
  console.log(`  из 200 потоков с адресов одной /64 принято: ${ok}`);
  assert.equal(ok, MAX_CLIENTS_PER_USER, 'с /64 — не больше лимита на источник');
  for (const f of spellings) assert.equal(sourceOf(f(7)), '2001:db8:aa:bb::/64', f(7));

  // Соседняя /64 — свой лимит; лимит по /64, а не по /48.
  assert.equal(anon(hub, '2001:db8:aa:bc::1').ok, true, 'соседняя /64 — отдельный источник');

  // ТВ-экран через ядро — тот же ключ и тот же лимит: обойти через другой маршрут нельзя.
  const tv = tvOver(hub);
  assert.equal(tv.usesCore, true);
  assert.equal(tv.attach(fakeRes(), { tournamentId: T, ip: `${net}::dead:beef` }).ok, false, 'ТВ через ядро с той же /64 — отказ');
  hub.closeAll();

  // ТВ-хаб без ядра (запасной путь) — тоже по /64.
  const solo = createTvHub({ timers });
  assert.equal(solo.usesCore, false);
  let tvOk = 0;
  for (let i = 0; i < 50; i += 1) if (solo.attach(fakeRes(), { tournamentId: T, ip: `${net}::${(i + 1).toString(16)}` }).ok) tvOk += 1;
  assert.equal(tvOk, TV_MAX_PER_IP, 'запасной ТВ-хаб: с /64 — не больше TV_MAX_PER_IP');
});

test('M4-7 выдержало: ::ffff:a.b.c.d считается как IPv4 — смесь записей не даёт лишних потоков', () => {
  const hub = createSseHub({ timers });
  const forms = ['203.0.113.7', '::ffff:203.0.113.7', '::FFFF:203.0.113.7', '::ffff:cb00:7107', '0:0:0:0:0:ffff:cb00:7107'];
  for (const f of forms) assert.equal(sourceOf(f), '203.0.113.7', f);
  let ok = 0;
  for (let i = 0; i < 50; i += 1) if (anon(hub, forms[i % forms.length]).ok) ok += 1;
  console.log(`  из 50 потоков с записей одного IPv4 принято: ${ok}`);
  assert.equal(ok, MAX_CLIENTS_PER_USER, 'IPv4 и ::ffff:IPv4 — один источник');
  // Другой IPv4 из той же /24 — отдельный источник (IPv4 считается по адресу).
  assert.equal(anon(hub, '::ffff:203.0.113.8').ok, true);
  assert.equal(anon(hub, '203.0.113.8').ok, true);
  hub.closeAll();
});

test(`M4-7 выдержало: анонимные потоки — не больше ${ANON_SHARE * 100} % хаба (${MAX_ANON_CLIENTS} из ${MAX_CLIENTS})`, () => {
  assert.equal(MAX_ANON_CLIENTS, Math.floor(MAX_CLIENTS * 0.25));
  const hub = createSseHub({ timers });
  // Атакующий с множества источников (каждая /64 — отдельный источник): 2000 потоков по 10 с /64.
  let ok = 0;
  let refused = 0;
  for (let n = 0; n < MAX_CLIENTS / MAX_CLIENTS_PER_USER; n += 1) {
    for (let k = 0; k < MAX_CLIENTS_PER_USER; k += 1) {
      const out = anon(hub, `2001:db8:${n.toString(16)}:${k.toString(16)}::1`);
      if (out.ok) ok += 1;
      else {
        assert.equal(out.reason, 'too_many_clients');
        refused += 1;
      }
    }
  }
  console.log(`  анонимных принято: ${ok}, отказ: ${refused}`);
  assert.equal(ok, MAX_ANON_CLIENTS, 'анонимных — ровно четверть хаба');
  assert.equal(hub.size, MAX_ANON_CLIENTS);
  // Без ключа (источник неизвестен) — та же общая доля анонимных.
  assert.equal(hub.attach(fakeRes(), { channels: [CH], only: PUBLIC_ONLY }).ok, false, 'аноним без ключа — тоже в доле');
  // ТВ-экран через ядро — тоже анонимный и тоже упирается в долю.
  assert.equal(tvOver(hub).attach(fakeRes(), { tournamentId: T, ip: '198.51.100.1' }).ok, false, 'ТВ через ядро — в доле анонимных');
  hub.closeAll();
  assert.equal(hub.size, 0);
  // Закрыли один анонимный — место освободилось ровно на один.
  const kept = [];
  for (let n = 0; n < MAX_ANON_CLIENTS; n += 1) kept.push(anon(hub, `198.18.${n >> 8}.${n & 0xff}`));
  assert.ok(kept.every((x) => x.ok));
  kept[0].client.close();
  assert.equal(anon(hub, '198.51.100.2').ok, true, 'место закрытого потока — свободно');
  assert.equal(anon(hub, '198.51.100.3').ok, false, 'и только одно');
  hub.closeAll();
});

test('M4-7 выдержало: вошедшие подключаются, когда анонимные упёрлись в предел', () => {
  const hub = createSseHub({ timers });
  for (let n = 0; n < MAX_ANON_CLIENTS; n += 1) assert.equal(anon(hub, `198.18.${n >> 8}.${n & 0xff}`).ok, true);
  assert.equal(anon(hub, '198.19.0.1').ok, false, 'анонимные упёрлись в предел');

  // Ресепшн клуба (зал) и гость (своя сессия) — подключаются.
  const staff = hub.attach(fakeRes(), { channels: [`club:${CLUB}`], userId: STAFF });
  const guestId = 'a1000000-0000-4000-8000-0000000000ff';
  const guest = hub.attach(fakeRes(), { channels: [`user:${guestId}`], userId: guestId });
  console.log(`  ресепшн: ok=${staff.ok}; гость: ok=${guest.ok}`);
  assert.equal(staff.ok, true);
  assert.equal(guest.ok, true);

  // Вошедшим доступен весь остаток хаба (3/4): заполняем до MAX_CLIENTS разными пользователями.
  let n = 0;
  while (hub.size < MAX_CLIENTS) {
    assert.equal(hub.attach(fakeRes(), { channels: [`user:${userId(n)}`], userId: userId(n) }).ok, true, `вошедший ${n}`);
    n += 1;
  }
  assert.equal(hub.size, MAX_CLIENTS);
  // Общий предел хаба по-прежнему действует (и для вошедших).
  assert.equal(hub.attach(fakeRes(), { channels: [`club:${CLUB}`], userId: userId(n + 1) }).ok, false);
  // Лимит на пользователя не стал анонимным: вошедший сам по себе — не больше MAX_CLIENTS_PER_USER.
  hub.closeAll();
  let mine = 0;
  for (let i = 0; i < 20; i += 1) if (hub.attach(fakeRes(), { channels: [`club:${CLUB}`], userId: STAFF }).ok) mine += 1;
  assert.equal(mine, MAX_CLIENTS_PER_USER);
  hub.closeAll();
});

test('замечание M4-I6: одна сеть /56 (обычная выдача абоненту) занимает всю долю анонимных — ТВ-экраны турниров без потока', () => {
  const hub = createSseHub({ timers });
  const nets = MAX_ANON_CLIENTS / MAX_CLIENTS_PER_USER; // 50 сетей /64 внутри 2001:db8:77:ff00::/56
  let ok = 0;
  for (let n = 0; n < nets; n += 1) {
    for (let k = 0; k < MAX_CLIENTS_PER_USER; k += 1) if (anon(hub, `2001:db8:77:ff${n.toString(16).padStart(2, '0')}::${(k + 1).toString(16)}`).ok) ok += 1;
  }
  assert.equal(ok, MAX_ANON_CLIENTS);
  // ТВ-экран турнира в другом клубе — отказ; вошедшие при этом подключаются (защита M4-7 держит).
  assert.equal(tvOver(hub).attach(fakeRes(), { tournamentId: T, ip: '198.51.100.10' }).ok, false);
  assert.equal(hub.attach(fakeRes(), { channels: [`club:${CLUB}`], userId: STAFF }).ok, true);
  hub.closeAll();
});

test('выдержало: в публичный канал — только события сетки; 11-й поток с IP — отказ', () => {
  const hub = createSseHub({ timers });
  assert.throws(() => hub.publish(CH, 'session_started', { phone: '+79120000000' }));
  const res = fakeRes();
  assert.ok(hub.attach(res, { channels: [CH], key: 'ip:203.0.113.1', only: PUBLIC_ONLY }).ok);
  hub.publish(CH, 'bracket', { rounds: [] });
  assert.ok(res.chunks.join('').includes('event: bracket'));
  for (let i = 1; i < MAX_CLIENTS_PER_USER; i += 1) assert.ok(hub.attach(fakeRes(), { channels: [CH], key: 'ip:203.0.113.1' }).ok);
  assert.equal(hub.attach(fakeRes(), { channels: [CH], key: 'ip:203.0.113.1' }).ok, false);
  hub.closeAll();
});
