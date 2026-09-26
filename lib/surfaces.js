// surfaces.js — reconstrução rápida de superfícies corticais a partir da segmentação
// DKT, no espírito do recon-surf do FastSurfer, mas 100% no navegador:
//   · malha por surface nets sobre a máscara (análogo ao mri_mc/mri_tessellate)
//   · suavização de Taubin λ|μ, que não encolhe (análogo ao mris_smooth)
//   · parcelação por amostragem do volume na superfície (como o sample_parc.py)
//   · espessura por transformada de distância euclidiana: d(córtex→SB) + d(córtex→fora
//     da pial) — aproximação declarada; NÃO é o mris_place_surface do FreeSurfer
// Saídas: malhas white/pial em MZ3 (com cores DKT por vértice) e tabela estilo
// aparc.stats por região (espessura média±dp, área da malha pial, volume).

// ---------------------------------------------------------------- EDT 3D (Felzenszwalb)
// w = (espaçamento do eixo)²: as parábolas ficam em unidades físicas (mm²), de modo
// que a EDT é exata também em grades anisotrópicas
function dt1d (f, n, d2, v, z, w = 1) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + w * q * q) - (f[v[k]] + w * v[k] * v[k])) / (2 * w * (q - v[k]))
    while (s <= z[k]) {
      k--
      s = ((f[q] + w * q * q) - (f[v[k]] + w * v[k] * v[k])) / (2 * w * (q - v[k]))
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d2[q] = w * (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/**
 * Distância euclidiana ao quadrado até o voxel semente mais próximo.
 * @param {Uint8Array} seeds máscara (1 = semente)
 * @param {number[]} [spacing] tamanho do voxel [sx,sy,sz] em mm; omitido = grade
 *        isotrópica unitária (resultado em voxels²)
 * @returns {Float32Array} d² em mm² (ou voxels² sem spacing)
 */
export function edt3d (seeds, dims, spacing = null) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const [wx, wy, wz] = spacing ? spacing.map(s => s * s) : [1, 1, 1]
  const INF = 1e12
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = seeds[i] ? 0 : INF
  const maxN = Math.max(nx, ny, nz)
  const f = new Float64Array(maxN)
  const out = new Float64Array(maxN)
  const v = new Int32Array(maxN)
  const z = new Float64Array(maxN + 1)
  // eixo x
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const base = j * nx + k * nx * ny
    for (let i = 0; i < nx; i++) f[i] = d[base + i]
    dt1d(f, nx, out, v, z, wx)
    for (let i = 0; i < nx; i++) d[base + i] = out[i]
  }
  // eixo y
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const base = i + k * nx * ny
    for (let j = 0; j < ny; j++) f[j] = d[base + j * nx]
    dt1d(f, ny, out, v, z, wy)
    for (let j = 0; j < ny; j++) d[base + j * nx] = out[j]
  }
  // eixo z
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const base = i + j * nx
    for (let k = 0; k < nz; k++) f[k] = d[base + k * nx * ny]
    dt1d(f, nz, out, v, z, wz)
    for (let k = 0; k < nz; k++) d[base + k * nx * ny] = out[k]
  }
  return d
}

// ---------------------------------------------------------------- surface nets
/**
 * Malha da fronteira de uma máscara binária (amostras nos centros dos voxels).
 * Um vértice por célula mista (centroide dos cruzamentos de aresta); um quad por
 * aresta com mudança de sinal, orientado para fora da máscara.
 * @returns {{verts: Float32Array (n×3, coords de voxel), faces: Int32Array (m×3)}}
 */
