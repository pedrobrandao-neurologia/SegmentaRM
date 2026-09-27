#!/usr/bin/env node
// Golden: roda o pipeline REAL (sem inferência simulada) no Chromium em cada exame de
// referência e compara os volumes por estrutura com a referência gravada — toda mudança de
// método aparece como uma diferença percentual por estrutura, em vez de passar despercebida.
//
//   node tests/golden/run.mjs                       todos os exames de tests/golden/exames.json
//   node tests/golden/run.mjs --so exemplo          só um (pelo id)
//   node tests/golden/run.mjs --atualizar           grava a referência (após mudança intencional)
//   node tests/golden/run.mjs --exame x.nii.gz      exame local (referência em tests/golden/.local, fora do git)
//   --dkt   roda também a parcelação DKT      --tol 1   tolerância em % (padrão 0,5)
//   --cpu   backend CPU (lento; a GPU/WebGL é o padrão)
//   --motor node   o MESMO núcleo do SynthSeg (lib/synthseg-core.js) em Node com TensorFlow nativo
//                  (npm i --no-save @tensorflow/tfjs-node@4.22.0): minutos em vez de horas numa
//                  máquina sem GPU; referência própria (<id>.node.json), só volumes por estrutura
//
// Compara o volume RÍGIDO (a segmentação em si) e o PRINCIPAL (suave quando há posteriores):
// uma mudança só no principal indica mudança de convenção de volume, não da segmentação.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RAIZ } from '../browser/comum.mjs'

const args = process.argv.slice(2)
const flag = (k) => args.includes(k)
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const TOL = parseFloat(val('--tol', '0.5'))
const DIR = path.join(RAIZ, 'tests/golden')
const CACHE = process.env.SEGMENTARM_GOLDEN_CACHE || path.join(DIR, '.cache')
fs.mkdirSync(CACHE, { recursive: true })

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')

