/* global __BL_MOCK__, __BL_DEV_LOGIN__ */
// Флаги сборки, как в web/guest: __BL_MOCK__ — заглушка API (VITE_MOCK=1), __BL_DEV_LOGIN__ — вход по телефону.
export const MOCK = typeof __BL_MOCK__ !== 'undefined' && __BL_MOCK__ === true;
export const DEV_LOGIN = MOCK || (typeof __BL_DEV_LOGIN__ !== 'undefined' && __BL_DEV_LOGIN__ === true);
export const BASE = '/club/';
