const CACHE_NAME = 'werkplaats-administratie-v3';
const URLS_TO_CACHE = [
  './',
  './index.html',
  './uren.html',
  './manifest.json',
  './uren-manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore-compat.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(URLS_TO_CACHE))
      .catch(() => {}) // als een CDN-bestand niet gecached kan worden, app blijft alsnog werken
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

const GEEN_CACHE_DOMEINEN = ['firestore.googleapis.com', 'googleapis.com', 'firebaseio.com', 'identitytoolkit.googleapis.com'];

self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  if(GEEN_CACHE_DOMEINEN.some(d=> url.includes(d))){
    return; // live data: nooit cachen, altijd naar het netwerk
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // succesvolle responses ook cachen voor volgend offline gebruik
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
