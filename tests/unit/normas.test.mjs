// Normas: fidelidade ao R (CentileBrain), multiplicidade/Holm, percentis, proveniência e
// borda etária, ausência de z lobar, recentragem pelo método e calibração de sítio.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as N from '../../lib/normative.js'
import { calcularCalibracao, statsDeLinha, salvarCalibracao, calibracaoPara, calibracaoDesatualizada } from '../../lib/calibracao.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(RAIZ, String(u).replace(/^\.\//, '')), 'utf8')) })
await N.loadNorms()

test('CentileBrain em JS reproduz os quantis e o z do R/gamlss', () => {
  const ref = JSON.parse(fs.readFileSync(path.join(RAIZ, 'tests/fixtures/centilebrain_ref_R.json'), 'utf8'))
  let maxMeio = 0; let maxCauda = 0; let maxV = 0
  for (const c of ref) {
    c.probs.forEach((p, i) => {
      const e = N.evaluateSubcortical(c.st, c.h, c.sex, c.age, c.q[i])
      const d = Math.abs(e.z - N.qnorm(p))
      if (p >= 0.05 && p <= 0.95) maxMeio = Math.max(maxMeio, d)
      else maxCauda = Math.max(maxCauda, d)
    })
    maxV = Math.max(maxV, Math.abs(N.evaluateSubcortical(c.st, c.h, c.sex, c.age, c.v).z - c.zTrue))
  }
  assert.ok(maxMeio < 0.01, `z entre P5 e P95: erro máx ${maxMeio}`)
  assert.ok(maxCauda < 0.06, `z em P0,5/P99,5: erro máx ${maxCauda}`)
  assert.ok(maxV < 0.02, `z de um volume 20% abaixo da mediana: erro máx ${maxV}`)
})

test('multiplicidade: esperado m·P(|Z|>2) e Holm passo a passo', () => {
  const itens = [{ z: 4.0, pheno: 'X' }, { z: 2.9, pheno: 'Hippocampus' }, { z: -2.1, pheno: 'Y' }, { z: 0.3, pheno: 'W' }]
  const m = N.multiplicidade(itens)
  assert.equal(m.m, 4)
  assert.ok(Math.abs(m.esperadoAbs2 - 4 * 0.0455) < 0.001)
  assert.equal(m.observadoAbs2, 3)
  // p(4.0) = 6,3e-5 ≤ 0,05/4; p(2.9) = 0,0037 ≤ 0,05/3; p(2.1) = 0,036 > 0,05/2 → para
  assert.deepEqual(itens.map(i => i.holm), [true, true, false, false])
  assert.equal(itens[1].preEspecificada, true)
})

test('percentis sem falsa precisão nas caudas', () => {
  assert.equal(N.formatPercentil(50.4), '50')
  assert.equal(N.formatPercentil(0.5), '< 1')
  assert.equal(N.formatPercentil(0.05), '< 0,1')
  assert.equal(N.formatPercentil(99.5), '> 99')
  assert.equal(N.formatPercentil(99.95), '> 99,9')
})

// estatísticas mínimas de um adulto típico (volumes na mediana aproximada)
const stats = {
  composites: [{ id: 'CortexVol', volMm3: 480e3 }, { id: 'CerebralWhiteMatterVol', volMm3: 470e3 }, { id: 'SubCortGrayVol', volMm3: 60e3 }, { id: 'VentricleVol', volMm3: 25e3 }],
  rows: [{ name: 'Left-Hippocampus', volMm3: 3800, group: 'subcortical', hemi: 'E' }, { name: 'Right-Hippocampus', volMm3: 3900, group: 'subcortical', hemi: 'D' }]
}

test('sem z por lobo; proveniência e borda etária por família', () => {
  const n = N.compareToNorms(stats, { age: 89, sex: 'M' }, { ferramentaPaciente: 'SynthSeg 1.0', metodoVolume: 'suave' })
  assert.equal(n.lobes.length, 0)
  assert.equal(n.proveniencia.centilebrain.borda, true) // 89 anos: a < 5 anos do limite de 90
  assert.equal(n.proveniencia.brainchart.borda, false)  // BrainChart vai a 100
  assert.ok(n.subcorticais.every(s => s.extrapolacao === true))
  assert.ok(n.globals.every(g => g.extrapolacao === false))
  const selo = N.seloNorma(n.proveniencia.centilebrain, n.proveniencia)
  assert.match(selo, /NÃO calibrado/)
  assert.match(selo, /BORDA/)
  const jovem = N.compareToNorms(stats, { age: 40, sex: 'M' }, {})
  assert.equal(jovem.proveniencia.centilebrain.borda, false)
})

