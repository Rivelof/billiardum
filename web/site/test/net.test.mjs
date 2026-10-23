import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientIp, inCidrs, ipBytes, parseCidrs } from '../src/net.mjs';

const trusted = parseCidrs('127.0.0.1/32,::1/128,172.18.0.0/16,fd00::/8');

test('адреса и подсети: IPv4, IPv6, IPv4-mapped', () => {
  assert.deepEqual(ipBytes('::ffff:10.1.2.3'), [10, 1, 2, 3]);
  assert.equal(ipBytes('::1').length, 16);
  assert.equal(ipBytes('nope'), null);
  assert.ok(inCidrs('172.18.5.9', trusted));
  assert.ok(!inCidrs('172.19.0.1', trusted));
  assert.ok(inCidrs('fd12:3456::1', trusted));
  assert.ok(inCidrs('::ffff:127.0.0.1', trusted));
  assert.equal(parseCidrs('мусор, 10.0.0.0/33, 10.0.0.0/8').length, 1);
});

test('X-Forwarded-For — только от доверенного прокси, клиент — первый недоверенный справа', () => {
  // напрямую, не через Caddy: заголовок подделан — берём адрес сокета
  assert.equal(clientIp('203.0.113.9', '1.2.3.4', trusted), '203.0.113.9');
  // через Caddy: он дописал адрес клиента справа
  assert.equal(clientIp('172.18.0.5', '198.51.100.7', trusted), '198.51.100.7');
  // клиент подставил свой XFF, Caddy дописал настоящий — подделка слева не помогает
  assert.equal(clientIp('172.18.0.5', '1.2.3.4, 198.51.100.7', trusted), '198.51.100.7');
  assert.equal(clientIp('::ffff:172.18.0.5', '::ffff:198.51.100.7', trusted), '198.51.100.7');
  // мусор в цепочке — адрес сокета
  assert.equal(clientIp('172.18.0.5', 'evil, ', trusted), '172.18.0.5');
  assert.equal(clientIp('172.18.0.5', undefined, trusted), '172.18.0.5');
  assert.equal(clientIp(undefined, '1.2.3.4', trusted), null);
});
