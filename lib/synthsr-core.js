// synthsr-core.js — SynthSR v1.0 (Iglesias et al., Sci Adv 2023; BBillot/SynthSR,
// Apache 2.0) no navegador: sintetiza um MP-RAGE T1 1 mm isotrópico a partir de um
// exame de qualquer contraste/resolução. Réplica do predict_command_line.py oficial:
//   1. reamostrar a 1 mm e alinhar a RAS identidade (trilinear)
//   2. normalizar min–max para [0,1] (global, sobre o volume inteiro)
//   3. UNet de regressão (mesma família do SynthSeg) — aqui em blocos com sobreposição,
//      porque o volume inteiro não cabe na GPU do navegador (recorte central no stitching)
//   4. opcional: média com a predição do volume espelhado em L/R (test-time flipping)
//   5. saída ×255, recortada a [0,128]

/**
 * Reamostra o volume nativo para a grade RAS 1 mm isotrópica (trilinear).
 * @param {Float32Array|Uint8Array|Int16Array} img
 * @param {number[]} dims [nx,ny,nz]
 * @param {number[]} affine 16 valores row-major voxel→mm RAS
 * @returns {{img: Float32Array, dims: number[], affine: number[]}} affine da grade nova
 */
export function resampleToRAS1mm (img, dims, affine) {
  const [nx, ny, nz] = dims
  const a = affine
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
 * @returns {Promise<Float32Array>} saída em [0,128]
 */
export async function tiledSR (tf, model, vol, dims, tile = 96, overlap = 32, onProgress = () => {}) {
  const [nx, ny, nz] = dims
  const out = new Float32Array(nx * ny * nz)
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
        const zyx = tf.tensor5d(inp, [1, tile, tile, tile, 1])
        const xyz = zyx.transpose([0, 3, 2, 1, 4])
        const yXyz = model.predict(xyz)
        const yZyx = yXyz.transpose([0, 3, 2, 1, 4])
        const yd = await yZyx.data()
        tf.dispose([zyx, xyz, yXyz, yZyx])
        // recorte central: meia sobreposição por lado interno
        const lo = (s, n) => s === 0 ? 0 : h
        const hi = (s, t2, n) => (s + tile >= n) ? Math.min(t2, n - s) : tile - h
        const xl = lo(x0, nx), xh = hi(x0, tx, nx)
        const yl = lo(y0, ny), yh = hi(y0, ty, ny)
        const zl = lo(z0, nz), zh = hi(z0, tz, nz)
        for (let k = zl; k < zh; k++) for (let j = yl; j < yh; j++) for (let i = xl; i < xh; i++) {
          const gx = x0 + i, gy = y0 + j, gz = z0 + k
          if (gx >= nx || gy >= ny || gz >= nz) continue
          out[gx + gy * nx + gz * nx * ny] = Math.min(128, Math.max(0, 255 * yd[i + j * tile + k * tile * tile]))
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
