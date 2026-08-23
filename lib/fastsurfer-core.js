// Núcleo do FastSurferCNN v1 (Henschel et al., NeuroImage 2020 — Deep-MI/FastSurfer,
// Apache 2.0) portado para tfjs. Os pesos vêm de models/fastsurfer/*.bin (float16,
// BatchNorm dobrada nas convoluções — ver tools/convert_fastsurfer_tfjs.py); o grafo
// aqui é conv + PReLU escalar + maxout competitivo + maxpool com índices/unpool.
// Usado pelo workers/fastsurfer.worker.js e pelos testes de paridade em Node.

const BLOCKS = ['encode1', 'encode2', 'encode3', 'encode4', 'bottleneck', 'decode4', 'decode3', 'decode2', 'decode1']

/** decodifica float16 → Float32Array */
export function f16ToF32 (u16) {
  const out = new Float32Array(u16.length)
  for (let i = 0; i < u16.length; i++) {
    const h = u16[i]
    const s = (h & 0x8000) >> 15
    const e = (h & 0x7C00) >> 10
    const f = h & 0x03FF
    let v
    if (e === 0) v = f * Math.pow(2, -24)
    else if (e === 31) v = f ? NaN : Infinity
    else v = (1 + f / 1024) * Math.pow(2, e - 15)
    out[i] = s ? -v : v
  }
  return out
}

/**
 * Monta os tensores de uma vista a partir do manifest + ArrayBuffer do .bin.
 * @returns {{get:(name:string)=>tf.Tensor, classes:number, dispose:()=>void}}
 */
export function buildViewWeights (tf, viewManifest, binBuffer) {
  const u16 = new Uint16Array(binBuffer)
  const map = new Map()
  for (const t of viewManifest.tensors) {
    const f32 = f16ToF32(u16.subarray(t.offset, t.offset + t.length))
    map.set(t.name, tf.tensor(f32, t.shape))
  }
  return {
    get: (name) => map.get(name),
    classes: viewManifest.classes,
    dispose: () => { for (const v of map.values()) v.dispose() }
  }
}

function prelu (tf, x, alpha) {
  return tf.tidy(() => tf.prelu(x, alpha))
}

function conv (tf, x, w, b) {
  return tf.tidy(() => tf.add(tf.conv2d(x, w, 1, 'same'), b))
}

// bloco denso competitivo (BN já dobrada): não-entrada
// x -> PReLU -> conv0 -> max(.,x) -> PReLU -> conv1 -> max(., m1) -> PReLU -> conv2
function denseBlock (tf, W, pre, x) {
  return tf.tidy(() => {
    const a = W.get(pre + '.alpha')
    const t1 = conv(tf, prelu(tf, x, a), W.get(pre + '.w0'), W.get(pre + '.b0'))
    const m1 = tf.maximum(t1, x)
    const t2 = conv(tf, prelu(tf, m1, a), W.get(pre + '.w1'), W.get(pre + '.b1'))
    const m2 = tf.maximum(t2, m1)
    return conv(tf, prelu(tf, m2, a), W.get(pre + '.w2'), W.get(pre + '.b2'))
  })
}

// bloco de entrada: in -> conv0 (bn0+bn1 dobradas) -> PReLU -> conv1 -> max(., t0) -> PReLU -> conv2
function denseBlockInput (tf, W, x) {
  return tf.tidy(() => {
    const a = W.get('encode1.alpha')
    const t0 = conv(tf, x, W.get('encode1.w0'), W.get('encode1.b0'))
    const t1 = conv(tf, prelu(tf, t0, a), W.get('encode1.w1'), W.get('encode1.b1'))
    const m = tf.maximum(t1, t0)
    return conv(tf, prelu(tf, m, a), W.get('encode1.w2'), W.get('encode1.b2'))
  })
}

