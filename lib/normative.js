// Comparação normativa ajustada por idade e sexo, a partir das curvas populacionais
// dos brain charts de Bethlehem et al. (Nature 2022) — modelos GAMLSS-GG oficiais do
// repositório github.com/brainchart/Lifespan, avaliados offline (efeitos fixos,
// versão-base do FreeSurfer) e vendorizados em models/normative/brainchart.json.
//
// Uso em pesquisa/QC, não clínico: as normas foram ajustadas em volumes FreeSurfer
// harmonizados; os volumes desta ferramenta vêm do SynthSeg/DKT — a comparação é
// aproximada. |z| ≥ 4 é tratado como possível ERRO DE SEGMENTAÇÃO (bandeira de QC).

let NORMS = null

export async function loadNorms (url = './models/normative/brainchart.json') {
  if (NORMS) return NORMS
  NORMS = await (await fetch(url)).json()
  return NORMS
}

// inversa da normal padrão (aproximação de Acklam, |erro| < 1.15e-9)
export function qnorm (p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  let q, r
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= 1 - pl) {
    q = p - 0.5; r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

function interpRow (tbl, age) {
  const ages = NORMS.idades
  const a = Math.max(ages[0], Math.min(ages[ages.length - 1], age))
  const i0 = Math.max(0, Math.min(ages.length - 2, Math.floor(a) - ages[0]))
  const t = a - ages[i0]
  const lerp = (x, y) => x + t * (y - x)
  return {
    q: tbl.q[i0].map((v, j) => lerp(v, tbl.q[i0 + 1][j])),
    mean: lerp(tbl.mean[i0], tbl.mean[i0 + 1]),
    sd: lerp(tbl.sd[i0], tbl.sd[i0 + 1])
  }
}

/**
 * Avalia um volume contra a norma. sex: 'F'|'M'; age em anos.
 * → { percentile (0.1–99.9, clampado), z, zGauss, median, flag: null|'atipico'|'erro?' }
 */
export function evaluate (pheno, sex, age, valueMm3) {
  if (!NORMS || !NORMS.fenotipos[pheno] || !(sex === 'F' || sex === 'M') || !(age > 0)) return null
  const row = interpRow(NORMS.fenotipos[pheno][sex], age)
  const probs = NORMS.probs
  const q = row.q
  // percentil por interpolação monótona na tabela de quantis
  let pct
  if (valueMm3 <= q[0]) pct = probs[0]
  else if (valueMm3 >= q[q.length - 1]) pct = probs[probs.length - 1]
  else {
    let j = 0
    while (valueMm3 > q[j + 1]) j++
    const f = (valueMm3 - q[j]) / (q[j + 1] - q[j] || 1)
    pct = probs[j] + f * (probs[j + 1] - probs[j])
  }
  const zGauss = row.sd > 0 ? (valueMm3 - row.mean) / row.sd : 0
  // z do percentil dentro da tabela; fora dela, usa o z gaussiano (linear nas caudas)
  let z = qnorm(pct)
  if (valueMm3 < q[0] || valueMm3 > q[q.length - 1]) z = zGauss
  const az = Math.abs(z)
  const flag = az >= 4 ? 'erro?' : az >= 3 ? 'atipico' : null
  return {
    percentile: Math.min(99.9, Math.max(0.1, pct * 100)),
    z, zGauss, median: q[Math.floor(probs.length / 2)], mean: row.mean, sd: row.sd, flag
  }
}

// mapeia agregados do SegmentaRM → fenótipos dos brain charts
const GLOBAL_MAP = [
  ['GMV', 'Córtex cerebral total (GMV)', s => comp(s, 'CortexVol')],
  ['WMV', 'Substância branca cerebral (WMV)', s => comp(s, 'CerebralWhiteMatterVol')],
  ['sGMV', 'Cinzenta subcortical (sGMV)', s => comp(s, 'SubcorticalGrayVol')],
  ['Ventricles', 'Ventrículos', s => comp(s, 'VentricleVol')],
  ['TCV', 'Cérebro total (GMV+WMV+sGMV)', s => {
    const a = comp(s, 'CortexVol'); const b = comp(s, 'CerebralWhiteMatterVol'); const c = comp(s, 'SubcorticalGrayVol')
    return (a == null && b == null) ? null : (a || 0) + (b || 0) + (c || 0)
  }]
]
function comp (stats, id) {
  const c = stats.composites.find(x => x.id === id)
  return c ? c.volMm3 : null
}

const LOBE_PT_TOTAL = { frontal: 'Lobo frontal', parietal: 'Lobo parietal', temporal: 'Lobo temporal', occipital: 'Lobo occipital', 'ínsula': 'Ínsula', 'cíngulo': 'Cíngulo' }

/**
 * Compara as estatísticas contra a norma.
 * → { globals: [...], parcels: [...], lobes: [...], flags: [...], available }
 * Parcelas dos brain charts são POR HEMISFÉRIO — cada hemisfério é comparado à mesma curva.
 */
export function compareToNorms (stats, { age, sex }) {
  if (!NORMS || !(sex === 'F' || sex === 'M') || !(age > 0)) return { available: false }
  const out = { available: true, age, sex, globals: [], parcels: [], lobes: [], flags: [] }

  for (const [pheno, pt, getter] of GLOBAL_MAP) {
    const v = getter(stats)
    if (v == null || v <= 0) continue
    const e = evaluate(pheno, sex, age, v)
    if (e) out.globals.push({ pheno, pt, value: v, ...e })
  }

  // parcelas DKT (quando o passo DKT foi aplicado): compara cada hemisfério
  const parcelRows = stats.rows.filter(r => r.group === 'cortex' && /^ctx-(lh|rh)-/.test(r.name) && r.volMm3 > 0)
  for (const r of parcelRows) {
    const base = r.name.replace(/^ctx-(lh|rh)-/, '')
    if (!NORMS.fenotipos[base]) continue
    const e = evaluate(base, sex, age, r.volMm3)
    if (e) out.parcels.push({ pheno: base, pt: r.ptName, hemi: r.hemi, value: r.volMm3, ...e })
  }

  // lobos: volume por hemisfério (soma das parcelas) contra soma dos momentos das
  // normas (aproximação gaussiana por independência — apenas z, sem percentil fino)
  const lobeParcels = {}
  for (const r of parcelRows) {
    const base = r.name.replace(/^ctx-(lh|rh)-/, '')
    const lobe = lobeOfBase(base)
    if (!lobe) continue
    const key = lobe + '|' + r.hemi
    lobeParcels[key] = lobeParcels[key] || { vol: 0, mean: 0, varSum: 0, n: 0 }
    lobeParcels[key].vol += r.volMm3
    const eRow = NORMS.fenotipos[base] ? interpRow(NORMS.fenotipos[base][sex], age) : null
    if (eRow) { lobeParcels[key].mean += eRow.mean; lobeParcels[key].varSum += eRow.sd * eRow.sd; lobeParcels[key].n++ }
  }
  for (const key of Object.keys(lobeParcels).sort()) {
    const [lobe, hemi] = key.split('|')
    const L = lobeParcels[key]
    const sd = Math.sqrt(L.varSum)
    const z = L.n > 0 && sd > 0 ? (L.vol - L.mean) / sd : null
    out.lobes.push({
      lobe,
      pt: (LOBE_PT_TOTAL[lobe] || lobe) + (hemi === 'E' ? ' — esquerdo' : ' — direito'),
      hemi,
      value: L.vol,
      mean: L.n ? L.mean : null,
      z,
      percentile: z != null ? Math.min(99.9, Math.max(0.1, pnorm(z) * 100)) : null,
      flag: z != null && Math.abs(z) >= 4 ? 'erro?' : z != null && Math.abs(z) >= 3 ? 'atipico' : null
    })
  }

  for (const item of [...out.globals, ...out.parcels, ...out.lobes]) {
    if (item.flag) out.flags.push(item)
  }
  out.flags.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  return out
}

function pnorm (z) {
  // CDF normal padrão (Abramowitz-Stegun 7.1.26 via erf)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

// lobo de cada parcela DKT (Desikan-Killiany)
const LOBE_OF = {
  frontalpole: 'frontal', superiorfrontal: 'frontal', rostralmiddlefrontal: 'frontal',
  caudalmiddlefrontal: 'frontal', parsopercularis: 'frontal', parsorbitalis: 'frontal',
  parstriangularis: 'frontal', lateralorbitofrontal: 'frontal', medialorbitofrontal: 'frontal',
  precentral: 'frontal', paracentral: 'frontal',
  superiorparietal: 'parietal', inferiorparietal: 'parietal', supramarginal: 'parietal',
  postcentral: 'parietal', precuneus: 'parietal',
  superiortemporal: 'temporal', middletemporal: 'temporal', inferiortemporal: 'temporal',
  bankssts: 'temporal', fusiform: 'temporal', transversetemporal: 'temporal',
  entorhinal: 'temporal', temporalpole: 'temporal', parahippocampal: 'temporal',
  lateraloccipital: 'occipital', lingual: 'occipital', cuneus: 'occipital', pericalcarine: 'occipital',
  rostralanteriorcingulate: 'cíngulo', caudalanteriorcingulate: 'cíngulo',
  posteriorcingulate: 'cíngulo', isthmuscingulate: 'cíngulo',
  insula: 'ínsula'
}
function lobeOfBase (base) { return LOBE_OF[base] || null }
