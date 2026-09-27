// Comparação normativa ajustada por idade e sexo, a partir das curvas populacionais
// dos brain charts de Bethlehem et al. (Nature 2022) — modelos GAMLSS-GG oficiais do
// repositório github.com/brainchart/Lifespan, avaliados offline (efeitos fixos,
// versão-base do FreeSurfer) e vendorizados em models/normative/brainchart.json.
//
// Uso em pesquisa/QC, não clínico: as normas foram ajustadas em volumes FreeSurfer
// harmonizados; os volumes desta ferramenta vêm do SynthSeg/DKT — a comparação é
// aproximada. |z| ≥ 4 é tratado como possível ERRO DE SEGMENTAÇÃO (bandeira de QC).
//
// Estruturas subcorticais regionais (tálamo, caudado, putâmen, pálido, hipocampo, amígdala,
// accumbens — por hemisfério e sexo) usam outra fonte: CentileBrain / ENIGMA Lifespan
// (models/normative/subcortical.json; ver o bloco "normas subcorticais" mais abaixo).

let NORMS = null
let SUB = null // normas subcorticais regionais (CentileBrain) — ver loadSubcorticalNorms
let ERRO = null // erro de medida por estrutura (intervalo de 90% do z)

let NORMS_P = null
export function loadNorms (url = './models/normative/brainchart.json') {
  // uma carga só, compartilhada: chamadas simultâneas (idade, sexo e fim da segmentação
  // disparam a comparação ao mesmo tempo) esperam a mesma promessa, e NORMS só aparece
  // depois das normas subcorticais e do erro de medida — antes, uma segunda chamada podia
  // comparar com as normas globais já prontas e as subcorticais ainda carregando
  if (!NORMS_P) {
    NORMS_P = (async () => {
      const n = await (await fetch(url)).json()
      // as normas subcorticais são um complemento: se faltarem (offline sem cache, arquivo
      // ausente), a comparação global continua funcionando sem elas
      try { await loadSubcorticalNorms() } catch (e) { SUB = null }
      // erro de medida (intervalo de 90% do z): sem ele, o z sai sem intervalo
      try { const r = await fetch('./models/normative/erro_medida.json'); ERRO = r.ok !== false ? await r.json() : null } catch (e) { ERRO = null }
      NORMS = n
      return NORMS
    })().catch(e => { NORMS_P = null; throw e })
  }
  return NORMS_P
}

/** erro de medida carregado (models/normative/erro_medida.json) ou null */
export function erroMedida () { return ERRO }

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

// z de um valor contra quantis tabelados (q crescente, zq = Φ⁻¹(probs)): interpolação linear
// na escala probit; fora da tabela, continua a reta probit do intervalo da borda
function zFromQuantiles (q, zq, v) {
  const last = q.length - 1
  if (v <= q[0]) return zq[0] + (v - q[0]) * (zq[1] - zq[0]) / ((q[1] - q[0]) || 1)
  if (v >= q[last]) return zq[last] + (v - q[last]) * (zq[last] - zq[last - 1]) / ((q[last] - q[last - 1]) || 1)
  let j = 0
  while (v > q[j + 1]) j++
  const f = (v - q[j]) / ((q[j + 1] - q[j]) || 1)
  return zq[j] + f * (zq[j + 1] - zq[j])
}

function interpRow (tbl, age, ages = NORMS.idades) {
  const a = Math.max(ages[0], Math.min(ages[ages.length - 1], age))
  // busca o intervalo [ages[i0], ages[i0+1]] (não supõe passo de 1 ano nem início em 1)
  let i0 = 0
  while (i0 < ages.length - 2 && a > ages[i0 + 1]) i0++
  const span = ages[i0 + 1] - ages[i0]
  const t = span > 0 ? (a - ages[i0]) / span : 0
  const lerp = (x, y) => x + t * (y - x)
  const row = {
    q: tbl.q[i0].map((v, j) => lerp(v, tbl.q[i0 + 1][j])),
    mean: lerp(tbl.mean[i0], tbl.mean[i0 + 1]),
    sd: lerp(tbl.sd[i0], tbl.sd[i0 + 1])
  }
  if (tbl.mfpMean) row.mfpMean = lerp(tbl.mfpMean[i0], tbl.mfpMean[i0 + 1])
  return row
}

