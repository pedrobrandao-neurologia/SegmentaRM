// reconsurf.worker.js — superfícies corticais no fluxo do recon-all-clinical
// (Gopinath et al., MedIA 2025), replicando a ordem do recon-all-clinical.sh:
//   máscaras wm.seg/filled a partir da segmentação (regras exatas do
//   mri_synth_surf.py) → partição hemisférica por EDT → SDFs white/pial
//   (rede SynthDist, se instalada, ou EDT das máscaras — fallback declarado) →
//   tesselação (surface nets ≈ mri_tessellate) → colocação pela energia da
//   Eq. 5 (λ1=6e-4, λ2=2e-4, nsmooth 5 na white como no script) → pial a partir
//   da white com repulsão (--repulse-surf) → χ de Euler como QC (defeitos
//   relatados, não corrigidos — mris_fix_topology não é portável) → parcelas por
//   amostragem (≈ sample_parc; sem sphere.reg/mris_ca_label) → espessura
//   Fischl–Dale com teto de 5 mm (mris_place_surface --thickness ... 20 5) →
//   área (SurfArea) e volume cinzento (GrayVol, -th3) por vértice da white →
//   imagem sintética norm (fórmula exata) e Talairach por COGs.
// Memória: todo o processamento roda numa CAIXA em torno do encéfalo (rótulos
// lateralizados + margem de 8 voxels, ~⅓ do volume 256³) e as SDFs por EDT são
// calculadas por hemisfério, sob demanda — no pico há ~4 Float32 do tamanho da
// caixa em vez de ~6 Float32 de 256³ (≈ 400 MB) da versão anterior.
// Mensagem: { seg, dims, affine (flat16), labels, colormap, voxVol,
//             engine: 'edt'|'net', img?, modelUrl?, isGPU?, tile? }
// Resposta: { cmd:'done', meshes, stats, euler, aviso, talairach, xfm, norm, engineUsed }

import {
  surfaceNets, taubinSmooth, applyAffine, writeMz3, wellComposed,
  spacingOfAffine, facesForAffine, vertexAreas, vertexVolumesTH3
} from '../lib/surfaces.js'
import { dilate6, erode6, largestComponent, fillCavities } from '../lib/fsl-prep.js'
import {
  signedSdfFromMask, hemispherePartition, accumulateSyntheticNorm, maskByDilatedSeg,
  buildNeighbors, eulerCharacteristic, placeSurface, smoothMesh,
  talairachFromSeg, talairachXfm, escolheCanaisSdf
} from '../lib/sdf-surface.js'

function post (frac, txt) { self.postMessage({ cmd: 'progress', frac, txt }) }

// classifica cada rótulo pelo NOME — cerebelo, tronco e CSF ficam de fora,
// exatamente como o mri_synth_surf.py os elimina antes de wm.seg/filled
function classify (labels) {
  const cls = {}
  for (const [idx, name] of Object.entries(labels)) {
    const i = +idx
    let hemi = 0
    if (/^Left-|^ctx-lh-/.test(name)) hemi = 1
    else if (/^Right-|^ctx-rh-/.test(name)) hemi = 2
    let kind = null
    if (/Cerebral-White-Matter/.test(name)) kind = 'wm'
    else if (/^ctx-(lh|rh)-/.test(name)) kind = 'ctx'
    else if (/Cerebral-Cortex/.test(name)) kind = 'ctx0'
    else if (/Lateral-Ventricle|Inf-Lat-Vent|choroid/i.test(name)) kind = 'vent'
    else if (/Thalamus|Caudate|Putamen|Pallidum|Hippocampus|Amygdala|Accumbens|VentralDC|vessel/i.test(name)) kind = 'sub'
    if (kind) cls[i] = { kind, hemi, name }
  }
  return cls
}

