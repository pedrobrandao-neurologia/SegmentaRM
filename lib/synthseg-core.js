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
      // cosseno diretor (coluna normalizada) — voxel anisotrópico não decide o eixo
      const v = Math.abs(affine[r][a]) / (Math.hypot(affine[0][a], affine[1][a], affine[2][a]) || 1)
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
// Espera o download de um tensor, mas desiste se o contexto WebGL for perdido: nesse
// caso o tfjs fica consultando a cerca da GPU para sempre (a promessa nunca resolve) e
// a segmentação "para no meio" sem erro. Com CPU, é só o data() normal.
let lostCheck = null
export function setContextLostCheck (fn) { lostCheck = fn }
async function waitData (t) {
  if (!lostCheck) return t.data()
  let timer = null
  const lost = new Promise((resolve, reject) => {
    timer = setInterval(() => {
      if (lostCheck()) reject(new Error('o contexto WebGL da GPU foi perdido no meio da inferência (memória de vídeo esgotada ou driver reiniciado)'))
    }, 500)
  })
  try { return await Promise.race([t.data(), lost]) } finally { clearInterval(timer) }
}

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
    // recorta à região pedida e calcula o top-K NA GPU: argMax/max iterativos (o
    // argMax devolve o primeiro máximo — mesmo desempate do topKChannels: menor
    // índice), com o canal escolhido empurrado para negativo a cada passo. Índice e
    // valor vão empacotados num float (valor + 2·canal; posterior ∈ [0,1], precisão
    // ~4e-6 < passo da quantização Uint16), então só K floats por voxel descem da GPU
    // — baixar os 32 canais (até ~270 MB por bloco) esgotava a memória de GPUs
    // integradas e derrubava o contexto WebGL, que deixa o tfjs esperando para sempre.
    const packed = tf.tidy(() => {
      const c = post.slice([reg.x0 - lo[0], reg.y0 - lo[1], reg.z0 - lo[2], 0],
        [reg.x1 - reg.x0, reg.y1 - reg.y0, reg.z1 - reg.z0, post.shape[3]])
      const C = c.shape[3]
      let q = c
      const outs = []
      for (let k = 0; k < K; k++) {
        const i = tf.argMax(q, 3)
        outs.push(tf.max(q, 3).add(i.toFloat().mul(2)))
        if (k < K - 1) q = q.sub(tf.oneHot(i, C).mul(4))
      }
      return tf.stack(outs, 3)
    })
    post.dispose()
    let d
    try { d = await waitData(packed) } finally { packed.dispose() }
    const val = new Float32Array(d.length)
    const idx = new Uint8Array(d.length)
    for (let i = 0; i < d.length; i++) {
      const ch = Math.floor(d[i] / 2)
      idx[i] = ch
      val[i] = d[i] - 2 * ch
    }
    return { val, idx }
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
// ---------------------------------------------------------------- pré-processamento oficial
// Réplica de predict_synthseg.preprocess (sem --crop): lê a imagem NATIVA, reamostra
// para 1 mm com edit_volumes.resample_volume (gaussiano anti-serrilhado σ = 0,25/fator
// só ao reduzir, RegularGridInterpolator linear na grade start = −(f−1)/2f, passo 1/f,
// ceil(n·f) amostras, coordenadas presas à borda), alinha a RAS com
// align_volume_to_ref(eye(4)) e devolve o volume e a affine resultantes. O rescale por
// percentis e o padding centrado ficam em runSynthSeg, sobre este volume — como no
// oficial, os percentis são do volume reamostrado (não do 256³ conformado, cujo
// preenchimento com zeros desloca o p99,5 em ~10%).

function inv4 (A) { // inversa de affine 4×4 em linhas [[..],[..],[..],[0,0,0,1]]
  const m = [A[0][0], A[0][1], A[0][2], A[1][0], A[1][1], A[1][2], A[2][0], A[2][1], A[2][2]]
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  const i = [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det
  ]
  const t = [A[0][3], A[1][3], A[2][3]]
  return [
    [i[0], i[1], i[2], -(i[0] * t[0] + i[1] * t[1] + i[2] * t[2])],
    [i[3], i[4], i[5], -(i[3] * t[0] + i[4] * t[1] + i[5] * t[2])],
    [i[6], i[7], i[8], -(i[6] * t[0] + i[7] * t[1] + i[8] * t[2])],
    [0, 0, 0, 1]
  ]
}

