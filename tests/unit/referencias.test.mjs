// Referências do mesmo método (assimetria e HOC por idade), regra da recentragem fora do domínio
// e coerência entre o JSON de referência e o módulo que o lê.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { anotarAssimetria, iaEsperado, zHoc } from '../../lib/assimetria.js'
import { avaliarRegras } from '../../lib/qcrules.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ler = (p) => JSON.parse(fs.readFileSync(path.join(RAIZ, p), 'utf8'))
const regras = ler('models/qc_rules.json')

// referência sintética: IA do hipocampo com média −1% e DP 4% (+0,02 por ano), HOC 0,95 − 0,002·t
const ref = {
  idadeRef: 60, idadeFaixa: [21, 89], fonteCurta: 'teste',
  assimetria: { estruturas: { Hippocampus: { media0: -1, media1: 0, dp0: 4, dp1: 0.02, dpMin: 1, n: 100 } } },
  hoc: { lados: { E: { media0: 0.95, media1: -0.002, media2: 0, dp0: 0.02, dp1: 0, dpMin: 0.005, n: 100 } } }
}

test('assimetria: z só com referência do mesmo método; parcelas corticais sem z', () => {
  const pares = [
    { base: 'Hippocampus', group: 'subcortical', ptName: 'Hipocampo', left: 4000, right: 4400, ai: 200 * (4000 - 4400) / 8400 },
    { base: 'lingual', group: 'cortex', ptName: 'Lingual', left: 5000, right: 6500, ai: 200 * (5000 - 6500) / 11500 },
    { base: 'Putamen', group: 'subcortical', ptName: 'Putâmen', left: 5000, right: 5100, ai: -2 }
  ]
  const a = anotarAssimetria(pares, 70, ref)
  const h = a.find(p => p.base === 'Hippocampus')
  const esp = iaEsperado(ref, 'Hippocampus', 70)
  assert.ok(Math.abs(esp.dp - 4.2) < 1e-9)
  assert.ok(Math.abs(h.zIA - (h.ai + 1) / 4.2) < 1e-9)
  assert.equal(h.nomeE, 'Left-Hippocampus')
  assert.equal(a.find(p => p.base === 'lingual').zIA, undefined)
  assert.equal(a.find(p => p.base === 'lingual').nomeE, 'ctx-lh-lingual')
  assert.equal(a.find(p => p.base === 'Putamen').zIA, undefined) // sem referência para o putâmen
  // idade fora da faixa: termos de idade na borda
  assert.ok(Math.abs(iaEsperado(ref, 'Hippocampus', 99).dp - iaEsperado(ref, 'Hippocampus', 89).dp) < 1e-12)
  // regra de assimetria extrema usa o zIA
  const al = avaliarRegras(regras, { assimetria: anotarAssimetria([{ ...pares[0], ai: -20 }], 70, ref) })
  assert.ok(al.some(x => x.id === 'assimetria_extrema'))
})

test('HOC por idade: a regra usa o z quando há referência e o corte fixo quando não há', () => {
  const zh = zHoc(0.85, 'E', 80, ref)
  assert.ok(Math.abs(zh.media - 0.91) < 1e-9 && Math.abs(zh.z - (0.85 - 0.91) / 0.02) < 1e-9)
  const normas = { subcorticais: [{ pheno: 'Hippocampus', hemi: 'E', z: 1.8 }], globals: [], flags: [], proveniencia: {} }
  // HOC 0,85 passa do corte fixo (0,83), mas é z −3 para a idade → dispara com a referência
  const comRef = avaliarRegras(regras, { normas, hoc: { E: { hoc: 0.85, z: zh.z } } })
  assert.ok(comRef.some(a => a.id === 'hipocampo_corno_temporal'))
  const semRef = avaliarRegras(regras, { normas, hoc: { E: { hoc: 0.85 } } })
  assert.ok(!semRef.some(a => a.id === 'hipocampo_corno_temporal'))
})

