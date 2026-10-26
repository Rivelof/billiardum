/**
 * Плавная прокрутка колесом мыши и тачпадом — Lenis (npm `lenis` 1.3.26, MIT; решение №228, DESIGN §6).
 * Включается только там, где её просили включить (публичный сайт и главная приложения гостя) и только
 * когда это помогает: Lenis грузится отдельным чанком уже после первой отрисовки, а не в критическом пути.
 * Сам `lenis` в shared не зависимость (shared без зависимостей): пакет стоит у web/site и web/guest, а тот,
 * кто включает прокрутку, передаёт загрузчик `load: () => import('lenis')` — сборка делает из него чанк.
 *
 *   startSmoothScroll({ load, … }) → () => void   включить; вернуть функцию «выключить» (в SPA — при уходе с экрана)
 *   smoothScrollAllowed(env)    → boolean      чистое правило «можно ли», проверяется тестами
 *
 * Не включается: при prefers-reduced-motion (и сам Lenis при смене настройки на лету отдаёт прокрутку 1:1),
 * на устройствах без мыши и тачпада (`any-pointer: fine`) — там остаётся нативная прокрутка и pull-to-refresh,
 * в режиме экономии трафика, во встроенных окнах (iframe: мини-приложения MAX и Telegram открываются так)
 * и когда вызывающий сказал `miniApp: true`.
 *
 * Что остаётся нативным: клавиатура (Space, PgUp/PgDn, Home/End, стрелки, Tab), касание пальцем (`syncTouch`
 * выключен), горизонтальная прокрутка, колесо над вложенной прокручиваемой областью (`allowNestedScroll`) и
 * над диалогом `<dialog>`, `[aria-modal]`, `[data-lenis-prevent]`. Якоря `#…` Lenis докручивает плавно, но
 * хеш, фокус и `scroll-margin`/`scroll-padding` остаются за браузером. `scrollIntoView` и поиск по странице
 * работают как раньше: Lenis подхватывает их из события прокрутки.
 *
 * Один экземпляр на страницу (счётчик подписчиков) и один rAF-цикл на всех (raf.mjs): в покое кадров нет,
 * цикл просыпается от колеса, клика и клавиши и засыпает, когда Lenis закончил движение.
 */
import { cancel, wake } from './raf.mjs';

/**
 * @param {{ reduce?: boolean, fine?: boolean, saveData?: boolean, framed?: boolean, miniApp?: boolean }} env
 * @returns {boolean}
 */
export function smoothScrollAllowed(env) {
  return !env.reduce && env.fine !== false && !env.saveData && !env.framed && !env.miniApp;
}

function readEnv(options) {
  const mq = (q) => globalThis.matchMedia?.(q).matches ?? false;
  let framed;
  try {
    framed = globalThis.top !== globalThis.self;
  } catch {
    framed = true; // чужой источник — точно встроенное окно
  }
  return {
    reduce: mq('(prefers-reduced-motion: reduce)'),
    fine: mq('(any-pointer: fine)'),
    saveData: Boolean(globalThis.navigator?.connection?.saveData),
    framed,
    miniApp: Boolean(options.miniApp),
  };
}

/** @type {{ stop: () => void } | null} */
let instance = null;
let users = 0;
let loading = false;

/** Узлы, над которыми колесо прокручивает не страницу: модальные окна. */
const isModal = (node) => node.localName === 'dialog' || node.getAttribute?.('aria-modal') === 'true';

function create(Lenis, options) {
  const lenis = new Lenis({
    autoRaf: false, // кадры даёт общий цикл raf.mjs
    smoothWheel: true,
    syncTouch: false, // касание — нативное
    anchors: true,
    allowNestedScroll: true,
    prevent: isModal,
  });

  let awake = false;
  const run = (now) => {
    lenis.raf(now);
    awake = lenis.isScrolling === 'smooth';
    return awake;
  };
  const poke = () => {
    if (!awake) {
      lenis.time = 0; // первый кадр после сна — с нулевым шагом, иначе Lenis решит, что прошла вечность
      awake = true;
    }
    wake(run, 0);
  };

  const offVirtual = lenis.on('virtual-scroll', poke);
  const wakeEvents = ['click', 'keydown'];
  for (const e of wakeEvents) addEventListener(e, poke, { capture: true, passive: true });
  const resets = (options.resetOn ?? []).map((name) => {
    const fn = () => lenis.reset();
    addEventListener(name, fn);
    return [name, fn];
  });
  const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const onMotion = () => {
    if (mq.matches) stopAll();
  };
  mq?.addEventListener?.('change', onMotion);

  return {
    stop() {
      cancel(run);
      offVirtual?.();
      for (const e of wakeEvents) removeEventListener(e, poke, { capture: true });
      for (const [name, fn] of resets) removeEventListener(name, fn);
      mq?.removeEventListener?.('change', onMotion);
      lenis.destroy();
    },
  };
}

function stopAll() {
  users = 0;
  instance?.stop();
  instance = null;
}

/**
 * @param {{ load: () => Promise<{ default: any }>, miniApp?: boolean, resetOn?: string[] }} options
 *   load — загрузчик Lenis: () => import('lenis') (чанк скачивается, только если прокрутка здесь разрешена);
 *   miniApp — приложение открыто как мини-приложение MAX/Telegram: нативная прокрутка;
 *   resetOn — события window, на которых гасить инерцию (переход между экранами SPA)
 * @returns {() => void} выключить (можно вызывать несколько раз)
 */
export function startSmoothScroll(options) {
  if (typeof options?.load !== 'function' || !smoothScrollAllowed(readEnv(options))) return () => {};
  users += 1;
  let released = false;
  if (!instance && !loading) {
    loading = true;
    options
      .load()
      .then(({ default: Lenis }) => {
        // успели выключить, пока грузился чанк, или экземпляр уже создан — ничего не делаем
        if (users > 0 && !instance) instance = create(Lenis, options);
      })
      .catch(() => {
        // чанк не загрузился (нет сети) — остаётся нативная прокрутка
      })
      .finally(() => {
        loading = false;
      });
  }
  return () => {
    if (released) return;
    released = true;
    users = Math.max(0, users - 1);
    if (users === 0 && instance) {
      instance.stop();
      instance = null;
    }
  };
}
