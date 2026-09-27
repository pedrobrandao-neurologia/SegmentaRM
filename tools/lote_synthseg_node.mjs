#!/usr/bin/env node
// Lote OFFLINE do SynthSeg do app (tools/synthseg_node.mjs) para construir a recentragem e as
// referências do mesmo método (tools/referencias_dlbs.py, tools/recentragem_dlbs.mjs). Nada disso
// roda no app.
//
//   npm i --no-save @tensorflow/tfjs-node@4.22.0      (mesma versão do tfjs vendorizado)
//   node tools/lote_synthseg_node.mjs <pasta com *_T1w.nii.gz> <pasta de saída> [selecao.json]
//
// Resultado: <id>.json com os volumes suaves (valor principal do app) e rígidos por estrutura.
// Com a seleção, a ordem intercala faixas etárias: qualquer prefixo do lote cobre a faixa toda.
import fs from 'node:fs'
import { carregarSynthSeg, segmentar } from './synthseg_node.mjs'

const [IN, RES, SEL] = process.argv.slice(2)
if (!IN || !RES) { console.error('uso: node tools/lote_synthseg_node.mjs <entrada> <saída> [selecao.json]'); process.exit(2) }
fs.mkdirSync(RES, { recursive: true })
const rede = await carregarSynthSeg()
let files = fs.readdirSync(IN).filter(f => f.endsWith('_T1w.nii.gz')).sort()
if (SEL && fs.existsSync(SEL)) {
  const sel = JSON.parse(fs.readFileSync(SEL, 'utf8')).slice().sort((a, b) => a.idade - b.idade || a.num - b.num)
  const K = 10; const faixas = Array.from({ length: K }, () => [])
  sel.forEach((s, i) => faixas[Math.floor(i * K / sel.length)].push(s.id + '_T1w.nii.gz'))
  const ordem = []
  for (let j = 0; ordem.length < sel.length; j++) for (const f of faixas) if (f[j]) ordem.push(f[j])
  files = ordem.filter(f => files.includes(f)).concat(files.filter(f => !ordem.includes(f)))
}
for (const f of files) {
  const id = f.replace('_T1w.nii.gz', '')
  const outP = `${RES}/${id}.json`
  if (fs.existsSync(outP)) continue
  const t0 = Date.now()
  try {
    const r = await segmentar(rede, `${IN}/${f}`)
    fs.writeFileSync(outP, JSON.stringify({ id, ...r, s: (Date.now() - t0) / 1000 }))
    console.log(id, 'ok', ((Date.now() - t0) / 1000).toFixed(0) + 's')
  } catch (e) {
    console.log(id, 'ERRO', e.message)
  }
}
process.exit(0)
