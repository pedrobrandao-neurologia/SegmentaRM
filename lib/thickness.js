// thickness.js — espessura cortical VOLUMÉTRICA (euleriana) por parcela DKT, sem malhas.
//
// Método (Jones et al., Hum Brain Mapp 2000; Yezzi & Prince, IEEE TMI 2003; reconstrução
// do LCR sulcal no espírito do PBT/CAT12 — Dahnke et al., NeuroImage 2013):
//   1. por hemisfério, cada voxel da caixa recebe um papel: CÓRTEX (ctx-lh/rh-*, Cerebral-
//      Cortex), INTERNO (substância branca + estruturas profundas coladas a ela: ventrículos
//      laterais, tálamo, caudado, putâmen, pálido, accumbens, DC ventral, corpo caloso),
//      NEUTRO (hipocampo/amígdala — interface que não é pia nem SB: fluxo nulo) ou EXTERNO
//      (todo o resto: LCR, fundo, cerebelo, tronco, OUTRO hemisfério inteiro).
//   2. sulcos fechados: transformada de distância com transformada de feições (voxel
//      INTERNO mais próximo); entre dois voxels corticais vizinhos cujos pontos de SB mais
//      próximos ficam em paredes opostas (|p−q| > 3 mm e > 1,4 × a profundidade média —
//      o eixo medial, onde as frentes vindas de dois giros se encontram) a FACE comum
//      vira borda externa (pia reconstruída), posta no ponto equidistante das duas
//      paredes. Sem isso as linhas de corrente sobem pelo sulco colado e a espessura
//      ali dobra (ver a validação).
//   3. Laplace ∇²u = 0 no córtex: u = 0 na borda com o INTERNO, u = 1 na borda com o
//      EXTERNO e nas faces de sulco reconstruído, ∂u/∂n = 0 junto ao NEUTRO. As bordas
//      de Dirichlet ficam ENTRE centros (Shortley–Weller, fração θ da aresta), não nos
//      centros dos voxels vizinhos: um córtex de n voxels mede n·h, e não (n+1)·h.
//      Gauss–Seidel com sobrerrelaxação (SOR), partindo da razão de distâncias.
//   4. T = ∇u/|∇u|; L0 (∇L0·T = 1, L0 = 0 na borda interna) e L1 (−∇L1·T = 1, L1 = 0 na
//      borda externa/sulcal) por diferenças contra o vento (Yezzi–Prince), varridas na
//      ordem de u (crescente para L0, decrescente para L1) até convergir.
//      Espessura em cada ponto = L0 + L1 (comprimento da linha de corrente que passa ali).
//   5. Amostragem na SUPERFÍCIE MÉDIA u = 0,5: cada cruzamento de u = 0,5 numa aresta da
//      grade entra com peso h_b·h_c·|T_a| (arestas do eixo a cortadas por unidade de área
//      = |n_a|/(h_b·h_c)), logo a soma dos pesos é a área da isosuperfície e a média é
//      por ÁREA (como a média por vértice do FreeSurfer), não por volume (a média por
//      voxel pesa mais o córtex espesso: E[t²]/E[t]). A média por voxel vai junto.
//   Correção de fração de voxel (padrão): θ em cada aresta córtex→SB/LCR sai do cruzamento
//   de zero da distância assinada média num disco TANGENTE à borda (estimador de 2ª ordem
//   que desfaz a escada de superfícies oblíquas sem erodir lâminas finas de SB nem
//   deslocar a borda pela curvatura); sem ela θ = 0,5 (face do voxel). Superamostragem
//   a 0,5 mm com rótulos duros foi testada e PIORA o viés (passa a medir a escada).
// Teto de 5 mm como o FreeSurfer (mris_place_surface … 5); valores acima são truncados.
// Índice de voxel v = i + j·nx + k·nx·ny (x mais rápido), como no resto do app.

export const OUT = 0
export const INN = 1
export const NEU = 2
export const CTX = 3

// códigos de vizinho (lista de adjacência dos voxels corticais; ≥ 0 = índice cortical)
const C_INN = -1
const C_OUT = -2
const C_NEU = -3
const C_CUT = -4

const BIG = 1e20

/** tamanho do voxel [sx, sy, sz] (mm) a partir da affine 4×4 achatada por linhas */
export function spacingOfAffine (A) {
  return [0, 1, 2].map(c => Math.hypot(A[c], A[4 + c], A[8 + c]) || 1)
}

/**
 * Papel de cada rótulo pelo NOME (convenção FreeSurfer).
 * @param {Object<string,string>} labels mapa índice → nome
 * @returns {{ role: Uint8Array, hemi: Uint8Array, parc: (string|null)[], name: string[] }}
 *   role: OUT/INN/NEU/CTX · hemi: 0 = bilateral/sem lado, 1 = esquerdo, 2 = direito
 *   parc: nome da parcela DKT (só córtex parcelado)
 */
export function classifyLabels (labels) {
  const role = new Uint8Array(256)
  const hemi = new Uint8Array(256)
  const parc = new Array(256).fill(null)
  const name = new Array(256).fill('')
  for (const [k, nm] of Object.entries(labels || {})) {
    const i = +k
    if (!(i >= 0 && i < 256)) continue
    const s = String(nm)
    name[i] = s
    let h = 0
    if (/^(Left-|ctx-lh-|lh-)/i.test(s)) h = 1
    else if (/^(Right-|ctx-rh-|rh-)/i.test(s)) h = 2
    let r = OUT
    const m = /^ctx-(lh|rh)-(.+)$/i.exec(s)
    if (m) {
      r = CTX
      parc[i] = /^(unknown|corpuscallosum|medialwall)$/i.test(m[2]) ? null : m[2]
    } else if (/Cerebral-Cortex/i.test(s)) r = CTX
    else if (/Cerebellum|Brain-Stem|CSF|3rd-Ventricle|4th-Ventricle|5th-Ventricle/i.test(s)) r = OUT
    else if (/Cerebral-White-Matter|WM-hypointensities|White-Matter-Hypointensities|^CC_/i.test(s)) r = INN
    else if (/Lateral-Ventricle|Inf-Lat-Vent|Inferior-Lateral-Ventricle|choroid-plexus|Thalamus|Caudate|Putamen|Pallidum|Accumbens|VentralDC|vessel/i.test(s)) r = INN
    else if (/Hippocampus|Amygdala/i.test(s)) r = NEU
    role[i] = r
    hemi[i] = h
  }
  return { role, hemi, parc, name }
}

