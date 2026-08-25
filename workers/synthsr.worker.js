// Worker do SynthSR (Iglesias et al., Sci Adv 2023 — BBillot/SynthSR, Apache 2.0):
// recebe o volume NATIVO (antes da conformação) e devolve o MP-RAGE T1 sintético
// 1 mm isotrópico em RAS, seguindo o predict_command_line.py oficial.
// Mensagem: { modelUrl, img, dims, affine (flat16), isGPU, tile, flip }
// Resposta: { cmd:'img', img: Float32Array [0,128], dims, affine } + progresso via 'ui'

import * as tf from '../vendor/tf.fesm.min.js'
import { registerUpSampling3D } from '../lib/tfjs-upsampling3d.js'
import { resampleToRAS1mm, tiledSR, flipX } from '../lib/synthsr-core.js'

function ui (message, progressFrac = -1, modalMessage = '') {
  self.postMessage({ cmd: 'ui', message, progressFrac, modalMessage })
}

self.onmessage = async (ev) => {
  const { modelUrl, img, dims, affine, isGPU = true, tile = 96, flip = false } = ev.data
  try {
    registerUpSampling3D(tf)
    if (isGPU && typeof OffscreenCanvas !== 'undefined') {
      try { await tf.setBackend('webgl') } catch { await tf.setBackend('cpu') }
    } else {
      await tf.setBackend('cpu')
    }
    await tf.enableProdMode()
    await tf.ready()
    ui(`SynthSR: backend ${tf.getBackend()}, baixando/carregando a rede (26 MB)…`, 0.01)
    const model = await tf.loadLayersModel(modelUrl)
    ui('SynthSR: reamostrando para a grade RAS 1 mm…', 0.04)
    const ras = resampleToRAS1mm(img, dims, affine)
    // normalização min–max global, como no oficial
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < ras.img.length; i++) { const v = ras.img[i]; if (v < mn) mn = v; if (v > mx) mx = v }
    const sc = mx > mn ? 1 / (mx - mn) : 1
    const norm = new Float32Array(ras.img.length)
    for (let i = 0; i < ras.img.length; i++) norm[i] = (ras.img[i] - mn) * sc
    ui(`SynthSR: sintetizando o MP-RAGE (grade ${ras.dims.join('×')}, blocos de ${tile}³${flip ? ', com média de flip L/R' : ''})…`, 0.06)
    const span = flip ? 0.45 : 0.9
    let out = await tiledSR(tf, model, norm, ras.dims, tile, 32, (f) => ui('', 0.06 + f * span))
    if (flip) {
      const out2f = await tiledSR(tf, model, flipX(norm, ras.dims), ras.dims, tile, 32, (f) => ui('', 0.51 + f * 0.44))
      const out2 = flipX(out2f, ras.dims)
      for (let i = 0; i < out.length; i++) out[i] = 0.5 * (out[i] + out2[i])
    }
    model.dispose()
    ui(`SynthSR: MP-RAGE sintético pronto (${ras.dims.join('×')} @ 1 mm).`, 0.99)
    self.postMessage({ cmd: 'img', img: out, dims: ras.dims, affine: ras.affine }, [out.buffer])
  } catch (e) {
    ui('', -1, 'SynthSR: ' + (e && e.message ? e.message : String(e)))
  }
}
