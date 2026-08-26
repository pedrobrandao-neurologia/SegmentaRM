// Núcleo da inferência SynthSeg no navegador: replica o predict.py do
// BBillot/SynthSeg (Apache 2.0) — alinhamento a RAS, rescale robusto por
// percentis 0,5–99,5 para [0,1], recorte ao encéfalo e UNet original —
// com uma diferença declarada: a inferência roda em blocos com sobreposição
// (stitching por recorte central), porque o volume inteiro não cabe na
// memória de GPU do navegador. Sem test-time flipping nem suavização de
// posteriors nesta versão.

// permutação/flips que levam o volume (ordem crua + affine) à ordem RAS
export function rasOrientation (affine) {
  const perm = [0, 0, 0]
  const flip = [1, 1, 1]
  const used = new Set()
  for (let r = 0; r < 3; r++) {
    let best = -1, bi = -1
    for (let a = 0; a < 3; a++) {
      if (used.has(a)) continue
      const v = Math.abs(affine[r][a])
      if (v > best) { best = v; bi = a }
    }
    used.add(bi)
    perm[r] = bi
    flip[r] = affine[r][bi] >= 0 ? 1 : -1
  }
  return { perm, flip }
}

// reordena o volume cru para eixos RAS (x mais rápido)
export function toRAS (data, dims, orientation) {
  const { perm, flip } = orientation
  const outDims = [dims[perm[0]], dims[perm[1]], dims[perm[2]]]
  const out = new Float32Array(outDims[0] * outDims[1] * outDims[2])
  const stride = [1, dims[0], dims[0] * dims[1]]
  const s0 = stride[perm[0]], s1 = stride[perm[1]], s2 = stride[perm[2]]
  const n0 = outDims[0], n1 = outDims[1], n2 = outDims[2]
  let v = 0
  for (let c = 0; c < n2; c++) {
    const sc = (flip[2] > 0 ? c : n2 - 1 - c) * s2
    for (let b = 0; b < n1; b++) {
      const sb = (flip[1] > 0 ? b : n1 - 1 - b) * s1
      for (let a = 0; a < n0; a++, v++) {
        out[v] = data[(flip[0] > 0 ? a : n0 - 1 - a) * s0 + sb + sc]
      }
    }
  }
  return { data: out, dims: outDims }
}

// caminho inverso: rótulos em RAS → ordem crua original
export function fromRAS (labels, dims, orientation) {
  const { perm, flip } = orientation
  const rasDims = [dims[perm[0]], dims[perm[1]], dims[perm[2]]]
  const out = new Uint8Array(dims[0] * dims[1] * dims[2])
  const stride = [1, dims[0], dims[0] * dims[1]]
  const s0 = stride[perm[0]], s1 = stride[perm[1]], s2 = stride[perm[2]]
  const n0 = rasDims[0], n1 = rasDims[1], n2 = rasDims[2]
  let v = 0
  for (let c = 0; c < n2; c++) {
    const sc = (flip[2] > 0 ? c : n2 - 1 - c) * s2
    for (let b = 0; b < n1; b++) {
      const sb = (flip[1] > 0 ? b : n1 - 1 - b) * s1
      for (let a = 0; a < n0; a++, v++) {
        out[(flip[0] > 0 ? a : n0 - 1 - a) * s0 + sb + sc] = labels[v]
      }
    }
  }
  return out
}

// rescale robusto (percentis 0,5–99,5 → [0,1]), como edit_volumes.rescale_volume
export function robustRescale (data) {
  const sample = []
  const step = Math.max(1, Math.floor(data.length / 500000))
  for (let i = 0; i < data.length; i += step) sample.push(data[i])
  sample.sort((a, b) => a - b)
  const q = (p) => sample[Math.min(sample.length - 1, Math.round(p * (sample.length - 1)))]
  const lo = q(0.005), hi = q(0.995)
  const den = hi - lo || 1
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) {
    out[i] = Math.min(1, Math.max(0, (data[i] - lo) / den))
  }
  return out
}

