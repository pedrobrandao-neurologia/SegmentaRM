#!/usr/bin/env node
// Equivalência entre os motores do SynthSeg: o navegador (o app: tfjs no WebGL, ou no backend
// CPU quando não há WebGL) e o TensorFlow nativo do Node (tools/synthseg_node.mjs, com que o
// lote do DLBS foi medido e a recentragem, ajustada). O exame inteiro no navegador de uma
// máquina sem GPU leva horas; aqui a comparação é direta, num bloco REAL do exame:
//
//   1. o exame passa pelo pré-processamento oficial do núcleo (lib/synthseg-core.js), e o bloco
//      central da grade que o app usaria nesta GPU (o tamanho sai do limite de textura, como no
//      workers/synthseg.worker.js; sobreposição como no runSynthSeg) vai, idêntico, aos motores;
//   2. cada motor roda a rede, a suavização σ = 0,5 e o top-3 do app (makeTilePredictor, sem o
//      espelhamento, que só reordena), quantizados como no app;
//   3. compara o rótulo (argmax), a posterior máxima e o volume suave e rígido por estrutura
//      depois do pós-processamento do app, dentro do bloco.
//
//   node tests/golden/motores.mjs [--so exemplo] [--f16] [--cpu]
//   node tests/golden/motores.mjs --tamanho 96 [--so exemplo]
//
// --f16          repete no WebGL forçado a texturas de 16 bits (GPUs sem float32 renderizável)
// --cpu          repete no backend CPU do tfjs no navegador (o app sem WebGL)
// --tamanho 96   segmenta o exame inteiro em Node com blocos de 96³ (o app na variante "memória
//                baixa" ou numa GPU com texturas de até 8192²) e compara com a referência de 128³
// --lado 64      bloco de outro tamanho (64: teste rápido do script)
//
// Requer o @tensorflow/tfjs-node 4.22.0 (npm i --no-save, ou NODE_PATH apontando para ele).
import fs from 'node:fs'
import path from 'node:path'
import { RAIZ, servidor, navegador } from '../browser/comum.mjs'
import { carregarSynthSeg, lerNifti, segmentar } from '../../tools/synthseg_node.mjs'
import {
  officialPreprocess, robustRescale, boundingBox, alignBoxToGrid, extractBox, tileGrid,
  makeTilePredictor, postprocessSegmentation
} from '../../lib/synthseg-core.js'

const args = process.argv.slice(2)
const flag = (k) => args.includes(k)
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const DIR = path.join(RAIZ, 'tests/golden')
const CACHE = process.env.SEGMENTARM_GOLDEN_CACHE || path.join(DIR, '.cache')
const ex = JSON.parse(fs.readFileSync(path.join(DIR, 'exames.json'), 'utf8')).exames.find(e => e.id === val('--so', 'exemplo'))
if (!ex) throw new Error('exame desconhecido: ' + val('--so'))
const arq = ex.caminho ? path.join(RAIZ, ex.caminho) : path.join(CACHE, ex.id + '.nii.gz')
if (!fs.existsSync(arq)) throw new Error(`${arq} ausente: rode antes node tests/golden/run.mjs --motor node --so ${ex.id}`)
const labels = JSON.parse(fs.readFileSync(path.join(RAIZ, 'models/synthseg1/labels.json'), 'utf8'))
const K = 3, QMAX = 65535
const pct = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d) + '%'
const saida = { exame: ex.id }
fs.mkdirSync(path.join(DIR, 'resultados'), { recursive: true })
const gravar = (nome) => fs.writeFileSync(path.join(DIR, 'resultados', nome), JSON.stringify(saida, null, 1) + '\n')

const rede = await carregarSynthSeg()

