// segqc.js — controle de qualidade automático da segmentação, por grupo tecidual.
//
// O SynthSeg 2.0 traz um regressor CNN de QC que prediz o Dice esperado por grupo
// tecidual (Billot et al., PNAS 2023). Os pesos desse regressor são distribuídos à
// parte (OneDrive da UCL / instalação do FreeSurfer) e não acompanham este projeto;
// quando você os instalar, o worker do SynthSeg 2.0 os usa e a proveniência passa a
// dizer "regressor SynthSeg 2.0".
//
// Sem eles, este módulo calcula um QC PRÓPRIO, determinístico e verificável, nos
// MESMOS 9 grupos teciduais e com os MESMOS nomes do regressor oficial (extraídos de
// data/labels_classes_priors/synthseg_qc_{labels,names}_2.0.npy), de modo que a
// tabela tenha a mesma forma do synthseg.qc.csv. São três componentes independentes,
// todos em [0,1] e todos reportados separadamente para permitir calibração:
//
//   confianca  média da posterior máxima da rede nos voxels do grupo (a incerteza
//              do próprio modelo — sai de graça da softmax que já calculamos)
//   coesao     fração dos voxels de cada estrutura que está no seu maior componente
//              conexo (6-vizinhança), agregada ao grupo por volume — mede
//              fragmentação/ilhas espúrias
//   simetria   1 − excesso de assimetria E/D do grupo (|IA| até 10% não penaliza;
//              40% zera) — só para grupos bilaterais
//
//   escore = confianca × coesao × simetria  (multiplicativo: uma falha derruba tudo)
//
// ATENÇÃO: o escore NÃO é o Dice predito do regressor oficial — é outra grandeza, em
// outra escala. O corte 0,65 do artigo é uma referência de partida; calibre o seu na
// sua própria coorte usando os três componentes, que vão separados no CSV/JSON.

/** os 9 grupos do regressor de QC do SynthSeg 2.0, na ordem oficial */
export const QC_GROUPS = [
  { id: 0, key: 'background', pt: 'fundo', curto: 'fundo' },
  { id: 1, key: 'general white matter', pt: 'substância branca (com caudado, acumbens, DC ventral)', curto: 'subst. branca' },
  { id: 2, key: 'general grey matter', pt: 'substância cinzenta cortical', curto: 'córtex' },
  { id: 3, key: 'general csf', pt: 'liquor (ventrículos)', curto: 'liquor' },
  { id: 4, key: 'cerebellum', pt: 'cerebelo', curto: 'cerebelo' },
  { id: 5, key: 'brainstem', pt: 'tronco encefálico', curto: 'tronco' },
  { id: 6, key: 'thalamus', pt: 'tálamo', curto: 'tálamo' },
  { id: 7, key: 'putamen+pallidum', pt: 'putâmen e pálido', curto: 'putâmen+pálido' },
  { id: 8, key: 'hippocampus+amygdala', pt: 'hipocampo e amígdala', curto: 'hipocampo+amígdala' }
]

/** grupos com contraparte E/D (o tronco e o liquor mediano não entram na simetria) */
const BILATERAL = new Set([1, 2, 4, 6, 7, 8])

/**
 * Grupo de QC de um rótulo, pelo NOME (vale para os espaços SynthSeg, aseg e DKT).
 * Segue o mapeamento de synthseg_qc_labels_2.0.npy: caudado, acumbens e DC ventral
 * caem em "substância branca"; o rótulo CSF (24) fica no fundo, como no oficial.
 * @returns {number} id do grupo, ou -1 se o rótulo não entra no QC
 */
export function qcGroupOfName (name) {
  if (!name || /^(fundo|background|Unknown)$/i.test(name)) return -1
  if (/Cerebellum/i.test(name)) return 4
  if (/Brain-?Stem/i.test(name)) return 5
  if (/Thalamus/i.test(name)) return 6
  if (/Putamen|Pallidum/i.test(name)) return 7
  if (/Hippocampus|Amygdala/i.test(name)) return 8
  if (/Lateral-Ventricle|Inf-Lat-Vent|3rd-Ventricle|4th-Ventricle|choroid/i.test(name)) return 3
  if (/^ctx-(lh|rh)-/.test(name) || /Cerebral-Cortex/i.test(name)) return 2
  if (/Cerebral-White-Matter|Caudate|Accumbens|VentralDC/i.test(name)) return 1
  return -1
}

/** lado do rótulo: 1 = esquerdo, 2 = direito, 0 = mediano/indefinido */
export function sideOfName (name) {
  if (/^Left-|^ctx-lh-|-lh-/.test(name)) return 1
  if (/^Right-|^ctx-rh-|-rh-/.test(name)) return 2
  return 0
}

