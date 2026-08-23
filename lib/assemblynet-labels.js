// Rótulos do AssemblyNet (volBrain): protocolo BrainColor / Neuromorphometrics,
// 133 rótulos (códigos 0–207) — usados pelo modo de importação da segmentação
// produzida pelo Docker oficial volbrain/assemblynet (a licença deles proíbe
// redistribuir a rede; a segmentação do próprio usuário pode ser importada).
// Convenção cortical: código par = direito, ímpar = esquerdo.

const SUB = {
  4: ['3rd-Ventricle', 'Terceiro ventrículo'],
  11: ['4th-Ventricle', 'Quarto ventrículo'],
  23: ['Right-Accumbens-area', null], 30: ['Left-Accumbens-area', null],
  31: ['Right-Amygdala', null], 32: ['Left-Amygdala', null],
  35: ['Brain-Stem', 'Tronco encefálico'],
  36: ['Right-Caudate', null], 37: ['Left-Caudate', null],
  38: ['Right-Cerebellum-Exterior', 'Cerebelo (exterior) — direito'],
  39: ['Left-Cerebellum-Exterior', 'Cerebelo (exterior) — esquerdo'],
  40: ['Right-Cerebellum-White-Matter', null], 41: ['Left-Cerebellum-White-Matter', null],
  44: ['Right-Cerebral-White-Matter', null], 45: ['Left-Cerebral-White-Matter', null],
  47: ['Right-Hippocampus', null], 48: ['Left-Hippocampus', null],
  49: ['Right-Inf-Lat-Vent', null], 50: ['Left-Inf-Lat-Vent', null],
  51: ['Right-Lateral-Ventricle', null], 52: ['Left-Lateral-Ventricle', null],
  55: ['Right-Pallidum', null], 56: ['Left-Pallidum', null],
  57: ['Right-Putamen', null], 58: ['Left-Putamen', null],
  59: ['Right-Thalamus', null], 60: ['Left-Thalamus', null],
  61: ['Right-VentralDC', null], 62: ['Left-VentralDC', null],
  71: ['Cerebellar-Vermal-Lobules-I-V', 'Vermis cerebelar — lóbulos I–V'],
  72: ['Cerebellar-Vermal-Lobules-VI-VII', 'Vermis cerebelar — lóbulos VI–VII'],
  73: ['Cerebellar-Vermal-Lobules-VIII-X', 'Vermis cerebelar — lóbulos VIII–X'],
  75: ['Left-Basal-Forebrain', 'Prosencéfalo basal — esquerdo'],
  76: ['Right-Basal-Forebrain', 'Prosencéfalo basal — direito']
}

