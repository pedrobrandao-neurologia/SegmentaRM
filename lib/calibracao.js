// Calibração de sítio (nível C do plano metodológico): controles saudáveis examinados no
// MESMO equipamento e protocolo do paciente, processados pelo próprio SegmentaRM, estimam
// por estrutura o deslocamento (média) e a escala (DP) do z em relação à norma. Aplicação:
//   n ≥ 30  → z' = (z − média) / DP     (deslocamento + escala)
//   10–29   → z' =  z − média           (só deslocamento; a escala com n pequeno é instável)
//   n < 10  → não aplica                (com 10 controles a estimativa já é pouco confiável —
//                                         Alyas et al., arXiv 2025; ≥ 30 recomendados)
// Controles de OUTRO equipamento não servem (o deslocamento não se transfere). Tudo roda no
// navegador: a calibração guarda só estatísticas agregadas (n, média, DP, IC), nunca volumes
// individuais, e pode ser exportada/importada como JSON para outro computador do serviço.

import { compareToNorms } from './normative.js'

export const N_MIN_DESLOCAMENTO = 10
export const N_MIN_ESCALA = 30
const CHAVE_LS = 'segmentarm_calibracoes_v1'

const sane = (s) => String(s).replace(/\*/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
// (cornos temporais, ventrículos laterais, cerebelo e tronco só têm norma nas normas próprias)
const SUB = ['Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area', 'Inf-Lat-Vent', 'Lateral-Ventricle']
const GLOB = ['CortexVol', 'CerebralWhiteMatterVol', 'SubCortGrayVol', 'VentricleVol', 'CerebellumVol', 'BrainStemVol']

// linha larga da coorte (statsToWideRow) → estatísticas mínimas para a comparação normativa
export function statsDeLinha (row) {
  const composites = GLOB.filter(id => row[id] > 0).map(id => ({ id, volMm3: +row[id] }))
  const rows = []
  for (const lado of ['Left', 'Right']) {
    for (const b of SUB) {
      const nome = `${lado}-${b}`
      const v = row[sane(nome)]
      if (v > 0) rows.push({ name: nome, volMm3: +v, group: 'subcortical', hemi: lado === 'Left' ? 'E' : 'D' })
    }
  }
  return { composites, rows }
}

// PRNG determinístico (mulberry32): o bootstrap dá o mesmo IC em qualquer máquina
function prng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function resumo (zs, idades) {
  const n = zs.length
  const media = zs.reduce((a, v) => a + v, 0) / n
  const dp = n > 1 ? Math.sqrt(zs.reduce((a, v) => a + (v - media) ** 2, 0) / (n - 1)) : null
  const ep = dp != null ? dp / Math.sqrt(n) : null
  // IC 90% da média por bootstrap (2000 reamostragens, semente fixa)
  const rnd = prng(20260927 + n)
  const ms = []
  for (let b = 0; b < 2000; b++) {
    let s = 0
    for (let i = 0; i < n; i++) s += zs[Math.floor(rnd() * n)]
    ms.push(s / n)
  }
  ms.sort((x, y) => x - y)
  const ic90 = [ms[Math.floor(0.05 * ms.length)], ms[Math.floor(0.95 * ms.length)]]
  // dependência da idade (heterocedasticidade/deriva): correlação de Pearson z × idade
  let r = null
  if (n >= 5) {
    const ma = idades.reduce((a, v) => a + v, 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < n; i++) { sxy += (idades[i] - ma) * (zs[i] - media); sxx += (idades[i] - ma) ** 2; syy += (zs[i] - media) ** 2 }
    r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
  }
  return { n, media, dp, ep, ic90, corrIdade: r }
}

/**
 * @param linhas     linhas da coorte (row de statsToWideRow) marcadas como controle, do mesmo protocolo
 * @param opts       { protocolo: {familia, familiaTxt}, recentragem (o mesmo modo usado nos pacientes) }
 * @returns calibração { protocolo, familiaTxt, n, criada, comRecentragem, estruturas: {chave: resumo}, avisos }
 */
export function calcularCalibracao (linhas, { protocolo = null, recentragem = null, metodo = null, normasProprias = null } = {}) {
  // com as normas próprias, a calibração é contra ELAS (a recentragem não se aplica)
  if (normasProprias) recentragem = null
  const porChave = {}
  const idadesPorChave = {}
  const porSexo = {} // chave → { F: [z], M: [z] }: o deslocamento do sítio pode depender do sexo
  let usados = 0
  for (const row of linhas) {
    const idade = +row.idade
    const sexo = row.sexo
    if (!(idade > 0) || !(sexo === 'F' || sexo === 'M')) continue
    const n = compareToNorms(statsDeLinha(row), { age: idade, sex: sexo }, { recentragem, normasProprias, vic: +row.eTIV > 0 ? +row.eTIV : null })
    if (!n || !n.available) continue
    usados++
    for (const it of [...n.globals, ...(n.subcorticais || [])]) {
      if (it.z == null || !isFinite(it.z) || !it.chave) continue
      ;(porChave[it.chave] = porChave[it.chave] || []).push(it.z)
      ;(idadesPorChave[it.chave] = idadesPorChave[it.chave] || []).push(idade)
      ;((porSexo[it.chave] = porSexo[it.chave] || { F: [], M: [] })[sexo]).push(it.z)
    }
  }
  const estruturas = {}
  const avisos = []
  for (const [k, zs] of Object.entries(porChave)) {
    if (zs.length < 2) continue
    estruturas[k] = resumo(zs, idadesPorChave[k])
    const e = estruturas[k]
    if (e.corrIdade != null && Math.abs(e.corrIdade) > 0.3 && e.n >= 20) avisos.push(`${k}: o desvio dos controles varia com a idade (r = ${e.corrIdade.toFixed(2)}) — um deslocamento único não corrige bem todas as idades.`)
    // dependência do sexo: diferença das médias F − M (com ≥ 5 controles de cada sexo)
    const ps = porSexo[k]
    if (ps.F.length >= 5 && ps.M.length >= 5) {
      const m = (a) => a.reduce((x, v) => x + v, 0) / a.length
      e.difSexo = m(ps.F) - m(ps.M)
      if (Math.abs(e.difSexo) > 0.5) avisos.push(`${k}: o desvio dos controles difere entre os sexos (F − M = ${e.difSexo.toFixed(2)} z) — um deslocamento único não corrige bem os dois.`)
    }
  }
  if (usados < N_MIN_DESLOCAMENTO) avisos.push(`Só ${usados} controle(s) com idade e sexo: a calibração só é aplicada com ≥ ${N_MIN_DESLOCAMENTO} (deslocamento) e ≥ ${N_MIN_ESCALA} (escala).`)
  else if (usados < N_MIN_ESCALA) avisos.push(`${usados} controles: aplica-se só o deslocamento; a escala exige ≥ ${N_MIN_ESCALA}.`)
  return {
    versao: 1,
    protocolo: protocolo ? protocolo.familia : null,
    familiaTxt: protocolo ? protocolo.familiaTxt : null,
    // o deslocamento do sítio é do MÉTODO (rede + convenção de volume): não vale para outro
    metodo,
    n: usados,
    criada: new Date().toISOString().slice(0, 10),
    comRecentragem: !!recentragem,
    // a calibração feita com uma recentragem só vale para ELA (coeficientes novos mudam os z)
    recentragemId: idRecentragem(recentragem),
    // idem para as normas próprias: outra versão dos coeficientes, outra calibração
    normasPropriasId: idRecentragem(normasProprias),
    estruturas,
    avisos
  }
}

/**
 * método de medida de uma linha/exame: família da rede + convenção de volume. Controles medidos
 * com outro método não entram na calibração, e a calibração de um método não vale para outro.
 */
export function metodoDe (modelo, metodoVolume) {
  const m = String(modelo || '')
  const rede = /SynthSeg/i.test(m) ? 'synthseg' : /FastSurfer/i.test(m) ? 'fastsurfer' : (m.split(/[\s·+(]/)[0] || '?').toLowerCase()
  return rede + '/' + (metodoVolume || '?')
}

const chaveDe = (familia, metodo, comRecentragem, comProprias = false) => familia + '|' + (metodo || '?') + (comProprias ? '|np' : comRecentragem ? '|rc' : '')

/** identidade de uma recentragem ou das normas próprias (versão + n + data): calibrações só valem para a mesma */
export function idRecentragem (rec) {
  return rec ? [rec.versao || '?', rec.n || '?', rec.gerado || ''].join('/') : null
}

export function lerCalibracoes () {
  try { return JSON.parse(localStorage.getItem(CHAVE_LS) || '{}') } catch { return {} }
}

export function salvarCalibracao (cal) {
  const todas = lerCalibracoes()
  todas[chaveDe(cal.protocolo, cal.metodo, cal.comRecentragem, !!cal.normasPropriasId)] = cal
  try { localStorage.setItem(CHAVE_LS, JSON.stringify(todas)) } catch { /* modo privado */ }
  return todas
}

/**
 * calibração válida para o protocolo e o modo do exame atual, ou null. recentragem: o objeto ativo
 * (ou null); uma calibração feita com outra recentragem (outra versão dos coeficientes) não vale.
 */
export function calibracaoPara (familia, recentragem = null, metodo = null, normasProprias = null) {
  if (!familia) return null
  if (normasProprias) recentragem = null
  const c = lerCalibracoes()[chaveDe(familia, metodo, !!recentragem, !!normasProprias)]
  if (!c || !(c.n >= N_MIN_DESLOCAMENTO)) return null
  if (recentragem && c.recentragemId !== idRecentragem(recentragem)) return null
  if (normasProprias && c.normasPropriasId !== idRecentragem(normasProprias)) return null
  return c
}

/** há calibração deste protocolo feita com OUTRA recentragem (ou outra versão das normas próprias)? */
export function calibracaoDesatualizada (familia, recentragem, metodo = null, normasProprias = null) {
  if (!familia) return false
  if (normasProprias) {
    const c = lerCalibracoes()[chaveDe(familia, metodo, false, true)]
    return !!(c && c.normasPropriasId !== idRecentragem(normasProprias))
  }
  if (!recentragem) return false
  const c = lerCalibracoes()[chaveDe(familia, metodo, true)]
  return !!(c && c.recentragemId !== idRecentragem(recentragem))
}

/** importa um JSON exportado (uma calibração ou o mapa inteiro); só estatísticas agregadas */
export function importarCalibracoes (obj) {
  const lista = obj && obj.estruturas ? [obj] : Object.values(obj || {})
  let k = 0
  for (const c of lista) {
    if (!c || !c.protocolo || !c.estruturas || !(c.n > 0)) continue
    salvarCalibracao(c)
    k++
  }
  return k
}
