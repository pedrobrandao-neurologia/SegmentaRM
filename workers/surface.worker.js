// surface.worker.js — reconstrução de superfícies corticais a partir do resultado
// DKT (SynthSeg+DKT ou aseg+DKT), no espírito do recon-surf do FastSurfer:
// máscaras white/pial por hemisfério (análogo ao mri_fill simplificado) →
// surface nets (≈ mri_mc) → Taubin (≈ mris_smooth) → parcelação por amostragem do
// volume (≈ sample_parc) → espessura por PAREAMENTO DE SUPERFÍCIES white↔pial
// (Fischl & Dale, PNAS 2000: média das duas distâncias de ponto mais próximo),
// como no recon-all — aproximada em vértices de malhas suavizadas, sem o
// posicionamento sub-voxel do mris_place_surface.
// Mensagem: { seg, dims, affine (flat16), labels {idx→nome}, colormap {R,G,B,I}, voxVol }
// Resposta: { cmd:'done', meshes:[{name,kind,hemi,mz3}], stats:[...], caveat }

import { surfaceNets, taubinSmooth, meshAreas, applyAffine, writeMz3 } from '../lib/surfaces.js'
import { dilate6, erode6, largestComponent, fillCavities } from '../lib/fsl-prep.js'

function post (frac, txt) { self.postMessage({ cmd: 'progress', frac, txt }) }

// classifica cada rótulo do espaço combinado pelo NOME (robusto às duas fontes)
function classify (labels) {
  const cls = {}
  for (const [idx, name] of Object.entries(labels)) {
    const i = +idx
    let hemi = 0 // 0 = bilateral/indefinido, 1 = E, 2 = D
    if (/^Left-|^ctx-lh-/.test(name)) hemi = 1
    else if (/^Right-|^ctx-rh-/.test(name)) hemi = 2
    let kind = null
    if (/Cerebral-White-Matter/.test(name)) kind = 'wm'
    else if (/^ctx-(lh|rh)-/.test(name)) kind = 'ctx'
    else if (/Cerebral-Cortex/.test(name)) kind = 'ctx0' // córtex residual sem parcela
    else if (/Lateral-Ventricle|Inf-Lat-Vent|choroid/i.test(name)) kind = 'vent'
    else if (/Thalamus|Caudate|Putamen|Pallidum|Hippocampus|Amygdala|Accumbens|VentralDC|vessel/i.test(name)) kind = 'sub'
    if (kind) cls[i] = { kind, hemi, name }
  }
  return cls
}

