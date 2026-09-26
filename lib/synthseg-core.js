// Núcleo da inferência SynthSeg 1.0 no navegador: replica o predict.py /
// predict_synthseg.py do BBillot/SynthSeg (Apache 2.0) —
//  • alinhamento a RAS (align_volume_to_ref) e rescale robusto por percentis
//    0,5–99,5 (np.percentile linear, clip) para [0,1];
//  • UNet original, com test-time flipping L/R (média com a predição do volume
//    espelhado, canais E/D trocados — flip_indices) e suavização gaussiana dos
//    posteriors (sigma_smoothing = 0,5, kernel 3³ normalizado, padding zero);
//  • pós-processamento: maior componente conexa (6-viz, como scipy.ndimage.label)
//    da máscara Σ posteriors não-fundo > 0,25, depois maior componente por classe
//    topológica (topology_classes), renormalização e argmax; volumes "soft"
//    (soma dos posteriors, como o --vol do oficial).
// Diferença declarada: a inferência roda em blocos com sobreposição (o volume
// inteiro não cabe na GPU do navegador). O recorte e os blocos começam na grade
// de 16 voxels do volume inteiro (a UNet tem 4 max-poolings: a predição só é
// equivariante a deslocamentos de 16 — fora dessa fase ~0,5% dos rótulos mudam),
// e a costura corta no meio de cada sobreposição, longe das bordas dos blocos.
// Medido no exemplo (T1 256³) contra a rede no volume inteiro + pós-processamento
// oficial em numpy/scipy: Dice médio 0,9965 (mín. 0,991) com blocos de 128.
// Por voxel guardam-se só os K maiores posteriors (K = 3 basta para as máscaras
// > 0,25 serem exatas: no máximo 3 canais podem passar de 0,25).

// rótulos FreeSurfer por canal da rede (np.unique de synthseg_segmentation_labels.npy)
export const SYNTHSEG1_LABELS = [0, 2, 3, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 26, 28,
  41, 42, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60]
// classes topológicas por canal (synthseg_topological_classes.npy[unique_idx])
export const SYNTHSEG1_TOPOLOGY = [0, 4, 4, 4, 4, 5, 5, 6, 7, 8, 9, 1, 2, 3, 10, 11, 12, 13,
  14, 14, 14, 14, 15, 15, 16, 17, 18, 19, 20, 21, 22, 23]
// pares esquerdo ↔ direito (FreeSurfer); 0, 14, 15, 16 são neutros
const LR_PAIRS = [[2, 41], [3, 42], [4, 43], [5, 44], [7, 46], [8, 47], [10, 49], [11, 50],
  [12, 51], [13, 52], [17, 53], [18, 54], [26, 58], [28, 60]]

/** equivalente a get_flip_indices(labels, n_neutral_labels) do predict.py */
export function flipIndices (labels = SYNTHSEG1_LABELS) {
  const pos = new Map(labels.map((l, i) => [l, i]))
  const mate = new Map()
  for (const [l, r] of LR_PAIRS) { mate.set(l, r); mate.set(r, l) }
  return labels.map((l, i) => (mate.has(l) && pos.has(mate.get(l)) ? pos.get(mate.get(l)) : i))
}
export const SYNTHSEG1_FLIP = flipIndices()

// permutação/flips que levam o volume (ordem crua + affine) à ordem RAS
export function rasOrientation (affine) {
  const perm = [0, 0, 0]
  const flip = [1, 1, 1]
  const used = new Set()
  for (let r = 0; r < 3; r++) {
    let best = -1, bi = -1
    for (let a = 0; a < 3; a++) {
      if (used.has(a)) continue
      const v = Math.abs(affine[r][a])
      if (v > best) { best = v; bi = a }
    }
    used.add(bi)
    perm[r] = bi
    flip[r] = affine[r][bi] >= 0 ? 1 : -1
  }
  return { perm, flip }
}