function unpool (tf, x, idx, h, w) {
  return tf.tidy(() => {
    const [n, , , c] = x.shape
    const flatLen = h * w * c
    const vals = tf.reshape(x, [-1])
    const offs = tf.mul(tf.range(0, n, 1, 'int32'), tf.scalar(flatLen, 'int32'))
    const ind = tf.add(tf.reshape(tf.cast(idx, 'int32'), [n, -1]), tf.reshape(offs, [n, 1]))
    const out = tf.scatterND(tf.reshape(ind, [-1, 1]), vals, [n * flatLen])
    return tf.reshape(out, [n, h, w, c])
  })
}

/**
 * Forward de um lote de fatias.
 * @param x tf.Tensor [n,256,256,7] em [0,1]
 * @returns tf.Tensor [n,256,256,classes] (logits)
 */
export function fsForward (tf, W, x) {
  return tf.tidy(() => {
    const skips = []
    const idxs = []
    const sizes = []
    let cur = x
    for (let i = 1; i <= 4; i++) {
      const blk = i === 1 ? denseBlockInput(tf, W, cur) : denseBlock(tf, W, `encode${i}`, cur)
      sizes.push([blk.shape[1], blk.shape[2]])
      const { result, indexes } = tf.maxPoolWithArgmax(blk, 2, 2, 'same')
      skips.push(blk)
      idxs.push(indexes)
      cur = result
    }
    cur = denseBlock(tf, W, 'bottleneck', cur)
    for (let j = 0; j < 4; j++) {
      const lvl = 3 - j
      const up = unpool(tf, cur, idxs[lvl], sizes[lvl][0], sizes[lvl][1])
      const merged = tf.maximum(up, skips[lvl])
      cur = denseBlock(tf, W, `decode${4 - j}`, merged)
    }
    return conv(tf, cur, W.get('classifier.w'), W.get('classifier.b'))
  })
}

// vistas: como cada uma fatia o volume LIA e onde caem (h, w) no plano —
// réplica exata dos transform_axial/transform_sagittal + get_thick_slices do
// FastSurfer v1 (coronal: eixo2; axial: moveaxis→fatias no eixo1; sagital: eixo0)
export const VIEW_DEFS = {
  coronal: { axis: 2, h: 0, w: 1, weight: 0.4 },
  axial: { axis: 1, h: 2, w: 0, weight: 0.4 },
  sagittal: { axis: 0, h: 2, w: 1, weight: 0.2 }
}

/**
 * Parcelação FastSurfer completa sobre o volume LIA, restrita à máscara de córtex.
 * Agrega logits das vistas (0,4·axial + 0,4·coronal + 0,2·sagital, como no
 * fastsurfer_inference.py v1), resolve o argmax por voxel mascarado e devolve a
 * parcela no espaço do modelo 104 do brainchop (1..34 = ctx-lh, 35..68 = ctx-rh) —
 * pronto para a fuseDKT. Classes corticais que a rede não lateraliza são atribuídas
 * por componente conexo contra a linha média (adaptação do fix por centroide de SB
 * do pipeline oficial, documentada no README).
 *
 * @param {object} p { tf, manifest, bins: {view: ArrayBuffer}, lia: Uint8Array,
 *                     dims, maskLia: Uint8Array, views: string[], batch, onProgress }
 * @returns {Promise<{parcLia: Uint8Array, stats: object}>}
 */
