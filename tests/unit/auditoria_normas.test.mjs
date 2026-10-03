// Correções da auditoria da camada normativa (out/2026): definição do TCV, caudas e idades
// pediátricas contra a CDF exata do R, par de assimetria do córtex com DKT, percentis-limite,
// calibração por método, mediana calibrada e regra de entrada fora do domínio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as N from '../../lib/normative.js'
import { computeStats } from '../../lib/stats.js'
import { metodoDe, calcularCalibracao, salvarCalibracao, calibracaoPara } from '../../lib/calibracao.js'
import { avaliarRegras } from '../../lib/qcrules.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ler = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'))
globalThis.fetch = async (u) => ({ ok: true, json: async () => ler(String(u).replace(/^\.\//, '')) })
await N.loadNorms()

// volume em que a norma dá z = 0 (bissecção)
const mediana = (ph, sexo, idade) => { let lo = 1, hi = 3e6; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (N.evaluate(ph, sexo, idade, m).z < 0) lo = m; else hi = m } return lo }

test('TCV = GMV + WMV (definição do BrainChart): componentes na mediana dão TCV ≈ 0', () => {
  for (const [sexo, idade] of [['F', 40], ['M', 70]]) {
    const stats = { composites: [{ id: 'CortexVol', volMm3: mediana('GMV', sexo, idade) }, { id: 'CerebralWhiteMatterVol', volMm3: mediana('WMV', sexo, idade) }, { id: 'SubCortGrayVol', volMm3: mediana('sGMV', sexo, idade) }], rows: [] }
    const tcv = N.compareToNorms(stats, { age: idade, sex: sexo }).globals.find(g => g.pheno === 'TCV')
    assert.ok(Math.abs(tcv.z) < 0.15, `TCV z ${tcv.z} (com a sGMV somada saía ≈ +0,6)`)
  }
  // sem a substância branca não há TCV (antes virava córtex + subcortical, z ≈ −5)
  const sem = N.compareToNorms({ composites: [{ id: 'CortexVol', volMm3: 5e5 }], rows: [] }, { age: 50, sex: 'F' }).globals
  assert.equal(sem.find(g => g.pheno === 'TCV'), undefined)
})

test('BrainChart contra a CDF exata da GG no R: caudas até ±6 e idades pediátricas', () => {
  let meio = 0, cauda = 0
  for (const e of ler('tests/fixtures/brainchart_exato_R.json')) {
    e.z.forEach((zt, i) => {
      const d = Math.abs(N.evaluate(e.ph, e.sex, e.age, e.v[i]).z - zt)
      if (Math.abs(zt) <= 3) meio = Math.max(meio, d); else cauda = Math.max(cauda, d)
    })
  }
  assert.ok(meio < 0.05, `|z| ≤ 3: erro máx ${meio}`)
  assert.ok(cauda < 0.05, `3 < |z| ≤ 6: erro máx ${cauda} (antes até ~16 nos ventrículos)`)
})

test('CentileBrain contra o R nas caudas (BCTo do putâmen incluído)', () => {
  let max = 0
  for (const e of ler('tests/fixtures/centilebrain_exato_R.json')) {
    e.z.forEach((zt, i) => { max = Math.max(max, Math.abs(N.evaluateSubcortical(e.st, e.h === 'L' ? 'E' : 'D', e.sex, e.age, e.v[i]).z - zt)) })
  }
  assert.ok(max < 0.06, `erro máx ${max} (antes +2 em z = +5)`)
})

test('percentil no limite da tabela aparece como "< 0,1" / "> 99,9"', () => {
  const r = N.compareToNorms({ composites: [{ id: 'CortexVol', volMm3: 0.6 * mediana('GMV', 'F', 60) }], rows: [] }, { age: 60, sex: 'F' }).globals.find(g => g.pheno === 'GMV')
  assert.equal(N.formatPercentil(r.percentile), '< 0,1')
  assert.equal(N.formatPercentil(99.9), '> 99,9')
})

test('com DKT, o par de assimetria do córtex é o córtex TOTAL do hemisfério, não o resíduo', () => {
  const labels = { 0: 'BG', 2: 'Left-Cerebral-Cortex', 3: 'Right-Cerebral-Cortex', 32: 'ctx-lh-insula', 33: 'ctx-rh-insula', 34: 'ctx-lh-lingual', 35: 'ctx-rh-lingual' }
  const seg = new Uint8Array(20 ** 3)
  // resíduo genérico pequeno e desigual (12 × 3 voxels); parcelas grandes e quase simétricas
  for (let i = 0; i < seg.length; i++) seg[i] = [32, 33, 34, 35][i % 4]
  for (let i = 0; i < 12; i++) seg[i * 4] = 2
  for (let i = 0; i < 3; i++) seg[i * 4 + 1] = 3
  const I = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  const st = computeStats(seg, new Uint8Array(seg.length), [20, 20, 20], labels, I, 1)
  const par = st.pairs.find(p => p.base === 'Cerebral-Cortex')
  assert.ok(par && Math.abs(par.ai) < 1, `IA ${par && par.ai} (o resíduo daria ≈ 120%)`)
  assert.equal(par.left + par.right, seg.length)
})

test('calibração do sítio separada por método (rede + convenção de volume)', () => {
  assert.equal(metodoDe('SynthSeg 1.0 + parcelação DKT (FastSurfer)', 'suave'), 'synthseg/suave')
  assert.notEqual(metodoDe('MeshNet aseg', 'rigido'), metodoDe('SynthSeg 1.0', 'suave'))
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)) }
  const linhas = Array.from({ length: 12 }, (_, i) => ({ idade: 50 + i, sexo: i % 2 ? 'F' : 'M', CortexVol: 480e3 }))
  salvarCalibracao(calcularCalibracao(linhas, { protocolo: { familia: 'fx', familiaTxt: 't' }, metodo: 'synthseg/suave' }))
  assert.ok(calibracaoPara('fx', null, 'synthseg/suave'))
  assert.equal(calibracaoPara('fx', null, 'meshnet/rigido'), null)
  delete globalThis.localStorage
})