// reordena o volume cru para eixos RAS (x mais rápido); saída Float32
export function toRAS (data, dims, orientation) {
  const { perm, flip } = orientation
  const outDims = [dims[perm[0]], dims[perm[1]], dims[perm[2]]]
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2])
  const stride = [1, dims[0], dims[0] * dims[1]]
  const s0 = stride[perm[0]], s1 = stride[perm[1]], s2 = stride[perm[2]]
  const n0 = outDims[0], n1 = outDims[1], n2 = outDims[2]
  let v = 0
  for (let c = 0; c < n2; c++) {
    const sc = (flip[2] > 0 ? c : n2 - 1 - c) * s2
    for (let b = 0; b < n1; b++) {
      const sb = (flip[1] > 0 ? b : n1 - 1 - b) * s1
      for (let a = 0; a < n0; a++, v++) {
        out[v] = data[(flip[0] > 0 ? a : n0 - 1 - a) * s0 + sb + sc]
      }
    }
  }
  return { data: out, dims: outDims }
}

// caminho inverso: volume em RAS → ordem crua original (tipo de saída configurável)
export function fromRAS (labels, dims, orientation, OutType = Uint8Array) {
  const { perm, flip } = orientation
  const rasDims = [dims[perm[0]], dims[perm[1]], dims[perm[2]]]
  const out = new OutType(dims[0] * dims[1] * dims[2])
  const stride = [1, dims[0], dims[0] * dims[1]]
  const s0 = stride[perm[0]], s1 = stride[perm[1]], s2 = stride[perm[2]]
  const n0 = rasDims[0], n1 = rasDims[1], n2 = rasDims[2]
  let v = 0
  for (let c = 0; c < n2; c++) {
    const sc = (flip[2] > 0 ? c : n2 - 1 - c) * s2
    for (let b = 0; b < n1; b++) {
      const sb = (flip[1] > 0 ? b : n1 - 1 - b) * s1
      for (let a = 0; a < n0; a++, v++) {
        out[(flip[0] > 0 ? a : n0 - 1 - a) * s0 + sb + sc] = labels[v]
      }
    }
  }
  return out
}

/**
 * Percentis exatos com a interpolação linear do np.percentile, sem copiar nem
 * ordenar o volume: histograma de 65 536 caixas → caixa do k-ésimo valor →
 * só os valores dessa caixa são ordenados.
 * @param {ArrayLike<number>} data
 * @param {number[]} ps percentis em [0, 100]
 */
export function percentiles (data, ps) {
  const n = data.length
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < n; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  if (!(mx > mn)) return ps.map(() => mn)
  const B = 65536
  const sc = (B - 1) / (mx - mn)
  const hist = new Float64Array(B)
  const bMin = new Float64Array(B).fill(Infinity)
  const bMax = new Float64Array(B).fill(-Infinity)
  for (let i = 0; i < n; i++) {
    const v = data[i]
    const b = Math.floor((v - mn) * sc)
    hist[b]++
    if (v < bMin[b]) bMin[b] = v
    if (v > bMax[b]) bMax[b] = v
  }
  const cum = new Float64Array(B)
  let acc = 0
  for (let b = 0; b < B; b++) { acc += hist[b]; cum[b] = acc }
  const kth = (k) => { // k-ésimo menor (0-based)
    let lo = 0, hi = B - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > k) hi = mid; else lo = mid + 1 }
    const b = lo
    if (bMin[b] === bMax[b]) return bMin[b]
    const vals = new Float64Array(hist[b])
    let j = 0
    for (let i = 0; i < n; i++) { const v = data[i]; if (Math.floor((v - mn) * sc) === b) vals[j++] = v }
    vals.sort()
    return vals[k - (b > 0 ? cum[b - 1] : 0)]
  }
  return ps.map(p => {
    const pos = (p / 100) * (n - 1)
    const k0 = Math.floor(pos)
    const f = pos - k0
    const v0 = kth(k0)
    return f > 0 && k0 + 1 < n ? v0 + f * (kth(k0 + 1) - v0) : v0
  })
}

/**
 * Rescale robusto como edit_volumes.rescale_volume(im, 0, 1, 0.5, 99.5):
 * percentis sobre o volume inteiro, clip e escala linear; faixa degenerada → zeros.
 * @param {boolean} [inPlace] reescreve `data` (Float32Array) em vez de alocar outro volume
 */
export function robustRescale (data, { minPercentile = 0.5, maxPercentile = 99.5, inPlace = false } = {}) {
  const [lo, hi] = percentiles(data, [minPercentile, maxPercentile])
  const out = inPlace && data instanceof Float32Array ? data : new Float32Array(data.length)
  if (!(hi > lo)) { out.fill(0); return out }
  const inv = 1 / (hi - lo)
  for (let i = 0; i < data.length; i++) {
    const v = data[i]
    out[i] = ((v < lo ? lo : v > hi ? hi : v) - lo) * inv
  }
  return out
}

