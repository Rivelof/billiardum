// ТВ-экран сетки: хаб core с каналом tournament:{id} или свой хаб (пока core канал не принимает).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createSseHub } from '../../http/sse.mjs';
import { createTvHub } from '../tv.mjs';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.write = (t) => res.chunks.push(t);
  res.end = () => {
    res.writableEnded = true;
  };
  return res;
}

const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
const brackets = (res) => res.chunks.filter((c) => c.startsWith('event: bracket')).map((c) => JSON.parse(c.split('data: ')[1]));

describe('ТВ-хаб', () => {
  it('свой хаб: первая сетка сразу, публикация только своему турниру, предел с одного адреса', () => {
    const tv = createTvHub({ core: { isChannel: () => false, attach() {}, publish() {} }, timers, maxPerIp: 2 });
    assert.equal(tv.usesCore, false);
    const a = fakeRes();
    const b = fakeRes();
    assert.equal(tv.attach(a, { tournamentId: T1, ip: '1.1.1.1', initial: { rounds: [] } }).ok, true);
    assert.equal(tv.attach(b, { tournamentId: T2, ip: '1.1.1.1' }).ok, true);
    assert.equal(tv.attach(fakeRes(), { tournamentId: T1, ip: '1.1.1.1' }).ok, false);
    assert.equal(a.status, 200);
    assert.match(a.headers['content-type'], /text\/event-stream/);
    assert.equal(tv.publish(T1, { rounds: [{ title: 'Финал' }] }), 1);
    assert.deepEqual(brackets(a).map((x) => x.rounds.length), [0, 1]);
    assert.deepEqual(brackets(b), []);
    a.emit('close');
    assert.equal(tv.size(), 1);
    tv.closeAll();
    assert.equal(tv.size(), 0);
  });

  it('хаб core с каналом tournament:{id}: подписка и публикация через него', () => {
    const core = createSseHub({ timers });
    const isChannel = (c) => /^(club|session|user|tournament):[0-9a-f-]{36}$/.test(c);
    const tv = createTvHub({ core: { ...core, isChannel }, timers });
    if (!tv.usesCore) return; // хаб core ещё без канала tournament:
    const a = fakeRes();
    assert.equal(tv.attach(a, { tournamentId: T1, ip: '2.2.2.2', initial: { rounds: [] } }).ok, true);
    tv.publish(T1, { rounds: [{ title: 'Финал' }] });
    assert.deepEqual(brackets(a).map((x) => x.rounds.length), [0, 1]);
    core.closeAll();
  });
});
