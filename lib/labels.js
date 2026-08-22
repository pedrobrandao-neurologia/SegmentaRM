// Base de conhecimento sobre os rótulos dos modelos brainchop:
// nomes em português, hemisfério, grupo anatômico, lobo (Desikan) e pares contralaterais.
// Os modelos devolvem índices sequenciais; o labels.json de cada modelo dá o nome canônico
// (convenção FreeSurfer), e tudo aqui é indexado por esse nome.

const PT = {
  'BG': 'Fundo', 'Unknown': 'Fundo',
  'Cerebral-White-Matter': 'Substância branca cerebral',
  'Cerebral-Cortex': 'Córtex cerebral',
  'Ventricle': 'Ventrículos',
  'Lateral-Ventricle': 'Ventrículo lateral',
  'Inferior-Lateral-Ventricle': 'Corno temporal do ventrículo lateral',
  'Inf-Lat-Vent': 'Corno temporal do ventrículo lateral',
  'Cerebellum-White-Matter': 'Substância branca cerebelar',
  'Cerebellum-Cortex': 'Córtex cerebelar',
  'Cerebellum': 'Cerebelo',
  'Thalamus': 'Tálamo', 'Thalamus-Proper*': 'Tálamo', 'Thalamus-Proper': 'Tálamo',
  'Caudate': 'Núcleo caudado',
  'Putamen': 'Putâmen',
  'Pallidum': 'Globo pálido',
  '3rd-Ventricle': 'Terceiro ventrículo',
  '4th-Ventricle': 'Quarto ventrículo',
  'Brain-Stem': 'Tronco encefálico',
  'Hippocampus': 'Hipocampo',
  'Amygdala': 'Amígdala',
  'Accumbens-area': 'Núcleo accumbens',
  'VentralDC': 'Diencéfalo ventral',
  'CSF': 'Líquor extraventricular',
  'Corpus callosum': 'Corpo caloso',
  'CC_Posterior': 'Corpo caloso — posterior (esplênio)',
  'CC_Mid_Posterior': 'Corpo caloso — médio-posterior',
  'CC_Central': 'Corpo caloso — central',
  'CC_Mid_Anterior': 'Corpo caloso — médio-anterior',
  'CC_Anterior': 'Corpo caloso — anterior (joelho)',
  'White Matter': 'Substância branca',
  'Grey Matter': 'Substância cinzenta',
  'Gray Matter': 'Substância cinzenta',
  'Brain': 'Encéfalo (máscara)',
  // parcelas corticais (Desikan-Killiany)
  'bankssts': 'Margens do sulco temporal superior',
  'caudalanteriorcingulate': 'Cíngulo anterior caudal',
  'caudalmiddlefrontal': 'Frontal médio caudal',
  'cuneus': 'Cúneo',
  'entorhinal': 'Córtex entorrinal',
  'fusiform': 'Giro fusiforme',
  'inferiorparietal': 'Parietal inferior',
  'inferiortemporal': 'Temporal inferior',
  'isthmuscingulate': 'Istmo do cíngulo',
  'lateraloccipital': 'Occipital lateral',
  'lateralorbitofrontal': 'Orbitofrontal lateral',
  'lingual': 'Giro lingual',
  'medialorbitofrontal': 'Orbitofrontal medial',
  'middletemporal': 'Temporal médio',
  'parahippocampal': 'Giro para-hipocampal',
  'paracentral': 'Lóbulo paracentral',
  'parsopercularis': 'Pars opercular',
  'parsorbitalis': 'Pars orbital',
  'parstriangularis': 'Pars triangular',
  'pericalcarine': 'Córtex pericalcarino',
  'postcentral': 'Giro pós-central',
  'posteriorcingulate': 'Cíngulo posterior',
  'precentral': 'Giro pré-central',
  'precuneus': 'Pré-cúneo',
  'rostralanteriorcingulate': 'Cíngulo anterior rostral',
  'rostralmiddlefrontal': 'Frontal médio rostral',
  'superiorfrontal': 'Frontal superior',
  'superiorparietal': 'Parietal superior',
  'superiortemporal': 'Temporal superior',
  'supramarginal': 'Giro supramarginal',
  'frontalpole': 'Polo frontal',
  'temporalpole': 'Polo temporal',
  'transversetemporal': 'Temporal transverso (Heschl)',
  'insula': 'Ínsula'
}

