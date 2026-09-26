// Régua de qualidade da entrada: classifica o exame em A–D a partir do cabeçalho
// (voxel, anisotropia, nº de cortes, FOV), do histograma de intensidades e do sidecar
// DICOM quando existe. O nível decide o ramo do pipeline (padrão × robusto).

export function assessQuality (hdrInfo, intensity, sidecar) {
  const { dims, pixDims } = hdrInfo // dims [nx,ny,nz], pixDims em mm
  const [dx, dy, dz] = pixDims.map(Math.abs)
  const sorted = [dx, dy, dz].slice().sort((a, b) => a - b)
  const maxVox = sorted[2]
  const minVox = sorted[0]
  const aniso = minVox > 0 ? maxVox / minVox : Infinity
  const nSlices = Math.min(...dims)
  const fov = [dims[0] * dx, dims[1] * dy, dims[2] * dz]
  const minFov = Math.min(...fov)

  const findings = []
  let score = 0
  const add = (pts, txt, bad) => { score += pts; findings.push({ txt, bad: !!bad }) }

  // voxel
  if (maxVox <= 1.2) add(0, `Voxel máximo ${maxVox.toFixed(2)} mm — resolução volumétrica`)
  else if (maxVox <= 2.0) add(1, `Voxel máximo ${maxVox.toFixed(2)} mm — quase isotrópico`, false)
  else if (maxVox <= 4.0) add(2, `Voxel máximo ${maxVox.toFixed(2)} mm — cortes espessos`, true)
  else add(3, `Voxel máximo ${maxVox.toFixed(2)} mm — muito espesso`, true)

  // anisotropia
  if (aniso <= 1.5) add(0, `Anisotropia ${aniso.toFixed(1)}:1`)
  else if (aniso <= 3) add(1, `Anisotropia ${aniso.toFixed(1)}:1`, true)
  else add(2, `Anisotropia ${aniso.toFixed(1)}:1 — aquisição 2D típica`, true)

  // nº de cortes
  if (nSlices >= 120) add(0, `${nSlices} cortes no menor eixo`)
  else if (nSlices >= 60) add(1, `${nSlices} cortes no menor eixo`, false)
  else if (nSlices >= 25) add(2, `Apenas ${nSlices} cortes no menor eixo`, true)
  else add(3, `Somente ${nSlices} cortes — cobertura mínima`, true)

  // FOV
  if (minFov >= 140) add(0, `FOV mínimo ${minFov.toFixed(0)} mm`)
  else add(2, `FOV mínimo ${minFov.toFixed(0)} mm — cobertura encefálica possivelmente incompleta`, true)

  // contraste SC/SB: CJV (MRIQC) com classes de GMM-3 no interior da cabeça — ver estimateContrast
  let contrast = null
  if (intensity && intensity.length) {
    contrast = estimateContrast(intensity, dims, pixDims)
    const c = contrast
    const txt = Number.isFinite(c.cjv)
      ? `CJV ${c.cjv > 5 ? '> 5' : c.cjv.toFixed(2)}, CNR ${c.cnr.toFixed(1)}, separação ${c.separation.toFixed(2)}`
      : `não estimável: ${c.note}`
    if (c.cjv <= CJV_GOOD) add(0, `Contraste tecidual SC/SB bom (${txt})`)
    else if (c.cjv <= CJV_MODERATE) add(1, `Contraste tecidual SC/SB moderado (${txt})`, false)
    else add(2, `Contraste tecidual SC/SB pobre (${txt})`, true)
  }

  // sidecar DICOM
  const seq = sidecar || {}
  const desc = [seq.SeriesDescription, seq.ProtocolName].filter(Boolean).join(' · ')
  if (seq.MagneticFieldStrength && seq.MagneticFieldStrength < 1.0) {
    add(1, `Campo ${seq.MagneticFieldStrength} T — baixo campo`, true)
  }
  const looksT1 = /t1|mprage|spgr|bravo|tfl|fspgr/i.test(desc) || (seq.InversionTime > 0 && seq.EchoTime < 10)
  const looksFlairT2 = /flair|t2/i.test(desc)
  if (desc) findings.push({ txt: `Série: ${desc}`, bad: false })
  if (looksFlairT2) findings.push({ txt: 'Sequência não-T1 (T2/FLAIR): os modelos foram treinados em T1 — confira a segmentação com atenção redobrada', bad: true })

  let grade, gradeTxt, robust
  if (score <= 1) { grade = 'A'; gradeTxt = 'volumétrico, pronto para o pipeline padrão'; robust = false }
  else if (score <= 3) { grade = 'B'; gradeTxt = 'bom, pipeline padrão com ressalvas'; robust = false }
  else if (score <= 6) { grade = 'C'; gradeTxt = 'clínico anisotrópico — modo robusto recomendado'; robust = true }
  else { grade = 'D'; gradeTxt = 'qualidade limítrofe — modo robusto obrigatório, interprete com cautela'; robust = true }

  return {
    grade,
    gradeTxt,
    score,
    robustRecommended: robust,
    findings,
    voxel: [dx, dy, dz],
    maxVox,
    aniso,
    nSlices,
    fov,
    contrast,
    seriesDescription: desc || null,
    fieldStrength: seq.MagneticFieldStrength || null,
    looksT1: looksT1 || (!desc && !looksFlairT2),
    tr: seq.RepetitionTime || null,
    te: seq.EchoTime || null,
    ti: seq.InversionTime || null
  }
}

