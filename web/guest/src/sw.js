/*
 * Сервис-воркер приложения гостя: оболочка работает без сети, Web Push.
 * Ответы API (/api/), короткие ссылки (/t/) и страница оплаты (/pay/) НЕ кэшируются никогда:
 * статус стола, оплаты и таймер всегда с сервера.
 * Списки файлов и версию подставляет scripts/sw-plugin.mjs при сборке.
 */

const VERSION = '__BL_VERSION__';
const PREFIX = '__BL_PREFIX__';
const PRECACHE = /* __BL_PRECACHE__ */ [];
const CACHE = `${PREFIX}-${VERSION}`;
const SCOPE = new URL(self.registration.scope);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((p) => new URL(p, SCOPE).href)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(`${PREFIX}-`) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(SCOPE.pathname)) return; // /api/, /t/, /pay/ — мимо воркера

  if (req.mode === 'navigate') {
    // Страница — из сети; без сети — оболочка, а экраны сами скажут «Нет связи»
    event.respondWith(fetch(req).catch(() => caches.match(new URL('./', SCOPE).href)));
    return;
  }
  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});

/** Ссылка из уведомления — только внутри приложения. */
function safeUrl(value) {
  try {
    const u = new URL(value, SCOPE);
    if (u.origin === SCOPE.origin && u.pathname.startsWith(SCOPE.pathname)) return u.href;
  } catch {
    // неверная ссылка — на главную
  }
  return SCOPE.href;
}

// Тело уведомления без персональных данных: только стол и время (decisions №53)
// { "title": "Стол 4", "body": "Осталось 10 минут, игра до 21:40", "url": "/app/s/{id}", "tag": "session-{id}" }
self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Бильярдум';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : 'bl-game',
      renotify: true,
      icon: new URL('icons/icon-192.png', SCOPE).href,
      badge: new URL('icons/icon-192.png', SCOPE).href,
      data: { url: safeUrl(data.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(SCOPE.href) && 'focus' in client) {
          return client.navigate(target).then((c) => (c ?? client).focus());
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
