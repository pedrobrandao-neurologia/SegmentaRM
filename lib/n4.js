// n4.js — correção de campo de viés N4 (Tustison et al., "N4ITK: Improved N3 Bias
// Correction", IEEE TMI 29(6):1310–1320, 2010), portada do algoritmo do
// itk::N4BiasFieldCorrectionImageFilter (o N4BiasFieldCorrection do ANTs). Função pura
// sobre typed arrays, sem dependências — roda no preprocess.worker, 100% no navegador.
//
// Algoritmo (idêntico ao ITK, salvo onde indicado em "Diferenças"):
//  1. redução (shrink) da imagem e da máscara por subamostragem (ShrinkImageFilter);
//  2. máscara de cabeça/tecido: limiar de Otsu na imagem reduzida (se nenhuma é dada);
//  3. no domínio log, v = log I − log B; a cada iteração:
//     a) "sharpening" do histograma de v (200 caixas, splat linear): deconvolução de
//        Wiener do histograma por uma gaussiana de FWHM 0,15 (no log) com ruído 0,01,
//        via FFT; mapeamento E[u|v] e reatribuição de cada voxel (SharpenImage);
//     b) resíduo r = v − E[u|v]; ajuste de uma B-spline cúbica ao resíduo pelo
//        algoritmo BA de Lee et al. (BSplineScatteredDataPointSetToImageFilter, 1 nível)
//        e soma à malha de pontos de controle acumulada (log B += ajuste);
//     c) convergência = CV de exp(Δ log B) na máscara (CalculateConvergenceMeasurement);
//  4. multi-resolução: a cada nível a malha acumulada é refinada EXATAMENTE (subdivisão
//     de B-spline cúbica, RefineControlPointLattice) — malha dobra, campo inalterado;
//  5. o campo final é avaliado pela malha na grade INTEIRA (resolução original) e a
//     imagem é dividida por ele.
//
// Diferenças (documentadas) em relação ao ANTs/ITK:
//  • shrink por eixo em mm: fator_a = round(shrinkFactor · 1 mm / voxel_a) — num exame
//    ~1 mm isotrópico dá o shrink 4 do ANTs; em voxel anisotrópico (FLAIR 0,34×0,34×3,6 mm)
//    mantém a imagem reduzida ~4 mm isotrópica em vez de reduzir 4× os cortes espessos;
//  • nº de elementos da malha inicial por eixo = ceil(extensão_mm / splineDistanceMM)
//    (como o `-b [200]` do ANTs), mas sem o preenchimento (pad) da imagem que o ANTs
//    faz; o domínio paramétrico é a grade original inteira (todos os voxels caem nele);
//  • o campo final é normalizado para média geométrica 1 dentro da máscara (preserva a
//    escala global de intensidade; o ITK deixa a média do campo livre).

const LN2 = Math.log(2)

/** FFT complexa radix-2 in-place (n potência de 2); inverse=true → sem normalização */
function fft (re, im, inverse) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr; im[b] = im[a] - xi
        re[a] += xr; im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr; cr = t
      }
    }
  }
}

/**
 * Sharpening do histograma (itk N4 › SharpenImage). Recebe os valores log na máscara e
 * devolve, em `out`, E[u|v] para cada um. Parâmetros como no ITK.
 */