async function arquivoDo (ex) {
  if (ex.caminho) return path.join(RAIZ, ex.caminho)
  const destino = path.join(CACHE, ex.id + '.nii.gz')
  if (!fs.existsSync(destino) || (ex.sha256 && sha(destino) !== ex.sha256)) {
    console.log(`  baixando ${ex.url}`)
    const r = await fetch(ex.url)
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${ex.url}`)
    fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()))
  }
  if (ex.sha256 && sha(destino) !== ex.sha256) throw new Error(`${ex.id}: SHA-256 diferente do registrado — o arquivo de origem mudou`)
  return destino
}

async function rodar (page, url, arquivo) {
  await page.goto(url + '/index.html')
  await page.waitForFunction(() => /pronto/.test(document.getElementById('console').textContent), null, { timeout: 120000 })
  await page.setInputFiles('#file-nifti', arquivo)
  await page.waitForSelector('#run:not([disabled])', { timeout: 300000 })
  await page.selectOption('#model', 'synthseg')
  if (flag('--cpu')) await page.selectOption('#backend', 'cpu')
  const t0 = Date.now()
  // progresso: a última linha do console do app, no máximo uma a cada 20 s
  let ult = 0; let visto = ''
  const prog = setInterval(async () => {
    const t = await page.evaluate(() => { const c = document.getElementById('console'); return c && c.lastElementChild ? c.lastElementChild.textContent.trim() : '' }).catch(() => '')
    if (t && t !== visto && Date.now() - ult > 20000) { visto = t; ult = Date.now(); console.log(`  [${Math.round((Date.now() - t0) / 1000)} s] ${t.slice(0, 140)}`) }
  }, 5000)
  await page.click('#run')
  await page.waitForFunction(() => window.__segrm.stats && !window.__segrm.running, null, { timeout: 4 * 3600e3, polling: 2000 })
  if (flag('--dkt')) {
    await page.click('#run-dkt')
    await page.waitForFunction(() => /-dkt$/.test(window.__segrm.segKind || '') && !window.__segrm.running, null, { timeout: 4 * 3600e3, polling: 2000 })
  }
  const r = await page.evaluate(() => {
    const S = window.__segrm
    return {
      modelo: S.modelUsed,
      segKind: S.segKind,
      volumeSuave: !!S.stats.volumeSoft,
      estruturas: Object.fromEntries(S.stats.rows.filter(r => r.volMm3 > 0 || r.volHardMm3 > 0).map(r => [r.name, {
        principal: r.volMm3, rigido: r.volHardMm3 != null ? r.volHardMm3 : r.volMm3, suave: r.volSoftMm3 != null ? r.volSoftMm3 : null, metodo: r.metodoVolume || 'rigido'
      }])),
      agregados: Object.fromEntries(S.stats.composites.map(c => [c.id, c.volMm3])),
      vic: S.icv ? S.icv.vic_mm3 : null
    }
  })
  clearInterval(prog)
  r.segundos = Math.round((Date.now() - t0) / 1000)
  return r
}

function comparar (atual, ref) {
  const linhas = []
  for (const [nome, a] of Object.entries(atual.estruturas)) {
    const b = ref.estruturas[nome]
    if (!b) { linhas.push({ nome, dRig: null, dPri: null, nota: 'nova' }); continue }
    const d = (x, y) => y > 0 ? 100 * (x - y) / y : (x > 0 ? Infinity : 0)
    linhas.push({ nome, dRig: d(a.rigido, b.rigido), dPri: d(a.principal, b.principal), nota: a.metodo !== (b.metodo || 'rigido') ? `${b.metodo || 'rigido'} → ${a.metodo}` : '' })
  }
  for (const nome of Object.keys(ref.estruturas)) if (!atual.estruturas[nome]) linhas.push({ nome, dRig: null, dPri: null, nota: 'sumiu' })
  return linhas.sort((x, y) => Math.abs(y.dRig ?? 999) - Math.abs(x.dRig ?? 999))
}

const lista = JSON.parse(fs.readFileSync(path.join(DIR, 'exames.json'), 'utf8')).exames
let exames = lista
if (val('--so')) exames = lista.filter(e => e.id === val('--so'))
if (val('--exame')) exames = [{ id: path.basename(val('--exame')).replace(/\.nii(\.gz)?$/, ''), caminhoAbs: path.resolve(val('--exame')), local: true }]

const NODE = val('--motor') === 'node'
let motor
if (NODE) {
  const { carregarSynthSeg, segmentar } = await import('../../tools/synthseg_node.mjs')
  const rede = await carregarSynthSeg()
  motor = {
    async rodar (arq) {
      const t0 = Date.now()
      const r = await segmentar(rede, arq)
      return {
        modelo: 'SynthSeg 1.0 (núcleo do app em Node, TensorFlow nativo)', segKind: 'synthseg', volumeSuave: true,
        estruturas: Object.fromEntries(Object.keys(r.soft).map(k => [k, { principal: r.soft[k], rigido: r.hard[k] || 0, suave: r.soft[k], metodo: 'suave' }])),
        agregados: {}, vic: null, segundos: Math.round((Date.now() - t0) / 1000)
      }
    },
    async fechar () {}
  }
} else {
  const { servidor, navegador } = await import('../browser/comum.mjs')
  const { srv, url } = await servidor()
  const browser = await navegador()
  motor = {
    async rodar (arq) { const page = await browser.newPage(); try { return await rodar(page, url, arq) } finally { await page.close() } },
    async fechar () { await browser.close(); srv.close() }
  }
}
let falhas = 0
try {
  for (const ex of exames) {
    console.log(`\n== ${ex.id}${ex.fonte ? ' — ' + ex.fonte : ''}`)
    const arq = ex.caminhoAbs || await arquivoDo(ex)
    const atual = await motor.rodar(arq)
    console.log(`  ${atual.modelo} · ${Object.keys(atual.estruturas).length} estruturas · ${atual.segundos} s`)
    const refDir = path.join(DIR, ex.local ? '.local' : 'referencia')
    fs.mkdirSync(refDir, { recursive: true })
    fs.mkdirSync(path.join(DIR, 'resultados'), { recursive: true })
    const sufixo = (flag('--dkt') ? '_dkt' : '') + (NODE ? '.node' : '')
    fs.writeFileSync(path.join(DIR, 'resultados', ex.id + sufixo + '.json'), JSON.stringify(atual, null, 1))
    const refP = path.join(refDir, ex.id + sufixo + '.json')
    if (flag('--atualizar') || !fs.existsSync(refP)) {
      fs.writeFileSync(refP, JSON.stringify(atual, null, 1) + '\n')
      console.log(`  referência gravada em ${path.relative(RAIZ, refP)}`)
      continue
    }
    const ref = JSON.parse(fs.readFileSync(refP, 'utf8'))
    const linhas = comparar(atual, ref)
    const acima = linhas.filter(l => l.dRig == null || Math.abs(l.dRig) > TOL)
    for (const l of linhas.slice(0, 12)) {
      console.log(`  ${l.nome.padEnd(34)} rígido ${l.dRig == null ? '   —  ' : (l.dRig >= 0 ? '+' : '') + l.dRig.toFixed(2) + '%'}   principal ${l.dPri == null ? '—' : (l.dPri >= 0 ? '+' : '') + l.dPri.toFixed(2) + '%'} ${l.nota}`)
    }
    console.log(acima.length ? `  ${acima.length} estrutura(s) com |Δ rígido| > ${TOL}%` : `  segmentação estável (todas as estruturas com |Δ rígido| ≤ ${TOL}%)`)
    falhas += acima.length
  }
} finally {
  await motor.fechar()
}
process.exit(falhas ? 1 : 0)
