// Estatísticas por estrutura a partir do mapa de rótulos (256³, 1 mm isotrópico após conform)
// e da imagem conformada. Tudo em milímetros cúbicos; o affine leva índice de voxel a RAS.

import { parseLabelName, groupOf, ptNameOf, lobeOf, LOBE_PT, GROUP_PT } from './labels.js'

function applyAffine (A, i, j, k) {
  return [
    A[0][0] * i + A[0][1] * j + A[0][2] * k + A[0][3],
    A[1][0] * i + A[1][1] * j + A[1][2] * k + A[1][3],
    A[2][0] * i + A[2][1] * j + A[2][2] * k + A[2][3]
  ]
}

/**
 * @param {Uint8Array} seg    mapa de rótulos, mesmo ordenamento de voxels da imagem conformada
 * @param {Uint8Array|Float32Array} img  imagem conformada (intensidades)
 * @param {number[]} dims     [nx, ny, nz]
 * @param {Object} labelsMap  { "0": "BG", "1": "Cerebral-White-Matter", ... }
 * @param {number[][]} affine 4×4 voxel→RAS da imagem conformada
 * @param {number} voxVol     volume do voxel em mm³ (1 no espaço conformado)
 * @param {Object} [ptMap]    nomes em português por índice de rótulo (sobrepõe o dicionário)
 */
