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
//   imagem sintética norm (fórmula exata) e Talairach por COGs.
// Mensagem: { seg, dims, affine (flat16), labels, colormap, voxVol,
//             engine: 'edt'|'net', img?, modelUrl?, isGPU?, tile? }
// Resposta: { cmd:'done', meshes, stats, euler, aviso, talairach, xfm, norm, engineUsed }

import { surfaceNets, taubinSmooth, meshAreas, applyAffine, writeMz3 } from '../lib/surfaces.js'
import { dilate6, erode6, largestComponent, fillCavities } from '../lib/fsl-prep.js'
import {
  signedSdfFromMask, hemispherePartition, accumulateSyntheticNorm, maskByDilatedSeg,
  buildNeighbors, eulerCharacteristic, trilinear, placeSurface, smoothMesh,
  talairachFromSeg, talairachXfm
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

function permuteToRAS (vol, dims, map, Ctor = Float32Array) {
  const { perm, flip } = map
  const od = [dims[perm[0]], dims[perm[1]], dims[perm[2]]]
  const out = new Ctor(vol.length)
  const st = [1, dims[0], dims[0] * dims[1]]
  for (let k = 0; k < od[2]; k++) for (let j = 0; j < od[1]; j++) for (let i = 0; i < od[0]; i++) {
    const c = [i, j, k]
    const src = [0, 0, 0]
    for (let w = 0; w < 3; w++) src[perm[w]] = flip[w] > 0 ? c[w] : od[w] - 1 - c[w]
    out[i + j * od[0] + k * od[0] * od[1]] = vol[src[0] * st[0] + src[1] * st[1] + src[2] * st[2]]
  }
  return { data: out, dims: od }
}

function permuteFromRAS (volRas, dimsRas, dims, map, Ctor = Float32Array) {
  const { perm, flip } = map
  const out = new Ctor(volRas.length)
  for (let k = 0; k < dimsRas[2]; k++) for (let j = 0; j < dimsRas[1]; j++) for (let i = 0; i < dimsRas[0]; i++) {
    const c = [i, j, k]
    const src = [0, 0, 0]
    for (let w = 0; w < 3; w++) src[perm[w]] = flip[w] > 0 ? c[w] : dimsRas[w] - 1 - c[w]
    out[src[0] + src[1] * dims[0] + src[2] * dims[0] * dims[1]] = volRas[i + j * dimsRas[0] + k * dimsRas[0] * dimsRas[1]]
  }
  return out
}

// SDFs pela rede SynthDist (pesos convertidos pelo usuário — traga-seus-pesos):
// recorte à caixa do encéfalo + margem, blocos 96³ com sobreposição e recorte
// central, 9 canais de saída (0..3 = SDFs dos dois hemisférios; a atribuição
// white/pial é decidida pelo próprio exame — ver o bloco no fim desta função)
async function netSdfs (img, seg, ctxMask, dims, affine, modelUrl, isGPU, tile) {
  const tf = await import('../vendor/tf.fesm.min.js')
  const { registerUpSampling3D } = await import('../lib/tfjs-upsampling3d.js')
  registerUpSampling3D(tf)
  if (isGPU && typeof OffscreenCanvas !== 'undefined') {
    try { await tf.setBackend('webgl') } catch { await tf.setBackend('cpu') }
  } else await tf.setBackend('cpu')
  await tf.enableProdMode()
  await tf.ready()
  post(0.06, `SynthDist: backend ${tf.getBackend()}, carregando a rede…`)
  const model = await tf.loadLayersModel(modelUrl)
  // normalização min–max GLOBAL (como o oficial), depois recorte à caixa cerebral
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < img.length; i++) { const v = img[i]; if (v < mn) mn = v; if (v > mx) mx = v }
  const sc = mx > mn ? 1 / (mx - mn) : 1
  const map = rasAxisMap(affine)
  const ras = permuteToRAS(img, dims, map)
  const segRas = permuteToRAS(seg, dims, map, Uint8Array)
  const rd = ras.dims
  let x0 = rd[0], x1 = 0, y0 = rd[1], y1 = 0, z0 = rd[2], z1 = 0
  for (let k = 0; k < rd[2]; k++) for (let j = 0; j < rd[1]; j++) for (let i = 0; i < rd[0]; i++) {
    if (!segRas.data[i + j * rd[0] + k * rd[0] * rd[1]]) continue
    if (i < x0) x0 = i; if (i > x1) x1 = i
    if (j < y0) y0 = j; if (j > y1) y1 = j
    if (k < z0) z0 = k; if (k > z1) z1 = k
  }
  const M = 12
  x0 = Math.max(0, x0 - M); y0 = Math.max(0, y0 - M); z0 = Math.max(0, z0 - M)
  x1 = Math.min(rd[0] - 1, x1 + M); y1 = Math.min(rd[1] - 1, y1 + M); z1 = Math.min(rd[2] - 1, z1 + M)
  const cd = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1]
  const crop = new Float32Array(cd[0] * cd[1] * cd[2])
  for (let k = 0; k < cd[2]; k++) for (let j = 0; j < cd[1]; j++) for (let i = 0; i < cd[0]; i++) {
    crop[i + j * cd[0] + k * cd[0] * cd[1]] = (ras.data[(x0 + i) + (y0 + j) * rd[0] + (z0 + k) * rd[0] * rd[1]] - mn) * sc
  }
  // blocos 96³ / sobreposição 32, saída 4 canais úteis
  const T = tile, OV = 32, step = T - OV, h = OV / 2
  const starts = (n) => { const s = []; for (let v = 0; ; v += step) { if (v + T >= n) { s.push(Math.max(0, n - T)); break } s.push(v) } return [...new Set(s)] }
  const XS = starts(cd[0]), YS = starts(cd[1]), ZS = starts(cd[2])
  const total = XS.length * YS.length * ZS.length
  const outC = [0, 1, 2, 3].map(() => new Float32Array(crop.length))
  let done = 0
  for (const zc of ZS) for (const yc of YS) for (const xc of XS) {
    const inp = new Float32Array(T * T * T)
    const tx = Math.min(T, cd[0]), ty = Math.min(T, cd[1]), tz = Math.min(T, cd[2])
    for (let k = 0; k < tz; k++) for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
      inp[i + j * T + k * T * T] = crop[(xc + i) + (yc + j) * cd[0] + (zc + k) * cd[0] * cd[1]]
    }
    const zyx = tf.tensor5d(inp, [1, T, T, T, 1])
    const xyz = zyx.transpose([0, 3, 2, 1, 4])
    const yOut = model.predict(xyz)
    const yZyx = yOut.transpose([0, 3, 2, 1, 4]) // [1, z, y, x, 9]
    const yd = await yZyx.data()
    tf.dispose([zyx, xyz, yOut, yZyx])
    const lo = (s) => s === 0 ? 0 : h
    const hi = (s, t2, n2) => (s + T >= n2) ? Math.min(t2, n2 - s) : T - h
    for (let k = lo(zc); k < hi(zc, tz, cd[2]); k++) for (let j = lo(yc); j < hi(yc, ty, cd[1]); j++) for (let i = lo(xc); i < hi(xc, tx, cd[0]); i++) {
      const gi = (xc + i) + (yc + j) * cd[0] + (zc + k) * cd[0] * cd[1]
      const src = ((k * T + j) * T + i) * 9
      for (let c = 0; c < 4; c++) outC[c][gi] = yd[src + c]
    }
    done++
    post(0.08 + 0.5 * done / total, done === total ? 'SynthDist: blocos concluídos.' : '')
    await new Promise(r => setTimeout(r, 0))
  }
  model.dispose()
  // devolve ao volume cheio (fora da caixa: +5 = longe da superfície) e à ordem original
  const sdfs = outC.map(c => {
    const full = new Float32Array(rd[0] * rd[1] * rd[2]).fill(5)
    for (let k = 0; k < cd[2]; k++) for (let j = 0; j < cd[1]; j++) for (let i = 0; i < cd[0]; i++) {
      full[(x0 + i) + (y0 + j) * rd[0] + (z0 + k) * rd[0] * rd[1]] = c[i + j * cd[0] + k * cd[0] * cd[1]]
    }
    return permuteFromRAS(full, rd, dims, map)
  })
  // ORDEM DOS CANAIS. O mri_synth_surf.py nomeia `W = pred[...,0]` e `P = pred[...,1]`,
  // mas a medicao nos pesos v10 mostra o contrario: no cortex (entre as duas
  // superficies) o canal 0 fica NEGATIVO (dentro da pial) e o canal 1 POSITIVO (fora
  // da white), e so a atribuicao W=canal 1 / P=canal 0 reproduz o perfil pretendido
  // pela formula do norm sintetico (cortex 39,8 contra os 40 do alvo; a leitura
  // literal da 63,9). Logo: 0 = lh-pial, 1 = lh-white, 2 = rh-pial, 3 = rh-white.
  //
  // Em vez de fixar isso as cegas, decide-se pelo proprio exame: dentro de cada par,
  // o canal de MAIOR media no cortex e a white (no cortex esta-se FORA dela e DENTRO
  // da pial). Assim um checkpoint futuro com outra ordem nao passa despercebido.
  const mediaNoCortex = (arr) => {
    let s = 0, c = 0
    for (let v = 0; v < arr.length; v++) if (ctxMask[v]) { s += arr[v]; c++ }
    return c ? s / c : 0
  }
  const par = (a, b) => {
    const ma = mediaNoCortex(sdfs[a]), mb = mediaNoCortex(sdfs[b])
    return ma > mb ? { W: sdfs[a], P: sdfs[b], wIdx: a } : { W: sdfs[b], P: sdfs[a], wIdx: b }
  }
  const lh = par(0, 1), rh = par(2, 3)
  const esperado = lh.wIdx === 1 && rh.wIdx === 3
  post(0.6, esperado
    ? 'SynthDist: canais conferidos no exame (white = 1 e 3, pial = 0 e 2).'
    : `SynthDist: ATENÇÃO — a ordem dos canais neste checkpoint difere da medida nos pesos v10 (white detectada em ${lh.wIdx} e ${rh.wIdx}); seguindo o que o exame indica.`)
  return { lhW: lh.W, lhP: lh.P, rhW: rh.W, rhP: rh.P }
}

