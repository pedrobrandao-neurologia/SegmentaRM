// sdf-surface.js — núcleo geométrico do recon-all-clinical no navegador.
// Réplica cuidadosa das peças do FreeSurfer usadas pelo recon-all-clinical.sh e
// pelo mri_synth_surf.py (Gopinath et al., Medical Image Analysis 2025), lida do
// código-fonte (branch dev do freesurfer/freesurfer):
//   · SDF assinada (negativa por dentro, recorte ±5 mm — convenção do SynthDist)
//   · partição hemisférica por transformada de distância dos rótulos lateralizados
//     (exatamente como filled.mgz: Dleft < Dright)
//   · imagem sintética norm.mgz: F = 70·(1−(tanh(2(W+0,3))+1)/2) + 40·(1−(tanh(2P)+1)/2)
//   · colocação de superfícies pela energia da Eq. 5 do artigo — fidelidade tanh(D)²
//     + molas normal/tangencial de Dale et al. 1999 (λ1 = 0,0006, λ2 = 0,0002),
//     descida de gradiente com monitoração de deslocamento
//   · característica de Euler (χ = V − E + F) como QC de topologia — o
//     mris_fix_topology (cirurgia de variedade) NÃO é portado: defeitos são
//     relatados, não corrigidos
//   · transformada de Talairach por casamento de centros de massa (getM do
//     mri_synth_surf.py, com a tabela de COGs do MNI ICBM152 embutida)

import { edt3d } from './surfaces.js'

// ---------------------------------------------------------------- SDF de máscara
/**
 * SDF assinada a partir de uma máscara binária: negativa dentro, positiva fora,
 * zero na face entre voxels (meio voxel descontado de cada lado), recorte ±clip.
 * Grade isotrópica de 1 mm → unidades em mm.
 */
export function signedSdfFromMask (mask, dims, clip = 5) {
  const n = mask.length
  const inv = new Uint8Array(n)
  for (let i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1
  const dOut2 = edt3d(mask, dims)
  const dIn2 = edt3d(inv, dims)
  const sdf = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = mask[i] ? -(Math.sqrt(dIn2[i]) - 0.5) : (Math.sqrt(dOut2[i]) - 0.5)
    sdf[i] = v < -clip ? -clip : (v > clip ? clip : v)
  }
  return sdf
}

// ------------------------------------------------- partição hemisférica (filled)
/**
 * Partição E/D exatamente como o mri_synth_surf.py monta o filled.mgz:
 * EDT até os rótulos lateralizados de cada lado; voxel é esquerdo se Dleft<Dright.
 * @param {Uint8Array} leftSeeds máscara dos rótulos do hemisfério esquerdo
 * @param {Uint8Array} rightSeeds idem, direito
 * @returns {Uint8Array} 1 = esquerdo, 0 = direito
 */
export function hemispherePartition (leftSeeds, rightSeeds, dims) {
  const dl = edt3d(leftSeeds, dims)
  const dr = edt3d(rightSeeds, dims)
  const out = new Uint8Array(leftSeeds.length)
  for (let i = 0; i < out.length; i++) out[i] = dl[i] < dr[i] ? 1 : 0
  return out
}

// ------------------------------------------------------- imagem sintética (norm)
/**
 * Imagem sintética de "córtex super-resolvido" do mri_synth_surf.py (exata):
 * por hemisfério F = 70·(1−(tanh(2·(W+0,3))+1)/2) + 40·(1−(tanh(2·P)+1)/2),
 * composta pela partição hemisférica e mascarada pela segmentação dilatada.
 * Chamar uma vez por hemisfério com o lado da partição correspondente.
 * @param {Float32Array} F imagem acumuladora (n)
 * @param {Float32Array} sdfW SDF white do hemisfério
 * @param {Float32Array} sdfP SDF pial do hemisfério
 * @param {Uint8Array} side 1 onde este hemisfério manda (da hemispherePartition)
 * @param {number} sideVal valor de side que seleciona este hemisfério (1 ou 0)
 */
