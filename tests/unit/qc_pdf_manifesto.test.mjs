// Regras de QC, laudo PDF (fonte embutida, texto pesquisável, seções novas) e manifesto
// SHA-256 dos pesos/normas (tem de bater com os arquivos do repositório).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { avaliarRegras, ocupacaoHipocampal, alvosDeCaptura } from '../../lib/qcrules.js'
import { PDF } from '../../lib/pdf.js'
import { buildReport } from '../../lib/report.js'
import * as N from '../../lib/normative.js'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ler = (p) => fs.readFileSync(path.join(RAIZ, p))
globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(ler(String(u).replace(/^\.\//, '')).toString('utf8')) })
const regras = JSON.parse(ler('models/qc_rules.json').toString('utf8'))

const rows = [
  { name: 'Left-Hippocampus', ptName: 'Hipocampo — esquerdo', volMm3: 4700, centroid: [-25, -20, -12] },
  { name: 'Left-Inf-Lat-Vent', ptName: 'Corno temporal — esquerdo', volMm3: 1300, centroid: [-30, -10, -15] },
  { name: 'Right-Hippocampus', ptName: 'Hipocampo — direito', volMm3: 4300, centroid: [26, -20, -12] },
  { name: 'Right-Inf-Lat-Vent', ptName: 'Corno temporal — direito', volMm3: 300, centroid: [30, -10, -15] }
]

test('HOC e regras: hipocampo grande com corno temporal dilatado, fronteira SC/SB, desvios em bloco', () => {
  const hoc = ocupacaoHipocampal({ rows })
  assert.ok(Math.abs(hoc.E.hoc - 4700 / 6000) < 1e-9)
  const normas = {
    globals: [{ pheno: 'GMV', z: 1.44, pt: 'Córtex' }, { pheno: 'WMV', z: -0.69, pt: 'SB' }],
    subcorticais: [{ pheno: 'Hippocampus', hemi: 'E', z: 1.87 }, { pheno: 'Hippocampus', hemi: 'D', z: 2.52 }],
    flags: [],
    multiplicidade: { m: 19, esperadoAbs2: 0.86, observadoAbs2: 8, fracPositivos: 0.9 },
    proveniencia: { brainchart: { borda: false, norma: 'BrainChart' }, centilebrain: { borda: true, norma: 'CentileBrain' } }
  }
  const al = avaliarRegras(regras, { idade: 89, sexo: 'M', normas, stats: { rows }, qc: null, icv: null, hoc, assimetria: [] })
  const ids = al.map(a => a.id)
  assert.ok(ids.includes('hipocampo_corno_temporal'))   // esquerdo: z 1,87 e HOC 0,78
  assert.equal(al.filter(a => a.id === 'hipocampo_corno_temporal').length, 1) // direito: HOC 0,93
  assert.ok(ids.includes('fronteira_sc_sb'))
  assert.ok(ids.includes('desvios_em_bloco'))
  assert.ok(ids.includes('idade_borda'))
  assert.ok(!ids.includes('z_extremo'))
  const alvos = alvosDeCaptura(al, { rows })
  assert.ok(alvos.some(a => /Hipocampo/.test(a.legenda)))
  assert.ok(alvos.length <= 9)
})

test('PDF com Inter embutida: texto pesquisável (ToUnicode) e kerning no TJ', () => {
  const kern = JSON.parse(ler('fonts/inter/kern.json').toString('utf8')).pares
  const pdf = new PDF()
  for (const w of [400, 600, 700]) pdf.addFont(w, ler(`fonts/inter/Inter-${w}.ttf`), kern[w])
  pdf.text(50, 100, 'AVoTe Relatório 1.234,5 cm³ α ≥', 20, { weight: 700 })
  const bytes = Buffer.from(pdf.build())
  const txt = bytes.toString('latin1')
  assert.match(txt, /\/Subtype \/Type0/)
  assert.match(txt, /\/FontFile2/)
  assert.match(txt, /beginbfchar/)
  assert.match(txt, /\] TJ/)
  assert.ok(pdf.textWidth('AV', 20, { weight: 700 }) < pdf.textWidth('A', 20, { weight: 700 }) + pdf.textWidth('V', 20, { weight: 700 }), 'kerning aproxima A e V')
  // sem fontes registradas: Helvetica de base
  const p2 = new PDF()
  p2.text(10, 10, 'ok', 10)
  assert.match(Buffer.from(p2.build()).toString('latin1'), /Helvetica/)
})

test('laudo: Como ler, selo de proveniência, índice não validado e alertas', async () => {
  await N.loadNorms()
  const stats = {
    rows: [...rows.map(r => ({ ...r, group: /Hippocampus/.test(r.name) ? 'subcortical' : 'ventrículos', hemi: /^Left/.test(r.name) ? 'E' : 'D', pctBrain: 0.3, meanInt: 90 }))],
    composites: [{ id: 'CortexVol', ptName: 'Córtex', volMm3: 520e3, pctBrain: 40 }, { id: 'CerebralWhiteMatterVol', ptName: 'SB', volMm3: 420e3, pctBrain: 35 }],
    lobes: [], pairs: [], brainVol: 1.2e6, hemiMethod: 'rótulos', volumeSoft: true
  }
  const norms = N.compareToNorms(stats, { age: 89, sex: 'M' }, { ferramentaPaciente: 'SynthSeg 1.0', metodoVolume: 'suave' })
  const meta = {
    tool: 'SegmentaRM', version: '1.1.0', subject: 't', age: 89, sex: 'M', date: '2026-09-27', norms,
    qc: { resumo: { escoreMinimo: 0.9, escoreMedio: 0.95, gruposEmAlerta: [] }, grupos: [{ pt: 'hipocampo', voxels: 10, escore: 0.9, confianca: 0.9, coesao: 1, simetria: 1 }] },
    inspecao: { alertas: [{ id: 'x', titulo: 'Teste de alerta', severidade: 'atencao', mensagem: 'm', recomendacao: 'r', status: 'provisório' }], imagens: [], hoc: ocupacaoHipocampal({ rows }) },
    hoc: { E: { hoc: 0.78, z: -2.4, esperado: 0.84, hip: 4700, cornoTemporal: 1300 }, D: { hoc: 0.93, z: 1.1, esperado: 0.85, hip: 4300, cornoTemporal: 300 } },
    assimetria: [{ base: 'Hippocampus', group: 'subcortical', ptName: 'Hipocampo', ai: 8.9, zIA: 2.3, iaMedia: -1, iaDp: 4.3 }],
    refAssimetria: { fonteCurta: 'DLBS (OpenNeuro ds004856, CC0)', n: 100, idadeFaixa: [21, 89] },
    reprodutibilidade: { componentes: [{ nome: 'synthseg1', sha256: 'a'.repeat(64) }] },
    caveats: []
  }
  const buf = Buffer.from(await buildReport({ stats, meta, snapshot: null }))
  // o conteúdo das páginas não é comprimido: dá para procurar o texto (Helvetica, WinAnsi)
  const t = buf.toString('latin1')
  if (process.env.SALVAR_PDF) fs.writeFileSync(process.env.SALVAR_PDF, buf)
  for (const frase of ['Como ler esta p', 'NÃO calibrado', 'ndice de confian', 'Teste de alerta', 'Reprodutibilidade', 'tricas do mesmo m', 'IC 90%']) {
    assert.ok(t.includes(Buffer.from(frase, 'latin1').toString('latin1')) || t.includes(frase.replace('Ã', '\\303')), `laudo sem "${frase}"`)
  }
  assert.ok(!/Lobos corticais/.test(t), 'a tabela de z lobar saiu do laudo')
})

test('manifesto SHA-256 confere com os arquivos (rode tools/manifesto_sha256.mjs ao trocar pesos/normas)', () => {
  const man = JSON.parse(ler('models/manifest-sha256.json').toString('utf8'))
  for (const [nome, c] of Object.entries(man.componentes)) {
    for (const f of c.arquivos) {
      const h = crypto.createHash('sha256').update(ler(f.arquivo)).digest('hex')
      assert.equal(h, f.sha256, `${nome}: ${f.arquivo} mudou — regenere o manifesto`)
    }
    const comb = crypto.createHash('sha256').update(c.arquivos.map(x => `${x.arquivo}:${x.sha256}`).join('\n')).digest('hex')
    assert.equal(comb, c.sha256)
  }
  assert.ok(zlib) // (import mantido para testes futuros de conteúdo comprimido)
})