self.onmessage = async (ev) => {
  try {
    const { seg, dims, affine, labels, colormap, voxVol = 1 } = ev.data
    const [nx, ny, nz] = dims
    const n = nx * ny * nz
    const cls = classify(labels)

    post(0.03, 'Separando hemisférios e montando as máscaras white/pial…')
    // hemisfério de rótulos bilaterais (aseg compacta): lado da linha média em x-mundo,
    // com a linha média estimada pelo centro dos córtex E/D parcelados
    let lxs = 0, lxn = 0, rxs = 0, rxn = 0
    const xw = (v) => {
      const x = v % nx, y = ((v / nx) | 0) % ny, z = (v / (nx * ny)) | 0
      return affine[0] * x + affine[1] * y + affine[2] * z + affine[3]
    }
    for (let v = 0; v < n; v++) {
      const c = cls[seg[v]]
      if (!c || c.kind !== 'ctx') continue
      if (c.hemi === 1) { lxs += xw(v); lxn++ } else if (c.hemi === 2) { rxs += xw(v); rxn++ }
    }
    if (!lxn || !rxn) throw new Error('sem córtex parcelado nos dois hemisférios — rode o passo DKT antes')
    const lx = lxs / lxn, rx = rxs / rxn
    const midX = (lx + rx) / 2
    const leftIsPositive = lx > rx

    const white = [new Uint8Array(n), new Uint8Array(n)] // [E, D]
    const pial = [new Uint8Array(n), new Uint8Array(n)]
    const ctxMask = new Uint8Array(n) // córtex parcelado (para a espessura)
    for (let v = 0; v < n; v++) {
      const c = cls[seg[v]]
      if (!c) continue
      let h = c.hemi
      if (h === 0) h = ((xw(v) > midX) === leftIsPositive) ? 1 : 2
      const hi = h - 1
      if (c.kind === 'wm' || c.kind === 'vent' || c.kind === 'sub') { white[hi][v] = 1; pial[hi][v] = 1 }
      else if (c.kind === 'ctx' || c.kind === 'ctx0') {
        pial[hi][v] = 1
        if (c.kind === 'ctx') ctxMask[v] = 1
      }
    }

    // volume por parcela (contagem de voxels de córtex parcelado)
    const acc = new Map() // idx → {sum, sum2, nT, nvox}
    for (let v = 0; v < n; v++) {
      if (!ctxMask[v]) continue
      const i = seg[v]
      let a = acc.get(i)
      if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0 }; acc.set(i, a) }
      a.nvox++
    }

    // amostrador de parcela: rótulo de córtex mais próximo (raio ≤ 2) de um ponto em voxels
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

    // vizinho mais próximo entre nuvens de vértices via grade uniforme (células de 4 mm)
    const CELL = 4
    const buildGrid = (verts) => {
      const g = new Map()
      for (let i = 0; i < verts.length; i += 3) {
        const key = `${Math.floor(verts[i] / CELL)},${Math.floor(verts[i + 1] / CELL)},${Math.floor(verts[i + 2] / CELL)}`
        let b = g.get(key)
        if (!b) { b = []; g.set(key, b) }
        b.push(i)
      }
      return g
    }
    const nearestDist = (grid, verts, px, py, pz) => {
      const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL), cz = Math.floor(pz / CELL)
      let best = Infinity, bi = -1
      for (let ring = 0; ring <= 3; ring++) {
        for (let dz = -ring; dz <= ring; dz++) for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue
          const b = grid.get(`${cx + dx},${cy + dy},${cz + dz}`)
          if (!b) continue
          for (const q of b) {
            const ddx = verts[q] - px, ddy = verts[q + 1] - py, ddz = verts[q + 2] - pz
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz
            if (d2 < best) { best = d2; bi = q }
          }
        }
        if (bi >= 0 && best <= (ring * CELL) * (ring * CELL)) break
      }
      return { d: Math.sqrt(best), i: bi }
    }

    const A = affine
    const meshes = []
    const areaByLabel = new Map()
    const names = ['esquerdo', 'direito']
    for (let h = 0; h < 2; h++) {
      post(0.2 + h * 0.35, `Hemisfério ${names[h]}: fechando máscaras e tesselando…`)
      // limpeza: fechamento + maior componente + cavidades (análogo grosseiro ao mri_fill)
      let w = erode6(dilate6(white[h], dims), dims)
      largestComponent(w, dims)
      fillCavities(w, dims)
      let p = pial[h]
      for (let v = 0; v < n; v++) p[v] = p[v] | w[v]
      p = erode6(dilate6(p, dims), dims)
      largestComponent(p, dims)
      fillCavities(p, dims)

      const hemiMeshes = {}
      for (const [kind, mask, iters] of [['white', w, 10], ['pial', p, 12]]) {
        const { verts, faces } = surfaceNets(mask, dims)
        if (!verts.length) continue
        const sm = taubinSmooth(verts, faces, iters)
        const mmv = applyAffine(sm, A)
        hemiMeshes[kind] = { sm, mmv, faces }
        let rgba = null
        if (kind === 'pial') {
          // parcela por vértice: amostra o rótulo de córtex mais próximo (raio ≤ 2)
          rgba = new Uint8Array((mmv.length / 3) * 4)
          const cmIdx = new Map()
          if (colormap && colormap.I) for (let q = 0; q < colormap.I.length; q++) cmIdx.set(colormap.I[q], q)
          const faceParcel = new Int32Array(faces.length / 3)
          const vertParcel = new Int32Array(mmv.length / 3)
          for (let vi = 0; vi < sm.length; vi += 3) {
            const x0 = Math.round(sm[vi]), y0 = Math.round(sm[vi + 1]), z0 = Math.round(sm[vi + 2])
            let found = 0
            for (let r = 0; r <= 2 && !found; r++) {
              for (let dz = -r; dz <= r && !found; dz++) for (let dy = -r; dy <= r && !found; dy++) for (let dx = -r; dx <= r && !found; dx++) {
                const X = x0 + dx, Y = y0 + dy, Z = z0 + dz
                if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue
                const s2 = seg[X + Y * nx + Z * nx * ny]
                const c2 = cls[s2]
                if (c2 && c2.kind === 'ctx') found = s2
              }
            }
            vertParcel[vi / 3] = found
            const q = found && cmIdx.has(found) ? cmIdx.get(found) : -1
            const o = (vi / 3) * 4
            if (q >= 0) { rgba[o] = colormap.R[q]; rgba[o + 1] = colormap.G[q]; rgba[o + 2] = colormap.B[q]; rgba[o + 3] = 255 } else { rgba[o] = 120; rgba[o + 1] = 120; rgba[o + 2] = 126; rgba[o + 3] = 255 }
          }
          // área por parcela: face vai para a parcela majoritária dos seus vértices
          const { per } = meshAreas(mmv, faces)
          for (let f = 0; f < faces.length; f += 3) {
            const a1 = vertParcel[faces[f]], b1 = vertParcel[faces[f + 1]], c1 = vertParcel[faces[f + 2]]
            const parc = a1 === b1 || a1 === c1 ? a1 : (b1 === c1 ? b1 : a1)
            faceParcel[f / 3] = parc
            if (parc) areaByLabel.set(parc, (areaByLabel.get(parc) || 0) + per[f / 3])
          }
        }
        const mz3 = writeMz3(mmv, faces, rgba)
        meshes.push({ name: `${h === 0 ? 'lh' : 'rh'}.${kind}`, kind, hemi: h === 0 ? 'E' : 'D', mz3 })
        post(0.2 + h * 0.35 + (kind === 'white' ? 0.15 : 0.3), `Hemisfério ${names[h]}: ${kind} com ${(mmv.length / 3).toLocaleString()} vértices.`)
      }

      // espessura Fischl–Dale: T(v) = ½·[d(white_v → pial) + d(pial* → white)],
      // aproximada por vértice mais próximo nas malhas suavizadas
      if (hemiMeshes.white && hemiMeshes.pial) {
        const wv = hemiMeshes.white.mmv
        const pv = hemiMeshes.pial.mmv
        const wvVox = hemiMeshes.white.sm
        const gridP = buildGrid(pv)
        const gridW = buildGrid(wv)
        for (let vi = 0; vi < wv.length; vi += 3) {
          const np = nearestDist(gridP, pv, wv[vi], wv[vi + 1], wv[vi + 2])
          if (np.i < 0 || np.d > 8) continue
          const nw = nearestDist(gridW, wv, pv[np.i], pv[np.i + 1], pv[np.i + 2])
          const t = Math.min(8, 0.5 * (np.d + (nw.i >= 0 ? nw.d : np.d)))
          const parc = parcelAt(Math.round(wvVox[vi]), Math.round(wvVox[vi + 1]), Math.round(wvVox[vi + 2]))
          if (!parc) continue
          let a = acc.get(parc)
          if (!a) { a = { sum: 0, sum2: 0, nT: 0, nvox: 0 }; acc.set(parc, a) }
          a.sum += t; a.sum2 += t * t; a.nT++
        }
      }
    }

    // tabela estilo aparc.stats
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
        area_mm2: +(areaByLabel.get(+idx) || 0).toFixed(1),
        volume_mm3: +(a.nvox * voxVol).toFixed(1)
      })
    }
    stats.sort((a, b) => a.base === b.base ? a.hemi.localeCompare(b.hemi) : a.base.localeCompare(b.base))
    post(0.98, `Superfícies prontas: ${meshes.length} malhas, ${stats.length} regiões.`)
    self.postMessage({ cmd: 'done', meshes, stats }, meshes.map(m => m.mz3))
  } catch (e) {
    self.postMessage({ cmd: 'error', message: e && e.message ? e.message : String(e) })
  }
}
