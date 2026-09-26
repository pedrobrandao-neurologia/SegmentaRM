// fsl-prep.js — equivalentes navegador das etapas estruturais clássicas do FSL,
// portados do MorfoStudio (pedrobrandao-neurologia/MorfoStudio). Funções puras sobre
// typed arrays, usadas pelo preprocess.worker (espaço nativo) e pelo mask.worker
// (espaço conformado). Ver README, seção "Pré-processamento estilo FSL".
//
//  • reorientToRAS  ≈ fslreorient2std — permutação/flip de eixos pela affine, SEM reamostrar.
//    (A conformação do NiiVue já reorienta implicitamente ao reamostrar para 256³; esta etapa
//    torna a orientação canônica explícita e testável no espaço NATIVO, antes do restante.)
//  • cropNeck       ≈ robustfov — heurística no perfil de intensidade do eixo inferior-superior:
//    localiza o topo da cabeça e mantém `keepMM` (170 mm, o default do robustfov) para baixo.
//  • maskCleanup    ≈ limpeza pós-BET — limiar de probabilidade (análogo ao -f), fechamento
//    morfológico, maior componente conexo e preenchimento de cavidades.

const NB6 = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]

/** limiar de Otsu sobre o histograma de 256 caixas (usado pelo recorte de pescoço) */
export function otsuThreshold (img) {
  let mx = -Infinity, mn = Infinity
  for (let i = 0; i < img.length; i++) { const v = img[i]; if (v > mx) mx = v; if (v < mn) mn = v }
  const nb = 256, hist = new Float64Array(nb)
  const sc = (nb - 1) / (mx - mn || 1)
  for (let i = 0; i < img.length; i++) hist[Math.round((img[i] - mn) * sc)]++
  const total = img.length
  let sumAll = 0
  for (let b = 0; b < nb; b++) sumAll += b * hist[b]
  let wB = 0, sumB = 0, best = 0, thr = 0
  for (let b = 0; b < nb; b++) {
    wB += hist[b]; if (wB === 0) continue
    const wF = total - wB; if (wF === 0) break
    sumB += b * hist[b]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = b }
  }
  return mn + thr / sc
}

// ---------------------------------------------------------------- reorientação canônica (≈ fslreorient2std)
/**
 * Reordena eixos/flips para orientação RAS a partir da affine, sem reamostrar.
 * @param {Float32Array} img
 * @param {number[]} dims [nx,ny,nz]
 * @param {number[]} pixdims
 * @param {number[]} affine 16 valores row-major voxel→mm RAS
 * @returns {{img, dims, pixdims, affine, applied, orientation, log}}
 */
