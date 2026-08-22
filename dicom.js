// dicom.js — leitor mínimo de séries DICOM (Explicit/Implicit VR Little Endian).
// Não decodifica pixel data comprimido (JPEG, JPEG-LS, JPEG2000, RLE): nesses casos
// avisa o usuário para converter antes com dcm2niix.

const TS = {
  '1.2.840.10008.1.2': { implicit: true, le: true, compressed: false },
  '1.2.840.10008.1.2.1': { implicit: false, le: true, compressed: false },
  '1.2.840.10008.1.2.1.99': { implicit: false, le: true, compressed: true, label: 'Deflated' },
  '1.2.840.10008.1.2.2': { implicit: false, le: false, compressed: false },
  '1.2.840.10008.1.2.4.50': { compressed: true, label: 'JPEG Baseline' },
  '1.2.840.10008.1.2.4.51': { compressed: true, label: 'JPEG Extended' },
  '1.2.840.10008.1.2.4.57': { compressed: true, label: 'JPEG Lossless' },
  '1.2.840.10008.1.2.4.70': { compressed: true, label: 'JPEG Lossless SV1' },
  '1.2.840.10008.1.2.4.80': { compressed: true, label: 'JPEG-LS Lossless' },
  '1.2.840.10008.1.2.4.81': { compressed: true, label: 'JPEG-LS Lossy' },
  '1.2.840.10008.1.2.4.90': { compressed: true, label: 'JPEG 2000 Lossless' },
  '1.2.840.10008.1.2.4.91': { compressed: true, label: 'JPEG 2000' },
  '1.2.840.10008.1.2.5': { compressed: true, label: 'RLE' },
};

const VR_2BYTE_LEN = new Set(['AE', 'AS', 'AT', 'CS', 'DA', 'DS', 'DT', 'FL', 'FD', 'IS', 'LO', 'LT', 'PN', 'SH', 'SL', 'SS', 'ST', 'TM', 'UI', 'UL', 'US']);

const tag = (g, e) => (g << 16 | e) >>> 0;
const T = {
  TransferSyntax: tag(0x0002, 0x0010),
  Modality: tag(0x0008, 0x0060),
  SeriesDescription: tag(0x0008, 0x103e),
  PatientID: tag(0x0010, 0x0020),
  SeriesUID: tag(0x0020, 0x000e),
  SeriesNumber: tag(0x0020, 0x0011),
  InstanceNumber: tag(0x0020, 0x0013),
  ImagePosition: tag(0x0020, 0x0032),
  ImageOrientation: tag(0x0020, 0x0037),
  Rows: tag(0x0028, 0x0010),
  Columns: tag(0x0028, 0x0011),
  PixelSpacing: tag(0x0028, 0x0030),
  BitsAllocated: tag(0x0028, 0x0100),
  PixelRepresentation: tag(0x0028, 0x0103),
  SamplesPerPixel: tag(0x0028, 0x0002),
  NumberOfFrames: tag(0x0028, 0x0008),
  RescaleIntercept: tag(0x0028, 0x1052),
  RescaleSlope: tag(0x0028, 0x1053),
  SliceThickness: tag(0x0018, 0x0050),
  SpacingBetweenSlices: tag(0x0018, 0x0088),
  PixelData: tag(0x7fe0, 0x0010),
};

