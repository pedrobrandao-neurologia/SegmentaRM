// Substitui os workers de inferência (SynthSeg, FastSurfer, brainchop) por respostas
// sintéticas instantâneas: testa encadeamento e estado sem custo de rede. Os demais são reais.
(() => {
  const RealWorker = window.Worker
  window.__fakeDelay = 300
  window.__fakeFail = null // regex de URL que deve falhar
  class FakeWorker {
    constructor (url) { this.url = String(url); this.onmessage = null; this.onerror = null; this.terminated = false; window.__fakeCount = (window.__fakeCount || 0) + 1 }
    terminate () { this.terminated = true; window.__fakeTerminated = (window.__fakeTerminated || 0) + 1 }
    addEventListener (t, f) { if (t === 'message') this.onmessage = f }
    postMessage (msg) {
      const emit = (d) => { if (!this.terminated && this.onmessage) this.onmessage({ data: d }) }
      setTimeout(() => {
        emit({ cmd: 'ui', message: 'fake ' + this.url.split('/').pop(), progressFrac: 0.5 })
        if (window.__fakeFail && window.__fakeFail.test(this.url)) { emit({ cmd: 'ui', message: '', progressFrac: -1, modalMessage: 'falha simulada: out of memory' }); return }
        const img = msg.img || msg.niftiImage
        const n = img.length
        const out = new Uint8Array(n)
        if (/synthseg/.test(this.url)) {
          const conf = new Uint8Array(n)
          for (let i = 0; i < n; i++) {
            const x = i % 256, v = img[i]
            const L = x >= 128
            if (v > 110) out[i] = L ? 1 : 18
            else if (v > 60) out[i] = L ? 2 : 19
            else if (v > 30) out[i] = 24 > 0 ? (L ? 3 : 20) : 0
            conf[i] = out[i] ? 220 : 250
          }
          const volumes = new Float64Array(32)
          for (let i = 0; i < n; i++) volumes[out[i]] += 0.97
          window.__lastSynthsegMsg = { native: !!msg.native, nativeDims: msg.native && msg.native.dims, overlap: msg.overlap, flip: msg.flip }
          // bloco usado = o pedido (sem GPU que o reduza)
          emit({ cmd: 'img', img: out, conf, volumes, volumesUnit: 'mm3', bloco: msg.tile, blocoPedido: msg.tile })
        } else if (/fastsurfer/.test(this.url)) {
          const mask = msg.mask
          for (let i = 0; i < n; i++) if (mask[i]) { const y = ((i / 256) | 0) % 256; out[i] = 1 + ((y >> 3) % 34) }
          emit({ cmd: 'img', img: out })
        } else { // brainchop
          const isScalar = msg.modelEntry && msg.modelEntry.isScalar
          for (let i = 0; i < n; i++) { const v = img[i]; out[i] = isScalar ? Math.min(255, v * 2) : (v > 110 ? 2 : v > 60 ? 1 : 0) }
          emit({ cmd: 'img', img: out })
        }
      }, window.__fakeDelay)
    }
  }
  window.Worker = function (url, opts) {
    const u = String(url)
    if (/synthseg\.worker|brainchop-webworker|fastsurfer\.worker/.test(u)) return new FakeWorker(u)
    return new RealWorker(url, opts)
  }
})()