export function accumulateSyntheticNorm (F, sdfW, sdfP, side, sideVal) {
  const a = 2
  for (let i = 0; i < F.length; i++) {
    if (side[i] !== sideVal) continue
    F[i] = 70 * (1 - (Math.tanh(a * (sdfW[i] + 0.3)) + 1) / 2) +
           40 * (1 - (Math.tanh(a * sdfP[i]) + 1) / 2)
  }
}

/** máscara: dilatação da segmentação por raio r (via EDT, exata) — F fora vira 0 */
export function maskByDilatedSeg (F, segMask, dims, r = 3) {
  const d2 = edt3d(segMask, dims)
  const r2 = r * r
  for (let i = 0; i < F.length; i++) if (d2[i] > r2) F[i] = 0
}

// -------------------------------------------------------------- malha: utilidades
/** vizinhos de cada vértice a partir das faces (listas planas) */
export function buildNeighbors (nVerts, faces) {
  const deg = new Int32Array(nVerts)
  const seen = new Set()
  const edges = []
  for (let f = 0; f < faces.length; f += 3) {
    for (const [a, b] of [[faces[f], faces[f + 1]], [faces[f + 1], faces[f + 2]], [faces[f + 2], faces[f]]]) {
      const key = a < b ? a * nVerts + b : b * nVerts + a
      if (seen.has(key)) continue
      seen.add(key)
      edges.push(a, b)
      deg[a]++; deg[b]++
    }
  }
  const off = new Int32Array(nVerts + 1)
  for (let v = 0; v < nVerts; v++) off[v + 1] = off[v] + deg[v]
  const adj = new Int32Array(off[nVerts])
  const cur = off.slice(0, nVerts)
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1]
    adj[cur[a]++] = b
    adj[cur[b]++] = a
  }
  return { off, adj, nEdges: edges.length / 2 }
}

/** característica de Euler χ = V − E + F (esfera topológica: χ = 2) */
export function eulerCharacteristic (nVerts, faces, nEdges = null) {
  if (nEdges === null) nEdges = buildNeighbors(nVerts, faces).nEdges
  return nVerts - nEdges + faces.length / 3
}

/** normais por vértice (média das normais de face ponderadas por área) */
export function vertexNormals (verts, faces, out = null) {
  const n = verts.length / 3
  const N = out || new Float32Array(verts.length)
  N.fill(0)
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const i of [a, b, c]) { N[i] += nx; N[i + 1] += ny; N[i + 2] += nz }
  }
  for (let v = 0; v < n; v++) {
    const i = v * 3
    const m = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1
    N[i] /= m; N[i + 1] /= m; N[i + 2] /= m
  }
  return N
}

/** amostra trilinear de um volume x-mais-rápido em coordenadas de voxel */
export function trilinear (vol, dims, x, y, z) {
  const [nx, ny, nz] = dims
  if (x < 0) x = 0; else if (x > nx - 1.001) x = nx - 1.001
  if (y < 0) y = 0; else if (y > ny - 1.001) y = ny - 1.001
  if (z < 0) z = 0; else if (z > nz - 1.001) z = nz - 1.001
  const x0 = x | 0, y0 = y | 0, z0 = z | 0
  const fx = x - x0, fy = y - y0, fz = z - z0
  const s = nx, sz = nx * ny
  const i000 = x0 + y0 * s + z0 * sz
  const c00 = vol[i000] * (1 - fx) + vol[i000 + 1] * fx
  const c10 = vol[i000 + s] * (1 - fx) + vol[i000 + s + 1] * fx
  const c01 = vol[i000 + sz] * (1 - fx) + vol[i000 + sz + 1] * fx
  const c11 = vol[i000 + s + sz] * (1 - fx) + vol[i000 + s + sz + 1] * fx
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz
}