/**
 * Avalia um volume contra a norma. sex: 'F'|'M'; age em anos.
 * → { percentile (0.1–99.9, clampado), z, zGauss, median, flag: null|'atipico'|'erro?', foraDaFaixaEtaria }
 *
 * A tabela traz quantis da distribuição gama generalizada (GG) do GAMLSS em 13 probabilidades.
 * Entre quantis, a interpolação é linear na escala PROBIT (z = Φ⁻¹(p)), que é exata quando a
 * distribuição é localmente normal — a interpolação linear em p subestimava |z| nas caudas
 * (um z real de −3,0 saía −2,87 e perdia a bandeira). Fora da tabela (p < 0,001 ou
 * p > 0,999), o z continua a reta probit do último intervalo: contínuo e monótono. O z
 * gaussiano (média/DP) só é devolvido como informação — a GG dos ventrículos é muito
 * assimétrica e ele chegava a +6,6 logo acima do P99,9 (falso "erro?") e a −1,5 logo
 * abaixo do P0,1 (z menos extremo para volume menor).
 */
export function evaluate (pheno, sex, age, valueMm3) {
  if (!NORMS || !NORMS.fenotipos[pheno] || !(sex === 'F' || sex === 'M') || !(age > 0) || !isFinite(valueMm3)) return null
  const row = interpRow(NORMS.fenotipos[pheno][sex], age)
  const probs = NORMS.probs
  const q = row.q
  const z = zFromQuantiles(q, probs.map(qnorm), valueMm3)
  const pct = pnorm(z)
  const zGauss = row.sd > 0 ? (valueMm3 - row.mean) / row.sd : 0
  const az = Math.abs(z)
  const flag = az >= 4 ? 'erro?' : az >= 3 ? 'atipico' : null
  const ages = NORMS.idades
  return {
    percentile: Math.min(99.9, Math.max(0.1, pct * 100)),
    z, zGauss, median: q[probs.indexOf(0.5) >= 0 ? probs.indexOf(0.5) : Math.floor(probs.length / 2)], mean: row.mean, sd: row.sd, flag,
    foraDaFaixaEtaria: age < ages[0] || age > ages[ages.length - 1]
  }
}

// mapeia agregados do SegmentaRM → fenótipos dos brain charts
const GLOBAL_MAP = [
  ['GMV', 'Córtex cerebral total (GMV)', s => comp(s, 'CortexVol'), 'CortexVol'],
  ['WMV', 'Substância branca cerebral (WMV)', s => comp(s, 'CerebralWhiteMatterVol'), 'CerebralWhiteMatterVol'],
  ['sGMV', 'Cinzenta subcortical (sGMV)', s => comp(s, 'SubCortGrayVol'), 'SubCortGrayVol'],
  ['Ventricles', 'Ventrículos', s => comp(s, 'VentricleVol'), 'VentricleVol'],
  ['TCV', 'Cérebro total (GMV+WMV+sGMV)', s => {
    const a = comp(s, 'CortexVol'); const b = comp(s, 'CerebralWhiteMatterVol'); const c = comp(s, 'SubCortGrayVol')
    return (a == null && b == null) ? null : (a || 0) + (b || 0) + (c || 0)
  }, 'TCV']
]
function comp (stats, id) {
  const c = stats.composites.find(x => x.id === id)
  return c ? c.volMm3 : null
}

/**
 * Compara as estatísticas contra a norma.
 * → { globals, parcels, subcorticais, flags, multiplicidade, proveniencia, available }
 * Parcelas dos brain charts são POR HEMISFÉRIO — cada hemisfério é comparado à mesma curva.
 *
 * opts (todas opcionais):
 *   ferramentaPaciente  texto (ex.: 'SynthSeg 1.0 + parcelação DKT') — vai para a proveniência
 *   metodoVolume        'suave' | 'rígido'
 *   recentragem         models/normative/recentragem_synthseg.json (nível A): desconta do z o
 *                       deslocamento que controles saudáveis medidos com o MESMO método têm
 *                       contra esta norma, por idade e sexo; a incerteza entra no intervalo
 *   calibracao          calibração de sítio (nível C, lib/calibracao.js) aplicada ao z
 *   erroMedida          sobrepõe models/normative/erro_medida.json (null = sem intervalo)
 *
 * Cada z traz ic90 = [inf, sup]: intervalo de 90% que combina o erro de medida (teste-reteste;
 * entre scanners se o sítio não está calibrado), a incerteza da recentragem e a da calibração.
 * NÃO inclui a incerteza do próprio modelo normativo (não publicada em forma utilizável) nem o
 * viés do método quando a recentragem está desligada.
 *
 * Sem z por LOBO: não há norma lobar própria, e a soma de médias/DP de parcelas não é um
 * modelo (as medianas saíam iguais nos dois hemisférios porque as curvas regionais dos
 * brain charts são as mesmas para E e D). Os lobos ficam só com volume e % do VIC.
 */
