// Pré-processamento no espaço NATIVO, antes da conformação — nesta ordem:
//  1. reorientação canônica RAS (≈ fslreorient2std) — permuta/flip pela affine, sem reamostrar
//  2. recorte de pescoço (≈ robustfov) — heurística no perfil do eixo S-I, mantém 170 mm do topo
//  3. reamostragem cúbica Catmull-Rom dos eixos espessos para ~isotrópico (ramo robusto;
//     inspirado no papel do SynthSR dentro do recon-all-clinical, mas por métodos clássicos)
//  4. correção de campo de viés N4 (Tustison et al., IEEE TMI 2010 — o algoritmo do
//     N4BiasFieldCorrection do ANTs/ITK, em lib/n4.js: sharpening do histograma do log por
//     deconvolução de Wiener + ajuste B-spline cúbico multi-resolução numa versão reduzida,
//     campo aplicado na grade inteira) — ANTES da extração cerebral, para que a imagem
//     corrigida alimente as etapas seguintes. Se o N4 falhar, cai na correção homomórfica
//     (lib/fsl-prep.js › biasCorrect), declarada na proveniência (prov.vies.fallback)
//  5. suavização gaussiana leve (opcional)
// Mensagem de entrada: { data: Float32Array, dims:[nx,ny,nz], pixDims:[dx,dy,dz],
//                        affine: number[16] row-major, targetIso: 1.0,
//                        doReorient, doCrop, doResample, doBias, doSmooth }
// Saída: { cmd:'done', data, dims, pixDims, affine, prov } com progressos { cmd:'progress', frac, txt }

import { reorientToRAS, cropNeck, resampleAxis, biasCorrect, gaussianish } from '../lib/fsl-prep.js'
import { n4BiasFieldCorrection } from '../lib/n4.js'

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
      post(0.68, 'Correção de campo de viés — N4 (Tustison 2010), antes da extração cerebral')
      try {
        const r = n4BiasFieldCorrection(cur, curDims, curPix, {
          shrinkFactor: 4, splineDistanceMM: 200, iterations: [50, 50, 50, 50], convergence: 0.001,
          bins: 200, fwhm: 0.15, wienerNoise: 0.01,
          onProgress: (f, txt) => post(0.68 + 0.16 * f, txt)
        })
        cur = r.data
        post(0.84, '· ' + r.log)
        prov.vies = {
          aplicado: true,
          metodo: 'N4 (Tustison et al., IEEE TMI 2010) — algoritmo do N4BiasFieldCorrection (ANTs/ITK)',
          fallback: false,
          parametros: r.params,
          iteracoesPorNivel: r.iterationsPerLevel,
          convergenciaPorNivel: r.convergencePerLevel.map(c => Number(c.toPrecision(3))),
          faixaCampo: r.fieldRange.map(v => Number(v.toFixed(3))),
          voxelsMascaraReduzida: r.maskVoxelsReduced,
          tempoS: Number((r.ms / 1000).toFixed(1))
        }
      } catch (e) {
        const motivo = String(e && e.message || e)
        post(0.72, `N4 (Tustison 2010) falhou (${motivo}) — usando a correção homomórfica como alternativa`)
        const b = biasCorrect(cur, curDims, curPix)
        cur = b.data
        prov.vies = {
          aplicado: true,
          metodo: 'homomórfico (convolução normalizada no tecido) — alternativa após falha do N4',
          fallback: true, motivoFallback: motivo, raioMM: b.radiusMM, raioVoxels: b.radius
        }
      }
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