export function surfaceNets (mask, dims) {
  const [nx, ny, nz] = dims
  const cx = nx - 1, cy = ny - 1, cz = nz - 1
  const cellIdx = new Int32Array(cx * cy * cz).fill(-1)
  const vx = []
  const at = (i, j, k) => mask[i + j * nx + k * nx * ny]
  // vértices
  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        const c = [at(i, j, k), at(i + 1, j, k), at(i, j + 1, k), at(i + 1, j + 1, k),
          at(i, j, k + 1), at(i + 1, j, k + 1), at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1)]
        const s = c[0] + c[1] + c[2] + c[3] + c[4] + c[5] + c[6] + c[7]
        if (s === 0 || s === 8) continue
        // centroide dos cruzamentos das 12 arestas
        let px = 0, py = 0, pz = 0, cnt = 0
        const E = [[0, 1, 1, 0, 0], [2, 3, 1, 1, 0], [4, 5, 1, 0, 1], [6, 7, 1, 1, 1],
          [0, 2, 2, 0, 0], [1, 3, 2, 1, 0], [4, 6, 2, 0, 1], [5, 7, 2, 1, 1],
          [0, 4, 3, 0, 0], [1, 5, 3, 1, 0], [2, 6, 3, 0, 1], [3, 7, 3, 1, 1]]
        for (const [a, b, ax, u, w] of E) {
          if (c[a] === c[b]) continue
          cnt++
          if (ax === 1) { px += 0.5; py += u; pz += w } else if (ax === 2) { px += u; py += 0.5; pz += w } else { px += u; py += w; pz += 0.5 }
        }
        cellIdx[i + j * cx + k * cx * cy] = vx.length / 3
        vx.push(i + px / cnt, j + py / cnt, k + pz / cnt)
      }
    }
  }
  // faces: uma por aresta da grade com mudança de sinal (entre voxels adjacentes),
  // ligando as 4 células que compartilham a aresta
  const faces = []
  const cell = (i, j, k) => cellIdx[i + j * cx + k * cx * cy]
  const quad = (a, b, c2, d2, flip) => {
    if (a < 0 || b < 0 || c2 < 0 || d2 < 0) return
    if (flip) { faces.push(a, d2, c2, a, c2, b) } else { faces.push(a, b, c2, a, c2, d2) }
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v0 = at(i, j, k)
        // aresta +x: células (i, j-1..j, k-1..k)
        if (i + 1 < nx && j > 0 && k > 0 && j < cy && k < cz) {
          const v1 = at(i + 1, j, k)
          if (v0 !== v1) quad(cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k), v0 === 0)
        }
        // aresta +y
        if (j + 1 < ny && i > 0 && k > 0 && i < cx && k < cz) {
          const v1 = at(i, j + 1, k)
          if (v0 !== v1) quad(cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1), v0 === 0)
        }
        // aresta +z
        if (k + 1 < nz && i > 0 && j > 0 && i < cx && j < cy) {
          const v1 = at(i, j, k + 1)
          if (v0 !== v1) quad(cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k), v0 === 0)
        }
      }
    }
  }
  return { verts: Float32Array.from(vx), faces: Int32Array.from(faces) }
}

/**
 * Torna a máscara "bem composta" (análogo ao mri_pretess), IN PLACE: preenche os
 * voxels que só se tocam por aresta (quadrado 2×2 em xadrez) ou por vértice (cubo
 * 2×2×2 com apenas dois cantos opostos cheios — ou vazios). Nessas configurações o
 * surface nets gera arestas usadas por 4 faces e vértices não-variedade, e o χ de
 * Euler deixa de medir alças (numa bola ruidosa: 1.574 arestas não-variedade e
 * χ = −32; depois, toda aresta em exatamente 2 faces e o χ conta só alças reais).
 * Só ACRESCENTA voxels; repete até estabilizar. Pode fechar bolsões de fundo:
 * chame fillCavities depois.
 * @returns {number} voxels acrescentados
 */
export function wellComposed (mask, dims, maxPasses = 30) {
  const [nx, ny, nz] = dims
  const sx = 1, sy = nx, sz = nx * ny
  let added = 0
  const set = (i) => { if (!mask[i]) { mask[i] = 1; added++; return 1 } return 0 }
  for (let pass = 0; pass < maxPasses; pass++) {
    let ch = 0
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = i + j * sy + k * sz
      // quadrados 2×2 nos três planos: a d na diagonal, b c na outra
      for (const [ua, ub, ok] of [[sx, sy, i + 1 < nx && j + 1 < ny], [sx, sz, i + 1 < nx && k + 1 < nz], [sy, sz, j + 1 < ny && k + 1 < nz]]) {
        if (!ok) continue
        const a = mask[v], b = mask[v + ua], c = mask[v + ub], d = mask[v + ua + ub]
        if (a === d && b === c && a !== b) {
          if (a) { ch += set(v + ua) + set(v + ub) } else { ch += set(v) + set(v + ua + ub) }
        }
      }
      // cubo 2×2×2: só dois cantos opostos cheios (ou só dois vazios)
      if (i + 1 < nx && j + 1 < ny && k + 1 < nz) {
        const c0 = mask[v], c1 = mask[v + sx], c2 = mask[v + sy], c3 = mask[v + sx + sy]
        const c4 = mask[v + sz], c5 = mask[v + sx + sz], c6 = mask[v + sy + sz], c7 = mask[v + sx + sy + sz]
        const cnt = c0 + c1 + c2 + c3 + c4 + c5 + c6 + c7
        if (cnt !== 2 && cnt !== 6) continue
        const want = cnt === 2 ? 1 : 0
        const pares = [[0, 7], [1, 6], [2, 5], [3, 4]]
        const cs = [c0, c1, c2, c3, c4, c5, c6, c7]
        const off = [0, sx, sy, sx + sy, sz, sx + sz, sy + sz, sx + sy + sz]
        for (const [p, q] of pares) {
          if (cs[p] !== want || cs[q] !== want) continue
          if (want) {
            // liga os dois cantos por faces: acrescenta um caminho de 2 voxels
            const pi = [p & 1, (p >> 1) & 1, (p >> 2) & 1]
            const m1 = (pi[0] ^ 1) | (pi[1] << 1) | (pi[2] << 2)
            const m2 = (pi[0] ^ 1) | ((pi[1] ^ 1) << 1) | (pi[2] << 2)
            ch += set(v + off[m1]) + set(v + off[m2])
          } else {
            ch += set(v + off[p]) + set(v + off[q])
          }
        }
      }
    }
    if (!ch) break
  }
  return added
}