// ---------------------------------------------------------------- contraste tecidual SC/SB
// Métrica: CJV — coeficiente de variação conjunto (Hui et al. 2010; Ganzetti et al. 2016;
// usado pelo MRIQC, Esteban et al. 2017): CJV = (σ_SB + σ_SC) / |μ_SB − μ_SC|, MENOR = melhor.
// Na carga do exame não há segmentação; as classes são estimadas assim:
//  1. grade subamostrada a ~3 mm (independe do tamanho do voxel);
//  2. primeiro plano = limiar de Otsu na faixa robusta [p0,5, p99,5] — remove o fundo (a
//     métrica antiga, bimodalidade do histograma inteiro, era dominada por ele: somar uma
//     constante à imagem mudava o resultado de 0,28 para 0,70); cavidades internas
//     (ventrículos/LCR abaixo do limiar) são preenchidas;
//  3. erosão de 10 mm (cuboide separável) — tira escalpo, gordura e díploe; o interior
//     resultante é ~90–99% encéfalo nos exames de validação;
//  4. GMM de 3 classes (EM determinístico, início nos quantis 1/6, 1/2, 5/6) no histograma
//     da MÉDIA DOS 6 VIZINHOS a ~1 mm de cada voxel (que exclui o próprio voxel), só onde
//     essa média está acima do meio caminho fundo→Otsu (tira osso/ar); cada voxel recebe
//     a classe da sua vizinhança, e μ/σ de cada classe vêm da intensidade do PRÓPRIO voxel. Como a classe não é
//     decidida pelo valor do voxel, não há viés de seleção: em ruído puro (sem estrutura)
//     as três classes têm a mesma média e o CJV explode (≫ 3), em vez de uma divisão
//     arbitrária de um histograma unimodal parecer "contraste";
//  5. SC/SB = as duas classes mais populosas; a terceira é o LCR (csfBright: LCR mais claro
//     que o par, ex. T2). Vale para qualquer ponderação e é invariante a escala/deslocamento.
// Campos devolvidos: cjv (principal), cnr = |Δμ|/√(σ₁²+σ₂²), separation = 1 − OVL (fração
// NÃO sobreposta das duas gaussianas, 0–1; o nome foi mantido por compatibilidade — antes
// era um índice de bimodalidade sem definição estatística, com outra escala), means, sds,
// weights (classes em ordem crescente de intensidade), pair, csfBright, nInterior.
// Limiares (DESTE estimador — ele fica ~0,1–0,4 acima do CJV com máscaras de segmentação
// porque inclui volume parcial; não compare com valores absolutos do MRIQC, que segmenta com
// o FAST após o N4): ≤ 0,90 bom · ≤ 1,20 moderado · > 1,20 pobre. Calibração: T1 reais
// 0,78–0,86 (CJV com máscaras do SynthSeg 0,67–0,72); T1 + ruído Rician de 5% da SB 0,91
// (ref. 0,81), 8–10% 1,18–1,46 (ref. 0,95–1,05), 20% 2,40 (ref. 1,69); ruído puro/esfera
// homogênea > 5 (30–330); fantoma T1 0,47 (ref. 0,37). Limitações: FLAIR 2D dá 1,05 (ref.
// 2,85 — o par estimado é SB × córtex mais claro, não toda a SC); num T2 com escalpo
// residual no interior, o par pode sair parênquima × LCR (superestima o contraste).
export const CJV_GOOD = 0.9
export const CJV_MODERATE = 1.2