// alinhamento de eixos à orientação RAS identidade (permutação/flip pela affine,
// sem reamostragem) — a rede SynthDist exige entrada RAS como o SynthSR
function rasAxisMap (affine) {
  const A = [[affine[0], affine[1], affine[2]], [affine[4], affine[5], affine[6]], [affine[8], affine[9], affine[10]]]
  const perm = [0, 0, 0]
  const flip = [1, 1, 1]
  const used = new Set()
  for (let w = 0; w < 3; w++) {
    let best = -1, bi = -1
    for (let a = 0; a < 3; a++) {
      if (used.has(a)) continue
      if (Math.abs(A[w][a]) > best) { best = Math.abs(A[w][a]); bi = a }
    }
    used.add(bi)
    perm[w] = bi
    flip[w] = A[w][bi] < 0 ? -1 : 1
  }
  return { perm, flip }
}

// caixa {o, d} (origem e tamanho em voxels) em torno dos voxels com lut[seg] ≠ 0
function boxOf (seg, dims, lut, margin) {
  const [nx, ny, nz] = dims
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1
  for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) {
    if (!lut[seg[v]]) continue
    if (i < x0) x0 = i; if (i > x1) x1 = i
    if (j < y0) y0 = j; if (j > y1) y1 = j
    if (k < z0) z0 = k; if (k > z1) z1 = k
  }
  if (x1 < 0) return null
  const lo = [x0, y0, z0].map(a => Math.max(0, a - margin))
  const hi = [x1, y1, z1].map((a, w) => Math.min(dims[w] - 1, a + margin))
  return { o: lo, d: [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1] }
}

function cropU8 (vol, dims, box) {
  const [nx, ny] = dims
  const [bx, by, bz] = box.d
  const out = new Uint8Array(bx * by * bz)
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) {
    const src = box.o[0] + (box.o[1] + j) * nx + (box.o[2] + k) * nx * ny
    out.set(vol.subarray(src, src + bx), (j + k * by) * bx)
  }
  return out
}

// affine da caixa: índice local + origem da caixa → mm (translação deslocada)
function shiftAffine (A, o) {
  const B = Array.from(A)
  for (let r = 0; r < 3; r++) B[r * 4 + 3] = A[r * 4 + 3] + A[r * 4] * o[0] + A[r * 4 + 1] * o[1] + A[r * 4 + 2] * o[2]
  return B
}