// ---------------------------------------------------------------- suavização de Taubin
/** Taubin λ|μ com pesos uniformes — suaviza sem o encolhimento do Laplace puro. */
export function taubinSmooth (verts, faces, iters = 12, lambda = 0.5, mu = -0.53) {
  const nv = verts.length / 3
  // adjacência compacta
  const deg = new Int32Array(nv)
  for (let f = 0; f < faces.length; f += 3) {
    deg[faces[f]] += 2; deg[faces[f + 1]] += 2; deg[faces[f + 2]] += 2
  }
  const off = new Int32Array(nv + 1)
  for (let i = 0; i < nv; i++) off[i + 1] = off[i] + deg[i]
  const adj = new Int32Array(off[nv])
  const fill = new Int32Array(nv)
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    adj[off[a] + fill[a]++] = b; adj[off[a] + fill[a]++] = c
    adj[off[b] + fill[b]++] = a; adj[off[b] + fill[b]++] = c
    adj[off[c] + fill[c]++] = a; adj[off[c] + fill[c]++] = b
  }
  let cur = Float32Array.from(verts)
  let nxt = new Float32Array(verts.length)
  const pass = (factor) => {
    for (let i = 0; i < nv; i++) {
      const s = off[i], e = off[i + 1]
      if (s === e) {
        nxt[i * 3] = cur[i * 3]; nxt[i * 3 + 1] = cur[i * 3 + 1]; nxt[i * 3 + 2] = cur[i * 3 + 2]
        continue
      }
      let ax = 0, ay = 0, az = 0
      for (let p = s; p < e; p++) {
        const q = adj[p] * 3
        ax += cur[q]; ay += cur[q + 1]; az += cur[q + 2]
      }
      const inv = 1 / (e - s)
      nxt[i * 3] = cur[i * 3] + factor * (ax * inv - cur[i * 3])
      nxt[i * 3 + 1] = cur[i * 3 + 1] + factor * (ay * inv - cur[i * 3 + 1])
      nxt[i * 3 + 2] = cur[i * 3 + 2] + factor * (az * inv - cur[i * 3 + 2])
    }
    const t = cur; cur = nxt; nxt = t
  }
  for (let it = 0; it < iters; it++) { pass(lambda); pass(mu) }
  return cur
}

/** área total e por-face de uma malha (mm² se os vértices estiverem em mm) */
export function meshAreas (verts, faces) {
  const per = new Float32Array(faces.length / 3)
  let total = 0
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const wx = verts[c] - verts[a], wy = verts[c + 1] - verts[a + 1], wz = verts[c + 2] - verts[a + 2]
    const crx = uy * wz - uz * wy, cry = uz * wx - ux * wz, crz = ux * wy - uy * wx
    const area = 0.5 * Math.sqrt(crx * crx + cry * cry + crz * crz)
    per[f / 3] = area
    total += area
  }
  return { per, total }
}

