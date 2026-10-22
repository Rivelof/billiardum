/**
 * Адрес подтверждения оплаты из ответа сервера — только https (или свой хост в разработке).
 * Защита от javascript: и data: в confirmation.url, если ответ подменён.
 * @param {unknown} url
 * @param {string} [origin] location.origin
 * @returns {string | null}
 */
export function safeRedirectUrl(url, origin = globalThis.location?.origin ?? 'https://localhost') {
  if (typeof url !== 'string' || !url) return null;
  let parsed;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }
  if (parsed.origin === origin) return parsed.href;
  if (parsed.protocol === 'https:') return parsed.href;
  return null;
}

/**
 * Ссылка из уведомления или параметра — только внутри приложения гостя.
 * @param {unknown} path
 * @param {string} base '/app/'
 */
export function safeAppPath(path, base) {
  if (typeof path !== 'string' || !path.startsWith(base) || path.startsWith('//')) return base;
  return path;
}