export function reorientToRAS (img, dims, pixdims, affine) {
  const a = affine
  // coluna j da affine = direção no mundo do eixo de voxel j, NORMALIZADA (cosseno
  // diretor): sem normalizar, num exame oblíquo com voxel anisotrópico (FLAIR
  // 0,34×0,34×3,6 mm) o eixo de 3,6 mm "vencia" o eixo y só por ser mais longo
  const col = (j) => {
    const v = [a[j], a[4 + j], a[8 + j]]
    const n = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / n, v[1] / n, v[2] / n]
  }
  const srcAxis = [-1, -1, -1] // srcAxis[i] = eixo de voxel que domina o eixo de mundo i
  const sign = [1, 1, 1]
  const used = new Set()
  for (const i of [0, 1, 2]) {
    let best = -1, bestAbs = -1
    for (let j = 0; j < 3; j++) {
      if (used.has(j)) continue
      const v = Math.abs(col(j)[i])
      if (v > bestAbs) { bestAbs = v; best = j }
    }
    srcAxis[i] = best; used.add(best)
    sign[i] = col(best)[i] >= 0 ? 1 : -1
  }
  const identity = srcAxis[0] === 0 && srcAxis[1] === 1 && srcAxis[2] === 2 && sign.every((s) => s === 1)
  const axisNames = ['x', 'y', 'z']
  const orientation = srcAxis.map((j, i) => `${sign[i] > 0 ? '+' : '-'}${axisNames[j]}`).join('')
  if (identity) return { img, dims, pixdims, affine, applied: false, orientation, log: 'já em RAS' }
  const [nx, ny] = dims
  const nd = [dims[srcAxis[0]], dims[srcAxis[1]], dims[srcAxis[2]]]
  const np = [pixdims[srcAxis[0]], pixdims[srcAxis[1]], pixdims[srcAxis[2]]]
  const out = new Float32Array(img.length)
  const stride = [1, nx, nx * ny]
  // novo índice (i0,i1,i2) → antigo: old[srcAxis[k]] = sign[k]>0 ? ik : nd[k]-1-ik
  const s0 = stride[srcAxis[0]], s1 = stride[srcAxis[1]], s2 = stride[srcAxis[2]]
  for (let i2 = 0; i2 < nd[2]; i2++) {
    const o2 = (sign[2] > 0 ? i2 : nd[2] - 1 - i2) * s2
    for (let i1 = 0; i1 < nd[1]; i1++) {
      const o1 = (sign[1] > 0 ? i1 : nd[1] - 1 - i1) * s1
      const rowOut = (i1 + i2 * nd[1]) * nd[0]
      for (let i0 = 0; i0 < nd[0]; i0++) {
        out[rowOut + i0] = img[(sign[0] > 0 ? i0 : nd[0] - 1 - i0) * s0 + o1 + o2]
      }
    }
  }
  // affine nova: coluna k = sign[k] × coluna srcAxis[k]; origem desloca quando há flip
  const A = new Array(16).fill(0); A[15] = 1
  for (let r = 0; r < 3; r++) {
    let orig = a[r * 4 + 3]
    for (let k = 0; k < 3; k++) {
      const j = srcAxis[k]
      A[r * 4 + k] = sign[k] * a[r * 4 + j]
      if (sign[k] < 0) orig += a[r * 4 + j] * (nd[k] - 1)
    }
    A[r * 4 + 3] = orig
  }
  return {
    img: out, dims: nd, pixdims: np, affine: A, applied: true, orientation,
    log: `reorientado para RAS (era ${orientation})`
  }
}

// ---------------------------------------------------------------- recorte de pescoço (≈ robustfov)
/**
 * Corta FOV inferior excessivo. Detecta pela affine qual eixo/direção é superior (S),
 * então funciona antes ou depois da reorientação.
 * @param {object} p {img, dims, pixdims, affine, keepMM=170, minAreaMM2=600}
 * @returns {{img, dims, affine, applied, removedSlices, removedMM, log}}
 */
export function cropNeck ({ img, dims, pixdims, affine, keepMM = 170, minAreaMM2 = 600 }) {
  const a = affine
  // eixo de voxel com maior componente no eixo S-I do mundo (linha 2 da affine)
  let axis = 0, bestAbs = -1
  // pelo cosseno diretor (coluna normalizada): voxel anisotrópico não pode decidir o eixo
  for (let j = 0; j < 3; j++) { const v = Math.abs(a[8 + j]) / (Math.hypot(a[j], a[4 + j], a[8 + j]) || 1); if (v > bestAbs) { bestAbs = v; axis = j } }
  const up = a[8 + axis] >= 0 ? 1 : -1 // índice cresce para superior?
  const n = dims[axis]
  const thr = otsuThreshold(img)
  const [nx, ny] = [dims[0], dims[1]]
  // área de primeiro plano por corte "axial" (perpendicular ao eixo S-I)
  const area = new Float64Array(n)
  for (let z = 0; z < dims[2]; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const v = img[x + y * nx + z * nx * ny]
    if (v <= thr) continue
    area[axis === 0 ? x : axis === 1 ? y : z]++
  }
  const sliceAreaMM2 = (dims[(axis + 1) % 3] * dims[(axis + 2) % 3] > 0)
    ? pixdims[(axis + 1) % 3] * pixdims[(axis + 2) % 3]
    : 1
  const minVox = minAreaMM2 / sliceAreaMM2
  // topo da cabeça: corte mais superior com área substancial
  let top = -1
  if (up > 0) { for (let s = n - 1; s >= 0; s--) if (area[s] >= minVox) { top = s; break } }
  else { for (let s = 0; s < n; s++) if (area[s] >= minVox) { top = s; break } }
  if (top < 0) return { img, dims, affine, applied: false, removedSlices: 0, removedMM: 0, log: 'recorte: sem primeiro plano detectável' }
  const keepSlices = Math.ceil(keepMM / pixdims[axis])
  // faixa mantida: do topo para baixo keepSlices
  let lo, hi // [lo, hi] inclusivo no eixo
  if (up > 0) { hi = top; lo = Math.max(0, top - keepSlices + 1) }
  else { lo = top; hi = Math.min(n - 1, top + keepSlices - 1) }
  const removed = n - (hi - lo + 1)
  if (removed <= 0) return { img, dims, affine, applied: false, removedSlices: 0, removedMM: 0, log: 'recorte: FOV já dentro de ' + keepMM + ' mm' }
  const nd = [...dims]; nd[axis] = hi - lo + 1
  const out = new Float32Array(nd[0] * nd[1] * nd[2])
  const src = (x, y, z) => img[x + y * nx + z * nx * ny]
  for (let z = 0; z < nd[2]; z++) for (let y = 0; y < nd[1]; y++) for (let x = 0; x < nd[0]; x++) {
    const c = [x, y, z]; c[axis] += lo
    out[x + y * nd[0] + z * nd[0] * nd[1]] = src(c[0], c[1], c[2])
  }
  // origem: soma lo × coluna do eixo
  const A = [...a]
  for (let r = 0; r < 3; r++) A[r * 4 + 3] += a[r * 4 + axis] * lo
  const removedMM = removed * pixdims[axis]
  return {
    img: out, dims: nd, affine: A, applied: true, removedSlices: removed, removedMM,
    log: `recorte de pescoço: ${removed} cortes (${removedMM.toFixed(0)} mm) removidos no eixo ${'xyz'[axis]} (mantidos ${keepMM} mm do topo)`
  }
}