// caixa envolvente do tecido (val > thr), com margem, dims da grade
export function boundingBox (data, dims, thr = 0.02, margin = 8) {
  const [nx, ny, nz] = dims
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1
  let v = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, v++) {
        if (data[v] > thr) {
          if (i < x0) x0 = i; if (i > x1) x1 = i
          if (j < y0) y0 = j; if (j > y1) y1 = j
          if (k < z0) z0 = k; if (k > z1) z1 = k
        }
      }
    }
  }
  if (x1 < 0) return { min: [0, 0, 0], size: dims.slice() }
  const min = [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.max(0, z0 - margin)]
  const max = [Math.min(nx - 1, x1 + margin), Math.min(ny - 1, y1 + margin), Math.min(nz - 1, z1 + margin)]
  return { min, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] }
}

/**
 * Caixa de recorte com a mesma fase de pooling do oficial: o predict.py processa o
 * volume inteiro com padding centrado até múltiplo de 32; a UNet (4 max-poolings)
 * só é equivariante a deslocamentos múltiplos de 16, e deslocar a grade em poucos
 * voxels muda ~0,5% dos rótulos. O início da caixa é recuado até coincidir com a
 * grade do volume inteiro — pode ficar negativo (região de padding, zeros como no
 * oficial).
 */
export function alignBoxToGrid (box, dims, align = 16, nLevels = 5) {
  const min = [], size = []
  for (let a = 0; a < 3; a++) {
    const n = dims[a]
    const padded = Math.ceil(n / 2 ** nLevels) * 2 ** nLevels
    const before = Math.floor((padded - n) / 2) // pad_volume centraliza
    const m0 = Math.floor((box.min[a] + before) / align) * align - before
    min.push(m0); size.push(box.min[a] + box.size[a] - m0)
  }
  return { min, size }
}

/** copia a caixa (pode sair do volume: fora vale 0) para um Float32Array x-mais-rápido */
export function extractBox (data, dims, box) {
  const [nx, ny, nz] = dims
  const [bx, by, bz] = box.size
  const out = new Float32Array(bx * by * bz)
  const x0 = Math.max(0, box.min[0]), x1 = Math.min(nx, box.min[0] + bx)
  if (x1 <= x0) return out
  for (let k = 0; k < bz; k++) {
    const z = box.min[2] + k
    if (z < 0 || z >= nz) continue
    for (let j = 0; j < by; j++) {
      const y = box.min[1] + j
      if (y < 0 || y >= ny) continue
      const src = (z * ny + y) * nx
      out.set(data.subarray(src + x0, src + x1), (k * by + j) * bx + (x0 - box.min[0]))
    }
  }
  return out
}

/** cola a caixa `src` (x-mais-rápido) em `dst` (volume `dims`), ignorando o que sai do volume */
export function pasteBox (dst, dims, src, box) {
  const [nx, ny, nz] = dims
  const [bx, by, bz] = box.size
  const x0 = Math.max(0, box.min[0]), x1 = Math.min(nx, box.min[0] + bx)
  if (x1 <= x0) return dst
  for (let k = 0; k < bz; k++) {
    const z = box.min[2] + k
    if (z < 0 || z >= nz) continue
    for (let j = 0; j < by; j++) {
      const y = box.min[1] + j
      if (y < 0 || y >= ny) continue
      const s = (k * by + j) * bx + (x0 - box.min[0])
      dst.set(src.subarray(s, s + (x1 - x0)), (z * ny + y) * nx + x0)
    }
  }
  return dst
}

/**
 * Grade de blocos num eixo: o menor nº de blocos com sobreposição ≥ `overlap`,
 * inícios em múltiplos de `align` (fase de pooling comum a todos os blocos) e
 * costura no meio de cada sobreposição. Cada bloco escreve [w0, w1) (absoluto);
 * os intervalos particionam [0, extent) sem buracos nem repetição.
 * @returns {{start:number, size:number, w0:number, w1:number}[]}
 */
