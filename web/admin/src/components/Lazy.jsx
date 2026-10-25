import { useEffect, useState } from 'preact/hooks';

/**
 * Экраны отдельными чанками (M5.1): мастер подключения и «Подключить клуб» не нужны на кассе и ресепшене,
 * поэтому не входят в первую загрузку программы клуба.
 */
const CHUNKS = {
  start: () => import('../screens/ClubStart.jsx'),
  onboarding: () => import('../screens/onboarding/Onboarding.jsx'),
  // M5.2: дашборд владельца и отчёты — свои чанки, на первую загрузку кассы не влияют
  dashboard: () => import('../screens/dashboard/Dashboard.jsx'),
  reports: () => import('../screens/reports/Reports.jsx'),
  // M5.3: экран «Подписка» владельца и «Клубы и подписки» платформы — свои чанки; плашка подписки — в каркасе
  billing: () => import('../screens/billing/Subscription.jsx'),
  platformBilling: () => import('../screens/billing/PlatformBilling.jsx'),
  // M5.6: обслуживание столов (внутри «Отчётов»); M5.7: «API и вебхуки» владельца
  maintenance: () => import('../screens/maintenance/Maintenance.jsx'),
  clubapi: () => import('../screens/clubapi/ClubApi.jsx'),
};
const loaded = {};

export function Lazy({ chunk, label, render, fallback }) {
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
    if (fallback) return fallback;
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