// SDFs pela rede SynthDist (pesos convertidos — models/synthsurf): recorte à caixa
// do encéfalo (+4 voxels de contexto) já na orientação RAS, blocos 96³ com
// sobreposição e recorte central, ≥ 4 canais de saída (0..3 = SDFs dos dois
// hemisférios; a atribuição white/pial é decidida pelo próprio exame — ver o
// bloco no fim desta função). Devolve as 4 SDFs indexadas na CAIXA (ordem original).
async function netSdfs (img, dims, affine, box, ctxE, ctxD, ctxAll, modelUrl, isGPU, tile) {
  const tf = await import('../vendor/tf.fesm.min.js')
  const { registerUpSampling3D } = await import('../lib/tfjs-upsampling3d.js')
  registerUpSampling3D(tf)
  if (isGPU && typeof OffscreenCanvas !== 'undefined') {
    // setBackend devolve false (não lança) quando a WebGL não inicializa
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu')
  } else await tf.setBackend('cpu')
  await tf.enableProdMode()
  await tf.ready()
  post(0.06, `SynthDist: backend ${tf.getBackend()}, carregando a rede…`)
  const model = await tf.loadLayersModel(modelUrl)
  try {
    const [nx, ny, nz] = dims
    // normalização min–max GLOBAL (como o oficial), depois recorte
    let mn = Infinity, mx = -Infinity
    for (let i = 0; i < img.length; i++) { const v = img[i]; if (v < mn) mn = v; if (v > mx) mx = v }
    const sc = mx > mn ? 1 / (mx - mn) : 1
    const { perm, flip } = rasAxisMap(affine)
    const od = [dims[perm[0]], dims[perm[1]], dims[perm[2]]] // dimensões na grade RAS
    // caixa da rede = caixa de trabalho + 4 voxels de contexto, levada à grade RAS
    const EX = 4
    const nlo = box.o.map(a => Math.max(0, a - EX))
    const nhi = box.o.map((a, w) => Math.min(dims[w] - 1, a + box.d[w] - 1 + EX))
    const r0 = [0, 0, 0], cd = [0, 0, 0]
    for (let w = 0; w < 3; w++) {
      const a = perm[w]
      r0[w] = flip[w] > 0 ? nlo[a] : od[w] - 1 - nhi[a]
      cd[w] = nhi[a] - nlo[a] + 1
    }
    // índice original de um voxel RAS (I,J,K)
    const src = [0, 0, 0]
    const origIdx = (I, J, K) => {
      const c = [I, J, K]
      for (let w = 0; w < 3; w++) src[perm[w]] = flip[w] > 0 ? c[w] : od[w] - 1 - c[w]
      return src[0] + src[1] * nx + src[2] * nx * ny
    }
    const crop = new Float32Array(cd[0] * cd[1] * cd[2])
    for (let k = 0; k < cd[2]; k++) for (let j = 0; j < cd[1]; j++) for (let i = 0; i < cd[0]; i++) {
      crop[i + j * cd[0] + k * cd[0] * cd[1]] = (img[origIdx(r0[0] + i, r0[1] + j, r0[2] + k)] - mn) * sc
    }
    // blocos T³ / sobreposição 32, saída 4 canais úteis
    // sobreposição ≤ metade do bloco: com T ≤ 32 o passo seria 0 (laço infinito)
    const T = tile, OV = Math.min(32, 2 * Math.floor(T / 4)), step = T - OV, h = OV / 2
    const starts = (n) => { const s = []; for (let v = 0; ; v += step) { if (v + T >= n) { s.push(Math.max(0, n - T)); break } s.push(v) } return [...new Set(s)] }
    const XS = starts(cd[0]), YS = starts(cd[1]), ZS = starts(cd[2])
    const total = XS.length * YS.length * ZS.length
    const outC = [0, 1, 2, 3].map(() => new Float32Array(crop.length))
    const tx = Math.min(T, cd[0]), ty = Math.min(T, cd[1]), tz = Math.min(T, cd[2])
    let done = 0
    for (const zc of ZS) for (const yc of YS) for (const xc of XS) {
      const inp = new Float32Array(T * T * T)
      for (let k = 0; k < tz; k++) for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
        inp[i + j * T + k * T * T] = crop[(xc + i) + (yc + j) * cd[0] + (zc + k) * cd[0] * cd[1]]
      }
      // o bloco chega x-mais-rápido ([z][y][x]); a rede foi treinada com x mais lento
      let yd, nc
      const tens = []
      try {
        const zyx = tf.tensor5d(inp, [1, T, T, T, 1]); tens.push(zyx)
        const xyz = zyx.transpose([0, 3, 2, 1, 4]); tens.push(xyz)
        const yOut = model.predict(xyz); tens.push(yOut)
        const yZyx = yOut.transpose([0, 3, 2, 1, 4]); tens.push(yZyx) // [1, z, y, x, C]
        nc = yZyx.shape[4]
        if (!(nc >= 4)) throw new Error(`a rede devolveu ${nc} canais; o SynthDist precisa de ≥ 4 (SDFs white/pial dos dois hemisférios)`)
        yd = await yZyx.data()
      } finally { tf.dispose(tens) }
      const lo = (s) => s === 0 ? 0 : h
      const hi = (s, t2, n2) => (s + T >= n2) ? Math.min(t2, n2 - s) : T - h
      for (let k = lo(zc); k < hi(zc, tz, cd[2]); k++) for (let j = lo(yc); j < hi(yc, ty, cd[1]); j++) for (let i = lo(xc); i < hi(xc, tx, cd[0]); i++) {
        const gi = (xc + i) + (yc + j) * cd[0] + (zc + k) * cd[0] * cd[1]
        const s0 = ((k * T + j) * T + i) * nc
        for (let c = 0; c < 4; c++) outC[c][gi] = yd[s0 + c]
      }
      done++
      post(0.08 + 0.5 * done / total, done === total ? 'SynthDist: blocos concluídos.' : '')
      await new Promise(r => setTimeout(r, 0))
    }
    // leva cada canal à caixa de trabalho (ordem original); fora da caixa da rede,
    // +5 = longe da superfície. Valores não finitos também viram +5 (e são contados)
    const [bx, by, bz] = box.d
    let naoFinitos = 0
    const sdfs = outC.map(ch => {
      const out = new Float32Array(bx * by * bz)
      const c = [0, 0, 0]
      for (let k = 0, v = 0; k < bz; k++) for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++, v++) {
        const s = [box.o[0] + i, box.o[1] + j, box.o[2] + k]
        let inside = true
        for (let w = 0; w < 3; w++) {
          const a = perm[w]
          c[w] = (flip[w] > 0 ? s[a] : od[w] - 1 - s[a]) - r0[w]
          if (c[w] < 0 || c[w] >= cd[w]) inside = false
        }
        let val = inside ? ch[c[0] + c[1] * cd[0] + c[2] * cd[0] * cd[1]] : 5
        if (!Number.isFinite(val)) { val = 5; naoFinitos++ }
        out[v] = val
      }
      return out
    })
    if (naoFinitos) post(0.59, `SynthDist: AVISO — ${naoFinitos.toLocaleString('pt-BR')} valores não finitos na saída da rede (tratados como fora da superfície).`)
    // Ordem dos canais decidida pelo próprio exame (ver escolheCanaisSdf).
    const esc = escolheCanaisSdf(sdfs, ctxE, ctxD, ctxAll)
    const me = esc.medidas.e, md = esc.medidas.d
    post(0.6, `SynthDist: média da SDF no córtex — E white ${me.W.toFixed(2)} / pial ${me.P.toFixed(2)} mm · D white ${md.W.toFixed(2)} / pial ${md.P.toFixed(2)} mm.`)
    post(0.6, esc.esperado
      ? 'SynthDist: canais conferidos no exame (white = 1 e 3, pial = 0 e 2).'
      : `SynthDist: ATENÇÃO — a ordem dos canais neste checkpoint difere da medida nos pesos v10 (white detectada em ${esc.ordem.e} e ${esc.ordem.d}); seguindo o que o exame indica.`)
    return { lhW: esc.lhW, lhP: esc.lhP, rhW: esc.rhW, rhP: esc.rhP }
  } finally {
    model.dispose()
  }
}

