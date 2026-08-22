// Escritor ZIP (método store, sem compressão) com CRC32 — para o pacote de exportação.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32 (bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** files: [{name, data: Uint8Array|ArrayBuffer|string}] → ArrayBuffer .zip */
export function makeZip (files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let off = 0
  const dosTime = (() => {
    const d = new Date()
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    }
  })()

  for (const f of files) {
    const nameB = enc.encode(f.name)
    const data = typeof f.data === 'string' ? enc.encode(f.data)
      : f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameB.length)
    const dv = new DataView(local.buffer)
    dv.setUint32(0, 0x04034b50, true)
    dv.setUint16(4, 20, true)
    dv.setUint16(6, 0x0800, true)       // UTF-8
    dv.setUint16(8, 0, true)            // store
    dv.setUint16(10, dosTime.time, true)
    dv.setUint16(12, dosTime.date, true)
    dv.setUint32(14, crc, true)
    dv.setUint32(18, data.length, true)
    dv.setUint32(22, data.length, true)
    dv.setUint16(26, nameB.length, true)
    local.set(nameB, 30)
    central.push({ nameB, crc, size: data.length, off })
    parts.push(local, data)
    off += local.length + data.length
  }

  const centralParts = []
  let centralSize = 0
  for (const c of central) {
    const rec = new Uint8Array(46 + c.nameB.length)
    const dv = new DataView(rec.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(4, 20, true); dv.setUint16(6, 20, true)
    dv.setUint16(8, 0x0800, true); dv.setUint16(10, 0, true)
    dv.setUint16(12, dosTime.time, true); dv.setUint16(14, dosTime.date, true)
    dv.setUint32(16, c.crc, true)
    dv.setUint32(20, c.size, true); dv.setUint32(24, c.size, true)
    dv.setUint16(28, c.nameB.length, true)
    dv.setUint32(42, c.off, true)
    rec.set(c.nameB, 46)
    centralParts.push(rec)
    centralSize += rec.length
  }
  const eocd = new Uint8Array(22)
  const dv = new DataView(eocd.buffer)
  dv.setUint32(0, 0x06054b50, true)
  dv.setUint16(8, central.length, true)
  dv.setUint16(10, central.length, true)
  dv.setUint32(12, centralSize, true)
  dv.setUint32(16, off, true)

  const all = [...parts, ...centralParts, eocd]
  const total = all.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const b of all) { out.set(b, p); p += b.length }
  return out.buffer
}