export async function runFastSurferParc ({ tf, manifest, bins, lia, dims, maskLia, views, batch = 2, onProgress = () => {} }) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const C = 79
  // voxels mascarados + baldes por fatia de cada vista
  const vlist = []
  for (let v = 0; v < n; v++) if (maskLia[v]) vlist.push(v)
  const nMask = vlist.length
  if (!nMask) throw new Error('máscara de córtex vazia')
  const acc = new Int16Array(nMask * C)
  const SCALE = 24 // logits ~±47 × peso ≤0,5 × 24 × 3 vistas < 32767
  const coordOf = (v) => [v % nx, ((v / nx) | 0) % ny, (v / (nx * ny)) | 0]

  const useViews = views.filter(v => VIEW_DEFS[v])
  const wSum = useViews.reduce((s, v) => s + VIEW_DEFS[v].weight, 0)
  let done = 0
  let totalSlices = 0
  const perView = {}
  for (const view of useViews) {
    const def = VIEW_DEFS[view]
    const buckets = new Map() // fatia → [ [idxNaLista, h, w], ... ]
    for (let i = 0; i < nMask; i++) {
      const c = coordOf(vlist[i])
      const s = c[def.axis]
      let b = buckets.get(s)
      if (!b) { b = []; buckets.set(s, b) }
      b.push([i, c[def.h], c[def.w]])
    }
    perView[view] = buckets
    totalSlices += buckets.size
  }

  const dimOf = (ax) => ax === 0 ? nx : ax === 1 ? ny : nz
  const stride = [1, nx, nx * ny]

  for (const view of useViews) {
    const def = VIEW_DEFS[view]
    const W = buildViewWeights(tf, manifest.views[view], bins[view])
    // 3 vistas: pesos oficiais 0,4/0,4/0,2; menos vistas: renormaliza para somar 1
    const wEff = useViews.length === 3 ? def.weight : def.weight / wSum
    const H = dimOf(def.h)
    const Wd = dimOf(def.w)
    const D = dimOf(def.axis)
    const slices = Array.from(perView[view].keys()).sort((a, b) => a - b)
    const isSag = view === 'sagittal'
    const sag2full = manifest.sag2full
    for (let si = 0; si < slices.length; si += batch) {
      const chunk = slices.slice(si, si + batch)
      const inArr = new Float32Array(chunk.length * H * Wd * 7)
      let q = 0
      for (const s of chunk) {
        for (let hh = 0; hh < H; hh++) {
          for (let ww = 0; ww < Wd; ww++) {
            for (let t = -3; t <= 3; t++) {
              const ss = Math.max(0, Math.min(D - 1, s + t))
              const lin = hh * stride[def.h] + ww * stride[def.w] + ss * stride[def.axis]
              inArr[q++] = lia[lin] / 255
            }
          }
        }
      }
      const x = tf.tensor4d(inArr, [chunk.length, H, Wd, 7])
      const y = fsForward(tf, W, x)
      const yd = await y.data()
      x.dispose(); y.dispose()
      const Cv = manifest.views[view].classes
      for (let b = 0; b < chunk.length; b++) {
        const bucket = perView[view].get(chunk[b])
        const base = b * H * Wd * Cv
        for (const [vi, hh, ww] of bucket) {
          const o = base + (hh * Wd + ww) * Cv
          const ao = vi * C
          if (isSag) {
            for (let c = 0; c < C; c++) acc[ao + c] += Math.round(wEff * SCALE * yd[o + sag2full[c]])
          } else {
            for (let c = 0; c < C; c++) acc[ao + c] += Math.round(wEff * SCALE * yd[o + c])
          }
        }
      }
      done += chunk.length
      onProgress(done / totalSlices, `FastSurfer ${view}: fatia ${Math.min(si + batch, slices.length)}/${slices.length}`)
      await new Promise(r => setTimeout(r, 0))
    }
    W.dispose()
  }

  // argmax por voxel → parcela + hemisfério
  const cls2parcel = manifest.cls2parcel
  const parcLia = new Uint8Array(n)
  const hemiOf = new Uint8Array(nMask) // 0 nada · 1 E · 2 D · 3 compartilhada
  let ctxVox = 0
  for (let i = 0; i < nMask; i++) {
    let best = -32768 * 4, bc = 0
    const ao = i * C
    for (let c = 0; c < C; c++) if (acc[ao + c] > best) { best = acc[ao + c]; bc = c }
    const [parcel, hemi] = cls2parcel[bc]
    if (parcel > 0) {
      hemiOf[i] = hemi
      parcLia[vlist[i]] = parcel // hemisfério aplicado depois
      ctxVox++
    }
  }

  // linha média (eixo0 LIA aponta para a esquerda): centroide da própria máscara
  let midSum = 0
  for (let i = 0; i < nMask; i++) midSum += vlist[i] % nx
  const mid = midSum / nMask

  // classes já lateralizadas pela rede (2000s) vão direto para a base direita
  for (let i = 0; i < nMask; i++) {
    if (hemiOf[i] === 2) parcLia[vlist[i]] += 34
  }
  // compartilhadas (a rede v1 usa uma classe para os dois lados em 19 regiões):
  // componente 26-conexo da mesma parcela → lado pelo centroide contra a linha média
  const visited = new Uint8Array(n)
  const stack = new Int32Array(nMask)
  const idxInList = new Map()
  for (let i = 0; i < nMask; i++) idxInList.set(vlist[i], i)
  let shared = 0
  for (let i = 0; i < nMask; i++) {
    const v0 = vlist[i]
    if (hemiOf[i] !== 3 || visited[v0]) continue
    const parcel = parcLia[v0]
    let top = 0
    stack[top++] = v0
    visited[v0] = 1
    const region = []
    let sumI0 = 0
    while (top) {
      const v = stack[--top]
      region.push(v)
      sumI0 += v % nx
      const x0 = v % nx, y0 = ((v / nx) | 0) % ny, z0 = (v / (nx * ny)) | 0
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const X = x0 + dx, Y = y0 + dy, Z = z0 + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
        const w = X + Y * nx + Z * nx * ny
        if (visited[w] || parcLia[w] !== parcel) continue
        const j = idxInList.get(w)
        if (j === undefined || hemiOf[j] !== 3) continue
        visited[w] = 1
        stack[top++] = w
      }
    }
    shared++
    // eixo0 do LIA aponta para a esquerda: centroide acima da linha média = hemisfério E
    if ((sumI0 / region.length) <= mid) for (const v of region) parcLia[v] = parcel + 34
  }
  return { parcLia, stats: { maskVox: nMask, ctxVox, sharedRegions: shared, slices: totalSlices, views: useViews } }
}