// scipy.ndimage.gaussian_filter (mode 'reflect', truncate 4) num eixo, em float64
function gaussAxis (vol, dims, ax, sg) {
  const r = Math.floor(4 * sg + 0.5)
  if (!(sg > 0) || r < 1) return
  const ker = new Float64Array(2 * r + 1)
  let ks = 0
  for (let t = -r; t <= r; t++) { ker[t + r] = Math.exp(-0.5 * (t / sg) ** 2); ks += ker[t + r] }
  for (let t = 0; t < ker.length; t++) ker[t] /= ks
  const n = dims[ax]
  const strides = [1, dims[0], dims[0] * dims[1]]
  const st = strides[ax]
  const [oa, ob] = [0, 1, 2].filter(d => d !== ax)
  const line = new Float64Array(n)
  const refl = (q) => { const p = 2 * n; q = ((q % p) + p) % p; return q < n ? q : p - 1 - q }
  for (let ib = 0; ib < dims[ob]; ib++) {
    for (let ia = 0; ia < dims[oa]; ia++) {
      const base = ia * strides[oa] + ib * strides[ob]
      for (let q = 0; q < n; q++) line[q] = vol[base + q * st]
      for (let q = 0; q < n; q++) {
        let acc = 0
        for (let t = -r; t <= r; t++) { const qq = q + t; acc += ker[t + r] * line[qq >= 0 && qq < n ? qq : refl(qq)] }
        vol[base + q * st] = acc
      }
    }
  }
}

// get_ras_axes: eixo da imagem que corresponde a cada eixo RAS, pela INVERSA da affine
function getRasAxes (A) {
  const I = inv4(A)
  const ax = [0, 1, 2].map(c => { // argmax |inv[0:3, c]| ao longo das linhas
    let best = -1, bi = 0
    for (let r = 0; r < 3; r++) { const v = Math.abs(I[r][c]); if (v > best) { best = v; bi = r } }
    return bi
  })
  for (let i = 0; i < 3; i++) {
    if (!ax.includes(i)) {
      const cnt = [0, 0, 0]; ax.forEach(a => cnt[a]++)
      const wrong = cnt.indexOf(Math.max(...cnt))
      const last = ax.lastIndexOf(wrong)
      ax[last] = i
    }
  }
  return ax
}

/**
 * @param {ArrayLike<number>} data volume nativo (x mais rápido)
 * @param {number[]} dims
 * @param {number[][]} affine 4×4 em linhas (vox → mm)
 * @returns {{data: Float32Array, dims: number[], affine: number[][], res: number[], resampled: boolean}}
 */