export function tileGrid (extent, tile, overlap, align = 16) {
  if (extent <= tile) return [{ start: 0, size: extent, w0: 0, w1: extent }]
  const n = Math.ceil((extent - tile) / Math.max(1, tile - overlap)) + 1
  let stride = Math.ceil((extent - tile) / (n - 1) / align) * align
  // tile − overlap não múltiplo de `align`: passo mínimo sem alinhamento
  if (stride > tile - overlap) stride = Math.ceil((extent - tile) / (n - 1))
  const tiles = []
  for (let i = 0; i < n; i++) {
    const start = Math.min(i * stride, extent - 1)
    tiles.push({ start, size: Math.min(tile, extent - start) })
    if (start + tile >= extent) break
  }
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]
    t.w0 = i === 0 ? 0 : tiles[i - 1].w1
    t.w1 = i === tiles.length - 1 ? extent : Math.floor((tiles[i + 1].start + t.start + t.size) / 2)
  }
  return tiles
}

/** kernel gaussiano 1D do GaussianBlur do lab2im (janela ceil(2,5σ)/2·2+1, normalizado) */
export function gaussianKernel1D (sigma) {
  if (!(sigma > 0)) return [1]
  const w = Math.trunc(Math.ceil(2.5 * sigma) / 2) * 2 + 1
  const r = (w - 1) / 2
  const g = []
  for (let i = -r; i <= r; i++) g.push(Math.exp(-(i * i) / (2 * sigma * sigma)))
  const s = g.reduce((a, b) => a + b, 0)
  return g.map(x => x / s)
}

const QMAX = 65535 // posteriors quantizados em Uint16 (resolução 1,5e-5)

/**
 * Inferência em blocos. `predictTile(block, [bw,bh,bd], reg)` recebe o bloco em
 * ordem [x][y][z] (z mais rápido — a ordem de um array do nibabel, com que a rede
 * foi treinada; bw,bh,bd múltiplos de 32) e devolve Promise<{ idx, val }>: os K
 * canais de maior posterior e seus valores para cada voxel da região
 * reg = {x0,x1,y0,y1,z0,z1} (coordenadas do bloco, semiabertas), em ordem
 * (x, y, z, k) com k mais rápido.
 * @returns {Promise<{topIdx: Uint8Array, topVal: Uint16Array, K: number}>}
 *          por voxel do volume (x mais rápido), K entradas em ordem decrescente
 */
export async function tiledSegment ({ data, dims, tile = 128, overlap = 32, K = 3, predictTile, onProgress }) {
  const [nx, ny, nz] = dims
  const gx = tileGrid(nx, tile, overlap)
  const gy = tileGrid(ny, tile, overlap)
  const gz = tileGrid(nz, tile, overlap)
  const N = nx * ny * nz
  const topIdx = new Uint8Array(N * K)
  const topVal = new Uint16Array(N * K)
  const total = gx.length * gy.length * gz.length
  let done = 0
  for (const tz of gz) {
    for (const ty of gy) {
      for (const tx of gx) {
        // bloco preenchido com zeros até múltiplo de 32 (a UNet tem 5 níveis)
        const bw = ceil32(tx.size), bh = ceil32(ty.size), bd = ceil32(tz.size)
        const block = new Float32Array(bw * bh * bd)
        for (let i = 0; i < tx.size; i++) {
          for (let j = 0; j < ty.size; j++) {
            const dst = (i * bh + j) * bd
            let src = tz.start * nx * ny + (ty.start + j) * nx + tx.start + i
            for (let k = 0; k < tz.size; k++, src += nx * ny) block[dst + k] = data[src]
          }
        }
        const reg = {
          x0: tx.w0 - tx.start, x1: tx.w1 - tx.start,
          y0: ty.w0 - ty.start, y1: ty.w1 - ty.start,
          z0: tz.w0 - tz.start, z1: tz.w1 - tz.start
        }
        const { idx, val } = await predictTile(block, [bw, bh, bd], reg)
        let r = 0
        for (let x = tx.w0; x < tx.w1; x++) {
          for (let y = ty.w0; y < ty.w1; y++) {
            for (let z = tz.w0; z < tz.w1; z++, r += K) {
              const o = ((z * ny + y) * nx + x) * K
              for (let k = 0; k < K; k++) {
                topIdx[o + k] = idx[r + k]
                const q = Math.round(val[r + k] * QMAX)
                topVal[o + k] = q < 0 ? 0 : q > QMAX ? QMAX : q
              }
            }
          }
        }
        done++
        if (onProgress) onProgress(done, total)
      }
    }
  }
  return { topIdx, topVal, K }
}

