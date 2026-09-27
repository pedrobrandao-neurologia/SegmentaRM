// dicom-scan.js — triagem de estudos DICOM por cabeçalho e leitura direta.
// Portado do LUME (pedrobrandao-neurologia/LUME), do mesmo autor deste projeto.
// Lê apenas os primeiros KB de cada arquivo (sem pixel data) para agrupar por
// SeriesInstanceUID — permitindo escolher quais séries abrir antes de alocar
// memória — e oferece um leitor direto DICOM→NIfTI para séries não comprimidas
// (Little Endian implícito/explícito), que monta o volume corte a corte com o
// mínimo de memória, sem passar pelo conversor WASM.

const TS_IMPLICIT = '1.2.840.10008.1.2'
const TS_EXPLICIT_LE = '1.2.840.10008.1.2.1'

// tags de interesse: s=string · n=número · v=vetor de números · u=uint16 binário
const WANT = {
  '00080008': 's', // ImageType (multivalorado, separado por '\')
  '00080020': 's', // StudyDate — só para calcular a idade; não sai do cabeçalho
  '00080022': 's', // AcquisitionDate — idem
  '00080060': 's', // Modality
  '00080070': 's', // Manufacturer
  '00081090': 's', // ManufacturersModelName
  '00100030': 's', // PatientBirthDate — só para calcular a idade; não sai do cabeçalho
  '00100040': 's', // PatientSex
  '00101010': 's', // PatientAge (nnnD/W/M/Y)
  '0008103e': 's', // SeriesDescription
  '00180010': 's', // ContrastBolusAgent
  '00180020': 's', // ScanningSequence
  '00180021': 's', // SequenceVariant
  '00180023': 's', // MRAcquisitionType (2D/3D)
  '00180024': 's', // SequenceName
  '00180050': 'n', // SliceThickness
  '00180060': 'n', // KVP
  '00180080': 'n', // RepetitionTime (ms)
  '00180081': 'n', // EchoTime (ms)
  '00180082': 'n', // InversionTime (ms)
  '00180087': 'n', // MagneticFieldStrength
  '00181020': 's', // SoftwareVersions
  '00181030': 's', // ProtocolName
  '00181314': 'n', // FlipAngle
  '0020000e': 's', // SeriesInstanceUID
  '00200011': 'n', // SeriesNumber
  '00200013': 'n', // InstanceNumber
  '00200032': 'v', // ImagePositionPatient
  '00200037': 'v', // ImageOrientationPatient
  '00280002': 'u', // SamplesPerPixel
  '00280008': 'n', // NumberOfFrames
  '00280010': 'u', // Rows
  '00280011': 'u', // Columns
  '00280030': 'v', // PixelSpacing
  '00280100': 'u', // BitsAllocated
  '00280103': 'u', // PixelRepresentation
  '00281052': 'n', // RescaleIntercept
  '00281053': 'n', // RescaleSlope
}
// VRs com 2 bytes reservados + comprimento de 32 bits (PS3.5 7.1.2, inclusive os de 64 bits)
const LONG_VRS = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV'])
const TS_EXPLICIT_BE = '1.2.840.10008.1.2.2'
const TS_DEFLATE = '1.2.840.10008.1.2.1.99'
const SOP_DICOMDIR = '1.2.840.10008.1.3.10'
const dec = new TextDecoder('ascii')

function u16 (b, p, le = true) { return le ? (b[p] | (b[p + 1] << 8)) : ((b[p] << 8) | b[p + 1]) }
function u32 (b, p, le = true) {
  return le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
    : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0
}
const key = (g, e) => (g.toString(16).padStart(4, '0') + e.toString(16).padStart(4, '0'))
const isVR = (c1, c2) => c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90

function readValue (kind, vr, buf, pos, len, le = true) {
  if (kind === 'u' && (vr === 'US' || (vr === '' && len === 2))) return u16(buf, pos, le)
  const s = dec.decode(buf.subarray(pos, pos + Math.min(len, 256))).replace(/\0+$/, '').trim()
  if (kind === 's') return s
  if (kind === 'n' || kind === 'u') return parseFloat(s)
  if (kind === 'v') return s.split('\\').map(parseFloat)
  return s
}