// ---------------------------------------------------------------- morfologia p/ limpeza de máscara (≈ pós-BET)
export function dilate6 (mask, dims) {
  const [nx, ny, nz] = dims
  const out = Uint8Array.from(mask)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny
    if (mask[i]) continue
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
      if (mask[X + Y * nx + Z * nx * ny]) { out[i] = 1; break }
    }
  }
  return out
}
export function erode6 (mask, dims) {
  const [nx, ny, nz] = dims
  const out = Uint8Array.from(mask)
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + y * nx + z * nx * ny
    if (!mask[i]) continue
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || !mask[X + Y * nx + Z * nx * ny]) { out[i] = 0; break }
    }
  }
  return out
}

/** maior componente 26-conexo, in-place; devolve nº de componentes removidos */
export function largestComponent (mask, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const comp = new Int32Array(n).fill(-1)
  const stack = new Int32Array(n)
  let best = -1, bestSize = 0, nComp = 0
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || comp[seed] >= 0) continue
    let top = 0, size = 0
    stack[top++] = seed; comp[seed] = nComp
    while (top) {
      const idx = stack[--top]; size++
      const z = (idx / (nx * ny)) | 0, y = ((idx / nx) | 0) % ny, x = idx % nx
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const X = x + dx, Y = y + dy, Z = z + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
        const j = X + Y * nx + Z * nx * ny
        if (mask[j] && comp[j] < 0) { comp[j] = nComp; stack[top++] = j }
      }
    }
    if (size > bestSize) { bestSize = size; best = nComp }
    nComp++
  }
  if (nComp > 1) for (let i = 0; i < n; i++) if (mask[i] && comp[i] !== best) mask[i] = 0
  return Math.max(0, nComp - 1)
}

/** preenche cavidades internas (componentes 6-viz do fundo que não tocam a borda), in-place */
export function fillCavities (mask, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const outside = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (x, y, z) => {
    const i = x + y * nx + z * nx * ny
    if (!mask[i] && !outside[i]) { outside[i] = 1; stack[top++] = i }
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { push(x, y, 0); push(x, y, nz - 1) }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { push(x, 0, z); push(x, ny - 1, z) }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) { push(0, y, z); push(nx - 1, y, z) }
  while (top) {
    const idx = stack[--top]
    const z = (idx / (nx * ny)) | 0, y = ((idx / nx) | 0) % ny, x = idx % nx
    for (const [dx, dy, dz] of NB6) {
      const X = x + dx, Y = y + dy, Z = z + dz
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
      const j = X + Y * nx + Z * nx * ny
      if (!mask[j] && !outside[j]) { outside[j] = 1; stack[top++] = j }
    }
  }
  let filled = 0
  for (let i = 0; i < n; i++) if (!mask[i] && !outside[i]) { mask[i] = 1; filled++ }
  return filled
}

