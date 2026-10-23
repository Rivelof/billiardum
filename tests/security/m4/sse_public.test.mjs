// PoC M4: публичные потоки турнира (ТВ-экран, страница турнира) и общий хаб SSE.
//
// НАХОДКА M4-7 (низкая, доступность): анонимные потоки tournament:{id} делят с персоналом и гостями
// один общий предел хаба MAX_CLIENTS = 2000 (server/http/sse.mjs, attach ~стр. 54–62; публичный поток —
// api/routes/stream.mjs publicStream, ТВ — server/tournaments/tv.mjs через core). Предел на источник —
// 10 потоков с IP, без входа и без проверки, что турнир существует. 200 адресов (одна сеть /64 IPv6 —
// это 2^64 адресов) занимают весь хаб: зал ресепшена, экран бара, приложение гостя получают отказ
// too_many_clients (429), живые обновления пропадают у всех клубов.
//
// Выдержало: в канал tournament:{id} нельзя опубликовать непубличное событие; подписчик публичного
// потока получает только разрешённые события; 11-й поток с одного IP — отказ.
//
// Запуск: node --test tests/security/m4/sse_public.test.mjs   (без базы, хаб в памяти)

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSseHub, isChannel, MAX_CLIENTS, MAX_CLIENTS_PER_USER } from '../../../server/http/sse.mjs';
import { createTvHub } from '../../../server/tournaments/tv.mjs';

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

test(`НАХОДКА M4-7 (низкая): ${MAX_CLIENTS / MAX_CLIENTS_PER_USER} анонимных адресов занимают весь хаб — потоки персонала и гостей отклоняются`, () => {
  const hub = createSseHub({ timers });
  const ips = MAX_CLIENTS / MAX_CLIENTS_PER_USER;
  let ok = 0;
  for (let i = 0; i < ips; i += 1) {
    const ip = `2001:db8::${i.toString(16)}`;
    for (let k = 0; k < MAX_CLIENTS_PER_USER; k += 1) {
      const id = `${T.slice(0, -4)}${String(k).padStart(4, '0')}`;
      const out = hub.attach(fakeRes(), { channels: [`tournament:${id}`], key: `ip:${ip}`, only: { [`tournament:${id}`]: ['bracket', 'tournament', 'match'] } });
      if (out.ok) ok += 1;
    }
  }
  assert.equal(ok, MAX_CLIENTS, 'все места хаба заняты анонимами');
  // Ресепшн клуба (зал) и гость (своя сессия) — отказ.
  const staff = hub.attach(fakeRes(), { channels: ['club:c1000000-0000-4000-8000-000000000001'], userId: 'a1000000-0000-4000-8000-000000000004' });
  const guest = hub.attach(fakeRes(), { channels: ['user:a1000000-0000-4000-8000-0000000000ff'], userId: 'a1000000-0000-4000-8000-0000000000ff' });
  console.log(`  ресепшн: ${JSON.stringify(staff)}; гость: ${JSON.stringify(guest)}`);
  assert.equal(staff.ok, false);
  assert.equal(guest.ok, false);
  // ТВ-хаб турниров идёт через тот же core-хаб и тоже упирается в общий предел.
  // Как в server/tournaments/index.mjs init: core = { ...ctx.sse, isChannel }.
  const tv = createTvHub({ core: { ...hub, isChannel: hub.isChannel ?? isChannel }, timers });
  assert.equal(tv.usesCore, true);
  assert.equal(tv.attach(fakeRes(), { tournamentId: T, ip: '198.51.100.1' }).ok, false);
  hub.closeAll?.();
});

test('выдержало: в публичный канал — только события сетки; 11-й поток с IP — отказ', () => {
  const hub = createSseHub({ timers });
  const ch = `tournament:${T}`;
  assert.throws(() => hub.publish(ch, 'session_started', { phone: '+79120000000' }));
  const res = fakeRes();
  assert.ok(hub.attach(res, { channels: [ch], key: 'ip:203.0.113.1', only: { [ch]: ['bracket', 'tournament', 'match'] } }).ok);
  hub.publish(ch, 'bracket', { rounds: [] });
  assert.ok(res.chunks.join('').includes('event: bracket'));
  for (let i = 1; i < MAX_CLIENTS_PER_USER; i += 1) assert.ok(hub.attach(fakeRes(), { channels: [ch], key: 'ip:203.0.113.1' }).ok);
  assert.equal(hub.attach(fakeRes(), { channels: [ch], key: 'ip:203.0.113.1' }).ok, false);
  hub.closeAll?.();
});