// ------------------------------------------------------------------ EDT (Felzenszwalb)
// Passo 1D exato com pesos w = h² (mm²) e, opcionalmente, propagação da feição
// (índice global da semente mais próxima).
function dt1d (f, fi, n, w, d, di, v, z) {
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
    const dq = q - v[k]
    d[q] = w * dq * dq + f[v[k]]
    if (di) di[q] = fi[v[k]]
  }
}

/**
 * Distância euclidiana ao quadrado (mm²) até a semente mais próxima, com transformada
 * de feições opcional.
 * @param {Uint8Array} seeds 1 = semente
 * @param {number[]} dims
 * @param {number[]} spacing [sx,sy,sz] mm
 * @param {boolean} withFeat devolver também o índice da semente mais próxima (−1 se nenhuma)
 * @returns {{ d2: Float32Array, feat: Int32Array|null }}
 */
export function edt3d (seeds, dims, spacing = [1, 1, 1], withFeat = false) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const d2 = new Float32Array(n)
  const feat = withFeat ? new Int32Array(n) : null
  for (let i = 0; i < n; i++) {
    d2[i] = seeds[i] ? 0 : BIG
    if (feat) feat[i] = seeds[i] ? i : -1
  }
  const m = Math.max(nx, ny, nz)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const fi = withFeat ? new Int32Array(m) : null
  const di = withFeat ? new Int32Array(m) : null
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  const pass = (len, stride, w, base) => {
    for (let q = 0, p = base; q < len; q++, p += stride) { f[q] = d2[p]; if (fi) fi[q] = feat[p] }
    dt1d(f, fi, len, w, d, di, v, z)
    for (let q = 0, p = base; q < len; q++, p += stride) { d2[p] = d[q]; if (di) feat[p] = di[q] }
  }
  const [wx, wy, wz] = spacing.map(s => s * s)
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) pass(nx, 1, wx, j * nx + k * nx * ny)
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) pass(ny, nx, wy, i + k * nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pass(nz, nx * ny, wz, i + j * nx)
  if (feat) for (let i = 0; i < n; i++) if (d2[i] >= BIG * 0.5) feat[i] = -1
  return { d2, feat }
}

// ------------------------------------------------------------------ estatística
function wstats (t, w, n) {
  if (!n) return { media: NaN, mediana: NaN, dp: NaN, peso: 0 }
  let sw = 0, s1 = 0
  for (let i = 0; i < n; i++) { sw += w[i]; s1 += w[i] * t[i] }
  const mu = s1 / sw
  let s2 = 0
  for (let i = 0; i < n; i++) { const d = t[i] - mu; s2 += w[i] * d * d }
  // mediana ponderada
  const ord = new Uint32Array(n)
  for (let i = 0; i < n; i++) ord[i] = i
  ord.sort((a, b) => t[a] - t[b])
  let acc = 0, med = t[ord[n - 1]]
  for (let q = 0; q < n; q++) {
    acc += w[ord[q]]
    if (acc >= 0.5 * sw) { med = t[ord[q]]; break }
  }
  return { media: mu, mediana: med, dp: Math.sqrt(s2 / sw), peso: sw }
}

function round (x, d = 3) {
  if (!Number.isFinite(x)) return null
  const p = 10 ** d
  return Math.round(x * p) / p
}

// ------------------------------------------------------------------ solver por hemisfério
/** suavização gaussiana separável no lugar (σ em mm; eixo com σ < 0,2 voxel é pulado) */
function gaussSmooth (vol, dims, h, sigma) {
  const [nx, ny, nz] = dims
  const m = Math.max(nx, ny, nz)
  const line = new Float32Array(m)
  const lines = [
    [nx, 1, (cb) => { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) cb(j * nx + k * nx * ny) }],
    [ny, nx, (cb) => { for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) cb(i + k * nx * ny) }],
    [nz, nx * ny, (cb) => { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) cb(i + j * nx) }]
  ]
  for (let a = 0; a < 3; a++) {
    const s = sigma / h[a]
    if (s < 0.2) continue
    const r = Math.max(1, Math.ceil(2.5 * s))
    const ker = new Float32Array(2 * r + 1)
    let sum = 0
    for (let q = -r; q <= r; q++) { ker[q + r] = Math.exp(-0.5 * q * q / (s * s)); sum += ker[q + r] }
    for (let q = 0; q <= 2 * r; q++) ker[q] /= sum
    const [len, st, each] = lines[a]
    each((base) => {
      for (let q = 0, p = base; q < len; q++, p += st) line[q] = vol[p]
      for (let q = 0, p = base; q < len; q++, p += st) {
        let acc = 0
        for (let d = -r; d <= r; d++) {
          let qq = q + d
          if (qq < 0) qq = 0; else if (qq >= len) qq = len - 1
          acc += ker[d + r] * line[qq]
        }
        vol[p] = acc
      }
    })
  }
}