/**
 * Preditor de bloco com TensorFlow.js (tf injetado — o worker usa o bundle do
 * navegador; os testes, o tfjs-node). Replica o grafo do build_model oficial:
 * média com a predição do bloco espelhado em x (canais trocados por
 * `flipIdx`) → GaussianBlur(σ) por canal → top-K por voxel.
 * Só a região pedida (+ a margem do kernel) sai da predição completa, que é
 * descartada logo em seguida: o pico de memória é o da própria UNet.
 */
export function makeTilePredictor (tf, model, { flipIdx = SYNTHSEG1_FLIP, flip = true, sigma = 0.5, K = 3 } = {}) {
  const g = gaussianKernel1D(sigma)
  const r = (g.length - 1) / 2
  let kernel = null
  if (r > 0) {
    const w = g.length
    const k3 = new Float32Array(w * w * w)
    for (let a = 0; a < w; a++) for (let b = 0; b < w; b++) for (let c = 0; c < w; c++) k3[(a * w + b) * w + c] = g[a] * g[b] * g[c]
    kernel = tf.tensor5d(k3, [w, w, w, 1, 1])
  }
  const flipT = flip && flipIdx ? tf.tensor1d(Int32Array.from(flipIdx), 'int32') : null
  const predict = async (block, [bw, bh, bd], reg) => {
    const lo = [Math.max(0, reg.x0 - r), Math.max(0, reg.y0 - r), Math.max(0, reg.z0 - r)]
    const hi = [Math.min(bw, reg.x1 + r), Math.min(bh, reg.y1 + r), Math.min(bd, reg.z1 + r)]
    const sz = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    const inp = tf.tensor5d(block, [1, bw, bh, bd, 1])
    let post
    try {
      post = tf.tidy(() => {
        const y = model.predict(inp)
        return y.slice([0, lo[0], lo[1], lo[2], 0], [1, sz[0], sz[1], sz[2], y.shape[4]]).reshape([sz[0], sz[1], sz[2], y.shape[4]])
      })
      if (flipT) {
        // RandomFlip(axis=0) do oficial: espelha x, prediz, espelha de volta e troca E/D
        const mirrored = tf.tidy(() => {
          const y = model.predict(tf.reverse(inp, 1))
          const s = y.slice([0, bw - hi[0], lo[1], lo[2], 0], [1, sz[0], sz[1], sz[2], y.shape[4]])
            .reshape([sz[0], sz[1], sz[2], y.shape[4]])
          return tf.gather(tf.reverse(s, 0), flipT, 3)
        })
        const avg = tf.tidy(() => post.add(mirrored).mul(0.5))
        tf.dispose([post, mirrored])
        post = avg
      }
    } finally {
      inp.dispose()
    }
    if (kernel) {
      // conv3d por canal (canais viram lote), padding zero 'SAME' como no oficial
      const t = tf.tidy(() => post.transpose([3, 0, 1, 2]).expandDims(4))
      post.dispose()
      const b = tf.conv3d(t, kernel, 1, 'same')
      t.dispose()
      post = tf.tidy(() => b.squeeze([4]).transpose([1, 2, 3, 0]))
      b.dispose()
    }
    // recorta à região pedida; o top-K é feito em JS após um download assíncrono
    // (o TopK do webgl, com 32 canais, cai num caminho síncrono na CPU que ordena
    // objetos linha a linha)
    const c = tf.tidy(() => post.slice([reg.x0 - lo[0], reg.y0 - lo[1], reg.z0 - lo[2], 0],
      [reg.x1 - reg.x0, reg.y1 - reg.y0, reg.z1 - reg.z0, post.shape[3]]))
    post.dispose()
    let p
    try { p = await c.data() } finally { c.dispose() }
    return topKChannels(p, c.shape[3], K)
  }
  predict.dispose = () => { if (kernel) kernel.dispose(); if (flipT) flipT.dispose() }
  return predict
}

