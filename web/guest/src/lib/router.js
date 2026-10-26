import { useEffect, useState } from 'preact/hooks';

/**
 * Маршрутизатор на History API. Маршруты — шаблоны относительно базы приложения: 't/:code', 's/:id/receipt'.
 * @param {string} pathname location.pathname
 * @param {[string, string][]} routes [['t/:code', 'table'], …]
 * @param {string} base '/app/'
 * @returns {{ name: string, params: Record<string, string> }}
 */
export function matchRoute(pathname, routes, base) {
  let rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\//, '');
  rest = rest.replace(/\/+$/, '');
  const parts = rest ? rest.split('/') : [];
  for (const [pattern, name] of routes) {
    const want = pattern ? pattern.split('/') : [];
    if (want.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < want.length; i += 1) {
      if (want[i].startsWith(':')) {
        let value;
        try {
          value = decodeURIComponent(parts[i]);
        } catch {
          ok = false;
          break;
        }
        if (!value) {
          ok = false;
          break;
        }
        params[want[i].slice(1)] = value;
      } else if (want[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { name, params };
  }
  return { name: 'notfound', params: {} };
}

export const NAVIGATE_EVENT = 'bl:navigate';
const EVENT = NAVIGATE_EVENT;

/**
 * Переход внутри приложения без перезагрузки.
 * @param {string} to полный путь: '/app/s/123'
 * @param {{ replace?: boolean }} [options]
 */
export function navigate(to, options = {}) {
  if (options.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

/** Текущий путь и строка запроса; обновляется при navigate() и кнопке «Назад». */
export function useLocation() {
  const read = () => ({ pathname: location.pathname, search: location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const update = () => setLoc(read());
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return loc;
}

/** Обработчик клика по внутренней ссылке: обычный клик — переход без перезагрузки, с модификаторами — как браузер. */
export function linkHandler(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.currentTarget;
  if (a.target && a.target !== '_self') return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
}
