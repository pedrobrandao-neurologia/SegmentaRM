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
  const { modelUrl, dims, affine, isGPU = true, flip = false } = ev.data
  let tile = ev.data.tile || 96
  let img = ev.data.img
  ev.data.img = null // o nativo só serve à reamostragem: solta a referência depois dela
  let model = null
  try {
    registerUpSampling3D(tf)
    if (isGPU && typeof OffscreenCanvas !== 'undefined') {
      // setBackend devolve false (não lança) quando a WebGL não inicializa
      if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu')
    } else {
      await tf.setBackend('cpu')
    }
    await tf.enableProdMode()
    await tf.ready()
    // bloco que cabe na textura da GPU (maior ativação ≈ 72 canais em resolução cheia)
    if (tf.getBackend() === 'webgl') {
      const maxTex = tf.env().getNumber('WEBGL_MAX_TEXTURE_SIZE') || 4096
      while (tile > 32 && tile ** 3 * 72 > maxTex * maxTex) tile -= 32
    }
    ui(`SynthSR: backend ${tf.getBackend()}, baixando/carregando a rede (26 MB)…`, 0.01)
    model = await tf.loadLayersModel(modelUrl)
    ui('SynthSR: reamostrando para a grade RAS 1 mm…', 0.04)
    const ras = resampleToRAS1mm(img, dims, affine)
    img = null
    // normalização min–max global, como no oficial — in place (poupa um volume)
    const norm = ras.img
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < norm.length; i++) { const v = norm[i]; if (v < mn) mn = v; if (v > mx) mx = v }
    const sc = mx > mn ? 1 / (mx - mn) : 1
    for (let i = 0; i < norm.length; i++) norm[i] = (norm[i] - mn) * sc
    ui(`SynthSR: sintetizando o MP-RAGE (grade ${ras.dims.join('×')}, blocos de ${tile}³${flip ? ', com média de flip L/R' : ''})…`, 0.06)
    const span = flip ? 0.45 : 0.9
    // sem recorte aqui: o oficial faz 0,5·(pred + flip(pred(flip))) e SÓ DEPOIS ×255 e [0,128]
    const out = await tiledSR(tf, model, norm, ras.dims, tile, 32, (f) => ui('', 0.06 + f * span), false)
    if (flip) {
      const [nx, ny, nz] = ras.dims
      const out2f = await tiledSR(tf, model, flipX(norm, ras.dims), ras.dims, tile, 32, (f) => ui('', 0.51 + f * 0.44), false)
      // média com a predição do volume espelhado, desfazendo o espelho no índice
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
        const b = (j + k * ny) * nx
        for (let i = 0; i < nx; i++) out[b + i] = 0.5 * (out[b + i] + out2f[b + (nx - 1 - i)])
      }
    }
    for (let i = 0; i < out.length; i++) { const v = out[i]; out[i] = v < 0 ? 0 : (v > 128 ? 128 : v) }
    model.dispose()
    ui(`SynthSR: MP-RAGE sintético pronto (${ras.dims.join('×')} @ 1 mm).`, 0.99)
    self.postMessage({ cmd: 'img', img: out, dims: ras.dims, affine: ras.affine }, [out.buffer])
  } catch (e) {
    try { if (model) model.dispose() } catch {}
    ui('', -1, 'SynthSR: ' + (e && e.message ? e.message : String(e)))
  }
}
