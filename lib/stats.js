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
  for (const key of Object.keys(labelsMap)) {
    const idx = +key
    if (idx === 0 || !count[idx]) {
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
  if (!hasLateral) {
    hemiMethod = 'divisão geométrica pela linha média (x RAS = 0)'
    let vv = 0
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, vv++) {
          if (seg[vv] === 0) continue
          const x = affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3]
          if (x < 0) volL += voxVol
          else if (x > 0) volR += voxVol
        }
      }
    }
  }

  // agregados clínicos
  const sumWhere = (pred) => rows.reduce((a, r) => a + (pred(r) ? r.volMm3 : 0), 0)
  const ventricles = sumWhere(r => r.group === 'ventrículos')
  const csf = sumWhere(r => r.group === 'líquor')
  const composites = [
    ['BrainSegVol', 'Volume encefálico segmentado', brainVol],
    ['ParenchymaVol', 'Parênquima (encéfalo − ventrículos − líquor)', brainVol - ventricles - csf],
    ['CortexVol', 'Córtex cerebral total', sumWhere(r => r.group === 'cortex' || r.group === 'córtex')],
    ['CerebralWhiteMatterVol', 'Substância branca cerebral', sumWhere(r => r.group === 'substância branca' || /Cerebral-White-Matter/.test(r.name))],
    ['SubcorticalGrayVol', 'Cinzenta subcortical', sumWhere(r => r.group === 'subcortical')],
    ['CerebellumVol', 'Cerebelo total', sumWhere(r => r.group === 'cerebelo')],
    ['CerebellumLeftVol', 'Cerebelo esquerdo', sumWhere(r => r.group === 'cerebelo' && r.hemi === 'E')],
    ['CerebellumRightVol', 'Cerebelo direito', sumWhere(r => r.group === 'cerebelo' && r.hemi === 'D')],
    ['BrainStemVol', 'Tronco encefálico', sumWhere(r => r.group === 'tronco')],
    ['VentricleVol', 'Ventrículos totais', ventricles],
    ['CorpusCallosumVol', 'Corpo caloso total', sumWhere(r => r.group === 'caloso')],
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
      id: 'Lobe_' + lb.replace(/[^a-z]/g, '') + (hemi === 'E' ? '_L' : hemi === 'D' ? '_R' : ''),
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
  return { rows, composites, lobes, pairs, brainVol, hemiMethod, perGroup, voxVol }
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
    const s = (+x).toFixed(d)
    return decimal === ',' ? s.replace('.', ',') : s
  }
  const sep = decimal === ',' ? ';' : ','
  const esc = (s) => /[";\n,]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s
  const L = []
  L.push(['exame', 'tipo', 'indice', 'rotulo', 'estrutura', 'grupo', 'hemisferio', 'volume_mm3', 'pct_encefalo', 'intensidade_media', 'intensidade_dp', 'centroide_x', 'centroide_y', 'centroide_z'].join(sep))
  const sid = esc(meta.subject || 'exame')
  for (const r of stats.rows) {
    if (r.group === 'fundo') continue
    L.push([sid, 'estrutura', r.index, esc(r.name), esc(r.ptName), esc(GROUP_PT[r.group] || r.group), r.hemi || '', fmt(r.volMm3), fmt(r.pctBrain, 2),
      fmt(r.meanInt, 2), fmt(r.sdInt, 2),
      r.centroid ? fmt(r.centroid[0], 1) : '', r.centroid ? fmt(r.centroid[1], 1) : '', r.centroid ? fmt(r.centroid[2], 1) : ''].join(sep))
  }
  for (const c of stats.composites) {
    L.push([sid, 'agregado', '', esc(c.id), esc(c.ptName), '', '', fmt(c.volMm3), fmt(c.pctBrain, 2), '', '', '', '', ''].join(sep))
  }
  for (const lb of stats.lobes) {
    L.push([sid, 'lobo', '', esc(lb.id), esc(lb.ptName), '', lb.hemi === '·' ? '' : lb.hemi, fmt(lb.volMm3), fmt(lb.pctBrain, 2), '', '', '', '', ''].join(sep))
  }
  for (const p of stats.pairs) {
    L.push([sid, 'assimetria', '', esc(p.base), esc(p.ptName), esc(GROUP_PT[p.group] || p.group), '', '', '', '', '', fmt(p.left, 1), fmt(p.right, 1), fmt(p.ai, 2)].join(sep))
  }
  return L.join('\r\n')
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
    volume_encefalico_mm3: stats.brainVol,
    metodo_hemisferios: stats.hemiMethod,
    normativo: meta.norms && meta.norms.available ? {
      referencia: 'Brain charts (Bethlehem et al., Nature 2022) — aproximação para QC, não clínico',
      idade: meta.norms.age, sexo: meta.norms.sex,
      globais: meta.norms.globals, lobos: meta.norms.lobes, parcelas: meta.norms.parcels,
      bandeiras: meta.norms.flags.map(f => ({ medida: f.pt, z: f.z, tipo: f.flag }))
    } : null,
    agregados: stats.composites,
    lobos: stats.lobes,
    estruturas: stats.rows.filter(r => r.group !== 'fundo'),
    assimetria: stats.pairs,
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
    labels[k] = 'Índice de assimetria — ' + p.ptName + ' (%)'
  }
  return { row, labels }
}
