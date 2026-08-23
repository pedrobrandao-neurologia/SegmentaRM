// Cache offline: pré-carrega o casco do aplicativo; modelos, fontes e vendors
// entram no cache na primeira utilização (cache-first).

const CACHE = 'segmentarm-v2'
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './lib/labels.js', './lib/quality.js', './lib/stats.js', './lib/nifti-writer.js',
  './lib/sav.js', './lib/pdf.js', './lib/zip.js', './lib/report.js',
  './workers/preprocess.worker.js', './workers/synthseg.worker.js',
  './lib/synthseg-core.js', './lib/tfjs-upsampling3d.js',
  './brainchop/brainchop-webworker.js', './brainchop/brainchop-parameters.js',
  './brainchop/tensor-utils.js', './brainchop/bwlabels.js',
  './vendor/niivue.js', './vendor/tf.fesm.min.js',
  './vendor/dcm2niix/index.jpeg.js', './vendor/dcm2niix/worker.jpeg.js',
  './vendor/dcm2niix/dcm2niix.jpeg.js', './vendor/dcm2niix/dcm2niix.jpeg.wasm',
  './vendor/fonts/archivo-var.woff2', './vendor/fonts/source-sans-3-var.woff2',
  './vendor/fonts/jetbrains-mono-var.woff2'
]

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== location.origin) return
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
      if (resp.ok) {
        const copy = resp.clone()
        caches.open(CACHE).then(c => c.put(e.request, copy))
      }
      return resp
    }))
  )
})
