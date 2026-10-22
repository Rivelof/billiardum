import { defineConfig } from 'vite';

// Программа клуба: база /club/ (Caddy отдаёт dist по /club/*, контракт M1 §11).
// Режим заглушки API: `npm run dev:mock -w web/admin` (или VITE_MOCK=1). Без него src/mock/ в сборку не попадает.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock' || process.env.VITE_MOCK === '1';
  const devLogin = mock || process.env.VITE_DEV_LOGIN === '1' || mode === 'development';
  return {
    base: '/club/',
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
      port: 5174,
      strictPort: true,
      proxy: mock ? undefined : { '/api': { target: process.env.BL_API_URL ?? 'http://127.0.0.1:3000' } },
    },
    preview: { port: 4174, strictPort: true },
  };
});
