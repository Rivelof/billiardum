import { useEffect, useState } from 'preact/hooks';

/**
 * Экраны отдельными чанками (M5.1): мастер подключения и «Подключить клуб» не нужны на кассе и ресепшене,
 * поэтому не входят в первую загрузку программы клуба.
 */
const CHUNKS = {
  start: () => import('../screens/ClubStart.jsx'),
  onboarding: () => import('../screens/onboarding/Onboarding.jsx'),
};
const loaded = {};

export function Lazy({ chunk, label, render }) {
  // Модуль храним вместе с именем чанка: тот же компонент на новом маршруте не отдаст чужой модуль
  const [state, setState] = useState(() => ({ chunk, mod: loaded[chunk] ?? null }));
  const [failed, setFailed] = useState(false);
  const mod = state.chunk === chunk ? state.mod : (loaded[chunk] ?? null);
  useEffect(() => {
    if (loaded[chunk]) {
      setState({ chunk, mod: loaded[chunk] });
      return;
    }
    CHUNKS[chunk]()
      .then((m) => {
        loaded[chunk] = m;
        setState({ chunk, mod: m });
      })
      .catch(() => setFailed(true));
  }, [chunk]);
  if (failed) {
    return (
      <main class="signin" data-theme="dark">
        <div class="signin__card">
          <p class="signin__brand display">Бильярдум</p>
          <p class="lead">Не получилось загрузить экран. Проверьте интернет и обновите страницу.</p>
          <button type="button" class="btn btn--primary btn--block" onClick={() => location.reload()}>
            Обновить страницу
          </button>
        </div>
      </main>
    );
  }
  if (!mod) {
    return (
      <main class="signin" data-theme="dark" aria-busy="true">
        <p class="signin__brand display" role="status">
          {label}
        </p>
      </main>
    );
  }
  return render(mod);
}
