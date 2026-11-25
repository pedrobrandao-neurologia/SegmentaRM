#!/usr/bin/env node
// Lote OFFLINE das normas próprias (docs/normas-proprias.md): para cada exame do manifesto
// (tools/normas_selecao.py), baixa o T1 do S3 público, mede com o SynthSeg do app
// (tools/synthseg_node.mjs: bloco 128³, sobreposição 64, espelhamento E/D, volume suave) e o VIC
// do app (conformação do NiiVue vendorizado + lib/icv.js), grava só os números e APAGA a imagem.
// Nada disso roda no app; nenhuma imagem fica guardada. Entradas com "arquivo" (exames locais,
// tools/normas_local.py) são lidas no lugar, sem download, e nunca apagadas.
//
//   NODE_PATH=<node_modules com @tensorflow/tfjs-node@4.22.0> \
//   node tools/normas_lote.mjs manifesto.json <pasta de saída> [--previos <pasta>] [--t1 <pasta>] [--fatia k/n]
//
//   --previos: resultados antigos do tools/lote_synthseg_node.mjs (mesmo SynthSeg), por id sem o
//              prefixo da base — reaproveita os volumes e só mede o VIC;
//   --t1:      pasta com T1 já baixados (<id sem prefixo>_T1w.nii.gz), usados antes do download;
//   --fatia k/n: só os exames de posição ≡ k (mod n) — n processos em paralelo, sem colisão;
//   --jsonl <pasta>: além do <id>.json, acrescenta uma linha compacta por exame (volumes suaves,
//              VIC e metadados) em <pasta>/resultados_f<k>de<n>.jsonl. Esses arquivos são o
//              registro DURÁVEL (versione-os): a retomada considera feito o que já está neles,
//              mesmo numa máquina nova sem a pasta de saída. Falhas vão para <saída>/erros.jsonl.
// O download vai 3 exames à frente (curl, respeita o proxy do ambiente). Pode parar e retomar.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { carregarSynthSeg, segmentar, RAIZ } from './synthseg_node.mjs'

const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null }
const PREVIOS = opt('--previos'); const T1LOCAL = opt('--t1')
const [FK, FN] = (opt('--fatia') || '0/1').split('/').map(Number)
const JSONL = opt('--jsonl')
const [MAN, RES] = args
if (!MAN || !RES) { console.error('uso: node tools/normas_lote.mjs manifesto.json <saída> [--previos dir] [--t1 dir]'); process.exit(2) }
fs.mkdirSync(RES, { recursive: true })
const TMP = path.join(RES, '.t1'); fs.mkdirSync(TMP, { recursive: true })
const man = JSON.parse(fs.readFileSync(MAN, 'utf8'))
const curto = (e) => e.id.slice(e.base.length + 1)

const pesos = crypto.createHash('sha256')
for (const f of fs.readdirSync(path.join(RAIZ, 'models/synthseg1')).sort()) pesos.update(fs.readFileSync(path.join(RAIZ, 'models/synthseg1', f)))
const SHA_PESOS = pesos.digest('hex')

function baixar (url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = dest + '.part'
    const p = spawn('curl', ['-sSfL', '--retry', '4', '--retry-delay', '5', '-o', tmp, url], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''; p.stderr.on('data', d => { err += d })
    p.on('close', c => { if (c === 0) { fs.renameSync(tmp, dest); resolve(dest) } else { try { fs.unlinkSync(tmp) } catch {} reject(new Error('curl ' + c + ' ' + err.trim())) } })
  })
}
const pendentes = new Map()
function obter (e) {
  // exame local (OASIS-3, controles do serviço — tools/normas_local.py): lido no lugar, nunca apagado
  if (e.arquivo) return Promise.resolve({ arq: e.arquivo, local: true })
  if (T1LOCAL) { const l = path.join(T1LOCAL, curto(e) + '_T1w.nii.gz'); if (fs.existsSync(l)) return Promise.resolve({ arq: l, local: true }) }
  const dest = path.join(TMP, e.id + '_T1w.nii.gz')
  // download que falha sai da fila: o exame tenta de novo quando chegar a vez dele
  if (!pendentes.has(e.id)) pendentes.set(e.id, fs.existsSync(dest) ? Promise.resolve(dest) : baixar(e.url, dest).catch(err => { pendentes.delete(e.id); throw err }))
  return pendentes.get(e.id).then(arq => ({ arq, local: false }))
}