if (val('--tamanho')) {
  // exame inteiro em Node com outro tamanho de bloco × a referência gravada (128³)
  const T = parseInt(val('--tamanho'), 10)
  const t0 = Date.now()
  const r = await segmentar(rede, arq, { tile: T })
  const ref = JSON.parse(fs.readFileSync(path.join(DIR, 'referencia', ex.id + '.node.json'), 'utf8'))
  const linhas = Object.entries(ref.estruturas)
    .filter(([k, e]) => e.suave > 0 && r.soft[k] != null)
    .map(([k, e]) => ({ k, ref: e.suave, novo: r.soft[k], d: 100 * (r.soft[k] - e.suave) / e.suave, dRig: e.rigido ? 100 * ((r.hard[k] || 0) - e.rigido) / e.rigido : null }))
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  const abs = linhas.map(l => Math.abs(l.d)).sort((a, b) => a - b)
  console.log(`\n== ${ex.id}: blocos de ${T}³ (${r.nTiles} blocos, ${Math.round((Date.now() - t0) / 1000)} s) × referência de 128³ — volume suave`)
  for (const l of linhas.slice(0, 10)) console.log(`  ${l.k.padEnd(34)} ${pct(l.d)}   (rígido ${l.dRig == null ? '—' : pct(l.dRig)})`)
  console.log(`  mediana |Δ| ${abs[abs.length >> 1].toFixed(2)}% · máximo ${abs[abs.length - 1].toFixed(2)}% (${linhas[0].k})`)
  Object.assign(saida, { tamanho: T, nTiles: r.nTiles, medianaAbsPct: abs[abs.length >> 1], maxAbsPct: abs[abs.length - 1], estruturas: linhas })
  gravar(`motores-${ex.id}-bloco${T}.json`)
  process.exit(0)
}

// o motor do navegador: o mesmo núcleo, com o tfjs vendorizado do app (roda dentro da página)
async function motorNavegador ({ modo, backend, f16, B, K }) {
  const tf = await import('/vendor/tf.fesm.min.js')
  const { registerUpSampling3D } = await import('/lib/tfjs-upsampling3d.js')
  const core = await import('/lib/synthseg-core.js')
  registerUpSampling3D(tf)
  // sem GPU, o WebGL do Chromium é o SwiftShader (software), que o tfjs recusa por padrão
  // (failIfMajorPerformanceCaveat) — o app então cai no backend CPU; aqui ele é aceito
  tf.env().set('SOFTWARE_WEBGL_ENABLED', true)
  if (f16) tf.env().set('WEBGL_FORCE_F16_TEXTURES', true)
  if (!(await tf.setBackend(backend).catch(() => false))) throw new Error(`backend ${backend} indisponível`)
  await tf.ready()
  tf.enableProdMode()
  const info = { backend: tf.getBackend() }
  if (backend === 'webgl') {
    const env = tf.env()
    let renderer = '?'
    try { const gl = tf.backend().gpgpu.gl; const e = gl.getExtension('WEBGL_debug_renderer_info'); renderer = String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) } catch { /* sem informação do driver */ }
    Object.assign(info, { webgl: env.getNumber('WEBGL_VERSION'), float32: env.getBool('WEBGL_RENDER_FLOAT32_ENABLED'), f16: env.getBool('WEBGL_FORCE_F16_TEXTURES'), maxTex: env.getNumber('WEBGL_MAX_TEXTURE_SIZE'), renderer })
  }
  if (modo === 'info') return { info }
  const model = await tf.loadLayersModel('/models/synthseg1/model.json')
  const block = new Float32Array(await (await fetch('/_bloco.f32')).arrayBuffer())
  const pred = core.makeTilePredictor(tf, model, { flip: false, sigma: 0.5, K })
  const t0 = performance.now()
  const { idx, val } = await pred(block, B, { x0: 0, x1: B[0], y0: 0, y1: B[1], z0: 0, z1: B[2] })
  const segundos = (performance.now() - t0) / 1000
  pred.dispose(); model.dispose()
  const q = new Uint16Array(val.length)
  for (let i = 0; i < val.length; i++) { const x = Math.round(val[i] * 65535); q[i] = x < 0 ? 0 : x > 65535 ? 65535 : x }
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }
  return { info, segundos, idx: b64(idx), val: b64(new Uint8Array(q.buffer)) }
}

const { srv, url } = await servidor()
const browser = await navegador()
async function naPagina (arg, bloco = null) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('  [navegador]', e.message))
  await page.route('**/_vazio.html', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>motores</title>' }))
  if (bloco) await page.route('**/_bloco.f32', r => r.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(bloco.buffer) }))
  await page.goto(url + '/_vazio.html')
  try { return await page.evaluate(motorNavegador, arg) } finally { await ctx.close() }
}

