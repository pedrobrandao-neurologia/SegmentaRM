// icv.worker.js — volume intracraniano estimado (VIC ≈ eTIV) em Web Worker (módulo).
// Registro afim de 12 parâmetros do T1 conformado ao MNI152 2009c embutido em lib/icv.js;
// VIC = constante × det(A). Tudo local: nenhum dado sai do navegador.
//
// Entrada: { img: Uint8Array (conformado 256³, i mais rápido), dims: [nx,ny,nz],
//            affine: vox→RAS (16 por linhas ou 4×4), seg?: Uint8Array (rótulos, mesmo espaço),
//            labels?: { índice: nome FreeSurfer }, opcoes?: {...} }
// Saída:   { cmd:'done', vic_mm3, metodo, detalhes, aviso }
//          progresso { cmd:'progress', frac, txt } · erro { cmd:'error', message }
// Custo típico: ~4–8 s e < 150 MB para 256³ (pirâmide 2/4/8 mm; laços com limite de iterações).

import { carregaTemplate, estimaVIC } from '../lib/icv.js'

function post (msg) { self.postMessage(msg) }

self.onmessage = async (e) => {
  const { img, dims, affine, seg, labels, opcoes } = e.data || {}
  try {
    post({ cmd: 'progress', frac: 0.01, txt: 'VIC: carregando o template MNI152…' })
    const tpl = await carregaTemplate()
    const r = estimaVIC({
      img: img instanceof ArrayBuffer ? new Uint8Array(img) : img,
      dims,
      affine,
      seg: seg ? (seg instanceof ArrayBuffer ? new Uint8Array(seg) : seg) : null,
      labels: labels || null,
      tpl,
      opcoes,
      onProgress: (frac, txt) => post({ cmd: 'progress', frac, txt })
    })
    post({ cmd: 'done', vic_mm3: r.vic_mm3, metodo: r.metodo, detalhes: r.detalhes, aviso: r.aviso })
  } catch (err) {
    post({ cmd: 'error', message: (err && err.message) || String(err) })
  }
}