self.onmessage = async (ev) => {
  let diag = null
  try {
    const { seg, dims, affine, labels, colormap, voxVol = 1, engine = 'edt', img = null, modelUrl = null, isGPU = true, tile = 96 } = ev.data
    const [nx, ny, nz] = dims
    const n = nx * ny * nz
    const cls = classify(labels)
    const affRows = [0, 1, 2, 3].map(r => affine.slice(r * 4, r * 4 + 4))

    post(0.02, 'Separando hemisférios (EDT dos rótulos lateralizados, como no filled.mgz)…')
    const leftSeeds = new Uint8Array(n)
    const rightSeeds = new Uint8Array(n)
    const segMask = new Uint8Array(n)
    let lxn = 0, rxn = 0, ctx0n = 0, wmn = 0
    for (let v = 0; v < n; v++) {
      const c = cls[seg[v]]
      if (!c) continue
      segMask[v] = 1
      if (c.hemi === 1) leftSeeds[v] = 1
      else if (c.hemi === 2) rightSeeds[v] = 1
      if (c.kind === 'ctx') { if (c.hemi === 1) lxn++; else if (c.hemi === 2) rxn++ }
      else if (c.kind === 'ctx0') ctx0n++
      else if (c.kind === 'wm') wmn++
    }
    diag = { cortexParceladoE_vox: lxn, cortexParceladoD_vox: rxn, cortexSemParcela_vox: ctx0n, substanciaBranca_vox: wmn, rotulosClassificaveis: Object.keys(cls).length }
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
    const side = hemispherePartition(leftSeeds, rightSeeds, dims) // 1 = E

    post(0.05, 'Montando máscaras wm.seg/pial por hemisfério (regras do mri_synth_surf)…')
    const white = [new Uint8Array(n), new Uint8Array(n)]
    const pial = [new Uint8Array(n), new Uint8Array(n)]
    const ctxMask = new Uint8Array(n)
    for (let v = 0; v < n; v++) {
      const c = cls[seg[v]]
      if (!c) continue
      const hi = (c.hemi === 1 || (c.hemi === 0 && side[v])) ? 0 : 1
      if (c.kind === 'wm' || c.kind === 'vent' || c.kind === 'sub') { white[hi][v] = 1; pial[hi][v] = 1 }
      else { pial[hi][v] = 1; if (c.kind === 'ctx') ctxMask[v] = 1 }
    }

    // SDFs — rede SynthDist (se instalada) ou EDT das máscaras (fallback declarado)
    let sdf = null
    let engineUsed = 'edt'
    if (engine === 'net' && modelUrl) {
      try {
        sdf = await netSdfs(img, segMask, ctxMask, dims, affine, modelUrl, isGPU, tile)
        engineUsed = 'net'
      } catch (e) {
        post(0.06, `Rede SynthDist indisponível (${e.message}) — usando SDF por EDT das máscaras.`)
      }
    }
    if (!sdf) {
      post(0.1, 'SDFs por EDT exata das máscaras (±5 mm, negativa por dentro)…')
      sdf = {
        lhW: signedSdfFromMask(white[0], dims, 5),
        lhP: signedSdfFromMask(pial[0], dims, 5),
        rhW: signedSdfFromMask(white[1], dims, 5),
        rhP: signedSdfFromMask(pial[1], dims, 5)
      }
    }

    post(0.3, 'Imagem sintética norm (córtex super-resolvido, fórmula do mri_synth_surf)…')
    const norm = new Float32Array(n)
    accumulateSyntheticNorm(norm, sdf.lhW, sdf.lhP, side, 1)
    accumulateSyntheticNorm(norm, sdf.rhW, sdf.rhP, side, 0)
    maskByDilatedSeg(norm, segMask, dims, 3)

    post(0.34, 'Transformada de Talairach por centros de massa (getM)…')
    const tal = talairachFromSeg(seg, dims, affRows, labels)

    // amostrador de parcela (≈ sample_parc): rótulo de córtex mais próximo, raio ≤ 2
    const parcelAt = (x0, y0, z0) => {
      for (let r = 0; r <= 2; r++) {
        for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const X = x0 + dx, Y = y0 + dy, Z = z0 + dz
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
          const s2 = seg[X + Y * nx + Z * nx * ny]
          const c2 = cls[s2]
          if (c2 && c2.kind === 'ctx') return s2
        }
      }
      return 0
    }

    const acc = new Map()
    for (let v = 0; v < n; v++) {
      if (!ctxMask[v]) continue
      const i = seg[v]
      let a = acc.get(i)
      if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0, area: 0 }; acc.set(i, a) }
      a.nvox++
    }

    const cmIdx = new Map()
    if (colormap && colormap.I) for (let q = 0; q < colormap.I.length; q++) cmIdx.set(colormap.I[q], q)

    const meshes = []
    const euler = {}
    const names = ['esquerdo', 'direito']
    const sdfW2 = [sdf.lhW, sdf.rhW]
    const sdfP2 = [sdf.lhP, sdf.rhP]
    for (let h = 0; h < 2; h++) {
      const base = 0.38 + h * 0.28
      post(base, `Hemisfério ${names[h]}: pretess + tesselação (surface nets)…`)
      // pretess/extract_main_component: fecha, maior componente, cavidades
      let w = erode6(dilate6(white[h], dims), dims)
      largestComponent(w, dims)
      fillCavities(w, dims)
      const t0 = surfaceNets(w, dims)
      if (!t0.verts.length) continue
      const wv = Float32Array.from(taubinSmooth(t0.verts, t0.faces, 4))
      const faces = t0.faces
      const neigh = buildNeighbors(wv.length / 3, faces)
      const chi = eulerCharacteristic(wv.length / 3, faces, neigh.nEdges)
      euler[(h === 0 ? 'lh' : 'rh')] = chi
      if (chi !== 2) post(base + 0.02, `AVISO: hemisfério ${names[h]} com χ de Euler = ${chi} (defeitos topológicos NÃO corrigidos — sem mris_fix_topology).`)

      post(base + 0.05, `Hemisfério ${names[h]}: colocando a white na SDF (Eq. 5, nsmooth 5)…`)
      const rw = placeSurface(wv, faces, sdfW2[h], dims, { onIter: (it, mv) => { if (it % 25 === 0) post(base + 0.05 + 0.04 * Math.min(1, it / 100), '') } })
      smoothMesh(wv, faces, 5, 0.5, neigh)
      post(base + 0.12, `Hemisfério ${names[h]}: white em ${rw.iters} iterações; colocando a pial (repulsão da white)…`)
      const pv = Float32Array.from(wv)
      const rp = placeSurface(pv, faces, sdfP2[h], dims, { repulse: sdfW2[h], onIter: (it, mv) => { if (it % 25 === 0) post(base + 0.12 + 0.06 * Math.min(1, it / 120), '') } })
      post(base + 0.2, `Hemisfério ${names[h]}: pial em ${rp.iters} iterações; parcelas, cores e espessura…`)

      // parcelas por vértice na white (fronteira cinza/branca, como no FreeSurfer)
      const nV = wv.length / 3
      const vertParcel = new Int32Array(nV)
      for (let vi = 0; vi < nV; vi++) {
        vertParcel[vi] = parcelAt(Math.round(wv[vi * 3]), Math.round(wv[vi * 3 + 1]), Math.round(wv[vi * 3 + 2]))
      }
      // áreas regionais na WHITE (aparc.stats usa a área da white)
      const wmm = applyAffine(wv, affine)
      const pmm = applyAffine(pv, affine)
      const { per } = meshAreas(wmm, faces)
      for (let f = 0; f < faces.length; f += 3) {
        const a1 = vertParcel[faces[f]], b1 = vertParcel[faces[f + 1]], c1 = vertParcel[faces[f + 2]]
        const parc = a1 === b1 || a1 === c1 ? a1 : (b1 === c1 ? b1 : a1)
        if (parc) {
          let a = acc.get(parc)
          if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0, area: 0 }; acc.set(parc, a) }
          a.area += per[f / 3]
        }
      }
      // espessura Fischl–Dale com correspondência + ponto mais próximo, teto 5 mm
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
        const i3 = vi * 3
        const dWP = Math.min(nearest(gP, pmm, wmm[i3], wmm[i3 + 1], wmm[i3 + 2]),
          Math.hypot(pmm[i3] - wmm[i3], pmm[i3 + 1] - wmm[i3 + 1], pmm[i3 + 2] - wmm[i3 + 2]))
        const dPW = nearest(gW, wmm, pmm[i3], pmm[i3 + 1], pmm[i3 + 2])
        if (!Number.isFinite(dWP) || !Number.isFinite(dPW)) continue
        const t = Math.min(5, 0.5 * (dWP + dPW))
        let a = acc.get(parc)
        if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0, area: 0 }; acc.set(parc, a) }
        a.sum += t; a.sum2 += t * t; a.nT++
      }
      // malhas de saída (mz3, pial colorida pelas parcelas dos vértices da white)
      const rgba = new Uint8Array(nV * 4)
      for (let vi = 0; vi < nV; vi++) {
        const q = vertParcel[vi] && cmIdx.has(vertParcel[vi]) ? cmIdx.get(vertParcel[vi]) : -1
        const o = vi * 4
        if (q >= 0) { rgba[o] = colormap.R[q]; rgba[o + 1] = colormap.G[q]; rgba[o + 2] = colormap.B[q]; rgba[o + 3] = 255 } else { rgba[o] = 120; rgba[o + 1] = 120; rgba[o + 2] = 126; rgba[o + 3] = 255 }
      }
      meshes.push({ name: `${h === 0 ? 'lh' : 'rh'}.white`, kind: 'white', hemi: h === 0 ? 'E' : 'D', mz3: writeMz3(wmm, faces, null) })
      meshes.push({ name: `${h === 0 ? 'lh' : 'rh'}.pial`, kind: 'pial', hemi: h === 0 ? 'E' : 'D', mz3: writeMz3(pmm, faces, rgba) })
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
        volume_mm3: +(a.nvox * voxVol).toFixed(1)
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
