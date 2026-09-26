// Worker de segmentação SynthSeg 1.0 (rede original de Billot/Iglesias, Apache 2.0,
// convertida para TensorFlow.js). Recebe o volume conformado 256³ · 1 mm e devolve
// o mapa de rótulos (índice do canal, 0–31) na mesma ordem de voxels.
// Mensagem: { modelUrl, img (Uint8Array | Float32Array…), dims, affine, isGPU, tile, overlap,
//             flip = true, sigma = 0.5, postprocess = true }
// Resposta: { cmd:'img', img: Uint8Array (canal 0–31), conf: Uint8Array (posterior
//             máxima 0–255), volumes: Float64Array (volume "soft" por canal, em voxels —
//             mm³ na grade de 1 mm; equivalente ao --vol do oficial) }
// O pipeline (pré-processamento, blocos, TTA, suavização, pós-processamento) está em
// lib/synthseg-core.js › runSynthSeg, o mesmo código exercitado pelos testes em Node.

import * as tf from '../vendor/tf.fesm.min.js'
import { registerUpSampling3D } from '../lib/tfjs-upsampling3d.js'
import { runSynthSeg, SYNTHSEG1_TOPOLOGY } from '../lib/synthseg-core.js'

function ui (message, progressFrac = -1, modalMessage = '') {
  self.postMessage({ cmd: 'ui', message, progressFrac, modalMessage })
}

self.onmessage = async (ev) => {
  const {
    modelUrl, img, dims, affine, isGPU = true, tile = 128, overlap = 32,
    flip = true, sigma = 0.5, postprocess = true
  } = ev.data
  try {
    registerUpSampling3D(tf)
    // tf.setBackend devolve false (sem lançar) quando o backend não inicializa
    let gpuFail = false
    if (isGPU && typeof OffscreenCanvas !== 'undefined') {
      if (!(await tf.setBackend('webgl').catch(() => false))) gpuFail = true
    } else if (isGPU) {
      gpuFail = true
    }
    if (gpuFail || !isGPU) {
      if (!(await tf.setBackend('cpu').catch(() => false))) throw new Error('nenhum backend do TensorFlow.js inicializou')
    }
    tf.enableProdMode()
    await tf.ready()
    ui(`SynthSeg: backend ${tf.getBackend()}${gpuFail ? ' (WebGL indisponível neste navegador/worker — caindo para CPU, bem mais lento)' : ''}, baixando/carregando a rede…`, 0.02)
    const model = await tf.loadLayersModel(modelUrl)
    const nOut = model.outputs[0].shape[4]
    if (nOut !== SYNTHSEG1_TOPOLOGY.length) throw new Error(`rede com ${nOut} canais — esperados ${SYNTHSEG1_TOPOLOGY.length} (SynthSeg 1.0)`)
    ui('SynthSeg: rede carregada (UNet 5 níveis, 32 estruturas).', 0.06)

    const t0 = performance.now()
    const { seg, conf, volumes } = await runSynthSeg({
      tf, model, img, dims, affine, tile, overlap, flip, sigma, postprocess,
      onProgress: (msg, frac) => ui('SynthSeg: ' + msg + '.', frac)
    })
    model.dispose()
    ui(`SynthSeg: inferência concluída em ${((performance.now() - t0) / 1000).toFixed(0)} s.`, 0.97)
    self.postMessage({ cmd: 'img', img: seg, conf, volumes }, [seg.buffer, conf.buffer, volumes.buffer])
  } catch (e) {
    const msg = String((e && e.message) || e)
    const oom = /memory|alloc|texture|context lost|OOM/i.test(msg)
    ui('', -1, 'SynthSeg: ' + msg + (oom ? ' — memória insuficiente: tente a variante "memória baixa" (blocos menores) ou o backend CPU.' : ''))
  }
}
