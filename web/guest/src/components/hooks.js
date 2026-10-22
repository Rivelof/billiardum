import { useEffect, useState } from 'preact/hooks';

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
