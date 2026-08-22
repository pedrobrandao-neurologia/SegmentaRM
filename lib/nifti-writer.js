// Escritor NIfTI-1 mínimo: cabeçalho de 348 bytes + extensão zero (vox_offset 352) + dados.
// Suficiente para salvar a segmentação (uint8) e volumes pré-processados (float32).

const DT = { uint8: 2, int16: 4, float32: 16 }
const BITS = { uint8: 8, int16: 16, float32: 32 }

export function writeNifti ({ dims, pixDims, affine, datatype = 'uint8', description = '' }, data) {
  const [nx, ny, nz] = dims
  const nvox = nx * ny * nz
  if (data.length !== nvox) throw new Error(`dados (${data.length}) ≠ dims (${nvox})`)
  const bytesPer = BITS[datatype] / 8
  const buf = new ArrayBuffer(352 + nvox * bytesPer)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)

  dv.setInt32(0, 348, true)                       // sizeof_hdr
  dv.setInt16(40, 3, true)                        // dim[0]
  dv.setInt16(42, nx, true); dv.setInt16(44, ny, true); dv.setInt16(46, nz, true)
  dv.setInt16(48, 1, true); dv.setInt16(50, 1, true); dv.setInt16(52, 1, true); dv.setInt16(54, 1, true)
  dv.setInt16(70, DT[datatype], true)             // datatype
  dv.setInt16(72, BITS[datatype], true)           // bitpix
  dv.setFloat32(76, 1, true)                      // pixdim[0] (qfac)
  dv.setFloat32(80, Math.abs(pixDims[0]), true)
  dv.setFloat32(84, Math.abs(pixDims[1]), true)
  dv.setFloat32(88, Math.abs(pixDims[2]), true)
  dv.setFloat32(108, 352, true)                   // vox_offset
  dv.setFloat32(112, 1, true)                     // scl_slope
  dv.setFloat32(116, 0, true)                     // scl_inter
  // descrição (80 bytes)
  const desc = new TextEncoder().encode(description.slice(0, 79))
  u8.set(desc, 148)
  dv.setInt16(252, 0, true)                       // qform_code = 0
  dv.setInt16(254, 1, true)                       // sform_code = 1 (usar srow)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      dv.setFloat32(280 + (r * 4 + c) * 4, affine[r][c], true)
    }
  }
  // magic "n+1\0"
  u8[344] = 0x6e; u8[345] = 0x2b; u8[346] = 0x31; u8[347] = 0

  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  u8.set(bytes, 352)
  return buf
}

export async function gzipBuffer (arrayBuffer) {
  if (typeof CompressionStream === 'undefined') return arrayBuffer
  const cs = new CompressionStream('gzip')
  const stream = new Blob([arrayBuffer]).stream().pipeThrough(cs)
  return await new Response(stream).arrayBuffer()
}