export function compareToNorms (stats, { age, sex }, opts = {}) {
  if (!NORMS || !(sex === 'F' || sex === 'M') || !(age > 0)) return { available: false }
  const ages = NORMS.idades
  const out = {
    available: true, age, sex, globals: [], parcels: [], lobes: [], flags: [],
    // fora de [1, 100] anos a curva é a da borda (sem extrapolação) — sinalizar no laudo
    foraDaFaixaEtaria: age < ages[0] || age > ages[ages.length - 1]
  }
  const provBC = proveniencia('brainchart', age, opts)
  const ctx = { age, sex, opts }

  for (const [pheno, pt, getter, chave] of GLOBAL_MAP) {
    const v = getter(stats)
    if (v == null || v <= 0) continue
    const e = avaliarComAjustes(ctx, chave, v, (vv) => evaluate(pheno, sex, age, vv), (z) => volumeNoZ(NORMS.fenotipos[pheno][sex], NORMS.idades, NORMS.probs, age, z))
    // z em cinza também quando a idade está fora da faixa em que a recentragem foi ajustada
    if (e) out.globals.push({ pheno, pt, value: v, chave, familia: 'brainchart', extrapolacao: provBC.borda || !!(e.recentrado && e.recentrado.foraDaFaixa), ...e })
  }

  // parcelas DKT (quando o passo DKT foi aplicado): compara cada hemisfério
  const parcelRows = stats.rows.filter(r => r.group === 'cortex' && /^ctx-(lh|rh)-/.test(r.name) && r.volMm3 > 0)
  // Atlas DKT × normas DK: os brain charts foram ajustados no aparc DK (Desikan 2006),
  // que tem bankssts, frontalpole e temporalpole; o protocolo DKT (Klein & Tourville,
  // Front Neurosci 2012) eliminou essas 3 regiões e a cortiça delas foi "absorvida pelas
  // regiões adjacentes", sem proporção definida (as margens do STS ficam divididas pelo
  // fundo do sulco entre temporal superior e médio; os polos, entre os giros vizinhos).
  // As parcelas DK adjacentes que podem ter absorvido esse tecido ficam SEM z ("sem norma
  // comparável") — somar a norma inteira de uma região removida a UMA vizinha seria
  // inventar a partilha.
  const dkt = isDktParcellation(parcelRows)
  const semNorma = new Map() // base → regiões DK removidas que ela pode ter absorvido
  if (dkt.lh || dkt.rh) {
    for (const [removed, neighbors] of Object.entries(DKT_ABSORB)) {
      for (const nb of neighbors) semNorma.set(nb, [...(semNorma.get(nb) || []), removed])
    }
    out.parcelasSemNorma = []
    out.notaDKT = 'Parcelação DKT (Klein & Tourville 2012) comparada a normas DK: bankssts, frontalpole e ' +
      'temporalpole não existem no DKT e foram absorvidas pelas vizinhas, sem partilha definida — essas vizinhas ' +
      'ficam sem z. Sem z por lobo (não há norma lobar).'
  }
  for (const r of parcelRows) {
    const base = r.name.replace(/^ctx-(lh|rh)-/, '')
    if (!NORMS.fenotipos[base]) continue
    const hemiDkt = r.hemi === 'E' ? dkt.lh : r.hemi === 'D' ? dkt.rh : (dkt.lh || dkt.rh)
    if (hemiDkt && semNorma.has(base)) {
      out.parcelasSemNorma.push({
        pheno: base, pt: r.ptName, hemi: r.hemi, value: r.volMm3,
        motivo: `DKT absorveu ${semNorma.get(base).join(' + ')} (sem norma DK comparável)`
      })
      continue
    }
    const e = evaluate(base, sex, age, r.volMm3)
    if (e) out.parcels.push({ pheno: base, pt: r.ptName, hemi: r.hemi, value: r.volMm3, ...e })
  }

  // estruturas subcorticais regionais (CentileBrain), quando essas normas estão carregadas
  const sub = SUB ? compareSubcorticalToNorms(stats, { age, sex }, opts) : null
  if (sub && sub.available) {
    out.subcorticais = sub.estruturas
    out.subcorticalInfo = {
      fonte: sub.fonte, versao: sub.versao, licenca: sub.licenca, avisos: sub.avisos,
      faixaTreino: sub.faixaTreino, foraDaFaixaEtaria: sub.foraDaFaixaEtaria
    }
  }

  out.proveniencia = {
    brainchart: provBC,
    centilebrain: SUB ? proveniencia('centilebrain', age, opts, sex) : null,
    ferramentaPaciente: opts.ferramentaPaciente || null,
    metodoVolume: opts.metodoVolume || null,
    recentragem: opts.recentragem ? { fonte: opts.recentragem.fonte, fonteCurta: opts.recentragem.fonteCurta || null, versao: opts.recentragem.versao, faixa: opts.recentragem.idadeFaixa, n: opts.recentragem.n, dominio: opts.recentragem.dominio || null } : null,
    calibracao: opts.calibracao ? resumoCalibracao(opts.calibracao) : null
  }
  // multiplicidade: só as famílias exibidas no laudo (globais + subcorticais)
  out.multiplicidade = multiplicidade([...out.globals, ...(out.subcorticais || [])])

  // bandeiras só das famílias exibidas no laudo: o z por parcela DK (norma bilateral, atlas
  // DK × DKT) fica no JSON como exploratório e não dispara alerta
  for (const item of [...out.globals, ...(out.subcorticais || [])]) {
    if (item.flag) out.flags.push(item)
  }
  out.flags.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  return out
}

