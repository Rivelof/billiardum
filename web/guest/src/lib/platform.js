/**
 * Мини-приложение Telegram: подписанные данные запуска приходят в адресе после # (tgWebAppData).
 * Внешний скрипт telegram-web-app.js не подключаем: CSP разрешает только свой хост (decisions №22).
 * @param {string} hash location.hash
 * @returns {string | null} init_data для POST /api/auth/telegram
 */
export function telegramInitData(hash) {
  if (!hash || hash.length < 2) return null;
  let params;
  try {
    params = new URLSearchParams(hash.slice(1));
  } catch {
    return null;
  }
  const data = params.get('tgWebAppData');
  return data && /(?:^|&)hash=/.test(data) ? data : null;
}

/**
 * Приложение открыто как мини-приложение MAX или Telegram: в адресе после # лежат параметры запуска
 * (tgWebAppData, tgWebAppPlatform, tgWebAppVersion; у MAX — WebAppData и т. п.). В мини-приложении остаётся
 * нативная прокрутка (плавную колесом включаем только в обычном браузере и PWA, shared/smooth-scroll.mjs).
 * @param {string} hash location.hash
 */
export function isMiniAppHash(hash) {
  return /(?:^|[#&?])(?:tg)?WebApp(?:Data|Platform|Version)=/i.test(hash ?? '');
}

/**
 * Запуск как мини-приложение запоминаем при загрузке модуля: после первого перехода между экранами
 * адрес уже без #-параметров. Встроенные окна (iframe) shared/smooth-scroll.mjs отсекает сам.
 */
export const LAUNCHED_AS_MINIAPP = (() => {
  try {
    return isMiniAppHash(globalThis.location?.hash) || Boolean(globalThis.TelegramWebviewProxy);
  } catch {
    return false;
  }
})();

/** iPhone и iPad (iPadOS представляется Mac с сенсорным экраном). */
export function isIos(ua = globalThis.navigator?.userAgent ?? '', touchPoints = globalThis.navigator?.maxTouchPoints ?? 0) {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** Открыто с экрана «Домой» как приложение. */
export function isStandalone() {
  try {
    return Boolean(globalThis.matchMedia?.('(display-mode: standalone)').matches || globalThis.navigator?.standalone);
  } catch {
    return false;
  }
}

/**
 * Можно ли подписаться на Web Push здесь.
 * На iPhone Web Push работает только у сайта на экране «Домой» (iOS 16.4+, PRODUCT §12).
 * @returns {'ok' | 'ios-install' | 'denied' | 'granted' | 'unsupported'}
 */
export function pushAvailability() {
  const g = globalThis;
  const supported = 'serviceWorker' in (g.navigator ?? {}) && 'PushManager' in g && 'Notification' in g;
  if (isIos() && !isStandalone()) return 'ios-install';
  if (!supported) return 'unsupported';
  if (g.Notification.permission === 'denied') return 'denied';
  if (g.Notification.permission === 'granted') return 'granted';
  return 'ok';
}

/** Ключ VAPID из base64url в байты для pushManager.subscribe. */
export function base64UrlToBytes(value) {
  const pad = '='.repeat((4 - (value.length % 4)) % 4);
  const b64 = (value + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
