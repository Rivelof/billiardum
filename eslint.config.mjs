// ESLint (flat config) для всего репозитория: Node 22, ESM.
// web/ и shared/ работают в браузере — им только браузерные глобалы;
// их тесты и служебные скрипты идут в Node. JSX (*.jsx, Preact) разбирается,
// ссылки на компоненты в JSX ESLint 10 учитывает сам (no-unused-vars).

import js from '@eslint/js';
import globals from 'globals';

const BROWSER = ['web/**', 'shared/**'];
const NODE_IN_BROWSER_DIRS = [
  '**/*.test.{js,mjs}',
  '**/test/**/*.{js,mjs}',
  '**/tests/**/*.{js,mjs}',
  '**/scripts/**/*.{js,mjs}',
  '**/*.config.{js,mjs}',
];

export default [
  {
    ignores: ['**/node_modules/', '**/coverage/', '**/dist/', '**/.pio/', 'deploy/dev/certs/'],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      // Синтаксис, который понимает Node 22 (в том числе import ... with { type: 'json' }).
      ecmaVersion: 2025,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.jsx'],
    languageOptions: { sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: BROWSER,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: BROWSER.map((dir) => `${dir}/*.{js,mjs,jsx}`),
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['web/**/sw.js', 'web/**/service-worker.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    files: BROWSER.flatMap((dir) => NODE_IN_BROWSER_DIRS.map((p) => `${dir.slice(0, -3)}/${p}`)),
    languageOptions: { globals: { ...globals.node } },
  },
];
