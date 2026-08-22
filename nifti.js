// nifti.js — leitura e escrita de NIfTI-1 (.nii / .nii.gz), sem dependências.

const DT = {
  2: { name: 'uint8', bytes: 1, get: (dv, o) => dv.getUint8(o) },
  4: { name: 'int16', bytes: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  8: { name: 'int32', bytes: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  16: { name: 'float32', bytes: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  64: { name: 'float64', bytes: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
  256: { name: 'int8', bytes: 1, get: (dv, o) => dv.getInt8(o) },
  512: { name: 'uint16', bytes: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  768: { name: 'uint32', bytes: 4, get: (dv, o, le) => dv.getUint32(o, le) },
};

export async function gunzipIfNeeded(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Este navegador não descompacta .gz. Envie o arquivo .nii descompactado.');
  }
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

// Quaternion -> matriz 3x3 (NIfTI-1, método 2)
function quatToMat(qb, qc, qd, qfac, dx, dy, dz) {
  let a = 1.0 - (qb * qb + qc * qc + qd * qd);
  a = a < 1e-7 ? 0 : Math.sqrt(a);
  const b = qb, c = qc, d = qd;
  const m = [
    [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
    [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
    [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
  ];
  const sz = [dx, dy, qfac < 0 ? -dz : dz];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] *= sz[j];
  return m;
}

/**
 * @returns {{data: Float32Array, dims:[number,number,number], affine:number[][],
 *            pixdim:[number,number,number], header:object}}
 */
export async function readNifti(arrayBuffer) {
  const buf = await gunzipIfNeeded(arrayBuffer);
  let dv = new DataView(buf);
  let le = true;
  let sizeof_hdr = dv.getInt32(0, true);
  if (sizeof_hdr !== 348) {
    le = false;
    sizeof_hdr = dv.getInt32(0, false);
    if (sizeof_hdr !== 348) {
      throw new Error('Não parece um NIfTI-1 (sizeof_hdr inválido). NIfTI-2 e Analyze não são suportados.');
    }
  }

  const ndim = dv.getInt16(40, le);
  const nx = dv.getInt16(42, le), ny = dv.getInt16(44, le), nz = dv.getInt16(46, le);
  const nt = ndim >= 4 ? dv.getInt16(48, le) : 1;
  const datatype = dv.getInt16(70, le);
  const dx = dv.getFloat32(80, le), dy = dv.getFloat32(84, le), dz = dv.getFloat32(88, le);
  const qfac = dv.getFloat32(76, le) < 0 ? -1 : 1;
  const vox_offset = Math.round(dv.getFloat32(108, le));
  let scl_slope = dv.getFloat32(112, le);
  const scl_inter = dv.getFloat32(116, le);
  const qform_code = dv.getInt16(252, le);
  const sform_code = dv.getInt16(254, le);
  const quatern = [dv.getFloat32(256, le), dv.getFloat32(260, le), dv.getFloat32(264, le)];
  const qoffset = [dv.getFloat32(268, le), dv.getFloat32(272, le), dv.getFloat32(276, le)];

  const spec = DT[datatype];
  if (!spec) throw new Error(`Tipo de dado NIfTI não suportado (código ${datatype}).`);
  if (nt > 1) console.warn(`Volume 4D com ${nt} pontos: usando apenas o primeiro.`);

  let affine;
  if (sform_code > 0) {
    affine = [[], [], []];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) affine[r][c] = dv.getFloat32(280 + r * 16 + c * 4, le);
    }
  } else if (qform_code > 0) {
    const m = quatToMat(quatern[0], quatern[1], quatern[2], qfac, dx, dy, dz);
    affine = m.map((row, i) => [...row, qoffset[i]]);
  } else {
    affine = [[dx, 0, 0, 0], [0, dy, 0, 0], [0, 0, dz, 0]];
  }

  const n = nx * ny * nz;
  const out = new Float32Array(n);
  if (!isFinite(scl_slope) || scl_slope === 0) scl_slope = 1;
  const start = vox_offset > 0 ? vox_offset : 352;
  dv = new DataView(buf, start);
  for (let i = 0; i < n; i++) out[i] = spec.get(dv, i * spec.bytes, le) * scl_slope + scl_inter;

  return {
    data: out,
    dims: [nx, ny, nz],
    pixdim: [Math.abs(dx), Math.abs(dy), Math.abs(dz)],
    affine,
    header: { datatype: spec.name, sform_code, qform_code, nt },
  };
}

/** Escreve NIfTI-1 (.nii, não compactado). `data` pode ser Float32Array, Uint8Array ou Int16Array. */
export function writeNifti({ data, dims, affine, pixdim = [1, 1, 1], description = 'NeuroVol' }) {
  let code, bpv, setter;
  if (data instanceof Uint8Array) { code = 2; bpv = 1; setter = (dv, o, v) => dv.setUint8(o, v); }
  else if (data instanceof Int16Array || data instanceof Uint16Array) { code = 512; bpv = 2; setter = (dv, o, v) => dv.setUint16(o, v, true); }
  else { code = 16; bpv = 4; setter = (dv, o, v) => dv.setFloat32(o, v, true); }

  const n = dims[0] * dims[1] * dims[2];
  const buf = new ArrayBuffer(352 + n * bpv);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, dims[0], true);
  dv.setInt16(44, dims[1], true);
  dv.setInt16(46, dims[2], true);
  dv.setInt16(48, 1, true); dv.setInt16(50, 1, true); dv.setInt16(52, 1, true); dv.setInt16(54, 1, true);
  dv.setInt16(70, code, true);
  dv.setInt16(72, bpv * 8, true);
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, pixdim[0], true);
  dv.setFloat32(84, pixdim[1], true);
  dv.setFloat32(88, pixdim[2], true);
  dv.setFloat32(108, 352, true);
  dv.setFloat32(112, 1, true);
  dv.setFloat32(116, 0, true);
  dv.setInt8(123, 2 | (1 << 3)); // xyzt_units: mm + sec
  const desc = new TextEncoder().encode(description.slice(0, 79));
  u8.set(desc, 148);
  const magic = new TextEncoder().encode('n+1\0');
  u8.set(magic, 344);
  dv.setInt16(252, 0, true);
  dv.setInt16(254, 1, true); // sform_code = scanner anat
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) dv.setFloat32(280 + r * 16 + c * 4, affine[r][c], true);
  }
  const body = new DataView(buf, 352);
  for (let i = 0; i < n; i++) setter(body, i * bpv, data[i]);
  return buf;
}