test('recentragem fora do domínio: avisa em outro fabricante/campo; cala com o sítio calibrado', () => {
  const rc = { dominio: { fabricante: 'Philips', campoT: 3, descricao: 'Philips 3 T' } }
  const normas = { globals: [], subcorticais: [], flags: [], proveniencia: { recentragem: rc } }
  const ge = avaliarRegras(regras, { normas, aquisicao: { fabricante: 'GE MEDICAL SYSTEMS', campoT: 3 } })
  assert.ok(ge.some(a => a.id === 'recentragem_fora_do_dominio' && /GE/.test(a.mensagem)))
  const ph = avaliarRegras(regras, { normas, aquisicao: { fabricante: 'Philips Medical Systems', campoT: 3 } })
  assert.ok(!ph.some(a => a.id === 'recentragem_fora_do_dominio'))
  const cal = avaliarRegras(regras, { normas: { ...normas, proveniencia: { recentragem: rc, calibracao: { n: 30 } } }, aquisicao: { fabricante: 'GE', campoT: 1.5 } })
  assert.ok(!cal.some(a => a.id === 'recentragem_fora_do_dominio'))
})

test('bloco reduzido: avisa abaixo de 128³ (GPU ou memória baixa); cala com 128³ ou sem a informação', () => {
  const gpu = avaliarRegras(regras, { segmentacao: { bloco: { usado: 96, pedido: 128 } } })
  const a = gpu.find(x => x.id === 'bloco_reduzido')
  assert.ok(a && /96³/.test(a.mensagem) && /textura/.test(a.mensagem) && /128³/.test(a.mensagem))
  const mem = avaliarRegras(regras, { segmentacao: { bloco: { usado: 96, pedido: 96 } } })
  assert.ok(mem.some(x => x.id === 'bloco_reduzido' && /memória baixa/.test(x.mensagem)))
  assert.ok(!avaliarRegras(regras, { segmentacao: { bloco: { usado: 128, pedido: 128 } } }).some(x => x.id === 'bloco_reduzido'))
  assert.ok(!avaliarRegras(regras, { segmentacao: { bloco: null } }).some(x => x.id === 'bloco_reduzido'))
  assert.ok(!avaliarRegras(regras, {}).some(x => x.id === 'bloco_reduzido'))
})

test('arquivos de referência embarcados: formato que o app lê', () => {
  for (const [arq, chk] of [
    ['models/normative/referencia_mesmo_metodo.json', (d) => d.assimetria && d.assimetria.estruturas.Hippocampus && d.hoc && d.hoc.lados.E && d.idadeFaixa],
    ['models/normative/recentragem_synthseg.json', (d) => d.estruturas && d.estruturas.CortexVol && d.estruturas['Left-Hippocampus'] && d.estruturas.CortexVol.cov.length === 4 && d.dominio && d.idadeFaixa && d.normasSha256],
    ['models/normative/erro_medida.json', (d) => d.estruturas && d.estruturas['Left-Hippocampus'] && d.estruturas.CortexVol]
  ]) {
    const p = path.join(RAIZ, arq)
    if (!fs.existsSync(p)) { assert.fail(`${arq} ausente`) }
    assert.ok(chk(JSON.parse(fs.readFileSync(p, 'utf8'))), `${arq} fora do formato esperado`)
  }
})

test('recentragem embarcada foi ajustada com as normas embarcadas (SHA-256 confere)', () => {
  const rc = ler('models/normative/recentragem_synthseg.json')
  const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, p))).digest('hex')
  assert.equal(rc.normasSha256.brainchart, h('models/normative/brainchart.json'), 'brainchart.json mudou: rode tools/recentragem_dlbs.mjs de novo')
  assert.equal(rc.normasSha256.subcortical, h('models/normative/subcortical.json'), 'subcortical.json mudou: rode tools/recentragem_dlbs.mjs de novo')
})
