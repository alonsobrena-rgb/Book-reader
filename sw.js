/* Service Worker: cachea toda la app (incluido PDF.js local) para que funcione
 * 100% sin internet una vez instalada. Los PDFs los abre el usuario. */
const CACHE = 'lector-pdf-v26';
const SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Solo gestionamos peticiones del propio origen (la app).
  if (url.origin !== self.location.origin) return;

  // Estrategia: RED PRIMERO (para recibir siempre la última versión), con
  // respaldo en caché si no hay conexión.
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
