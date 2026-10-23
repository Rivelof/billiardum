import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tableKind, typeLabel, tableSvg, planLayout, tableState, TABLE_SIZES } from '../hall.mjs';
import { DECLINE_REASONS, SERVICE_REASONS, reasonLabel } from '../reasons.mjs';
import { ICONS, ICON_STROKE } from '../icons.mjs';

test('вид стола по типу ресурса', () => {
  assert.equal(tableKind('billiard_pool'), 'pool');
  assert.equal(tableKind('billiard_pyramid'), 'pyramid');
  assert.equal(tableKind('billiard_snooker'), 'pyramid');
  assert.equal(tableKind(undefined), 'pyramid');
  assert.equal(typeLabel('billiard_pool'), 'Пул, 9 футов');
  assert.equal(typeLabel('billiard_snooker'), 'Снукер, 12 футов');
  assert.equal(typeLabel('billiard_mixed'), 'Стол под пирамиду и пул', 'M5.1: смешанный стол');
  assert.equal(typeLabel('billiard_mixed', 'Стол 3'), 'Стол под пирамиду и пул');
  assert.equal(typeLabel('billiard_pool', 'VIP-пул'), 'VIP-пул');
  assert.equal(typeLabel('billiard_pyramid', 'Стол 2'), 'Русская пирамида, 12 футов', 'название «Стол N» не повторяем');
  assert.equal(tableState({ status: 'fault' }).word, 'Неисправность');
});

test('рисунок стола: настоящие пропорции, без style и внешних ссылок (CSP), поворот', () => {
  const v = tableSvg('pyramid', { uid: 'a' });
  assert.match(v, /viewBox="0 0 2115 3890"/);
  assert.doesNotMatch(v, /style=|https?:|<script/);
  assert.match(v, /fill="url\(#a\)"/);
  const h = tableSvg('pool', { horizontal: true, uid: 'b' });
  assert.match(h, /viewBox="0 0 2840 1570"/);
  assert.match(h, /rotate\(90\)/);
  // пул короче пирамиды (DESIGN §1)
  assert.ok(TABLE_SIZES.pool.outerLong < TABLE_SIZES.pyramid.outerLong);
  // уникальные id градиента по умолчанию
  assert.notEqual(tableSvg('pool').match(/id="([^"]+)"/)[1], tableSvg('pool').match(/id="([^"]+)"/)[1]);
});

test('план зала сида: 5 пирамид в ряд, 3 пула во втором ряду, столы не пересекаются', () => {
  const res = [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, number: n, type: 'billiard_pyramid' }))
    .concat([6, 7, 8].map((n) => ({ id: `q${n}`, number: n, type: 'billiard_pool' })));
  const { width, height, items } = planLayout(res.reverse());
  assert.equal(items.length, 8);
  assert.deepEqual(items.map((i) => i.number), [1, 2, 3, 4, 5, 6, 7, 8]);
  const rows = new Set(items.map((i) => i.y + i.h));
  assert.equal(rows.size, 2, 'два ряда, столы ряда выровнены по нижнему краю');
  for (const a of items) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height, `стол ${a.number} внутри зала`);
    for (const b of items) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, `столы ${a.number} и ${b.number} не пересекаются`);
    }
  }
  assert.equal(planLayout(res, { perRow: 4 }).items.filter((i) => i.kind === 'pyramid').map((i) => i.y).filter((y, i, a) => a.indexOf(y) === i).length, 2);
  assert.deepEqual(planLayout([]).items, []);
});

test('состояние стола словами: статус никогда не только цветом', () => {
  const f = (iso) => iso.slice(11, 16);
  assert.deepEqual(tableState({ status: 'free' }), { tone: 'free', lit: false, word: 'Свободен' });
  const play = tableState({ status: 'busy', session: { status: 'active', paid_until: '2026-10-21T16:40:00Z' } }, { formatTime: f });
  assert.deepEqual(play, { tone: 'play', lit: true, word: 'До 16:40' });
  assert.equal(tableState({ status: 'busy', session: { status: 'ending' } }).tone, 'ending');
  assert.equal(tableState({ status: 'busy', session: { status: 'ending' } }).spoken, 'меньше 5 минут');
  assert.equal(tableState({ status: 'busy', session: { status: 'grace' } }).word, 'Льгота');
  assert.equal(tableState({ status: 'busy', session: { status: 'active', unlimited: true } }).word, 'Без лимита');
  assert.equal(tableState({ status: 'service', until: '2026-10-21T16:40:00Z' }, { formatTime: f }).word, 'Сервис до 16:40');
  assert.equal(tableState({ status: 'service' }).lit, true, 'сервисный свет горит');
  assert.equal(tableState({ status: 'pending' }).word, 'Оплата');
  assert.equal(tableState({ status: 'reserved' }).word, 'Бронь');
  assert.deepEqual(tableState({ status: 'free', device: { online: false } }), { tone: 'offline', lit: false, word: 'Нет связи' });
  assert.equal(tableState({ status: 'offline', session: { status: 'active' } }).lit, true, 'без связи игра доигрывается');
  for (const s of ['free', 'busy', 'pending', 'reserved', 'service', 'offline']) assert.ok(tableState({ status: s }).word.length > 0);
});

