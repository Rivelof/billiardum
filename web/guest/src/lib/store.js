import { useEffect, useState } from 'preact/hooks';

/**
 * Маленькое хранилище состояния без библиотек: get, set (слиянием), subscribe и хук useStore.
 * @template T
 * @param {T} initial
 */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    /** @param {Partial<T> | ((s: T) => Partial<T>)} patch */
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of listeners) fn(state);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Подписка компонента на хранилище. */
export function useStore(store) {
  const [state, setState] = useState(store.get());
  useEffect(() => {
    setState(store.get());
    return store.subscribe(setState);
  }, [store]);
  return state;
}

/** sessionStorage без исключений: в приватном режиме и WebView хранилище бывает недоступно. */
export const session = {
  get(key) {
    try {
      const raw = globalThis.sessionStorage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) globalThis.sessionStorage?.removeItem(key);
      else globalThis.sessionStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // хранилище недоступно — состояние живёт до перезагрузки
    }
  },
};

/** localStorage без исключений — только для удобств одного браузера (тема, «подсказку уже видел»). */
export const local = {
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value === null) globalThis.localStorage?.removeItem(key);
      else globalThis.localStorage?.setItem(key, value);
    } catch {
      // недоступно — не страшно
    }
  },
};