function otsuRange (vals, lo, hi) {
  const nb = 256, hist = new Float64Array(nb), sc = (nb - 1) / (hi - lo)
  for (let i = 0; i < vals.length; i++) {
    const x = vals[i]
    hist[x <= lo ? 0 : x >= hi ? nb - 1 : Math.round((x - lo) * sc)]++
  }
  let sumAll = 0
  for (let b = 0; b < nb; b++) sumAll += b * hist[b]
  let wB = 0, sumB = 0, best = -1, thr = 0
  for (let b = 0; b < nb; b++) {
    wB += hist[b]; if (!wB) continue
    const wF = vals.length - wB; if (!wF) break
    sumB += b * hist[b]
    const d = sumB / wB - (sumAll - sumB) / wF
    if (wB * wF * d * d > best) { best = wB * wF * d * d; thr = b }
  }
  return lo + (thr + 0.5) / sc
}

/** erosão binária por cuboide [±r0, ±r1, ±r2] (separável, exata, O(N)) */
function erodeBox (m, d, r) {
  let cur = m
  const st = [1, d[0], d[0] * d[1]]
  for (let ax = 0; ax < 3; ax++) {
    const R = r[ax]
    if (R < 1) continue
    const out = new Uint8Array(cur.length)
    const n = d[ax], s = st[ax]
    const oa = [0, 1, 2].filter(a => a !== ax)
    const run = new Int32Array(n + 1)
    for (let b = 0; b < d[oa[1]]; b++) for (let a = 0; a < d[oa[0]]; a++) {
      const base = a * st[oa[0]] + b * st[oa[1]]
      for (let i = 0; i < n; i++) run[i + 1] = run[i] + (cur[base + i * s] ? 0 : 1) // zeros acumulados
      for (let i = 0; i < n; i++) {
        const lo = i - R, hi = i + R
        if (lo < 0 || hi > n - 1) continue // borda da grade conta como fora
        if (run[hi + 1] - run[lo] === 0) out[base + i * s] = 1
      }
    }
    cur = out
  }
  return cur
}

/** preenche cavidades (fundo 6-conexo que não toca a borda da grade), in-place */
function fillHoles (m, d) {
  const [nx, ny, nz] = d
  const n = m.length
  const out = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (i) => { if (!m[i] && !out[i]) { out[i] = 1; stack[top++] = i } }
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) push(x + y * nx + z * nx * ny)
  }
  while (top) {
    const i = stack[--top]
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0
    if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1)
    if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx)
    if (z > 0) push(i - nx * ny); if (z < nz - 1) push(i + nx * ny)
  }
  for (let i = 0; i < n; i++) if (!out[i]) m[i] = 1
}

/** EM de mistura gaussiana 1D (K classes) sobre um histograma (centros c, contagens h) */
function gmmHistogram (c, h, K, init) {
  const nb = c.length
  let mu = init.slice(), w = new Array(K).fill(1 / K)
  const bw = c[1] - c[0]
  let sd = new Array(K).fill((c[nb - 1] - c[0]) / (2 * K))
  let total = 0
  for (let b = 0; b < nb; b++) total += h[b]
  const r = new Float64Array(nb * K)
  let prevLL = -Infinity
  for (let it = 0; it < 300; it++) {
    let ll = 0
    for (let b = 0; b < nb; b++) {
      let s = 0
      for (let k = 0; k < K; k++) {
        const z = (c[b] - mu[k]) / sd[k]
        const p = w[k] * Math.exp(-0.5 * z * z) / sd[k]
        r[b * K + k] = p; s += p
      }
      if (s > 0) { for (let k = 0; k < K; k++) r[b * K + k] /= s; ll += h[b] * Math.log(s) }
    }
    for (let k = 0; k < K; k++) {
      let sw = 0, sx = 0
      for (let b = 0; b < nb; b++) { const q = h[b] * r[b * K + k]; sw += q; sx += q * c[b] }
      if (sw <= 0) continue
      const m = sx / sw
      let sv = 0
      for (let b = 0; b < nb; b++) { const q = h[b] * r[b * K + k]; sv += q * (c[b] - m) * (c[b] - m) }
      mu[k] = m; sd[k] = Math.max(bw, Math.sqrt(sv / sw)); w[k] = sw / total
    }
    if (Math.abs(ll - prevLL) < 1e-8 * Math.abs(ll)) { prevLL = ll; break }
    prevLL = ll
  }
  const ord = mu.map((m, k) => k).sort((a, b) => mu[a] - mu[b])
  return { mu: ord.map(k => mu[k]), sd: ord.map(k => sd[k]), w: ord.map(k => w[k]), ll: prevLL }
}