// cabeçalho de um elemento; null se não cabe no buffer. Itens/delimitadores (FFFE,xxxx)
// nunca têm VR. VR implícita é sempre little endian.
function readElem (buf, pos, explicit, le) {
  if (pos + 8 > buf.length) return null
  const g = u16(buf, pos, le), e = u16(buf, pos + 2, le)
  if (g === 0xfffe) return { g, e, vr: '', len: u32(buf, pos + 4, le), dataPos: pos + 8 }
  if (explicit) {
    const c1 = buf[pos + 4], c2 = buf[pos + 5]
    if (!isVR(c1, c2)) return { g, e, vr: '??', len: 0, dataPos: pos + 8, bad: true }
    const vr = String.fromCharCode(c1, c2)
    if (LONG_VRS.has(vr)) {
      if (pos + 12 > buf.length) return null
      return { g, e, vr, len: u32(buf, pos + 8, le), dataPos: pos + 12 }
    }
    return { g, e, vr, len: u16(buf, pos + 6, le), dataPos: pos + 8 }
  }
  return { g, e, vr: '', len: u32(buf, pos + 4, true), dataPos: pos + 8 }
}

// pula o conteúdo de uma sequência de comprimento indefinido, respeitando o
// ANINHAMENTO (itens definidos/indefinidos, SQ dentro de SQ, UN indefinido — que
// é codificado em VR implícita LE). Procurar só o padrão FFFE,E0DD parava no
// delimitador da sequência interna e lia elementos aninhados como se fossem do
// nível principal. → posição após o delimitador; −2 = precisa de mais bytes; −1 = malformado
function skipUndefSeq (buf, pos, explicit, le, depth = 0) {
  if (depth > 64) return -1
  for (;;) {
    const it = readElem(buf, pos, explicit, le)
    if (!it) return -2
    if (it.g !== 0xfffe) return -1
    if (it.e === 0xe0dd) return it.dataPos // fim da sequência
    if (it.e !== 0xe000) return -1
    if (it.len !== 0xffffffff) { pos = it.dataPos + it.len; continue }
    pos = it.dataPos
    for (;;) { // elementos do item até (FFFE,E00D)
      const x = readElem(buf, pos, explicit, le)
      if (!x) return -2
      if (x.bad) return -1
      if (x.g === 0xfffe && x.e === 0xe00d) { pos = x.dataPos; break }
      if (x.len === 0xffffffff) {
        const un = x.vr === 'UN'
        const r = skipUndefSeq(buf, x.dataPos, un ? false : explicit, un ? true : le, depth + 1)
        if (r < 0) return r
        pos = r
      } else {
        pos = x.dataPos + x.len
        if (pos > buf.length) return -2
      }
    }
  }
}

/**
 * Analisa o cabeçalho de um arquivo, lendo só o necessário do disco.
 * @returns {{tags:object, ts:string, explicit:boolean, pixelOffset:number, pixelLength:number, dicomdir?:boolean, deflated?:boolean}|null}
 */
export async function parseDicomHeader (file, { needPixel = false } = {}) {
  let cap = 128 * 1024
  for (;;) {
    const buf = new Uint8Array(await file.slice(0, Math.min(cap, file.size)).arrayBuffer())
    const r = tryParse(buf, needPixel)
    if (r === 'again') {
      if (cap >= file.size || cap >= 8 * 1024 * 1024) {
        if (needPixel) return null
        const r2 = tryParse(buf, false, true)
        return r2 && r2 !== 'again' ? r2 : null
      }
      cap *= 4
      continue
    }
    return r
  }
}

