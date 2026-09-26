// Núcleo do FastSurferCNN v1 (Henschel et al., NeuroImage 2020 — Deep-MI/FastSurfer,
// Apache 2.0) portado para tfjs. Os pesos vêm de models/fastsurfer/*.bin (float32;
// BatchNorm pós-conv dobrada nas convoluções e bn0 da entrada explícita — ver
// tools/convert_fastsurfer_tfjs.py); o grafo aqui é bn0 + conv + PReLU escalar +
// maxout competitivo + maxpool/unpool (posição do máximo com o desempate do PyTorch).
// Usado pelo workers/fastsurfer.worker.js e pelos testes de paridade em Node contra uma
// referência numpy do FastSurferCNN com as BN não dobradas (ver README).

/** decodifica float16 → Float32Array (manifesto legado 'float16') */
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
 * dtype 'float32' (atual) ou 'float16' (legado, com a bn0 dobrada na conv0 — inexato
 * numa borda de 2 px que se propaga pela U-Net; mantido só para leitura).
 * @returns {{get:(name:string)=>tf.Tensor, bn0:{s:tf.Tensor,t:tf.Tensor}|null, classes:number, dispose:()=>void}}
 */
export function buildViewWeights (tf, viewManifest, binBuffer, dtype = 'float32') {
  const map = new Map()
  if (dtype === 'float32') {
    const f32all = new Float32Array(binBuffer)
    for (const t of viewManifest.tensors) {
      map.set(t.name, tf.tensor(f32all.subarray(t.offset, t.offset + t.length), t.shape))
    }
  } else if (dtype === 'float16') {
    const u16 = new Uint16Array(binBuffer)
    for (const t of viewManifest.tensors) {
      map.set(t.name, tf.tensor(f16ToF32(u16.subarray(t.offset, t.offset + t.length)), t.shape))
    }
  } else {
    throw new Error(`dtype de pesos FastSurfer não suportado: ${dtype}`)
  }
  const s0 = map.get('encode1.bn0_s')
  const t0 = map.get('encode1.bn0_t')
  return {
    get: (name) => map.get(name),
    bn0: s0 && t0 ? { s: s0, t: t0 } : null,
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

// bloco de entrada: in -> bn0 -> conv0 (bn1 dobrada; zero-padding DEPOIS da bn0, como no
// PyTorch) -> PReLU -> conv1 -> max(., t0) -> PReLU -> conv2
function denseBlockInput (tf, W, x) {
  return tf.tidy(() => {
    const a = W.get('encode1.alpha')
    const xin = W.bn0 ? tf.add(tf.mul(x, W.bn0.s), W.bn0.t) : x
    const t0 = conv(tf, xin, W.get('encode1.w0'), W.get('encode1.b0'))
    const t1 = conv(tf, prelu(tf, t0, a), W.get('encode1.w1'), W.get('encode1.b1'))
    const m = tf.maximum(t1, t0)
    return conv(tf, prelu(tf, m, a), W.get('encode1.w2'), W.get('encode1.b2'))
  })
}

// MaxUnpool2d(2,2) do PyTorch sem scatterND. O scatterND do backend WebGL do tfjs
// percorre TODAS as atualizações para cada texel de saída (O(saída × entrada): ~10¹³
// iterações no nível 256² — a GPU integrada trava/perde o contexto) e o
// maxPoolWithArgmax do WebGL desempata pelo ÚLTIMO máximo (shader com '>='), enquanto
// o PyTorch fica com o PRIMEIRO em ordem row-major. Aqui a posição do máximo é
// recalculada do próprio mapa de skip (que a U-Net guarda de qualquer forma): máscara
// one-hot do primeiro máximo em cada janela 2×2, na ordem (0,0),(0,1),(1,0),(1,1) — o
// mesmo desempate do PyTorch — e o valor volta ao lugar por depthToSpace.
function firstMaxMask (tf, skip) {
  return tf.tidy(() => {
    const [n, h, w, c] = skip.shape
    const q = (dy, dx) => tf.stridedSlice(skip, [0, dy, dx, 0], [n, h, w, c], [1, 2, 2, 1])
    const a00 = q(0, 0), a01 = q(0, 1), a10 = q(1, 0), a11 = q(1, 1)
    const m = tf.maximum(tf.maximum(a00, a01), tf.maximum(a10, a11))
    const e00 = tf.equal(a00, m)
    const e01 = tf.logicalAnd(tf.equal(a01, m), tf.logicalNot(e00))
    const got = tf.logicalOr(e00, e01)
    const e10 = tf.logicalAnd(tf.equal(a10, m), tf.logicalNot(got))
    const e11 = tf.logicalNot(tf.logicalOr(got, e10))
    // canais agrupados por (dy·2+dx)·c + canal — a ordem do depthToSpace NHWC
    return tf.concat([e00, e01, e10, e11].map(e => tf.cast(e, 'float32')), 3)
  })
}

function unpool (tf, x, skip) {
  return tf.tidy(() => tf.depthToSpace(tf.mul(tf.tile(x, [1, 1, 1, 4]), firstMaxMask(tf, skip)), 2, 'NHWC'))
}

/**
 * Forward de um lote de fatias.
 * @param x tf.Tensor [n,H,W,7] em [0,1] (H e W múltiplos de 16; 256 no conformado)
 * @returns tf.Tensor [n,H,W,classes] (logits)
 */
export function fsForward (tf, W, x) {
  return tf.tidy(() => {
    const skips = []
    let cur = x
    for (let i = 1; i <= 4; i++) {
      const blk = i === 1 ? denseBlockInput(tf, W, cur) : denseBlock(tf, W, `encode${i}`, cur)
      skips.push(blk)
      cur = tf.maxPool(blk, 2, 2, 'valid')
    }
    cur = denseBlock(tf, W, 'bottleneck', cur)
    for (let j = 0; j < 4; j++) {
      const lvl = 3 - j
      const merged = tf.maximum(unpool(tf, cur, skips[lvl]), skips[lvl])
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

// Lateralização do eval.py v1 (map_label2aparc_aseg → "Quick Fix"): estas 19 classes
// lh são trocadas para rh por componente 26-conexo quando o centroide do componente fica
// mais perto do hemisfério direito (1025/1028 entram na lista oficial mesmo tendo par
// rh na rede) …
const SPLIT_CC_V1 = [1003, 1006, 1007, 1008, 1009, 1011, 1015, 1018, 1019, 1020, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1034, 1035]
// … e estas 4 ("problematic classes", que cruzam a fissura inter-hemisférica) são
// depois redivididas VOXEL A VOXEL pelo hemisfério mais próximo.
const SPLIT_VOXEL_V1 = [1011, 1019, 1026, 1029]

/**
 * Tabela por classe (0..C-1) a partir do lut79 do manifesto (códigos FreeSurfer).
 * lado: 0 não-cortical · 1 E fixo · 2 D fixo · 3 por componente · 4 voxel a voxel
 */
function classTable (manifest) {
  const lut = manifest.lut79
  const cls2parcel = manifest.cls2parcel
  const codes = new Set(lut)
  const C = lut.length
  const parcel = new Uint8Array(C)
  const side = new Uint8Array(C)
  for (let c = 0; c < C; c++) {
    const code = lut[c]
    if (code < 1000 || code >= 3000) continue
    parcel[c] = cls2parcel[c][0]
    if (!parcel[c]) continue
    if (code >= 2000) side[c] = 2
    else if (SPLIT_VOXEL_V1.includes(code)) side[c] = 4
    else if (SPLIT_CC_V1.includes(code) || !codes.has(code + 1000)) side[c] = 3
    else side[c] = 1
  }
  return { C, parcel, side }
}

/**
 * Parcelação FastSurfer completa sobre o volume LIA, restrita à máscara de córtex.
 * Agrega logits das vistas (0,4·axial + 0,4·coronal + 0,2·sagital, como o run_network
 * do eval.py v1 — soma de logits, sem softmax) e resolve o argmax por voxel mascarado.
 * Dentro da máscara de córtex da segmentação-fonte o argmax é tomado só entre as
 * classes corticais (o "argmax sem fundo" do --parc do SynthSeg, que a fuseDKT
 * replica): um voxel que a rede chamaria de SB/fundo recebe a parcela mais provável
 * em vez de ficar para a propagação por vizinhança.
 * Devolve a parcela no espaço do modelo 104 do brainchop (1..34 = ctx-lh, 35..68 =
 * ctx-rh) — pronto para a fuseDKT. A lateralização das classes que a rede v1 não
 * separa segue o eval.py v1 (componente → hemisfério mais próximo; 4 classes da linha
 * média voxel a voxel); como só a fita cortical é inferida, os centroides dos
 * hemisférios vêm das classes corticais que a rede JÁ lateraliza (no oficial: maior
 * componente da SB E/D, e a divisão voxel a voxel usa a SB suavizada com σ = 3 mm; aqui,
 * o plano bissetor entre os dois centroides) — adaptação declarada. Com a fonte
 * SynthSeg o hemisfério final vem do próprio SynthSeg (fuseDKT); esta lateralização só
 * decide o lado na aseg compacta (córtex bilateral).
 *
 * Memória: acumulador Int16 só nos voxels mascarados (≈ 0,6 M × 79 × 2 B ≈ 95 MB),
 * nunca o volume 256³ × 79 × float32 (5,3 GB) do pipeline oficial.
 *
 * @param {object} p { tf, manifest, bins: {view: ArrayBuffer}, lia: Uint8Array,
 *                     dims, maskLia: Uint8Array, views: string[], batch, onProgress }
 * @returns {Promise<{parcLia: Uint8Array, stats: object}>}
 */
export async function runFastSurferParc ({ tf, manifest, bins, lia, dims, maskLia, views, batch = 2, onProgress = () => {} }) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const nxy = nx * ny
  // 4 níveis de pooling 2×2: cada lado precisa ser múltiplo de 16 (256 no conformado)
  if (dims.some(d => d % 16)) throw new Error(`FastSurfer exige volume conformado (lados múltiplos de 16), recebeu ${dims.join('×')}`)
  const { C, parcel: clsParcel } = classTable(manifest)
  let nMask = 0
  for (let v = 0; v < n; v++) if (maskLia[v]) nMask++
  if (!nMask) throw new Error('máscara de córtex vazia')
  const vlist = new Int32Array(nMask)
  for (let v = 0, i = 0; v < n; v++) if (maskLia[v]) vlist[i++] = v
  const acc = new Int16Array(nMask * C)
  // logits medidos nas 3 vistas em fatias reais: −18…+30; peso total das vistas = 1 →
  // |acc| ≤ 128·256 = 32767 cobre |z| até 128 com passo de 1/256 logit (antes 1/24, da
  // ordem das margens de empate); fora disso o acúmulo satura em vez de dar a volta
  const SCALE = 256
  const coord = (v, ax) => ax === 0 ? v % nx : ax === 1 ? ((v / nx) | 0) % ny : (v / nxy) | 0
  const dimOf = (ax) => ax === 0 ? nx : ax === 1 ? ny : nz
  const stride = [1, nx, nxy]

  const useViews = views.filter(v => VIEW_DEFS[v] && manifest.views[v] && bins[v])
  if (!useViews.length) throw new Error('nenhuma vista FastSurfer disponível')
  const wSum = useViews.reduce((s, v) => s + VIEW_DEFS[v].weight, 0)

  // voxels mascarados ordenados por fatia de cada vista (counting sort — CSR compacto)
  const perView = {}
  let totalSlices = 0
  for (const view of useViews) {
    const ax = VIEW_DEFS[view].axis
    const D = dimOf(ax)
    const start = new Int32Array(D + 1)
    for (let i = 0; i < nMask; i++) start[coord(vlist[i], ax) + 1]++
    for (let s = 0; s < D; s++) start[s + 1] += start[s]
    const fill = start.slice(0, D)
    const order = new Int32Array(nMask)
    for (let i = 0; i < nMask; i++) order[fill[coord(vlist[i], ax)]++] = i
    const slices = []
    for (let s = 0; s < D; s++) if (start[s + 1] > start[s]) slices.push(s)
    perView[view] = { start, order, slices }
    totalSlices += slices.length
  }

  let done = 0
  for (const view of useViews) {
    const def = VIEW_DEFS[view]
    const { start, order, slices } = perView[view]
    const W = buildViewWeights(tf, manifest.views[view], bins[view], manifest.dtype || 'float16')
    try {
      // 3 vistas: pesos oficiais 0,4/0,4/0,2; menos vistas: renormaliza para somar 1
      const wEff = useViews.length === 3 ? def.weight : def.weight / wSum
      const k = wEff * SCALE
      const H = dimOf(def.h)
      const Wd = dimOf(def.w)
      const D = dimOf(def.axis)
      const sh = stride[def.h], sw = stride[def.w], sa = stride[def.axis]
      const Cv = manifest.views[view].classes
      const map = view === 'sagittal' ? Int32Array.from(manifest.sag2full) : null
      if (map && map.length !== C) throw new Error('sag2full incompatível com o lut79')
      if (!map && Cv !== C) throw new Error(`vista ${view}: ${Cv} classes, esperado ${C}`)
      for (let si = 0; si < slices.length; si += batch) {
        const chunk = slices.slice(si, si + batch)
        // fatias espessas (get_thick_slices): canais s−3..s+3, borda replicada ('edge')
        const inArr = new Float32Array(chunk.length * H * Wd * 7)
        let q = 0
        for (const s of chunk) {
          const offT = []
          for (let t = -3; t <= 3; t++) offT.push(Math.max(0, Math.min(D - 1, s + t)) * sa)
          for (let hh = 0; hh < H; hh++) {
            for (let ww = 0; ww < Wd; ww++) {
              const base = hh * sh + ww * sw
              for (let t = 0; t < 7; t++) inArr[q++] = lia[base + offT[t]] / 255
            }
          }
        }
        const x = tf.tensor4d(inArr, [chunk.length, H, Wd, 7])
        let yd
        try {
          const y = fsForward(tf, W, x)
          try { yd = await y.data() } finally { y.dispose() }
        } finally { x.dispose() }
        for (let b = 0; b < chunk.length; b++) {
          const s = chunk[b]
          const base = b * H * Wd * Cv
          for (let kk = start[s]; kk < start[s + 1]; kk++) {
            const i = order[kk]
            const v = vlist[i]
            const o = base + (coord(v, def.h) * Wd + coord(v, def.w)) * Cv
            const ao = i * C
            for (let c = 0; c < C; c++) {
              const r = acc[ao + c] + Math.round(k * yd[o + (map ? map[c] : c)])
              acc[ao + c] = r > 32767 ? 32767 : r < -32768 ? -32768 : r
            }
          }
        }
        done += chunk.length
        onProgress(done / totalSlices, `FastSurfer ${view}: fatia ${Math.min(si + batch, slices.length)}/${slices.length}`)
        await new Promise(r => setTimeout(r, 0))
      }
    } finally {
      W.dispose()
    }
  }

  // argmax por voxel (restrito às classes corticais — ver acima)
  const cls = new Uint8Array(nMask)
  let agree = 0
  for (let i = 0; i < nMask; i++) {
    const ao = i * C
    let bAll = 0, vAll = -Infinity, bCtx = -1, vCtx = -Infinity
    for (let c = 0; c < C; c++) {
      const a = acc[ao + c]
      if (a > vAll) { vAll = a; bAll = c }
      if (clsParcel[c] && a > vCtx) { vCtx = a; bCtx = c }
    }
    if (clsParcel[bAll]) agree++
    cls[i] = bCtx
  }

  const lat = lateralizeFastSurfer(cls, vlist, dims, manifest)
  return {
    parcLia: lat.parcLia,
    stats: {
      maskVox: nMask,
      ctxVox: nMask,
      netCortexVox: agree, // voxels em que o argmax irrestrito da rede já era córtex
      ...lat.stats,
      slices: totalSlices,
      views: useViews
    }
  }
}

/**
 * Lateralização pós-argmax (eval.py v1 adaptado — ver runFastSurferParc).
 * @param {Uint8Array} cls   classe 0..C-1 escolhida por voxel mascarado
 * @param {Int32Array} vlist índices lineares (LIA, crescentes) dos voxels mascarados
 * @returns {{parcLia: Uint8Array, stats: {lhVox:number, rhVox:number, sharedRegions:number, midlineVox:number}}}
 */
export function lateralizeFastSurfer (cls, vlist, dims, manifest) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const nxy = nx * ny
  const nMask = vlist.length
  const { parcel: clsParcel, side: clsSide } = classTable(manifest)
  // centroides dos hemisférios a partir das classes que a rede já lateraliza
  const cen = [[0, 0, 0, 0], [0, 0, 0, 0]] // [E, D]: soma x, y, z, contagem
  for (let i = 0; i < nMask; i++) {
    const sd = clsSide[cls[i]]
    if (sd !== 1 && sd !== 2) continue
    const v = vlist[i], e = cen[sd - 1]
    e[0] += v % nx; e[1] += ((v / nx) | 0) % ny; e[2] += (v / nxy) | 0; e[3]++
  }
  let lhC, rhC
  if (cen[0][3] && cen[1][3]) {
    lhC = cen[0].slice(0, 3).map(s => s / cen[0][3])
    rhC = cen[1].slice(0, 3).map(s => s / cen[1][3])
  } else {
    // sem referência lateralizada: plano pelo centroide da máscara (eixo0 LIA → esquerda)
    let mx = 0
    for (let i = 0; i < nMask; i++) mx += vlist[i] % nx
    mx /= nMask
    lhC = [mx + 1, 0, 0]
    rhC = [mx - 1, 0, 0]
  }
  const closerRight = (x, y, z) =>
    (x - rhC[0]) ** 2 + (y - rhC[1]) ** 2 + (z - rhC[2]) ** 2 <
    (x - lhC[0]) ** 2 + (y - lhC[1]) ** 2 + (z - lhC[2]) ** 2

  const parcLia = new Uint8Array(n)
  const right = new Uint8Array(nMask)
  // mapa voxel → classe+1 (0 fora da máscara) para o flood-fill sem Map
  const clsVol = new Uint8Array(n)
  for (let i = 0; i < nMask; i++) clsVol[vlist[i]] = cls[i] + 1
  const idxOf = (v) => {
    // busca binária em vlist (ordenado) — evita um Int32Array de 256³
    let lo = 0, hi = nMask - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const m = vlist[mid]
      if (m === v) return mid
      if (m < v) lo = mid + 1; else hi = mid - 1
    }
    return -1
  }
  const visited = new Uint8Array(nMask)
  const stack = new Int32Array(nMask)
  let ccRegions = 0, voxSplit = 0
  for (let i = 0; i < nMask; i++) {
    const sd = clsSide[cls[i]]
    if (sd === 2) { right[i] = 1; continue }
    if (sd === 4) {
      const v = vlist[i]
      if (closerRight(v % nx, ((v / nx) | 0) % ny, (v / nxy) | 0)) right[i] = 1
      voxSplit++
      continue
    }
    if (sd !== 3 || visited[i]) continue
    // componente 26-conexo da mesma classe (label(connectivity=3) do skimage)
    const lab = cls[i] + 1
    let top = 0, cnt = 0, sx = 0, sy = 0, sz = 0
    stack[top++] = i
    visited[i] = 1
    const members = []
    while (top) {
      const j = stack[--top]
      members.push(j)
      const v = vlist[j]
      const x0 = v % nx, y0 = ((v / nx) | 0) % ny, z0 = (v / nxy) | 0
      sx += x0; sy += y0; sz += z0; cnt++
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy && !dz) continue
        const X = x0 + dx, Y = y0 + dy, Z = z0 + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
        const w = X + Y * nx + Z * nxy
        if (clsVol[w] !== lab) continue
        const jj = idxOf(w)
        if (visited[jj]) continue
        visited[jj] = 1
        stack[top++] = jj
      }
    }
    ccRegions++
    if (closerRight(sx / cnt, sy / cnt, sz / cnt)) for (const j of members) right[j] = 1
  }
  let lhVox = 0, rhVox = 0
  for (let i = 0; i < nMask; i++) {
    const p = clsParcel[cls[i]]
    parcLia[vlist[i]] = right[i] ? p + 34 : p
    if (right[i]) rhVox++; else lhVox++
  }
  return { parcLia, stats: { lhVox, rhVox, sharedRegions: ccRegions, midlineVox: voxSplit } }
}

/**
 * Reorienta o volume conformado (256³) para LIA a partir da affine (voxel→mm RAS,
 * row-major 16). Sem reamostrar — só permutação/flip; devolve também o mapa inverso.
 * LIA: eixo0→Esquerda (−x), eixo1→Inferior (−z), eixo2→Anterior (+y).
 */
export function toLIA (img, dims, affine, withBack = true) {
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
  // mapa LIA→original (índice linear) para trazer o resultado de volta (67 MB em
  // 256³ — dispensável para a máscara, que não volta)
  const back = withBack ? new Int32Array(img.length) : null
  let p = 0
  for (let i2 = 0; i2 < nd[2]; i2++) {
    const o2 = (sign[2] > 0 ? i2 : nd[2] - 1 - i2) * s2
    for (let i1 = 0; i1 < nd[1]; i1++) {
      const o1 = (sign[1] > 0 ? i1 : nd[1] - 1 - i1) * s1
      for (let i0 = 0; i0 < nd[0]; i0++, p++) {
        const src = (sign[0] > 0 ? i0 : nd[0] - 1 - i0) * s0 + o1 + o2
        out[p] = img[src]
        if (back) back[p] = src
      }
    }
  }
  return { img: out, dims: nd, back }
}