/**
 * Fração de voxels de cada rótulo que está no seu maior componente conexo
 * (6-vizinhança), sem alocar máscara por estrutura: os voxels são agrupados por
 * rótulo numa passada e a busca em largura usa `seg[vizinho] === rotulo`.
 * @returns {Map<number, {total:number, largest:number}>}
 */
export function componentCohesion (seg, dims) {
  const [nx, ny, nz] = dims
  const nxy = nx * ny
  const n = seg.length
  // baldes de voxels por rótulo (uma passada, sem alocar por estrutura)
  const counts = new Map()
  for (let v = 0; v < n; v++) {
    const s = seg[v]
    if (!s) continue
    counts.set(s, (counts.get(s) || 0) + 1)
  }
  const starts = new Map()
  let off = 0
  for (const [s, c] of counts) { starts.set(s, off); off += c }
  const bucket = new Int32Array(off)
  const cursor = new Map(starts)
  for (let v = 0; v < n; v++) {
    const s = seg[v]
    if (!s) continue
    const p = cursor.get(s)
    bucket[p] = v
    cursor.set(s, p + 1)
  }
  // busca em largura com carimbo (evita limpar o vetor de visitados por estrutura);
  // Int16 basta porque o carimbo é o próprio rótulo (0–255) e cabe em 33 MB num 256³
  const stamp = new Int16Array(n).fill(-1)
  const stack = new Int32Array(off)
  const out = new Map()
  for (const [s, total] of counts) {
    const from = starts.get(s)
    let largest = 0
    for (let b = 0; b < total; b++) {
      const seed = bucket[from + b]
      if (stamp[seed] === s) continue
      let sp = 0
      stack[sp++] = seed
      stamp[seed] = s
      let size = 0
      while (sp > 0) {
        const v = stack[--sp]
        size++
        const x = v % nx, y = ((v / nx) | 0) % ny, z = (v / nxy) | 0
        if (x > 0 && seg[v - 1] === s && stamp[v - 1] !== s) { stamp[v - 1] = s; stack[sp++] = v - 1 }
        if (x < nx - 1 && seg[v + 1] === s && stamp[v + 1] !== s) { stamp[v + 1] = s; stack[sp++] = v + 1 }
        if (y > 0 && seg[v - nx] === s && stamp[v - nx] !== s) { stamp[v - nx] = s; stack[sp++] = v - nx }
        if (y < ny - 1 && seg[v + nx] === s && stamp[v + nx] !== s) { stamp[v + nx] = s; stack[sp++] = v + nx }
        if (z > 0 && seg[v - nxy] === s && stamp[v - nxy] !== s) { stamp[v - nxy] = s; stack[sp++] = v - nxy }
        if (z < nz - 1 && seg[v + nxy] === s && stamp[v + nxy] !== s) { stamp[v + nxy] = s; stack[sp++] = v + nxy }
      }
      if (size > largest) largest = size
    }
    out.set(s, { total, largest })
  }
  return out
}

/** penalidade de assimetria: |IA| ≤ 10% não penaliza; 40% zera */
function symmetryScore (left, right) {
  const soma = left + right
  if (soma <= 0) return 1
  const ia = Math.abs(left - right) / soma
  return Math.max(0, Math.min(1, 1 - Math.max(0, ia - 0.10) / 0.30))
}

/**
 * QC por grupo tecidual e por estrutura.
 * @param {Uint8Array} seg mapa de rótulos (índices do espaço de `labelsMap`)
 * @param {Uint8Array|null} conf posterior máxima por voxel, 0–255 (do worker); se
 *        ausente, o componente de confiança vale 1 e é marcado como indisponível
 * @param {number[]} dims
 * @param {Object<string,string>} labelsMap índice → nome
 * @param {number} voxVol mm³ por voxel
 * @returns {{grupos: Array, estruturas: Array, resumo: Object}}
 */
