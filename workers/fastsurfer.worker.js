// Worker da parcelação FastSurfer (FastSurferCNN v1, Deep-MI/FastSurfer, Apache 2.0).
// Recebe o volume conformado 256³ + a máscara de córtex da segmentação-fonte, roda as
// vistas (0,4·axial + 0,4·coronal + 0,2·sagital) restritas à máscara e devolve a
// parcelação DKT no espaço do modelo 104 (1..34 ctx-lh, 35..68 ctx-rh), na ordem de
// voxels de origem — pronta para a fuseDKT.
// Mensagem: { baseUrl, img, dims, affine, mask, isGPU, views, batch }

import * as tf from '../vendor/tf.fesm.min.js'
import { toLIA, runFastSurferParc } from '../lib/fastsurfer-core.js'

function ui (message, progressFrac = -1, modalMessage = '') {
  self.postMessage({ cmd: 'ui', message, progressFrac, modalMessage })
}

self.onmessage = async (ev) => {
  const { baseUrl, img, dims, affine, mask, isGPU = true, views = ['coronal', 'axial', 'sagittal'], batch = 2 } = ev.data
  try {
    if (isGPU && typeof OffscreenCanvas !== 'undefined') {
      try { await tf.setBackend('webgl') } catch { await tf.setBackend('cpu') }
    } else {
      await tf.setBackend('cpu')
    }
    await tf.enableProdMode()
    await tf.ready()
    ui(`FastSurfer: backend ${tf.getBackend()}, baixando a rede…`, 0.01)
    const abs = (p) => new URL(p, baseUrl).href
    const manifest = await (await fetch(abs('models/fastsurfer/manifest.json'))).json()
    const bins = {}
    for (const v of views) {
      bins[v] = await (await fetch(abs('models/fastsurfer/' + manifest.views[v].bin))).arrayBuffer()
    }
    ui('FastSurfer: reorientando para LIA e preparando as fatias…', 0.03)
    const liaImg = toLIA(new Uint8Array(img), dims, affine)
    const liaMask = toLIA(new Uint8Array(mask), dims, affine)
    const { parcLia, stats } = await runFastSurferParc({
      tf,
      manifest,
      bins,
      lia: liaImg.img,
      dims: liaImg.dims,
      maskLia: liaMask.img,
      views,
      batch,
      onProgress: (f, txt) => ui(txt, 0.04 + f * 0.94)
    })
    // volta para a ordem de voxels de origem
    const out = new Uint8Array(parcLia.length)
    const back = liaImg.back
    for (let p = 0; p < parcLia.length; p++) {
      if (parcLia[p]) out[back[p]] = parcLia[p]
    }
    ui(`FastSurfer: ${stats.ctxVox.toLocaleString()} voxels parcelados em ${stats.slices} fatias (${stats.views.join('+')}).`, 0.99)
    self.postMessage({ cmd: 'img', img: out, stats }, [out.buffer])
  } catch (e) {
    ui('', -1, 'FastSurfer: ' + (e && e.message ? e.message : String(e)))
  }
}