function sharpen (v, out, nBins, fwhm, wienerNoise) {
  const M = v.length
  let binMin = Infinity, binMax = -Infinity
  for (let i = 0; i < M; i++) { const x = v[i]; if (x < binMin) binMin = x; if (x > binMax) binMax = x }
  const slope = (binMax - binMin) / (nBins - 1)
  if (!(slope > 0)) { out.set(v); return }
  const H = new Float64Array(nBins)
  for (let i = 0; i < M; i++) {
    const c = (v[i] - binMin) / slope
    const idx = Math.floor(c)
    const off = c - idx
    if (off === 0) H[idx] += 1
    else if (idx < nBins - 1) { H[idx] += 1 - off; H[idx + 1] += off }
  }
  // tamanho com zero-padding: 2^(ceil(log2 nBins) + 1)  (200 → 512)
  const P = 1 << (Math.ceil(Math.log2(nBins)) + 1)
  const offset = Math.floor(0.5 * (P - nBins))
  const Vr = new Float64Array(P), Vi = new Float64Array(P)
  for (let i = 0; i < nBins; i++) Vr[i + offset] = H[i]
  fft(Vr, Vi, false)
  // filtro gaussiano de FWHM (em caixas), normalizado, simétrico (circular)
  const sFWHM = fwhm / slope
  const expFactor = 4 * LN2 / (sFWHM * sFWHM)
  const scale = 2 * Math.sqrt(LN2 / Math.PI) / sFWHM
  const Fr = new Float64Array(P), Fi = new Float64Array(P)
  Fr[0] = scale
  const half = P >> 1
  for (let k = 1; k <= half; k++) {
    const g = scale * Math.exp(-k * k * expFactor)
    Fr[k] = g; Fr[P - k] = g
  }
  if (P % 2 === 0) Fr[half] = scale * Math.exp(-0.25 * P * P * expFactor)
  fft(Fr, Fi, false)
  // Wiener: G = conj(F) / (|F|² + ruído); U = G·V → espaço original, parte real ≥ 0
  const Ur = new Float64Array(P), Ui = new Float64Array(P)
  for (let k = 0; k < P; k++) {
    const a = Fr[k], b = Fi[k]
    const den = a * a + b * b + wienerNoise
    const gr = a / den, gi = -b / den
    Ur[k] = gr * Vr[k] - gi * Vi[k]
    Ui[k] = gr * Vi[k] + gi * Vr[k]
  }
  fft(Ur, Ui, true)
  for (let k = 0; k < P; k++) { Ur[k] = Math.max(Ur[k], 0); Ui[k] = 0 }
  // E[u|v] = (F ⊛ (u·U)) / (F ⊛ U)
  const Nr = new Float64Array(P), Ni = new Float64Array(P)
  for (let k = 0; k < P; k++) Nr[k] = (binMin + (k - offset) * slope) * Ur[k]
  fft(Nr, Ni, false)
  fft(Ur, Ui, false)
  for (let k = 0; k < P; k++) {
    const a = Fr[k], b = Fi[k]
    let r = Nr[k], i = Ni[k]
    Nr[k] = r * a - i * b; Ni[k] = r * b + i * a
    r = Ur[k]; i = Ui[k]
    Ur[k] = r * a - i * b; Ui[k] = r * b + i * a
  }
  fft(Nr, Ni, true)
  fft(Ur, Ui, true)
  const E = new Float64Array(nBins)
  for (let i = 0; i < nBins; i++) {
    const d = Ur[i + offset]
    E[i] = d !== 0 ? Nr[i + offset] / d : 0
  }
  for (let i = 0; i < M; i++) {
    const c = (v[i] - binMin) / slope
    const idx = Math.floor(c)
    out[i] = idx < nBins - 1 ? E[idx] + (E[idx + 1] - E[idx]) * (c - idx) : E[nBins - 1]
  }
}

/** pesos da B-spline cúbica uniforme no parâmetro t ∈ [0,1) */
function bsplineWeights (t, w, o) {
  const t2 = t * t, t3 = t2 * t, mt = 1 - t
  w[o] = mt * mt * mt / 6
  w[o + 1] = (3 * t3 - 6 * t2 + 4) / 6
  w[o + 2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6
  w[o + 3] = t3 / 6
}

/**
 * Tabela (por eixo) de vão e pesos para posições `pos` (em índice de voxel da grade
 * original) num domínio [0, nFull−1] dividido em `nMesh` elementos.
 */
function axisTable (pos, nFull, nMesh) {
  const n = pos.length
  const span = new Int32Array(n)
  const w = new Float64Array(n * 4)
  const w2 = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let u = nFull > 1 ? pos[i] / (nFull - 1) * nMesh : 0
    if (u < 0) u = 0
    if (u >= nMesh) u = nMesh - 1e-9
    const s = Math.floor(u)
    span[i] = s
    bsplineWeights(u - s, w, i * 4)
    let q = 0
    for (let k = 0; k < 4; k++) q += w[i * 4 + k] * w[i * 4 + k]
    w2[i] = q
  }
  return { span, w, w2 }
}

