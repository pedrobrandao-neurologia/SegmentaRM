// thickness.worker.js — espessura cortical volumétrica (Laplace/euleriana) por parcela DKT,
// sem malhas, 100% no navegador (ver lib/thickness.js para o método e as referências).
// Mensagem: { seg (Uint8Array), dims, affine (16, achatada por linhas), labels (índice → nome),
//             voxVol?, mapa? (bool; padrão false), sulcos? (bool; padrão true),
//             fracaoVoxel? (bool; padrão true), compararSemSulcos? (bool; padrão false —
//             true roda de novo sem a reconstrução sulcal e põe o resultado em qc) }
// Progresso: { cmd:'progress', frac, txt }
// Resposta:  { cmd:'done', regioes: [{ label, name, hemi, parcela, espessura_media_mm,
//              espessura_mediana_mm, espessura_dp_mm, voxels, espessura_media_vox_mm,
//              area_superficie_media_mm2, amostras }],
//              hemisferios: { lh, rh }, metodo, qc, mapa? (Float32Array, mm por voxel) }
// Erro:      { cmd:'error', message }

import { corticalThickness } from '../lib/thickness.js'

let lastPost = 0
function post (frac, txt) {
  const now = Date.now()
  if (now - lastPost < 150 && frac < 1) return // não inunda o thread principal
  lastPost = now
  self.postMessage({ cmd: 'progress', frac, txt })
}

self.onmessage = (ev) => {
  const d = ev.data || {}
  try {
    const { seg, dims, affine, labels } = d
    if (!seg || !dims || !labels) throw new Error('mensagem incompleta: seg, dims e labels são obrigatórios')
    const A = affine ? Array.from(affine).flat() : null
    const r = corticalThickness(seg, dims, A, labels, {
      mapa: !!d.mapa,
      fracaoVoxel: d.fracaoVoxel !== false,
      sulcos: d.sulcos !== false,
      compararSemSulcos: !!d.compararSemSulcos,
      onProgress: post
    })
    if (d.voxVol) r.qc.voxVol = d.voxVol
    self.postMessage({ cmd: 'done', ...r }, r.mapa ? [r.mapa.buffer] : [])
  } catch (e) {
    self.postMessage({ cmd: 'error', message: e && e.message ? e.message : String(e) })
  }
}
