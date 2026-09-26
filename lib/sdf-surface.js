// sdf-surface.js — núcleo geométrico do recon-all-clinical no navegador.
// Réplica cuidadosa das peças do FreeSurfer usadas pelo recon-all-clinical.sh e
// pelo mri_synth_surf.py (Gopinath et al., Medical Image Analysis 2025), lida do
// código-fonte (branch dev do freesurfer/freesurfer):
//   · SDF assinada (negativa por dentro, recorte ±5 mm — convenção do SynthDist)
//   · partição hemisférica por transformada de distância dos rótulos lateralizados
//     (exatamente como filled.mgz: Dleft < Dright)
//   · imagem sintética norm.mgz: F = 70·(1−(tanh(2(W+0,3))+1)/2) + 40·(1−(tanh(2P)+1)/2)
//   · colocação da WHITE pela energia da Eq. 5 do artigo — fidelidade tanh(D)²
//     + molas normal/tangencial de Dale et al. 1999 (λ1 = 0,0006, λ2 = 0,0002),
//     descida de gradiente com monitoração de deslocamento
//   · PIAL por raios a partir da white (placePialByRay): para no nível zero da
//     pial ou na linha média do sulco. A descida pelo gradiente da SDF pial (com
//     molas ≈ 1/800 do termo de dados) fazia as paredes dos sulcos fechados
//     escorregarem e se aglomerarem ("pipoca")
//   · característica de Euler (χ = V − E + F) e QC de malha (qcMalha: dobras,
//     faces invertidas, arestas) — o mris_fix_topology (cirurgia de variedade)
//     NÃO é portado: defeitos são relatados, não corrigidos
//   · transformada de Talairach por casamento de centros de massa (getM do
//     mri_synth_surf.py, com a tabela de COGs do MNI ICBM152 embutida)

import { edt3d } from './surfaces.js'

// ---------------------------------------------------------------- SDF de máscara
/**
 * SDF assinada a partir de uma máscara binária: negativa dentro, positiva fora,
 * zero na face entre voxels (meio voxel descontado de cada lado), recorte ±clip.
 * Em mm quando `spacing` é dado (EDT anisotrópica); sem ele, voxel ≡ mm. Com voxel
 * anisotrópico desconta-se meio voxel do eixo mais fino: o nível zero entre dois
 * vizinhos dentro/fora continua exatamente na face (os valores são simétricos).
 * O resultado reaproveita o buffer da EDT externa (pico de 2 Float32, não 3).
 */