// ---------- proveniência, borda etária, recentragem pelo método, calibração, multiplicidade ----------

// idade a menos de BORDA_ANOS do limite da norma (ou além dele): z em cinza e "borda"
export const BORDA_ANOS = 5
// estruturas pré-especificadas (hipótese clínica comum: atrofia mesial temporal, núcleos da
// base, expansão ventricular) — destacadas mesmo sem correção de multiplicidade
export const PRE_ESPECIFICADAS = new Set(['Hippocampus', 'Amygdala', 'Thalamus', 'Putamen', 'Ventricles'])

function proveniencia (familia, age, opts, sex = null) {
  if (familia === 'brainchart') {
    const a = NORMS.idades
    const fx = [a[0], a[a.length - 1]]
    return {
      id: 'brainchart', norma: 'BrainChart (Bethlehem et al., Nature 2022)',
      ferramentaNorma: 'FreeSurfer (volumes de estudos harmonizados; majoritariamente 5.3–7)',
      faixa: fx, borda: age < fx[0] + BORDA_ANOS || age > fx[1] - BORDA_ANOS, fora: age < fx[0] || age > fx[1]
    }
  }
  const fxs = (SUB && SUB.faixaTreino) || {}
  const fx = (sex && fxs[sex]) || [SUB.idades[0], SUB.idades[SUB.idades.length - 1]]
  return {
    id: 'centilebrain', norma: 'CentileBrain (Ge et al., Lancet Digit Health 2024)',
    ferramentaNorma: 'FreeSurfer ≥ 5.0 (aseg), ComBat-GAM',
    faixa: fx, borda: age < fx[0] + BORDA_ANOS || age > fx[1] - BORDA_ANOS, fora: age < fx[0] || age > fx[1]
  }
}

/**
 * Recentragem pelo método (nível A). Controles saudáveis medidos com o MESMO método do paciente
 * (SynthSeg 1.0 do SegmentaRM, volume suave; tools/recentragem_dlbs.mjs) ficam, contra cada
 * norma, deslocados de m(t, sexo) = a + c·t + d·t² + e·[M] em z (t = idade − idadeRef); o z do
 * paciente é recentrado: z' = z − m. A escala do z continua a da norma.
 *
 * Por que não "traduzir o volume para a escala do FreeSurfer" (como pedia o plano): controles
 * saudáveis medidos pelo PRÓPRIO FreeSurfer (5.3 no DLBS; 6.0 no ds000001/ds000005) ficam de
 * 1,4 a 1,9 DP abaixo da GMV do BrainChart; acima dos 73 anos, a tradução daria córtex −1,6 e
 * hipocampo −0,9 em pessoas saudáveis. Recentrar contra a própria norma remove esse desvio.
 * Fora da faixa etária do ajuste, os termos de idade ficam na borda. ep = erro-padrão do
 * deslocamento (em z), pela covariância bootstrap de (a, c, d, e).
 */
export function recentragemZ (rec, chave, idade, sexo = null) {
  const e = rec && rec.estruturas && rec.estruturas[chave]
  if (!e) return null
  const ref = rec.idadeRef != null ? rec.idadeRef : 60
  const fx = rec.idadeFaixa || [0, 200]
  const id = idade > 0 ? idade : ref
  const t = Math.min(fx[1], Math.max(fx[0], id)) - ref
  const m = sexo === 'M' ? 1 : 0
  const g = [1, t, t * t, m]
  const desloc = e.a + (e.c || 0) * t + (e.d || 0) * t * t + (e.e || 0) * m
  let ep = null
  if (Array.isArray(e.cov)) {
    let v = 0
    for (let i = 0; i < e.cov.length; i++) for (let j = 0; j < e.cov.length; j++) v += g[i] * e.cov[i][j] * g[j]
    ep = Math.sqrt(Math.max(0, v))
  }
  return { desloc, ep, foraDaFaixa: id < fx[0] || id > fx[1] }
}

