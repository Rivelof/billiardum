/* BL_MOCK_MARKER — подключение заглушки API (только VITE_MOCK=1). */
import { formatMoney } from '@billiardum/shared/format';
import { createBackend } from './backend.js';

const KEY = 'bl-mock-guest';
const LATENCY = 180;

const storage = {
  load() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  save(state) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // без хранилища заглушка живёт до перезагрузки
    }
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Подменяет fetch и EventSource клиента API. Возвращает доп. маршрут страницы «ЮKassa». */
export function install(configureApi) {
  const backend = createBackend(storage);

  const params = new URLSearchParams(location.search);
  const sc = params.get('mock');
  if (sc) {
    backend.scenario(sc);
    params.delete('mock');
    const q = params.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
  }

  const fetchImpl = async (url, init = {}) => {
    await wait(LATENCY);
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const res = await backend.handle(init.method ?? 'GET', u.pathname, body, u.searchParams);
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = new Map();
      const id = new URL(url, location.origin).searchParams.get('session');
      this.unsubscribe = backend.subscribe(id, (data, name = 'session') => this.dispatch(name, data));
      // Бар готовит заказы сам — статусы двигаются раз в 3 секунды
      this.timer = setInterval(() => backend.handle('GET', '/api/__tick'), 3000);
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.();
      }, LATENCY);
    }
    addEventListener(name, fn) {
      if (!this.handlers.has(name)) this.handlers.set(name, new Set());
      this.handlers.get(name).add(fn);
    }
    dispatch(name, data) {
      for (const fn of this.handlers.get(name) ?? []) fn({ data: JSON.stringify(data) });
    }
    close() {
      this.readyState = 2;
      clearInterval(this.timer);
      this.unsubscribe();
    }
  }

  configureApi({ fetch: fetchImpl, EventSource: MockEventSource });
  // Метка заглушки: строка переживает минификацию, scripts/size.mjs ищет её в обычной сборке
  globalThis.blMock = Object.assign(backend, { marker: 'BL_MOCK_MARKER' }); // и для ручной проверки из консоли

  return {
    routes: [['mock-pay/:id', 'mockpay']],
    render: (name, routeParams) => (name === 'mockpay' ? <MockPay id={routeParams.id} backend={backend} /> : null),
  };
}

function MockPay({ id, backend }) {
  const p = backend.payment(id);
  const go = (success) => {
    backend.confirm(id, success);
    // return_url платежа: стол — /app/wait/{id}, бар — /app/orders/{id} и /app/sessions/{id}/tab (backend-pos)
    location.assign(p?.return_url ?? `/app/wait/${id}`);
  };
  return (
    <div class="screen screen--paper">
      <main class="wrap content">
        <p class="devlogin__tag">Заглушка разработки вместо страницы ЮKassa</p>
        <h1 class="page-title display">{p ? `Оплата ${formatMoney(p.amount_kopecks)}` : 'Платёж не найден'}</h1>
        {p ? (
          <div class="stack">
            <button type="button" class="btn btn--primary btn--block btn--lg" onClick={() => go(true)}>
              Оплатить
            </button>
            <button type="button" class="btn btn--quiet btn--block" onClick={() => go(false)}>
              Отказаться от оплаты
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
