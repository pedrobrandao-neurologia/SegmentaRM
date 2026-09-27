#!/usr/bin/env node
// Recentragem pelo método (nível A), OFFLINE: controles saudáveis do DLBS medidos com o SynthSeg
// do app ficam, contra cada norma embarcada, deslocados de m(t, sexo) em z; o app desconta esse
// deslocamento do z do paciente (lib/normative.js › recentragemZ). O z é calculado com o MESMO
// código e as MESMAS tabelas do app (lib/normative.js), então o ajuste vale exatamente para elas.
//
//   python3 tools/referencias_dlbs.py … --trabalho <pasta>      (prepara os volumes por sujeito)
//   node tools/recentragem_dlbs.mjs --trabalho <pasta> [--bootstrap 2000]
//     → models/normative/recentragem_synthseg.json e docs/validacao/dlbs.md
//
// Modelo, por estrutura (e por hemisfério nas subcorticais): z_cru = a + c·t + d·t² + e·[M] + ε,
// t = idade − 60 presa à faixa do DLBS, mínimos quadrados depois de excluir falhas grosseiras
// (|resíduo| > 5 DP robustos). Escala do z inalterada (a da norma). Incerteza: covariância
// bootstrap por sujeito (semente fixa). Validação: 10 partes por sujeito (média por terço de idade)
// e um conjunto externo de outro scanner (adultos jovens do OpenNeuro).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const TRAB = val('--trabalho')
if (!TRAB) { console.error('uso: node tools/recentragem_dlbs.mjs --trabalho <pasta> [--bootstrap 2000]'); process.exit(2) }
const B = +val('--bootstrap', '2000')
const SAIDA = val('--saida', path.join(RAIZ, 'models/normative/recentragem_synthseg.json'))
const RELATORIO = val('--relatorio', path.join(RAIZ, 'docs/validacao/dlbs.md'))

globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(RAIZ, String(u).replace(/^\.\//, '')), 'utf8')) })
const N = await import(path.join(RAIZ, 'lib/normative.js'))
await N.loadNorms()

const dlbs = JSON.parse(fs.readFileSync(path.join(TRAB, 'dlbs_pares.json'), 'utf8'))
const ext = JSON.parse(fs.readFileSync(path.join(TRAB, 'externo_pares.json'), 'utf8'))
const IDADE_REF = dlbs.idadeRef || 60
const FAIXA = dlbs.idadeFaixa

// z de um conjunto de volumes (chaves do app) contra as normas embarcadas, sem ajuste nenhum
const GLOB = ['CortexVol', 'CerebralWhiteMatterVol', 'SubCortGrayVol', 'VentricleVol']
function zs (v, idade, sexo) {
  const stats = {
    composites: GLOB.filter(k => v[k] > 0).map(id => ({ id, volMm3: v[id] })),
    rows: Object.keys(v).filter(k => /^(Left|Right)-/.test(k) && v[k] > 0).map(name => ({ name, volMm3: v[name], group: 'subcortical', hemi: /^Left/.test(name) ? 'E' : 'D' }))
  }
  const n = N.compareToNorms(stats, { age: idade, sex: sexo }, { erroMedida: null })
  const o = {}
  for (const it of [...n.globals, ...(n.subcorticais || [])]) if (isFinite(it.z)) o[it.chave] = it.z
  return o
}
const suj = dlbs.pares.map(p => ({ ...p, zss: zs(p.ss, p.idade, p.sexo), zfs: zs(Object.fromEntries(Object.entries(p.fs).filter(([, x]) => x > 0)), p.idade, p.sexo) }))
const sujE = ext.pares.map(p => ({ ...p, zss: zs(p.ss, p.idade, p.sexo), zfs: zs(p.fs, p.idade, p.sexo) }))

// ---------- álgebra mínima ----------
const lin = (idade, sexo) => { const t = Math.min(FAIXA[1], Math.max(FAIXA[0], idade)) - IDADE_REF; return [1, t, t * t, sexo === 'M' ? 1 : 0] }
function mqo (X, y) {
  const p = X[0].length
  const A = Array.from({ length: p }, () => new Array(p).fill(0)); const b = new Array(p).fill(0)
  for (let i = 0; i < X.length; i++) for (let j = 0; j < p; j++) { b[j] += X[i][j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += X[i][j] * X[i][k] }
  for (let c = 0; c < p; c++) {
    let piv = c
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    ;[A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]]
    for (let r = 0; r < p; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < p; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  return b.map((v, i) => v / A[i][i])
}
const dot = (x, b) => x.reduce((a, v, i) => a + v * b[i], 0)
const media = (a) => a.reduce((x, y) => x + y, 0) / a.length
const dp = (a) => { const m = media(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) }
function prng (seed) { // mulberry32
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function robustos (v) {
  const s = v.slice().sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)]
  const dev = v.map(x => Math.abs(x - med)).sort((a, b) => a - b); const mad = 1.4826 * dev[Math.floor(dev.length / 2)]
  return v.map(x => mad > 0 ? Math.abs(x - med) <= 5 * mad : true)
}

// ---------- ajuste por estrutura ----------
// terços de idade: os mesmos cortes da comparação com o FreeSurfer (referencias_dlbs.py), se houver
const diagPy = fs.existsSync(path.join(TRAB, 'dlbs_diag.json')) ? JSON.parse(fs.readFileSync(path.join(TRAB, 'dlbs_diag.json'), 'utf8')) : null
const idadesOrd = suj.map(s => s.idade).sort((a, b) => a - b)
const cortesPy = diagPy && diagPy.comparacaoFS && Object.values(diagPy.comparacaoFS)[0] && Object.values(diagPy.comparacaoFS)[0].tercos_idade
const terc = cortesPy || [idadesOrd[Math.floor(idadesOrd.length / 3)], idadesOrd[Math.floor(2 * idadesOrd.length / 3)]]
const tercoDe = (idade) => idade <= terc[0] ? 0 : idade <= terc[1] ? 1 : 2
const chaves = [...new Set(suj.flatMap(s => Object.keys(s.zss)))]
const estruturas = {}; const diag = {}
for (const chave of chaves) {
  let dados = suj.filter(s => s.zss[chave] != null)
  const X0 = dados.map(s => lin(s.idade, s.sexo)); const y0 = dados.map(s => s.zss[chave])
  const b0 = mqo(X0, y0)
  const ok = robustos(y0.map((y, i) => y - dot(X0[i], b0)))
  const excluidos = ok.filter(x => !x).length
  dados = dados.filter((_, i) => ok[i])
  const X = dados.map(s => lin(s.idade, s.sexo)); const y = dados.map(s => s.zss[chave])
  const beta = mqo(X, y)
  // bootstrap por sujeito
  const rnd = prng(20260927 + chave.length)
  const boots = []
  for (let k = 0; k < B; k++) {
    const idx = Array.from({ length: dados.length }, () => Math.floor(rnd() * dados.length))
    boots.push(mqo(idx.map(i => X[i]), idx.map(i => y[i])))
  }
  const mb = [0, 1, 2, 3].map(j => media(boots.map(bb => bb[j])))
  const cov = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => boots.reduce((a, bb) => a + (bb[i] - mb[i]) * (bb[j] - mb[j]), 0) / (B - 1)))
  // validação cruzada de 10 partes (ordem embaralhada com semente fixa)
  const ordem = dados.map((_, i) => i); const r2 = prng(7 + chave.length)
  for (let i = ordem.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1));[ordem[i], ordem[j]] = [ordem[j], ordem[i]] }
  const parte = new Array(dados.length); ordem.forEach((i, k) => { parte[i] = k % 10 })
  const cv = new Array(dados.length)
  for (let f = 0; f < 10; f++) {
    const tr = dados.map((_, i) => i).filter(i => parte[i] !== f)
    const bf = mqo(tr.map(i => X[i]), tr.map(i => y[i]))
    dados.forEach((_, i) => { if (parte[i] === f) cv[i] = y[i] - dot(X[i], bf) })
  }
  const porTerco = (vals, arr) => [0, 1, 2].map(q => media(arr.map((d, i) => [d, vals[i]]).filter(([d]) => tercoDe(d.idade) === q).map(([, v]) => v)))
  // conjunto externo
  const e = sujE.filter(s => s.zss[chave] != null)
  const eRec = e.map(s => s.zss[chave] - dot(lin(s.idade, s.sexo), beta))
  const r4 = (v) => +v.toFixed(4)
  estruturas[chave] = {
    a: r4(beta[0]), c: +beta[1].toPrecision(5), d: +beta[2].toPrecision(5), e: r4(beta[3]),
    cov: cov.map(row => row.map(v => +v.toPrecision(4))), n: dados.length, excluidos, dpResiduo: +dp(cv).toFixed(3)
  }
  const comFs = suj.filter(s => s.zfs[chave] != null)
  const zfsD = comFs.map(s => s.zfs[chave])
  diag[chave] = {
    n: dados.length, excluidos,
    dlbsCru: [media(y), dp(y)], dlbsFs: zfsD.length ? [media(zfsD), dp(zfsD)] : null,
    fsTercos: zfsD.length ? porTerco(zfsD, comFs) : null,
    cruTercos: porTerco(y, dados), vcTercos: porTerco(cv, dados), dpVc: dp(cv),
    desloc30F: dot(lin(30, 'F'), beta), desloc60F: dot(lin(60, 'F'), beta), desloc85F: dot(lin(85, 'F'), beta), sexoM: beta[3],
    externo: e.length ? { n: e.length, cru: [media(e.map(s => s.zss[chave])), dp(e.map(s => s.zss[chave]))], recentrado: [media(eRec), dp(eRec)], fs: sujE.some(s => s.zfs[chave] != null) ? media(sujE.filter(s => s.zfs[chave] != null).map(s => s.zfs[chave])) : null } : null
  }
}