function readString(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function nums(s) {
  return String(s).split('\\').map(Number).filter((x) => !Number.isNaN(x));
}

/** Percorre o dataset e devolve um mapa tag -> {vr, off, len}. Para no PixelData. */
function parse(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 140) return null;
  if (readString(dv, 128, 4) !== 'DICM') return null;

  const el = new Map();
  let off = 132;
  let implicit = false, le = true;
  let ts = null;
  let inMeta = true;

  while (off + 8 <= buf.byteLength) {
    const g = dv.getUint16(off, le), e = dv.getUint16(off + 2, le);
    const key = tag(g, e);
    if (inMeta && g !== 0x0002) {
      inMeta = false;
      const info = TS[ts] || {};
      if (info.compressed) {
        const err = new Error(`Transfer syntax comprimido (${info.label || ts}). Converta com dcm2niix antes de enviar.`);
        err.code = 'COMPRESSED';
        throw err;
      }
      implicit = !!info.implicit;
      le = info.le !== false;
    }

    let vr = null, len = 0, hdr = 8;
    if (implicit && g !== 0x0002) {
      len = dv.getUint32(off + 4, le);
    } else {
      vr = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5));
      if (VR_2BYTE_LEN.has(vr)) {
        len = dv.getUint16(off + 6, le);
      } else {
        len = dv.getUint32(off + 8, le);
        hdr = 12;
      }
    }
    const dataOff = off + hdr;
    if (dataOff + len > buf.byteLength) break; // cabeçalho truncado: para aqui
    if (len === 0xffffffff) {
      const err = new Error('Pixel data com comprimento indefinido (encapsulado/comprimido). Converta com dcm2niix.');
      err.code = 'COMPRESSED';
      throw err;
    }
    el.set(key, { vr, off: dataOff, len, le });

    if (key === T.TransferSyntax) ts = readString(dv, dataOff, len);
    if (key === T.PixelData) break;
    off = dataOff + len + (len % 2);
  }
  el.__dv = dv;
  el.__le = le;
  return el;
}

function str(el, key) {
  const it = el.get(key);
  return it ? readString(el.__dv, it.off, it.len) : null;
}
function int(el, key, dflt = null) {
  const it = el.get(key);
  if (!it) return dflt;
  if (it.vr === 'US' || (!it.vr && it.len === 2)) return el.__dv.getUint16(it.off, it.le);
  if (it.vr === 'UL') return el.__dv.getUint32(it.off, it.le);
  const v = parseFloat(readString(el.__dv, it.off, it.len));
  return Number.isNaN(v) ? dflt : v;
}
function flt(el, key, dflt = null) {
  const s = str(el, key);
  if (s === null || s === '') return dflt;
  const v = parseFloat(s);
  return Number.isNaN(v) ? dflt : v;
}

/**
 * Agrupa arquivos DICOM por série.
 * @param {File[]} files
 * @param {(msg:string, frac:number)=>void} onProgress
 */
export async function groupSeries(files, onProgress = () => {}) {
  const series = new Map();
  let compressedCount = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (i % 25 === 0) onProgress(`Lendo cabeçalhos DICOM (${i + 1}/${files.length})`, i / files.length);
    let el;
    try {
      const head = await f.slice(0, Math.min(f.size, 65536)).arrayBuffer();
      el = parse(head);
    } catch (err) {
      if (err.code === 'COMPRESSED') { compressedCount++; continue; }
      continue;
    }
    if (!el) continue;
    const uid = str(el, T.SeriesUID);
    if (!uid) continue;
    if (!series.has(uid)) {
      series.set(uid, {
        uid,
        number: int(el, T.SeriesNumber, 0),
        description: str(el, T.SeriesDescription) || '(sem descrição)',
        modality: str(el, T.Modality) || '?',
        patientId: str(el, T.PatientID) || '',
        rows: int(el, T.Rows), cols: int(el, T.Columns),
        files: [],
      });
    }
    series.get(uid).files.push(f);
  }
  const out = [...series.values()].sort((a, b) => a.number - b.number);
  return { series: out, compressedCount };
}

