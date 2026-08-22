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

  // contraste: bimodalidade do histograma dentro da faixa robusta (proxy de contraste SC/SB)
  let contrast = null
  if (intensity && intensity.length) {
    contrast = estimateContrast(intensity)
    if (contrast.separation >= 0.28) add(0, `Contraste tecidual estimado bom (separação ${contrast.separation.toFixed(2)})`)
    else if (contrast.separation >= 0.15) add(1, `Contraste tecidual moderado (separação ${contrast.separation.toFixed(2)})`, false)
    else add(2, `Contraste tecidual pobre (separação ${contrast.separation.toFixed(2)})`, true)
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

// separação entre os dois modos principais do histograma (0 = unimodal, ~0.5 = T1 nítido)
function estimateContrast (data) {
  const n = data.length
  const step = Math.max(1, Math.floor(n / 300000))
  const vals = []
  for (let i = 0; i < n; i += step) { const x = data[i]; if (x > 0 && isFinite(x)) vals.push(x) }
  if (vals.length < 1000) return { separation: 0, p2: 0, p98: 0 }
  vals.sort((a, b) => a - b)
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))]
  const lo = q(0.02), hi = q(0.98)
  if (hi <= lo) return { separation: 0, p2: lo, p98: hi }
  const nb = 64
  const hist = new Float64Array(nb)
  for (const x of vals) {
    const b = Math.max(0, Math.min(nb - 1, Math.floor((x - lo) / (hi - lo) * nb)))
    hist[b]++
  }
  // suaviza e procura dois picos separados por um vale
  const sm = new Float64Array(nb)
  for (let i = 0; i < nb; i++) {
    let s = 0, w = 0
    for (let d = -2; d <= 2; d++) {
      const j = i + d
      if (j < 0 || j >= nb) continue
      const g = [1, 4, 6, 4, 1][d + 2]
      s += hist[j] * g; w += g
    }
    sm[i] = s / w
  }
  const peaks = []
  for (let i = 2; i < nb - 2; i++) {
    if (sm[i] > sm[i - 1] && sm[i] >= sm[i + 1] && sm[i] > 0.05 * Math.max(...sm)) peaks.push(i)
  }
  if (peaks.length < 2) return { separation: 0, p2: lo, p98: hi }
  // par de picos com maior massa combinada e vale profundo entre eles
  let best = 0
  for (let a = 0; a < peaks.length - 1; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const i1 = peaks[a], i2 = peaks[b]
      let valley = Infinity
      for (let i = i1; i <= i2; i++) valley = Math.min(valley, sm[i])
      const pk = Math.min(sm[i1], sm[i2])
      if (pk <= 0) continue
      const depth = 1 - valley / pk
      const dist = (i2 - i1) / nb
      best = Math.max(best, depth * Math.min(1, dist * 3))
    }
  }
  return { separation: best, p2: lo, p98: hi }
}
