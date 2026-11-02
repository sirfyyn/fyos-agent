/* FYOS Agent — Service Worker.
 *
 * Die statische Oberfläche (HTML, CSS, JS, Bilder) wird im Cache vorgehalten, damit
 * der Client nach einem Neustart des Runners sofort wieder lädt. API-Aufrufe und der
 * SSE-Strom laufen immer direkt gegen den Runner (kein Cache, kein zweiter Zustand).
 *
 * Netz zuerst, Cache als Rückfall: früher kam jede Datei zuerst aus dem Cache. Da `VERSION` fest war und sw.js
 * sich nicht änderte, hat der Browser einen neuen Stand von app.js nie geholt (der Cache wurde nur bei einer
 * Änderung von sw.js selbst neu gefüllt). Jetzt holt jeder Aufruf den aktuellen Stand und merkt ihn sich;
 * nur wenn der Runner nicht antwortet (Neustart, offline), kommt die Datei aus dem Cache.
 */
const VERSION = 'fyos-agent-sw-v3';
const STATIC = [
  '/',
  '/index.html',
  '/app.js',
  '/i18n.js',
  '/style.css',
  '/wirken.css',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(STATIC)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((namen) =>
      Promise.all(namen.filter((name) => name !== VERSION).map((name) => caches.delete(name))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API, SSE und alles auf anderen Hosts nie cachen.
  if (url.pathname.startsWith('/api/') || url.origin !== locationOrigin()) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((antwort) => {
        if (antwort.status === 200) {
          const klon = antwort.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, klon)).catch(() => {});
        }
        return antwort;
      })
      .catch(() =>
        caches
          .match(event.request)
          .then((treffer) => treffer ?? (event.request.mode === 'navigate' ? caches.match('/index.html') : undefined))
          .then((treffer) => treffer ?? Response.error()),
      ),
  );
});

function locationOrigin() {
  try {
    return self.location.origin;
  } catch {
    return '';
  }
}
