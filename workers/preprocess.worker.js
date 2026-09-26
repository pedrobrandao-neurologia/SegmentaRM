// Pré-processamento no espaço NATIVO, antes da conformação — nesta ordem:
//  1. reorientação canônica RAS (≈ fslreorient2std) — permuta/flip pela affine, sem reamostrar
//  2. recorte de pescoço (≈ robustfov) — heurística no perfil do eixo S-I, mantém 170 mm do topo
//  3. reamostragem cúbica Catmull-Rom dos eixos espessos para ~isotrópico (ramo robusto;
//     inspirado no papel do SynthSR dentro do recon-all-clinical, mas por métodos clássicos)
//  4. correção homomórfica de campo de viés (log → passa-baixa normalizada no tecido →
//     divisão; raio em mm) — ANTES da extração cerebral, para que a imagem corrigida
//     alimente as etapas seguintes
//  5. suavização gaussiana leve (opcional)
// Mensagem de entrada: { data: Float32Array, dims:[nx,ny,nz], pixDims:[dx,dy,dz],
//                        affine: number[16] row-major, targetIso: 1.0,
//                        doReorient, doCrop, doResample, doBias, doSmooth }
// Saída: { cmd:'done', data, dims, pixDims, affine, prov } com progressos { cmd:'progress', frac, txt }

import { reorientToRAS, cropNeck, resampleAxis, biasCorrect, gaussianish } from '../lib/fsl-prep.js'

function post (frac, txt) { self.postMessage({ cmd: 'progress', frac, txt }) }

self.onmessage = (ev) => {
  try {
    const {
      data, dims, pixDims, affine = null, targetIso = 1.0,
      doReorient = false, doCrop = false, doResample = true, doBias = true, doSmooth = false
    } = ev.data
    let cur = data instanceof Float32Array ? data : new Float32Array(data)
    let curDims = dims.slice()
    let curPix = pixDims.map(Math.abs)
    let curAff = affine ? affine.slice() : null
    const prov = {}

    if (doReorient && curAff) {
      post(0.03, 'Reorientação canônica RAS (≈ fslreorient2std)')
      const r = reorientToRAS(cur, curDims, curPix, curAff)
      prov.reorientacao = { aplicada: r.applied, orientacaoOriginal: r.orientation }
      if (r.applied) post(0.06, '· ' + r.log)
      cur = r.img; curDims = r.dims.slice(); curPix = r.pixdims.slice(); curAff = r.affine
    }

    if (doCrop && curAff) {
      post(0.08, 'Recorte de pescoço (≈ robustfov, 170 mm do topo)')
      const c = cropNeck({ img: cur, dims: curDims, pixdims: curPix, affine: curAff })
      prov.recortePescoco = { aplicado: c.applied, cortesRemovidos: c.removedSlices, mmRemovidos: Math.round(c.removedMM) }
      post(0.12, '· ' + c.log)
      cur = c.img; curDims = c.dims.slice(); curAff = c.affine
    }

    if (doResample) {
      post(0.15, 'Analisando a grade de voxels')
      // reamostra cada eixo cujo espaçamento excede o alvo em mais de 20%
      for (let ax = 0; ax < 3; ax++) {
        if (curPix[ax] > targetIso * 1.2) {
          const newN = Math.max(8, Math.round(curDims[ax] * curPix[ax] / targetIso))
          post(0.2 + ax * 0.15, `Reamostrando eixo ${['x', 'y', 'z'][ax]}: ${curDims[ax]} → ${newN} cortes (cúbica Catmull-Rom)`)
          const oldN = curDims[ax]
          const r = resampleAxis(cur, curDims, ax, newN)
          cur = r.data
          curDims = r.dims
          const scale = oldN / newN
          curPix[ax] = curPix[ax] * scale
          if (curAff) {
            // coluna escala pela razão; origem desloca meio voxel
            for (let row = 0; row < 3; row++) {
              curAff[row * 4 + 3] += curAff[row * 4 + ax] * (0.5 * scale - 0.5)
              curAff[row * 4 + ax] *= scale
            }
          }
          prov.reamostragem = prov.reamostragem || []
          prov.reamostragem.push({ eixo: 'xyz'[ax], de: oldN, para: newN })
        }
      }
    }

    if (doBias) {
      post(0.68, 'Correção homomórfica de campo de viés (antes da extração cerebral)')
      const b = biasCorrect(cur, curDims, curPix)
      cur = b.data
      prov.vies = { aplicado: true, metodo: 'homomorfico (convolução normalizada no tecido)', raioMM: b.radiusMM, raioVoxels: b.radius }
    }
    if (doSmooth) {
      post(0.85, 'Suavização leve')
      cur = gaussianish(cur, curDims, 1, 1)
      prov.suavizacao = { aplicada: true }
    }
    post(0.95, 'Pré-processamento concluído')
    self.postMessage({ cmd: 'done', data: cur, dims: curDims, pixDims: curPix, affine: curAff, prov }, [cur.buffer])
  } catch (e) {
    self.postMessage({ cmd: 'error', message: String(e && e.message || e) })
  }
}
