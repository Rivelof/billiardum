import { defineConfig } from 'vite';
import { serviceWorker } from './scripts/sw-plugin.mjs';

// Приложение гостя: база /app/ (Caddy отдаёт dist по /app/*, контракт M1 §11).
// Режим заглушки API: `npm run dev:mock -w web/guest` (или VITE_MOCK=1). Без него src/mock/ в сборку не попадает.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock' || process.env.VITE_MOCK === '1';
  const devLogin = mock || process.env.VITE_DEV_LOGIN === '1' || mode === 'development';
  return {
    base: '/app/',
    define: {
      __BL_MOCK__: JSON.stringify(mock),
      __BL_DEV_LOGIN__: JSON.stringify(devLogin),
    },
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      assetsInlineLimit: 0,
      sourcemap: false,
      modulePreload: { polyfill: false },
    },
    server: {
      port: 5173,
      strictPort: true,
      // Без заглушки — настоящий сервер разработки (deploy/dev публикует его на 127.0.0.1:3000)
      proxy: mock ? undefined : { '/api': { target: process.env.BL_API_URL ?? 'http://127.0.0.1:3000' } },
    },
    preview: { port: 4173, strictPort: true },
    plugins: [serviceWorker({ prefix: 'bl-guest', mock })],
  };
});