// volume em que a norma dá um certo z (inverso de zFromQuantiles: interpolação linear na escala
// probit entre os quantis tabelados; fora da tabela, a reta probit do intervalo da borda)
function volumeNoZ (tbl, ages, probs, age, z) {
  if (!tbl) return null
  const q = interpRow(tbl, age, ages).q
  const zq = probs.map(qnorm)
  const last = q.length - 1
  if (z <= zq[0]) return q[0] + (z - zq[0]) * (q[1] - q[0]) / ((zq[1] - zq[0]) || 1)
  if (z >= zq[last]) return q[last] + (z - zq[last]) * (q[last] - q[last - 1]) / ((zq[last] - zq[last - 1]) || 1)
  let j = 0
  while (z > zq[j + 1]) j++
  const f = (z - zq[j]) / ((zq[j + 1] - zq[j]) || 1)
  return q[j] + f * (q[j + 1] - q[j])
}

// inclinação local da norma em z por unidade de log(volume) (diferença central, ±1%)
function inclinacaoZ (avaliar, valor) {
  const h = 0.01
  const a = avaliar(valor * Math.exp(h)); const b = avaliar(valor * Math.exp(-h))
  return a && b ? (a.z - b.z) / (2 * h) : null
}

// erro de medida de uma estrutura em unidades de z (entre scanners se o sítio não está calibrado);
// dzdl = dz/d log V da norma no volume do paciente
function erroMedidaZ (erro, chave, entre, dzdl) {
  const e = erro && erro.estruturas && erro.estruturas[chave]
  if (!e) return null
  const f = erro.fatorEntreSemMedida || 1.77
  let z = null
  if (entre) {
    if (e.entrePct != null && dzdl != null) z = Math.abs(dzdl) * e.entrePct / 100
    else if (e.intraZ != null) z = e.intraZ * f
    else if (e.intraPct != null && dzdl != null) z = Math.abs(dzdl) * e.intraPct / 100 * f
  } else {
    if (e.intraZ != null) z = e.intraZ
    else if (e.intraPct != null && dzdl != null) z = Math.abs(dzdl) * e.intraPct / 100
  }
  return z == null ? null : { z, fonte: e.fonte, aproximado: !!e.aproximado }
}

const Z90 = 1.6448536269514722

// z com os ajustes pedidos: recentragem pelo método (nível A) e calibração de sítio (nível C),
// ambas no espaço do z; intervalo de 90% com as incertezas de medida, recentragem e calibração.
// volumeEmZ(z) → volume em que a norma dá esse z (mediana esperada para o método recentrado)
function avaliarComAjustes (ctx, chave, valor, avaliar, volumeEmZ = null) {
  const bruto = avaliar(valor)
  if (!bruto) return null
  const r = { ...bruto, zBruto: bruto.z, percentilBruto: bruto.percentile }
  let z = bruto.z
  let epRec = null
  const rc = ctx.opts.recentragem ? recentragemZ(ctx.opts.recentragem, chave, ctx.age, ctx.sex) : null
  if (rc) {
    z = bruto.z - rc.desloc
    epRec = rc.ep
    r.recentrado = { desloc: rc.desloc, ep: rc.ep, foraDaFaixa: rc.foraDaFaixa }
    // mediana ESPERADA para quem é medido com este método (z bruto = deslocamento)
    const mv = volumeEmZ ? volumeEmZ(rc.desloc) : null
    if (mv > 0) { r.medianaNorma = r.median; r.median = mv }
  }
  const cal = ctx.opts.calibracao && ctx.opts.calibracao.estruturas && ctx.opts.calibracao.estruturas[chave]
  let escala = 1
  let epCal = null
  if (cal && cal.n >= 10) {
    // escala só com n ≥ 30 e limitada a [0,5; 2] (um DP de controles fora disso é instável)
    escala = cal.n >= 30 && cal.dp > 0 ? Math.min(2, Math.max(0.5, cal.dp)) : 1
    r.calibrado = { n: cal.n, desloc: cal.media, escala, ep: cal.ep }
    z = (z - cal.media) / escala
    epCal = cal.ep != null ? cal.ep / escala : null
  }
  const az = Math.abs(z)
  r.z = z
  r.percentile = Math.min(99.9, Math.max(0.1, pnorm(z) * 100))
  r.flag = az >= 4 ? 'erro?' : az >= 3 ? 'atipico' : null

  // intervalo de 90%: componentes independentes somados em quadratura, em unidades de z
  const erro = ctx.opts.erroMedida !== undefined ? ctx.opts.erroMedida : ERRO
  const dzdl = inclinacaoZ(avaliar, valor)
  const med = erroMedidaZ(erro, chave, !r.calibrado, dzdl)
  const comp = {
    medida: med ? med.z / escala : null,
    recentragem: epRec != null ? epRec / escala : null,
    calibracao: epCal
  }
  if (comp.medida != null) {
    const s = Math.sqrt(Object.values(comp).reduce((a, v) => a + (v || 0) ** 2, 0))
    r.ic90 = [z - Z90 * s, z + Z90 * s]
    r.incerteza = { dp: s, ...comp, entreScanners: !r.calibrado, fonteMedida: med.fonte, aproximado: med.aproximado }
  }
  return r
}