// ------------------------------------------------- colocação de superfícies (Eq. 5)
/**
 * Deforma a malha até o nível zero de uma SDF minimizando a energia da Eq. 5 do
 * artigo: Σ tanh(D(x_v))² + λ1·Σ[n·(x_v−x_u)]² + λ2·Σ[componentes tangenciais]²,
 * por descida de gradiente com passo limitado (as autointerseções são contidas
 * pelo teto de deslocamento por iteração; o resíduo é suavizado no nsmooth).
 * Coordenadas em voxels de grade isotrópica 1 mm (voxel ≡ mm).
 * @param {Float32Array} verts malha inicial (modificada IN PLACE)
 * @param {Float32Array} sdf volume SDF; opts.repulse: SDF de outra superfície a
 *        manter fora (pial mantém-se fora da white, como o --repulse-surf)
 * @returns {{iters:number, meanMove:number}}
 */
export function placeSurface (verts, faces, sdf, dims, opts = {}) {
  const {
    lambdaN = 0.0006, lambdaT = 0.0002, step = 0.4, iters = 150,
    maxMove = 0.5, tol = 0.005, repulse = null, repulseMargin = 0.3, onIter = null
  } = opts
  const nV = verts.length / 3
  const { off, adj } = buildNeighbors(nV, faces)
  const N = new Float32Array(verts.length)
  const delta = new Float32Array(verts.length)
  let it = 0, meanMove = Infinity
  const g = (vol, x, y, z) => [
    (trilinear(vol, dims, x + 0.5, y, z) - trilinear(vol, dims, x - 0.5, y, z)),
    (trilinear(vol, dims, x, y + 0.5, z) - trilinear(vol, dims, x, y - 0.5, z)),
    (trilinear(vol, dims, x, y, z + 0.5) - trilinear(vol, dims, x, y, z - 0.5))
  ]
  for (it = 0; it < iters; it++) {
    vertexNormals(verts, faces, N)
    let acc = 0
    for (let v = 0; v < nV; v++) {
      const i = v * 3
      const x = verts[i], y = verts[i + 1], z = verts[i + 2]
      // fidelidade: ∇ tanh(D)² = 2·t·(1−t²)·∇D — o tanh satura longe do nível
      // zero, então soma-se uma advecção linear limitada (kFar·clamp(D,±1)·∇D)
      // que só acelera a APROXIMAÇÃO; no nível zero ambas se anulam juntas
      const D = trilinear(sdf, dims, x, y, z)
      const t = Math.tanh(D)
      const gd = g(sdf, x, y, z)
      const cf = 2 * t * (1 - t * t) + 0.5 * Math.max(-1, Math.min(1, D))
      let fx = -cf * gd[0], fy = -cf * gd[1], fz = -cf * gd[2]
      // molas: soma dos vizinhos relativa ao vértice, decomposta pela normal
      let sx = 0, sy = 0, sz = 0
      for (let e = off[v]; e < off[v + 1]; e++) {
        const u = adj[e] * 3
        sx += verts[u] - x; sy += verts[u + 1] - y; sz += verts[u + 2] - z
      }
      const nxv = N[i], nyv = N[i + 1], nzv = N[i + 2]
      const sn = sx * nxv + sy * nyv + sz * nzv
      fx += 2 * lambdaN * sn * nxv + 2 * lambdaT * (sx - sn * nxv)
      fy += 2 * lambdaN * sn * nyv + 2 * lambdaT * (sy - sn * nyv)
      fz += 2 * lambdaN * sn * nzv + 2 * lambdaT * (sz - sn * nzv)
      // repulsão da outra superfície (pial fora da white)
      if (repulse) {
        const Dw = trilinear(repulse, dims, x, y, z)
        if (Dw < repulseMargin) {
          const gw = g(repulse, x, y, z)
          const k = (repulseMargin - Dw)
          fx += k * gw[0]; fy += k * gw[1]; fz += k * gw[2]
        }
      }
      let dx = step * fx, dy = step * fy, dz = step * fz
      const m = Math.hypot(dx, dy, dz)
      if (m > maxMove) { const s2 = maxMove / m; dx *= s2; dy *= s2; dz *= s2 }
      delta[i] = dx; delta[i + 1] = dy; delta[i + 2] = dz
      acc += Math.hypot(dx, dy, dz)
    }
    for (let i = 0; i < verts.length; i++) verts[i] += delta[i]
    // projeção dura contra a superfície de repulsão: a pial pode tocar a white,
    // nunca cruzá-la (análogo à restrição do mris_place_surface)
    if (repulse) {
      for (let v = 0; v < nV; v++) {
        const i = v * 3
        const Dw = trilinear(repulse, dims, verts[i], verts[i + 1], verts[i + 2])
        if (Dw < 0) {
          const gw = g(repulse, verts[i], verts[i + 1], verts[i + 2])
          const m2 = Math.hypot(gw[0], gw[1], gw[2]) || 1
          const push = (-Dw + 0.05) / m2
          verts[i] += push * gw[0]; verts[i + 1] += push * gw[1]; verts[i + 2] += push * gw[2]
        }
      }
    }
    meanMove = acc / nV
    if (onIter) onIter(it, meanMove)
    if (meanMove < tol) break
  }
  return { iters: it + 1, meanMove }
}

