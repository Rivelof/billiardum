// Д1 приёмки M5.6: сообщение после записи и история событий — по ответу сервера (cashbook.action), не по форме.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/mock/backend.js';
import { cashbookWords, correctionBody, eventBody, eventCostWords, eventDoneText, eventEffect, maintenanceView } from '../src/lib/maintenance.js';

const CLUB = '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const memory = () => {
  let v = null;
  return { load: () => v, save: (s) => (v = JSON.parse(JSON.stringify(s))) };
};
const backend = (sc) => {
  const b = createBackend(memory(), () => NOW);
  b.scenario(sc);
  return (path, method = 'GET', body) => b.handle(method, { href: `http://x${path}`, body });
};
const sp = (s) => (s === null ? s : s.replace(/[\u00a0\u202f]/g, ' '));
const PATH = `/api/clubs/${CLUB}/maintenance`;

test('cashbookWords: пять исходов cashbook.action', () => {
  assert.equal(sp(cashbookWords({ cost_kopecks: 150000, cashbook: { action: 'created' } })), 'Расход 1 500 ₽ внесён в кассу управляющего');
  assert.equal(sp(cashbookWords({ cost_kopecks: 120000, cashbook: { action: 'replaced' } })), 'Прежний расход сторнирован, внесён новый — 1 200 ₽');
  assert.equal(sp(cashbookWords({ cost_kopecks: 0, cashbook: { action: 'reversed' } }, 150000)), 'Расход 1 500 ₽ сторнирован', 'сумма — из прежней записи');
  assert.equal(cashbookWords({ cost_kopecks: 0, cashbook: { action: 'reversed' } }), 'Расход сторнирован');
  assert.equal(cashbookWords({ cost_kopecks: 0, cashbook: { action: 'kept' } }), 'Стоимость не изменена: расход в кассе по исходной записи');
  assert.equal(cashbookWords({ cost_kopecks: 0, cashbook: { action: 'none' } }), null);
  assert.equal(cashbookWords({ cost_kopecks: 150000 }), null, 'нет поля cashbook — о кассе ни слова');
});

test('исправление: пустая стоимость не уходит в тело, 0 и число — явная стоимость', () => {
  const orig = { id: 'e1', resourceId: 'r1', kind: 'cloth', date: '2026-10-20', cost: 150000, comment: 'сукно' };
  const form = { ...orig, reason: 'уточнил комментарий', comment: 'Simonis' };
  assert.deepEqual(correctionBody(orig, { ...form, cost: null }), { corrects_id: 'e1', reason: 'уточнил комментарий', comment: 'Simonis' });
  assert.deepEqual(correctionBody(orig, { ...form, cost: 0 }), { corrects_id: 'e1', reason: 'уточнил комментарий', cost_kopecks: 0, comment: 'Simonis' });
  assert.deepEqual(correctionBody(orig, { ...form, cost: 150000 }), { corrects_id: 'e1', reason: 'уточнил комментарий', cost_kopecks: 150000, comment: 'Simonis' });
  const held = { cost: 150000 };
  assert.match(sp(eventEffect({ kind: 'other', cost: null, correction: true, held }).join(' ')), /Расход 1 500 ₽ в кассе не изменится/);
  assert.match(sp(eventEffect({ kind: 'other', cost: 0, correction: true, held }).join(' ')), /Расход 1 500 ₽ сторнируется, нового не будет/);
  assert.match(sp(eventEffect({ kind: 'other', cost: 120000, correction: true, held }).join(' ')), /Прежний расход 1 500 ₽ сторнируется, 1 200 ₽ уйдут новым/);
});