/** K maiores canais por voxel (ordem decrescente; empate → menor índice, como np.argmax) */
export function topKChannels (p, C, K) {
  const n = p.length / C
  const val = new Float32Array(n * K)
  const idx = new Uint8Array(n * K)
  const bv = new Float64Array(K), bi = new Int32Array(K)
  for (let v = 0, o = 0; v < n; v++, o += C) {
    bv.fill(-Infinity); bi.fill(0)
    for (let ch = 0; ch < C; ch++) {
      const x = p[o + ch]
      if (!(x > bv[K - 1])) continue
      let k = K - 1
      while (k > 0 && x > bv[k - 1]) { bv[k] = bv[k - 1]; bi[k] = bi[k - 1]; k-- }
      bv[k] = x; bi[k] = ch
    }
    for (let k = 0; k < K; k++) { val[v * K + k] = bv[k]; idx[v * K + k] = bi[k] }
  }
  return { val, idx }
}

// componentes 6-conexas (estrutura padrão do scipy.ndimage.label em 3D) sobre
// uma lista de voxels marcados com `stamp[v] === 1`; marca 3 no maior componente
// e devolve seu tamanho. `stamp` volta a 0 nos demais (reutilizável).
function keepLargest6 (list, count, dims, stamp, stack) {
  const [nx, ny, nz] = dims
  const nxy = nx * ny
  let bestSeed = -1, bestSize = 0
  for (let s = 0; s < count; s++) {
    const seed = list[s]
    if (stamp[seed] !== 1) continue
    let top = 0, size = 0
    stack[top++] = seed; stamp[seed] = 2
    while (top) {
      const v = stack[--top]; size++
      const x = v % nx, y = ((v - x) / nx) % ny, z = (v - x - y * nx) / nxy
      if (x > 0 && stamp[v - 1] === 1) { stamp[v - 1] = 2; stack[top++] = v - 1 }
      if (x < nx - 1 && stamp[v + 1] === 1) { stamp[v + 1] = 2; stack[top++] = v + 1 }
      if (y > 0 && stamp[v - nx] === 1) { stamp[v - nx] = 2; stack[top++] = v - nx }
      if (y < ny - 1 && stamp[v + nx] === 1) { stamp[v + nx] = 2; stack[top++] = v + nx }
      if (z > 0 && stamp[v - nxy] === 1) { stamp[v - nxy] = 2; stack[top++] = v - nxy }
      if (z < nz - 1 && stamp[v + nxy] === 1) { stamp[v + nxy] = 2; stack[top++] = v + nxy }
    }
    if (size > bestSize) { bestSize = size; bestSeed = seed }
  }
  if (bestSeed >= 0) {
    let top = 0
    stack[top++] = bestSeed; stamp[bestSeed] = 3
    while (top) {
      const v = stack[--top]
      const x = v % nx, y = ((v - x) / nx) % ny, z = (v - x - y * nx) / nxy
      if (x > 0 && stamp[v - 1] === 2) { stamp[v - 1] = 3; stack[top++] = v - 1 }
      if (x < nx - 1 && stamp[v + 1] === 2) { stamp[v + 1] = 3; stack[top++] = v + 1 }
      if (y > 0 && stamp[v - nx] === 2) { stamp[v - nx] = 3; stack[top++] = v - nx }
      if (y < ny - 1 && stamp[v + nx] === 2) { stamp[v + nx] = 3; stack[top++] = v + nx }
      if (z > 0 && stamp[v - nxy] === 2) { stamp[v - nxy] = 3; stack[top++] = v - nxy }
      if (z < nz - 1 && stamp[v + nxy] === 2) { stamp[v + nxy] = 3; stack[top++] = v + nxy }
    }
  }
  return bestSize
}

/**
 * Pós-processamento do predict_synthseg (ramo não-fast) sobre os top-K:
 *  1. máscara Σ posteriors[1:] > 0,25 (⇔ fundo < 0,75) → maior componente;
 *     canais não-fundo zerados fora dela;
 *  2. para cada classe topológica: máscara "algum canal da classe > 0,25" →
 *     maior componente; os canais da classe são zerados fora dela;
 *  3. renormalização e argmax → índice do canal (0–31); volumes soft por canal.
 * Canais fora do top-K entram só como massa residual na renormalização.
 * @returns {{seg: Uint8Array, conf: Uint8Array, volumes: Float64Array}}
 *          conf = maior posterior (antes do pós-processamento) em 0–255;
 *          volumes em voxels (soma dos posteriors normalizados)
 */