/**
 * Limpeza da máscara cerebral a partir do mapa de probabilidade (0–255).
 * @param {Uint8Array} prob
 * @param {number[]} dims
 * @param {number} f limiar 0–1 (análogo ao -f do BET; maior = máscara menor)
 * @returns {{mask: Uint8Array, voxels, removedComponents, cavitiesFilled, log}}
 */
export function maskCleanup (prob, dims, f = 0.5) {
  // entrada binária 0/1 (caminho do worker que ignora isScalar e devolve argmax):
  // escala para 0/255 para que o limiar f continue significando "probabilidade"
  let mx = 0
  for (let i = 0; i < prob.length; i++) if (prob[i] > mx) mx = prob[i]
  const scale = mx > 0 && mx <= 1 ? 255 : 1
  const thr = Math.round(Math.max(0.02, Math.min(0.98, f)) * 255)
  let mask = new Uint8Array(prob.length)
  for (let i = 0; i < prob.length; i++) mask[i] = prob[i] * scale >= thr ? 1 : 0
  // fechamento (raio 1, 6-viz) + maior componente + cavidades
  mask = erode6(dilate6(mask, dims), dims)
  const removedComponents = largestComponent(mask, dims)
  const cavitiesFilled = fillCavities(mask, dims)
  let voxels = 0
  for (let i = 0; i < mask.length; i++) if (mask[i]) voxels++
  return {
    mask, voxels, removedComponents, cavitiesFilled,
    log: `máscara: limiar f=${f}, fechamento, ${removedComponents} componentes removidos, ${cavitiesFilled} voxels de cavidade preenchidos → ${voxels} voxels`
  }
}

/** normalização robusta de intensidade dentro da máscara: [p2, p98] → [0, 255] (só onde mask=1) */
export function normalizeWithinMask (img, mask) {
  const vals = []
  for (let i = 0; i < img.length; i++) if (mask[i]) vals.push(img[i])
  if (vals.length < 100) return { img, applied: false, log: 'normalização: máscara insuficiente' }
  const sorted = Float32Array.from(vals).sort()
  const p2 = sorted[Math.floor(0.02 * (sorted.length - 1))]
  const p98 = sorted[Math.floor(0.98 * (sorted.length - 1))]
  if (!(p98 > p2)) return { img, applied: false, log: 'normalização: faixa degenerada' }
  const out = new Uint8Array(img.length)
  const sc = 255 / (p98 - p2)
  for (let i = 0; i < img.length; i++) {
    if (!mask[i]) continue
    const v = (img[i] - p2) * sc
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
  }
  return { img: out, applied: true, p2, p98, log: `normalização na máscara: [${p2}, ${p98}] → [0, 255]` }
}