test('заглушка и экран: created → kept → replaced → reversed, none; текст по ответу, история «расход по исходной записи»', async () => {
  const call = backend('maintenance');
  const get = async () => maintenanceView((await call(PATH)).body);
  let v = await get();
  const t1 = v.resources.find((r) => r.number === 1);
  const fixOf = (id) => v.events.find((e) => e.id === id);
  const done = (res, fix) => sp(eventDoneText(res, { fix, labels: v.labels }));

  // created — событие с расходом 1 500 ₽
  const a = (await call(PATH, 'POST', eventBody({ resourceId: t1.id, kind: 'cloth', date: '2026-10-24', cost: 150000, comment: 'сукно' }))).body;
  assert.equal(a.cashbook.action, 'created');
  assert.equal(a.cashbook.entry_id, a.cashbook_entry_id);
  assert.equal(done(a, null), 'Записано: замена сукна, стол 1, 24 октября. Расход 1 500 ₽ внесён в кассу управляющего.');
  v = await get();
  assert.equal(fixOf(a.event_id).cash, 'in_cash');
  assert.deepEqual(fixOf(a.event_id).held, { id: a.cashbook_entry_id, cost: 150000, eventId: a.event_id });

  // kept — исправление комментария, стоимость пустая
  let fix = fixOf(a.event_id);
  const bBody = correctionBody(fix, { ...fix, cost: null, comment: 'Сукно Simonis 860', reason: 'уточнил комментарий' });
  assert.equal('cost_kopecks' in bBody, false);
  const b = (await call(PATH, 'POST', bBody)).body;
  assert.deepEqual(b.cashbook, { action: 'kept', entry_id: null, storno_entry_ids: [], kept_entry_id: a.cashbook_entry_id });
  assert.equal(b.cost_kopecks, 0, 'стоимость не переносится');
  assert.equal(done(b, fix), 'Запись исправлена: замена сукна, стол 1, 24 октября. Стоимость не изменена: расход в кассе по исходной записи.');
  v = await get();
  assert.equal(fixOf(a.event_id).cash, 'in_cash', 'исправленная запись: расход по-прежнему в кассе');
  assert.deepEqual(eventCostWords(fixOf(b.event_id)), { money: null, note: 'расход по исходной записи' }, 'не «без расхода»');
  assert.equal(fixOf(b.event_id).held.cost, 150000);

  // replaced — явная стоимость 1 200 ₽ у исправления исправления: сторно расхода корня цепочки и новый
  fix = fixOf(b.event_id);
  const c = (await call(PATH, 'POST', correctionBody(fix, { ...fix, cost: 120000, reason: 'сумма по счёту' }))).body;
  assert.equal(c.cashbook.action, 'replaced');
  assert.equal(c.cashbook.storno_entry_ids.length, 1);
  assert.equal(done(c, fix), 'Запись исправлена: замена сукна, стол 1, 24 октября. Прежний расход сторнирован, внесён новый — 1 200 ₽.');
  v = await get();
  assert.equal(fixOf(a.event_id).cash, 'storno');
  assert.deepEqual(eventCostWords(fixOf(b.event_id)), { money: null, note: 'без расхода' }, 'расход цепочки теперь у нового исправления');
  assert.equal(fixOf(c.event_id).cash, 'in_cash');

  // reversed — «события не было»: сумма — из прежней записи
  fix = fixOf(c.event_id);
  const d = (await call(PATH, 'POST', correctionBody(fix, { reason: 'сукно меняли на другом столе', voided: true }))).body;
  assert.equal(d.cashbook.action, 'reversed');
  assert.equal(done(d, fix), 'Отмечено: события не было (замена сукна, стол 1). Счётчик пересчитан. Расход 1 200 ₽ сторнирован.');
  v = await get();
  assert.equal(fixOf(c.event_id).cash, 'storno');
  assert.equal(fixOf(d.event_id).cash, 'none');
  const cash = (await call(`/api/clubs/${CLUB}/cashbook?from=2026-10-01&to=2026-10-24`)).body.entries.filter((x) => x.category === 'Ремонт столов');
  assert.equal(cash.reduce((s, x) => s + x.signed_kopecks, 0), 0, 'в кассе всё сторнировано');

  // none — событие без стоимости и исправление без стоимости, когда расхода нет: о кассе ни слова
  const e = (await call(PATH, 'POST', eventBody({ resourceId: t1.id, kind: 'balls', date: '2026-10-24', cost: null, comment: '' }))).body;
  assert.equal(e.cashbook.action, 'none');
  assert.equal(done(e, null), 'Записано: замена шаров, стол 1, 24 октября.');
  v = await get();
  fix = fixOf(e.event_id);
  const f = (await call(PATH, 'POST', correctionBody(fix, { ...fix, cost: null, comment: 'набор Aramith', reason: 'комментарий' }))).body;
  assert.equal(f.cashbook.action, 'none');
  assert.doesNotMatch(done(f, fix), /касс|расход/i);
});

test('заглушка: после ручного сторно в кассе исправление без стоимости — none, расход не возвращается', async () => {
  const call = backend('maintenance');
  let v = maintenanceView((await call(PATH)).body);
  const t2 = v.resources.find((r) => r.number === 2);
  const a = (await call(PATH, 'POST', { resource_id: t2.id, kind: 'cushions', date: '2026-10-24', cost_kopecks: 300000 })).body;
  assert.ok([200, 201].includes((await call(`/api/clubs/${CLUB}/cashbook/${a.cashbook_entry_id}/storno`, 'POST', { reason: 'ошибка' })).status));
  v = maintenanceView((await call(PATH)).body);
  const fix = v.events.find((x) => x.id === a.event_id);
  assert.equal(fix.cash, 'storno');
  assert.equal(fix.held, null);
  const b = (await call(PATH, 'POST', correctionBody(fix, { ...fix, cost: null, comment: 'Simonis', reason: 'комментарий' }))).body;
  assert.equal(b.cashbook.action, 'none');
  v = maintenanceView((await call(PATH)).body);
  assert.deepEqual(eventCostWords(v.events.find((x) => x.id === b.event_id)), { money: null, note: 'без расхода' });
});
