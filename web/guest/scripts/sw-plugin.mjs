// Плагин Vite: собирает dist/sw.js из src/sw.js и подставляет список файлов оболочки и версию.
// Кэшируются только статика приложения (HTML, JS, CSS, шрифты, значки). Ответы API не кэшируются никогда.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PUBLIC_FILES = ['manifest.webmanifest', 'theme-init.js', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
const CACHEABLE = /\.(?:js|css|woff2|svg|png|webmanifest)$/;

export function serviceWorker({ prefix, mock }) {
  const source = fileURLToPath(new URL('../src/sw.js', import.meta.url));
  return {
    name: 'bl-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => CACHEABLE.test(f) && !f.endsWith('.map'))
        .sort();
      const precache = ['./', ...PUBLIC_FILES, ...files];
      const version = createHash('sha256').update(precache.join('\n')).update(String(mock)).digest('hex').slice(0, 12);
      const code = readFileSync(source, 'utf8')
        .replace("'__BL_VERSION__'", JSON.stringify(version))
        .replace("'__BL_PREFIX__'", JSON.stringify(prefix))
        .replace('/* __BL_PRECACHE__ */ []', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: code });
    },
  };
}
