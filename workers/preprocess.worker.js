// Pré-processamento no espaço NATIVO, antes da conformação — nesta ordem:
//  1. reorientação canônica RAS (≈ fslreorient2std) — permuta/flip pela affine, sem reamostrar
//  2. recorte de pescoço (≈ robustfov) — heurística no perfil do eixo S-I, mantém 170 mm do topo
//  3. reamostragem cúbica Catmull-Rom dos eixos espessos para ~isotrópico (ramo robusto;
//     inspirado no papel do SynthSR dentro do recon-all-clinical, mas por métodos clássicos)
//  4. correção homomórfica de campo de viés (log → passa-baixa → divisão) — ANTES da
//     extração cerebral, para que a imagem corrigida alimente as etapas seguintes
//  5. suavização gaussiana leve (opcional)
// Mensagem de entrada: { data: Float32Array, dims:[nx,ny,nz], pixDims:[dx,dy,dz],
//                        affine: number[16] row-major, targetIso: 1.0,
//                        doReorient, doCrop, doResample, doBias, doSmooth }
// Saída: { cmd:'done', data, dims, pixDims, affine, prov } com progressos { cmd:'progress', frac, txt }

import { reorientToRAS, cropNeck } from '../lib/fsl-prep.js'

function post (frac, txt) { self.postMessage({ cmd: 'progress', frac, txt }) }

function catmullRom (p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

// reamostra um eixo por interpolação cúbica separável
function resampleAxis (src, dims, axis, newN) {
  const [nx, ny, nz] = dims
  const outDims = dims.slice()
  outDims[axis] = newN
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2])
  const n = dims[axis]
  const scale = n / newN
  const strides = [1, nx, nx * ny]
  const oStrides = [1, outDims[0], outDims[0] * outDims[1]]
  const oAxes = [0, 1, 2].filter(a => a !== axis)
  const nA = outDims[oAxes[0]], nB = outDims[oAxes[1]]
  for (let b = 0; b < nB; b++) {
    for (let a = 0; a < nA; a++) {
      const baseIn = a * strides[oAxes[0]] + b * strides[oAxes[1]]
      const baseOut = a * oStrides[oAxes[0]] + b * oStrides[oAxes[1]]
      for (let o = 0; o < newN; o++) {
        const x = (o + 0.5) * scale - 0.5
        const i1 = Math.floor(x)
        const t = x - i1
        const c = (ii) => src[baseIn + Math.max(0, Math.min(n - 1, ii)) * strides[axis]]
        let val
        if (scale <= 1.0001) {
          val = catmullRom(c(i1 - 1), c(i1), c(i1 + 1), c(i1 + 2), t)
        } else {
          // downsample: média em janela para evitar aliasing
          const lo = Math.max(0, Math.round(x - scale / 2))
          const hi = Math.min(n - 1, Math.round(x + scale / 2))
          let s = 0
          for (let ii = lo; ii <= hi; ii++) s += c(ii)
          val = s / (hi - lo + 1)
        }
        out[baseOut + o * oStrides[axis]] = val
      }
    }
  }
  return { data: out, dims: outDims }
}

// passa-baixa por box blur repetido (aprox. gaussiana), por eixo, com raio em voxels
function boxBlurAxis (src, dims, axis, radius) {
  if (radius < 1) return src
  const [nx, ny] = dims
  const out = new Float32Array(src.length)
  const strides = [1, nx, nx * ny]
  const n = dims[axis]
  const oAxes = [0, 1, 2].filter(a => a !== axis)
  const nA = dims[oAxes[0]], nB = dims[oAxes[1]]
  const w = 2 * radius + 1
  for (let b = 0; b < nB; b++) {
    for (let a = 0; a < nA; a++) {
      const base = a * strides[oAxes[0]] + b * strides[oAxes[1]]
      let acc = 0
      for (let i = -radius; i <= radius; i++) acc += src[base + Math.max(0, Math.min(n - 1, i)) * strides[axis]]
      for (let o = 0; o < n; o++) {
        out[base + o * strides[axis]] = acc / w
        const iAdd = Math.min(n - 1, o + radius + 1)
        const iSub = Math.max(0, o - radius)
        acc += src[base + iAdd * strides[axis]] - src[base + iSub * strides[axis]]
      }
    }
  }
  return out
}

function gaussianish (src, dims, radius, passes = 3) {
  let cur = src
  for (let p = 0; p < passes; p++) {
    for (let ax = 0; ax < 3; ax++) cur = boxBlurAxis(cur, dims, ax, radius)
  }
  return cur
}

// correção homomórfica: divide pela estimativa suave do campo em log-espaço
function biasCorrect (data, dims) {
  const n = data.length
  const eps = 1e-3
  // limiar simples para considerar só tecido (evita que o fundo puxe o campo)
  let max = 0
  for (let i = 0; i < n; i++) if (data[i] > max) max = data[i]
  const thr = max * 0.05
  const logv = new Float32Array(n)
  for (let i = 0; i < n; i++) logv[i] = Math.log(Math.max(data[i], thr * 0.5) + eps)
  const radius = Math.max(4, Math.round(Math.min(...dims) / 10))
  const field = gaussianish(logv, dims, radius, 2)
  // média do campo dentro do tecido, para preservar a escala global
  let fsum = 0, fcount = 0
  for (let i = 0; i < n; i++) if (data[i] > thr) { fsum += field[i]; fcount++ }
  const fmean = fcount ? fsum / fcount : 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = data[i] > 0 ? data[i] * Math.exp(fmean - field[i]) : 0
  }
  return { data: out, radius }
}

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
      const b = biasCorrect(cur, curDims)
      cur = b.data
      prov.vies = { aplicado: true, metodo: 'homomorfico', raioVoxels: b.radius }
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