// caixa envolvente do tecido (val > thr), com margem, dims da grade
export function boundingBox (data, dims, thr = 0.02, margin = 8) {
  const [nx, ny, nz] = dims
  let x0 = nx, x1 = -1, y0 = ny, y1 = -1, z0 = nz, z1 = -1
  let v = 0
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, v++) {
        if (data[v] > thr) {
          if (i < x0) x0 = i; if (i > x1) x1 = i
          if (j < y0) y0 = j; if (j > y1) y1 = j
          if (k < z0) z0 = k; if (k > z1) z1 = k
        }
      }
    }
  }
  if (x1 < 0) return { min: [0, 0, 0], size: dims.slice() }
  const min = [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.max(0, z0 - margin)]
  const max = [Math.min(nx - 1, x1 + margin), Math.min(ny - 1, y1 + margin), Math.min(nz - 1, z1 + margin)]
  return { min, size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1] }
}

// grade de blocos com sobreposição cobrindo [0, extent)
export function tileGrid (extent, tile, overlap) {
  if (extent <= tile) return [{ start: 0, size: extent }]
  const stride = tile - overlap
  const starts = []
  for (let s = 0; s + tile < extent; s += stride) starts.push(s)
  starts.push(extent - tile)
  return starts.map(s => ({ start: s, size: tile }))
}

/**
 * Inferência em blocos. `predictTile(f32, [d,h,w])` → Promise<{argmax, conf?}>
 * O stitching usa o recorte central de cada bloco (metade da sobreposição de margem,
 * exceto nas bordas do volume).
 * @param {Float32Array} [confOut] se fornecido e `predictTile` devolver `conf`
 *        (posterior máxima por voxel), recebe o mesmo stitching do argmax — é a
 *        confiança da rede, base do QC por grupo tecidual.
 */
export async function tiledSegment ({ data, dims, tile = 96, overlap = 32, predictTile, onProgress, confOut = null }) {
  const [nx, ny, nz] = dims
  const gx = tileGrid(nx, Math.min(tile, ceil32(nx)), overlap)
  const gy = tileGrid(ny, Math.min(tile, ceil32(ny)), overlap)
  const gz = tileGrid(nz, Math.min(tile, ceil32(nz)), overlap)
  const out = new Uint8Array(nx * ny * nz)
  const total = gx.length * gy.length * gz.length
  let done = 0
  for (const tz of gz) {
    for (const ty of gy) {
      for (const tx of gx) {
        // bloco preenchido até múltiplo de 32 (a UNet tem 5 níveis de pooling)
        const bw = ceil32(tx.size), bh = ceil32(ty.size), bd = ceil32(tz.size)
        const block = new Float32Array(bw * bh * bd)
        for (let k = 0; k < tz.size; k++) {
          for (let j = 0; j < ty.size; j++) {
            const src = (tz.start + k) * nx * ny + (ty.start + j) * nx + tx.start
            const dst = k * bw * bh + j * bw
            block.set(data.subarray(src, src + tx.size), dst)
          }
        }
        const { argmax, conf } = await predictTile(block, [bw, bh, bd])
        // recorte central: margem = overlap/2, exceto quando o bloco toca a borda
        const m = Math.floor(overlap / 2)
        const ix0 = tx.start === 0 ? 0 : m
        const iy0 = ty.start === 0 ? 0 : m
        const iz0 = tz.start === 0 ? 0 : m
        const ix1 = tx.start + tx.size >= nx ? tx.size : tx.size - m
        const iy1 = ty.start + ty.size >= ny ? ty.size : ty.size - m
        const iz1 = tz.start + tz.size >= nz ? tz.size : tz.size - m
        for (let k = iz0; k < iz1; k++) {
          for (let j = iy0; j < iy1; j++) {
            for (let i = ix0; i < ix1; i++) {
              const dst = (tz.start + k) * nx * ny + (ty.start + j) * nx + (tx.start + i)
              const src = k * bw * bh + j * bw + i
              out[dst] = argmax[src]
              if (confOut && conf) confOut[dst] = conf[src]
            }
          }
        }
        done++
        if (onProgress) onProgress(done, total)
      }
    }
  }
  return out
}

function ceil32 (n) { return Math.ceil(n / 32) * 32 }
