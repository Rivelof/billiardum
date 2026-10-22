/* global __BL_MOCK__ */
import { render } from 'preact';
import '@billiardum/shared/fonts.css';
import '@billiardum/shared/tokens.css';
import '@billiardum/shared/ui.css';
import '@billiardum/shared/hall.css';
import './styles/admin.css';
import './styles/m2.css';
import './styles/m3.css';
import { App } from './app.jsx';
import { configureApi } from './lib/api.js';
import { loadMe } from './lib/auth.js';

async function boot() {
  // Заглушка API только в режиме разработки: __BL_MOCK__ подставляется при сборке, без флага ветка вырезается
  if (__BL_MOCK__) {
    const mock = await import('./mock/index.js');
    mock.install(configureApi);
  }
  render(<App />, document.getElementById('app'));
  try {
    await loadMe();
  } catch {
    // нет связи — экран входа покажет ошибку при попытке
  }
}

boot();