/** distância assinada (mm) à face da máscara: negativa dentro, positiva fora */
function signedFromD2 (mask, dOut2, dims, h) {
  const n = mask.length
  const inv = new Uint8Array(n)
  for (let i = 0; i < n; i++) inv[i] = mask[i] ? 0 : 1
  const { d2: dIn2 } = edt3d(inv, dims, h, false)
  const hh = 0.5 * Math.min(h[0], h[1], h[2])
  const s = dIn2 // reaproveita o buffer
  for (let i = 0; i < n; i++) s[i] = mask[i] ? -(Math.sqrt(dIn2[i]) - hh) : (Math.sqrt(dOut2[i]) - hh)
  return s
}

/**
 * Espessura euleriana num recorte (caixa) de um hemisfério.
 * @param {Uint8Array} cls papel de cada voxel (OUT/INN/NEU/CTX) — caixa bx·by·bz
 * @param {number[]} bd dimensões da caixa
 * @param {number[]} h espaçamento (mm)
 * @param {object} o { sulcos, fracaoVoxel, cutMin, cutK, capMax, omega, tolU, maxIterU, tolL, maxIterL, onIter }
 * @returns {{ cvox: Int32Array, tVox: Float32Array, uVox: Float32Array, samples, qc, cutBits }}
 *   cvox: índices (na caixa) dos voxels corticais; tVox: espessura por voxel (NaN =
 *   inválido); samples: { lab (índice cortical), t, w, n } na superfície média u = 0,5
 */