export function officialPreprocess (data, dims, affine) {
  let A = affine.map(r => r.slice())
  let d = dims.slice()
  let vol = data instanceof Float32Array ? data : Float32Array.from(data)
  // pixdim = normas das colunas (np.sqrt(np.sum(aff * aff, axis=0))[:-1])
  const pix = [0, 1, 2].map(c => Math.sqrt(A[0][c] ** 2 + A[1][c] ** 2 + A[2][c] ** 2 + A[3][c] ** 2))
  let res = pix.slice()
  let resampled = false
  if (pix.some(p => p > 1.05 || p < 0.95)) {
    resampled = true
    const f = pix.map(p => p / 1)
    const work = new Float64Array(vol.length)
    for (let i = 0; i < vol.length; i++) work[i] = vol[i]
    for (let a = 0; a < 3; a++) if (!(f[a] > 1)) gaussAxis(work, d, a, 0.25 / f[a])
    // grade de amostragem por eixo, exatamente como np.arange(start, stop, step)
    const coords = [0, 1, 2].map(a => {
      const start = -(f[a] - 1) / (2 * f[a])
      const step = 1 / f[a]
      const stop = start + step * Math.ceil(d[a] * f[a])
      const len = Math.ceil((stop - start) / step)
      const c = new Float64Array(len)
      for (let i = 0; i < len; i++) c[i] = Math.min(d[a] - 1, Math.max(0, start + i * step))
      return c
    })
    const nd = coords.map(c => c.length)
    // interpolação linear separável (≡ RegularGridInterpolator 'linear')
    const axisPass = (src, sd, a) => {
      const od = sd.slice(); od[a] = nd[a]
      const out = new Float64Array(od[0] * od[1] * od[2])
      const sStr = [1, sd[0], sd[0] * sd[1]], oStr = [1, od[0], od[0] * od[1]]
      const [oa, ob] = [0, 1, 2].filter(x => x !== a)
      const c = coords[a], n = sd[a]
      const i0 = new Int32Array(c.length), fr = new Float64Array(c.length)
      for (let q = 0; q < c.length; q++) { let k = Math.floor(c[q]); if (k >= n - 1) k = Math.max(0, n - 2); i0[q] = k; fr[q] = c[q] - k }
      for (let ib = 0; ib < od[ob]; ib++) {
        for (let ia = 0; ia < od[oa]; ia++) {
          const sb = ia * sStr[oa] + ib * sStr[ob], ob2 = ia * oStr[oa] + ib * oStr[ob]
          for (let q = 0; q < c.length; q++) {
            const v0 = src[sb + i0[q] * sStr[a]]
            const v1 = n > 1 ? src[sb + (i0[q] + 1) * sStr[a]] : v0
            out[ob2 + q * oStr[a]] = v0 + fr[q] * (v1 - v0)
          }
        }
      }
      return { out, od }
    }
    let cur = work, cd = d
    for (let a = 0; a < 3; a++) { const r = axisPass(cur, cd, a); cur = r.out; cd = r.od }
    vol = Float32Array.from(cur)
    d = cd
    const A2 = A.map(r => r.slice())
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) A2[r][c] = A[r][c] / f[c]
    for (let r = 0; r < 3; r++) A2[r][3] = A[r][3] - (A2[r][0] * 0.5 * (f[0] - 1) + A2[r][1] * 0.5 * (f[1] - 1) + A2[r][2] * 0.5 * (f[2] - 1))
    A = A2
    res = [1, 1, 1]
  }
  // align_volume_to_ref(aff_ref = eye(4)): troca de eixos e depois inversões
  // a troca de eixos do oficial termina com o eixo i do volume = eixo ras[i] original
  // (e aff[:, i] = aff_original[:, ras[i]]) — vale também para ciclos de 3 eixos
  const perm = getRasAxes(A)
  A = A.map(row => [row[perm[0]], row[perm[1]], row[perm[2]], row[3]])
  const pd = perm.map(p => d[p])
  const flip = [0, 1, 2].map(i => A[i][i] < 0) // dot_products com eye(4)
  for (let i = 0; i < 3; i++) {
    if (flip[i]) {
      for (let r = 0; r < 4; r++) A[r][i] = -A[r][i]
      for (let r = 0; r < 3; r++) A[r][3] = A[r][3] - A[r][i] * (pd[i] - 1)
    }
  }
  const out = new Float32Array(pd[0] * pd[1] * pd[2])
  const sStr = [1, d[0], d[0] * d[1]]
  const st = perm.map(p => sStr[p])
  let v = 0
  for (let k = 0; k < pd[2]; k++) {
    const sk = (flip[2] ? pd[2] - 1 - k : k) * st[2]
    for (let j = 0; j < pd[1]; j++) {
      const sj = (flip[1] ? pd[1] - 1 - j : j) * st[1]
      for (let i = 0; i < pd[0]; i++, v++) out[v] = vol[(flip[0] ? pd[0] - 1 - i : i) * st[0] + sj + sk]
    }
  }
  return { data: out, dims: pd, affine: A, res, resampled }
}

/** amostra (vizinho mais próximo) um volume da grade `src` na grade `dst` (affines 4×4 em linhas) */
export function resliceNearest (vol, srcDims, srcAffine, dstDims, dstAffine, OutType = Uint8Array) {
  const M = inv4(srcAffine)
  const T = [0, 1, 2].map(r => [0, 1, 2, 3].map(c =>
    M[r][0] * dstAffine[0][c] + M[r][1] * dstAffine[1][c] + M[r][2] * dstAffine[2][c] + (c === 3 ? M[r][3] : 0)))
  const [sx, sy, sz] = srcDims
  const out = new OutType(dstDims[0] * dstDims[1] * dstDims[2])
  let v = 0
  for (let k = 0; k < dstDims[2]; k++) {
    for (let j = 0; j < dstDims[1]; j++) {
      const bx = T[0][1] * j + T[0][2] * k + T[0][3]
      const by = T[1][1] * j + T[1][2] * k + T[1][3]
      const bz = T[2][1] * j + T[2][2] * k + T[2][3]
      for (let i = 0; i < dstDims[0]; i++, v++) {
        const x = Math.round(bx + T[0][0] * i), y = Math.round(by + T[1][0] * i), z = Math.round(bz + T[2][0] * i)
        if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz) out[v] = vol[x + (y + z * sy) * sx]
      }
    }
  }
  return out
}