/** suavização por média de vizinhos (≈ mris_smooth / --nsmooth N), in place */
export function smoothMesh (verts, faces, n = 5, alpha = 0.5, neigh = null) {
  const nV = verts.length / 3
  const { off, adj } = neigh || buildNeighbors(nV, faces)
  const tmp = new Float32Array(verts.length)
  for (let k = 0; k < n; k++) {
    for (let v = 0; v < nV; v++) {
      const i = v * 3
      let sx = 0, sy = 0, sz = 0
      const d = off[v + 1] - off[v]
      for (let e = off[v]; e < off[v + 1]; e++) {
        const u = adj[e] * 3
        sx += verts[u]; sy += verts[u + 1]; sz += verts[u + 2]
      }
      if (d) {
        tmp[i] = verts[i] + alpha * (sx / d - verts[i])
        tmp[i + 1] = verts[i + 1] + alpha * (sy / d - verts[i + 1])
        tmp[i + 2] = verts[i + 2] + alpha * (sz / d - verts[i + 2])
      } else { tmp[i] = verts[i]; tmp[i + 1] = verts[i + 1]; tmp[i + 2] = verts[i + 2] }
    }
    verts.set(tmp)
  }
}

// ------------------------------------------------------------ Talairach por COGs
// Tabela de rótulos e centros de massa do MNI ICBM152 nlin sym 09c, copiada
// verbatim do mri_synth_surf.py (código FreeSurfer, branch dev)
const TAL_LABELS = [2, 4, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 24, 26, 28, 41, 43, 44, 46, 47, 49, 50, 51, 52, 53, 54, 58, 60,
  1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034, 1035,
  2001, 2002, 2003, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035]
