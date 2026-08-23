// mask.worker.js — limpeza da máscara cerebral (≈ pós-processamento do BET) em Web Worker.
// Entrada: mapa de probabilidade de cérebro (Uint8, 0–255, do modelo MeshNet com isScalar)
// ou máscara binária; aplica limiar f (análogo ao -f do BET), fechamento morfológico,
// maior componente 26-conexo e preenchimento de cavidades. Opcionalmente aplica a máscara
// ao volume de intensidade e normaliza [p2,p98]→[0,255] dentro dela (≈ efeito do FAST).

import { maskCleanup, normalizeWithinMask } from '../lib/fsl-prep.js'

function post (msg, transfer) { self.postMessage(msg, transfer || []) }

self.onmessage = (e) => {
  const { prob, intensity, dims, f, normalize } = e.data
  try {
    post({ cmd: 'progress', frac: 0.3, txt: 'Limpando máscara cerebral (limiar, fechamento, componente)…' })
    const cleaned = maskCleanup(new Uint8Array(prob), dims, f)
    const out = { cmd: 'done', mask: cleaned.mask, voxels: cleaned.voxels, removedComponents: cleaned.removedComponents, cavitiesFilled: cleaned.cavitiesFilled, log: [cleaned.log] }
    if (intensity) {
      post({ cmd: 'progress', frac: 0.7, txt: 'Aplicando máscara ao volume…' })
      let brain = new Uint8Array(intensity.length)
      for (let i = 0; i < brain.length; i++) brain[i] = cleaned.mask[i] ? intensity[i] : 0
      if (normalize) {
        const nrm = normalizeWithinMask(brain, cleaned.mask)
        out.log.push(nrm.log)
        out.normalized = nrm.applied
        if (nrm.applied) { brain = nrm.img; out.normP2 = nrm.p2; out.normP98 = nrm.p98 }
      }
      out.brain = brain
      post(out, [out.mask.buffer, out.brain.buffer])
    } else {
      post(out, [out.mask.buffer])
    }
  } catch (err) {
    post({ cmd: 'error', message: err.message || String(err) })
  }
}