function tryParse (buf, needPixel, lenient = false) {
  let pos = 0
  let explicit = true
  let ts = TS_EXPLICIT_LE
  let preamble = false
  let sopClass = ''
  const tags = {}
  if (buf.length > 132 && dec.decode(buf.subarray(128, 132)) === 'DICM') {
    preamble = true
    pos = 132
    // grupo meta (0002): sempre explicit little endian
    while (pos + 8 <= buf.length) {
      const el = readElem(buf, pos, true, true)
      if (!el || el.g !== 0x0002 || el.bad) break
      const val = () => dec.decode(buf.subarray(el.dataPos, el.dataPos + el.len)).replace(/\0+$/, '').trim()
      if (el.e === 0x0010) ts = val()
      else if (el.e === 0x0002) sopClass = val()
      pos = el.dataPos + el.len
    }
    explicit = ts !== TS_IMPLICIT
  } else {
    // sem preâmbulo: detecta explicit pelo VR plausível no primeiro elemento
    if (buf.length < 8) return null
    explicit = isVR(buf[4], buf[5])
    ts = explicit ? TS_EXPLICIT_LE : TS_IMPLICIT
  }
  const base = { tags, ts, explicit, pixelOffset: -1, pixelLength: 0 }
  // DICOMDIR (índice da mídia): não é imagem — o chamador descarta
  if (sopClass === SOP_DICOMDIR) return { ...base, dicomdir: true }
  // deflate: o dataset inteiro está comprimido — sem tags legíveis aqui
  if (ts === TS_DEFLATE) return { ...base, deflated: true }
  const le = ts !== TS_EXPLICIT_BE

  let sane = 0
  let lastG = 0
  const partial = () => (lenient || sane) ? base : null
  while (pos + 8 <= buf.length) {
    const el = readElem(buf, pos, explicit, le)
    if (!el) break
    const { g, e, vr, len, dataPos } = el
    if (g === 0xfffe) { // delimitadores soltos
      pos = dataPos + (len === 0xffffffff ? 0 : len)
      continue
    }
    // sanidade: VR inválida, grupo fora de ordem ou além do pixel data → para aqui
    if (el.bad || g > 0x7fe0 || g < lastG || (sane === 0 && !preamble && g > 0x0008 && g !== 0x7fe0)) return partial()
    lastG = g
    sane++
    if (g === 0x7fe0 && e === 0x0010) {
      return { ...base, pixelOffset: len === 0xffffffff ? -1 : dataPos, pixelLength: len === 0xffffffff ? 0 : len }
    }
    if (len === 0xffffffff) { // SQ/UN indefinido
      const un = vr === 'UN'
      const next = skipUndefSeq(buf, dataPos, un ? false : explicit, un ? true : le)
      if (next === -2) return 'again'
      if (next < 0) return partial()
      pos = next
      continue
    }
    if (vr === 'SQ') { pos = dataPos + len; continue }
    const k = key(g, e)
    if (WANT[k] && dataPos + len <= buf.length) tags[k] = readValue(WANT[k], vr, buf, dataPos, len, le)
    pos = dataPos + len
    // triagem: com os grupos 0008–0028 lidos já temos tudo — para cedo
    if (!needPixel && g > 0x0028) return base
  }
  if (pos + 8 > buf.length && buf.length < 8 * 1024 * 1024) return 'again'
  return base
}

// data DICOM (AAAAMMDD) → Date UTC
function dataDicom (s) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(s || '').trim())
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return isNaN(d) ? null : d
}

/**
 * Idade NA DATA DO EXAME (não na data do processamento): data do estudo (ou da aquisição)
 * menos a data de nascimento; sem elas, o PatientAge (nnnY/M/W/D). As datas em si não
 * saem desta função — o sidecar leva só a idade em anos (1 casa) e a fonte.
 */
export function idadeNoExame (tags) {
  const exame = dataDicom(tags['00080020']) || dataDicom(tags['00080022'])
  const nasc = dataDicom(tags['00100030'])
  if (exame && nasc && exame > nasc) {
    const anos = (exame - nasc) / (365.2425 * 86400000)
    if (anos > 0 && anos < 120) return { IdadeNoExame: Math.round(anos * 10) / 10, IdadeFonte: 'DICOM: data do exame − data de nascimento' }
  }
  const pa = /^(\d{1,3})\s*([DWMY])$/i.exec(String(tags['00101010'] || '').trim())
  if (pa) {
    const v = +pa[1]
    const u = pa[2].toUpperCase()
    const anos = u === 'Y' ? v : u === 'M' ? v / 12 : u === 'W' ? v / 52.1775 : v / 365.2425
    if (anos > 0 && anos < 120) return { IdadeNoExame: Math.round(anos * 10) / 10, IdadeFonte: 'DICOM: PatientAge (0010,1010)' }
  }
  return {}
}