/** selo de proveniência de uma família de normas: norma · ferramentas · recentragem · calibração · faixa */
export function seloNorma (prov, pv = {}) {
  if (!prov) return ''
  const cal = pv.calibracao ? `calibrado para o sítio (n = ${pv.calibracao.n})` : 'NÃO calibrado para este sítio'
  const tr = pv.recentragem ? `z recentrado por controles do mesmo método (nível A; ${pv.recentragem.fonteCurta || 'DLBS'}, n = ${pv.recentragem.n})` : 'sem recentragem pelo método'
  return `${prov.norma} · norma medida com ${prov.ferramentaNorma} · paciente: ${pv.ferramentaPaciente || '—'} (volume ${pv.metodoVolume || '—'}) · ${tr} · ${cal} · faixa da norma ${prov.faixa.map(v => v.toFixed(0)).join('–')} anos${prov.borda ? ' · idade na BORDA da norma (z instável)' : ''}`
}

function resumoCalibracao (c) {
  return { protocolo: c.protocolo || null, n: c.n || null, criada: c.criada || null, descricao: c.descricao || null }
}

/**
 * Multiplicidade: m testes → número esperado de |z| > 2 por acaso (m·0,0455), observado,
 * correção de Holm (α = 5%, p bicaudal) e sinal predominante dos desvios.
 */
export function multiplicidade (itens, alpha = 0.05) {
  const vs = itens.filter(it => it && it.z != null && isFinite(it.z))
  const m = vs.length
  for (const it of vs) {
    it.pValor = Math.min(1, 2 * (1 - pnorm(Math.abs(it.z))))
    it.holm = false
    it.preEspecificada = PRE_ESPECIFICADAS.has(it.pheno)
  }
  const ord = vs.slice().sort((a, b) => a.pValor - b.pValor)
  for (let k = 0; k < ord.length; k++) {
    if (ord[k].pValor <= alpha / (m - k)) ord[k].holm = true
    else break
  }
  const acima = vs.filter(it => Math.abs(it.z) > 2)
  const pos = vs.filter(it => it.z > 0).length
  return {
    m,
    esperadoAbs2: m * 2 * (1 - pnorm(2)),
    observadoAbs2: acima.length,
    holmSignificativos: vs.filter(it => it.holm).length,
    fracPositivos: m ? pos / m : null,
    zMedio: m ? vs.reduce((a, it) => a + it.z, 0) / m : null
  }
}

/** percentil sem falsa precisão: inteiro entre 1 e 99; nas caudas, "< 1", "< 0,1", "> 99", "> 99,9" */
export function formatPercentil (p) {
  if (p == null || !isFinite(p)) return '—'
  if (p < 0.1) return '< 0,1'
  if (p < 1) return '< 1'
  if (p > 99.9) return '> 99,9'
  if (p > 99) return '> 99'
  return String(Math.round(p))
}

// ---------- normas subcorticais regionais (CentileBrain / ENIGMA Lifespan) ----------
//
// Fonte: modelos oficiais do CentileBrain (ENIGMA Lifespan Working Group; Ge et al., Lancet
// Digit Health 2024;6:e211–e221, doi:10.1016/S2589-7500(23)00250-9), repositório
// github.com/CentileBrain/centilebrain — sucessor com modelos publicados do trabalho de Dima
// et al. (Hum Brain Mapp 2022;43:452–469), cujas tabelas de centis (suplemento S6–S9) não
// foram acessíveis e, de todo modo, são de volumes ajustados por ICV relativo à média de
// cada sítio (inaplicáveis a um exame isolado).
//
// Conteúdo de models/normative/subcortical.json (gerado por tools/extract_centilebrain_subcortical.R):
// para tálamo, caudado, putâmen, pálido, hipocampo, amígdala e accumbens, por HEMISFÉRIO
// (L/R) e SEXO (F/M), os quantis em 13 probabilidades nas idades inteiras 3–90 do modelo
// LMS/GAMLSS do CentileBrain (Box-Cox BCCGo/BCPEo/BCTo com mu, sigma, nu[, tau] suavizados
// por P-splines da idade; heteroscedástico e assimétrico) + média prevista e RMSE do modelo
// MFPR só com idade (o escore de desvio publicado pelo CentileBrain, z = (y − ŷ)/RMSE,
// homoscedástico — devolvido como zMFPR, só para comparação).
//
// Unidade: mm³ de volumes BRUTOS (sem normalização por ICV). O CentileBrain também publica
// modelos MFPR com ICV linear, mas os objetos disponíveis, alimentados com ICV em mm³ (como
// pede o template deles), preveem ~45–60% dos volumes típicos — escala de ICV do treino não
// documentada; por isso não são usados e a norma aqui NÃO aceita ICV: o z inclui o efeito
// do tamanho da cabeça.
//
// Faixa etária: treino 3,17–90,06 anos (F) e 3,42–90,0 anos (M); a grade vai de 3 a 90 e,
// fora dela, a curva é a da borda (sem extrapolação da idade) com foraDaFaixaEtaria = true.
// Fora de P0,1–P99,9 o z continua a reta probit do último intervalo (como nas normas globais).