// lobo de cada parcela Desikan-Killiany
const LOBE = {
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

const LOBE_PT = { frontal: 'Lobo frontal', parietal: 'Lobo parietal', temporal: 'Lobo temporal', occipital: 'Lobo occipital', 'cíngulo': 'Cíngulo', 'ínsula': 'Ínsula' }

// decompõe um nome canônico em { hemi: 'E'|'D'|null, base, cortical: bool, dkt: nome da parcela | null }
export function parseLabelName (raw) {
  let name = String(raw).trim()
  let hemi = null
  let m
  if ((m = name.match(/^ctx-lh-(.+)$/)) || (m = name.match(/^Left-ctx-(.+)$/))) { hemi = 'E'; name = 'ctx:' + m[1] }
  else if ((m = name.match(/^ctx-rh-(.+)$/)) || (m = name.match(/^Right-ctx-(.+)$/))) { hemi = 'D'; name = 'ctx:' + m[1] }
  else if ((m = name.match(/^ctx-(.+)$/))) { name = 'ctx:' + m[1] }
  else if ((m = name.match(/^Left-(.+)$/)) || (m = name.match(/^lh[-.](.+)$/))) { hemi = 'E'; name = m[1] }
  else if ((m = name.match(/^Right-(.+)$/)) || (m = name.match(/^rh[-.](.+)$/))) { hemi = 'D'; name = m[1] }
  const cortical = name.startsWith('ctx:')
  const base = cortical ? name.slice(4) : name
  return { hemi, base, cortical, dkt: cortical && LOBE[base] ? base : null }
}

export function groupOf (raw) {
  const { base, cortical } = parseLabelName(raw)
  if (cortical) return 'cortex'
  if (/^CC_|^Corpus callosum$/.test(base)) return 'caloso'
  if (/Cerebellum/.test(base)) return 'cerebelo'
  if (/^Brain-Stem$/.test(base)) return 'tronco'
  if (/Ventricle|Inf-Lat-Vent/.test(base)) return 'ventrículos'
  if (/^CSF$/.test(base)) return 'líquor'
  if (/White-Matter|^White Matter$/.test(base)) return 'substância branca'
  if (/Cerebral-Cortex|Grey Matter|Gray Matter/.test(base)) return 'córtex'
  if (/^(BG|Unknown|Fundo)$/i.test(base)) return 'fundo'
  if (/Thalamus|Caudate|Putamen|Pallidum|Hippocampus|Amygdala|Accumbens|VentralDC/.test(base)) return 'subcortical'
  return 'outros'
}

export const GROUP_PT = {
  cortex: 'Córtex por região', 'córtex': 'Córtex', subcortical: 'Estruturas subcorticais',
  cerebelo: 'Cerebelo', tronco: 'Tronco encefálico', 'ventrículos': 'Ventrículos',
  caloso: 'Corpo caloso', 'líquor': 'Líquor', 'substância branca': 'Substância branca',
  fundo: 'Fundo', outros: 'Outros'
}

export function ptNameOf (raw) {
  const { hemi, base, cortical } = parseLabelName(raw)
  const clean = base.replace(/\*$/, '')
  const pt = (cortical ? PT[clean] : PT[clean] || PT[base]) || clean
  if (hemi === 'E') return pt + ' — esquerdo'
  if (hemi === 'D') return pt + ' — direito'
  return pt
}

export function lobeOf (raw) {
  const { dkt } = parseLabelName(raw)
  return dkt ? LOBE[dkt] : null
}

export { LOBE_PT }