const TAL_COG_X = [-27, -13, -31, -17, -24, -11, -14, -27, -20, 0, 0, 0, -26, -23, 0, -8, -9, 27, 14, 33, 17, 25, 11, 14, 27, 20, 26, 23, 9, 9, -54, -4, -37, -6, -23, -35, -44, -53, -6, -30, -23, -13, -5, -60, -23, -6, -49, -44, -49, -11, -48, -4, -44, -8, -4, -34, -10, -25, -54, -57, -9, -28, -45, -37, 55, 4, 37, 6, 22, 35, 45, 52, 6, 31, 23, 13, 5, 60, 23, 6, 49, 43, 50, 10, 48, 4, 43, 8, 4, 33, 10, 25, 54, 57, 8, 30, 46, 37]
const TAL_COG_Y = [-18, -18, -13, -54, -63, -18, 12, 3, -2, -7, -46, -31, -20, -4, -21, 10, -16, -18, -21, -15, -54, -63, -18, 12, 3, -3, -20, -4, 10, -16, -43, 21, 11, -79, -4, -41, -67, -35, -46, -90, 29, -67, 42, -23, -32, -28, 16, 43, 32, -79, -19, -21, -7, -59, 38, 49, 29, -63, -9, -35, 67, 13, -21, 2, -42, 20, 13, -81, -6, -41, -66, -34, -46, -90, 29, -68, 41, -24, -32, -27, 16, 44, 32, -82, -19, -20, -7, -59, 39, 50, 30, -62, -8, -34, 67, 13, -20, 2]
const TAL_COG_Z = [19, 15, -15, -35, -38, 6, 10, -1, -2, -4, -34, -34, -16, -20, 8, -9, -10, 19, 14, -14, -35, -38, 6, 10, -1, -3, -16, -20, -9, -10, 8, 28, 49, 20, -34, -21, 31, -24, 22, 0, -19, -5, -17, -13, -17, 58, 14, -14, 2, 7, 47, 40, 47, 38, 1, 20, 47, 53, -4, 33, -11, -37, 9, -2, 6, 28, 48, 21, -33, -21, 31, -25, 23, -1, -20, -5, -17, -13, -17, 59, 13, -14, 2, 7, 46, 40, 47, 39, 1, 19, 47, 54, -5, 34, -11, -38, 8, -3]
// ordem padrão do aparc do FreeSurfer (código = 1000/2000 + índice+1)
const APARC_NAMES = ['bankssts', 'caudalanteriorcingulate', 'caudalmiddlefrontal', 'corpuscallosum', 'cuneus', 'entorhinal', 'fusiform', 'inferiorparietal', 'inferiortemporal', 'isthmuscingulate', 'lateraloccipital', 'lateralorbitofrontal', 'lingual', 'medialorbitofrontal', 'middletemporal', 'parahippocampal', 'paracentral', 'parsopercularis', 'parsorbitalis', 'parstriangularis', 'pericalcarine', 'postcentral', 'posteriorcingulate', 'precentral', 'precuneus', 'rostralanteriorcingulate', 'rostralmiddlefrontal', 'superiorfrontal', 'superiorparietal', 'superiortemporal', 'supramarginal', 'frontalpole', 'temporalpole', 'transversetemporal', 'insula']
const SUBCORT_CODES = {
  'Left-Cerebral-White-Matter': 2, 'Left-Lateral-Ventricle': 4, 'Left-Inf-Lat-Vent': 5, 'Left-Cerebellum-White-Matter': 7, 'Left-Cerebellum-Cortex': 8, 'Left-Thalamus': 10, 'Left-Thalamus-Proper': 10, 'Left-Caudate': 11, 'Left-Putamen': 12, 'Left-Pallidum': 13, '3rd-Ventricle': 14, '4th-Ventricle': 15, 'Brain-Stem': 16, 'Left-Hippocampus': 17, 'Left-Amygdala': 18, CSF: 24, 'Left-Accumbens-area': 26, 'Left-VentralDC': 28,
  'Right-Cerebral-White-Matter': 41, 'Right-Lateral-Ventricle': 43, 'Right-Inf-Lat-Vent': 44, 'Right-Cerebellum-White-Matter': 46, 'Right-Cerebellum-Cortex': 47, 'Right-Thalamus': 49, 'Right-Thalamus-Proper': 49, 'Right-Caudate': 50, 'Right-Putamen': 51, 'Right-Pallidum': 52, 'Right-Hippocampus': 53, 'Right-Amygdala': 54, 'Right-Accumbens-area': 58, 'Right-VentralDC': 60
}

/** código FreeSurfer de um nome do nosso espaço de rótulos (ou 0) */
export function fsCodeOfName (name) {
  if (SUBCORT_CODES[name]) return SUBCORT_CODES[name]
  const m = /^ctx-(lh|rh)-(.+)$/.exec(name)
  if (m) {
    const i = APARC_NAMES.indexOf(m[2])
    if (i >= 0) return (m[1] === 'lh' ? 1000 : 2000) + i + 1
  }
  return 0
}