/** coeficiente de sobreposição de duas gaussianas normalizadas (integração numérica) */
function overlap (m1, s1, m2, s2) {
  const lo = Math.min(m1 - 6 * s1, m2 - 6 * s2), hi = Math.max(m1 + 6 * s1, m2 + 6 * s2)
  const n = 4000, dx = (hi - lo) / n
  const g = (x, m, s) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI))
  let a = 0
  for (let i = 0; i < n; i++) { const x = lo + (i + 0.5) * dx; a += Math.min(g(x, m1, s1), g(x, m2, s2)) }
  return Math.min(1, a * dx)
}

/**
 * Contraste SC/SB (CJV por GMM-3 no interior da cabeça) — ver comentário acima.
 * @param {ArrayLike<number>} data volume (x mais rápido)
 * @param {number[]} [dims] [nx,ny,nz] — sem ela, usa só o primeiro plano (sem erosão)
 * @param {number[]} [pixDims] mm por eixo
 * @param {{erodeMM?:number, nbrMM?:number, darkFrac?:number}} [opts] só para validação
 *   (padrões: erosão 10 mm, vizinhos a 1 mm, corte de escuros a 0,5 do caminho fundo→Otsu)
 */
export function estimateContrast (data, dims = null, pixDims = null, opts = {}) {
  const { erodeMM = 10, nbrMM = 1, darkFrac = 0.5 } = opts
  const K = 3
  const empty = (why) => ({ cjv: Infinity, cnr: 0, separation: 0, method: 'CJV', note: why })
  const N = data.length
  const spatial = dims && dims.length === 3 && dims[0] * dims[1] * dims[2] === N
  const pix = (pixDims || [1, 1, 1]).map(p => Math.abs(p) || 1)
  let sub, nbr = null, sd = null, spacing = null
  if (spatial) {
    const st = pix.map(p => Math.max(1, Math.floor(3 / p)))
    sd = dims.map((n, a) => Math.ceil(n / st[a]))
    spacing = pix.map((p, a) => p * st[a])
    sub = new Float32Array(sd[0] * sd[1] * sd[2])
    nbr = new Float32Array(sub.length)
    const [nx, ny, nz] = dims, sxy = nx * ny
    // vizinhos a ~nbrMM (≥ 1 voxel) nos 6 sentidos, na resolução ORIGINAL
    const o = pix.map(p => Math.max(1, Math.round(nbrMM / p)))
    let k = 0
    for (let z = 0; z < nz; z += st[2]) for (let y = 0; y < ny; y += st[1]) {
      const row = y * nx + z * sxy
      const ym = Math.max(0, y - o[1]), yp = Math.min(ny - 1, y + o[1])
      const zm = Math.max(0, z - o[2]), zp = Math.min(nz - 1, z + o[2])
      for (let x = 0; x < nx; x += st[0]) {
        const i = row + x
        sub[k] = data[i]
        const xm = Math.max(0, x - o[0]), xp = Math.min(nx - 1, x + o[0])
        nbr[k++] = (data[row + xm] + data[row + xp] + data[ym * nx + z * sxy + x] + data[yp * nx + z * sxy + x] +
          data[y * nx + zm * sxy + x] + data[y * nx + zp * sxy + x]) / 6
      }
    }
  } else {
    const step = Math.max(1, Math.floor(N / 400000))
    sub = new Float32Array(Math.ceil(N / step))
    for (let i = 0, k = 0; i < N; i += step) sub[k++] = data[i]
  }
  const fin = []
  for (let i = 0; i < sub.length; i++) if (Number.isFinite(sub[i])) fin.push(sub[i])
  if (fin.length < 1000) return empty('amostra insuficiente')
  const sorted = Float32Array.from(fin).sort()
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))]
  const lo = q(sorted, 0.005), hi = q(sorted, 0.995)
  if (!(hi > lo)) return empty('intensidade constante')
  const thr = otsuRange(fin, lo, hi)
  let mask = new Uint8Array(sub.length)
  for (let i = 0; i < sub.length; i++) mask[i] = sub[i] > thr ? 1 : 0
  let erodedMM = 0
  if (spatial) {
    fillHoles(mask, sd)
    for (const R of [erodeMM, 6, 3, 0].filter((r, i) => i === 0 || r < erodeMM)) {
      const m = erodeBox(mask, sd, spacing.map(s => Math.round(R / s)))
      let c = 0
      for (let i = 0; i < m.length; i++) c += m[i]
      if (c >= 2000 || R === 0) { mask = m; erodedMM = R; break }
    }
  }
  // classes: GMM-K no histograma da vizinhança (espacial) ou da própria intensidade (sem dims)
  const cls = nbr || sub
  const idx = []
  // descarta vizinhanças escuras como o fundo (abaixo do meio caminho fundo→Otsu: osso
  // cortical, ar dos seios) — senão, num T2, osso + SB + SC + LCR seriam 4 populações para
  // 3 classes. O critério usa a vizinhança, não o voxel, para não truncar as distribuições
  const dark = lo + darkFrac * (thr - lo)
  for (let i = 0; i < sub.length; i++) if (mask[i] && Number.isFinite(sub[i]) && Number.isFinite(cls[i]) && cls[i] > dark) idx.push(i)
  if (idx.length < 500) return empty('interior da cabeça insuficiente')
  const sv = Float32Array.from(idx, i => cls[i]).sort()
  const a = q(sv, 0.005), b = q(sv, 0.995)
  if (!(b > a)) return empty('interior homogêneo')
  const nb = 256, h = new Float64Array(nb), cen = new Float64Array(nb)
  const bw = (b - a) / nb
  for (let i = 0; i < nb; i++) cen[i] = a + (i + 0.5) * bw
  for (const x of sv) { if (x < a || x > b) continue; h[Math.min(nb - 1, Math.floor((x - a) / bw))]++ }
  // EM determinístico: inicialização nos quantis 1/6, 1/2, 5/6 (várias partidas com escolha
  // por verossimilhança tornavam o resultado instável entre realizações de ruído)
  const g = gmmHistogram(cen, h, K, [q(sv, 1 / 6), q(sv, 0.5), q(sv, 5 / 6)])
  // estatísticas por classe da intensidade do PRÓPRIO voxel, com a classe decidida pela
  // vizinhança (que exclui o voxel): sem viés de seleção — em ruído puro as classes
  // ficam com a mesma média e o CJV explode, em vez de inventar contraste
  const S = new Float64Array(K), S2 = new Float64Array(K), C = new Float64Array(K)
  for (const i of idx) {
    const x = cls[i]
    let best = 0, bp = -Infinity
    for (let k = 0; k < K; k++) {
      const z = (x - g.mu[k]) / g.sd[k]
      const lp = Math.log(g.w[k] + 1e-12) - Math.log(g.sd[k]) - 0.5 * z * z
      if (lp > bp) { bp = lp; best = k }
    }
    const v = sub[i]
    S[best] += v; S2[best] += v * v; C[best]++
  }
  const mu = [], sdv = [], w = []
  for (let k = 0; k < K; k++) {
    const m = C[k] ? S[k] / C[k] : NaN
    mu.push(m); sdv.push(C[k] > 1 ? Math.sqrt(Math.max(0, S2[k] / C[k] - m * m)) : NaN); w.push(C[k] / idx.length)
  }
  // SC/SB = as duas classes mais populosas do interior; a 3ª (menor) é o LCR/resto
  const ord = [0, 1, 2].sort((x, y) => w[y] - w[x])
  const i1 = Math.min(ord[0], ord[1]), i2 = Math.max(ord[0], ord[1])
  const third = ord[2]
  const dmu = Math.abs(mu[i2] - mu[i1])
  const cjv = dmu > 0 ? (sdv[i1] + sdv[i2]) / dmu : Infinity
  const cnr = dmu / Math.sqrt(sdv[i1] ** 2 + sdv[i2] ** 2)
  const separation = sdv[i1] > 0 && sdv[i2] > 0 ? 1 - overlap(mu[i1], sdv[i1], mu[i2], sdv[i2]) : 0
  const r4 = (x) => Number(x.toPrecision(4))
  return {
    cjv: Number.isFinite(cjv) ? cjv : Infinity, cnr: Number.isFinite(cnr) ? cnr : 0, separation,
    method: nbr ? 'CJV (MRIQC); classes por GMM-3 da vizinhança, no interior da cabeça' : 'CJV (MRIQC); classes por GMM-3 da intensidade (sem geometria)',
    means: mu.map(r4), sds: sdv.map(r4), weights: w.map(x => Number(x.toFixed(3))),
    pair: [i1, i2], csfBright: third === 2,
    nInterior: idx.length, erodedMM, threshold: thr, p05: lo, p995: hi
  }
}
