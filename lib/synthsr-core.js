// synthsr-core.js — SynthSR v1.0 (Iglesias et al., Sci Adv 2023; BBillot/SynthSR,
// Apache 2.0) no navegador: sintetiza um MP-RAGE T1 1 mm isotrópico a partir de um
// exame de qualquer contraste/resolução. Réplica do predict_command_line.py oficial:
//   1. reamostrar a 1 mm e alinhar a RAS identidade (trilinear), com o filtro
//      gaussiano anti-serrilhado do resample_volume oficial (σ = 0,25/fator)
//   2. normalizar min–max para [0,1] (global, sobre o volume inteiro)
//   3. UNet de regressão (mesma família do SynthSeg) — aqui em blocos com sobreposição,
//      porque o volume inteiro não cabe na GPU do navegador (recorte central no stitching)
//   4. opcional: média com a predição do volume espelhado em L/R (test-time flipping)
//   5. saída ×255, recortada a [0,128]

/**
 * Filtro gaussiano separável IN PLACE (float), como o scipy.ndimage.gaussian_filter
 * (modo 'reflect' — meia amostra simétrica — e truncamento em 4σ).
 * @param {Float32Array} vol volume x-mais-rápido
 * @param {number[]} sigmas σ por eixo, em voxels (0 = eixo não filtrado)
 */
export function gaussianFilter3d (vol, dims, sigmas) {
  const [nx, ny, nz] = dims
  const strides = [1, nx, nx * ny]
  for (let ax = 0; ax < 3; ax++) {
    const sg = sigmas[ax]
    if (!(sg > 0)) continue
    const n = dims[ax]
    const r = Math.max(1, Math.ceil(4 * sg))
    const ker = new Float64Array(2 * r + 1)
    let ks = 0
    for (let t = -r; t <= r; t++) { ker[t + r] = Math.exp(-0.5 * (t / sg) ** 2); ks += ker[t + r] }
    for (let t = 0; t < ker.length; t++) ker[t] /= ks
    const line = new Float64Array(n)
    const st = strides[ax]
    // índice refletido (… c b a | a b c … | … c b a | a b c …)
    const refl = (q) => {
      const p = 2 * n
      q = ((q % p) + p) % p
      return q < n ? q : p - 1 - q
    }
    const others = [0, 1, 2].filter(d => d !== ax)
    const [oa, ob] = others
    for (let ib = 0; ib < dims[ob]; ib++) for (let ia = 0; ia < dims[oa]; ia++) {
      const base = ia * strides[oa] + ib * strides[ob]
      for (let q = 0; q < n; q++) line[q] = vol[base + q * st]
      for (let q = 0; q < n; q++) {
        let acc = 0
        for (let t = -r; t <= r; t++) {
          const qq = q + t
          acc += ker[t + r] * line[qq >= 0 && qq < n ? qq : refl(qq)]
        }
        vol[base + q * st] = acc
      }
    }
  }
  return vol
}

/**
 * Reamostra o volume nativo para a grade RAS 1 mm isotrópica (trilinear).
 * Antes, como o resample_volume do SynthSR, suaviza com σ = 0,25/fator voxels nos
 * eixos com voxel ≤ 1 mm (fator = tamanho do voxel / 1 mm) — sem isso, exames
 * submilimétricos entram serrilhados. Fora do campo de visão, o valor mínimo da
 * imagem (fundo), não 0: com intensidades negativas (p.ex. TC em HU) o 0 viraria
 * um tecido falso depois da normalização min–max.
 * @param {Float32Array|Uint8Array|Int16Array} img (um Float32Array é filtrado IN PLACE)
 * @param {number[]} dims [nx,ny,nz]
 * @param {number[]} affine 16 valores row-major voxel→mm RAS
 * @returns {{img: Float32Array, dims: number[], affine: number[]}} affine da grade nova
 */