export function computeStats (seg, img, dims, labelsMap, affine, voxVol = 1, ptMap = null) {
  // volume do voxel = |det| da parte 3×3 da affine (correto também com shear/oblíquo,
  // onde o produto dos pixdim superestima); o valor informado só vale sem affine
  const detVol = affine ? Math.abs(det3(affine)) : 0
  let voxVolSource = 'informado'
  if (detVol > 0 && isFinite(detVol)) {
    voxVolSource = 'determinante da affine'
    voxVol = detVol
  }
  const [nx, ny, nz] = dims
  const nvox = nx * ny * nz
  const K = 256
  const count = new Float64Array(K)
  const sum = new Float64Array(K)
  const sum2 = new Float64Array(K)
  const si = new Float64Array(K)
  const sj = new Float64Array(K)
  const sk = new Float64Array(K)

  let v = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, v++) {
        const lab = seg[v]
        if (lab === 0) continue
        const val = img[v]
        count[lab]++
        sum[lab] += val
        sum2[lab] += val * val
        si[lab] += i; sj[lab] += j; sk[lab] += k
      }
    }
  }
  if (v !== nvox) throw new Error('dimensões inconsistentes')

  // hemisfério por rótulo; se o modelo não separa E/D, decide pela linha média em RAS-x
  const rows = []
  let brainVox = 0
  const perGroup = {}
  const rotulosOmitidos = []
  for (const key of Object.keys(labelsMap)) {
    const idx = +key
    if (idx === 0 || !count[idx]) {
      // o protocolo DKT (Klein & Tourville 2012) eliminou bankssts, frontalpole e
      // temporalpole: com a parcelação DKT eles não existem (volume zero por definição)
      // e ficam fora das tabelas/exportações em vez de aparecerem como zeros
      if (idx !== 0 && DKT_AUSENTES.test(labelsMap[key] || '')) { rotulosOmitidos.push(labelsMap[key]); continue }
      if (idx !== 0 && labelsMap[key]) {
        // estrutura prevista mas ausente entra com volume zero (importa para coorte)
        rows.push(makeRow(idx, labelsMap[key], 0, 0, 0, null, ptMap))
      }
      continue
    }
    const name = labelsMap[key]
    const n = count[idx]
    brainVox += n
    const mean = sum[idx] / n
    const sd = Math.sqrt(Math.max(0, sum2[idx] / n - mean * mean))
    const centroid = applyAffine(affine, si[idx] / n, sj[idx] / n, sk[idx] / n)
    rows.push(makeRow(idx, name, n * voxVol, mean, sd, centroid, ptMap))
  }
  const brainVol = brainVox * voxVol

  for (const r of rows) {
    r.pctBrain = brainVol > 0 ? 100 * r.volMm3 / brainVol : 0
    perGroup[r.group] = (perGroup[r.group] || 0) + r.volMm3
  }

  // hemisférios: soma dos rótulos lateralizados; se nenhum rótulo é lateralizado,
  // divide o parênquima pela linha média (RAS x = 0)
  let volL = 0, volR = 0
  let hasLateral = false
  for (const r of rows) {
    if (r.hemi === 'E') { volL += r.volMm3; hasLateral = true }
    else if (r.hemi === 'D') { volR += r.volMm3; hasLateral = true }
  }
  let hemiMethod = 'rótulos lateralizados do modelo'
  if (!hasLateral && brainVox > 0) {
    // plano sagital pelo centroide x (RAS) do tecido rotulado — x = 0 do scanner não é,
    // em geral, a linha média do encéfalo (cabeça fora do isocentro)
    let sx = 0
    for (let lab = 1; lab < K; lab++) {
      if (count[lab] && labelsMap[lab] != null) sx += affine[0][0] * si[lab] + affine[0][1] * sj[lab] + affine[0][2] * sk[lab] + affine[0][3] * count[lab]
    }
    const x0 = sx / brainVox
    hemiMethod = `divisão geométrica pelo plano sagital do centroide (x RAS = ${x0.toFixed(1)} mm)`
    let vv = 0
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, vv++) {
          const lab = seg[vv]
          if (lab === 0 || labelsMap[lab] == null) continue
          const x = affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3]
          if (x < x0) volL += voxVol
          else if (x > x0) volR += voxVol
        }
      }
    }
  }

  const sumWhere = (pred) => rows.reduce((a, r) => a + (pred(r) ? r.volMm3 : 0), 0)

  // agregados — nomes e definições do FreeSurfer 7 (mri_segstats / ComputeBrainVolumeStats2
  // em utils/cma.cpp; conferidos com a reimplementação do FastSurfer, brainvolstats.py),
  // aproximados por contagem de voxels. CortexVol no FreeSurfer é pial − white (superfície);
  // aqui é a soma dos rótulos corticais. Rótulos genéricos "Grey/White Matter" (modelos
  // de 3 classes) NÃO entram em CortexVol/CerebralWhiteMatterVol — eles incluem cerebelo
  // e núcleos da base e vão para TotalGrayVol/TotalWhiteMatterVol.
  const isGenericGM = (r) => /^(Grey|Gray) Matter$/.test(r.name)
  const isGenericWM = (r) => /^White Matter$/.test(r.name)
  const isBrainStem = (r) => /^Brain-?Stem$/i.test(parseLabelName(r.name).base)
  const isOpticChiasm = (r) => /Optic-Chiasm/i.test(r.name)
  const isCSF = (r) => r.group === 'líquor'
  const isVentChor = (r) => /(^|-)Lateral-Ventricle$|Inf-Lat-Vent$|choroid-plexus$/i.test(r.name) || /^Ventricle$/.test(r.name)
  const isTFF = (r) => /^(3rd|4th|5th)-Ventricle$/.test(r.name)
  const isCC = (r) => r.group === 'caloso'
  const isCortex = (r) => (r.group === 'cortex' || r.group === 'córtex') && !isGenericGM(r)
  const isCerebralWM = (r) => /Cerebral-White-Matter$/.test(r.name) || /(^|-)WM-hypointensities$/.test(r.name) || /Fornix$/.test(r.name)
  const isCblmGM = (r) => /Cerebellum-Cortex$|^Cerebellum$|Vermal/.test(parseLabelName(r.name).base)
  const ventricles = sumWhere(r => r.group === 'ventrículos')
  const csf = sumWhere(isCSF)
  // BrainSegVol (FS7): tudo exceto fundo, tronco encefálico e quiasma óptico — INCLUI líquor (24)
  const brainSeg = sumWhere(r => !isBrainStem(r) && !isOpticChiasm(r))
  const ventChor = sumWhere(isVentChor)
  const tffc = sumWhere(r => isTFF(r) || isCSF(r))
  const cerebellum = sumWhere(r => r.group === 'cerebelo')
  const subCortGray = sumWhere(r => r.group === 'subcortical' && !/Basal-Forebrain/.test(r.name))
  const cortexVol = sumWhere(isCortex)
  const cblmGM = sumWhere(isCblmGM)
  const hasCSF = rows.some(r => isCSF(r) && r.volMm3 > 0)
  const composites = [
    ['BrainSegVol', 'Volume encefálico segmentado (FreeSurfer 7: exceto tronco e quiasma; inclui líquor)', brainSeg],
    ['BrainSegVolNotVent', 'Encéfalo sem ventrículos, plexo coroide e líquor (FreeSurfer)', brainSeg - ventChor - tffc],
    ['SupraTentorialVol', 'Supratentorial (BrainSegVol − cerebelo)', brainSeg - cerebellum],
    ['SupraTentorialVolNotVent', 'Supratentorial sem ventrículos e líquor', brainSeg - cerebellum - ventChor - tffc],
    // total de todos os rótulos ≠ 0: é o "total intracranial" do vol.csv do SynthSeg
    // (soma de todas as estruturas, com líquor e tronco) quando o modelo rotula o líquor
    [hasCSF ? 'TotalIntracranialVol' : 'TotalSegmentedVol', hasCSF ? 'Intracraniano total (convenção SynthSeg: todos os rótulos, com líquor)' : 'Total segmentado (todos os rótulos; modelo sem líquor — NÃO é TIV)', brainVol],
    ['ParenchymaVol', 'Parênquima (todos os rótulos − ventrículos − líquor)', brainVol - ventricles - csf],
    ['CortexVol', 'Córtex cerebral total', cortexVol],
    ['CerebralWhiteMatterVol', 'Substância branca cerebral (com corpo caloso e hipointensidades, como no FreeSurfer)', sumWhere(r => isCerebralWM(r) || isCC(r))],
    ['SubCortGrayVol', 'Cinzenta subcortical (FreeSurfer SubCortGrayVol)', subCortGray],
    ['TotalGrayVol', 'Substância cinzenta total (córtex + subcortical + córtex cerebelar)', cortexVol + subCortGray + cblmGM + sumWhere(isGenericGM)],
    ['TotalWhiteMatterVol', 'Substância branca total (rótulo genérico do modelo, inclui cerebelo)', sumWhere(isGenericWM)],
    ['CerebellumVol', 'Cerebelo total', cerebellum],
    ['CerebellumLeftVol', 'Cerebelo esquerdo', sumWhere(r => r.group === 'cerebelo' && r.hemi === 'E')],
    ['CerebellumRightVol', 'Cerebelo direito', sumWhere(r => r.group === 'cerebelo' && r.hemi === 'D')],
    ['BrainStemVol', 'Tronco encefálico', sumWhere(r => r.group === 'tronco')],
    ['VentricleChoroidVol', 'Ventrículos laterais + cornos temporais + plexo coroide (FreeSurfer)', ventChor],
    ['VentricleVol', 'Ventrículos totais (laterais, cornos temporais, 3º e 4º)', ventricles],
    ['CorpusCallosumVol', 'Corpo caloso total', sumWhere(isCC)],
    ['LeftHemisphereVol', 'Hemisfério esquerdo (' + hemiMethod + ')', volL],
    ['RightHemisphereVol', 'Hemisfério direito', volR]
  ].filter(c => c[2] > 0 || c[0] === 'BrainSegVol')
    .map(([id, pt, vol]) => ({ id, ptName: pt, volMm3: vol, pctBrain: brainVol ? 100 * vol / brainVol : 0 }))

  // lobos por hemisfério (apenas quando há parcelação cortical)
  const lobes = []
  const lobeAcc = {}
  for (const r of rows) {
    const lb = lobeOf(r.name)
    if (!lb) continue
    const key = lb + '|' + (r.hemi || '·')
    lobeAcc[key] = (lobeAcc[key] || 0) + r.volMm3
  }
  for (const key of Object.keys(lobeAcc).sort()) {
    const [lb, hemi] = key.split('|')
    lobes.push({
      id: 'Lobe_' + lb.normalize('NFD').replace(/[^a-z]/g, '') + (hemi === 'E' ? '_L' : hemi === 'D' ? '_R' : ''),
      ptName: LOBE_PT[lb] + (hemi === 'E' ? ' — esquerdo' : hemi === 'D' ? ' — direito' : ''),
      lobe: lb,
      hemi,
      volMm3: lobeAcc[key],
      pctBrain: brainVol ? 100 * lobeAcc[key] / brainVol : 0
    })
  }

  // assimetria: pares E/D com o mesmo nome-base — IA = 200·(E−D)/(E+D)
  const pairs = []
  const byBase = {}
  for (const r of rows) {
    if (!r.hemi) continue
    const b = parseLabelName(r.name)
    const key = (b.cortical ? 'ctx:' : '') + b.base
    byBase[key] = byBase[key] || {}
    byBase[key][r.hemi] = r
  }
  for (const key of Object.keys(byBase)) {
    const p = byBase[key]
    if (!p.E || !p.D) continue
    const L = p.E.volMm3, R = p.D.volMm3
    if (L + R <= 0) continue
    pairs.push({
      base: key.replace(/^ctx:/, ''),
      ptName: p.E.ptName.replace(/ — esquerd[oa]$/, ''),
      group: p.E.group,
      left: L,
      right: R,
      ai: 200 * (L - R) / (L + R)
    })
  }
  pairs.sort((a, b) => Math.abs(b.ai) - Math.abs(a.ai))

  rows.sort((a, b) => a.group === b.group ? b.volMm3 - a.volMm3 : String(a.group).localeCompare(String(b.group)))
  return { rows, composites, lobes, pairs, brainVol, hemiMethod, perGroup, voxVol, voxVolSource, rotulosOmitidos }
}

