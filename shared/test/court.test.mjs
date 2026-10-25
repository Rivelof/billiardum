// M5.8 «Падел-корт»: рисунок и расстановка кортов (hall.mjs), тексты ошибок по виду ресурса (errors.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courtLayout, courtSvg, planLayout, resourceArt, tableKind, tableSvg, typeLabel, TABLE_SIZES } from '../hall.mjs';
import { errorMessage } from '../errors.mjs';

test('вид рисунка: корт по family, kind и type; столы — как раньше', () => {
  assert.equal(resourceArt('padel_court'), 'court');
  assert.equal(resourceArt({ family: 'court' }), 'court');
  assert.equal(resourceArt({ kind: 'padel_court' }), 'court');
  assert.equal(resourceArt({ type: 'billiard_pool' }), 'pool');
  assert.equal(resourceArt('billiard_snooker'), 'pyramid');
  // tableKind не меняется: на него опираются расстановки зала столов
  assert.equal(tableKind('padel_court'), 'pyramid');
  assert.equal(typeLabel('padel_court', 'Корт 1'), 'Падел-корт, 10 × 20 м', 'название «Корт N» не повторяем');
  assert.equal(typeLabel('padel_court', 'Корт у окна'), 'Корт у окна');
});

test('рисунок корта: 10 × 20 м со стенами, сетка посередине, четыре прожектора, без style (CSP)', () => {
  const v = tableSvg('court', { uid: 'k' });
  assert.equal(v, courtSvg({ uid: 'k' }));
  assert.match(v, /class="ta ta--court"/);
  assert.match(v, /viewBox="0 0 10600 20600"/);
  assert.doesNotMatch(v, /style=|https?:|<script/);
  assert.match(v, /fill="url\(#k-c\)"/, 'трава — те же стопы, что у сукна: свет через --lit');
  assert.equal((v.match(/<g class="ta-lamps">(.*?)<\/g>/)[1].match(/<circle/g) ?? []).length, 4);
  assert.match(v, /class="co-net"/);
  const h = tableSvg('court', { horizontal: true, uid: 'h' });
  assert.match(h, /viewBox="0 0 20600 10600"/);
  assert.match(h, /rotate\(90\)/);
  assert.ok(TABLE_SIZES.court.outerLong > TABLE_SIZES.pyramid.outerLong * 5);
});

test('расстановка кортов: в ряд, не пересекаются, внутри плана; столы — без кортов', () => {
  const courts = [2, 1, 3].map((n) => ({ id: `c${n}`, number: n }));
  const { width, height, items } = courtLayout(courts);
  assert.deepEqual(items.map((i) => i.number), [1, 2, 3]);
  assert.ok(items.every((i) => i.kind === 'court'));
  assert.equal(new Set(items.map((i) => i.y)).size, 1, 'один ряд');
  for (const a of items) {
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height, `корт ${a.number} внутри плана`);
    for (const b of items) {
      if (a !== b) assert.ok(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h));
    }
  }
  assert.equal(new Set(courtLayout(courts, { perRow: 2 }).items.map((i) => i.y)).size, 2, 'по два в ряду — два ряда');
  assert.deepEqual(courtLayout([]).items, []);
  // planLayout столов корты не рисует по-новому (программа клуба — следующий шаг)
  assert.equal(planLayout([{ id: 'x', number: 1, type: 'billiard_pool' }]).items[0].kind, 'pool');
});

test('ошибки по виду ресурса: у корта «корт», у стола без изменений; пятый игрок — «На корте уже 4 игрока»', () => {
  const busy = errorMessage({ code: 'table_busy' }, { family: 'court', busyUntil: '21:40' });
  assert.equal(busy.title, 'Корт занят до 21:40.');
  assert.equal(busy.action, 'Выберите другой корт.');
  assert.equal(busy.text, 'Корт занят до 21:40. Выберите другой корт.');
  assert.equal(errorMessage({ code: 'forbidden' }, { family: { type: 'padel_court' } }).action, 'Если вы играете на этом корте, подойдите на ресепшн.');
  assert.equal(errorMessage({ code: 'table_offline' }, { family: 'court' }).title, 'Корт не на связи, свет на нём не включится.');
  assert.equal(errorMessage({ code: 'table_busy', data: { reason: 'tournament' } }, { family: 'court', busyUntil: '22:00' }).title, 'Корт занят турниром до 22:00.');
  assert.deepEqual(errorMessage({ code: 'table_busy' }, { family: 'table' }), errorMessage({ code: 'table_busy' }));
  const full = errorMessage({ code: 'limit_exceeded' }, { family: 'court', playersLimit: 4 });
  assert.equal(full.title, 'На корте уже 4 игрока.');
  assert.match(full.action, /не больше 4 игроков/);
  assert.equal(errorMessage({ code: 'limit_exceeded' }, { family: 'table', playersLimit: 20 }).title, 'За столом уже 20 игроков.');
  // Без playersLimit — прежний текст продления
  assert.equal(errorMessage({ code: 'limit_exceeded' }, { family: 'court' }).title, 'Больше продлить нельзя.');
});