export function postprocessSegmentation ({ topIdx, topVal, K, dims, topology = SYNTHSEG1_TOPOLOGY, nLabels = topology.length, keepBiggest = true, useTopology = true }) {
  const N = dims[0] * dims[1] * dims[2]
  const thr = 0.25 * QMAX
  const nClasses = Math.max(...topology) + 1
  if (nClasses > 32) throw new Error('SynthSeg: mais de 32 classes topológicas')
  const stamp = new Uint8Array(N)
  const keep = new Uint32Array(N) // bit 0: componente do encéfalo; bit c: componente da classe c
  let list = null, stack = null

  // 1. maior componente da máscara encefálica
  let nIn = 0
  for (let v = 0; v < N; v++) {
    const o = v * K
    let p0 = -1
    for (let k = 0; k < K; k++) if (topIdx[o + k] === 0) { p0 = topVal[o + k]; break }
    // fundo fora do top-K ⇒ fundo < 1/K ⇒ Σ não-fundo > 0,25
    if (p0 < 0 || QMAX - p0 > thr) { stamp[v] = 1; nIn++ }
  }
  if (keepBiggest) {
    list = new Int32Array(nIn)
    let j = 0
    for (let v = 0; v < N; v++) if (stamp[v] === 1) list[j++] = v
    stack = new Int32Array(Math.max(1, nIn))
    keepLargest6(list, nIn, dims, stamp, stack)
    for (let s = 0; s < nIn; s++) { const v = list[s]; if (stamp[v] === 3) keep[v] = 1; stamp[v] = 0 }
  } else {
    keep.fill(1) // sem keep_biggest_component nada é zerado neste passo
    stamp.fill(0)
  }

  // 2. classes topológicas (máscaras calculadas depois do passo 1, como no oficial)
  if (useTopology) {
    const counts = new Int32Array(nClasses)
    const seen = new Uint8Array(nClasses)
    const each = (fn) => {
      for (let v = 0; v < N; v++) {
        if (!(keep[v] & 1)) continue
        const o = v * K
        for (let k = 0; k < K; k++) {
          if (topVal[o + k] <= thr) break // ordem decrescente
          const c = topology[topIdx[o + k]]
          if (c === 0 || seen[c]) continue
          seen[c] = 1; fn(c, v)
        }
        for (let k = 0; k < K; k++) seen[topology[topIdx[o + k]]] = 0
      }
    }
    each((c) => { counts[c]++ })
    const offs = new Int32Array(nClasses + 1)
    for (let c = 0; c < nClasses; c++) offs[c + 1] = offs[c] + counts[c]
    const lists = new Int32Array(offs[nClasses])
    const fill = offs.slice(0, nClasses)
    each((c, v) => { lists[fill[c]++] = v })
    let maxCount = 0
    for (let c = 1; c < nClasses; c++) maxCount = Math.max(maxCount, counts[c])
    if (!stack || stack.length < maxCount) stack = new Int32Array(Math.max(1, maxCount))
    for (let c = 1; c < nClasses; c++) {
      if (!counts[c]) continue
      const sub = lists.subarray(offs[c], offs[c + 1])
      for (let s = 0; s < sub.length; s++) stamp[sub[s]] = 1
      keepLargest6(sub, sub.length, dims, stamp, stack)
      const bit = (1 << c) >>> 0
      for (let s = 0; s < sub.length; s++) { const v = sub[s]; if (stamp[v] === 3) keep[v] = (keep[v] | bit) >>> 0; stamp[v] = 0 }
    }
  }
  list = null; stack = null

  // 3. zera, renormaliza, argmax e volumes soft
  const seg = new Uint8Array(N)
  const conf = new Uint8Array(N)
  const volumes = new Float64Array(nLabels)
  for (let v = 0; v < N; v++) {
    const o = v * K
    const kv = keep[v]
    let sumOrig = 0, sumKept = 0, best = -1, bestIdx = 0
    for (let k = 0; k < K; k++) {
      const ch = topIdx[o + k], p = topVal[o + k]
      sumOrig += p
      let kept = true
      if (ch !== 0) {
        if (!(kv & 1)) kept = false
        else if (useTopology) { const c = topology[ch]; if (c !== 0 && !((kv >>> c) & 1)) kept = false }
      }
      if (kept) { sumKept += p; if (p > best) { best = p; bestIdx = ch } }
    }
    conf[v] = Math.round(topVal[o] * 255 / QMAX)
    seg[v] = best > 0 ? bestIdx : 0
    const denom = sumKept + Math.max(0, QMAX - sumOrig) // massa fora do top-K
    if (denom > 0) {
      for (let k = 0; k < K; k++) {
        const ch = topIdx[o + k]
        if (ch === 0) continue
        if (!(kv & 1)) continue
        if (useTopology) { const c = topology[ch]; if (c !== 0 && !((kv >>> c) & 1)) continue }
        volumes[ch] += topVal[o + k] / denom
      }
    }
  }
  return { seg, conf, volumes }
}

