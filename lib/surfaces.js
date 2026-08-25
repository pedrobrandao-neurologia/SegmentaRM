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
function dt1d (f, n, d2, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d2[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/**
 * Distância euclidiana ao quadrado até o voxel semente mais próximo (grade isotrópica).
 * @param {Uint8Array} seeds máscara (1 = semente)
 * @returns {Float32Array} d² em voxels²
 */
export function edt3d (seeds, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const INF = 1e12
  const d = new Float32Array(n)
  for (let i = 0; i < n; i++) d[i] = seeds[i] ? 0 : INF
  const maxN = Math.max(nx, ny, nz)
  const f = new Float32Array(maxN)
  const out = new Float32Array(maxN)
  const v = new Int32Array(maxN)
  const z = new Float32Array(maxN + 1)
  // eixo x
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const base = j * nx + k * nx * ny
    for (let i = 0; i < nx; i++) f[i] = d[base + i]
    dt1d(f, nx, out, v, z)
    for (let i = 0; i < nx; i++) d[base + i] = out[i]
  }
  // eixo y
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const base = i + k * nx * ny
    for (let j = 0; j < ny; j++) f[j] = d[base + j * nx]
    dt1d(f, ny, out, v, z)
    for (let j = 0; j < ny; j++) d[base + j * nx] = out[j]
  }
  // eixo z
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const base = i + j * nx
    for (let k = 0; k < nz; k++) f[k] = d[base + k * nx * ny]
    dt1d(f, nz, out, v, z)
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
