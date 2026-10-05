// Cache offline: pré-carrega o casco do aplicativo; modelos, fontes e vendors
// entram no cache na primeira utilização (cache-first).

const CACHE = 'segmentarm-v30'
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
  './lib/labels.js', './lib/quality.js', './lib/stats.js', './lib/nifti-writer.js',
  './lib/sav.js', './lib/pdf.js', './lib/zip.js', './lib/report.js',
  './workers/preprocess.worker.js', './workers/synthseg.worker.js',
  './workers/mask.worker.js', './workers/fastsurfer.worker.js',
  './workers/synthsr.worker.js', './workers/reconsurf.worker.js', './workers/thickness.worker.js', './workers/icv.worker.js',
  './lib/surfaces.js', './lib/synthsr-core.js', './lib/sdf-surface.js', './lib/segqc.js', './lib/thickness.js',
  './lib/synthseg-core.js', './lib/tfjs-upsampling3d.js', './lib/fastsurfer-core.js',
  './lib/dkt-fusion.js', './lib/normative.js', './lib/fsl-prep.js', './lib/n4.js', './lib/icv.js',
  './fonts/inter/Inter-400.ttf', './fonts/inter/Inter-600.ttf', './fonts/inter/Inter-700.ttf', './fonts/inter/kern.json', './lib/dicom-scan.js',
  './lib/protocolo.js', './lib/qcrules.js', './lib/calibracao.js', './lib/assimetria.js',
  './models/qc_rules.json', './models/manifest-sha256.json',
  './models/normative/brainchart.json',
  './models/normative/subcortical.json',
  './models/normative/erro_medida.json', './models/normative/recentragem_synthseg.json',
  './models/normative/normas_segmentarm.json',
  './models/normative/referencia_mesmo_metodo.json',
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
  // navegação ignora a query (?mockbet etc.) para abrir offline pelo casco em cache
  const opts = e.request.mode === 'navigate' ? { ignoreSearch: true } : undefined
  e.respondWith(
    caches.match(e.request, opts).then(hit => hit || fetch(e.request).then(resp => {
      // só respostas completas: 206 (Range) faz cache.put lançar; cota cheia também —
      // falhar ao guardar não pode derrubar a resposta
      if (resp.status === 200 && !e.request.headers.has('range')) {
        const copy = resp.clone()
        e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}))
      }
      return resp
    }))
  )
})
