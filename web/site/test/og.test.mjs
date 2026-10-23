import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ogAvailable, ogImage, ogSvg, woffToSfnt, wrap } from '../src/og.mjs';
import { site } from './helpers.mjs';

test('WOFF → TrueType для resvg: заголовок sfnt и все таблицы на месте', () => {
  const woff = readFileSync(new URL('../og/fonts/geologica-cyrillic-400-normal.woff', import.meta.url));
  const ttf = woffToSfnt(woff);
  assert.equal(ttf.readUInt32BE(0), woff.readUInt32BE(4), 'flavor сохранён');
  assert.equal(ttf.readUInt16BE(4), woff.readUInt16BE(12), 'число таблиц');
  assert.throws(() => woffToSfnt(Buffer.from('nope')));
});

test('перенос заголовка по словам с многоточием', () => {
  assert.deepEqual(wrap('Кубок Свояка свободная пирамида', 12, 2), ['Кубок Свояка', 'свободная…']);
  assert.deepEqual(wrap('Свояк', 16, 3), ['Свояк']);
});

test('SVG карточки экранирует данные клуба', () => {
  const svg = ogSvg({ title: '<script>"x"</script>', subtitle: 'a & b' });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /a &amp; b/);
});

test('OG-картинка клуба и турнира — PNG 1200 × 630 (или SVG без resvg); нет клуба — 404', async () => {
  const { get } = site();
  const r = await get('/og/club/ekaterinburg/svoyak.png');
  assert.equal(r.status, 200);
  if (await ogAvailable()) {
    assert.equal(r.headers['content-type'], 'image/png');
    assert.equal(r.body.subarray(1, 4).toString(), 'PNG');
    assert.equal(r.body.readUInt32BE(16), 1200);
    assert.equal(r.body.readUInt32BE(20), 630);
  } else {
    assert.equal(r.headers['content-type'], 'image/svg+xml');
  }
  assert.equal((await get('/og/turnir/22222222-2222-4222-8222-000000000001.png')).status, 200);
  assert.equal((await get('/og/site.png')).status, 200);
  assert.equal((await get('/og/club/ekaterinburg/net.png')).status, 404);
  assert.equal((await get('/og/club/../../etc.png')).status, 404);
  const a = await ogImage({ title: 'Кэш' });
  assert.equal(await ogImage({ title: 'Кэш' }), a, 'повтор — из кэша');
});
