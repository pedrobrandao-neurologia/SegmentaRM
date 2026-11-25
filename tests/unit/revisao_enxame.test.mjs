// Regressões da revisão por áreas (nov/2026): volume com NaN zerava a imagem do SynthSeg, data
// DICOM anonimizada deslocava a idade, fórmula em CSV, colisão thick_ na planilha larga, alerta
// de idade na borda com as normas SegmentaRM e registro durável do lote das normas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { robustRescale } from '../../lib/synthseg-core.js'
import { idadeNoExame } from '../../lib/dicom-scan.js'
import { statsToCSV, statsToWideRow } from '../../lib/stats.js'
import { avaliarRegras } from '../../lib/qcrules.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('robustRescale: NaN/Inf viram 0 em vez de zerar a imagem inteira', () => {
  const n = 20000
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = i % 1000
  const limpo = robustRescale(a)
  const b = Float32Array.from(a)
  for (let i = 0; i < 300; i++) b[i * 7] = NaN // 1,5% de NaN (> 0,5%: o P99,5 saía NaN)
  b[5] = Infinity
  const r = robustRescale(b)
  let max = 0; let finitos = true
  for (const v of r) { if (!Number.isFinite(v)) finitos = false; if (v > max) max = v }
  assert.ok(finitos && max > 0.99, `imagem zerada ou com NaN (máx ${max})`)
  assert.ok(Number.isNaN(b[7]), 'sem inPlace, a entrada não é alterada')
  // sem valores não finitos o resultado é idêntico ao de antes
  assert.deepEqual(Array.from(robustRescale(Float32Array.from(a))), Array.from(limpo))
})

test('idade do DICOM: data de nascimento anonimizada (mês/dia 00) não vira outra data', () => {
  const r = idadeNoExame({ '00080020': '20200101', '00100030': '19800000', '00101010': '040Y' })
  assert.equal(r.IdadeNoExame, 40)
  assert.match(r.IdadeFonte, /PatientAge/i)
  assert.equal(idadeNoExame({ '00080020': '20200101', '00100030': '19800101' }).IdadeNoExame, 40)
})

test('CSV: identificação que começa com = + - @ não é avaliada como fórmula', () => {
  const stats = { rows: [], composites: [{ id: 'CortexVol', ptName: 'Córtex', volMm3: 5e5, pctBrain: 40 }], lobes: [], pairs: [], brainVol: 1e6 }
  const l = statsToCSV(stats, { subject: '=HYPERLINK("http://x";"y")' }).split('\r\n')[1]
  assert.ok(l.startsWith('"\'=HYPERLINK('), l.slice(0, 40))
})

test('planilha larga: espessura da malha não sobrescreve a volumétrica de mesmo nome', () => {
  const stats = { rows: [], composites: [], lobes: [], pairs: [], brainVol: 1 }
  const { row } = statsToWideRow(stats, {
    subject: 's',
    espessura: { regioes: [{ hemi: 'lh', parcela: 'precentral', espessura_media_mm: 2.5 }] },
    surf: { regioes: [{ hemi: 'E', base: 'precentral', thickAvg: 3.1, area_mm2: 10 }] }
  })
  assert.equal(row.thick_lh_precentral, 2.5)
  assert.equal(row.thicksurf_lh_precentral, 3.1)
})

test('QC: idade na borda dispara com as normas SegmentaRM (década com poucos controles)', () => {
  const regras = JSON.parse(fs.readFileSync(path.join(RAIZ, 'models/qc_rules.json'), 'utf8'))
  const ctx = (pv) => ({ idade: 85, sexo: 'F', normas: { globals: [], subcorticais: [], proveniencia: pv } })
  const a = avaliarRegras(regras, ctx({ brainchart: { norma: 'BrainChart', borda: false }, segmentarm: { norma: 'Normas SegmentaRM (n = 641, 14 sítios)', borda: true } }))
  const hit = a.find(x => x.id === 'idade_borda')
  assert.ok(hit && /SegmentaRM/.test(hit.mensagem) && /poucos controles/.test(hit.mensagem), JSON.stringify(hit))
  // com as normas próprias em uso, a borda do BrainChart (só parcelas) não dispara o alerta
  const b = avaliarRegras(regras, ctx({ brainchart: { norma: 'BrainChart', borda: true }, segmentarm: { norma: 'Normas SegmentaRM', borda: false } }))
  assert.equal(b.find(x => x.id === 'idade_borda'), undefined)
})

test('normas_preparar: lê o registro durável (.jsonl), ignora JSON truncado e não duplica', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'normas-'))
  const soft = { 'Left-Cerebral-Cortex': 250e3, 'Right-Cerebral-Cortex': 250e3, 'Left-Cerebral-White-Matter': 220e3, 'Right-Cerebral-White-Matter': 220e3, 'Left-Hippocampus': 4000, 'Right-Hippocampus': 4100 }
  const reg = (id) => ({ id, base: 'b', sujeito: id, sitio: 's1', idade: 60, sexo: 'F', soft, vic: 1.5e6, vicAviso: null })
  fs.writeFileSync(path.join(d, 'resultados_f0de2.jsonl'), JSON.stringify(reg('a')) + '\n' + JSON.stringify(reg('b')) + '\n{"id":"c","so')
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(reg('a'))) // mesmo exame nas duas formas
  fs.writeFileSync(path.join(d, 'x.json'), '{"id":"x","soft":{"Left-') // truncado por queda
  const csv = path.join(d, 'tabela.csv')
  execFileSync('node', [path.join(RAIZ, 'tools/normas_preparar.mjs'), d, csv], { stdio: 'pipe' })
  const linhas = fs.readFileSync(csv, 'utf8').trim().split('\n')
  assert.equal(linhas.length, 3, 'cabeçalho + a + b')
  assert.ok(linhas[0].includes('CortexVol') && linhas[0].includes('zr_CortexVol'))
})
