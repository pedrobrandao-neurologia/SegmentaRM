// Escritor NIfTI-1 mínimo: cabeçalho de 348 bytes + extensão zero (vox_offset 352) + dados.
// Suficiente para salvar a segmentação (uint8) e volumes pré-processados (float32).
// A affine (voxel → RAS, mm) é a fonte da verdade: vai inteira no sform (código 1,
// scanner) e, quando é rígida + escala (sem shear), também no qform — com pixdim
// igual às normas das colunas, como exigem FSL/ANTs/FreeSurfer para não acusar
// qform ≠ sform.

import { crc32 } from './zip.js'

const DT = { uint8: 2, int16: 4, int32: 8, float32: 16, uint16: 512 }
const BITS = { uint8: 8, int16: 16, int32: 32, float32: 32, uint16: 16 }
const ARR = { uint8: Uint8Array, int16: Int16Array, int32: Int32Array, float32: Float32Array, uint16: Uint16Array }

// nifti_mat44_to_quatern (nifti1_io.c): devolve null se a parte 3×3 tem shear
// (não é ortogonal após tirar a escala) — nesse caso só o sform é gravado.
function quaternFromAffine (A) {
  const col = (c) => [A[0][c], A[1][c], A[2][c]]
  const norm = (v) => Math.hypot(v[0], v[1], v[2])
  const cols = [col(0), col(1), col(2)]
  const dx = norm(cols[0]), dy = norm(cols[1]), dz = norm(cols[2])
  if (!(dx > 0 && dy > 0 && dz > 0)) return null
  const u = [cols[0].map(v => v / dx), cols[1].map(v => v / dy), cols[2].map(v => v / dz)]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  // shear: colunas não ortogonais → qform não representa a affine
  if (Math.abs(dot(u[0], u[1])) > 1e-4 || Math.abs(dot(u[0], u[2])) > 1e-4 || Math.abs(dot(u[1], u[2])) > 1e-4) return null
  // matriz de rotação R (colunas u0,u1,u2); det < 0 → qfac = −1 e nega a 3ª coluna
  let r = [[u[0][0], u[1][0], u[2][0]], [u[0][1], u[1][1], u[2][1]], [u[0][2], u[1][2], u[2][2]]]
  const det = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
    r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
    r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0])
  let qfac = 1
  if (det < 0) { qfac = -1; r = r.map(row => [row[0], row[1], -row[2]]) }
  const [[r11, r12, r13], [r21, r22, r23], [r31, r32, r33]] = r
  let a = r11 + r22 + r33 + 1
  let b, c, d
  if (a > 0.5) {
    a = 0.5 * Math.sqrt(a)
    b = 0.25 * (r32 - r23) / a
    c = 0.25 * (r13 - r31) / a
    d = 0.25 * (r21 - r12) / a
  } else {
    const xd = 1 + r11 - (r22 + r33)
    const yd = 1 + r22 - (r11 + r33)
    const zd = 1 + r33 - (r11 + r22)
    if (xd > 1) {
      b = 0.5 * Math.sqrt(xd); c = 0.25 * (r12 + r21) / b; d = 0.25 * (r13 + r31) / b; a = 0.25 * (r32 - r23) / b
    } else if (yd > 1) {
      c = 0.5 * Math.sqrt(yd); b = 0.25 * (r12 + r21) / c; d = 0.25 * (r23 + r32) / c; a = 0.25 * (r13 - r31) / c
    } else {
      d = 0.5 * Math.sqrt(zd); b = 0.25 * (r13 + r31) / d; c = 0.25 * (r23 + r32) / d; a = 0.25 * (r21 - r12) / d
    }
    if (a < 0) { b = -b; c = -c; d = -d }
  }
  return { b, c, d, qfac, pix: [dx, dy, dz] }
}