test('recentragem pelo método: desconta o desvio dos controles por idade e sexo; incerteza no intervalo', () => {
  const z4 = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
  const covH = z4.map(r => r.slice()); covH[0][0] = 0.01 // EP de 0,1 z no deslocamento
  const rec = {
    idadeRef: 60, idadeFaixa: [21, 89], n: 100, fonteCurta: 'teste',
    estruturas: {
      'Left-Hippocampus': { a: 0, c: 0, d: 0, e: 0, cov: covH },
      CortexVol: { a: 0.5, c: 0.01, d: 0, e: 0.2, cov: z4 }
    }
  }
  const r = N.recentragemZ(rec, 'CortexVol', 60, 'F')
  assert.ok(Math.abs(r.desloc - 0.5) < 1e-12)
  assert.ok(Math.abs(N.recentragemZ(rec, 'CortexVol', 70, 'M').desloc - (0.5 + 0.1 + 0.2)) < 1e-12, 'termos de idade e sexo')
  // fora da faixa do ajuste, os termos de idade ficam na borda (sem extrapolar)
  const r95 = N.recentragemZ(rec, 'CortexVol', 95, 'F')
  assert.ok(Math.abs(r95.desloc - N.recentragemZ(rec, 'CortexVol', 89, 'F').desloc) < 1e-12 && r95.foraDaFaixa)
  const bruto = N.compareToNorms(stats, { age: 60, sex: 'F' }, {})
  const reco = N.compareToNorms(stats, { age: 60, sex: 'F' }, { recentragem: rec })
  const hb = bruto.subcorticais.find(s => s.hemi === 'E'); const hr = reco.subcorticais.find(s => s.hemi === 'E')
  // deslocamento nulo: mesmo z, intervalo mais largo pela incerteza da recentragem
  assert.ok(Math.abs(hr.z - hb.z) < 1e-9)
  assert.ok(Math.abs(hr.incerteza.recentragem - 0.1) < 1e-9 && (hr.ic90[1] - hr.ic90[0]) > (hb.ic90[1] - hb.ic90[0]))
  const gb = bruto.globals.find(g => g.pheno === 'GMV'); const gr = reco.globals.find(g => g.pheno === 'GMV')
  assert.ok(Math.abs(gr.z - (gb.z - 0.5)) < 1e-9, 'z recentrado = z bruto − deslocamento')
  assert.equal(gr.zBruto, gb.z)
  // mediana esperada para o método: o volume em que a norma dá z = deslocamento (acima da mediana da norma)
  assert.ok(gr.median > gr.medianaNorma && N.compareToNorms({ composites: [{ id: 'CortexVol', volMm3: gr.median }], rows: [] }, { age: 60, sex: 'F' }, { recentragem: rec }).globals[0].z < 0.01)
})

test('intervalo de 90% do z: erro entre scanners sem calibração; ausente sem modelo de erro', () => {
  const n = N.compareToNorms(stats, { age: 70, sex: 'F' }, {})
  const h = n.subcorticais.find(s => s.hemi === 'E')
  assert.ok(h.ic90[0] < h.z && h.ic90[1] > h.z)
  assert.equal(h.incerteza.entreScanners, true)
  // hipocampo E: CV entre sessões 2,2% ÷ DP normativo (~10%) → meia-largura ≈ 1,645·0,2
  const meia = (h.ic90[1] - h.ic90[0]) / 2
  assert.ok(meia > 0.15 && meia < 0.8, `meia-largura ${meia}`)
  const g = n.globals.find(x => x.pheno === 'GMV')
  assert.ok(g.ic90 && g.incerteza.fonteMedida === 'vanNederpelt2023')
  const sem = N.compareToNorms(stats, { age: 70, sex: 'F' }, { erroMedida: null })
  assert.ok(sem.globals.every(x => x.ic90 === undefined))
})

test('calibração de sítio: recupera um deslocamento simulado e respeita n mínimo', () => {
  const linhas = []
  for (let i = 0; i < 32; i++) {
    const idade = 40 + (i % 30)
    const sexo = i % 2 ? 'F' : 'M'
    const med = (ph) => { let lo = 1, hi = 3e6; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (N.evaluate(ph, sexo, idade, m).z < 0) lo = m; else hi = m } return lo }
    linhas.push({ idade, sexo, CortexVol: med('GMV') * 1.08 })
  }
  const cal = calcularCalibracao(linhas, { protocolo: { familia: 'f', familiaTxt: 'teste' } })
  assert.equal(cal.n, 32)
  const e = cal.estruturas.CortexVol
  assert.ok(e.media > 0.5 && e.ic90[0] < e.media && e.ic90[1] > e.media)
  const pac = { composites: [{ id: 'CortexVol', volMm3: linhas[0].CortexVol }], rows: [] }
  const zc = N.compareToNorms(pac, { age: linhas[0].idade, sex: linhas[0].sexo }, { calibracao: cal }).globals.find(g => g.pheno === 'GMV')
  assert.ok(Math.abs(zc.z) < 0.5, `z calibrado ${zc.z}`)
  assert.equal(zc.incerteza.entreScanners, false)
  assert.ok(zc.incerteza.calibracao > 0)
  // com menos de 10 controles a calibração não é aplicada
  const pouca = calcularCalibracao(linhas.slice(0, 5), {})
  const z5 = N.compareToNorms(pac, { age: linhas[0].idade, sex: linhas[0].sexo }, { calibracao: pouca }).globals.find(g => g.pheno === 'GMV')
  assert.equal(z5.calibrado, undefined)
  assert.ok(pouca.avisos.length > 0)
  assert.equal(statsDeLinha({ Left_Hippocampus: 4000 }).rows[0].name, 'Left-Hippocampus')
})

test('calibração guardada só vale para a mesma recentragem (coeficientes novos exigem recalcular)', () => {
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => mem.has(k) ? mem.get(k) : null, setItem: (k, v) => mem.set(k, String(v)) }
  const rcA = { versao: '1.0', n: 100, gerado: '2026-09-27', estruturas: {} }
  const rcB = { ...rcA, n: 201 }
  const linhas = Array.from({ length: 12 }, (_, i) => ({ idade: 50 + i, sexo: i % 2 ? 'F' : 'M', CortexVol: 480e3 + 1e3 * i }))
  salvarCalibracao(calcularCalibracao(linhas, { protocolo: { familia: 'fam1', familiaTxt: 't' }, recentragem: rcA }))
  assert.ok(calibracaoPara('fam1', rcA))
  assert.equal(calibracaoPara('fam1', rcB), null)
  assert.equal(calibracaoDesatualizada('fam1', rcB), true)
  assert.equal(calibracaoPara('fam1', null), null) // sem recentragem: outra calibração (modo diferente)
  delete globalThis.localStorage
})