/**
 * Reorienta o volume conformado (256³) para LIA a partir da affine (voxel→mm RAS,
 * row-major 16). Sem reamostrar — só permutação/flip; devolve também o mapa inverso.
 * LIA: eixo0→Esquerda (−x), eixo1→Inferior (−z), eixo2→Anterior (+y).
 */
export function toLIA (img, dims, affine) {
  const a = affine
  const col = (j) => [a[j], a[4 + j], a[8 + j]]
  // eixo de memória dominante para cada eixo de MUNDO desejado: L(−x), I(−z), A(+y)
  const want = [[-1, 0, 0], [0, 0, -1], [0, 1, 0]]
  const srcAxis = [-1, -1, -1]
  const sign = [1, 1, 1]
  const used = new Set()
  for (let t = 0; t < 3; t++) {
    let best = -1, bestDot = -1
    for (let j = 0; j < 3; j++) {
      if (used.has(j)) continue
      const c = col(j)
      const d = Math.abs(c[0] * want[t][0] + c[1] * want[t][1] + c[2] * want[t][2])
      if (d > bestDot) { bestDot = d; best = j }
    }
    srcAxis[t] = best
    used.add(best)
    const c = col(best)
    sign[t] = (c[0] * want[t][0] + c[1] * want[t][1] + c[2] * want[t][2]) >= 0 ? 1 : -1
  }
  const nd = [dims[srcAxis[0]], dims[srcAxis[1]], dims[srcAxis[2]]]
  const [nx, ny] = dims
  const stride = [1, nx, nx * ny]
  const s0 = stride[srcAxis[0]], s1 = stride[srcAxis[1]], s2 = stride[srcAxis[2]]
  const out = new Uint8Array(img.length)
  // mapa LIA→original (índice linear) para trazer o resultado de volta
  const back = new Int32Array(img.length)
  let p = 0
  for (let i2 = 0; i2 < nd[2]; i2++) {
    const o2 = (sign[2] > 0 ? i2 : nd[2] - 1 - i2) * s2
    for (let i1 = 0; i1 < nd[1]; i1++) {
      const o1 = (sign[1] > 0 ? i1 : nd[1] - 1 - i1) * s1
      for (let i0 = 0; i0 < nd[0]; i0++, p++) {
        const src = (sign[0] > 0 ? i0 : nd[0] - 1 - i0) * s0 + o1 + o2
        out[p] = img[src]
        back[p] = src
      }
    }
  }
  return { img: out, dims: nd, back }
}
