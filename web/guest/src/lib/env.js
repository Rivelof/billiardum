/* global __BL_MOCK__, __BL_DEV_LOGIN__ */
// Флаги сборки. __BL_MOCK__ подставляет vite.config.js (define): true только при `--mode mock` или VITE_MOCK=1.
// Без флага условие сворачивается в false, и заглушка не попадает в сборку (проверяет scripts/size.mjs).
export const MOCK = typeof __BL_MOCK__ !== 'undefined' && __BL_MOCK__ === true;

// Вход по телефону без бота — только разработка (POST /api/auth/dev не существует в проде).
export const DEV_LOGIN = MOCK || (typeof __BL_DEV_LOGIN__ !== 'undefined' && __BL_DEV_LOGIN__ === true);

export const BASE = '/app/';