/**
 * Correção de distorção do gradiente pelo fabricante. Só a Siemens a declara em tag padrão
 * (ImageType: DIS3D / DIS2D / ND); na GE (GradWarp) e na Philips a informação fica em tags
 * privadas não padronizadas — o app responde "não verificado" em vez de supor.
 * Aceita o sidecar (ImageType como vetor ou string, Manufacturer).
 */
export function correcaoDistorcao (sidecar) {
  const fab = String((sidecar && sidecar.Manufacturer) || '').toLowerCase()
  let it = sidecar && sidecar.ImageType
  if (typeof it === 'string') it = it.split('\\')
  const tipos = (Array.isArray(it) ? it : []).map(x => String(x).trim().toUpperCase())
  if (/siemens/.test(fab)) {
    if (tipos.includes('DIS3D')) return 'aplicada (3D; ImageType DIS3D)'
    if (tipos.includes('DIS2D')) return 'aplicada (2D; ImageType DIS2D)'
    if (tipos.includes('ND')) return 'NÃO aplicada (ImageType ND)'
  }
  return 'não verificado'
}

/** Sidecar no formato do dcm2niix (tempos em segundos) a partir das tags. */
function sidecarFrom (t) {
  const sx = String(t['00100040'] || '').trim().toUpperCase()
  const sc = {
    ImageType: t['00080008'] ? String(t['00080008']).split('\\').map(x => x.trim()).filter(Boolean) : undefined,
    PatientSex: sx === 'M' || sx === 'F' ? sx : undefined,
    ...idadeNoExame(t),
    ScanningSequence: t['00180020'] || undefined,
    SequenceVariant: t['00180021'] || undefined,
    MRAcquisitionType: t['00180023'] || undefined,
    SequenceName: t['00180024'] || undefined,
    SoftwareVersions: t['00181020'] || undefined,
    FlipAngle: t['00181314'] || undefined,
    Modality: t['00080060'],
    Manufacturer: t['00080070'],
    ManufacturersModelName: t['00081090'],
    SeriesDescription: t['0008103e'],
    ProtocolName: t['00181030'],
    SeriesNumber: t['00200011'],
    ContrastBolusAgent: t['00180010'],
    SliceThickness: t['00180050'],
    KVP: t['00180060'],
    MagneticFieldStrength: t['00180087'],
    RepetitionTime: t['00180080'] ? t['00180080'] / 1000 : undefined,
    EchoTime: t['00180081'] ? t['00180081'] / 1000 : undefined,
    InversionTime: t['00180082'] ? t['00180082'] / 1000 : undefined,
  }
  sc.CorrecaoDistorcao = correcaoDistorcao({ ...sc, Manufacturer: t['00080070'] })
  return sc
}

/**
 * Agrupa arquivos DICOM por série lendo apenas cabeçalhos (memória mínima).
 * @returns {Promise<Array<{uid, desc, sidecar, files, items, bytes, count, supportedDirect}>>}
 */