self.onmessage = async (ev) => {
  let diag = null
  try {
    const data = ev.data
    const { seg, dims, affine, labels, colormap, voxVol = 1, engine = 'edt', modelUrl = null, isGPU = true, tile = 96 } = data
    let img = data.img || null
    data.img = null // a imagem só serve à rede: solta a referência assim que possível
    const [nx, ny] = dims
    const n = nx * ny * dims[2]
    const cls = classify(labels)
    const affRows = [0, 1, 2, 3].map(r => affine.slice(r * 4, r * 4 + 4))
    const sp = spacingOfAffine(affine) // mm por voxel em cada eixo
    const iso1 = sp.every(s => Math.abs(s - 1) < 0.02)
    if (!iso1) post(0.01, `Grade de ${sp.map(s => s.toFixed(2)).join('×')} mm: EDT, SDF, colocação e medidas em mm (voxel anisotrópico/não unitário).`)

    // tabelas por índice de rótulo (seg é Uint8Array)
    const KIND = { wm: 1, ctx: 2, ctx0: 3, vent: 4, sub: 5 }
    const kindL = new Uint8Array(256)
    const hemiL = new Uint8Array(256)
    const latL = new Uint8Array(256) // sementes da partição: qualquer rótulo lateralizado (inclui cerebelo, como o L/R do mri_synth_surf.py)
    for (const [idx, name] of Object.entries(labels)) {
      const i = +idx
      if (!(i >= 0 && i < 256)) continue
      if (/^Left-|^ctx-lh-/.test(name)) latL[i] = 1
      else if (/^Right-|^ctx-rh-/.test(name)) latL[i] = 2
      const c = cls[i]
      if (c) { kindL[i] = KIND[c.kind]; hemiL[i] = c.hemi }
    }

    post(0.02, 'Separando hemisférios (EDT dos rótulos lateralizados, como no filled.mgz)…')
    let lxn = 0, rxn = 0, ctx0n = 0, wmn = 0
    for (let v = 0; v < n; v++) {
      const s = seg[v]
      const k = kindL[s]
      if (!k) continue
      if (k === KIND.ctx) { if (hemiL[s] === 1) lxn++; else if (hemiL[s] === 2) rxn++ }
      else if (k === KIND.ctx0) ctx0n++
      else if (k === KIND.wm) wmn++
    }
    diag = { cortexParceladoE_vox: lxn, cortexParceladoD_vox: rxn, cortexSemParcela_vox: ctx0n, substanciaBranca_vox: wmn, rotulosClassificaveis: Object.keys(cls).length, espacamento_mm: sp }
    if (!lxn && !rxn) {
      throw new Error('nenhum voxel de córtex parcelado (ctx-lh-*/ctx-rh-*) na segmentação atual' +
        (ctx0n ? ` — há ${ctx0n.toLocaleString('pt-BR')} voxels de córtex SEM parcela, sinal de que o passo 04 (DKT) não parcelou ou de que a segmentação foi refeita depois dele; re-rode o passo 04` : ' — a segmentação atual não tem córtex classificável; refaça os passos 03 (segmentação) e 04 (DKT)'))
    }
    let aviso = null
    if (!lxn || !rxn) {
      const okPt = lxn ? 'esquerdo' : 'direito'
      aviso = `córtex parcelado só no hemisfério ${okPt} — malhas dos dois lados, mas espessura/área/volume só do ${okPt}; re-rode o passo 04 para recuperar o outro`
      post(0.03, 'AVISO: ' + aviso)
    }

    // Talairach no volume inteiro (usa também cerebelo/tronco, fora da caixa)
    post(0.03, 'Transformada de Talairach por centros de massa (getM)…')
    const tal = talairachFromSeg(seg, dims, affRows, labels)

    // caixa de trabalho: rótulos lateralizados + classificáveis, margem 8 (> recorte
    // de 5 mm da SDF + 1, > dilatação de 3 do norm) — fora dela nada muda
    const inBox = new Uint8Array(256)
    for (let i = 0; i < 256; i++) inBox[i] = (latL[i] || kindL[i]) ? 1 : 0
    const MARGIN = Math.ceil(8 / Math.min(...sp))
    const box = boxOf(seg, dims, inBox, MARGIN)
    const bd = box.d
    const nB = bd[0] * bd[1] * bd[2]
    const AB = shiftAffine(affine, box.o)
    const segB = cropU8(seg, dims, box)
    diag.caixa = { origem: box.o, dims: bd }

    // partição hemisférica e máscara da segmentação (para o norm) na caixa
    const segMask = new Uint8Array(nB)
    let side
    {
      const leftSeeds = new Uint8Array(nB)
      const rightSeeds = new Uint8Array(nB)
      for (let v = 0; v < nB; v++) {
        const s = segB[v]
        if (kindL[s]) segMask[v] = 1
        if (latL[s] === 1) leftSeeds[v] = 1
        else if (latL[s] === 2) rightSeeds[v] = 1
      }
      side = hemispherePartition(leftSeeds, rightSeeds, bd, sp) // 1 = E
    }

    post(0.05, 'Montando máscaras wm.seg/pial por hemisfério (regras do mri_synth_surf)…')
    const white = [new Uint8Array(nB), new Uint8Array(nB)]
    const pial = [new Uint8Array(nB), new Uint8Array(nB)]
    const ctxMask = new Uint8Array(nB)
    const ctxH = [new Uint8Array(nB), new Uint8Array(nB)]
    for (let v = 0; v < nB; v++) {
      const s = segB[v]
      const k = kindL[s]
      if (!k) continue
      const hm = hemiL[s]
      const hi = (hm === 1 || (hm === 0 && side[v])) ? 0 : 1
      if (k === KIND.wm || k === KIND.vent || k === KIND.sub) { white[hi][v] = 1; pial[hi][v] = 1 }
      else { pial[hi][v] = 1; if (k === KIND.ctx) { ctxMask[v] = 1; ctxH[hi][v] = 1 } }
    }

    // SDFs — rede SynthDist (se instalada) ou EDT das máscaras (fallback declarado)
    let net = null
    let engineUsed = 'edt'
    if (engine === 'net' && modelUrl && img) {
      if (!iso1) {
        post(0.06, `Rede SynthDist exige grade de 1 mm (esta tem ${sp.map(s => s.toFixed(2)).join('×')} mm) — usando SDF por EDT das máscaras.`)
      } else {
        try {
          net = await netSdfs(img, dims, affine, box, ctxH[0], ctxH[1], ctxMask, modelUrl, isGPU, tile)
          engineUsed = 'net'
        } catch (e) {
          post(0.06, `Rede SynthDist indisponível (${e.message}) — usando SDF por EDT das máscaras.`)
        }
      }
    }
    img = null
    if (!net) post(0.1, 'SDFs por EDT exata das máscaras (±5 mm, negativa por dentro), por hemisfério…')

    // amostrador de parcela (≈ sample_parc): rótulo de córtex mais próximo (em mm)
    // até 2 voxels — deslocamentos em ordem de distância, sem viés de varredura
    const OFFS = []
    for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      OFFS.push([dx, dy, dz, (dx * sp[0]) ** 2 + (dy * sp[1]) ** 2 + (dz * sp[2]) ** 2])
    }
    OFFS.sort((a, b) => a[3] - b[3])
    const parcelAt = (x0, y0, z0) => {
      for (const [dx, dy, dz] of OFFS) {
        const X = x0 + dx, Y = y0 + dy, Z = z0 + dz
        if (X < 0 || Y < 0 || Z < 0 || X >= bd[0] || Y >= bd[1] || Z >= bd[2]) continue
        const s2 = segB[X + Y * bd[0] + Z * bd[0] * bd[1]]
        if (kindL[s2] === KIND.ctx) return s2
      }
      return 0
    }

    const acc = new Map()
    const accOf = (i) => {
      let a = acc.get(i)
      if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0, area: 0, gray: 0 }; acc.set(i, a) }
      return a
    }
    for (let v = 0; v < nB; v++) if (ctxMask[v]) accOf(segB[v]).nvox++

    const cmIdx = new Map()
    if (colormap && colormap.I) for (let q = 0; q < colormap.I.length; q++) cmIdx.set(colormap.I[q], q)

    const normB = new Float32Array(nB)
    const meshes = []
    const euler = {}
    const names = ['esquerdo', 'direito']
    for (let h = 0; h < 2; h++) {
      const base = 0.38 + h * 0.28
      // SDFs deste hemisfério (as do outro já foram liberadas)
      let W, P
      if (net) {
        W = h === 0 ? net.lhW : net.rhW
        P = h === 0 ? net.lhP : net.rhP
        if (h === 0) { net.lhW = null; net.lhP = null } else { net.rhW = null; net.rhP = null }
      } else {
        post(base - 0.02, `Hemisfério ${names[h]}: SDFs white/pial por EDT…`)
        W = signedSdfFromMask(white[h], bd, 5, sp)
        P = signedSdfFromMask(pial[h], bd, 5, sp)
      }
      // norm sintético do lado deste hemisfério (fórmula do mri_synth_surf)
      accumulateSyntheticNorm(normB, W, P, side, h === 0 ? 1 : 0)

      post(base, `Hemisfério ${names[h]}: pretess + tesselação (surface nets)…`)
      // pretess/extract_main_component: fecha, maior componente, contatos só por
      // aresta/vértice desfeitos (malha variedade — senão o χ mede artefato), cavidades
      let w = erode6(dilate6(white[h], bd), bd)
      white[h] = null
      largestComponent(w, bd)
      wellComposed(w, bd)
      fillCavities(w, bd)
      const t0 = surfaceNets(w, bd)
      w = null
      if (!t0.verts.length) { pial[h] = null; continue }
      const wv = taubinSmooth(t0.verts, t0.faces, 4)
      const faces = t0.faces
      const neigh = buildNeighbors(wv.length / 3, faces)
      const chi = eulerCharacteristic(wv.length / 3, faces, neigh.nEdges)
      euler[(h === 0 ? 'lh' : 'rh')] = chi
      if (chi !== 2) post(base + 0.02, `AVISO: hemisfério ${names[h]} com χ de Euler = ${chi} (defeitos topológicos NÃO corrigidos — sem mris_fix_topology).`)

      post(base + 0.05, `Hemisfério ${names[h]}: colocando a white na SDF (Eq. 5, nsmooth 5)…`)
      // --nsmooth 5 do mris_place_surface suaviza a superfície de ENTRADA (orig)
      // antes da colocação (MRISaverageVertexPositions); suavizar depois tiraria a
      // white do nível zero (encolhimento de ~0,3 mm nas cristas)
      smoothMesh(wv, faces, 5, 0.5, neigh)
      const rw = placeSurface(wv, faces, W, bd, { spacing: sp, neigh, onIter: (it) => { if (it % 25 === 0) post(base + 0.05 + 0.04 * Math.min(1, it / 100), '') } })
      post(base + 0.12, `Hemisfério ${names[h]}: white em ${rw.iters} iterações; colocando a pial (repulsão da white)…`)
      const pv = Float32Array.from(wv)
      const rp = placeSurface(pv, faces, P, bd, { repulse: W, spacing: sp, neigh, onIter: (it) => { if (it % 25 === 0) post(base + 0.12 + 0.06 * Math.min(1, it / 120), '') } })
      W = null; P = null; pial[h] = null
      if (rw.naoFinitos || rp.naoFinitos) post(base + 0.19, `AVISO: hemisfério ${names[h]} — ${rw.naoFinitos + rp.naoFinitos} passos com SDF não finita ignorados na colocação.`)
      post(base + 0.2, `Hemisfério ${names[h]}: pial em ${rp.iters} iterações; parcelas, cores e espessura…`)

      // parcelas por vértice: rótulo DKT amostrado no meio da espessura (entre o
      // vértice da white e o da pial correspondente), onde a fita cortical está
      const nV = wv.length / 3
      const vertParcel = new Int32Array(nV)
      for (let vi = 0; vi < nV; vi++) {
        const i3 = vi * 3
        vertParcel[vi] = parcelAt(Math.round((wv[i3] + pv[i3]) / 2), Math.round((wv[i3 + 1] + pv[i3 + 1]) / 2), Math.round((wv[i3 + 2] + pv[i3 + 2]) / 2))
      }
      // medidas em mm (affine da caixa): área e GrayVol por vértice da WHITE,
      // como o mris_anatomical_stats -th3 (aparc.stats usa a white)
      const wmm = applyAffine(wv, AB)
      const pmm = applyAffine(pv, AB)
      const vArea = vertexAreas(wmm, faces)
      const vVol = vertexVolumesTH3(wmm, pmm, faces)
      // espessura Fischl–Dale com correspondência + vértice mais próximo; como no
      // MRISmeasureCorticalThickness, o teto de 5 mm vale para CADA sentido antes
      // da média: T = ½[min(d(w→p), 5) + min(d(p→w), 5)]
      const CELL = 4
      const grid = (verts) => {
        const g = new Map()
        for (let i = 0; i < verts.length; i += 3) {
          const key = `${Math.floor(verts[i] / CELL)},${Math.floor(verts[i + 1] / CELL)},${Math.floor(verts[i + 2] / CELL)}`
          let b = g.get(key)
          if (!b) { b = []; g.set(key, b) }
          b.push(i)
        }
        return g
      }
      const nearest = (g, verts, px, py, pz) => {
        const cx2 = Math.floor(px / CELL), cy2 = Math.floor(py / CELL), cz2 = Math.floor(pz / CELL)
        let best = Infinity
        for (let ring = 0; ring <= 2; ring++) {
          for (let dz = -ring; dz <= ring; dz++) for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue
            const b = g.get(`${cx2 + dx},${cy2 + dy},${cz2 + dz}`)
            if (!b) continue
            for (const q of b) {
              const d2 = (verts[q] - px) ** 2 + (verts[q + 1] - py) ** 2 + (verts[q + 2] - pz) ** 2
              if (d2 < best) best = d2
            }
          }
          if (best <= (ring * CELL) ** 2) break
        }
        return Math.sqrt(best)
      }
      const gP = grid(pmm)
      const gW = grid(wmm)
      for (let vi = 0; vi < nV; vi++) {
        const parc = vertParcel[vi]
        if (!parc) continue
        const a = accOf(parc)
        a.area += vArea[vi]
        a.gray += vVol[vi]
        const i3 = vi * 3
        const dWP = Math.min(nearest(gP, pmm, wmm[i3], wmm[i3 + 1], wmm[i3 + 2]),
          Math.hypot(pmm[i3] - wmm[i3], pmm[i3 + 1] - wmm[i3 + 1], pmm[i3 + 2] - wmm[i3 + 2]))
        const dPW = nearest(gW, wmm, pmm[i3], pmm[i3 + 1], pmm[i3 + 2])
        if (!Number.isFinite(dWP) || !Number.isFinite(dPW)) continue
        const t = 0.5 * (Math.min(5, dWP) + Math.min(5, dPW))
        a.sum += t; a.sum2 += t * t; a.nT++
      }
      // malhas de saída (mz3, pial colorida pelas parcelas dos vértices); faces com
      // as normais para FORA no espaço RAS (a conformação LIA tem det < 0)
      const rgba = new Uint8Array(nV * 4)
      for (let vi = 0; vi < nV; vi++) {
        const q = vertParcel[vi] && cmIdx.has(vertParcel[vi]) ? cmIdx.get(vertParcel[vi]) : -1
        const o = vi * 4
        if (q >= 0) { rgba[o] = colormap.R[q]; rgba[o + 1] = colormap.G[q]; rgba[o + 2] = colormap.B[q]; rgba[o + 3] = 255 } else { rgba[o] = 120; rgba[o + 1] = 120; rgba[o + 2] = 126; rgba[o + 3] = 255 }
      }
      const fOut = facesForAffine(faces, AB)
      meshes.push({ name: `${h === 0 ? 'lh' : 'rh'}.white`, kind: 'white', hemi: h === 0 ? 'E' : 'D', mz3: writeMz3(wmm, fOut, null) })
      meshes.push({ name: `${h === 0 ? 'lh' : 'rh'}.pial`, kind: 'pial', hemi: h === 0 ? 'E' : 'D', mz3: writeMz3(pmm, fOut, rgba) })
    }

    // norm: mascarado pela segmentação dilatada (r = 3 mm) e devolvido no volume inteiro
    post(0.95, 'Imagem sintética norm (córtex super-resolvido, fórmula do mri_synth_surf)…')
    maskByDilatedSeg(normB, segMask, bd, 3, sp)
    const norm = new Float32Array(n)
    for (let k = 0; k < bd[2]; k++) for (let j = 0; j < bd[1]; j++) {
      const dst = box.o[0] + (box.o[1] + j) * nx + (box.o[2] + k) * nx * ny
      const srcI = (j + k * bd[1]) * bd[0]
      norm.set(normB.subarray(srcI, srcI + bd[0]), dst)
    }

    const stats = []
    for (const [idx, a] of acc) {
      if (!a.nT) continue
      const name = labels[idx]
      const mean = a.sum / a.nT
      const sd = Math.sqrt(Math.max(0, a.sum2 / a.nT - mean * mean))
      stats.push({
        label: +idx,
        name,
        hemi: /-lh-/.test(name) ? 'E' : 'D',
        base: name.replace(/^ctx-(lh|rh)-/, ''),
        thickAvg: +mean.toFixed(2),
        thickStd: +sd.toFixed(2),
        area_mm2: +a.area.toFixed(1),
        volume_mm3: +(a.nvox * voxVol).toFixed(1), // contagem de voxels (como o aseg)
        grayVol_mm3: +a.gray.toFixed(1), // entre white e pial (GrayVol do aparc.stats)
        nVert: a.nT
      })
    }
    stats.sort((a, b) => a.base === b.base ? a.hemi.localeCompare(b.hemi) : a.base.localeCompare(b.base))
    post(0.98, `Superfícies recon-clinical prontas: ${meshes.length} malhas, ${stats.length} regiões (motor ${engineUsed === 'net' ? 'rede SynthDist' : 'SDF por EDT'}).`)
    self.postMessage({
      cmd: 'done',
      meshes,
      stats,
      aviso,
      euler,
      engineUsed,
      talairach: tal ? { M: tal.M, nUsed: tal.nUsed } : null,
      xfm: tal ? talairachXfm(tal.M) : null,
      norm
    }, [...meshes.map(m => m.mz3), norm.buffer])
  } catch (e) {
    self.postMessage({ cmd: 'error', message: e && e.message ? e.message : String(e), diag })
  }
}