// pares corticais: código direito (par) → [sufixo canônico, nome em português]
const CTX = {
  100: ['ACgG-anterior-cingulate-gyrus', 'Giro do cíngulo anterior'],
  102: ['AIns-anterior-insula', 'Ínsula anterior'],
  104: ['AOrG-anterior-orbital-gyrus', 'Giro orbital anterior'],
  106: ['AnG-angular-gyrus', 'Giro angular'],
  108: ['Calc-calcarine-cortex', 'Córtex calcarino'],
  112: ['CO-central-operculum', 'Opérculo central'],
  114: ['Cun-cuneus', 'Cúneo'],
  116: ['Ent-entorhinal-area', 'Área entorrinal'],
  118: ['FO-frontal-operculum', 'Opérculo frontal'],
  120: ['FRP-frontal-pole', 'Polo frontal'],
  122: ['FuG-fusiform-gyrus', 'Giro fusiforme'],
  124: ['GRe-gyrus-rectus', 'Giro reto'],
  128: ['IOG-inferior-occipital-gyrus', 'Giro occipital inferior'],
  132: ['ITG-inferior-temporal-gyrus', 'Giro temporal inferior'],
  134: ['LiG-lingual-gyrus', 'Giro lingual'],
  136: ['LOrG-lateral-orbital-gyrus', 'Giro orbital lateral'],
  138: ['MCgG-middle-cingulate-gyrus', 'Giro do cíngulo médio'],
  140: ['MFC-medial-frontal-cortex', 'Córtex frontal medial'],
  142: ['MFG-middle-frontal-gyrus', 'Giro frontal médio'],
  144: ['MOG-middle-occipital-gyrus', 'Giro occipital médio'],
  146: ['MOrG-medial-orbital-gyrus', 'Giro orbital medial'],
  148: ['MPoG-postcentral-gyrus-medial-segment', 'Giro pós-central — segmento medial'],
  150: ['MPrG-precentral-gyrus-medial-segment', 'Giro pré-central — segmento medial'],
  152: ['MSFG-superior-frontal-gyrus-medial-segment', 'Giro frontal superior — segmento medial'],
  154: ['MTG-middle-temporal-gyrus', 'Giro temporal médio'],
  156: ['OCP-occipital-pole', 'Polo occipital'],
  160: ['OFuG-occipital-fusiform-gyrus', 'Giro fusiforme occipital'],
  162: ['OpIFG-opercular-part-inferior-frontal-gyrus', 'Giro frontal inferior — pars opercular'],
  164: ['OrIFG-orbital-part-inferior-frontal-gyrus', 'Giro frontal inferior — pars orbital'],
  166: ['PCgG-posterior-cingulate-gyrus', 'Giro do cíngulo posterior'],
  168: ['PCu-precuneus', 'Pré-cúneo'],
  170: ['PHG-parahippocampal-gyrus', 'Giro para-hipocampal'],
  172: ['PIns-posterior-insula', 'Ínsula posterior'],
  174: ['PO-parietal-operculum', 'Opérculo parietal'],
  176: ['PoG-postcentral-gyrus', 'Giro pós-central'],
  178: ['POrG-posterior-orbital-gyrus', 'Giro orbital posterior'],
  180: ['PP-planum-polare', 'Planum polare'],
  182: ['PrG-precentral-gyrus', 'Giro pré-central'],
  184: ['PT-planum-temporale', 'Planum temporale'],
  186: ['SCA-subcallosal-area', 'Área subcalosa'],
  190: ['SFG-superior-frontal-gyrus', 'Giro frontal superior'],
  192: ['SMC-supplementary-motor-cortex', 'Córtex motor suplementar'],
  194: ['SMG-supramarginal-gyrus', 'Giro supramarginal'],
  196: ['SOG-superior-occipital-gyrus', 'Giro occipital superior'],
  198: ['SPL-superior-parietal-lobule', 'Lóbulo parietal superior'],
  200: ['STG-superior-temporal-gyrus', 'Giro temporal superior'],
  202: ['TMP-temporal-pole', 'Polo temporal'],
  204: ['TrIFG-triangular-part-inferior-frontal-gyrus', 'Giro frontal inferior — pars triangular'],
  206: ['TTG-transverse-temporal-gyrus', 'Giro temporal transverso (Heschl)']
}

// mapa código → nome canônico (estilo FreeSurfer, para o parser de hemisférios)
export function assemblynetLabels () {
  const out = { 0: 'BG' }
  for (const [code, [name]] of Object.entries(SUB)) out[code] = name
  for (const [codeR, [suffix]] of Object.entries(CTX)) {
    out[codeR] = 'Right-' + suffix
    out[+codeR + 1] = 'Left-' + suffix
  }
  return out
}

// nomes em português explícitos (os demais caem no dicionário geral de labels.js)
export function assemblynetPt () {
  const out = {}
  for (const [code, [, pt]] of Object.entries(SUB)) if (pt) out[code] = pt
  for (const [codeR, [, pt]] of Object.entries(CTX)) {
    out[codeR] = pt + ' — direito'
    out[+codeR + 1] = pt + ' — esquerdo'
  }
  return out
}

// colormap estável: mesmo matiz para o par E/D (como o FreeSurfer faz por estrutura)
export function assemblynetColormap () {
  const labels = assemblynetLabels()
  const codes = Object.keys(labels).map(Number).sort((a, b) => a - b)
  const R = [], G = [], B = [], I = [], names = []
  const golden = 0.61803398875
  const hueOf = (base) => {
    let h = 0
    for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0
    return ((h * golden) % 1)
  }
  for (const code of codes) {
    const name = labels[code]
    if (code === 0) { R.push(0); G.push(0); B.push(0); I.push(0); names.push(name); continue }
    const base = name.replace(/^Left-|^Right-/, '')
    const h = hueOf(base)
    const isCortex = code >= 100
    const s = isCortex ? 0.62 : 0.75
    const l = isCortex ? 0.58 : 0.45
    const [r, g, b] = hslToRgb(h, s, l)
    R.push(r); G.push(g); B.push(b); I.push(code); names.push(name)
  }
  return { R, G, B, I, labels: names }
}

function hslToRgb (h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}