/** Monta o volume 3D de uma série. */
export async function buildVolume(serie, onProgress = () => {}) {
  const slices = [];
  for (let i = 0; i < serie.files.length; i++) {
    if (i % 10 === 0) onProgress(`Lendo cortes (${i + 1}/${serie.files.length})`, i / serie.files.length);
    const buf = await serie.files[i].arrayBuffer();
    const el = parse(buf);
    if (!el) continue;
    const pd = el.get(T.PixelData);
    if (!pd) continue;
    if (int(el, T.SamplesPerPixel, 1) !== 1) throw new Error('Imagem colorida (RGB) não suportada.');
    slices.push({
      el, buf,
      ipp: nums(str(el, T.ImagePosition) || '0\\0\\0'),
      iop: nums(str(el, T.ImageOrientation) || '1\\0\\0\\0\\1\\0'),
      inst: int(el, T.InstanceNumber, i),
      pd,
    });
  }
  if (!slices.length) throw new Error('Nenhum corte legível nessa série.');

  const first = slices[0];
  const iop = first.iop.length === 6 ? first.iop : [1, 0, 0, 0, 1, 0];
  const rowDir = iop.slice(0, 3);           // direção de i (colunas)
  const colDir = iop.slice(3, 6);           // direção de j (linhas)
  const nrm = [
    rowDir[1] * colDir[2] - rowDir[2] * colDir[1],
    rowDir[2] * colDir[0] - rowDir[0] * colDir[2],
    rowDir[0] * colDir[1] - rowDir[1] * colDir[0],
  ];
  slices.sort((a, b) => {
    const da = a.ipp[0] * nrm[0] + a.ipp[1] * nrm[1] + a.ipp[2] * nrm[2];
    const db = b.ipp[0] * nrm[0] + b.ipp[1] * nrm[1] + b.ipp[2] * nrm[2];
    return da === db ? a.inst - b.inst : da - db;
  });

  const nx = int(first.el, T.Columns);
  const ny = int(first.el, T.Rows);
  const nFrames = int(first.el, T.NumberOfFrames, 1) || 1;
  const nz = slices.length > 1 ? slices.length : nFrames;
  const ps = nums(str(first.el, T.PixelSpacing) || '1\\1');
  const dj = ps[0] || 1, di = ps[1] || ps[0] || 1;

  let dk;
  if (slices.length > 1) {
    const a = slices[0].ipp, b = slices[slices.length - 1].ipp;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    dk = d / (slices.length - 1);
  } else {
    dk = flt(first.el, T.SpacingBetweenSlices, null) ?? flt(first.el, T.SliceThickness, 1) ?? 1;
  }
  if (!isFinite(dk) || dk <= 0) dk = flt(first.el, T.SliceThickness, 1) || 1;

  const bits = int(first.el, T.BitsAllocated, 16);
  const signed = int(first.el, T.PixelRepresentation, 0) === 1;
  const slope = flt(first.el, T.RescaleSlope, 1) ?? 1;
  const inter = flt(first.el, T.RescaleIntercept, 0) ?? 0;

  const data = new Float32Array(nx * ny * nz);
  const perSlice = nx * ny;
  for (let k = 0; k < slices.length; k++) {
    const s = slices[k];
    const dv = new DataView(s.buf, s.pd.off, s.pd.len);
    const nFr = slices.length > 1 ? 1 : nFrames;
    for (let f = 0; f < nFr; f++) {
      const base = (slices.length > 1 ? k : f) * perSlice;
      for (let p = 0; p < perSlice; p++) {
        const o = (f * perSlice + p) * (bits / 8);
        let v;
        if (bits === 8) v = signed ? dv.getInt8(o) : dv.getUint8(o);
        else if (bits === 16) v = signed ? dv.getInt16(o, true) : dv.getUint16(o, true);
        else v = signed ? dv.getInt32(o, true) : dv.getUint32(o, true);
        data[base + p] = v * slope + inter;
      }
    }
  }

  // Affine LPS -> RAS
  const ipp0 = first.ipp;
  const A = [
    [rowDir[0] * di, colDir[0] * dj, nrm[0] * dk, ipp0[0]],
    [rowDir[1] * di, colDir[1] * dj, nrm[1] * dk, ipp0[1]],
    [rowDir[2] * di, colDir[2] * dj, nrm[2] * dk, ipp0[2]],
  ];
  for (let c = 0; c < 4; c++) { A[0][c] = -A[0][c]; A[1][c] = -A[1][c]; }

  return {
    data,
    dims: [nx, ny, nz],
    pixdim: [di, dj, dk],
    affine: A,
    header: { source: 'dicom', series: serie.description, modality: serie.modality },
  };
}