let SUB_ZQ = null
const SUB_BASE = {
  Thalamus: 'Thalamus', 'Thalamus-Proper': 'Thalamus', Caudate: 'Caudate', Putamen: 'Putamen',
  Pallidum: 'Pallidum', Hippocampus: 'Hippocampus', Amygdala: 'Amygdala',
  'Accumbens-area': 'Accumbens-area', Accumbens: 'Accumbens-area'
}
const SUB_PT = {
  Thalamus: 'Tálamo', Caudate: 'Núcleo caudado', Putamen: 'Putâmen', Pallidum: 'Globo pálido',
  Hippocampus: 'Hipocampo', Amygdala: 'Amígdala', 'Accumbens-area': 'Núcleo accumbens'
}
const SUB_AVISOS = [
  'Normas de volumes FreeSurfer aseg (≥ 5.0) de controles saudáveis harmonizados por ComBat-GAM; ' +
    'volumes de SynthSeg ou de outras ferramentas diferem sistematicamente, por estrutura, do aseg — ' +
    'o z pode ter viés (idealmente, calibre com controles do mesmo protocolo e da mesma ferramenta).',
  'Sem ajuste por volume intracraniano: o z inclui o efeito do tamanho da cabeça.',
  'O treino excluiu valores além de 1,5×IQR: a distribuição de referência é levemente estreitada ' +
    '(DP ≈ 3% menor se normal) e |z| muito altos tendem a ser um pouco superestimados.',
  'Exame isolado não passa pela harmonização de sítio usada no treino: diferenças de scanner/protocolo não são corrigidas.'
]

/** Carrega as normas subcorticais (URL do JSON ou o próprio objeto já lido). */
export async function loadSubcorticalNorms (src = './models/normative/subcortical.json') {
  if (SUB) return SUB
  const data = typeof src === 'string' ? await (await fetch(src)).json() : src
  if (!data || !data.estruturas || !Array.isArray(data.idades) || !Array.isArray(data.probs)) {
    throw new Error('normas subcorticais inválidas')
  }
  SUB = data
  SUB_ZQ = data.probs.map(qnorm)
  return SUB
}

export function subcorticalNormsLoaded () { return !!SUB }

function subBaseOf (name) {
  const s = String(name).replace(/^(Left|Right)-/, '').replace(/\*$/, '')
  return SUB_BASE[s] || null
}
function subHemiOf (h) {
  if (h === 'E' || h === 'L' || h === 'lh' || h === 'Left') return 'L'
  if (h === 'D' || h === 'R' || h === 'rh' || h === 'Right') return 'R'
  return null
}

/**
 * Avalia o volume (mm³) de uma estrutura subcortical contra a norma do CentileBrain.
 * structure: nome-base FreeSurfer ('Hippocampus', 'Thalamus'/'Thalamus-Proper', 'Accumbens-area', …,
 * com ou sem prefixo Left-/Right-); hemi: 'E'|'D' (ou 'L'|'R'); sex: 'F'|'M'; age em anos.
 * → { percentile, z, zGauss, zMFPR, median, p5, p95, mean, sd, flag, foraDaFaixaEtaria, fonte } | null
 */
export function evaluateSubcortical (structure, hemi, sex, age, valueMm3) {
  if (!SUB || !(sex === 'F' || sex === 'M') || !(age > 0) || !isFinite(valueMm3)) return null
  const base = subBaseOf(structure)
  const h = subHemiOf(hemi) || (/^Left-/.test(structure) ? 'L' : /^Right-/.test(structure) ? 'R' : null)
  const tbl = base && h && SUB.estruturas[base] && SUB.estruturas[base][h] && SUB.estruturas[base][h][sex]
  if (!tbl) return null
  const row = interpRow(tbl, age, SUB.idades)
  const z = zFromQuantiles(row.q, SUB_ZQ, valueMm3)
  const qAt = p => { const i = SUB.probs.indexOf(p); return i >= 0 ? row.q[i] : null }
  const az = Math.abs(z)
  const ages = SUB.idades
  const fx = (SUB.faixaTreino && SUB.faixaTreino[sex]) || [ages[0], ages[ages.length - 1]]
  return {
    percentile: Math.min(99.9, Math.max(0.1, pnorm(z) * 100)),
    z,
    zGauss: row.sd > 0 ? (valueMm3 - row.mean) / row.sd : 0,
    zMFPR: tbl.mfpRmse > 0 && row.mfpMean != null ? (valueMm3 - row.mfpMean) / tbl.mfpRmse : null,
    median: qAt(0.5), p5: qAt(0.05), p95: qAt(0.95), mean: row.mean, sd: row.sd,
    flag: az >= 4 ? 'erro?' : az >= 3 ? 'atipico' : null,
    foraDaFaixaEtaria: age < fx[0] || age > fx[1],
    fonte: 'CentileBrain'
  }
}