/** resolve A·x = b por eliminação de Gauss com pivotação parcial (A n×n) */
function solve (A, b) {
  const n = b.length
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]
    x[r] = s / A[r][r]
  }
  return x
}

/**
 * Affine sujeito→MNI por mínimos quadrados sobre pares de COGs (getM do
 * mri_synth_surf.py): COGs do sujeito em RAS (mediana dos voxels por rótulo,
 * ≥ 50 voxels) casados com a tabela do ICBM152.
 * @param {Uint8Array} seg no espaço conformado; labels {idx→nome}; affine 4×4 rows
 * @returns {{M: number[][], nUsed: number}|null}
 */
export function talairachFromSeg (seg, dims, affine, labels) {
  const [nx, ny] = dims
  // código FS → índice na tabela
  const codeToCol = new Map()
  TAL_LABELS.forEach((c, i) => codeToCol.set(c, i))
  // agrupa voxels por código FS
  const byCode = new Map()
  const codeOfIdx = new Map()
  for (const [idx, nm] of Object.entries(labels)) {
    const c = fsCodeOfName(nm)
    if (c && codeToCol.has(c)) codeOfIdx.set(+idx, c)
  }
  for (let v = 0; v < seg.length; v++) {
    const c = codeOfIdx.get(seg[v])
    if (!c) continue
    let a = byCode.get(c)
    if (!a) { a = { xs: [], ys: [], zs: [] }; byCode.set(c, a) }
    a.xs.push(v % nx); a.ys.push(((v / nx) | 0) % ny); a.zs.push((v / (nx * ny)) | 0)
  }
  const med = (arr) => { arr.sort((p, q) => p - q); return arr[arr.length >> 1] }
  const ref = [] // RAS do sujeito
  const mov = [] // MNI
  for (const [c, a] of byCode) {
    if (a.xs.length <= 50) continue
    const i = med(a.xs), j = med(a.ys), k = med(a.zs)
    const col = codeToCol.get(c)
    ref.push([
      affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3],
      affine[1][0] * i + affine[1][1] * j + affine[1][2] * k + affine[1][3],
      affine[2][0] * i + affine[2][1] * j + affine[2][2] * k + affine[2][3]
    ])
    mov.push([TAL_COG_X[col], TAL_COG_Y[col], TAL_COG_Z[col]])
  }
  if (ref.length < 6) return null
  // mínimos quadrados: para cada linha r de M, resolve [ref 1]·m_r = mov_r
  const M = []
  const AtA = () => Array.from({ length: 4 }, () => new Array(4).fill(0))
  for (let r = 0; r < 3; r++) {
    const A = AtA()
    const b = new Array(4).fill(0)
    for (let s = 0; s < ref.length; s++) {
      const row = [ref[s][0], ref[s][1], ref[s][2], 1]
      for (let p = 0; p < 4; p++) {
        b[p] += row[p] * mov[s][r]
        for (let q = 0; q < 4; q++) A[p][q] += row[p] * row[q]
      }
    }
    M.push(solve(A, b))
  }
  M.push([0, 0, 0, 1])
  return { M, nUsed: ref.length }
}

/** serializa a matriz no formato MNI Transform File (talairach.xfm) */
export function talairachXfm (M) {
  const f = (v) => String(+v.toFixed(6))
  return 'MNI Transform File\n% avi2talxfm\n\nTransform_Type = Linear;\nLinear_Transform = \n' +
    `${f(M[0][0])} ${f(M[0][1])} ${f(M[0][2])} ${f(M[0][3])}\n` +
    `${f(M[1][0])} ${f(M[1][1])} ${f(M[1][2])} ${f(M[1][3])}\n` +
    `${f(M[2][0])} ${f(M[2][1])} ${f(M[2][2])} ${f(M[2][3])};\n`
}
