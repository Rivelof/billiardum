/* BL_MOCK_MARKER — подключение заглушки API программы клуба (только VITE_MOCK=1). */
import { createBackend } from './backend.js';
import { setTerminal } from '../lib/api.js';

const KEY = 'bl-mock-admin';
const LATENCY = 160;

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
      // без хранилища — до перезагрузки
    }
  },
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function install(configureApi) {
  const backend = createBackend(storage);
  const params = new URLSearchParams(location.search);
  const sc = params.get('mock');
  if (sc) {
    backend.scenario(sc);
    if (sc === 'terminal') setTerminal({ token: 'term-mock', name: 'Ресепшн у входа', club_id: '0b6b8c1e-5a7d-4f0e-9c3a-2d1e4f5a6b7c' });
    params.delete('mock');
    const q = params.toString();
    history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
  }

  const fetchImpl = async (url, init = {}) => {
    await wait(LATENCY);
    const href = new URL(url, location.origin).href;
    // Тело JSON — объектом; файл (M5.1, импорт меню .xlsx) — байтами с типом: { __raw, __type }
    let body;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body !== undefined && init.body !== null) {
      const buf = init.body instanceof Blob ? await init.body.arrayBuffer() : init.body;
      body = { __raw: new Uint8Array(buf.buffer ?? buf), __type: init.headers?.['Content-Type'] ?? '' };
    }
    const res = await backend.handle(init.method ?? 'GET', { href, body });
    if (res.pdf) return new Response(new Blob([res.pdf], { type: 'application/pdf' }), { status: 200, headers: { 'content-type': 'application/pdf' } });
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json' } });
  };

  class MockEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.handlers = new Map();
      this.unsubscribe = backend.subscribe((name, data) => this.dispatch(name, data));
      this.timer = setInterval(() => backend.tick(), 5000);
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
  globalThis.blMock = Object.assign(backend, { marker: 'BL_MOCK_MARKER' });
}