export function writeNifti ({ dims, pixDims, affine, datatype = 'uint8', description = '' }, data) {
  const [nx, ny, nz] = dims
  const nvox = nx * ny * nz
  if (!DT[datatype]) throw new Error(`tipo de dado NIfTI não suportado: ${datatype}`)
  if (data.length !== nvox) throw new Error(`dados (${data.length}) ≠ dims (${nvox})`)
  if ([nx, ny, nz].some(n => !(n >= 1 && n <= 32767))) throw new Error('dimensão fora do limite do NIfTI-1 (1–32767)')
  const bytesPer = BITS[datatype] / 8
  // o vetor precisa ter o mesmo tipo declarado no cabeçalho (senão os bytes não batem)
  if (!(data instanceof ARR[datatype])) data = ARR[datatype].from(data)
  const buf = new ArrayBuffer(352 + nvox * bytesPer)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)

  dv.setInt32(0, 348, true)                       // sizeof_hdr
  u8[38] = 0x72                                   // regular = 'r'
  dv.setInt16(40, 3, true)                        // dim[0]
  dv.setInt16(42, nx, true); dv.setInt16(44, ny, true); dv.setInt16(46, nz, true)
  dv.setInt16(48, 1, true); dv.setInt16(50, 1, true); dv.setInt16(52, 1, true); dv.setInt16(54, 1, true)
  dv.setInt16(70, DT[datatype], true)             // datatype
  dv.setInt16(72, BITS[datatype], true)           // bitpix
  const q = affine ? quaternFromAffine(affine) : null
  // pixdim: normas das colunas da affine (o que os leitores esperam); sem affine, o informado
  const pix = q ? q.pix : affine
    ? [0, 1, 2].map(c => Math.hypot(affine[0][c], affine[1][c], affine[2][c]))
    : pixDims.map(Math.abs)
  dv.setFloat32(76, q ? q.qfac : 1, true)         // pixdim[0] (qfac)
  dv.setFloat32(80, pix[0], true)
  dv.setFloat32(84, pix[1], true)
  dv.setFloat32(88, pix[2], true)
  dv.setFloat32(92, 1, true)                      // pixdim[4]
  dv.setFloat32(108, 352, true)                   // vox_offset
  dv.setFloat32(112, 1, true)                     // scl_slope
  dv.setFloat32(116, 0, true)                     // scl_inter
  dv.setUint8(123, 2 | 8)                         // xyzt_units = mm + s
  // descrição (80 bytes, terminada em NUL) — corta em BYTES sem partir um caractere UTF-8
  u8.set(utf8Bytes(description, 79), 148)
  if (affine) {
    dv.setInt16(252, q ? 1 : 0, true)             // qform_code = 1 (scanner) quando representável
    dv.setInt16(254, 1, true)                     // sform_code = 1 (scanner)
    if (q) {
      dv.setFloat32(256, q.b, true); dv.setFloat32(260, q.c, true); dv.setFloat32(264, q.d, true)
      dv.setFloat32(268, affine[0][3], true); dv.setFloat32(272, affine[1][3], true); dv.setFloat32(276, affine[2][3], true)
    }
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        dv.setFloat32(280 + (r * 4 + c) * 4, affine[r][c], true)
      }
    }
  }
  // magic "n+1\0"
  u8[344] = 0x6e; u8[345] = 0x2b; u8[346] = 0x31; u8[347] = 0

  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  u8.set(bytes, 352)
  return buf
}

function utf8Bytes (str, maxBytes) {
  const full = new TextEncoder().encode(String(str))
  if (full.length <= maxBytes) return full
  // recua até o início de um caractere (bytes de continuação são 10xxxxxx)
  let end = maxBytes
  while (end > 0 && (full[end] & 0xC0) === 0x80) end--
  return full.slice(0, end)
}

export async function gzipBuffer (arrayBuffer) {
  // sem CompressionStream (navegador antigo): gzip VÁLIDO com blocos deflate
  // "stored" — o arquivo sai .nii.gz legível, só não fica menor
  if (typeof CompressionStream === 'undefined') return gzipStored(arrayBuffer)
  const cs = new CompressionStream('gzip')
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(cs)
  return await new Response(stream).arrayBuffer()
}

function gzipStored (arrayBuffer) {
  const data = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer)
  const nBlocks = Math.max(1, Math.ceil(data.length / 65535))
  const out = new Uint8Array(10 + nBlocks * 5 + data.length + 8)
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255], 0)
  const dv = new DataView(out.buffer)
  let p = 10
  for (let b = 0; b < nBlocks; b++) {
    const start = b * 65535
    const len = Math.min(65535, data.length - start)
    out[p] = b === nBlocks - 1 ? 1 : 0
    dv.setUint16(p + 1, len, true)
    dv.setUint16(p + 3, (~len) & 0xFFFF, true)
    out.set(data.subarray(start, start + len), p + 5)
    p += 5 + len
  }
  dv.setUint32(p, crc32(data), true)
  dv.setUint32(p + 4, data.length >>> 0, true)
  return out.buffer
}