export function signedSdfFromMask (mask, dims, clip = 5, spacing = null) {
  const n = mask.length
  const half = spacing ? 0.5 * Math.min(...spacing) : 0.5
  const inv = new Uint8Array(n)
  for (let i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1
  const dIn2 = edt3d(inv, dims, spacing)
  const sdf = edt3d(mask, dims, spacing) // d² externa, sobrescrita pela SDF
  for (let i = 0; i < n; i++) {
    const v = mask[i] ? -(Math.sqrt(dIn2[i]) - half) : (Math.sqrt(sdf[i]) - half)
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
export function hemispherePartition (leftSeeds, rightSeeds, dims, spacing = null) {
  const dl = edt3d(leftSeeds, dims, spacing)
  const dr = edt3d(rightSeeds, dims, spacing)
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
 * Vértices em coordenadas de voxel; internamente a descida roda em mm (vértices
 * escalados por `spacing`), então passos, tolerância, molas e normais valem em mm
 * também com voxel anisotrópico. A SDF deve estar em mm.
 * Usada só para a WHITE: o alvo (borda SB/córtex) é bem definido e a malha de
 * partida (tesselação da máscara) já está a < 1 voxel dele. Para a pial, cujo alvo
 * tem sulcos fechados, ver placePialByRay.
 * @param {Float32Array} verts malha inicial (modificada IN PLACE)
 * @param {Float32Array} sdf volume SDF
 * @returns {{iters:number, meanMove:number, naoFinitos:number}}
 */
export function placeSurface (verts, faces, sdf, dims, opts = {}) {
  const {
    lambdaN = 0.0006, lambdaT = 0.0002, step = 0.4, iters = 150,
    maxMove = 0.5, tol = 0.005, onIter = null,
    spacing = null, neigh = null
  } = opts
  const [sx0, sy0, sz0] = spacing || [1, 1, 1]
  const nV = verts.length / 3
  const { off, adj } = neigh || buildNeighbors(nV, faces)
  // coordenadas de trabalho em mm (escala diagonal: preserva a orientação das faces)
  const P = new Float32Array(verts.length)
  for (let i = 0; i < verts.length; i += 3) { P[i] = verts[i] * sx0; P[i + 1] = verts[i + 1] * sy0; P[i + 2] = verts[i + 2] * sz0 }
  const N = new Float32Array(verts.length)
  const delta = new Float32Array(verts.length)
  let it = 0, meanMove = Infinity, naoFinitos = 0
  // amostragem e gradiente (diferença central de ±½ voxel) em mm
  const smp = (vol, x, y, z) => trilinear(vol, dims, x / sx0, y / sy0, z / sz0)
  const gr = [0, 0, 0]
  const g = (vol, x, y, z) => {
    gr[0] = (smp(vol, x + 0.5 * sx0, y, z) - smp(vol, x - 0.5 * sx0, y, z)) / sx0
    gr[1] = (smp(vol, x, y + 0.5 * sy0, z) - smp(vol, x, y - 0.5 * sy0, z)) / sy0
    gr[2] = (smp(vol, x, y, z + 0.5 * sz0) - smp(vol, x, y, z - 0.5 * sz0)) / sz0
    return gr
  }
  for (it = 0; it < iters; it++) {
    vertexNormals(P, faces, N)
    let acc = 0
    for (let v = 0; v < nV; v++) {
      const i = v * 3
      const x = P[i], y = P[i + 1], z = P[i + 2]
      // fidelidade: ∇ tanh(D)² = 2·t·(1−t²)·∇D — o tanh satura longe do nível
      // zero, então soma-se uma advecção linear limitada (kFar·clamp(D,±1)·∇D)
      // que só acelera a APROXIMAÇÃO; no nível zero ambas se anulam juntas
      const D = smp(sdf, x, y, z)
      const t = Math.tanh(D)
      const gd = g(sdf, x, y, z)
      const cf = 2 * t * (1 - t * t) + 0.5 * Math.max(-1, Math.min(1, D))
      let fx = -cf * gd[0], fy = -cf * gd[1], fz = -cf * gd[2]
      // molas: soma dos vizinhos relativa ao vértice, decomposta pela normal
      let sx = 0, sy = 0, sz = 0
      for (let e = off[v]; e < off[v + 1]; e++) {
        const u = adj[e] * 3
        sx += P[u] - x; sy += P[u + 1] - y; sz += P[u + 2] - z
      }
      const nxv = N[i], nyv = N[i + 1], nzv = N[i + 2]
      const sn = sx * nxv + sy * nyv + sz * nzv
      fx += 2 * lambdaN * sn * nxv + 2 * lambdaT * (sx - sn * nxv)
      fy += 2 * lambdaN * sn * nyv + 2 * lambdaT * (sy - sn * nyv)
      fz += 2 * lambdaN * sn * nzv + 2 * lambdaT * (sz - sn * nzv)
      let dx = step * fx, dy = step * fy, dz = step * fz
      const m = Math.hypot(dx, dy, dz)
      // SDF com NaN/Inf (saída de rede corrompida) não pode contaminar a malha:
      // o vértice fica parado nesta iteração e o caso é contado
      if (!Number.isFinite(m)) { dx = dy = dz = 0; naoFinitos++ } else if (m > maxMove) { const s2 = maxMove / m; dx *= s2; dy *= s2; dz *= s2 }
      delta[i] = dx; delta[i + 1] = dy; delta[i + 2] = dz
      acc += Math.hypot(dx, dy, dz)
    }
    for (let i = 0; i < P.length; i++) P[i] += delta[i]
    meanMove = acc / nV
    if (onIter) onIter(it, meanMove)
    if (meanMove < tol) break
  }
  for (let i = 0; i < verts.length; i += 3) { verts[i] = P[i] / sx0; verts[i + 1] = P[i + 1] / sy0; verts[i + 2] = P[i + 2] / sz0 }
  return { iters: Math.min(it + 1, iters), meanMove, naoFinitos }
}

// ------------------------------------------------------ pial por raio (perfil)
/**
 * Pial a partir da white por busca ao longo de RAIOS (no espírito da busca de
 * perfil do mris_place_surface, sem a descida livre de gradiente):
 *   1. normais da white (em mm) suavizadas por `nsmNormais` médias de vizinhos —
 *      raios vizinhos quase paralelos, sem cruzar nas cristas;
 *   2. para cada vértice, marcha de `dt` mm ao longo da normal até o PRIMEIRO de:
 *      · P ≥ 0 (saiu da pial; posição por interpolação linear do cruzamento);
 *      · linha média do sulco: a SDF da white para de crescer ao longo do raio
 *        (inclinação dW/ds < `inclinMin`) — o raio chegou ao eixo medial entre os
 *        dois bancos. É o que separa as paredes de um sulco FECHADO (sem LCR visível,
 *        P < 0 dos dois lados): cada banco para no meio, em vez de escorregar pela
 *        parede como na descida pelo gradiente;
 *      · teto `tmax` mm (5 mm, o mesmo teto da espessura do FreeSurfer);
 *   3. o campo ESCALAR t (espessura ao longo do raio) é suavizado na malha por
 *      `nsmT` passos (não as posições: a forma da white é preservada);
 *   4. pial = white + t·n. Mesma topologia e correspondência vértice a vértice da
 *      white (necessárias ao GrayVol -th3 e à espessura). t ≥ 0: a pial nunca
 *      entra na white ao longo do próprio raio.
 * Não há laço aberto: custo fixo de ⌈tmax/dt⌉ amostras por vértice.
 * @param {Float32Array} white vértices da white (coords de voxel), não alterados
 * @param {Int32Array} faces
 * @param {Float32Array} W SDF da white (mm, negativa por dentro)
 * @param {Float32Array} P SDF da pial (mm, negativa por dentro)
 * @param {number[]} dims
 * @returns {{verts: Float32Array, t: Float32Array, motivo: {pial:number, sulco:number, teto:number, nula:number}}}
 *          verts em coords de voxel; t em mm; motivo = contagem de vértices por
 *          critério de parada (nula: a white já está fora da pial, t = 0)
 */
export function placePialByRay (white, faces, W, P, dims, opts = {}) {
  const {
    spacing = null, neigh = null, tmax = 5, dt = 0.1, nsmNormais = 10, nsmT = 5,
    inclinMin = 0.1, sMin = 0.5, tolPlat = 0.02, passosDesinv = 30, onProgress = null
  } = opts
  const [sx, sy, sz] = spacing || [1, 1, 1]
  const platMax = Math.max(sx, sy, sz) + 1e-6
  const nV = white.length / 3
  const { off, adj } = neigh || buildNeighbors(nV, faces)
  const Wm = new Float32Array(white.length)
  for (let i = 0; i < white.length; i += 3) { Wm[i] = white[i] * sx; Wm[i + 1] = white[i + 1] * sy; Wm[i + 2] = white[i + 2] * sz }
  const smp = (vol, x, y, z) => trilinear(vol, dims, x / sx, y / sy, z / sz)

  // 1. normais suavizadas (média com os vizinhos, renormalizada)
  const N = vertexNormals(Wm, faces)
  const tmp = new Float32Array(N.length)
  for (let k = 0; k < nsmNormais; k++) {
    for (let v = 0; v < nV; v++) {
      const i = v * 3
      let x = N[i], y = N[i + 1], z = N[i + 2]
      for (let e = off[v]; e < off[v + 1]; e++) { const u = adj[e] * 3; x += N[u]; y += N[u + 1]; z += N[u + 2] }
      const m = Math.hypot(x, y, z)
      if (m > 1e-12) { tmp[i] = x / m; tmp[i + 1] = y / m; tmp[i + 2] = z / m } else { tmp[i] = N[i]; tmp[i + 1] = N[i + 1]; tmp[i + 2] = N[i + 2] }
    }
    N.set(tmp)
  }
  // orientação: as normais devem apontar para FORA da white (sentido de ∇W).
  // Decide-se pela maioria — não depende da convenção de ordem das faces
  let conc = 0
  for (let v = 0; v < nV; v += 7) {
    const i = v * 3, h = 0.5
    const d = smp(W, Wm[i] + h * N[i], Wm[i + 1] + h * N[i + 1], Wm[i + 2] + h * N[i + 2]) -
              smp(W, Wm[i] - h * N[i], Wm[i + 1] - h * N[i + 1], Wm[i + 2] - h * N[i + 2])
    if (d > 0) conc++; else if (d < 0) conc--
  }
  if (conc < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i]

  // 2. marcha ao longo do raio
  const t = new Float32Array(nV)
  const motivo = { pial: 0, sulco: 0, teto: 0, nula: 0 }
  const nPassos = Math.ceil(tmax / dt)
  const lote = Math.max(1, Math.floor(nV / 10))
  for (let v = 0; v < nV; v++) {
    const i = v * 3
    const x0 = Wm[i], y0 = Wm[i + 1], z0 = Wm[i + 2]
    const nx = N[i], ny = N[i + 1], nz = N[i + 2]
    let pPrev = smp(P, x0, y0, z0)
    let wPrev = smp(W, x0, y0, z0)
    let best = tmax
    if (!(pPrev < 0)) { t[v] = 0; motivo.nula++; continue } // white fora da pial (ou SDF não finita)
    let why = 'teto'
    for (let q = 1; q <= nPassos; q++) {
      const s = Math.min(tmax, q * dt)
      const x = x0 + s * nx, y = y0 + s * ny, z = z0 + s * nz
      const p = smp(P, x, y, z)
      if (!(p < 0)) { // saiu da pial (NaN também encerra o raio)
        best = Number.isFinite(p) && p > pPrev ? s - dt * p / (p - pPrev) : s - dt
        why = 'pial'
        break
      }
      const w = smp(W, x, y, z)
      if (s > sMin && (w - wPrev) < inclinMin * dt) {
        // topo de W alcançado. Com SDF amostrada em voxels (EDT) o topo é um
        // PATAMAR de até um voxel de largura cujo centro é a linha média; percorre-o
        // (no máximo `platMax` mm, parando se sair da pial) e fica no meio dele
        const sIni = s - dt
        let sFim = sIni
        for (let r = 1; r * dt <= platMax; r++) {
          const s2 = sIni + r * dt
          if (s2 > tmax) break
          const x2 = x0 + s2 * nx, y2 = y0 + s2 * ny, z2 = z0 + s2 * nz
          if (!(smp(P, x2, y2, z2) < 0)) break
          if (Math.abs(smp(W, x2, y2, z2) - wPrev) > tolPlat) break
          sFim = s2
        }
        best = 0.5 * (sIni + sFim); why = 'sulco'; break
      }
      pPrev = p; wPrev = w
    }
    t[v] = Math.max(0, Math.min(tmax, best))
    motivo[why]++
    if (onProgress && v % lote === 0) onProgress(v / nV)
  }

  // 3. suavização do campo escalar t na malha
  const t2 = new Float32Array(nV)
  for (let k = 0; k < nsmT; k++) {
    for (let v = 0; v < nV; v++) {
      let sm = t[v], c = 1
      for (let e = off[v]; e < off[v + 1]; e++) { sm += t[adj[e]]; c++ }
      t2[v] = 0.5 * t[v] + 0.5 * sm / c
    }
    t.set(t2)
  }

  // 4. deslocamento d = t·n (mm)
  const d = new Float32Array(white.length)
  for (let v = 0; v < nV; v++) {
    const i = v * 3
    d[i] = t[v] * N[i]; d[i + 1] = t[v] * N[i + 1]; d[i + 2] = t[v] * N[i + 2]
  }

  // 5. desinversão local: onde raios convergentes (fundos côncavos) cruzaram e a
  // face "virou", o campo de deslocamento é suavizado SÓ nos vértices dessas faces
  // (média com os vizinhos). Um campo localmente uniforme translada o triângulo da
  // white sem invertê-lo. Número fixo de passos; para quando nada mais muda
  const nWf = faceNormals(Wm, faces)
  const Pm = new Float32Array(white.length)
  const marca = new Uint8Array(nV)
  const d2 = new Float32Array(d.length)
  let desinv = 0
  for (let k = 0; k < passosDesinv; k++) {
    for (let i = 0; i < Pm.length; i++) Pm[i] = Wm[i] + d[i]
    marca.fill(0)
    let nInv = 0
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
      const ux = Pm[b] - Pm[a], uy = Pm[b + 1] - Pm[a + 1], uz = Pm[b + 2] - Pm[a + 2]
      const vx = Pm[c] - Pm[a], vy = Pm[c + 1] - Pm[a + 1], vz = Pm[c + 2] - Pm[a + 2]
      const dot = (uy * vz - uz * vy) * nWf[f] + (uz * vx - ux * vz) * nWf[f + 1] + (ux * vy - uy * vx) * nWf[f + 2]
      if (dot < 0) { marca[faces[f]] = 1; marca[faces[f + 1]] = 1; marca[faces[f + 2]] = 1; nInv++ }
    }
    if (!nInv) break
    desinv = k + 1
    d2.set(d)
    for (let v = 0; v < nV; v++) {
      if (!marca[v]) continue
      const i = v * 3
      let x = 0, y = 0, z = 0, c = 0
      for (let e = off[v]; e < off[v + 1]; e++) { const u = adj[e] * 3; x += d[u]; y += d[u + 1]; z += d[u + 2]; c++ }
      if (!c) continue
      d2[i] = 0.5 * d[i] + 0.5 * x / c; d2[i + 1] = 0.5 * d[i + 1] + 0.5 * y / c; d2[i + 2] = 0.5 * d[i + 2] + 0.5 * z / c
    }
    d.set(d2)
  }

  // 6. pial = white + d, de volta a coords de voxel; t final = |d|
  const out = new Float32Array(white.length)
  for (let v = 0; v < nV; v++) {
    const i = v * 3
    out[i] = (Wm[i] + d[i]) / sx
    out[i + 1] = (Wm[i + 1] + d[i + 1]) / sy
    out[i + 2] = (Wm[i + 2] + d[i + 2]) / sz
    t[v] = Math.hypot(d[i], d[i + 1], d[i + 2])
  }
  return { verts: out, t, motivo, passosDesinv: desinv }
}

// ------------------------------------------------------------ QC da malha
/** normais unitárias por face (Float32Array nF×3; face degenerada → 0,0,0) */
function faceNormals (verts, faces) {
  const out = new Float32Array(faces.length)
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
    const ux = verts[b] - verts[a], uy = verts[b + 1] - verts[a + 1], uz = verts[b + 2] - verts[a + 2]
    const vx = verts[c] - verts[a], vy = verts[c + 1] - verts[a + 1], vz = verts[c + 2] - verts[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const m = Math.hypot(nx, ny, nz)
    if (m > 1e-12) { out[f] = nx / m; out[f + 1] = ny / m; out[f + 2] = nz / m }
  }
  return out
}

/** percentil q (0..1) de um Float32Array (ordena uma cópia) */
function percentil (arr, q) {
  if (!arr.length) return 0
  const s = Float32Array.from(arr).sort()
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}

/**
 * Limites do QC de malha para VISUALIZAÇÃO confiável. Calibrados no T1 real
 * (chris_t1) contra a inspeção visual das renderizações:
 *   · dobrasPct 5 — dobras agudas (diedro > 120°) numa superfície cortical lisa
 *     são raras (white: 0,03–0,3 %; pial por raio: 0,8–2 %); a colocação antiga
 *     pelo gradiente, com "pipoca" visível, dava 16 % com a rede;
 *   · invertidasPct 10 — faces que viram entre white e pial concentram-se nos
 *     fundos côncavos dos sulcos (raios convergentes), escondidas na vista 3D; o
 *     protótipo sem desinversão tinha 10–13 % e ainda se lia como cérebro; acima
 *     disso as inversões chegam às paredes visíveis (colocação antiga: 14–15 %);
 *   · arestaP99Rel 2,5 e arestaP99_mm 4 — a aresta p99 da pial deve ficar abaixo
 *     de max(4 mm, 2,5 × aresta p99 da white): aglomeração de vértices nas cristas
 *     com arestas esticadas nas paredes (a "pipoca" da EDT com 3 % de dobras) dá
 *     p99 ≈ 7 mm contra 1,5–1,9 mm na white; a pial por raio fica em ≈ 3 mm.
 *     A parte relativa acompanha grades mais grossas (voxel anisotrópico).
 */
export const QC_MALHA_LIMITES = { dobrasPct: 5, invertidasPct: 10, arestaP99_mm: 4, arestaP99Rel: 2.5 }

/**
 * QC automático de um par white/pial de MESMA topologia (vértices em mm):
 *   · dobrasPialPct/dobrasWhitePct: % das arestas internas cujas duas faces têm
 *     normais a mais de 120° uma da outra (cos < −0,5) — dobra aguda, "pipoca";
 *   · invertidasPct: % das faces cuja normal na pial aponta contra a normal da
 *     mesma face na white (a face "virou" no caminho white→pial);
 *   · aresta mediana/p99 (mm) da pial e da white — aglomeração/esticamento;
 *   · χ de Euler (V − E + F; 2 = esfera) e arestas não-variedade (≠ 2 faces);
 *   · áreas (cm²).
 * @returns {object} métricas + `confiavel` (booleano pelos QC_MALHA_LIMITES)
 */
export function qcMalha (whiteMm, pialMm, faces, limites = QC_MALHA_LIMITES) {
  const nV = whiteMm.length / 3
  const nF = faces.length / 3
  const nW = faceNormals(whiteMm, faces)
  const nP = faceNormals(pialMm, faces)
  // arestas → par de faces: listas por vértice de menor índice (CSR), sem Map
  const cnt = new Int32Array(nV + 1)
  for (let f = 0; f < faces.length; f += 3) {
    for (let e = 0; e < 3; e++) { const a = faces[f + e], b = faces[f + (e + 1) % 3]; cnt[(a < b ? a : b) + 1]++ }
  }
  for (let v = 0; v < nV; v++) cnt[v + 1] += cnt[v]
  const other = new Int32Array(faces.length)
  const fOf = new Int32Array(faces.length)
  const fill = cnt.slice(0, nV)
  for (let f = 0; f < faces.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = faces[f + e], b = faces[f + (e + 1) % 3]
      const lo = a < b ? a : b, hi = a < b ? b : a
      const k = fill[lo]++
      other[k] = hi; fOf[k] = f
    }
  }
  let nE = 0, nPares = 0, naoVariedade = 0, dobrasP = 0, dobrasW = 0
  const arestasP = new Float32Array(faces.length / 2 + 8)
  const arestasW = new Float32Array(faces.length / 2 + 8)
  let nA = 0
  const usado = new Uint8Array(faces.length)
  for (let v = 0; v < nV; v++) {
    for (let k = cnt[v]; k < cnt[v + 1]; k++) {
      if (usado[k]) continue
      const hi = other[k]
      let m = 1, k2 = -1
      for (let j = k + 1; j < cnt[v + 1]; j++) if (!usado[j] && other[j] === hi) { usado[j] = 1; m++; if (k2 < 0) k2 = j }
      usado[k] = 1
      nE++
      if (nA < arestasP.length) {
        const a = v * 3, b = hi * 3
        arestasP[nA] = Math.hypot(pialMm[a] - pialMm[b], pialMm[a + 1] - pialMm[b + 1], pialMm[a + 2] - pialMm[b + 2])
        arestasW[nA] = Math.hypot(whiteMm[a] - whiteMm[b], whiteMm[a + 1] - whiteMm[b + 1], whiteMm[a + 2] - whiteMm[b + 2])
        nA++
      }
      if (m !== 2) { naoVariedade++; continue }
      const f1 = fOf[k], f2 = fOf[k2]
      nPares++
      if (nP[f1] * nP[f2] + nP[f1 + 1] * nP[f2 + 1] + nP[f1 + 2] * nP[f2 + 2] < -0.5) dobrasP++
      if (nW[f1] * nW[f2] + nW[f1 + 1] * nW[f2 + 1] + nW[f1 + 2] * nW[f2 + 2] < -0.5) dobrasW++
    }
  }
  let inv = 0, areaW = 0, areaP = 0
  for (let f = 0; f < faces.length; f += 3) {
    if (nW[f] * nP[f] + nW[f + 1] * nP[f + 1] + nW[f + 2] * nP[f + 2] < 0) inv++
  }
  const area = (V) => {
    let s = 0
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3
      const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2]
      const wx = V[c] - V[a], wy = V[c + 1] - V[a + 1], wz = V[c + 2] - V[a + 2]
      s += 0.5 * Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx)
    }
    return s
  }
  areaW = area(whiteMm); areaP = area(pialMm)
  const aP = arestasP.subarray(0, nA), aW = arestasW.subarray(0, nA)
  const r2 = (x) => Math.round(x * 100) / 100
  const q = {
    nVert: nV,
    nFaces: nF,
    euler: nV - nE + nF,
    naoVariedade,
    dobrasPialPct: r2(100 * dobrasP / Math.max(1, nPares)),
    dobrasWhitePct: r2(100 * dobrasW / Math.max(1, nPares)),
    invertidasPct: r2(100 * inv / Math.max(1, nF)),
    arestaMedPial_mm: r2(percentil(aP, 0.5)),
    arestaP99Pial_mm: r2(percentil(aP, 0.99)),
    arestaMedWhite_mm: r2(percentil(aW, 0.5)),
    arestaP99White_mm: r2(percentil(aW, 0.99)),
    areaWhite_cm2: Math.round(areaW / 100),
    areaPial_cm2: Math.round(areaP / 100)
  }
  q.limiteArestaP99_mm = r2(Math.max(limites.arestaP99_mm, limites.arestaP99Rel * q.arestaP99White_mm))
  q.confiavel = q.dobrasPialPct < limites.dobrasPct && q.invertidasPct < limites.invertidasPct &&
    q.arestaP99Pial_mm < q.limiteArestaP99_mm && q.naoVariedade === 0
  return q
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
  const [nx, ny, nz] = dims
  // código FS → índice na tabela
  const codeToCol = new Map()
  TAL_LABELS.forEach((c, i) => codeToCol.set(c, i))
  // índice do nosso espaço de rótulos (≤ 255) → coluna da tabela (−1 = ignora)
  const colOfIdx = new Int16Array(256).fill(-1)
  for (const [idx, nm] of Object.entries(labels)) {
    const c = fsCodeOfName(nm)
    if (c && codeToCol.has(c) && +idx >= 0 && +idx < 256) colOfIdx[+idx] = codeToCol.get(c)
  }
  // histogramas de índice por eixo e por rótulo (em vez de listas de coordenadas:
  // milhões de voxels em arrays JS custavam dezenas de MB); a mediana sai exata
  const nL = TAL_LABELS.length
  const hx = new Int32Array(nL * nx), hy = new Int32Array(nL * ny), hz = new Int32Array(nL * nz)
  const cnt = new Int32Array(nL)
  for (let k = 0, v = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, v++) {
    const col = colOfIdx[seg[v]]
    if (col < 0) continue
    cnt[col]++; hx[col * nx + i]++; hy[col * ny + j]++; hz[col * nz + k]++
  }
  // mediana como np.median: média dos dois centrais quando a contagem é par
  const med = (h, col, n, total) => {
    const r1 = (total - 1) >> 1, r2 = total >> 1
    let acc = 0, v1 = -1
    for (let i = 0; i < n; i++) {
      acc += h[col * n + i]
      if (v1 < 0 && acc > r1) v1 = i
      if (acc > r2) return (v1 + i) / 2
    }
    return v1
  }
  const ref = [] // RAS do sujeito
  const mov = [] // MNI
  for (let col = 0; col < nL; col++) {
    if (cnt[col] <= 50) continue
    const i = med(hx, col, nx, cnt[col]), j = med(hy, col, ny, cnt[col]), k = med(hz, col, nz, cnt[col])
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

// ------------------------------------------------- ordem dos canais do SynthDist
// O mri_synth_surf.py nomeia `W = pred[...,0]` e `P = pred[...,1]`, mas a medição
// nos pesos v10 (synthsurf_v10_230420) mostra o contrário: no córtex — a faixa
// ENTRE as duas superfícies — o canal 0 fica negativo (dentro da pial) e o canal 1
// positivo (fora da white). Só a atribuição W = canal 1 / P = canal 0 reproduz o
// perfil que a fórmula do norm sintético pretende (córtex 39,8 contra o alvo 40; a
// leitura literal dá 63,9). Logo: 0 = lh-pial, 1 = lh-white, 2 = rh-pial, 3 = rh-white.
//
// Em vez de fixar isso às cegas, decide-se pelo próprio exame: dentro de cada par,
// o canal de MAIOR média no córtex daquele hemisfério é a white. Um checkpoint
// futuro com outra ordem não passa despercebido — é relatado.
export function escolheCanaisSdf (sdfs, ctxE, ctxD, ctxTodo = null) {
  const media = (arr, mask) => {
    let s = 0, c = 0
    for (let v = 0; v < arr.length; v++) if (mask[v]) { s += arr[v]; c++ }
    return c ? { m: s / c, n: c } : { m: 0, n: 0 }
  }
  const conta = (mask) => { let c = 0; for (let v = 0; v < mask.length; v++) if (mask[v]) c++; return c }
  const par = (a, b, mask) => {
    const usa = conta(mask) > 500 ? mask : (ctxTodo || mask)
    const ma = media(sdfs[a], usa), mb = media(sdfs[b], usa)
    const inv = ma.m > mb.m
    return { W: sdfs[inv ? a : b], P: sdfs[inv ? b : a], wIdx: inv ? a : b, mediaW: inv ? ma.m : mb.m, mediaP: inv ? mb.m : ma.m, nVox: ma.n }
  }
  const e = par(0, 1, ctxE)
  const d = par(2, 3, ctxD)
  return {
    lhW: e.W, lhP: e.P, rhW: d.W, rhP: d.P,
    ordem: { e: e.wIdx, d: d.wIdx },
    esperado: e.wIdx === 1 && d.wIdx === 3,
    medidas: { e: { W: e.mediaW, P: e.mediaP, vox: e.nVox }, d: { W: d.mediaW, P: d.mediaP, vox: d.nVox } }
  }
}