try {
  // 1. o bloco que o worker do app usaria nesta GPU, no pré-processamento oficial
  let gl = null
  try { gl = (await naPagina({ modo: 'info', backend: 'webgl', K })).info } catch (e) { console.log('  sem WebGL neste navegador:', e.message) }
  let T = parseInt(val('--lado', '0'), 10)
  if (!T) { T = 128; if (gl) while (T > 32 && T ** 3 * 72 > gl.maxTex * gl.maxTex) T -= 32 }
  let ov = 64 // o app pede 64; o runSynthSeg aumenta para blocos < 128 e limita ao bloco
  if (T < 128) ov = Math.max(ov, T - 32)
  ov = Math.min(ov, Math.max(T - 32, T / 2))

  const nat = lerNifti(arq)
  const pre = officialPreprocess(nat.data, nat.dims, nat.affine)
  const norm = robustRescale(pre.data, { inPlace: true })
  const box = alignBoxToGrid(boundingBox(norm, pre.dims, 0.02, 16), pre.dims)
  const crop = extractBox(norm, pre.dims, box)
  const [nx, ny] = box.size
  const meio = (n) => { const g = tileGrid(n, T, ov); return g[g.length >> 1] }
  const [tx, ty, tz] = box.size.map(meio)
  const c32 = (n) => Math.ceil(n / 32) * 32
  const B = [c32(tx.size), c32(ty.size), c32(tz.size)]
  const [bw, bh, bd] = B
  const N = bw * bh * bd
  const block = new Float32Array(N)
  for (let i = 0; i < tx.size; i++) {
    for (let j = 0; j < ty.size; j++) {
      const dst = (i * bh + j) * bd
      let src = tz.start * nx * ny + (ty.start + j) * nx + tx.start + i
      for (let k = 0; k < tz.size; k++, src += nx * ny) block[dst + k] = crop[src]
    }
  }
  console.log(`\n== ${ex.id}: recorte ${box.size.join('×')} @ 1 mm; bloco central ${B.join('×')} (grade de ${T}³, sobreposição ${ov}) em (${tx.start}, ${ty.start}, ${tz.start})`)
  Object.assign(saida, { recorte: box.size, bloco: { tamanho: B, grade: T, sobreposicao: ov, inicio: [tx.start, ty.start, tz.start] } })

  // saída do preditor (x, y, z, k; z mais rápido) → layout do tiledSegment (x mais rápido)
  const layout = (idx, valQ) => {
    const topIdx = new Uint8Array(N * K), topVal = new Uint16Array(N * K)
    let r = 0
    for (let x = 0; x < bw; x++) {
      for (let y = 0; y < bh; y++) {
        for (let z = 0; z < bd; z++, r += K) {
          const o = ((z * bh + y) * bw + x) * K
          for (let k = 0; k < K; k++) { topIdx[o + k] = idx[r + k]; topVal[o + k] = valQ[r + k] }
        }
      }
    }
    return { topIdx, topVal }
  }
  const quantizar = (v) => { const q = new Uint16Array(v.length); for (let i = 0; i < v.length; i++) { const x = Math.round(v[i] * QMAX); q[i] = x < 0 ? 0 : x > QMAX ? QMAX : x } return q }

  // 2. motor Node (a referência)
  const predN = makeTilePredictor(rede.tf, rede.model, { flip: false, sigma: 0.5, K })
  const t0 = Date.now()
  const rn = await predN(block, B, { x0: 0, x1: bw, y0: 0, y1: bh, z0: 0, z1: bd })
  predN.dispose()
  const node = { ...layout(rn.idx, quantizar(rn.val)), segundos: (Date.now() - t0) / 1000 }
  console.log(`  Node (TensorFlow nativo): ${node.segundos.toFixed(1)} s`)

  // 3. comparação com o Node
  const comparar = (a, b) => {
    let igual = 0, tecido = 0, igualT = 0
    const dp = new Float32Array(N); let nD = 0
    for (let v = 0; v < N; v++) {
      const o = v * K, ia = a.topIdx[o], ib = b.topIdx[o]
      const t = ia !== 0 || ib !== 0
      if (t) tecido++
      if (ia === ib) { igual++; if (t) igualT++; dp[nD++] = Math.abs(a.topVal[o] - b.topVal[o]) / QMAX }
    }
    const ds = dp.subarray(0, nD).sort()
    const ppA = postprocessSegmentation({ topIdx: a.topIdx, topVal: a.topVal, K, dims: B })
    const ppB = postprocessSegmentation({ topIdx: b.topIdx, topVal: b.topVal, K, dims: B })
    const nA = new Float64Array(32), nB = new Float64Array(32), nAB = new Float64Array(32)
    for (let v = 0; v < N; v++) { nA[ppA.seg[v]]++; nB[ppB.seg[v]]++; if (ppA.seg[v] === ppB.seg[v]) nAB[ppA.seg[v]]++ }
    const est = []
    for (let c = 1; c < 32; c++) {
      if (!(ppA.volumes[c] >= 500)) continue // estruturas com pelo menos 500 voxels (~0,5 mL) no bloco
      est.push({ k: labels[c] || String(c), voxels: ppA.volumes[c], dSuave: 100 * (ppB.volumes[c] - ppA.volumes[c]) / ppA.volumes[c], dRigido: nA[c] ? 100 * (nB[c] - nA[c]) / nA[c] : null, dice: 2 * nAB[c] / (nA[c] + nB[c]) })
    }
    est.sort((x, y) => Math.abs(y.dSuave) - Math.abs(x.dSuave))
    const sA = est.reduce((s, e) => s + e.voxels, 0), sB = est.reduce((s, e) => s + e.voxels * (1 + e.dSuave / 100), 0)
    return {
      rotuloIgualPct: 100 * igual / N,
      rotuloIgualTecidoPct: 100 * igualT / tecido,
      dPosterior: { media: ds.reduce((s, x) => s + x, 0) / nD, p99: ds[Math.floor(0.99 * (nD - 1))], p999: ds[Math.floor(0.999 * (nD - 1))], max: ds[nD - 1] },
      suaveMaxAbsPct: Math.abs(est[0].dSuave), suaveTotalPct: 100 * (sB - sA) / sA,
      diceMin: Math.min(...est.map(e => e.dice)),
      estruturas: est
    }
  }

  const variantes = []
  if (gl) variantes.push({ id: 'webgl', nome: 'WebGL', backend: 'webgl', f16: false })
  if (gl && flag('--f16')) variantes.push({ id: 'webglF16', nome: 'WebGL 16 bits', backend: 'webgl', f16: true })
  if (!gl || flag('--cpu')) variantes.push({ id: 'cpu', nome: 'CPU do navegador', backend: 'cpu', f16: false })
  for (const v of variantes) {
    const res = await naPagina({ modo: 'bloco', backend: v.backend, f16: v.f16, B, K }, block)
    const ib = Buffer.from(res.idx, 'base64'), vb = Buffer.from(res.val, 'base64')
    const nav = layout(new Uint8Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength)), new Uint16Array(vb.buffer.slice(vb.byteOffset, vb.byteOffset + vb.byteLength)))
    const r = comparar(node, nav)
    const i = res.info
    console.log(`  ${v.nome} × Node: ${i.backend === 'webgl' ? `${i.renderer}, WebGL ${i.webgl}, float32 ${i.float32 ? 'sim' : 'não'}, texturas de até ${i.maxTex}²` : 'tfjs em JavaScript'} · ${res.segundos.toFixed(0)} s`)
    console.log(`    rótulo igual em ${r.rotuloIgualPct.toFixed(4)}% dos voxels (${r.rotuloIgualTecidoPct.toFixed(4)}% do tecido)`)
    console.log(`    |Δ posterior máxima|: média ${r.dPosterior.media.toExponential(1)} · p99 ${r.dPosterior.p99.toExponential(1)} · p99,9 ${r.dPosterior.p999.toExponential(1)} · máx ${r.dPosterior.max.toExponential(1)}`)
    console.log(`    volume suave no bloco: total ${pct(r.suaveTotalPct, 4)}, maior |Δ| ${r.suaveMaxAbsPct.toFixed(4)}% · Dice mínimo ${r.diceMin.toFixed(4)}`)
    for (const e of r.estruturas.slice(0, 5)) console.log(`      ${e.k.padEnd(32)} suave ${pct(e.dSuave, 4)} · rígido ${e.dRigido == null ? '—' : pct(e.dRigido, 3)} · Dice ${e.dice.toFixed(4)}`)
    saida[v.id] = { info: i, segundos: res.segundos, ...r }
  }
} finally {
  await browser.close()
  srv.close()
}
gravar(`motores-${ex.id}.json`)