export function resampleToRAS1mm (img, dims, affine) {
  const [nx, ny, nz] = dims
  const a = affine
  const pix = [0, 1, 2].map(c => Math.hypot(a[c], a[4 + c], a[8 + c]))
  const sig = pix.map(p => (p > 0 && p <= 1) ? 0.25 / p : 0)
  if (sig.some(v => v > 0)) {
    if (!(img instanceof Float32Array)) img = Float32Array.from(img)
    gaussianFilter3d(img, dims, sig)
  }
  let bg = Infinity
  for (let i = 0; i < img.length; i++) if (img[i] < bg) bg = img[i]
  if (!Number.isFinite(bg)) bg = 0
  // cantos do volume em mm → caixa RAS
  let mn = [Infinity, Infinity, Infinity]
  let mx = [-Infinity, -Infinity, -Infinity]
  for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) for (const k of [0, nz - 1]) {
    const w = [
      a[0] * i + a[1] * j + a[2] * k + a[3],
      a[4] * i + a[5] * j + a[6] * k + a[7],
      a[8] * i + a[9] * j + a[10] * k + a[11]
    ]
    for (let d = 0; d < 3; d++) { mn[d] = Math.min(mn[d], w[d]); mx[d] = Math.max(mx[d], w[d]) }
  }
  const od = [0, 1, 2].map(d => Math.max(8, Math.round(mx[d] - mn[d]) + 1))
  // inversa da affine 3×4 (parte linear 3×3 + origem)
  const M = [[a[0], a[1], a[2]], [a[4], a[5], a[6]], [a[8], a[9], a[10]]]
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
  const inv = [
    [(M[1][1] * M[2][2] - M[1][2] * M[2][1]) / det, (M[0][2] * M[2][1] - M[0][1] * M[2][2]) / det, (M[0][1] * M[1][2] - M[0][2] * M[1][1]) / det],
    [(M[1][2] * M[2][0] - M[1][0] * M[2][2]) / det, (M[0][0] * M[2][2] - M[0][2] * M[2][0]) / det, (M[0][2] * M[1][0] - M[0][0] * M[1][2]) / det],
    [(M[1][0] * M[2][1] - M[1][1] * M[2][0]) / det, (M[0][1] * M[2][0] - M[0][0] * M[2][1]) / det, (M[0][0] * M[1][1] - M[0][1] * M[1][0]) / det]
  ]
  const t = [a[3], a[7], a[11]]
  const out = new Float32Array(od[0] * od[1] * od[2])
  if (bg !== 0) out.fill(bg)
  const sxy = nx * ny
  for (let K = 0; K < od[2]; K++) {
    const wz = mn[2] + K
    for (let J = 0; J < od[1]; J++) {
      const wy = mn[1] + J
      const base = (J + K * od[1]) * od[0]
      for (let I = 0; I < od[0]; I++) {
        const wx = mn[0] + I
        const dx = wx - t[0], dy = wy - t[1], dz = wz - t[2]
        const x = inv[0][0] * dx + inv[0][1] * dy + inv[0][2] * dz
        const y = inv[1][0] * dx + inv[1][1] * dy + inv[1][2] * dz
        const z = inv[2][0] * dx + inv[2][1] * dy + inv[2][2] * dz
        if (x < 0 || y < 0 || z < 0 || x > nx - 1 || y > ny - 1 || z > nz - 1) continue
        const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z)
        const fx = x - x0, fy = y - y0, fz = z - z0
        const x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), z1 = Math.min(nz - 1, z0 + 1)
        const c000 = img[x0 + y0 * nx + z0 * sxy], c100 = img[x1 + y0 * nx + z0 * sxy]
        const c010 = img[x0 + y1 * nx + z0 * sxy], c110 = img[x1 + y1 * nx + z0 * sxy]
        const c001 = img[x0 + y0 * nx + z1 * sxy], c101 = img[x1 + y0 * nx + z1 * sxy]
        const c011 = img[x0 + y1 * nx + z1 * sxy], c111 = img[x1 + y1 * nx + z1 * sxy]
        out[base + I] =
          (1 - fz) * ((1 - fy) * ((1 - fx) * c000 + fx * c100) + fy * ((1 - fx) * c010 + fx * c110)) +
          fz * ((1 - fy) * ((1 - fx) * c001 + fx * c101) + fy * ((1 - fx) * c011 + fx * c111))
      }
    }
  }
  const A = [1, 0, 0, mn[0], 0, 1, 0, mn[1], 0, 0, 1, mn[2], 0, 0, 0, 1]
  return { img: out, dims: od, affine: A }
}