test('com calibração, a "mediana" mostrada é o volume de z final 0', () => {
  const linhas = Array.from({ length: 32 }, (_, i) => { const idade = 40 + (i % 30); const sexo = i % 2 ? 'F' : 'M'; return { idade, sexo, CortexVol: mediana('GMV', sexo, idade) * 1.08 } })
  const cal = calcularCalibracao(linhas, { protocolo: { familia: 'f', familiaTxt: 't' } })
  const g = N.compareToNorms({ composites: [{ id: 'CortexVol', volMm3: 5e5 }], rows: [] }, { age: 60, sex: 'F' }, { calibracao: cal }).globals.find(x => x.pheno === 'GMV')
  const naMediana = N.compareToNorms({ composites: [{ id: 'CortexVol', volMm3: g.median }], rows: [] }, { age: 60, sex: 'F' }, { calibracao: cal }).globals.find(x => x.pheno === 'GMV')
  assert.ok(Math.abs(naMediana.z) < 0.02, `z na mediana mostrada: ${naMediana.z}`)
  assert.ok(g.medianaNorma > 0 && g.median > g.medianaNorma)
})

test('regra de entrada fora do domínio da referência (extração cerebral, SynthSR, sem espelhamento)', () => {
  const regras = ler('models/qc_rules.json')
  const al = avaliarRegras(regras, { segmentacao: { dominio: { bet: true, synthsr: false, recorte: false, suavizacao: false, espelhamento: false } } })
  const a = al.find(x => x.id === 'entrada_fora_do_dominio')
  assert.ok(a && /extração cerebral/.test(a.mensagem) && /espelhado/.test(a.mensagem))
  assert.ok(!avaliarRegras(regras, { segmentacao: { dominio: { bet: false, synthsr: false, recorte: false, suavizacao: false, espelhamento: true } } }).some(x => x.id === 'entrada_fora_do_dominio'))
})
