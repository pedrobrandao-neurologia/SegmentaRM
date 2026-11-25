#!/usr/bin/env node
// Normas próprias, etapa 2 (OFFLINE): junta os resultados do lote (tools/normas_lote.mjs) numa
// tabela por exame para o ajuste em R (tools/normas_ajuste.R) e calcula, para os MESMOS exames,
// o z do pipeline atual do app — BrainChart/CentileBrain + recentragem pelo DLBS — com o mesmo
// código e as mesmas tabelas do app (lib/normative.js). É a base da comparação deixando um sítio
// de fora (docs/validacao/normas.md).
//
//   node tools/normas_preparar.mjs <pasta de resultados (*.json e/ou resultados_*.jsonl)> <tabela.csv>
//
// Fenótipos (chaves do app): globais do BrainChart (CortexVol, CerebralWhiteMatterVol,
// SubCortGrayVol, VentricleVol, TCV = córtex + SB), subcorticais E/D do CentileBrain, mais
// cornos temporais, ventrículos laterais, cerebelo, tronco e o VIC (eTIV afim do app).
// Volumes SUAVES do SynthSeg (valor principal do app).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [RES, SAIDA] = process.argv.slice(2)
if (!RES || !SAIDA) { console.error('uso: node tools/normas_preparar.mjs <resultados> <tabela.csv>'); process.exit(2) }

globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(RAIZ, String(u).replace(/^\.\//, '')), 'utf8')) })
const N = await import(path.join(RAIZ, 'lib/normative.js'))
await N.loadNorms()
const REC = JSON.parse(fs.readFileSync(path.join(RAIZ, 'models/normative/recentragem_synthseg.json'), 'utf8'))

const H = ['Left', 'Right']
const SUB = ['Thalamus', 'Caudate', 'Putamen', 'Pallidum', 'Hippocampus', 'Amygdala', 'Accumbens-area']
const soma = (v, nomes) => nomes.reduce((a, k) => a + (v[k] || 0), 0)
// mesmas definições do app (lib/stats.js) para o SynthSeg 1.0
export const FENOTIPOS = {
  CortexVol: v => soma(v, ['Left-Cerebral-Cortex', 'Right-Cerebral-Cortex']),
  CerebralWhiteMatterVol: v => soma(v, ['Left-Cerebral-White-Matter', 'Right-Cerebral-White-Matter']),
  SubCortGrayVol: v => soma(v, H.flatMap(h => [...SUB, 'VentralDC'].map(s => `${h}-${s}`))),
  VentricleVol: v => soma(v, ['Left-Lateral-Ventricle', 'Right-Lateral-Ventricle', 'Left-Inf-Lat-Vent', 'Right-Inf-Lat-Vent', '3rd-Ventricle', '4th-Ventricle']),
  TCV: v => soma(v, ['Left-Cerebral-Cortex', 'Right-Cerebral-Cortex', 'Left-Cerebral-White-Matter', 'Right-Cerebral-White-Matter']),
  ...Object.fromEntries(H.flatMap(h => [...SUB, 'Inf-Lat-Vent', 'Lateral-Ventricle'].map(s => [`${h}-${s}`, v => v[`${h}-${s}`]]))),
  CerebellumVol: v => soma(v, ['Left-Cerebellum-Cortex', 'Right-Cerebellum-Cortex', 'Left-Cerebellum-White-Matter', 'Right-Cerebellum-White-Matter']),
  BrainStemVol: v => v['Brain-Stem']
}

// z do pipeline atual (com e sem a recentragem do DLBS), como no app
function zAtual (v, idade, sexo) {
  const stats = {
    composites: ['CortexVol', 'CerebralWhiteMatterVol', 'SubCortGrayVol', 'VentricleVol'].map(id => ({ id, volMm3: FENOTIPOS[id](v) })),
    rows: Object.keys(v).filter(k => /^(Left|Right)-/.test(k) && v[k] > 0).map(name => ({ name, volMm3: v[name], group: 'subcortical', hemi: /^Left/.test(name) ? 'E' : 'D' }))
  }
  const o = {}
  const n = N.compareToNorms(stats, { age: idade, sex: sexo }, { recentragem: REC, erroMedida: null })
  for (const it of [...n.globals, ...(n.subcorticais || [])]) if (isFinite(it.z)) { o['zr_' + it.chave] = it.z; o['zb_' + it.chave] = it.zBruto }
  return o
}

const linhas = []
// entrada: <id>.json do lote e/ou resultados_*.jsonl (registro durável, uma linha por exame);
// arquivo ou linha ilegível é avisado e pulado, e o mesmo id não entra duas vezes
const registros = []
for (const f of fs.readdirSync(RES).sort()) {
  const p = path.join(RES, f)
  try {
    if (/^resultados_.*\.jsonl$/.test(f)) { for (const l of fs.readFileSync(p, 'utf8').split('\n')) if (l.trim()) { try { registros.push(JSON.parse(l)) } catch { console.error('linha ilegível em', f) } } }
    else if (f.endsWith('.json')) registros.push(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch (e) { console.error('ilegível, pulado:', f, e.message) }
}
const vistos = new Set()
for (const r of registros.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
  if (!r || !r.soft || !(r.idade > 0) || vistos.has(r.id)) continue
  vistos.add(r.id)
  const o = { id: r.id, base: r.base, sitio: r.sitio, idade: r.idade, sexo: r.sexo, fabricante: r.fabricante, modelo: r.modelo, campo: r.campo, vic: r.vic, vicAviso: r.vicAviso ? 1 : 0 }
  for (const [k, g] of Object.entries(FENOTIPOS)) o[k] = g(r.soft)
  Object.assign(o, zAtual(r.soft, r.idade, r.sexo))
  linhas.push(o)
}
const cols = [...new Set(linhas.flatMap(Object.keys))]
const esc = (x) => x == null ? 'NA' : typeof x === 'string' ? `"${x.replace(/"/g, '""')}"` : (typeof x === 'number' && !isFinite(x)) ? 'NA' : String(x)
fs.writeFileSync(SAIDA, [cols.join(','), ...linhas.map(l => cols.map(c => esc(l[c])).join(','))].join('\n') + '\n')
console.log(linhas.length, 'exames →', SAIDA)