export async function scanDicomSeries (files, onProgress) {
  const groups = new Map()
  let done = 0
  const queue = [...files]
  async function worker () {
    for (;;) {
      const file = queue.shift()
      if (!file) return
      let h = null
      try { h = await parseDicomHeader(file) } catch { /* ilegível → ignora */ }
      done++
      if (done % 50 === 0) onProgress?.(done, files.length)
      if (!h || h.dicomdir) continue
      const t = h.tags
      // objetos sem imagem (SR, estado de apresentação, RT…) não viram "série"
      if (!h.deflated && !t['00280010'] && !t['00280011']) continue
      const uid = t['0020000e'] || '(sem UID de série)'
      let g = groups.get(uid)
      if (!g) {
        g = {
          uid,
          desc: t['0008103e'] || t['00181030'] || '(sem descrição)',
          sidecar: sidecarFrom(t),
          files: [], items: [], bytes: 0, count: 0,
          ts: h.ts,
          supportedDirect:
            (h.ts === TS_IMPLICIT || h.ts === TS_EXPLICIT_LE) &&
            (t['00280103'] ?? 0) <= 1 &&
            (t['00280002'] ?? 1) === 1 &&
            !(t['00280008'] > 1) &&
            (t['00280100'] === 8 || t['00280100'] === 16) &&
            Array.isArray(t['00200037']) && Array.isArray(t['00200032']),
        }
        groups.set(uid, g)
      }
      g.files.push(file)
      g.items.push({ file, tags: t })
      g.bytes += file.size
      g.count++
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker))
  const out = [...groups.values()].filter((g) => g.count > 0)
  // a leitura direta só é segura numa pilha simples e regular; senão vai ao dcm2niix
  for (const g of out) {
    if (!g.supportedDirect) continue
    const why = directProblem(g)
    if (why) { g.supportedDirect = false; g.directReason = why }
  }
  out.sort((a, b) => (a.sidecar.SeriesNumber ?? 999) - (b.sidecar.SeriesNumber ?? 999))
  return out
}

// devolve o motivo pelo qual a série NÃO pode ser montada corte a corte, ou null
function directProblem (group) {
  const items = group.items
  const t0 = items[0].tags
  const iop0 = t0['00200037']
  if (!Array.isArray(iop0) || iop0.length < 6 || iop0.some(v => !isFinite(v))) return 'orientação ausente'
  const same = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol)
  for (const it of items) {
    const t = it.tags
    if (t['00280010'] !== t0['00280010'] || t['00280011'] !== t0['00280011']) return 'matriz varia na série'
    if (t['00280100'] !== t0['00280100'] || (t['00280103'] ?? 0) !== (t0['00280103'] ?? 0)) return 'formato de pixel varia na série'
    if (!same(t['00200037'], iop0, 1e-3)) return 'orientações diferentes na série (ex.: localizador 3 planos)'
    if (!Array.isArray(t['00200032']) || t['00200032'].length < 3) return 'corte sem posição'
    if ((t['00281053'] ?? 1) !== (t0['00281053'] ?? 1) || (t['00281052'] ?? 0) !== (t0['00281052'] ?? 0)) return 'rescale varia por corte'
    if (!same(t['00280030'] || [1, 1], t0['00280030'] || [1, 1], 1e-4)) return 'pixel spacing varia na série'
  }
  if (items.length < 2) return null
  const normal = cross(iop0.slice(0, 3), iop0.slice(3, 6))
  const proj = items.map(it => dot(it.tags['00200032'], normal)).sort((a, b) => a - b)
  const dz = []
  for (let i = 1; i < proj.length; i++) dz.push(proj[i] - proj[i - 1])
  const med = [...dz].sort((a, b) => a - b)[dz.length >> 1]
  if (!(med > 1e-3)) return 'cortes com posição repetida (multi-eco/temporal)'
  if (dz.some(d => Math.abs(d - med) > Math.max(0.02 * med, 0.01))) return 'espaçamento entre cortes irregular (corte faltando?)'
  return null
}

/* ---------------- leitura direta DICOM → NIfTI ---------------- */
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Monta um NIfTI em memória lendo os cortes DICOM um a um (sem conversor).
 * Suporta Little Endian implícito/explícito, corte único por arquivo, 8/16 bits.
 * @returns {Promise<{file: File, sidecar: object}>}
 */
