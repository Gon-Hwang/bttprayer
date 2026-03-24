const CACHE_NAME = 'bttprayer-cache-v83';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css?v=2026030956',
  '/js/main.js?v=2026032410',
  '/favicon.svg?v=2026031001',
  '/app-icon-192.png?v=2026031001',
  '/app-icon-512.png?v=2026031001',
  '/manifest.webmanifest?v=2026031002'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const isNavigation = event.request.mode === 'navigate';
  const isHtmlDocument = requestUrl.pathname === '/' || requestUrl.pathname.endsWith('/index.html');

  // HTML은 항상 네트워크 우선으로 받아 최신 index/main.js 버전을 따라가게 한다.
  if (isNavigation || isHtmlDocument) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return response;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