export function solveBox (cls, bd, h, o = {}) {
  const sulcos = o.sulcos !== false
  const cutMin = o.cutMin ?? 3.0
  const cutK = o.cutK ?? 1.4
  const fracao = o.fracaoVoxel !== false // correção de fração de voxel (falso = bordas nas faces)
  const TH_MIN = 0.05
  const tolU = o.tolU ?? 1e-6
  const maxIterU = o.maxIterU ?? 600
  const tolL = o.tolL ?? 1e-3
  const maxIterL = o.maxIterL ?? 100
  const onIter = o.onIter || (() => {})
  const [bx, by, bz] = bd
  const nb = bx * by * bz
  const sxy = bx * by
  const stride = [1, bx, sxy]

  // voxels corticais
  const cidx = new Int32Array(nb).fill(-1)
  let N = 0
  for (let i = 0; i < nb; i++) if (cls[i] === CTX) N++
  const cvox = new Int32Array(N)
  for (let i = 0, c = 0; i < nb; i++) if (cls[i] === CTX) { cidx[i] = c; cvox[c++] = i }
  const qc = { voxels: N, faces_sulco: 0, voxels_sulco: 0, iter_u: 0, delta_u: 0, iter_L: [0, 0], invalidos: 0, truncados: 0 }
  if (!N) return { cvox, tVox: new Float32Array(0), uVox: new Float32Array(0), samples: { lab: new Int32Array(0), t: new Float32Array(0), w: new Float32Array(0), n: 0 }, qc, cutBits: new Uint8Array(0) }

  // transformadas de distância: ao INTERNO (com feições) e ao EXTERNO
  const mIn = new Uint8Array(nb)
  const mOut = new Uint8Array(nb)
  for (let i = 0; i < nb; i++) { mIn[i] = cls[i] === INN ? 1 : 0; mOut[i] = cls[i] === OUT ? 1 : 0 }
  const { d2: dIn2, feat } = edt3d(mIn, bd, h, true)
  const { d2: dOut2 } = edt3d(mOut, bd, h, false)
  // estimativa inicial de u: razão de distâncias
  const u = new Float32Array(N)
  for (let c = 0; c < N; c++) {
    const v = cvox[c]
    const a = Math.sqrt(dIn2[v]), b = Math.sqrt(dOut2[v])
    u[c] = (a + b) > 0 ? a / (a + b) : 0.5
  }
  // correção de fração de voxel: a posição da borda na aresta v→w sai do cruzamento de
  // zero da distância assinada à borda estimada num disco TANGENTE (⟂ à normal, raio
  // 1,2 mm): desfaz a escada de superfícies oblíquas sem erodir lâminas finas de SB (uma
  // suavização isotrópica "come" giros com SB de 1–2 voxels: +0,4 mm numa placa de 1
  // voxel). A normal vem da distância assinada suavizada (σ = 1 mm).
  const sIn = signedFromD2(mIn, dIn2, bd, h)
  const sOut = signedFromD2(mOut, dOut2, bd, h)
  let gIn = null, gOut = null
  if (fracao) {
    gIn = Float32Array.from(sIn); gaussSmooth(gIn, bd, h, 1.0)
    gOut = Float32Array.from(sOut); gaussSmooth(gOut, bd, h, 1.0)
  }
  const trilin = (S, x, y, z) => {
    if (x < 0) x = 0; else if (x > bx - 1.001) x = bx - 1.001
    if (y < 0) y = 0; else if (y > by - 1.001) y = by - 1.001
    if (z < 0) z = 0; else if (z > bz - 1.001) z = bz - 1.001
    const i = x | 0, j = y | 0, k = z | 0
    const fx = x - i, fy = y - j, fz = z - k
    const b0 = i + j * bx + k * sxy
    const c00 = S[b0] * (1 - fx) + S[b0 + 1] * fx
    const c10 = S[b0 + bx] * (1 - fx) + S[b0 + bx + 1] * fx
    const c01 = S[b0 + sxy] * (1 - fx) + S[b0 + sxy + 1] * fx
    const c11 = S[b0 + sxy + bx] * (1 - fx) + S[b0 + sxy + bx + 1] * fx
    return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz
  }
  // disco tangencial: centro + anéis de 0,6 e 1,2 mm com pesos de um estimador de 2ª
  // ordem (Σw = 1 e Σw·r² = 0): a média desfaz a escada, e a restrição de momento anula a
  // flecha da curvatura (sem ela, giros finos e fundos de sulco deslocam a borda ~0,1 mm)
  const W1 = 0.06
  const W2 = -W1 * 8 * 0.36 / (12 * 1.44)
  const PTS = [[0, 0, 1 - 8 * W1 - 12 * W2]] // [r·cos, r·sin, peso]
  for (const [r, m, wt] of [[0.6, 8, W1], [1.2, 12, W2]]) {
    for (let q = 0; q < m; q++) PTS.push([r * Math.cos(2 * Math.PI * q / m), r * Math.sin(2 * Math.PI * q / m), wt])
  }
  const tangAvg = (S, G, v, a, dir) => {
    // ponto médio da aresta e normal (gradiente de G por diferenças centrais)
    const x0 = v % bx, y0 = ((v / bx) | 0) % by, z0 = (v / sxy) | 0
    const mx = x0 + (a === 0 ? (dir ? 0.5 : -0.5) : 0)
    const my = y0 + (a === 1 ? (dir ? 0.5 : -0.5) : 0)
    const mz = z0 + (a === 2 ? (dir ? 0.5 : -0.5) : 0)
    let nx = (trilin(G, mx + 0.5, my, mz) - trilin(G, mx - 0.5, my, mz)) / h[0]
    let ny = (trilin(G, mx, my + 0.5, mz) - trilin(G, mx, my - 0.5, mz)) / h[1]
    let nz = (trilin(G, mx, my, mz + 0.5) - trilin(G, mx, my, mz - 0.5)) / h[2]
    const nn = Math.hypot(nx, ny, nz)
    if (!(nn > 1e-6)) return null
    nx /= nn; ny /= nn; nz /= nn
    // base tangente (mm)
    let ax = 1, ay = 0, az = 0
    if (Math.abs(nx) > 0.8) { ax = 0; ay = 1 }
    let t1x = ay * nz - az * ny, t1y = az * nx - ax * nz, t1z = ax * ny - ay * nx
    const l1 = Math.hypot(t1x, t1y, t1z); t1x /= l1; t1y /= l1; t1z /= l1
    const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x
    const w = v + (dir ? stride[a] : -stride[a])
    const wx = w % bx, wy = ((w / bx) | 0) % by, wz = (w / sxy) | 0
    let sv = 0, sw = 0
    for (let q = 0; q < PTS.length; q++) {
      const [pc, ps, wt] = PTS[q]
      const ox = (pc * t1x + ps * t2x) / h[0]
      const oy = (pc * t1y + ps * t2y) / h[1]
      const oz = (pc * t1z + ps * t2z) / h[2]
      sv += wt * trilin(S, x0 + ox, y0 + oy, z0 + oz)
      sw += wt * trilin(S, wx + ox, wy + oy, wz + oz)
    }
    return [sv, sw]
  }

  // adjacência (códigos) e posição fracionária θ da borda em cada um dos 6 lados
  const nbr = new Int32Array(6 * N)
  const th = new Float32Array(6 * N)
  const cutBits = new Uint8Array(N) // bit 2a = lado −a, bit 2a+1 = lado +a
  const vc = [0, 0, 0]
  for (let c = 0; c < N; c++) {
    const v = cvox[c]
    vc[0] = v % bx; vc[1] = ((v / bx) | 0) % by; vc[2] = (v / sxy) | 0
    for (let a = 0; a < 3; a++) {
      for (let dir = 0; dir < 2; dir++) {
        const s = 6 * c + 2 * a + dir
        const na = vc[a] + (dir ? 1 : -1)
        if (na < 0 || na >= bd[a]) { nbr[s] = C_OUT; th[s] = 0.5; continue }
        const w = v + (dir ? stride[a] : -stride[a])
        const k = cls[w]
        if (k === CTX) { nbr[s] = cidx[w]; th[s] = 1 } else if (k === NEU) { nbr[s] = C_NEU; th[s] = 1 } else {
          let t = 0.5
          if (fracao) {
            const r = k === INN ? tangAvg(sIn, gIn, v, a, dir) : tangAvg(sOut, gOut, v, a, dir)
            if (r) {
              const [sv, sw] = r
              t = sv <= 0 ? TH_MIN : (sw >= 0 ? 1 : sv / (sv - sw))
              if (t < TH_MIN) t = TH_MIN; else if (t > 1) t = 1
            }
          }
          nbr[s] = k === INN ? C_INN : C_OUT
          th[s] = t
        }
      }
    }
  }

  // QC: posição média da borda (θ = 0,5 → face do voxel)
  {
    let si = 0, ni = 0, so = 0, no = 0
    for (let s = 0; s < 6 * N; s++) {
      if (nbr[s] === C_INN) { si += th[s]; ni++ } else if (nbr[s] === C_OUT) { so += th[s]; no++ }
    }
    qc.theta_interna = ni ? si / ni : NaN
    qc.theta_externa = no ? so / no : NaN
  }

  // sulcos fechados: faces do eixo medial (pontos de SB mais próximos em paredes opostas)
  if (sulcos) {
    for (let c = 0; c < N; c++) {
      const v = cvox[c]
      const p = feat[v]
      if (p < 0) continue
      const px = p % bx, py = ((p / bx) | 0) % by, pz = (p / sxy) | 0
      const vx = v % bx, vy = ((v / bx) | 0) % by, vz = (v / sxy) | 0
      const Dv = Math.sqrt(dIn2[v])
      const pv = [(vx - px) * h[0], (vy - py) * h[1], (vz - pz) * h[2]] // p → v
      for (let a = 0; a < 3; a++) {
        const cw = nbr[6 * c + 2 * a + 1]
        if (cw < 0) continue
        const w = cvox[cw]
        const q = feat[w]
        if (q < 0 || q === p) continue
        const qx = q % bx, qy = ((q / bx) | 0) % by, qz = (q / sxy) | 0
        const dist = Math.hypot((px - qx) * h[0], (py - qy) * h[1], (pz - qz) * h[2])
        const Dw = Math.sqrt(dIn2[w])
        if (!(dist > cutMin && dist > cutK * 0.5 * (Dv + Dw))) continue
        // posição da face de equidistância entre v e w (em fração de h[a], a partir de v)
        const wx = w % bx, wy = ((w / bx) | 0) % by, wz = (w / sxy) | 0
        const qw = [(wx - qx) * h[0], (wy - qy) * h[1], (wz - qz) * h[2]] // q → w
        let gv = Dv > 0 ? pv[a] / Dv : 1 // d|x−p|/dx_a em v
        let gw = Dw > 0 ? -qw[a] / Dw : 1 // −d|x−q|/dx_a em w
        if (gv < 0.2) gv = 0.2
        if (gw < 0.2) gw = 0.2
        let tv = (Dw - Dv + h[a] * gw) / ((gv + gw) * h[a])
        if (tv < TH_MIN) tv = TH_MIN; else if (tv > 1 - TH_MIN) tv = 1 - TH_MIN
        nbr[6 * c + 2 * a + 1] = C_CUT; th[6 * c + 2 * a + 1] = tv
        nbr[6 * cw + 2 * a] = C_CUT; th[6 * cw + 2 * a] = 1 - tv
        cutBits[c] |= 1 << (2 * a + 1)
        cutBits[cw] |= 1 << (2 * a)
        qc.faces_sulco++
      }
    }
    for (let c = 0; c < N; c++) if (cutBits[c]) { qc.voxels_sulco++; if (u[c] < 0.75) u[c] = 0.75 }
  }

  // Laplace — SOR com Shortley–Weller (Dirichlet a θ·h do centro; Neumann por espelho)
  const ih = h.map(x => 1 / (x * x))
  const omega = o.omega ?? 1.8
  let it = 0, dmax = Infinity
  for (; it < maxIterU && dmax > tolU; it++) {
    dmax = 0
    for (let i = 0; i < N; i++) {
      let num = 0, den = 0
      const b = 6 * i
      for (let a = 0; a < 3; a++) {
        const m = nbr[b + 2 * a], p = nbr[b + 2 * a + 1]
        const tm = th[b + 2 * a], tp = th[b + 2 * a + 1]
        const s2 = 2 * ih[a] / (tm + tp)
        if (m !== C_NEU) {
          const cm = s2 / tm
          num += cm * (m >= 0 ? u[m] : (m === C_INN ? 0 : 1)); den += cm
        }
        if (p !== C_NEU) {
          const cp = s2 / tp
          num += cp * (p >= 0 ? u[p] : (p === C_INN ? 0 : 1)); den += cp
        }
      }
      if (den > 0) {
        const du = omega * (num / den - u[i])
        u[i] += du
        const ad = du < 0 ? -du : du
        if (ad > dmax) dmax = ad
      }
    }
    if ((it & 15) === 15) onIter('u', it, dmax)
  }
  qc.iter_u = it; qc.delta_u = dmax

  // campo tangente T = ∇u/|∇u|
  const T = new Float32Array(3 * N)
  for (let i = 0; i < N; i++) {
    let gx = 0, gy = 0, gz = 0
    for (let a = 0; a < 3; a++) {
      const m = nbr[6 * i + 2 * a], p = nbr[6 * i + 2 * a + 1]
      const tm = th[6 * i + 2 * a] * h[a], tp = th[6 * i + 2 * a + 1] * h[a]
      const vm = m >= 0 ? u[m] : m === C_NEU ? u[i] : m === C_INN ? 0 : 1
      const vp = p >= 0 ? u[p] : p === C_NEU ? u[i] : p === C_INN ? 0 : 1
      const gg = (vp - vm) / (tm + tp)
      if (a === 0) gx = gg; else if (a === 1) gy = gg; else gz = gg
    }
    const nrm = Math.hypot(gx, gy, gz)
    if (nrm > 1e-9) { T[3 * i] = gx / nrm; T[3 * i + 1] = gy / nrm; T[3 * i + 2] = gz / nrm }
  }

  // ordem por u (bucket sort)
  const NB = 4096
  const cnt = new Int32Array(NB + 1)
  const bk = (x) => { const b = (x * NB) | 0; return b < 0 ? 0 : b >= NB ? NB - 1 : b }
  for (let i = 0; i < N; i++) cnt[bk(u[i]) + 1]++
  for (let b = 0; b < NB; b++) cnt[b + 1] += cnt[b]
  const order = new Int32Array(N)
  for (let i = 0; i < N; i++) order[cnt[bk(u[i])]++] = i

  // L0 (desde a borda interna) e L1 (desde a externa/sulcal), contra o vento
  const solveL = (L, sgn, isSrc) => {
    L.fill(NaN)
    let k = 0, dm = Infinity
    for (; k < maxIterL && dm > tolL; k++) {
      dm = 0
      const fwd = ((k & 1) === 0) === (sgn > 0)
      for (let q = 0; q < N; q++) {
        const i = order[fwd ? q : N - 1 - q]
        let num = 1, den = 0
        for (let a = 0; a < 3; a++) {
          const Ta = sgn * T[3 * i + a]
          if (Ta === 0) continue
          const s = 6 * i + 2 * a + (Ta > 0 ? 0 : 1) // lado a montante
          const code = nbr[s]
          const at = Ta > 0 ? Ta : -Ta
          if (code >= 0) {
            const Ln = L[code]
            if (Ln !== Ln) continue
            const w = at / h[a]
            num += w * Ln; den += w
          } else if (isSrc(code)) den += at / (th[s] * h[a])
        }
        if (den > 0) {
          const nv = num / den
          const old = L[i]
          const d = old === old ? Math.abs(nv - old) : Infinity
          if (d > dm) dm = d
          L[i] = nv
        }
      }
      onIter(sgn > 0 ? 'L0' : 'L1', k, dm)
    }
    return k
  }
  const L0 = new Float32Array(N)
  const L1 = new Float32Array(N)
  qc.iter_L[0] = solveL(L0, 1, (c) => c === C_INN)
  qc.iter_L[1] = solveL(L1, -1, (c) => c === C_OUT || c === C_CUT)

  const capMax = o.capMax ?? 5
  const t = L0 // reaproveita
  for (let i = 0; i < N; i++) {
    let x = L0[i] + L1[i]
    if (!(x > 0) || !(T[3 * i] || T[3 * i + 1] || T[3 * i + 2])) { x = NaN; qc.invalidos++ } else if (x > capMax) { x = capMax; qc.truncados++ }
    t[i] = x
  }

  // amostras na superfície média u = 0,5: cada aresta (ou meia-aresta até a borda)
  // cruzada entra com o peso h_b·h_c·|T_a| — arestas do eixo a cortadas por unidade de
  // área = |n_a|/(h_b·h_c), logo a soma dos pesos é a área da isosuperfície
  let cap = Math.max(1024, 2 * N)
  let sLab = new Int32Array(cap), sT = new Float32Array(cap), sW = new Float32Array(cap), ns = 0
  const push = (c, tt, w) => {
    if (ns === cap) {
      cap *= 2
      const a = new Int32Array(cap); a.set(sLab); sLab = a
      const b = new Float32Array(cap); b.set(sT); sT = b
      const d = new Float32Array(cap); d.set(sW); sW = d
    }
    sLab[ns] = c; sT[ns] = tt; sW[ns] = w; ns++
  }
  const areaEl = [h[1] * h[2], h[0] * h[2], h[0] * h[1]]
  for (let i = 0; i < N; i++) {
    const ti = t[i]
    if (ti !== ti) continue
    const ui = u[i]
    for (let a = 0; a < 3; a++) {
      const Ta = Math.abs(T[3 * i + a])
      for (let dir = 0; dir < 2; dir++) {
        const code = nbr[6 * i + 2 * a + dir]
        if (code >= 0) {
          if (!dir) continue // aresta cortical contada uma vez (lado +)
          const uj = u[code], tj = t[code]
          if ((ui < 0.5) === (uj < 0.5) || tj !== tj) continue
          const fr = (0.5 - ui) / (uj - ui)
          push(fr < 0.5 ? i : code, ti + fr * (tj - ti), areaEl[a] * 0.5 * (Ta + Math.abs(T[3 * code + a])))
        } else if (code === C_INN) {
          if (ui >= 0.5) push(i, ti, areaEl[a] * Ta)
        } else if (code === C_OUT || code === C_CUT) {
          if (ui < 0.5) push(i, ti, areaEl[a] * Ta)
        }
      }
    }
  }
  return { cvox, tVox: t, uVox: u, samples: { lab: sLab, t: sT, w: sW, n: ns }, qc, cutBits }
}