/**
 * Super-resolução em blocos com sobreposição e recorte central no stitching.
 * @param tf tfjs; model LayersModel; vol Float32Array já em [0,1]; dims da grade 1 mm
 * @param {number} tile lado do bloco (múltiplo de 32); overlap sobreposição
 * @param {boolean} clip true: saída ×255 recortada a [0,128]; false: ×255 sem
 *        recorte (para a média com o flip, que o oficial faz ANTES de recortar)
 * @returns {Promise<Float32Array>} saída em [0,128] (ou ×255 bruta)
 */
export async function tiledSR (tf, model, vol, dims, tile = 96, overlap = 32, onProgress = () => {}, clip = true) {
  const [nx, ny, nz] = dims
  const out = new Float32Array(nx * ny * nz)
  // sobreposição ≤ metade do bloco: com overlap ≥ tile o passo seria ≤ 0 (laço infinito)
  overlap = Math.min(overlap, 2 * Math.floor(tile / 4))
  const step = tile - overlap
  const starts = (n) => {
    const s = []
    for (let v = 0; ; v += step) {
      if (v + tile >= n) { s.push(Math.max(0, n - tile)); break }
      s.push(v)
    }
    return [...new Set(s)]
  }
  const XS = starts(nx), YS = starts(ny), ZS = starts(nz)
  const total = XS.length * YS.length * ZS.length
  let done = 0
  const h = overlap / 2
  for (const z0 of ZS) {
    for (const y0 of YS) {
      for (const x0 of XS) {
        const tx = Math.min(tile, nx), ty = Math.min(tile, ny), tz = Math.min(tile, nz)
        // bloco (com pad zero se o volume é menor que o tile)
        const inp = new Float32Array(tile * tile * tile)
        for (let k = 0; k < tz; k++) for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
          inp[i + j * tile + k * tile * tile] = vol[(x0 + i) + (y0 + j) * nx + (z0 + k) * nx * ny]
        }
        // o bloco chega x-mais-rápido ([z][y][x]); a rede foi treinada com [x, y, z]
        // (x no eixo mais lento, como um array do nibabel) — transpõe na entrada e na saída
        let yd, nc
        const tens = []
        try {
          const zyx = tf.tensor5d(inp, [1, tile, tile, tile, 1]); tens.push(zyx)
          const xyz = zyx.transpose([0, 3, 2, 1, 4]); tens.push(xyz)
          const yXyz = model.predict(xyz); tens.push(yXyz)
          const yZyx = yXyz.transpose([0, 3, 2, 1, 4]); tens.push(yZyx)
          nc = yZyx.shape[4] || 1 // o SynthSR tem 1 canal; lê-se o canal 0 de qualquer forma
          yd = await yZyx.data()
        } finally { tf.dispose(tens) }
        // recorte central: meia sobreposição por lado interno
        const lo = (s, n) => s === 0 ? 0 : h
        const hi = (s, t2, n) => (s + tile >= n) ? Math.min(t2, n - s) : tile - h
        const xl = lo(x0, nx), xh = hi(x0, tx, nx)
        const yl = lo(y0, ny), yh = hi(y0, ty, ny)
        const zl = lo(z0, nz), zh = hi(z0, tz, nz)
        for (let k = zl; k < zh; k++) for (let j = yl; j < yh; j++) for (let i = xl; i < xh; i++) {
          const gx = x0 + i, gy = y0 + j, gz = z0 + k
          if (gx >= nx || gy >= ny || gz >= nz) continue
          const val = 255 * yd[(i + j * tile + k * tile * tile) * nc]
          out[gx + gy * nx + gz * nx * ny] = clip ? Math.min(128, Math.max(0, val)) : val
        }
        done++
        onProgress(done / total)
        await new Promise(r => setTimeout(r, 0))
      }
    }
  }
  return out
}

/** flip L/R (eixo x da grade RAS) */
export function flipX (vol, dims) {
  const [nx, ny, nz] = dims
  const out = new Float32Array(vol.length)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const b = (j + k * ny) * nx
    for (let i = 0; i < nx; i++) out[b + i] = vol[b + (nx - 1 - i)]
  }
  return out
}