/** refinamento exato de uma malha cúbica ao longo de um eixo (malha n → 2n elementos) */
function refineAxis (L, c, axis) {
  const nc = c.slice()
  nc[axis] = 2 * c[axis] - 3
  const out = new Float64Array(nc[0] * nc[1] * nc[2])
  const st = [1, c[0], c[0] * c[1]]
  const nst = [1, nc[0], nc[0] * nc[1]]
  const oa = [0, 1, 2].filter(a => a !== axis)
  const nA = c[oa[0]], nB = c[oa[1]]
  const ca = c[axis]
  for (let b = 0; b < nB; b++) {
    for (let a = 0; a < nA; a++) {
      const bi = a * st[oa[0]] + b * st[oa[1]]
      const bo = a * nst[oa[0]] + b * nst[oa[1]]
      const g = (j) => L[bi + j * st[axis]]
      for (let j = 0; j < ca - 1; j++) out[bo + 2 * j * nst[axis]] = 0.5 * (g(j) + g(j + 1))
      for (let j = 1; j < ca - 1; j++) out[bo + (2 * j - 1) * nst[axis]] = (g(j - 1) + 6 * g(j) + g(j + 1)) / 8
    }
  }
  return { L: out, c: nc }
}

/** limiar de Otsu robusto (faixa [mín, p99,5]) sobre valores positivos */
function robustOtsu (vals) {
  const pos = []
  for (let i = 0; i < vals.length; i++) if (vals[i] > 0 && Number.isFinite(vals[i])) pos.push(vals[i])
  if (pos.length < 100) return Infinity
  const s = Float32Array.from(pos).sort()
  const lo = s[0], hi = s[Math.floor(0.995 * (s.length - 1))]
  if (!(hi > lo)) return lo
  const nb = 256, hist = new Float64Array(nb), sc = (nb - 1) / (hi - lo)
  for (let i = 0; i < s.length; i++) hist[Math.min(nb - 1, Math.round((s[i] - lo) * sc))]++
  let sumAll = 0
  for (let b = 0; b < nb; b++) sumAll += b * hist[b]
  const total = s.length
  let wB = 0, sumB = 0, best = -1, thr = 0
  for (let b = 0; b < nb; b++) {
    wB += hist[b]; if (!wB) continue
    const wF = total - wB; if (!wF) break
    sumB += b * hist[b]
    const d = sumB / wB - (sumAll - sumB) / wF
    const between = wB * wF * d * d
    if (between > best) { best = between; thr = b }
  }
  return lo + (thr + 0.5) / sc
}

/**
 * Correção de viés N4 (Tustison 2010).
 * @param {Float32Array} data volume (x mais rápido), intensidades ≥ 0
 * @param {number[]} dims [nx, ny, nz]
 * @param {number[]} pixDims mm por eixo
 * @param {object} [o]
 * @param {number} [o.shrinkFactor=4] redução (em "voxels de 1 mm"; ver cabeçalho)
 * @param {number} [o.splineDistanceMM=200] espaçamento da malha inicial (mm)
 * @param {number[]} [o.iterations=[50,50,50,50]] iterações máximas por nível (nº de níveis = comprimento)
 * @param {number} [o.convergence=0.001] limiar de convergência (CV de exp(Δ log B))
 * @param {number} [o.bins=200] caixas do histograma
 * @param {number} [o.fwhm=0.15] FWHM da gaussiana do viés (no log)
 * @param {number} [o.wienerNoise=0.01] ruído do filtro de Wiener
 * @param {Uint8Array} [o.mask] máscara na grade original (senão: Otsu na imagem reduzida)
 * @param {boolean} [o.returnLogField=false] devolve também o log do campo na grade original
 * @param {(frac:number, txt:string) => void} [o.onProgress]
 */