export async function directSeriesToNifti (group, onProgress) {
  const first = group.items[0].tags
  const nx = first['00280011'], ny = first['00280010']
  const bits = first['00280100']
  const signed = first['00280103'] === 1
  const bpp = bits / 8
  if (!group.supportedDirect || !nx || !ny) throw new Error('série não suportada para leitura direta')

  // ordena os cortes pela projeção da posição sobre a normal do plano
  const iop = first['00200037']
  const rowDir = iop.slice(0, 3), colDir = iop.slice(3, 6)
  const normal = cross(rowDir, colDir)
  const slices = group.items
    .filter((it) => Array.isArray(it.tags['00200032']))
    .map((it) => ({ ...it, proj: dot(it.tags['00200032'], normal) }))
    .sort((a, b) => a.proj - b.proj)
  const nz = slices.length
  if (nz < 1) throw new Error('nenhum corte com posição espacial')

  const ps = first['00280030'] || [1, 1] // [entre linhas (dir. coluna), entre colunas (dir. linha)]
  const dzs = []
  for (let i = 1; i < nz; i++) dzs.push(slices[i].proj - slices[i - 1].proj)
  dzs.sort((a, b) => a - b)
  const dz = nz > 1 ? Math.abs(dzs[dzs.length >> 1]) || 1 : (first['00180050'] || 1)

  const Arr = bits === 8 ? Uint8Array : signed ? Int16Array : Uint16Array
  const out = new Arr(nx * ny * nz)
  const need = nx * ny * bpp
  for (let k = 0; k < nz; k++) {
    const it = slices[k]
    let off = it.pixelOffset
    if (off === undefined) {
      const h = await parseDicomHeader(it.file, { needPixel: true })
      if (!h || h.pixelOffset < 0 || h.pixelLength < need) throw new Error(`pixel data ausente em ${it.file.name}`)
      off = h.pixelOffset
      const r = h.tags['00280010'], c = h.tags['00280011']
      if ((r && r !== ny) || (c && c !== nx)) throw new Error('matriz varia dentro da série')
    }
    const bytes = await it.file.slice(off, off + need).arrayBuffer()
    out.set(new Arr(bytes), k * nx * ny)
    if ((k & 15) === 0) onProgress?.(k + 1, nz)
  }

  // afim LPS→RAS: colunas i (linha da imagem), j (coluna) e k (normal); nega x,y
  const ipp0 = slices[0].tags['00200032']
  const kDir = nz > 1
    ? slices[nz - 1].tags['00200032'].map((v, i2) => (v - ipp0[i2]) / (nz - 1))
    : normal.map((v) => v * dz)
  const ci = rowDir.map((v) => v * ps[1])
  const cj = colDir.map((v) => v * ps[0])
  const sgn = [-1, -1, 1]
  const srow = [0, 1, 2].map((r) => [sgn[r] * ci[r], sgn[r] * cj[r], sgn[r] * kDir[r], sgn[r] * ipp0[r]])

  const hdr = new ArrayBuffer(352)
  const v = new DataView(hdr)
  v.setInt32(0, 348, true)
  v.setInt16(40, 3, true)
  v.setInt16(42, nx, true); v.setInt16(44, ny, true); v.setInt16(46, nz, true)
  for (let i = 4; i <= 7; i++) v.setInt16(40 + i * 2, 1, true)
  v.setInt16(70, bits === 8 ? 2 : signed ? 4 : 512, true) // datatype
  v.setInt16(72, bits, true)
  v.setFloat32(76, 1, true)
  v.setFloat32(80, ps[1], true); v.setFloat32(84, ps[0], true); v.setFloat32(88, dz, true)
  v.setFloat32(92, 1, true) // pixdim[4]
  v.setFloat32(108, 352, true) // vox_offset
  v.setUint8(123, 2 | 8) // xyzt_units = mm + s
  v.setFloat32(112, first['00281053'] ?? 1, true) // scl_slope
  v.setFloat32(116, first['00281052'] ?? 0, true) // scl_inter
  v.setInt16(254, 1, true) // sform_code
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) v.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true)
  new Uint8Array(hdr, 344, 4).set([0x6e, 0x2b, 0x31, 0]) // "n+1"

  const name = `${(group.desc || 'serie').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'serie'}.nii`
  return { file: new File([hdr, out.buffer], name), sidecar: group.sidecar }
}