// VIC exatamente como no app: NVImage → conform(…, false, true, false, false) → estimaVIC
globalThis.require = globalThis.require || (await import('node:module')).createRequire(import.meta.url)
const { Niivue, NVImage } = await import(path.join(RAIZ, 'vendor/niivue.js'))
const { carregaTemplate, estimaVIC } = await import(path.join(RAIZ, 'lib/icv.js'))
const tpl = await carregaTemplate()
const silencio = console.log
async function medirVIC (arq) {
  const b = fs.readFileSync(arq)
  console.log = () => {} // o NiiVue registra cada reescala
  try {
    const v = await NVImage.new(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path.basename(arq))
    const c = await Niivue.prototype.conform.call(Object.create(Niivue.prototype), v, false, true, false, false)
    const r = estimaVIC({ img: c.img, dims: c.hdr.dims.slice(1, 4), affine: c.hdr.affine, tpl })
    return { vic: r.vic_mm3, vicAviso: r.aviso || null }
  } finally { console.log = silencio }
}

const rede = await carregarSynthSeg()
// feito = linha válida no registro durável (qualquer fatia) ou <id>.json íntegro; um JSON truncado
// por queda no meio da escrita NÃO conta (antes a retomada o pulava e a tabela quebrava depois)
const feitos = new Set()
if (JSONL) {
  fs.mkdirSync(JSONL, { recursive: true })
  for (const f of fs.readdirSync(JSONL).filter(f => /^resultados_.*\.jsonl$/.test(f))) {
    for (const l of fs.readFileSync(path.join(JSONL, f), 'utf8').split('\n')) {
      if (!l.trim()) continue
      try { const o = JSON.parse(l); if (o && o.id && o.soft) feitos.add(o.id) } catch { /* linha cortada */ }
    }
  }
}
const integro = (p) => { try { const o = JSON.parse(fs.readFileSync(p, 'utf8')); return !!(o && o.soft) } catch { return false } }
const todo = man.filter((e, i) => i % FN === FK && !feitos.has(e.id) && !integro(path.join(RES, e.id + '.json')))
const ARQ_JSONL = JSONL ? path.join(JSONL, `resultados_f${FK}de${FN}.jsonl`) : null
let nOk = 0; const erros = []
console.log(`${man.length} no manifesto, ${todo.length} a fazer; pesos ${SHA_PESOS.slice(0, 12)}`)
for (let i = 0; i < todo.length; i++) {
  const e = todo[i]
  for (const f of todo.slice(i + 1, i + 4)) if (!(PREVIOS && fs.existsSync(path.join(PREVIOS, curto(f) + '.json')))) obter(f).catch(() => {})
  const t0 = Date.now()
  let arq = null; let local = false
  try {
    ({ arq, local } = await obter(e))
    const prev = PREVIOS && path.join(PREVIOS, curto(e) + '.json')
    let r
    if (prev && fs.existsSync(prev)) {
      const p = JSON.parse(fs.readFileSync(prev, 'utf8'))
      r = { soft: p.soft, hard: p.hard, voxGrid: p.voxGrid, dimsNat: p.dimsNat, nTiles: p.nTiles, reaproveitado: true }
    } else r = await segmentar(rede, arq, { tile: 128 })
    const vic = await medirVIC(arq)
    const meta = { base: e.base, sujeito: e.sujeito, sitio: e.sitio, idade: e.idade, sexo: e.sexo, fabricante: e.fabricante, modelo: e.modelo, campo: e.campo }
    const reg = { id: e.id, ...meta, ...r, ...vic, tile: 128, pesos: SHA_PESOS, s: (Date.now() - t0) / 1000 }
    // escrita atômica: grava ao lado e renomeia
    const dest = path.join(RES, e.id + '.json')
    fs.writeFileSync(dest + '.tmp', JSON.stringify(reg)); fs.renameSync(dest + '.tmp', dest)
    if (ARQ_JSONL) { const { hard, ...compacto } = reg; fs.appendFileSync(ARQ_JSONL, JSON.stringify({ ...compacto, pesos: SHA_PESOS.slice(0, 12) }) + '\n') }
    nOk++
    console.log(e.id, 'ok', ((Date.now() - t0) / 1000).toFixed(0) + 's', 'VIC', (vic.vic / 1000).toFixed(0), vic.vicAviso ? '⚠ ' + vic.vicAviso : '')
  } catch (err) {
    console.log(e.id, 'ERRO', err.message)
    erros.push(e.id)
    fs.appendFileSync(path.join(RES, 'erros.jsonl'), JSON.stringify({ id: e.id, erro: String(err.message).slice(0, 300), url: e.url || null }) + '\n')
  } finally {
    if (arq && !local) { try { fs.unlinkSync(arq) } catch {} }
    pendentes.delete(e.id)
  }
}
console.log(`fim: ${nOk} ok, ${erros.length} com erro${erros.length ? ' (' + erros.slice(0, 20).join(', ') + '; ver erros.jsonl)' : ''}`)
process.exit(erros.length ? 1 : 0)