export function n4BiasFieldCorrection (data, dims, pixDims = [1, 1, 1], o = {}) {
  const t0 = Date.now()
  const {
    shrinkFactor = 4, splineDistanceMM = 200, iterations = [50, 50, 50, 50],
    convergence = 0.001, bins = 200, fwhm = 0.15, wienerNoise = 0.01,
    mask = null, returnLogField = false, onProgress = null
  } = o
  const [nx, ny, nz] = dims
  const pix = pixDims.map(p => Math.abs(p) || 1)
  if (data.length !== nx * ny * nz) throw new Error('N4: dimensões inconsistentes com o volume')
  const prog = (f, t) => { if (onProgress) onProgress(Math.max(0, Math.min(1, f)), t) }

  // ---- 1. redução por subamostragem (ITK ShrinkImageFilter: amostra em o·f + round((f−1)/2))
  const sf = pix.map((p, a) => Math.max(1, Math.min(dims[a], Math.round(shrinkFactor / p))))
  const sd = dims.map((n, a) => Math.max(1, Math.floor(n / sf[a])))
  const posAxis = sd.map((n, a) => {
    const off = Math.round((sf[a] - 1) / 2)
    const p = new Float64Array(n)
    for (let i = 0; i < n; i++) p[i] = Math.min(dims[a] - 1, i * sf[a] + off)
    return p
  })
  const S = sd[0] * sd[1] * sd[2]
  const small = new Float32Array(S)
  const smallMask = mask ? new Uint8Array(S) : null
  for (let z = 0; z < sd[2]; z++) {
    const Z = posAxis[2][z]
    for (let y = 0; y < sd[1]; y++) {
      const Y = posAxis[1][y]
      for (let x = 0; x < sd[0]; x++) {
        const src = posAxis[0][x] + Y * nx + Z * nx * ny
        const d = x + y * sd[0] + z * sd[0] * sd[1]
        small[d] = data[src]
        if (smallMask) smallMask[d] = mask[src] ? 1 : 0
      }
    }
  }

  // ---- 2. máscara (Otsu robusto) e pontos da máscara
  const thr = smallMask ? 0 : robustOtsu(small)
  let M = 0
  for (let i = 0; i < S; i++) if ((smallMask ? smallMask[i] : small[i] > thr) && small[i] > 0) M++
  if (M < 500) throw new Error(`N4: máscara de tecido insuficiente (${M} voxels na imagem reduzida)`)
  const px = new Uint16Array(M), py = new Uint16Array(M), pz = new Uint16Array(M)
  const logIn = new Float64Array(M)
  {
    let k = 0
    for (let z = 0; z < sd[2]; z++) for (let y = 0; y < sd[1]; y++) for (let x = 0; x < sd[0]; x++) {
      const i = x + y * sd[0] + z * sd[0] * sd[1]
      if (!((smallMask ? smallMask[i] : small[i] > thr) && small[i] > 0)) continue
      px[k] = x; py[k] = y; pz[k] = z; logIn[k] = Math.log(small[i]); k++
    }
  }

  // ---- 3–4. iterações por nível
  const extent = dims.map((n, a) => Math.max(0, n - 1) * pix[a])
  const mesh0 = extent.map(e => Math.max(1, Math.ceil(e / splineDistanceMM)))
  let mesh = mesh0.slice()
  let c = mesh.map(m => m + 3)
  let L = new Float64Array(c[0] * c[1] * c[2]) // malha acumulada do log do campo
  const logB = new Float64Array(M) // log do campo nos pontos da máscara
  const v = new Float64Array(M)
  const sharp = new Float64Array(M)
  const dB = new Float64Array(M)
  const levels = iterations.length
  const totalIt = iterations.reduce((a, b) => a + b, 0)
  const itersDone = []
  const convByLevel = []
  let itGlobal = 0
  for (let level = 0; level < levels; level++) {
    if (level > 0) {
      for (let a = 0; a < 3; a++) { const r = refineAxis(L, c, a); L = r.L; c = r.c }
      mesh = mesh.map(m => m * 2)
    }
    const tx = axisTable(posAxis[0], nx, mesh[0])
    const ty = axisTable(posAxis[1], ny, mesh[1])
    const tz = axisTable(posAxis[2], nz, mesh[2])
    const cxy = c[0] * c[1]
    const delta = new Float64Array(L.length)
    const omega = new Float64Array(L.length)
    const phi = new Float64Array(L.length)
    let conv = Infinity, it = 0
    prog(itGlobal / totalIt, `N4 (Tustison 2010): nível ${level + 1}/${levels}, malha ${mesh.join('×')} elementos`)
    for (; it < iterations[level] && conv > convergence; it++) {
      for (let i = 0; i < M; i++) v[i] = logIn[i] - logB[i]
      sharpen(v, sharp, bins, fwhm, wienerNoise)
      // ajuste BA (Lee et al.) do resíduo v − E[u|v]
      delta.fill(0); omega.fill(0)
      for (let i = 0; i < M; i++) {
        const ix = px[i], iy = py[i], iz = pz[i]
        const sx = tx.span[ix], sy = ty.span[iy], sz = tz.span[iz]
        const rr = (v[i] - sharp[i]) / (tx.w2[ix] * ty.w2[iy] * tz.w2[iz])
        for (let cc = 0; cc < 4; cc++) {
          const wz = tz.w[iz * 4 + cc], zo = (sz + cc) * cxy
          for (let b = 0; b < 4; b++) {
            const wyz = wz * ty.w[iy * 4 + b], off = zo + (sy + b) * c[0] + sx
            for (let a = 0; a < 4; a++) {
              const w = wyz * tx.w[ix * 4 + a]
              const w2 = w * w
              delta[off + a] += w2 * w * rr
              omega[off + a] += w2
            }
          }
        }
      }
      for (let k = 0; k < phi.length; k++) phi[k] = omega[k] > 0 ? delta[k] / omega[k] : 0
      // Δ log B nos pontos; convergência = CV de exp(Δ)
      let s = 0, s2 = 0
      for (let i = 0; i < M; i++) {
        const ix = px[i], iy = py[i], iz = pz[i]
        const sx = tx.span[ix], sy = ty.span[iy], sz = tz.span[iz]
        let val = 0
        for (let cc = 0; cc < 4; cc++) {
          const wz = tz.w[iz * 4 + cc], zo = (sz + cc) * cxy
          for (let b = 0; b < 4; b++) {
            const wyz = wz * ty.w[iy * 4 + b], off = zo + (sy + b) * c[0] + sx
            val += wyz * (tx.w[ix * 4] * phi[off] + tx.w[ix * 4 + 1] * phi[off + 1] +
              tx.w[ix * 4 + 2] * phi[off + 2] + tx.w[ix * 4 + 3] * phi[off + 3])
          }
        }
        dB[i] = val
        const e = Math.exp(val)
        s += e; s2 += e * e
      }
      for (let k = 0; k < L.length; k++) L[k] += phi[k]
      for (let i = 0; i < M; i++) logB[i] += dB[i]
      const mu = s / M
      const sd2 = M > 1 ? Math.max(0, (s2 - M * mu * mu) / (M - 1)) : 0
      conv = Math.sqrt(sd2) / mu
      if (!Number.isFinite(conv)) throw new Error('N4: divergência numérica (campo não finito)')
      itGlobal++
      if (it % 25 === 24) prog(itGlobal / totalIt, `N4 (Tustison 2010): nível ${level + 1}/${levels}, iteração ${it + 1}, convergência ${conv.toExponential(2)}`)
    }
    itGlobal += iterations[level] - it
    itersDone.push(it)
    convByLevel.push(conv)
  }

  // média do log do campo na máscara → removida (preserva a escala global)
  let meanLog = 0
  for (let i = 0; i < M; i++) meanLog += logB[i]
  meanLog /= M

  // ---- 5. campo na grade original: avaliação separável da malha, corte a corte
  prog(0.97, 'N4 (Tustison 2010): aplicando o campo na resolução original')
  const full = (n) => { const p = new Float64Array(n); for (let i = 0; i < n; i++) p[i] = i; return p }
  const fx = axisTable(full(nx), nx, mesh[0])
  const fy = axisTable(full(ny), ny, mesh[1])
  const fz = axisTable(full(nz), nz, mesh[2])
  const out = new Float32Array(data.length)
  const logField = returnLogField ? new Float32Array(data.length) : null
  const cxy = c[0] * c[1]
  const Az = new Float64Array(cxy)
  const Ay = new Float64Array(c[0])
  let fieldMin = Infinity, fieldMax = -Infinity
  for (let z = 0; z < nz; z++) {
    Az.fill(0)
    for (let k = 0; k < 4; k++) {
      const w = fz.w[z * 4 + k], base = (fz.span[z] + k) * cxy
      for (let j = 0; j < cxy; j++) Az[j] += w * L[base + j]
    }
    for (let y = 0; y < ny; y++) {
      Ay.fill(0)
      for (let k = 0; k < 4; k++) {
        const w = fy.w[y * 4 + k], base = (fy.span[y] + k) * c[0]
        for (let j = 0; j < c[0]; j++) Ay[j] += w * Az[base + j]
      }
      const row = y * nx + z * nx * ny
      for (let x = 0; x < nx; x++) {
        const s0 = fx.span[x], w = x * 4
        const f = fx.w[w] * Ay[s0] + fx.w[w + 1] * Ay[s0 + 1] + fx.w[w + 2] * Ay[s0 + 2] + fx.w[w + 3] * Ay[s0 + 3] - meanLog
        if (f < fieldMin) fieldMin = f
        if (f > fieldMax) fieldMax = f
        out[row + x] = data[row + x] * Math.exp(-f)
        if (logField) logField[row + x] = f
      }
    }
  }
  if (!Number.isFinite(fieldMin) || !Number.isFinite(fieldMax)) throw new Error('N4: campo final não finito')
  const ms = Date.now() - t0
  const params = {
    shrink: sf, dimsReduzidas: sd, distanciaSplineMM: splineDistanceMM, malhaInicial: mesh0,
    malhaFinal: mesh, pontosControle: c, niveis: levels, iteracoesMax: iterations,
    convergencia: convergence, caixas: bins, fwhm, ruidoWiener: wienerNoise, ordemSpline: 3
  }
  return {
    data: out,
    logField,
    maskVoxelsReduced: M,
    threshold: thr,
    iterationsPerLevel: itersDone,
    convergencePerLevel: convByLevel,
    fieldRange: [Math.exp(fieldMin), Math.exp(fieldMax)],
    params,
    ms,
    log: `N4 (Tustison 2010): shrink ${sf.join('×')} → ${sd.join('×')}, ${M} voxels na máscara, ` +
      `malha ${mesh0.join('×')}→${mesh.join('×')} elementos (B-spline cúbica), iterações ${itersDone.join('/')} ` +
      `(convergência final ${convByLevel[levels - 1].toExponential(2)}), campo ${Math.exp(fieldMin).toFixed(2)}–${Math.exp(fieldMax).toFixed(2)}, ${(ms / 1000).toFixed(1)} s`
  }
}