function ceil32 (n) { return Math.ceil(n / 32) * 32 }

/**
 * Pipeline completo do worker (testável em Node com o tfjs-node):
 * RAS → rescale robusto → recorte alinhado à grade → blocos (TTA + suavização) →
 * pós-processamento → ordem crua.
 * @param {object} p
 * @param {object} p.tf       TensorFlow.js
 * @param {object} p.model    LayersModel do SynthSeg 1.0
 * @param {ArrayLike<number>} p.img volume na ordem crua (x mais rápido)
 * @param {number[]} p.dims
 * @param {number[][]} p.affine 4×4
 * @param {(msg: string, frac: number) => void} [p.onProgress]
 * @returns {Promise<{seg: Uint8Array, conf: Uint8Array, volumes: Float64Array, box: object, nTiles: number}>}
 */
export async function runSynthSeg ({
  tf, model, img, dims, affine, tile = 128, overlap = 32, flip = true, sigma = 0.5,
  postprocess = true, K = 3, flipIdx = SYNTHSEG1_FLIP, topology = SYNTHSEG1_TOPOLOGY, onProgress = null
}) {
  const say = (msg, frac) => { if (onProgress) onProgress(msg, frac) }
  // blocos < 128 têm pouco contexto perto da costura: com 96 e sobreposição 32 o
  // cerebelo ficou com Dice 0,85 contra a inferência em volume inteiro (0,97 com 64)
  if (tile < 128) overlap = Math.max(overlap, tile - 32)
  const orientation = rasOrientation(affine)
  const ras = toRAS(img, dims, orientation)
  // rescale no próprio buffer RAS (percentis do volume inteiro, como o oficial)
  let norm = robustRescale(ras.data, { inPlace: true })
  // recorte ao tecido, com o início na mesma grade de pooling do volume inteiro
  const box = alignBoxToGrid(boundingBox(norm, ras.dims), ras.dims)
  let crop = extractBox(norm, ras.dims, box)
  ras.data = norm = null // só o recorte segue
  say(`recorte ${box.size.join('×')} @ 1 mm, blocos de ${tile} (sobreposição ≥ ${overlap})` +
    `${flip ? ', média com o volume espelhado E/D' : ''}${sigma > 0 ? `, suavização σ=${sigma}` : ''}`, 0.08)
  const predictTile = makeTilePredictor(tf, model, { flipIdx, flip, sigma, K })
  let nTiles = 0
  const top = await tiledSegment({
    data: crop, dims: box.size, tile, overlap, K, predictTile,
    onProgress: (done, total) => { nTiles = total; say(`bloco ${done}/${total}${flip ? ' (+ espelhado)' : ''}`, 0.08 + 0.82 * done / total) }
  })
  crop = null
  predictTile.dispose()
  say(postprocess ? 'pós-processamento (maior componente por estrutura, como o predict_synthseg)' : 'argmax dos posteriors', 0.91)
  await new Promise(resolve => setTimeout(resolve, 0))
  const pp = postprocessSegmentation({ ...top, dims: box.size, topology, keepBiggest: postprocess, useTopology: postprocess })
  const nRas = ras.dims[0] * ras.dims[1] * ras.dims[2]
  const seg = fromRAS(pasteBox(new Uint8Array(nRas), ras.dims, pp.seg, box), dims, orientation)
  const conf = fromRAS(pasteBox(new Uint8Array(nRas), ras.dims, pp.conf, box), dims, orientation)
  return { seg, conf, volumes: pp.volumes, box, nTiles }
}
