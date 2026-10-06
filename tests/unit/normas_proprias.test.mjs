// Normas próprias do SegmentaRM (models/normative/normas_segmentarm.json): z SHASHo em forma
// fechada contra o R, mediana e inverso, substituição de BrainChart/CentileBrain sem recentragem,
// variância do sítio no IC enquanto o sítio não está calibrado e calibração com chave própria.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as N from '../../lib/normative.js'
import { calcularCalibracao, salvarCalibracao, calibracaoPara, calibracaoDesatualizada } from '../../lib/calibracao.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ler = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'))
globalThis.fetch = async (u) => ({ ok: true, json: async () => ler(String(u).replace(/^\.\//, '')) })
const mem = {}
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v) } }
await N.loadNorms()

// normas sintéticas: μ constante, σ crescente com a idade, SHASHo assimétrica
const IDADES = Array.from({ length: 73 }, (_, i) => 18 + i)
const fen = (mu0, s0, nu, tau, sig) => ({
  familia: 'SHASHo', nu, tau, sigmaSitio: sig, n: 600, nSitios: 12, excluidos: 0, faixa: [18, 89],
  nPorDecada: { '[18,30)': 120, '[30,40)': 60, '[40,50)': 60, '[50,60)': 120, '[60,70)': 120, '[70,80)': 100, '[80,90)': 20, '[90,200)': 0 },
  F: { mu: IDADES.map(() => mu0), sigma: IDADES.map(a => s0 * (1 + (a - 18) / 200)) },
  M: { mu: IDADES.map(() => mu0 + 0.1), sigma: IDADES.map(a => s0 * (1 + (a - 18) / 200)) },
  epMuZ: { F: IDADES.map(a => a < 80 ? 0.05 : 0.2), M: IDADES.map(a => a < 80 ? 0.05 : 0.2) }
})
const NP = {
  versao: 'teste', gerado: '2026-10-03', n: 600, nSitios: 12, idades: IDADES, faixa: [18, 89],
  fenotipos: { CortexVol: fen(Math.log(5e5), 0.07, 0.2, 1.3, 0.05), 'Left-Hippocampus': fen(Math.log(4000), 0.09, -0.1, 0.9, 0.04), 'Left-Inf-Lat-Vent': fen(Math.log(500), 0.5, 0.3, 1, 0.15) }
}

test('z SHASHo em forma fechada, mediana e inverso exatos', () => {
  const v = 4.6e5
  const e = N.avaliarProprio(NP, 'CortexVol', 'F', 50, v)
  const s = 0.07 * (1 + 32 / 200)
  const zr = Math.sinh(1.3 * Math.asinh((Math.log(v) - Math.log(5e5)) / s) - 0.2)
  assert.ok(Math.abs(e.z - zr) < 1e-12)
  assert.ok(Math.abs(N.avaliarProprio(NP, 'CortexVol', 'F', 50, e.median).z) < 1e-9, 'mediana dá z = 0')
  assert.ok(Math.abs(e.percentile - 100 * N.pnorm(zr)) < 1e-9)
  // idade entre pontos da grade: interpolação linear de μ e σ
  const e2 = N.avaliarProprio(NP, 'CortexVol', 'M', 50.5, v)
  const s2 = 0.07 * (1 + 32.5 / 200)
  assert.ok(Math.abs(e2.z - Math.sinh(1.3 * Math.asinh((Math.log(v) - Math.log(5e5) - 0.1) / s2) - 0.2)) < 1e-9)
  // poucos controles na década (80s: 20 < 30) → borda
  assert.equal(N.avaliarProprio(NP, 'CortexVol', 'F', 84, v).borda, true)
  assert.equal(N.avaliarProprio(NP, 'CortexVol', 'F', 64, v).borda, false)
  // década com controles suficientes mas de menos de 3 sítios → borda também
  const NPs = { ...NP, fenotipos: { CortexVol: { ...NP.fenotipos.CortexVol, sitiosPorDecada: { '[60,70)': 2, '[50,60)': 5 } } } }
  assert.equal(N.avaliarProprio(NPs, 'CortexVol', 'F', 64, v).borda, true)
  assert.equal(N.avaliarProprio(NPs, 'CortexVol', 'F', 55, v).borda, false)
  assert.equal(N.avaliarProprio(NP, 'Nada', 'F', 64, v), null)
})

test('com as normas próprias: substituem BrainChart/CentileBrain, sem recentragem, sítio no IC', () => {
  const stats = {
    composites: [{ id: 'CortexVol', volMm3: 4.6e5 }],
    rows: [{ name: 'Left-Hippocampus', volMm3: 3600, group: 'subcortical', hemi: 'E' }, { name: 'Left-Inf-Lat-Vent', volMm3: 900, group: 'ventrículos', hemi: 'E' }]
  }
  const rec = ler('models/normative/recentragem_synthseg.json')
  const n = N.compareToNorms(stats, { age: 60, sex: 'F' }, { normasProprias: NP, recentragem: rec })
  const ctx = n.globals.find(g => g.chave === 'CortexVol')
  assert.equal(ctx.familia, 'segmentarm')
  assert.equal(ctx.recentrado, undefined, 'a recentragem não se aplica às normas próprias')
  assert.ok(Math.abs(ctx.z - N.avaliarProprio(NP, 'CortexVol', 'F', 60, 4.6e5).z) < 1e-12)
  assert.ok(ctx.incerteza.sitio > 0 && ctx.incerteza.curva > 0, 'sem calibração, σ_sítio e o erro da curva entram no IC')
  assert.equal(ctx.incerteza.entreScanners, false, 'o erro de medida entra como teste-reteste (o sítio já cobre o entre scanners)')
  // σ_sítio em z ≈ σ_sítio / σ (perto da mediana, dz/dlnV ≈ τ·cosh(ν)/σ)
  const s = 0.07 * (1 + 42 / 200)
  assert.ok(Math.abs(ctx.incerteza.sitio - 0.05 * 1.3 * Math.cosh(1.3 * Math.asinh((Math.log(4.6e5) - Math.log(5e5)) / s) - 0.2) / Math.sqrt(1 + ((Math.log(4.6e5) - Math.log(5e5)) / s) ** 2) / s) < 0.01)
  // ventrículo extra (sem norma no CentileBrain) entra nas subcorticais
  assert.ok(n.subcorticais.find(r => r.chave === 'Left-Inf-Lat-Vent'))
  assert.ok(n.proveniencia.segmentarm && !n.proveniencia.centilebrain && !n.proveniencia.recentragem)
  assert.match(N.seloNorma(n.proveniencia.segmentarm, n.proveniencia), /Normas SegmentaRM.*NÃO calibrado.*variância entre sítios/)
  // com calibração (n ≥ 30): o sítio é estimado — sai do IC
  const cal = { n: 40, estruturas: { CortexVol: { n: 40, media: 0.3, dp: 1, ep: 0.16 } } }
  const c = N.compareToNorms(stats, { age: 60, sex: 'F' }, { normasProprias: NP, calibracao: cal }).globals.find(g => g.chave === 'CortexVol')
  assert.ok(Math.abs(c.z - (ctx.z - 0.3)) < 1e-9)
  assert.equal(c.incerteza.sitio, null)
  assert.ok(Math.abs(N.avaliarProprio(NP, 'CortexVol', 'F', 60, c.median).z - 0.3) < 1e-9, 'mediana calibrada dá z final 0')
})

test('calibração contra as normas próprias tem chave própria', () => {
  const linhas = Array.from({ length: 12 }, (_, i) => ({ idade: 50 + i, sexo: i % 2 ? 'M' : 'F', CortexVol: 4.8e5 + 1000 * i, Left_Hippocampus: 3800 }))
  const cal = calcularCalibracao(linhas, { protocolo: { familia: 'np1', familiaTxt: 't' }, metodo: 'synthseg/suave', normasProprias: NP })
  assert.ok(cal.estruturas.CortexVol && cal.estruturas['Left-Hippocampus'])
  salvarCalibracao(cal)
  assert.ok(calibracaoPara('np1', null, 'synthseg/suave', NP))
  assert.equal(calibracaoPara('np1', null, 'synthseg/suave'), null, 'não vale para BrainChart')
  const NP2 = { ...NP, versao: 'outra' }
  assert.equal(calibracaoPara('np1', null, 'synthseg/suave', NP2), null, 'outra versão das normas, outra calibração')
  assert.equal(calibracaoDesatualizada('np1', null, 'synthseg/suave', NP2), true)
})

const REAL = path.join(RAIZ, 'models/normative/normas_segmentarm.json')
test('normas embarcadas contra o z exato do R (pSHASHo)', { skip: !fs.existsSync(REAL) }, () => {
  const np = ler('models/normative/normas_segmentarm.json')
  const fx = ler('tests/fixtures/normas_segmentarm_exato_R.json')
  let pior = 0
  for (const e of fx) pior = Math.max(pior, Math.abs(N.avaliarProprio(np, e.fen, e.sexo, e.idade, e.v).z - e.z))
  assert.ok(pior < 1e-6, `|Δz| máx ${pior}`)
  // todas as medidas do app têm norma
  for (const k of ['CortexVol', 'CerebralWhiteMatterVol', 'SubCortGrayVol', 'VentricleVol', 'TCV', 'Left-Hippocampus', 'Right-Hippocampus', 'vic']) assert.ok(np.fenotipos[k], k)
})

test('normas próprias nos relatórios: CSV, planilha larga, JSON e PDF', { skip: !fs.existsSync(REAL) }, async () => {
  const { statsToCSV, statsToWideRow, statsToJSON } = await import('../../lib/stats.js')
  const { buildReport } = await import('../../lib/report.js')
  const np = ler('models/normative/normas_segmentarm.json')
  const r = (name, v, group, hemi) => ({ name, ptName: name, volMm3: v, group, hemi, pctBrain: 0.3, meanInt: 90, index: 1 })
  const stats = {
    rows: [r('Left-Hippocampus', 3600, 'subcortical', 'E'), r('Right-Hippocampus', 3900, 'subcortical', 'D'),
      r('Left-Inf-Lat-Vent', 900, 'ventrículos', 'E'), r('Right-Inf-Lat-Vent', 600, 'ventrículos', 'D')],
    composites: [{ id: 'CortexVol', ptName: 'Córtex', volMm3: 470e3, pctBrain: 40 }, { id: 'CerebralWhiteMatterVol', ptName: 'SB', volMm3: 430e3, pctBrain: 35 }, { id: 'VentricleVol', ptName: 'Ventrículos', volMm3: 40e3, pctBrain: 3 }],
    lobes: [], pairs: [], brainVol: 1.2e6, hemiMethod: 'rótulos', volumeSoft: true
  }
  const norms = N.compareToNorms(stats, { age: 72, sex: 'F' }, { ferramentaPaciente: 'SynthSeg 1.0', metodoVolume: 'suave', normasProprias: np, vic: 1.45e6 })
  const meta = { subject: 't', age: 72, sex: 'F', date: '2026-10-06', norms, icv: { vic_mm3: 1.45e6 }, caveats: [] }
  // CSV por exame: norma, z, percentil, IC e mediana esperada nas linhas com norma
  const campos = (l) => [...l.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map(m => m[1].replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1)
  const csv = statsToCSV(stats, meta).replace(/^\uFEFF/, '').split('\r\n').filter(Boolean).map(campos)
  const H = csv[0]; const lin = (rot) => csv.find(c => c[H.indexOf('rotulo')] === rot)
  const hip = lin('Left-Hippocampus')
  assert.equal(hip[H.indexOf('norma')], 'SegmentaRM')
  assert.ok(Math.abs(+hip[H.indexOf('z')] - norms.subcorticais.find(x => x.chave === 'Left-Hippocampus').z) < 0.006)
  assert.ok(+hip[H.indexOf('ic90_z_inf')] < +hip[H.indexOf('z')] && +hip[H.indexOf('mediana_esperada_mm3')] > 0)
  assert.ok(lin('TCV')[H.indexOf('z')] !== '' && lin('eTIV')[H.indexOf('norma')] === 'SegmentaRM')
  // planilha larga da coorte: z, percentil e IC por medida + norma usada
  const { row } = statsToWideRow(stats, meta)
  assert.equal(row.norma_referencia, 'SegmentaRM')
  assert.ok(isFinite(row.z_Left_Hippocampus) && isFinite(row.pct_TCV) && isFinite(row.z_vic) && isFinite(row.zinf_CortexVol))
  // JSON: referência e notas da norma própria
  const js = JSON.parse(statsToJSON(stats, meta))
  assert.match(js.normativo.referencia, /Normas SegmentaRM/)
  assert.match(js.normativo.nota_normas_proprias, /sinh/)
  // PDF: destaques normativos na capa e texto do "Como ler" das normas próprias
  const buf = Buffer.from(await buildReport({ stats, meta, snapshot: null }))
  if (process.env.SALVAR_PDF_NP) fs.writeFileSync(process.env.SALVAR_PDF_NP, buf)
  const t = buf.toString('latin1')
  for (const frase of ['Destaques normativos', 'Normas SegmentaRM', 'mesmo SynthSeg']) assert.ok(t.includes(frase), `laudo sem "${frase}"`)
})