// ------------------------------------------------------------------ caixa / partição
function bboxWhere (n, dims, pred, margin, lim = null) {
  const [nx, ny] = dims
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1, z0 = Infinity, z1 = -1
  for (let v = 0; v < n; v++) {
    if (!pred(v)) continue
    const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / (nx * ny)) | 0
    if (i < x0) x0 = i; if (i > x1) x1 = i
    if (j < y0) y0 = j; if (j > y1) y1 = j
    if (k < z0) z0 = k; if (k > z1) z1 = k
  }
  if (x1 < 0) return null
  const hi = lim || dims
  const lo = [x0, y0, z0].map(a => Math.max(0, a - margin))
  const up = [x1, y1, z1].map((a, w) => Math.min(hi[w] - 1, a + margin))
  return { o: lo, d: [up[0] - lo[0] + 1, up[1] - lo[1] + 1, up[2] - lo[2] + 1] }
}

/**
 * Espessura cortical por parcela a partir da segmentação.
 * @param {Uint8Array} seg rótulos na grade (x mais rápido)
 * @param {number[]} dims
 * @param {ArrayLike<number>} affine 4×4 achatada (16)
 * @param {Object<string,string>} labels índice → nome FreeSurfer
 * @param {object} opts { mapa (bool), compararSemSulcos (bool), fracaoVoxel (bool, padrão true),
 *                        sulcos (bool, padrão true), capMax, cutMin, cutK, onProgress(frac, txt) }
 */