test('причины ручных действий: коды уникальны, есть «Другое»', () => {
  for (const list of [DECLINE_REASONS, SERVICE_REASONS]) {
    const codes = list.map((r) => r.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(codes.includes('other'));
    for (const c of codes) assert.match(c, /^[a-z_]+$/, 'код — печатный ASCII (decisions №31)');
  }
  assert.equal(reasonLabel(SERVICE_REASONS, 'cleaning'), 'Уборка');
  assert.equal(reasonLabel(SERVICE_REASONS, 'nope'), 'Другое');
});

test('значки: линейные пути, толщина 1,75, без эмодзи', () => {
  assert.equal(ICON_STROKE, 1.75);
  for (const [name, paths] of Object.entries(ICONS)) {
    assert.ok(Array.isArray(paths) && paths.length, name);
    for (const d of paths) assert.match(d, /^M[\d.\s,MLHVCSQTAZmlhvcsqtaz-]+$/, `${name}: только команды пути`);
  }
});

test('ui.css и hall.css: только токены, без внешних ресурсов и запрещённых шрифтов', () => {
  for (const file of ['../ui.css', '../hall.css']) {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /url\(\s*["']?(?:https?:)?\/\/|@import/, file);
    assert.doesNotMatch(css, /font-family:[^;]*(Inter|Roboto|Space Grotesk)/, file);
    assert.doesNotMatch(css, /\b(purple|violet|neon)\b/i, file);
    // цвета — через токены; допускаются только тени и затемнение фона
    const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hex, [], `${file}: цвета только через var(--…)`);
  }
});

test('бронь на плане зала (M3): свободный стол с бронью — янтарная рамка и время, reserved — ждёт гостя', () => {
  const fmt = { formatTime: () => '21:00', now: Date.parse('2026-10-22T12:00:00Z') };
  const booked = tableState({ status: 'free', next_booking: { starts_at: '2026-10-22T16:00:00Z' } }, fmt);
  assert.equal(booked.tone, 'booked');
  assert.equal(booked.word, 'Бронь 21:00');
  assert.match(booked.spoken, /свободен, бронь на 21:00/);
  assert.equal(tableState({ status: 'reserved', next_booking: { starts_at: '2026-10-22T16:00:00Z' } }, fmt).word, 'Бронь 21:00');
  assert.equal(tableState({ status: 'busy', next_booking: { starts_at: 'x' }, until: '2026-10-22T15:00:00Z' }, fmt).tone, 'play', 'идёт игра важнее брони');
  assert.equal(tableState({ status: 'free', next_booking: { starts_at: '2026-10-23T16:00:00Z' } }, fmt).tone, 'free', 'бронь завтра — стол свободен');
  const offered = tableState({ status: 'reserved', hold: { kind: 'reserved', source: 'waitlist', until: '2026-10-22T16:05:00Z', offer_id: 'w1' } }, fmt);
  assert.equal(offered.tone, 'reserved');
  assert.equal(offered.word, 'Из очереди до 21:00');
  assert.match(offered.spoken, /предложен гостю из очереди/);
});

test('иллюстрации пустых состояний: линейные SVG без style и внешних ссылок, на currentColor', async () => {
  const { illustration, ILLUSTRATIONS } = await import('../illustrations.mjs');
  assert.ok(ILLUSTRATIONS.length >= 5);
  for (const name of ILLUSTRATIONS) {
    const svg = illustration(name);
    assert.match(svg, /^<svg class="ill" viewBox="0 0 120 96" aria-hidden="true"/);
    assert.doesNotMatch(svg, /style=|https?:|<script|#[0-9a-f]{3,6}/i, name);
    assert.match(svg, /currentColor/);
  }
  assert.equal(illustration('nope'), illustration('rack'), 'неизвестное имя — пустой стол');
});
