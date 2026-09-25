// Fusão segmentação + parcelação DKT, replicando o predict_synthseg.py do SynthSeg 2.0:
// mask = (seg == córtex); seg[mask] = parcelação[mask].
// A parcelação vem da rede DKT (aparc+aseg 104 do brainchop); voxels de córtex
// que a rede DKT não parcelou recebem o parcelamento do vizinho por propagação
// iterativa (equivalente ao argmax sem fundo do pipeline oficial).
//
// Duas fontes de segmentação são aceitas:
// · SynthSeg (labels.json): córtex E=2 / D=19 — o hemisfério do SynthSeg é a
//   autoridade, como no mascaramento oficial. Espaço combinado (labels_dkt.json):
//   0–31 SynthSeg · 32–65 ctx-lh · 66–99 ctx-rh.
// · aseg compacta (model30chan18cls): córtex bilateral=2 — o hemisfério vem da
//   própria rede DKT (parcelas 1–34 = E, 35–68 = D). Espaço combinado:
//   0–17 aseg · 18–51 ctx-lh · 52–85 ctx-rh.
//
// Nos dois casos os intervalos ctx-lh e ctx-rh são contíguos (lhBase+34 === rhBase),
// o que a propagação por vizinhança usa para tratar o hemisfério indefinido.
// Com a fonte FastSurfer a máscara já chega toda parcelada (argmax restrito às classes
// corticais em lib/fastsurfer-core.js); a propagação cobre sobretudo a rede brainchop.

const UNSET = 255
const H_L = 0
const H_R = 1
const H_ANY = 2 // córtex bilateral sem parcela direta: o hemisfério sai dos vizinhos

/**
 * @param {Uint8Array} segSrc  segmentação de origem, 256³
 * @param {Uint8Array} seg104  saída do modelo aparc+aseg 104 (0–103), mesma grade
 * @param {number[]} dims      [nx, ny, nz]
 * @param {object}   opts      { leftCtx, rightCtx, bothCtx, lhBase, rhBase }
 *   leftCtx/rightCtx: rótulos de córtex E/D (fonte com hemisfério, ex. SynthSeg)
 *   bothCtx:          rótulo de córtex bilateral (fonte sem hemisfério, ex. aseg)
 *   lhBase/rhBase:    out = base + parcela (1–34) → ctx-lh/ctx-rh no espaço combinado
 * @returns {{ seg: Uint8Array, stats: {cortexVox:number, direct:number, filled:number, residual:number} }}
 */
export function fuseDKT (segSrc, seg104, dims, opts = {}) {
  const { leftCtx = 2, rightCtx = 19, bothCtx = -1, lhBase = 31, rhBase = 65 } = opts
  const [nx, ny, nz] = dims
  const n = nx * ny * nz
  const out = new Uint8Array(segSrc) // não-córtex herda a segmentação de origem
  const hemi = new Uint8Array(n)     // H_L | H_R | H_ANY, válido onde out === UNSET
  let cortexVox = 0
  let direct = 0

  // passo 1: máscara do córtex recebe o parcelamento DKT do modelo 104;
  // quando a origem tem hemisfério (SynthSeg), ela é a autoridade — a rede DKT
  // só dá o nome da região; no córtex bilateral o hemisfério vem da rede DKT
  for (let v = 0; v < n; v++) {
    const s = segSrc[v]
    const isL = s === leftCtx
    const isR = s === rightCtx
    if (!isL && !isR && s !== bothCtx) continue
    cortexVox++
    const p = seg104[v]
    const parcel = (p >= 1 && p <= 34) ? p : (p >= 35 && p <= 68) ? p - 34 : 0
    const h = isL ? H_L : isR ? H_R : (p >= 1 && p <= 34) ? H_L : (p >= 35 && p <= 68) ? H_R : H_ANY
    if (parcel > 0) {
      out[v] = (h === H_L ? lhBase : rhBase) + parcel
      direct++
    } else {
      out[v] = UNSET
      hemi[v] = h
    }
  }

  // passo 2: propagação — voxel de córtex sem parcela herda a parcela modal
  // dos 6 vizinhos já parcelados (restrita ao hemisfério quando conhecido).
  // Varre só a lista de pendentes (não o volume 256³ inteiro a cada rodada) e
  // aplica as atribuições no fim da rodada (atualização síncrona, sem viés de ordem).
  let filled = 0
  const sxy = nx * ny
  const counts = new Int32Array(rhBase + 35)
  let pend = new Int32Array(cortexVox - direct)
  {
    let k = 0
    for (let v = 0; v < n; v++) if (out[v] === UNSET) pend[k++] = v
  }
  const nextV = new Int32Array(pend.length)
  const nextL = new Uint8Array(pend.length)
  for (let round = 0; round < 24 && pend.length; round++) {
    let changed = 0
    let keep = 0
    for (let k = 0; k < pend.length; k++) {
      const v = pend[k]
      const h = hemi[v]
      const lo = h === H_R ? rhBase + 1 : lhBase + 1
      const hi = h === H_L ? lhBase + 34 : rhBase + 34
      const x = v % nx, y = ((v / nx) | 0) % ny, z = (v / sxy) | 0
      let best = 0, bestC = 0
      const nb = [x > 0 ? v - 1 : -1, x < nx - 1 ? v + 1 : -1, y > 0 ? v - nx : -1,
        y < ny - 1 ? v + nx : -1, z > 0 ? v - sxy : -1, z < nz - 1 ? v + sxy : -1]
      for (const w of nb) {
        if (w < 0) continue
        const q = out[w]
        if (q >= lo && q <= hi) {
          const c = ++counts[q]
          if (c > bestC) { bestC = c; best = q }
        }
      }
      for (const w of nb) {
        if (w < 0) continue
        const q = out[w]
        if (q >= lo && q <= hi) counts[q] = 0
      }
      if (best) { nextV[changed] = v; nextL[changed] = best; changed++ } else pend[keep++] = v
    }
    for (let k = 0; k < changed; k++) out[nextV[k]] = nextL[k]
    filled += changed
    pend = pend.subarray(0, keep)
    if (!changed) break
  }

  // resíduo: mantém o rótulo genérico de córtex da origem
  let residual = 0
  for (let v = 0; v < n; v++) {
    if (out[v] === UNSET) {
      out[v] = segSrc[v]
      residual++
    }
  }
  return { seg: out, stats: { cortexVox, direct, filled, residual } }
}
