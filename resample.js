// resample.js — reamostragem afim entre grades voxel.

function inv4(A) {
  const m = [
    [A[0][0], A[0][1], A[0][2], A[0][3]],
    [A[1][0], A[1][1], A[1][2], A[1][3]],
    [A[2][0], A[2][1], A[2][2], A[2][3]],
    [0, 0, 0, 1],
  ];
  const inv = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    if (Math.abs(m[p][i]) < 1e-12) throw new Error('Matriz de orientação singular no cabeçalho da imagem.');
    [m[i], m[p]] = [m[p], m[i]];
    [inv[i], inv[p]] = [inv[p], inv[i]];
    const d = m[i][i];
    for (let c = 0; c < 4; c++) { m[i][c] /= d; inv[i][c] /= d; }
    for (let r = 0; r < 4; r++) {
      if (r === i) continue;
      const f = m[r][i];
      if (!f) continue;
      for (let c = 0; c < 4; c++) { m[r][c] -= f * m[i][c]; inv[r][c] -= f * inv[i][c]; }
    }
  }
  return inv;
}

const apply = (M, v) => [
  M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2] + M[0][3],
  M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2] + M[1][3],
  M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2] + M[2][3],
];

/** Centro de massa (em índices de voxel) das intensidades acima de um percentil. */
function centroid(data, dims) {
  const sorted = [];
  const step = Math.max(1, Math.floor(data.length / 200000));
  for (let i = 0; i < data.length; i += step) sorted.push(data[i]);
  sorted.sort((a, b) => a - b);
  const thr = sorted[Math.floor(sorted.length * 0.6)] ?? 0;
  const [nx, ny] = dims;
  let sx = 0, sy = 0, sz = 0, w = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v <= thr) continue;
    const x = i % nx, y = ((i / nx) | 0) % ny, z = (i / (nx * ny)) | 0;
    sx += x; sy += y; sz += z; w++;
  }
  if (!w) return [(dims[0] - 1) / 2, (dims[1] - 1) / 2, (dims[2] - 1) / 2];
  return [sx / w, sy / w, sz / w];
}

/**
 * Reamostra para uma grade cúbica isotrópica alinhada a RAS.
 * @returns {{data:Float32Array, dims:number[], affine:number[][], srcAffine:number[][], srcDims:number[]}}
 */
export function conform(vol, { size = 192, mm = 1.0 } = {}) {
  const { data, dims, affine } = vol;
  const c = centroid(data, dims);
  const cw = apply(affine, c);
  const half = ((size - 1) * mm) / 2;
  const T = [
    [mm, 0, 0, cw[0] - half],
    [0, mm, 0, cw[1] - half],
    [0, 0, mm, cw[2] - half],
  ];
  const out = resampleToGrid(vol, { dims: [size, size, size], affine: T }, 'linear');
  return { data: out, dims: [size, size, size], affine: T, pixdim: [mm, mm, mm], srcAffine: affine, srcDims: dims };
}

/**
 * Reamostra `vol` para a grade descrita por `grid` ({dims, affine}).
 * @param {'linear'|'nearest'} mode
 */
export function resampleToGrid(vol, grid, mode = 'linear') {
  const { data, dims, affine } = vol;
  const [sx, sy, sz] = dims;
  const [tx, ty, tz] = grid.dims;
  const M = inv4(affine);
  // combinada: índice alvo -> mundo -> índice fonte
  const G = grid.affine;
  const C = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += M[r][k] * G[k][c];
      C[r][c] = s + (c === 3 ? M[r][3] : 0);
    }
  }
  const out = mode === 'nearest' ? new Float32Array(tx * ty * tz) : new Float32Array(tx * ty * tz);
  let o = 0;
  for (let k = 0; k < tz; k++) {
    for (let j = 0; j < ty; j++) {
      let fx = C[0][1] * j + C[0][2] * k + C[0][3];
      let fy = C[1][1] * j + C[1][2] * k + C[1][3];
      let fz = C[2][1] * j + C[2][2] * k + C[2][3];
      for (let i = 0; i < tx; i++, o++) {
        const x = fx + C[0][0] * i, y = fy + C[1][0] * i, z = fz + C[2][0] * i;
        if (mode === 'nearest') {
          const xi = Math.round(x), yi = Math.round(y), zi = Math.round(z);
          if (xi < 0 || yi < 0 || zi < 0 || xi >= sx || yi >= sy || zi >= sz) continue;
          out[o] = data[xi + yi * sx + zi * sx * sy];
        } else {
          const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
          if (x0 < 0 || y0 < 0 || z0 < 0 || x0 + 1 >= sx || y0 + 1 >= sy || z0 + 1 >= sz) continue;
          const dx = x - x0, dy = y - y0, dz = z - z0;
          const b = x0 + y0 * sx + z0 * sx * sy;
          const s0 = sx, s1 = sx * sy;
          const c000 = data[b], c100 = data[b + 1], c010 = data[b + s0], c110 = data[b + s0 + 1];
          const c001 = data[b + s1], c101 = data[b + s1 + 1], c011 = data[b + s1 + s0], c111 = data[b + s1 + s0 + 1];
          const c00 = c000 + (c100 - c000) * dx, c10 = c010 + (c110 - c010) * dx;
          const c01 = c001 + (c101 - c001) * dx, c11 = c011 + (c111 - c011) * dx;
          const c0 = c00 + (c10 - c00) * dy, c1 = c01 + (c11 - c01) * dy;
          out[o] = c0 + (c1 - c0) * dz;
        }
      }
    }
  }
  return out;
}

/** Normalização robusta por percentis para [0,1], como no pré-processamento do SynthSeg. */
export function normalizeRobust(data, lo = 0.5, hi = 99.5) {
  const step = Math.max(1, Math.floor(data.length / 500000));
  const s = [];
  for (let i = 0; i < data.length; i += step) if (data[i] > 0) s.push(data[i]);
  if (!s.length) return new Float32Array(data);
  s.sort((a, b) => a - b);
  const a = s[Math.floor((lo / 100) * (s.length - 1))];
  const b = s[Math.floor((hi / 100) * (s.length - 1))];
  const rng = b - a || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    let v = (data[i] - a) / rng;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

export { inv4, apply };