export function computeSegQC ({ seg, conf = null, dims, labelsMap, voxVol = 1 }) {
  const grupoDe = new Int8Array(256).fill(-1)
  const ladoDe = new Uint8Array(256)
  const nomeDe = {}
  for (const [idx, nome] of Object.entries(labelsMap || {})) {
    const i = +idx
    if (i < 0 || i > 255) continue
    grupoDe[i] = qcGroupOfName(nome)
    ladoDe[i] = sideOfName(nome)
    nomeDe[i] = nome
  }

  // acumuladores por grupo e por estrutura
  const g = QC_GROUPS.map(q => ({ ...q, vox: 0, confSum: 0, volE: 0, volD: 0, coesSum: 0 }))
  const perLabel = new Map()
  for (let v = 0; v < seg.length; v++) {
    const s = seg[v]
    if (!s) continue
    const gi = grupoDe[s]
    if (gi < 1) continue // fundo (0) e rótulos fora do QC (−1)
    const c = conf ? conf[v] / 255 : 1
    g[gi].vox++
    g[gi].confSum += c
    if (ladoDe[s] === 1) g[gi].volE++
    else if (ladoDe[s] === 2) g[gi].volD++
    let pl = perLabel.get(s)
    if (!pl) { pl = { vox: 0, confSum: 0 }; perLabel.set(s, pl) }
    pl.vox++
    pl.confSum += c
  }

  // coesão por estrutura → agregada ao grupo, ponderada por volume
  const coes = componentCohesion(seg, dims)
  const estruturas = []
  for (const [s, cc] of coes) {
    const gi = grupoDe[s]
    const pl = perLabel.get(s) || { vox: cc.total, confSum: cc.total }
    const coesao = cc.total ? cc.largest / cc.total : 1
    if (gi >= 1) g[gi].coesSum += coesao * cc.total
    estruturas.push({
      label: s,
      nome: nomeDe[s] || String(s),
      grupo: gi >= 0 ? QC_GROUPS[gi].key : null,
      voxels: cc.total,
      volume_mm3: +(cc.total * voxVol).toFixed(1),
      voxelsForaDoMaiorComponente: cc.total - cc.largest,
      coesao: +coesao.toFixed(4),
      confianca: +(pl.confSum / Math.max(1, pl.vox)).toFixed(4)
    })
  }
  estruturas.sort((a, b) => b.voxels - a.voxels)

  const temConf = !!conf
  const grupos = g.filter(q => q.id >= 1).map(q => {
    const confianca = q.vox ? q.confSum / q.vox : 0
    const coesao = q.vox ? q.coesSum / q.vox : 0
    const bil = BILATERAL.has(q.id) && (q.volE + q.volD) > 0
    const simetria = bil ? symmetryScore(q.volE, q.volD) : 1
    const escore = q.vox ? confianca * coesao * simetria : 0
    return {
      grupo: q.key,
      pt: q.pt,
      curto: q.curto,
      voxels: q.vox,
      volume_mm3: +(q.vox * voxVol).toFixed(1),
      confianca: +confianca.toFixed(4),
      coesao: +coesao.toFixed(4),
      simetria: bil ? +simetria.toFixed(4) : null,
      ia_pct: bil ? +(100 * (q.volE - q.volD) / (q.volE + q.volD)).toFixed(1) : null,
      escore: +escore.toFixed(4),
      alerta: q.vox > 0 && escore < 0.65
    }
  })

  const presentes = grupos.filter(q => q.voxels > 0)
  const resumo = {
    metodo: temConf
      ? 'QC próprio do SegmentaRM (confiança × coesão × simetria) nos 9 grupos teciduais do regressor do SynthSeg 2.0'
      : 'QC próprio do SegmentaRM (coesão × simetria; sem confiança da rede — modelo sem posteriores)',
    confiancaDisponivel: temConf,
    corteSugerido: 0.65,
    escoreMinimo: presentes.length ? +Math.min(...presentes.map(q => q.escore)).toFixed(4) : 0,
    escoreMedio: presentes.length ? +(presentes.reduce((a, q) => a + q.escore, 0) / presentes.length).toFixed(4) : 0,
    gruposEmAlerta: presentes.filter(q => q.alerta).map(q => q.grupo),
    ressalva: 'Escore próprio, NÃO é o Dice predito pelo regressor do SynthSeg 2.0. Calibre o corte na sua coorte usando os componentes.'
  }
  return { grupos, estruturas, resumo }
}

/** CSV do QC, na forma do synthseg.qc.csv (uma linha por exame, colunas por grupo) */
export function qcToCSV (qc, meta = {}, dec = '.') {
  const sep = dec === ',' ? ';' : ','
  const fmt = (v) => v == null ? '' : (dec === ',' ? String(v).replace('.', ',') : String(v))
  const cab = ['subject']
  const lin = [meta.subject || 'exame']
  for (const q of qc.grupos) {
    cab.push(`escore ${q.grupo}`, `confianca ${q.grupo}`, `coesao ${q.grupo}`, `simetria ${q.grupo}`)
    lin.push(fmt(q.escore), fmt(q.confianca), fmt(q.coesao), fmt(q.simetria))
  }
  cab.push('escore minimo', 'escore medio', 'grupos em alerta', 'metodo')
  lin.push(fmt(qc.resumo.escoreMinimo), fmt(qc.resumo.escoreMedio),
    '"' + qc.resumo.gruposEmAlerta.join('; ') + '"', '"' + qc.resumo.metodo + '"')
  return cab.join(sep) + '\r\n' + lin.join(sep) + '\r\n'
}