export async function runSynthSeg ({
  tf, model, img, dims, affine, tile = 128, overlap = 32, flip = true, sigma = 0.5,
  postprocess = true, K = 3, flipIdx = SYNTHSEG1_FLIP, topology = SYNTHSEG1_TOPOLOGY, onProgress = null,
  native = null, cropShape = null, fullVolume = false, boxMargin = 16
}) {
  const say = (msg, frac) => { if (onProgress) onProgress(msg, frac) }
  // blocos < 128 têm pouco contexto perto da costura: com 96 e sobreposição 32 o
  // cerebelo ficou com Dice 0,85 contra a inferência em volume inteiro (0,97 com 64)
  if (tile < 128) overlap = Math.max(overlap, tile - 32)
  // Caminho oficial (native): a imagem NATIVA passa por predict_synthseg.preprocess
  // (reamostragem 1 mm + alinhamento RAS), os percentis são do volume reamostrado e a
  // rede vê o volume inteiro com a fase de pooling do padding centrado; no fim a
  // segmentação é amostrada (vizinho mais próximo) na grade `dims/affine` pedida.
  // Sem `native`, segmenta o próprio `img` (grade conformada), como antes.
  let orientation = null, ras, rasAffine = null, voxMm3 = 1, fullRas = null
  if (native) {
    const pre = officialPreprocess(native.data, native.dims, native.affine)
    ras = { data: pre.data, dims: pre.dims }
    rasAffine = pre.affine
    if (cropShape) {
      // --crop do oficial: recorte centrado (múltiplo de 32) ANTES dos percentis; a
      // saída volta ao volume inteiro com zeros fora do recorte
      const cs = cropShape.map(c => Math.ceil(c / 32) * 32)
      const lo = pre.dims.map((n, a) => Math.max(Math.trunc((n - cs[a]) / 2), 0))
      const hi = pre.dims.map((n, a) => Math.min(lo[a] + cs[a], n))
      const cbox = { min: lo, size: hi.map((h, a) => h - lo[a]) }
      fullRas = { dims: pre.dims, box: cbox }
      ras = { data: extractBox(pre.data, pre.dims, cbox), dims: cbox.size }
    }
    voxMm3 = pre.res[0] * pre.res[1] * pre.res[2]
    say(`pré-processamento oficial: ${native.dims.join('×')} → ${pre.dims.join('×')}${pre.resampled ? ' (reamostrado a 1 mm)' : ''}`, 0.07)
  } else {
    orientation = rasOrientation(affine)
    ras = toRAS(img, dims, orientation)
  }
  // rescale no próprio buffer RAS (percentis do volume inteiro, como o oficial)
  let norm = robustRescale(ras.data, { inPlace: true })
  // caminho oficial: o volume inteiro (como o predict.py); senão, recorte ao tecido —
  // em ambos, com o início na mesma grade de pooling do volume inteiro
  // caixa do tecido (limiar 0,02 do volume normalizado) com margem de contexto, na fase
  // de pooling do volume inteiro. Fora dela a rede do oficial só vê fundo; processar o
  // volume inteiro custava 27 blocos (×2 com o espelhamento) num 256³ contra ~12.
  const box = alignBoxToGrid(fullVolume ? { min: [0, 0, 0], size: ras.dims.slice() } : boundingBox(norm, ras.dims, 0.02, native ? boxMargin : 8), ras.dims)
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
  if (native) {
    // volumes em mm³ (voxel do volume reamostrado), como o --vol oficial
    for (let i = 0; i < pp.volumes.length; i++) pp.volumes[i] *= voxMm3
    let segR = pasteBox(new Uint8Array(nRas), ras.dims, pp.seg, box)
    let confR = pasteBox(new Uint8Array(nRas), ras.dims, pp.conf, box)
    let gd = ras.dims
    if (fullRas) { // volta do --crop ao volume inteiro
      const nF = fullRas.dims[0] * fullRas.dims[1] * fullRas.dims[2]
      segR = pasteBox(new Uint8Array(nF), fullRas.dims, segR, fullRas.box)
      confR = pasteBox(new Uint8Array(nF), fullRas.dims, confR, fullRas.box)
      gd = fullRas.dims
    }
    const seg = resliceNearest(segR, gd, rasAffine, dims, affine)
    const conf = resliceNearest(confR, gd, rasAffine, dims, affine)
    // gridSeg: a segmentação na grade do oficial (1 mm, RAS), antes da amostragem no conformado
    return { seg, conf, volumes: pp.volumes, volumesUnit: 'mm3', box, nTiles, grid: { dims: gd, affine: rasAffine }, gridSeg: segR }
  }
  const seg = fromRAS(pasteBox(new Uint8Array(nRas), ras.dims, pp.seg, box), dims, orientation)
  const conf = fromRAS(pasteBox(new Uint8Array(nRas), ras.dims, pp.conf, box), dims, orientation)
  return { seg, conf, volumes: pp.volumes, volumesUnit: 'voxels', box, nTiles }
}
