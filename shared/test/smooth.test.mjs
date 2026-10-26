import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cancel, pending, wake } from '../raf.mjs';
import { smoothScrollAllowed, startSmoothScroll } from '../smooth-scroll.mjs';

/** Заглушка requestAnimationFrame: кадры гоняем вручную. */
function fakeRaf() {
  const queue = new Map();
  let next = 1;
  globalThis.requestAnimationFrame = (fn) => {
    queue.set(next, fn);
    return next++;
  };
  globalThis.cancelAnimationFrame = (id) => queue.delete(id);
  return {
    get scheduled() {
      return queue.size;
    },
    frame(now = 0) {
      const fns = [...queue.values()];
      queue.clear();
      for (const fn of fns) fn(now);
    },
  };
}

test('raf: один цикл на всех, по приоритету, засыпает, когда все закончили', () => {
  const raf = fakeRaf();
  const log = [];
  let left = 2;
  const late = () => {
    log.push('late');
    return false;
  };
  const early = () => {
    log.push('early');
    left -= 1;
    return left > 0;
  };
  wake(late, 10);
  wake(early, 0);
  wake(early, 0); // повторный вызов — та же задача
  assert.equal(raf.scheduled, 1, 'один rAF на две задачи');
  assert.equal(pending(), 2);
  raf.frame();
  assert.deepEqual(log, ['early', 'late'], 'прокрутка раньше рисунка');
  assert.equal(pending(), 1);
  assert.equal(raf.scheduled, 1, 'early просит ещё кадр');
  raf.frame();
  assert.deepEqual(log, ['early', 'late', 'early']);
  assert.equal(pending(), 0);
  assert.equal(raf.scheduled, 0, 'в покое кадров нет');
});

test('raf: cancel снимает задачу и останавливает цикл; упавшая задача не ломает остальные', () => {
  const raf = fakeRaf();
  const job = () => true;
  wake(job);
  assert.equal(raf.scheduled, 1);
  cancel(job);
  assert.equal(pending(), 0);
  assert.equal(raf.scheduled, 0);

  let ran = false;
  const boom = () => {
    throw new Error('boom');
  };
  const ok = () => {
    ran = true;
    return false;
  };
  const thrown = [];
  const realMicrotask = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (fn) => thrown.push(fn); // ошибка уходит наружу микрозадачей — перехватим
  try {
    wake(boom, 0);
    wake(ok, 1);
    raf.frame();
  } finally {
    globalThis.queueMicrotask = realMicrotask;
  }
  assert.ok(ran, 'следующая задача выполнилась');
  assert.equal(pending(), 0, 'упавшая снята');
  assert.equal(thrown.length, 1);
  assert.throws(thrown[0], /boom/);
});

test('плавная прокрутка: правила включения', () => {
  const ok = { reduce: false, fine: true, saveData: false, framed: false, miniApp: false };
  assert.equal(smoothScrollAllowed(ok), true);
  assert.equal(smoothScrollAllowed({ ...ok, reduce: true }), false, 'prefers-reduced-motion');
  assert.equal(smoothScrollAllowed({ ...ok, fine: false }), false, 'телефон без мыши и тачпада — нативная прокрутка');
  assert.equal(smoothScrollAllowed({ ...ok, saveData: true }), false, 'экономия трафика');
  assert.equal(smoothScrollAllowed({ ...ok, framed: true }), false, 'встроенное окно (мини-приложения)');
  assert.equal(smoothScrollAllowed({ ...ok, miniApp: true }), false, 'мини-приложение MAX и Telegram');
});

test('плавная прокрутка: там, где она не нужна, ничего не загружается и выключатель безвреден', () => {
  const had = globalThis.matchMedia;
  try {
    // без matchMedia (сервер, тесты): нет «мыши» — выключено
    delete globalThis.matchMedia;
    let loaded = 0;
    const load = () => {
      loaded += 1;
      return Promise.resolve({ default: class {} });
    };
    const stop = startSmoothScroll({ load });
    assert.equal(typeof stop, 'function');
    stop();
    stop();
    // reduce-motion
    globalThis.matchMedia = (q) => ({ matches: q.includes('reduce') || q.includes('any-pointer'), addEventListener() {}, removeEventListener() {} });
    startSmoothScroll({ load })();
    // мини-приложение
    globalThis.matchMedia = (q) => ({ matches: q.includes('any-pointer') });
    startSmoothScroll({ load, miniApp: true })();
    assert.equal(startSmoothScroll({})(), undefined, 'без загрузчика — ничего');
    assert.equal(loaded, 0, 'Lenis не скачивается там, где прокрутка не нужна');
  } finally {
    if (had) globalThis.matchMedia = had;
    else delete globalThis.matchMedia;
  }
});
