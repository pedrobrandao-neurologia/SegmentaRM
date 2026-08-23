// Fusão SynthSeg + parcelação DKT, replicando o predict_synthseg.py do SynthSeg 2.0:
// mask = (seg == córtex E) | (seg == córtex D); seg[mask] = parcelação[mask].
// A parcelação vem da rede DKT (aparc+aseg 104 do brainchop); voxels do córtex
// SynthSeg que a rede DKT não parcelou recebem o parcelamento do vizinho por
// propagação iterativa (equivalente ao argmax sem fundo do pipeline oficial).
//
// Espaço combinado (labels_dkt.json): 0–31 SynthSeg · 32–65 ctx-lh · 66–99 ctx-rh.

const L_CTX = 2    // índice de Left-Cerebral-Cortex no synthseg1/labels.json
const R_CTX = 19   // Right-Cerebral-Cortex
const UNSET = 255

/**
 * @param {Uint8Array} segSynth  saída do SynthSeg (índices 0–31), 256³
 * @param {Uint8Array} seg104    saída do modelo aparc+aseg 104 (0–103), mesma grade
 * @param {number[]} dims        [nx, ny, nz]
 * @returns {{ seg: Uint8Array, stats: {cortexVox:number, direct:number, filled:number, residual:number} }}
 */
export function fuseDKT (segSynth, seg104, dims) {
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const out = new Uint8Array(segSynth) // não-córtex herda o SynthSeg
  let cortexVox = 0
  let direct = 0

  // passo 1: máscara do córtex SynthSeg recebe o parcelamento DKT do modelo 104;
  // o hemisfério do SynthSeg é a autoridade (como no mascaramento oficial)
  for (let v = 0; v < n; v++) {
    const s = segSynth[v]
    if (s !== L_CTX && s !== R_CTX) continue
    cortexVox++
    const p = seg104[v]
    let parcel = 0
    if (p >= 1 && p <= 34) parcel = p            // ctx-lh-<j>
    else if (p >= 35 && p <= 68) parcel = p - 34 // ctx-rh-<j> → base
    if (parcel > 0) {
      out[v] = (s === L_CTX ? 31 : 65) + parcel
      direct++
    } else {
      out[v] = UNSET
    }
  }

  // passo 2: propagação — voxel de córtex sem parcela herda a parcela modal
  // dos 6 vizinhos já parcelados (respeitando o hemisfério), até convergir
  let filled = 0
  const sxy = nx * ny
  const counts = new Int32Array(100)
  for (let round = 0; round < 24; round++) {
    let changed = 0
    const next = []
    for (let v = 0; v < n; v++) {
      if (out[v] !== UNSET) continue
      const s = segSynth[v]
      const lo = s === L_CTX ? 32 : 66
      const hi = lo + 33
      counts.fill(0)
      const x = v % nx, y = ((v / nx) | 0) % ny, z = (v / sxy) | 0
      let best = 0, bestC = 0
      const look = (w) => {
        const q = out[w]
        if (q >= lo && q <= hi) {
          const c = ++counts[q]
          if (c > bestC) { bestC = c; best = q }
        }
      }
      if (x > 0) look(v - 1)
      if (x < nx - 1) look(v + 1)
      if (y > 0) look(v - nx)
      if (y < ny - 1) look(v + nx)
      if (z > 0) look(v - sxy)
      if (z < nz - 1) look(v + sxy)
      if (best) { next.push([v, best]); changed++ }
    }
    for (const [v, val] of next) out[v] = val
    filled += changed
    if (!changed) break
  }

  // resíduo: mantém o rótulo genérico de córtex do SynthSeg
  let residual = 0
  for (let v = 0; v < n; v++) {
    if (out[v] === UNSET) {
      out[v] = segSynth[v]
      residual++
    }
  }
  return { seg: out, stats: { cortexVox, direct, filled, residual } }
}