// ---------------------------------------------------------------- reamostragem e campo de viés (preprocess.worker)
function catmullRom (p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

/** reamostra um eixo por interpolação cúbica separável (Catmull-Rom; média em janela ao reduzir) */
export function resampleAxis (src, dims, axis, newN) {
  const [nx, ny] = dims
  const outDims = dims.slice()
  outDims[axis] = newN
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2])
  const n = dims[axis]
  const scale = n / newN
  const strides = [1, nx, nx * ny]
  const oStrides = [1, outDims[0], outDims[0] * outDims[1]]
  const oAxes = [0, 1, 2].filter(a => a !== axis)
  const nA = outDims[oAxes[0]], nB = outDims[oAxes[1]]
  const sAx = strides[axis]
  for (let b = 0; b < nB; b++) {
    for (let a = 0; a < nA; a++) {
      const baseIn = a * strides[oAxes[0]] + b * strides[oAxes[1]]
      const baseOut = a * oStrides[oAxes[0]] + b * oStrides[oAxes[1]]
      const c = (ii) => src[baseIn + (ii < 0 ? 0 : ii > n - 1 ? n - 1 : ii) * sAx]
      for (let o = 0; o < newN; o++) {
        const x = (o + 0.5) * scale - 0.5
        const i1 = Math.floor(x)
        const t = x - i1
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

/** passa-baixa por box blur (raio em voxels), num eixo; bordas replicadas */
export function boxBlurAxis (src, dims, axis, radius) {
  if (radius < 1) return src
  const [nx, ny] = dims
  const out = new Float32Array(src.length)
  const strides = [1, nx, nx * ny]
  const n = dims[axis]
  const oAxes = [0, 1, 2].filter(a => a !== axis)
  const nA = dims[oAxes[0]], nB = dims[oAxes[1]]
  const w = 2 * radius + 1
  const s = strides[axis]
  for (let b = 0; b < nB; b++) {
    for (let a = 0; a < nA; a++) {
      const base = a * strides[oAxes[0]] + b * strides[oAxes[1]]
      let acc = 0
      for (let i = -radius; i <= radius; i++) acc += src[base + Math.max(0, Math.min(n - 1, i)) * s]
      for (let o = 0; o < n; o++) {
        out[base + o * s] = acc / w
        const iAdd = Math.min(n - 1, o + radius + 1)
        const iSub = Math.max(0, o - radius)
        acc += src[base + iAdd * s] - src[base + iSub * s]
      }
    }
  }
  return out
}

/** aproximação gaussiana por box blurs repetidos; `radius` escalar ou [rx, ry, rz] em voxels */
export function gaussianish (src, dims, radius, passes = 3) {
  const r = Array.isArray(radius) ? radius : [radius, radius, radius]
  let cur = src
  for (let p = 0; p < passes; p++) {
    for (let ax = 0; ax < 3; ax++) cur = boxBlurAxis(cur, dims, ax, r[ax])
  }
  return cur
}

/**
 * ALTERNATIVA (fallback) — a correção de viés padrão é o N4 (lib/n4.js, Tustison 2010);
 * esta só roda no preprocess.worker se o N4 falhar, e fica declarada na proveniência.
 * Correção homomórfica de viés: campo = passa-baixa do log da intensidade, estimado
 * por convolução NORMALIZADA só no tecido (Σ w·log I·m / Σ w·m) — o fundo não entra,
 * então o campo não despenca na borda da cabeça (o que clareava o córtex periférico).
 * O raio é em mm (≈ 10% do menor FOV, mín. 12 mm) e convertido por eixo — em voxels
 * fixos, um exame 0,5×0,5×5 mm recebia um "campo" de 2 mm no plano, que apagava o
 * contraste substância cinzenta/branca.
 * @param {Float32Array} data
 * @param {number[]} dims
 * @param {number[]} [pixDims] mm por eixo (padrão 1)
 */
export function biasCorrect (data, dims, pixDims = [1, 1, 1]) {
  const n = data.length
  const pix = pixDims.map(p => Math.abs(p) || 1)
  let max = 0
  for (let i = 0; i < n; i++) if (data[i] > max) max = data[i]
  const thr = max * 0.05
  const minFovMM = Math.min(dims[0] * pix[0], dims[1] * pix[1], dims[2] * pix[2])
  const radiusMM = Math.max(12, Math.round(minFovMM / 10))
  const radius = pix.map((p, a) => Math.max(1, Math.min(dims[a] - 1, Math.round(radiusMM / p))))
  const logm = new Float32Array(n)
  const m = new Float32Array(n)
  let lsum = 0, lcount = 0
  for (let i = 0; i < n; i++) {
    if (data[i] > thr) { const l = Math.log(data[i]); logm[i] = l; m[i] = 1; lsum += l; lcount++ }
  }
  const lmean = lcount ? lsum / lcount : 0
  const num = gaussianish(logm, dims, radius, 2)
  const den = gaussianish(m, dims, radius, 2)
  // média do campo dentro do tecido, para preservar a escala global
  const field = num // reaproveita o buffer
  let fsum = 0
  for (let i = 0; i < n; i++) {
    field[i] = den[i] > 1e-3 ? num[i] / den[i] : lmean
    if (m[i]) fsum += field[i]
  }
  const fmean = lcount ? fsum / lcount : 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = data[i] > 0 ? data[i] * Math.exp(fmean - field[i]) : 0
  return { data: out, radius, radiusMM }
}