// ---------- saída ----------
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, p))).digest('hex')
const recentragem = {
  versao: '1.0', gerado: new Date().toISOString().slice(0, 10),
  fonte: dlbs.fonte, fonteCurta: dlbs.fonteCurta, n: dlbs.n, idadeRef: IDADE_REF, idadeFaixa: FAIXA, sexo: dlbs.sexo,
  metodo: 'z recentrado: z − (a + c·t + d·t² + e·[M]), t = idade − 60 (presa à faixa do DLBS); a, c, d, e = desvio médio, em z, dos controles do DLBS medidos com o SynthSeg 1.0 do SegmentaRM (volume suave) contra esta norma; escala do z inalterada; cov = covariância bootstrap por sujeito de (a, c, d, e)',
  medida: 'SynthSeg 1.0 do SegmentaRM, volume suave, espelhamento E/D',
  dominio: { fabricante: 'Philips', campoT: 3, descricao: 'Philips 3 T, MPRAGE (TFE) 1 mm, TR 8,4 ms / TE 3,9 ms (DLBS)' },
  normasSha256: { brainchart: sha('models/normative/brainchart.json'), subcortical: sha('models/normative/subcortical.json') },
  ativoPorPadrao: true,
  estruturas
}
fs.writeFileSync(SAIDA, JSON.stringify(recentragem, null, 1) + '\n')

// ---------- relatório ----------
const f1 = (v) => v == null || !isFinite(v) ? '—' : (Math.abs(v) < 0.005 ? '0,00' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace('.', ','))
const f2 = (v, d = 2) => v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ',')
const NOMES = { CortexVol: 'Córtex cerebral (GMV)', CerebralWhiteMatterVol: 'Substância branca (WMV)', SubCortGrayVol: 'Cinzenta subcortical (sGMV)', VentricleVol: 'Ventrículos', TCV: 'Cérebro total (TCV)' }
const PT = { Thalamus: 'Tálamo', Caudate: 'Caudado', Putamen: 'Putâmen', Pallidum: 'Pálido', Hippocampus: 'Hipocampo', Amygdala: 'Amígdala', 'Accumbens-area': 'Accumbens' }
const nome = (k) => NOMES[k] || (() => { const [h, ...b] = k.split('-'); return `${PT[b.join('-')] || b.join('-')} ${h === 'Left' ? 'E' : 'D'}` })()
const absMedia = (sel) => media(Object.values(diag).map(sel).filter(v => v != null && isFinite(v)).map(Math.abs))
const L = []
L.push('# Recentragem pelo método e referências do mesmo método (DLBS)', '')
L.push('_Gerado por `tools/referencias_dlbs.py` e `tools/recentragem_dlbs.mjs` — não edite à mão; rode os scripts de novo._', '')
L.push(`**Amostra:** ${dlbs.n} controles saudáveis do Dallas Lifespan Brain Study (onda 1; ${FAIXA[0]}–${FAIXA[1]} anos; ${dlbs.sexo.F} F / ${dlbs.sexo.M} M; Philips 3 T MPRAGE), ` +
  'OpenNeuro ds004856 (CC0; Park et al., *Sci Data* 2025), com FreeSurfer 5.3 editado à mão e revisado por outra equipe. **SynthSeg:** o núcleo do app ' +
  '(`lib/synthseg-core.js`) em Node, volume suave, espelhamento E/D — o mesmo valor principal do app. **Conjunto externo:** ' +
  `${sujE.length} adultos jovens (19–30 anos) do OpenNeuro ds000001/ds000005, outro scanner, com FreeSurfer 6.0.1 dos derivados públicos do OpenNeuro. Todos os z usam as tabelas e o código do app.`, '')
