// SynthSeg do app em Node (TensorFlow nativo): o MESMO núcleo do navegador (lib/synthseg-core.js)
// no caminho oficial do app — imagem nativa pré-processada como no predict_synthseg (reamostragem
// 1 mm, RAS, percentis), blocos 128³ com sobreposição 64, espelhamento E/D, pós-processamento.
// Os volumes SUAVES (valor principal do app) são somados na grade da rede e não dependem da
// conformação; os rígidos aqui são contados na grade da rede (no app, na grade conformada 256³,
// após amostragem por vizinho mais próximo — diferem em frações de %).
//
// Requer: npm i --no-save @tensorflow/tfjs-node@4.22.0 (mesma versão do tfjs vendorizado)
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function carregarSynthSeg () {
  globalThis.require = globalThis.require || createRequire(import.meta.url)
  let tf
  try { tf = createRequire(path.join(RAIZ, 'package.json'))('@tensorflow/tfjs-node') } catch (e) {
    throw new Error('instale o TensorFlow nativo: npm i --no-save @tensorflow/tfjs-node@4.22.0')
  }
  const { registerUpSampling3D } = await import(path.join(RAIZ, 'lib/tfjs-upsampling3d.js'))
  const { runSynthSeg } = await import(path.join(RAIZ, 'lib/synthseg-core.js'))
  registerUpSampling3D(tf)
  const labels = JSON.parse(fs.readFileSync(path.join(RAIZ, 'models/synthseg1/labels.json'), 'utf8'))
  const model = await tf.loadLayersModel('file://' + path.join(RAIZ, 'models/synthseg1/model.json'))
  return { tf, model, labels, runSynthSeg }
}

// NIfTI-1 (gz ou não); afim como o nibabel: sform se sform_code > 0, senão qform
export function lerNifti (arquivo) {
  let b = fs.readFileSync(arquivo)
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  let le = true
  if (dv.getInt32(0, true) !== 348) { le = false; if (dv.getInt32(0, false) !== 348) throw new Error('não é NIfTI-1') }
  const i16 = (o) => dv.getInt16(o, le); const f32 = (o) => dv.getFloat32(o, le)
  const dim = [0, 1, 2, 3, 4, 5, 6, 7].map(k => i16(40 + 2 * k))
  const datatype = i16(70); const bitpix = i16(72)
  const pixdim = [0, 1, 2, 3, 4, 5, 6, 7].map(k => f32(76 + 4 * k))
  const voxOffset = f32(108); let slope = f32(112); const inter = f32(116)
  if (!slope) slope = 1
  const qcode = i16(252); const scode = i16(254)
  let A
  if (scode > 0) {
    A = [0, 1, 2].map(r => [0, 1, 2, 3].map(c => f32(280 + 16 * r + 4 * c)))
  } else if (qcode > 0) {
    const b1 = f32(256), c1 = f32(260), d1 = f32(264)
    const qx = f32(268), qy = f32(272), qz = f32(276)
    let a = 1 - (b1 * b1 + c1 * c1 + d1 * d1); a = a < 1e-7 ? 0 : Math.sqrt(a)
    const qfac = pixdim[0] < 0 ? -1 : 1
    const R = [[a * a + b1 * b1 - c1 * c1 - d1 * d1, 2 * (b1 * c1 - a * d1), 2 * (b1 * d1 + a * c1)],
      [2 * (b1 * c1 + a * d1), a * a + c1 * c1 - b1 * b1 - d1 * d1, 2 * (c1 * d1 - a * b1)],
      [2 * (b1 * d1 - a * c1), 2 * (c1 * d1 + a * b1), a * a + d1 * d1 - c1 * c1 - b1 * b1]]
    const z = [pixdim[1], pixdim[2], pixdim[3] * qfac]
    A = [0, 1, 2].map(r => [R[r][0] * z[0], R[r][1] * z[1], R[r][2] * z[2], [qx, qy, qz][r]])
  } else {
    A = [[pixdim[1], 0, 0, 0], [0, pixdim[2], 0, 0], [0, 0, pixdim[3], 0]]
  }
  A.push([0, 0, 0, 1])
  const [nx, ny, nz] = [dim[1], dim[2], dim[3]]
  const n = nx * ny * nz
  const off = Math.round(voxOffset)
  const out = new Float32Array(n)
  const rd = { 2: (o) => dv.getUint8(o), 4: (o) => dv.getInt16(o, le), 8: (o) => dv.getInt32(o, le), 16: (o) => dv.getFloat32(o, le), 64: (o) => dv.getFloat64(o, le), 256: (o) => dv.getInt8(o), 512: (o) => dv.getUint16(o, le), 768: (o) => dv.getUint32(o, le) }[datatype]
  if (!rd) throw new Error('datatype ' + datatype)
  const bs = bitpix / 8
  for (let i = 0; i < n; i++) out[i] = rd(off + i * bs) * slope + inter
  return { dims: [nx, ny, nz], affine: A, data: out }
}


const det3 = (G) => Math.abs(G[0][0] * (G[1][1] * G[2][2] - G[1][2] * G[2][1]) - G[0][1] * (G[1][0] * G[2][2] - G[1][2] * G[2][0]) + G[0][2] * (G[1][0] * G[2][1] - G[1][1] * G[2][0]))

/** segmenta um arquivo → { soft, hard, voxGrid, dimsNat, nTiles } (mm³ por estrutura) */
export async function segmentar (rede, arquivo) {
  const { tf, model, labels, runSynthSeg } = rede
  const nat = lerNifti(arquivo)
  const A = nat.affine
  const c = [0, 1, 2].map(r => A[r][0] * (nat.dims[0] - 1) / 2 + A[r][1] * (nat.dims[1] - 1) / 2 + A[r][2] * (nat.dims[2] - 1) / 2 + A[r][3])
  // grade de saída conformada 256³ LIA 1 mm centrada no volume (como o mri_convert --conform)
  const C = [[-1, 0, 0, c[0] + 127.5], [0, 0, 1, c[1] - 127.5], [0, -1, 0, c[2] + 127.5], [0, 0, 0, 1]]
  const r = await runSynthSeg({ tf, model, img: null, dims: [256, 256, 256], affine: C, tile: 128, overlap: 64, flip: true, native: nat })
  const cnt = new Float64Array(256)
  for (let i = 0; i < r.gridSeg.length; i++) cnt[r.gridSeg[i]]++
  const det = det3(r.grid.affine)
  const soft = {}; const hard = {}
  for (let k = 1; k < r.volumes.length; k++) if (labels[k]) soft[labels[k]] = r.volumes[k]
  for (let k = 1; k < 256; k++) if (cnt[k] && labels[k]) hard[labels[k]] = cnt[k] * det
  return { soft, hard, voxGrid: det, dimsNat: nat.dims, nTiles: r.nTiles }
}