/**
 * Compara as estruturas subcorticais das estatísticas (linhas Left-/Right-Thalamus[-Proper],
 * -Caudate, -Putamen, -Pallidum, -Hippocampus, -Amygdala, -Accumbens-area) com as normas.
 * → { available, age, sex, estruturas: [{ pheno, pt, hemi, value, ...evaluateSubcortical }], flags,
 *     foraDaFaixaEtaria, faixaTreino, fonte, versao, licenca, avisos }
 */
export function compareSubcorticalToNorms (stats, { age, sex }, opts = {}) {
  if (!SUB || !stats || !(sex === 'F' || sex === 'M') || !(age > 0)) return { available: false }
  const fx = (SUB.faixaTreino && SUB.faixaTreino[sex]) || [SUB.idades[0], SUB.idades[SUB.idades.length - 1]]
  const out = {
    available: true, age, sex, estruturas: [], flags: [],
    foraDaFaixaEtaria: age < fx[0] || age > fx[1], faixaTreino: fx,
    borda: age < fx[0] + BORDA_ANOS || age > fx[1] - BORDA_ANOS,
    fonte: SUB.fonte, versao: SUB.versao, licenca: SUB.licenca, avisos: SUB_AVISOS
  }
  for (const r of stats.rows || []) {
    if (!(r.volMm3 > 0)) continue
    const m = /^(Left|Right)-(.+)$/.exec(r.name)
    if (!m) continue
    const base = subBaseOf(m[2])
    if (!base) continue
    const hemi = m[1] === 'Left' ? 'E' : 'D'
    const chave = `${m[1]}-${base}`
    const tblSub = SUB.estruturas[base] && SUB.estruturas[base][hemi === 'E' ? 'L' : 'R'] && SUB.estruturas[base][hemi === 'E' ? 'L' : 'R'][sex]
    const e = avaliarComAjustes({ age, sex, opts }, chave, r.volMm3, (vv) => evaluateSubcortical(base, hemi, sex, age, vv), (z) => volumeNoZ(tblSub, SUB.idades, SUB.probs, age, z))
    if (!e) continue
    out.estruturas.push({
      pheno: base, pt: r.ptName || `${SUB_PT[base]} — ${hemi === 'E' ? 'esquerdo' : 'direito'}`,
      hemi, value: r.volMm3, chave, familia: 'centilebrain', extrapolacao: out.borda || !!(e.recentrado && e.recentrado.foraDaFaixa), ...e
    })
  }
  for (const it of out.estruturas) if (it.flag) out.flags.push(it)
  out.flags.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  return out
}

export function pnorm (z) {
  // CDF normal padrão (Abramowitz-Stegun 7.1.26 via erf, |erro| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2)
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}


// regiões DK eliminadas no DKT → parcelas DK adjacentes que podem ter absorvido o tecido
// (adjacência no atlas DK; o protocolo DKT só diz "absorvido pelas regiões adjacentes")
const DKT_ABSORB = {
  bankssts: ['superiortemporal', 'middletemporal', 'inferiorparietal', 'supramarginal'],
  frontalpole: ['superiorfrontal', 'rostralmiddlefrontal', 'medialorbitofrontal', 'lateralorbitofrontal'],
  temporalpole: ['superiortemporal', 'middletemporal', 'inferiortemporal', 'entorhinal']
}

// DKT por hemisfério: nenhuma das 3 regiões DK-only com volume, mas parcelas corticais
// presentes (≥ 20 das 31 do DKT) — no DK (rede 104 do brainchop) elas existem
function isDktParcellation (parcelRows) {
  const res = {}
  for (const [key, hemi] of [['lh', 'E'], ['rh', 'D']]) {
    const rows = parcelRows.filter(r => r.hemi === hemi)
    const bases = new Set(rows.map(r => r.name.replace(/^ctx-(lh|rh)-/, '')))
    res[key] = rows.length >= 20 && !Object.keys(DKT_ABSORB).some(b => bases.has(b))
  }
  return res
}