L.push('## Por que recentrar, e não traduzir para a escala do FreeSurfer', '')
L.push('z médio (DP) de pessoas **saudáveis** contra as normas embarcadas — o esperado, se o método e a norma estivessem na mesma escala, é média 0 e DP 1. ' +
  'O próprio FreeSurfer fica longe disso no córtex (GMV do BrainChart), nos dois conjuntos, e em várias subcorticais no DLBS. Traduzir o SynthSeg para a ' +
  'escala do FreeSurfer 5.3 levaria os controles, por construção, aos z das colunas do FreeSurfer — herdaria esses desvios. O nível A recentra contra a ' +
  '**própria norma**, com controles medidos pelo mesmo método do paciente.', '')
L.push(`| Medida | DLBS: SynthSeg cru | DLBS: FreeSurfer 5.3 | FreeSurfer 5.3, > ${terc[1].toFixed(0)} anos | externo: SynthSeg cru | externo: FreeSurfer 6.0.1 |`, '|---|---:|---:|---:|---:|---:|')
for (const [k, d] of Object.entries(diag)) {
  L.push(`| ${nome(k)} | ${f1(d.dlbsCru[0])} (${f2(d.dlbsCru[1])}) | ${d.dlbsFs ? `${f1(d.dlbsFs[0])} (${f2(d.dlbsFs[1])})` : '—'} | ${d.fsTercos ? f1(d.fsTercos[2]) : '—'} | ${d.externo ? `${f1(d.externo.cru[0])} (${f2(d.externo.cru[1])})` : '—'} | ${d.externo ? f1(d.externo.fs) : '—'} |`)
}
L.push('', '## Recentragem (nível A): validação', '')
L.push('Deslocamento (em z) que o app desconta, para uma mulher aos 30, 60 e 85 anos, e o termo de sexo masculino. Validação cruzada (10 partes) no DLBS: ' +
  'z médio depois da recentragem por terço de idade (o esperado é 0) e DP. Externo: z médio (DP) antes e depois.', '')
L.push(`| Medida | n | desloc. 30 · 60 · 85 anos | masc. | VC por terço (≤ ${terc[0].toFixed(0)} · ${terc[0].toFixed(0)}–${terc[1].toFixed(0)} · > ${terc[1].toFixed(0)}) | DP VC | externo: cru → recentrado |`, '|---|---:|---|---:|---|---:|---|')
for (const [k, d] of Object.entries(diag)) {
  L.push(`| ${nome(k)} | ${d.n}${d.excluidos ? ` (−${d.excluidos})` : ''} | ${[d.desloc30F, d.desloc60F, d.desloc85F].map(f1).join(' · ')} | ${f1(d.sexoM)} | ${d.vcTercos.map(f1).join(' · ')} | ${f2(d.dpVc)} | ${d.externo ? `${f1(d.externo.cru[0])} → ${f1(d.externo.recentrado[0])} (${f2(d.externo.recentrado[1])})` : '—'} |`)
}
L.push('', `**Resumo.** |z| médio dos controles externos: ${f2(absMedia(d => d.externo && d.externo.cru[0]))} sem recentragem → ${f2(absMedia(d => d.externo && d.externo.recentrado[0]))} com recentragem; ` +
  `no terço mais velho do DLBS (> ${terc[1].toFixed(0)} anos), em validação cruzada: ${f2(absMedia(d => d.cruTercos[2]))} → ${f2(absMedia(d => d.vcTercos[2]))}. O que resta no conjunto externo ` +
  '(outro scanner e protocolo, adultos jovens) é o desvio próprio de cada sítio e protocolo — por isso a calibração com controles locais (nível C) continua necessária para uso sério.', '')
L.push(fs.readFileSync(path.join(TRAB, 'dlbs_parte_py.md'), 'utf8'))
L.push('## Como regenerar', '', 'Veja `docs/plano-metodologico.md` ("Como regenerar os coeficientes").', '')
fs.mkdirSync(path.dirname(RELATORIO), { recursive: true })
fs.writeFileSync(RELATORIO, L.join('\n') + '\n')
console.log(`recentragem: ${Object.keys(estruturas).length} medidas, n = ${dlbs.n} → ${path.relative(RAIZ, SAIDA)}; relatório → ${path.relative(RAIZ, RELATORIO)}`)
console.log(`|z| médio externo: ${absMedia(d => d.externo && d.externo.cru[0]).toFixed(2)} → ${absMedia(d => d.externo && d.externo.recentrado[0]).toFixed(2)}; terço mais velho (VC): ${absMedia(d => d.cruTercos[2]).toFixed(2)} → ${absMedia(d => d.vcTercos[2]).toFixed(2)}`)
