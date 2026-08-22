// sw.js — cache do app shell para funcionar offline.
// Os modelos ONNX ficam no OPFS, não aqui.
const CACHE = 'neurovol-v1';
const SHELL = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './lib/nifti.js', './lib/dicom.js', './lib/resample.js',
  './lib/infer.js', './lib/stats.js', './lib/sav.js',
  './lib/lut.js', './lib/viewer.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isRuntime = /cdn\.jsdelivr\.net|unpkg\.com/.test(url.hostname);
  if (e.request.method !== 'GET') return;

  if (isRuntime) {
    // ONNX Runtime: cache-first, para a segunda execução funcionar sem rede.
    e.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
