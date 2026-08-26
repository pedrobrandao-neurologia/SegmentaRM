// Worker de segmentação SynthSeg 1.0 (rede original de Billot/Iglesias, Apache 2.0,
// convertida para TensorFlow.js). Recebe o volume conformado 256³ · 1 mm e devolve
// o mapa de rótulos (índice do canal, 0–31) na mesma ordem de voxels.
// Mensagem: { modelUrl, img (Uint8Array), dims, affine, isGPU, tile, overlap }

import * as tf from '../vendor/tf.fesm.min.js'
import { registerUpSampling3D } from '../lib/tfjs-upsampling3d.js'
import { rasOrientation, toRAS, fromRAS, robustRescale, boundingBox, tiledSegment } from '../lib/synthseg-core.js'

function ui (message, progressFrac = -1, modalMessage = '') {
  self.postMessage({ cmd: 'ui', message, progressFrac, modalMessage })
}

self.onmessage = async (ev) => {
  const { modelUrl, img, dims, affine, isGPU = true, tile = 96, overlap = 32 } = ev.data
  try {
    registerUpSampling3D(tf)
    if (isGPU && typeof OffscreenCanvas !== 'undefined') {
      try { await tf.setBackend('webgl') } catch { await tf.setBackend('cpu') }
    } else {
      await tf.setBackend('cpu')
    }
    await tf.enableProdMode()
    await tf.ready()
    ui(`SynthSeg: backend ${tf.getBackend()}, baixando/carregando a rede…`, 0.02)
    const model = await tf.loadLayersModel(modelUrl)
    ui('SynthSeg: rede carregada (UNet 5 níveis, 32 estruturas).', 0.06)

    // pré-processamento fiel ao predict.py: RAS + rescale robusto → [0,1]
    const orientation = rasOrientation(affine)
    const ras = toRAS(img, dims, orientation)
    const norm = robustRescale(ras.data)
    const bbox = boundingBox(norm, ras.dims)
    ui(`SynthSeg: recorte ao encéfalo ${bbox.size.join('×')} @ 1 mm, blocos de ${tile} com sobreposição ${overlap}.`, 0.08)

    // volume recortado
    const [nx, ny] = ras.dims
    const crop = new Float32Array(bbox.size[0] * bbox.size[1] * bbox.size[2])
    let v = 0
    for (let k = 0; k < bbox.size[2]; k++) {
      for (let j = 0; j < bbox.size[1]; j++) {
        const src = (bbox.min[2] + k) * nx * ny + (bbox.min[1] + j) * nx + bbox.min[0]
        crop.set(norm.subarray(src, src + bbox.size[0]), v)
        v += bbox.size[0]
      }
    }

    const t0 = performance.now()
    // o bloco chega x-mais-rápido ([z][y][x]); a rede foi treinada com [x, y, z]
    // (x no eixo mais lento, como um array do nibabel) — transpõe na entrada e na saída
    const predictTile = async (block, bdims) => {
      const [bw, bh, bd] = bdims
      const zyx = tf.tensor5d(block, [1, bd, bh, bw, 1])
      const xyz = zyx.transpose([0, 3, 2, 1, 4])
      const y = model.predict(xyz)
      const amXyz = tf.argMax(y, -1)
      const amZyx = amXyz.transpose([0, 3, 2, 1])
      // posterior máxima por voxel = confiança da rede (base do QC por grupo tecidual)
      const mxXyz = tf.max(y, -1)
      const mxZyx = mxXyz.transpose([0, 3, 2, 1])
      const [argmax, conf] = await Promise.all([amZyx.data(), mxZyx.data()])
      tf.dispose([zyx, xyz, y, amXyz, amZyx, mxXyz, mxZyx])
      return { argmax, conf }
    }
    const cropConf = new Float32Array(bbox.size[0] * bbox.size[1] * bbox.size[2])
    const cropSeg = await tiledSegment({
      data: crop,
      dims: bbox.size,
      tile,
      overlap,
      predictTile,
      confOut: cropConf,
      onProgress: (done, total) => {
        ui(`SynthSeg: bloco ${done}/${total}`, 0.08 + 0.88 * done / total)
      }
    })

    // devolve ao volume RAS cheio e depois à ordem crua da imagem conformada
    // (a confiança segue o mesmo caminho, quantizada em 0–255)
    const rasSeg = new Uint8Array(ras.dims[0] * ras.dims[1] * ras.dims[2])
    const rasConf = new Uint8Array(rasSeg.length)
    v = 0
    for (let k = 0; k < bbox.size[2]; k++) {
      for (let j = 0; j < bbox.size[1]; j++) {
        const dst = (bbox.min[2] + k) * nx * ny + (bbox.min[1] + j) * nx + bbox.min[0]
        rasSeg.set(cropSeg.subarray(v, v + bbox.size[0]), dst)
        for (let i = 0; i < bbox.size[0]; i++) {
          rasConf[dst + i] = Math.round(255 * Math.max(0, Math.min(1, cropConf[v + i])))
        }
        v += bbox.size[0]
      }
    }
    const seg = fromRAS(rasSeg, dims, orientation)
    const conf = fromRAS(rasConf, dims, orientation)
    ui(`SynthSeg: inferência concluída em ${((performance.now() - t0) / 1000).toFixed(0)} s.`, 0.97)
    self.postMessage({ cmd: 'img', img: seg, conf }, [seg.buffer, conf.buffer])
  } catch (e) {
    ui('', -1, 'SynthSeg: ' + String((e && e.message) || e))
  }
}
