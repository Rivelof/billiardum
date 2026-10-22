/* global __BL_MOCK__ */
import { render } from 'preact';
import '@billiardum/shared/fonts.css';
import '@billiardum/shared/tokens.css';
import '@billiardum/shared/ui.css';
import '@billiardum/shared/hall.css';
import './styles/app.css';
import './styles/redesign.css';
import { App } from './app.jsx';
import { configureApi } from './lib/api.js';
import { loadMe, tryMiniAppLogin } from './lib/auth.js';

async function boot() {
  let extra = null;
  // Заглушка API только в режиме разработки: __BL_MOCK__ подставляется при сборке, без флага ветка вырезается
  if (__BL_MOCK__) {
    const mock = await import('./mock/index.jsx');
    extra = mock.install(configureApi);
  }

  render(<App extra={extra} />, document.getElementById('app'));

  try {
    const viaMiniApp = await tryMiniAppLogin(location.hash);
    if (!viaMiniApp) await loadMe();
  } catch {
    // нет связи — экраны покажут ошибку сами
  }

  // Оболочка офлайн и Web Push. В разработке без сервис-воркера: Vite отдаёт модули на лету
  if (import.meta.env.PROD && !__BL_MOCK__ && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  }
}

boot();