export function corticalThickness (seg, dims, affine, labels, opts = {}) {
  const t0 = Date.now()
  const post = opts.onProgress || (() => {})
  const sulcos = opts.sulcos !== false
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  if (!seg || seg.length !== n) throw new Error(`segmentação com ${seg ? seg.length : 0} voxels ≠ ${nx}×${ny}×${nz}`)
  const A = affine && affine.length >= 12 ? affine : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const h = spacingOfAffine(A)
  const L = classifyLabels(labels)
  const hasCtx = { 1: false, 2: false }
  let hasBilat = false
  const present = new Uint8Array(256)
  for (let v = 0; v < n; v++) present[seg[v]] = 1
  for (let k = 0; k < 256; k++) {
    if (!present[k] || L.role[k] === OUT) continue
    if (L.role[k] === CTX && L.hemi[k]) hasCtx[L.hemi[k]] = true
    if (!L.hemi[k]) hasBilat = true
    if (L.role[k] === CTX && !L.hemi[k]) hasCtx[1] = hasCtx[2] = true
  }
  if (!hasCtx[1] && !hasCtx[2]) throw new Error('nenhum rótulo de córtex (ctx-lh-*/ctx-rh-*/Cerebral-Cortex) na segmentação')

  // caixa do cérebro (rótulos com papel) e partição E/D para rótulos sem lado
  post(0.01, 'Espessura: caixa do cérebro e papéis dos rótulos…')
  const brain = bboxWhere(n, dims, (v) => L.role[seg[v]] !== OUT, 3)
  const [ox, oy, oz] = brain.o
  const [bx, by, bz] = brain.d
  const nbB = bx * by * bz
  const segB = new Uint8Array(nbB)
  for (let k = 0; k < bz; k++) for (let j = 0; j < by; j++) {
    const src = ox + (oy + j) * nx + (oz + k) * nx * ny
    segB.set(seg.subarray(src, src + bx), (j + k * by) * bx)
  }
  let side = null
  if (hasBilat) {
    post(0.03, 'Espessura: partição hemisférica dos rótulos sem lado…')
    const sL = new Uint8Array(nbB), sR = new Uint8Array(nbB)
    let nL = 0, nR = 0
    for (let i = 0; i < nbB; i++) {
      const k = segB[i]
      if (L.role[k] === OUT) continue
      if (L.hemi[k] === 1) { sL[i] = 1; nL++ } else if (L.hemi[k] === 2) { sR[i] = 1; nR++ }
    }
    side = new Uint8Array(nbB)
    if (nL && nR) {
      const dl = edt3d(sL, brain.d, h).d2
      const dr = edt3d(sR, brain.d, h).d2
      for (let i = 0; i < nbB; i++) side[i] = dl[i] <= dr[i] ? 1 : 2
    } else {
      // sem rótulos lateralizados: divide pela coordenada x de mundo (x < 0 = esquerdo em RAS)
      for (let i = 0; i < nbB; i++) {
        const x = ox + i % bx, y = oy + ((i / bx) | 0) % by, z = oz + ((i / (bx * by)) | 0)
        const wx = A[0] * x + A[1] * y + A[2] * z + A[3]
        side[i] = wx < 0 ? 1 : 2
      }
    }
  }
  const roleAt = (i, hs) => {
    const k = segB[i]
    const r = L.role[k]
    if (r === OUT) return OUT
    const hk = L.hemi[k]
    if (hk) return hk === hs ? r : OUT
    return side && side[i] === hs ? r : OUT
  }

  const hemisferios = {}
  const regioes = []
  const qcH = {}
  const mapa = opts.mapa ? new Float32Array(n) : null
  const regAcc = new Map() // (hemisfério·256 + rótulo) → { tt, ww, k, vox, sv, nv }
  const HS = [[1, 'lh', 'esquerdo'], [2, 'rh', 'direito']]
  const semSulcos = {}
  for (let hi = 0; hi < 2; hi++) {
    const [hs, key, nome] = HS[hi]
    const base = hi * 0.5
    if (!hasCtx[hs]) { hemisferios[key] = null; continue }
    const box = bboxWhere(nbB, brain.d, (i) => roleAt(i, hs) !== OUT, 2, brain.d)
    if (!box) { hemisferios[key] = null; continue }
    const [hx0, hy0, hz0] = box.o
    const [cx, cy, cz] = box.d
    const nbH = cx * cy * cz
    const cls = new Uint8Array(nbH)
    const lab = new Uint8Array(nbH)
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const b = (hx0 + i) + (hy0 + j) * bx + (hz0 + k) * bx * by
      const q = i + j * cx + k * cx * cy
      cls[q] = roleAt(b, hs)
      lab[q] = segB[b]
    }
    const span = opts.compararSemSulcos ? 0.3 : 0.48
    post(base + 0.02, `Espessura (hemisfério ${nome}): distâncias e sulcos fechados…`)
    const onIter = (tag, it, d) => {
      if (tag === 'u') {
        const fr = Math.min(1, it / 200)
        post(base + 0.02 + span * (0.2 + 0.5 * fr), `Espessura (hemisfério ${nome}): Laplace, iteração ${it + 1}, Δu ${d.toExponential(1)}`)
      } else if (it === 0) post(base + 0.02 + span * (tag === 'L0' ? 0.8 : 0.9), `Espessura (hemisfério ${nome}): comprimentos ${tag} contra o vento…`)
    }
    const res = solveBox(cls, box.d, h, { sulcos, capMax: opts.capMax, cutMin: opts.cutMin, cutK: opts.cutK, fracaoVoxel: opts.fracaoVoxel, maxIterU: opts.maxIterU, onIter })
    const { cvox, tVox, samples, qc } = res
    // acumula por rótulo (amostras da superfície média + voxels)
    const nc = cvox.length
    // chave por hemisfério: um rótulo sem lado (ex.: Cerebral-Cortex) aparece nos dois
    const labOfC = new Uint16Array(nc)
    for (let c = 0; c < nc; c++) labOfC[c] = hs * 256 + lab[cvox[c]]
    const counts = new Map()
    for (let s = 0; s < samples.n; s++) { const lb = labOfC[samples.lab[s]]; counts.set(lb, (counts.get(lb) || 0) + 1) }
    for (const [lb, m] of counts) regAcc.set(lb, { tt: new Float32Array(m), ww: new Float32Array(m), k: 0, vox: 0, sv: 0, nv: 0 })
    for (let s = 0; s < samples.n; s++) {
      const R = regAcc.get(labOfC[samples.lab[s]])
      R.tt[R.k] = samples.t[s]; R.ww[R.k] = samples.w[s]; R.k++
    }
    let hv = 0, hs1 = 0, hnv = 0
    for (let c = 0; c < nc; c++) {
      const lb = labOfC[c]
      let R = regAcc.get(lb)
      if (!R) { R = { tt: new Float32Array(0), ww: new Float32Array(0), k: 0, vox: 0, sv: 0, nv: 0 }; regAcc.set(lb, R) }
      R.vox++
      hv++
      const tv = tVox[c]
      if (tv === tv) { R.sv += tv; R.nv++; hs1 += tv; hnv++ }
      if (mapa) {
        const b = cvox[c]
        const i = b % cx, j = ((b / cx) | 0) % cy, k = (b / (cx * cy)) | 0
        mapa[(ox + hx0 + i) + (oy + hy0 + j) * nx + (oz + hz0 + k) * nx * ny] = tv === tv ? tv : 0
      }
    }
    const st = wstats(samples.t, samples.w, samples.n)
    hemisferios[key] = {
      hemi: key,
      espessura_media_mm: round(st.media),
      espessura_mediana_mm: round(st.mediana),
      espessura_dp_mm: round(st.dp),
      espessura_media_vox_mm: round(hnv ? hs1 / hnv : NaN),
      voxels: hv,
      area_superficie_media_cm2: round(st.peso / 100, 1)
    }
    qcH[key] = {
      voxels_corticais: nc,
      voxels_invalidos: qc.invalidos,
      frac_truncados_5mm: round(qc.truncados / Math.max(1, nc), 4),
      faces_sulco_reconstruidas: qc.faces_sulco,
      frac_voxels_sulco_fechado: round(qc.voxels_sulco / Math.max(1, nc), 4),
      iter_laplace: qc.iter_u,
      delta_u_final: qc.delta_u,
      iter_L0: qc.iter_L[0],
      iter_L1: qc.iter_L[1],
      amostras_superficie_media: samples.n,
      caixa: box.d
    }
    if (opts.compararSemSulcos && sulcos) {
      post(base + 0.35, `Espessura (hemisfério ${nome}): controle sem reconstrução sulcal…`)
      const r2 = solveBox(cls, box.d, h, { sulcos: false, capMax: opts.capMax, fracaoVoxel: opts.fracaoVoxel, cutMin: opts.cutMin, cutK: opts.cutK, maxIterU: opts.maxIterU })
      const s2 = wstats(r2.samples.t, r2.samples.w, r2.samples.n)
      semSulcos[key] = { espessura_media_mm: round(s2.media), espessura_mediana_mm: round(s2.mediana), frac_truncados_5mm: round(r2.qc.truncados / Math.max(1, nc), 4) }
    }
  }

  post(0.98, 'Espessura: estatísticas por parcela…')
  const keys = [...regAcc.keys()].sort((a, b) => a - b)
  let semParc = 0
  for (const key of keys) {
    const R = regAcc.get(key)
    const lb = key & 255
    if (!L.parc[lb]) { semParc += R.vox; continue }
    const st = wstats(R.tt, R.ww, R.k)
    regioes.push({
      label: lb,
      name: L.name[lb],
      hemi: key >> 8 === 1 ? 'lh' : 'rh',
      parcela: L.parc[lb],
      espessura_media_mm: round(st.media),
      espessura_mediana_mm: round(st.mediana),
      espessura_dp_mm: round(st.dp),
      voxels: R.vox,
      espessura_media_vox_mm: round(R.nv ? R.sv / R.nv : NaN),
      area_superficie_media_mm2: round(st.peso, 0),
      amostras: R.k
    })
  }
  const qc = {
    tempo_s: round((Date.now() - t0) / 1000, 1),
    correcao_fracao_voxel: opts.fracaoVoxel !== false,
    espacamento_mm: h.map(x => round(x, 3)),
    reconstrucao_sulcal: sulcos,
    voxels_corticais_sem_parcela: semParc,
    hemisferios: qcH,
    ...(opts.compararSemSulcos ? { sem_reconstrucao_sulcal: semSulcos } : {})
  }
  const fr = opts.fracaoVoxel !== false
  const metodo = 'Espessura cortical euleriana volumétrica, sem malhas (Laplace; Jones et al. 2000; Yezzi & Prince 2003), ' +
    'sobre a segmentação, por hemisfério: u = 0 na borda com a substância branca e as estruturas profundas coladas a ela ' +
    '(ventrículos laterais, núcleos da base, tálamo, DC ventral), u = 1 na borda com LCR/fundo/cerebelo/tronco/outro hemisfério, ' +
    'fluxo nulo junto a hipocampo/amígdala; bordas entre os centros dos voxels (Shortley–Weller)' +
    (fr ? ' com correção de fração de voxel (cruzamento de zero da distância assinada média no plano tangente)' : ' nas faces dos voxels') + '. ' +
    (sulcos ? 'Sulcos fechados reconstruídos como no PBT/CAT12 (Dahnke et al. 2013): faces do eixo medial da distância à SB dentro do córtex viram pia. ' : 'SEM reconstrução de sulcos fechados. ') +
    'Espessura = L0 + L1 (EDPs de 1ª ordem contra o vento ao longo de T = ∇u/|∇u|); ' +
    'média/mediana/DP ponderadas por área na superfície média u = 0,5; teto de 5 mm como o FreeSurfer. ' +
    'Pesquisa — não validado contra o FreeSurfer (aparc.stats) nos mesmos exames; depende da qualidade do rótulo cortical.'
  post(1, 'Espessura concluída')
  return { regioes, hemisferios, metodo, qc, ...(mapa ? { mapa } : {}) }
}