// parcelas do Desikan-Killiany que o protocolo DKT não tem (Klein & Tourville 2012)
const DKT_AUSENTES = /^ctx-[lr]h-(bankssts|frontalpole|temporalpole)$/

// convenção do índice de assimetria (documentada no JSON, no SPSS, no PDF e no README)
export const CONVENCAO_ASSIMETRIA = 'IA = 200·(E − D)/(E + D), em %: positivo = esquerda maior, negativo = direita maior (faixa −200 a +200; 0 = simetria). Pares E/D com o mesmo nome-base (Left-/Right-, ctx-lh-/ctx-rh-), sobre o volume por contagem de voxels.'

function det3 (A) {
  return A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
    A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
    A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])
}

function makeRow (index, name, volMm3, meanInt, sdInt, centroid, ptMap) {
  return {
    index,
    name,
    ptName: (ptMap && ptMap[index]) || ptNameOf(name),
    group: groupOf(name),
    hemi: parseLabelName(name).hemi,
    volMm3,
    pctBrain: 0,
    meanInt,
    sdInt,
    centroid
  }
}

// ---------- serializações tabulares ----------

export function statsToCSV (stats, meta, decimal = '.') {
  const fmt = (x, d = 1) => {
    if (x == null || x === '' || !isFinite(+x)) return ''
    const s = (+x).toFixed(d)
    return decimal === ',' ? s.replace('.', ',') : s
  }
  const sep = decimal === ',' ? ';' : ','
  // RFC 4180: aspas em campos com separador, aspas ou quebra de linha
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[";,\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const HEAD = ['exame', 'tipo', 'indice', 'rotulo', 'estrutura', 'grupo', 'hemisferio', 'volume_mm3', 'pct_encefalo', 'intensidade_media', 'intensidade_dp', 'centroide_x', 'centroide_y', 'centroide_z', 'espessura_mm', 'espessura_dp_mm', 'area_mm2', 'vol_esquerdo_mm3', 'vol_direito_mm3', 'indice_assimetria_pct', 'volume_soft_mm3']
  const blank = () => HEAD.map(() => '')
  const L = [HEAD.join(sep)]
  const sid = esc(meta.subject || 'exame')
  const line = (o) => { const c = blank(); for (const [k, v] of Object.entries(o)) c[HEAD.indexOf(k)] = v; L.push(c.join(sep)) }
  for (const r of stats.rows) {
    if (r.group === 'fundo') continue
    line({
      exame: sid, tipo: 'estrutura', indice: r.index, rotulo: esc(r.name), estrutura: esc(r.ptName), grupo: esc(GROUP_PT[r.group] || r.group), hemisferio: r.hemi || '',
      volume_mm3: fmt(r.volMm3), pct_encefalo: fmt(r.pctBrain, 2),
      // SynthSeg: soma dos posteriors (convenção do --vol oficial), além da contagem
      volume_soft_mm3: r.volSoftMm3 != null ? fmt(r.volSoftMm3) : '',
      // estrutura ausente (volume 0): intensidade e centroide ficam vazios, não 0
      intensidade_media: r.volMm3 > 0 ? fmt(r.meanInt, 2) : '', intensidade_dp: r.volMm3 > 0 ? fmt(r.sdInt, 2) : '',
      centroide_x: r.centroid ? fmt(r.centroid[0], 1) : '', centroide_y: r.centroid ? fmt(r.centroid[1], 1) : '', centroide_z: r.centroid ? fmt(r.centroid[2], 1) : ''
    })
  }
  for (const c of stats.composites) {
    line({ exame: sid, tipo: 'agregado', rotulo: esc(c.id), estrutura: esc(c.ptName), volume_mm3: fmt(c.volMm3), pct_encefalo: fmt(c.pctBrain, 2) })
  }
  for (const lb of stats.lobes) {
    line({ exame: sid, tipo: 'lobo', rotulo: esc(lb.id), estrutura: esc(lb.ptName), hemisferio: lb.hemi === '·' ? '' : lb.hemi, volume_mm3: fmt(lb.volMm3), pct_encefalo: fmt(lb.pctBrain, 2) })
  }
  // assimetria em colunas próprias (antes caía nas colunas de centroide)
  for (const p of stats.pairs) {
    line({ exame: sid, tipo: 'assimetria', rotulo: esc(p.base), estrutura: esc(p.ptName), grupo: esc(GROUP_PT[p.group] || p.group), vol_esquerdo_mm3: fmt(p.left, 1), vol_direito_mm3: fmt(p.right, 1), indice_assimetria_pct: fmt(p.ai, 2) })
  }
  if (meta.surf && meta.surf.regioes) {
    for (const r of meta.surf.regioes) {
      line({ exame: sid, tipo: 'superficie', indice: r.label ?? '', rotulo: esc(r.name), estrutura: esc(r.pt || r.base), grupo: 'Superfície cortical', hemisferio: r.hemi || '', volume_mm3: fmt(r.volume_mm3), espessura_mm: fmt(r.thickAvg, 2), espessura_dp_mm: fmt(r.thickStd, 2), area_mm2: fmt(r.area_mm2, 1) })
    }
  }
  // BOM UTF-8: o Excel (pt-BR) só lê os acentos corretamente com ele
  return '\uFEFF' + L.join('\r\n') + '\r\n'
}

export function statsToJSON (stats, meta) {
  return JSON.stringify({
    ferramenta: meta.tool,
    versao: meta.version,
    exame: meta.subject,
    data: meta.date,
    entrada: meta.input,
    qualidade: meta.quality,
    pipeline: meta.pipeline,
    preprocessamento: meta.preproc || null,
    modelo: meta.model,
    unidade_volume: 'mm3',
    volume_voxel_mm3: stats.voxVol,
    fonte_volume_voxel: stats.voxVolSource || null,
    metodo_volume: stats.volumeSoft
      ? 'volMm3 = contagem de voxels rotulados (volume rígido); volSoftMm3 = soma dos posteriors após o pós-processamento (volume suave, convenção do --vol do SynthSeg oficial; os 3 maiores posteriors por voxel)'
      : 'contagem de voxels rotulados (volume rígido); o SynthSeg oficial soma as posteriores (volume suave)',
    volume_total_rotulado_mm3: stats.brainVol,
    metodo_hemisferios: stats.hemiMethod,
    normativo: meta.norms && meta.norms.available ? {
      referencia: 'Brain charts (Bethlehem et al., Nature 2022) — aproximação para QC, não clínico',
      idade: meta.norms.age, sexo: meta.norms.sex,
      globais: meta.norms.globals, lobos: meta.norms.lobes, parcelas: meta.norms.parcels,
      bandeiras: meta.norms.flags.map(f => ({ medida: f.pt, z: f.z, tipo: f.flag }))
    } : null,
    superficie: meta.surf ? {
      metodo: meta.surf.fluxo || 'fluxo recon-all-clinical (navegador): SDFs white/pial + colocação Eq. 5 + espessura Fischl & Dale (teto 5 mm)',
      motorSdf: meta.surf.motorSdf || null,
      eulerQC: meta.surf.euler || null,
      talairachRotulos: meta.surf.talairachRotulos || 0,
      regioes: meta.surf.regioes
    } : null,
    agregados: stats.composites,
    lobos: stats.lobes,
    estruturas: stats.rows.filter(r => r.group !== 'fundo'),
    convencao_assimetria: CONVENCAO_ASSIMETRIA,
    assimetria: stats.pairs,
    rotulos_omitidos: stats.rotulosOmitidos && stats.rotulosOmitidos.length
      ? { rotulos: stats.rotulosOmitidos, motivo: 'ausentes por definição no protocolo DKT (Klein & Tourville 2012): bankssts, frontalpole e temporalpole foram absorvidos pelas regiões vizinhas' }
      : null,
    ressalvas: meta.caveats
  }, null, 2)
}

// linha larga (uma por exame) para coorte / SAV
export function statsToWideRow (stats, meta) {
  const sane = (s) => String(s).replace(/\*/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  const row = { subject: meta.subject || 'exame', date: meta.date || '', pipeline: meta.pipeline || '', model: meta.model || '', quality: (meta.quality && meta.quality.grade) || '' }
  const labels = { subject: 'Identificação do exame', date: 'Data do processamento', pipeline: 'Pipeline', model: 'Modelo de segmentação', quality: 'Nível de qualidade da entrada' }
  for (const c of stats.composites) { row[sane(c.id)] = c.volMm3; labels[sane(c.id)] = c.ptName + ' (mm³)' }
  for (const lb of stats.lobes) { row[sane(lb.id)] = lb.volMm3; labels[sane(lb.id)] = lb.ptName + ' (mm³)' }
  for (const r of stats.rows) {
    if (r.group === 'fundo') continue
    row[sane(r.name)] = r.volMm3
    labels[sane(r.name)] = r.ptName + ' (mm³)'
  }
  for (const p of stats.pairs) {
    const k = 'AI_' + sane(p.base)
    row[k] = p.ai
    labels[k] = 'Índice de assimetria 200·(E−D)/(E+D) — ' + p.ptName + ' (%; + = esquerda maior)'
  }
  if (meta.surf && meta.surf.regioes) {
    for (const r of meta.surf.regioes) {
      const b = sane(r.hemi === 'E' ? 'lh_' + r.base : 'rh_' + r.base)
      row['thick_' + b] = r.thickAvg
      labels['thick_' + b] = 'Espessura média — ' + (r.pt || r.base) + ' (mm, aproximação EDT)'
      row['surfarea_' + b] = r.area_mm2
      labels['surfarea_' + b] = 'Área pial — ' + (r.pt || r.base) + ' (mm²)'
    }
  }
  return { row, labels }
}