/** aplica a affine (linhas 4×4, voxel→mm) aos vértices em coordenadas de voxel */
export function applyAffine (verts, A) {
  const out = new Float32Array(verts.length)
  for (let i = 0; i < verts.length; i += 3) {
    const x = verts[i], y = verts[i + 1], z = verts[i + 2]
    out[i] = A[0] * x + A[1] * y + A[2] * z + A[3]
    out[i + 1] = A[4] * x + A[5] * y + A[6] * z + A[7]
    out[i + 2] = A[8] * x + A[9] * y + A[10] * z + A[11]
  }
  return out
}

/** tamanho do voxel (mm) por eixo de voxel: normas das colunas da parte linear da affine */
export function spacingOfAffine (A) {
  return [0, 1, 2].map(c => Math.hypot(A[c], A[4 + c], A[8 + c]))
}

/** determinante da parte linear 3×3 da affine (linhas 4×4 achatadas) */
export function affineDet (A) {
  return A[0] * (A[5] * A[10] - A[6] * A[9]) -
    A[1] * (A[4] * A[10] - A[6] * A[8]) +
    A[2] * (A[4] * A[9] - A[5] * A[8])
}

/**
 * Faces com a orientação correta no espaço de mundo. O surface nets orienta as faces
 * para fora no espaço de ÍNDICES; se a affine inverte a orientação (det < 0, caso da
 * conformação LIA do FreeSurfer), as normais ficariam para dentro no espaço RAS —
 * inverte-se então a ordem dos vértices de cada triângulo.
 */
export function facesForAffine (faces, A) {
  if (affineDet(A) >= 0) return faces
  const out = new Int32Array(faces.length)
  for (let f = 0; f < faces.length; f += 3) { out[f] = faces[f]; out[f + 1] = faces[f + 2]; out[f + 2] = faces[f + 1] }
  return out
}

/**
 * Área por vértice (mm² com vértices em mm): 1/3 da área de cada face adjacente,
 * como o v->area do FreeSurfer (fix_vertex_area) — a soma por rótulo é o SurfArea
 * do aparc.stats.
 */
export function vertexAreas (verts, faces) {
  const out = new Float64Array(verts.length / 3)
  const { per } = meshAreas(verts, faces)
  for (let f = 0; f < faces.length; f += 3) {
    const a3 = per[f / 3] / 3
    out[faces[f]] += a3; out[faces[f + 1]] += a3; out[faces[f + 2]] += a3
  }
  return out
}

/**
 * Volume cortical por vértice entre white e pial de MESMA topologia (mm³): cada face
 * gera um prisma white→pial decomposto em 3 tetraedros — o GrayVol do
 * mris_anatomical_stats -th3 —, repartido em terços pelos vértices da face.
 */
export function vertexVolumesTH3 (white, pial, faces) {
  const out = new Float64Array(white.length / 3)
  const tet = (P, Q, R, S) => {
    const ax = Q[0] - P[0], ay = Q[1] - P[1], az = Q[2] - P[2]
    const bx = R[0] - P[0], by = R[1] - P[1], bz = R[2] - P[2]
    const cx = S[0] - P[0], cy = S[1] - P[1], cz = S[2] - P[2]
    return Math.abs(ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  const pt = (V, i) => [V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    const w0 = pt(white, a), w1 = pt(white, b), w2 = pt(white, c)
    const p0 = pt(pial, a), p1 = pt(pial, b), p2 = pt(pial, c)
    const v = tet(w0, w1, w2, p2) + tet(w0, w1, p1, p2) + tet(w0, p0, p1, p2)
    if (!Number.isFinite(v)) continue
    out[a] += v / 3; out[b] += v / 3; out[c] += v / 3
  }
  return out
}

/** escreve MZ3 (faces + vértices + RGBA opcional), little-endian, sem compressão */
export function writeMz3 (verts, faces, rgba = null) {
  const nvert = verts.length / 3
  const nface = faces.length / 3
  const attr = 1 | 2 | (rgba ? 4 : 0)
  const bytes = 16 + nface * 12 + nvert * 12 + (rgba ? nvert * 4 : 0)
  const buf = new ArrayBuffer(bytes)
  const dv = new DataView(buf)
  dv.setUint16(0, 23117, true)
  dv.setUint16(2, attr, true)
  dv.setUint32(4, nface, true)
  dv.setUint32(8, nvert, true)
  dv.setUint32(12, 0, true)
  new Int32Array(buf, 16, nface * 3).set(faces)
  new Float32Array(buf, 16 + nface * 12, nvert * 3).set(verts)
  if (rgba) new Uint8Array(buf, 16 + nface * 12 + nvert * 12, nvert * 4).set(rgba)
  return buf
}
