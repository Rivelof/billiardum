import { useEffect, useState } from 'preact/hooks';
import { loginMethods } from '@billiardum/shared/api';
import { api } from '../lib/api.js';

/** Текущее время, обновляется на границе каждой секунды (таймер не «прыгает»). */
export function useNow(skew = 0, enabled = true) {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    if (!enabled) return undefined;
    let timer;
    const tick = () => {
      const t = Date.now() + skew;
      setNow(t);
      timer = setTimeout(tick, 1000 - (t % 1000) + 5);
    };
    tick();
    return () => clearTimeout(timer);
  }, [skew, enabled]);
  return now;
}

/** Повторять fn каждые ms, пока компонент на экране и вкладка видна; сразу — при возвращении во вкладку. */
export function usePoll(fn, ms, deps = []) {
  useEffect(() => {
    let stopped = false;
    let timer;
    const run = async () => {
      if (stopped) return;
      try {
        await fn();
      } finally {
        if (!stopped) timer = setTimeout(run, ms);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        run();
      }
    };
    run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, deps);
}

/** Совпадает ли медиазапрос; обновляется при повороте планшета. */
export function useMedia(query) {
  const get = () => Boolean(globalThis.matchMedia?.(query).matches);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    const mq = globalThis.matchMedia?.(query);
    if (!mq) return undefined;
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

// Способы входа читаем один раз за загрузку страницы: настройка ботов на сервере меняется редко
let methodsOnce = null;

/**
 * Способы входа (U1): undefined — ещё загружаем; null — ответ не разобрали или сервер старый
 * (экран входа показывает оба мессенджера); иначе — только настроенные.
 * @returns {string[] | null | undefined}
 */
export function useLoginMethods() {
  const [methods, setMethods] = useState(undefined);
  useEffect(() => {
    let alive = true;
    methodsOnce ??= api.authMethods().then(loginMethods, () => {
      methodsOnce = null; // сбой сети — в следующий раз спросим снова
      return null;
    });
    methodsOnce.then((m) => alive && setMethods(m));
    return () => {
      alive = false;
    };
  }, []);
  return methods;
}
