/**
 * Один requestAnimationFrame-цикл на страницу (DESIGN §6): плавная прокрутка (Lenis) и разбой пирамиды
 * подписываются сюда, а не заводят каждый свой цикл. Цикл крутится, только пока хоть одна задача просит
 * следующий кадр, и засыпает, когда все закончили, — в покое страница не тратит кадры и батарею.
 *
 *   wake(fn, priority?)  поставить задачу на ближайший кадр; повторный вызов безвреден (задача одна)
 *   cancel(fn)           снять задачу
 *
 * fn(now) вызывается раз в кадр (now — время rAF, мс) и возвращает true, если нужен ещё кадр.
 * Задачи идут по возрастанию priority: прокрутка (0) раньше рисунка (10), поэтому рисунок видит свежий scrollY.
 */

/** @type {Map<(now: number) => boolean | void, number>} */
const jobs = new Map();
let id = 0;

function loop(now) {
  id = 0;
  const batch = [...jobs].sort((a, b) => a[1] - b[1]);
  for (const [fn] of batch) {
    if (!jobs.has(fn)) continue;
    let again = false;
    try {
      again = fn(now) === true;
    } catch (e) {
      // одна упавшая задача не должна останавливать остальные; ошибка уходит в консоль, как обычно
      queueMicrotask(() => {
        throw e;
      });
    }
    if (!again) jobs.delete(fn);
  }
  if (jobs.size && !id) id = requestAnimationFrame(loop);
}

/**
 * @param {(now: number) => boolean | void} fn
 * @param {number} [priority] меньше — раньше
 */
export function wake(fn, priority = 0) {
  jobs.set(fn, priority);
  if (!id) id = requestAnimationFrame(loop);
}

/** @param {(now: number) => boolean | void} fn */
export function cancel(fn) {
  jobs.delete(fn);
  if (!jobs.size && id) {
    cancelAnimationFrame(id);
    id = 0;
  }
}

/** Сколько задач ждёт кадр (для тестов и проверки «в покое цикла нет»). */
export function pending() {
  return jobs.size;
}
