// Identidade do protocolo de aquisição — usada para agrupar controles na calibração de sítio
// (nível C) e para a proveniência do laudo. Só campos técnicos do cabeçalho entram (nenhum
// identificador do paciente, nenhuma data). Dois níveis:
//  · familia — fabricante + modelo + campo + tipo de aquisição (2D/3D) + nome da série:
//              é a chave da calibração (tolera pequenas variações de FOV entre pacientes);
//  · id      — a família + TR/TE/TI/ângulo + voxel arredondado a 0,05 mm: protocolo exato.

const limpa = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toUpperCase()
const num = (v, d) => (v == null || v === '' || !isFinite(+v)) ? '' : (+v).toFixed(d)

/**
 * @param {object|null} sidecar  sidecar no formato do dcm2niix (tempos em segundos)
 * @param {number[]} pixDims     tamanho do voxel (mm) da imagem de entrada
 */
export function descritorProtocolo (sidecar, pixDims = []) {
  const sc = sidecar || {}
  const vox = pixDims.slice(0, 3).map(p => (Math.round(Math.abs(+p || 0) / 0.05) * 0.05).toFixed(2))
  const campos = {
    fabricante: limpa(sc.Manufacturer),
    modelo: limpa(sc.ManufacturersModelName),
    campoT: num(sc.MagneticFieldStrength, 1),
    aquisicao: limpa(sc.MRAcquisitionType),
    serie: limpa(sc.ProtocolName || sc.SeriesDescription),
    sequencia: limpa(sc.SequenceName || sc.ScanningSequence),
    trMs: num(sc.RepetitionTime != null ? sc.RepetitionTime * 1000 : null, 0),
    teMs: num(sc.EchoTime != null ? sc.EchoTime * 1000 : null, 1),
    tiMs: num(sc.InversionTime != null ? sc.InversionTime * 1000 : null, 0),
    anguloGraus: num(sc.FlipAngle, 0),
    voxelMm: vox.join('×')
  }
  const semDicom = !campos.fabricante && !campos.modelo && !campos.serie
  const familiaTxt = [campos.fabricante, campos.modelo, campos.campoT && campos.campoT + 'T', campos.aquisicao, campos.serie].filter(Boolean).join(' · ')
  return {
    campos,
    semDicom,
    familiaTxt: familiaTxt || 'protocolo não identificado (entrada sem cabeçalho DICOM)',
    chaveFamilia: JSON.stringify([campos.fabricante, campos.modelo, campos.campoT, campos.aquisicao, campos.serie]),
    chaveExata: JSON.stringify(campos)
  }
}

async function sha256curto (txt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt))
  return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** → { familia, id, familiaTxt, campos, semDicom } com hashes curtos (12 hex) */
export async function protocoloDe (sidecar, pixDims) {
  const d = descritorProtocolo(sidecar, pixDims)
  return {
    familia: await sha256curto(d.chaveFamilia),
    id: await sha256curto(d.chaveExata),
    familiaTxt: d.familiaTxt,
    campos: d.campos,
    semDicom: d.semDicom
  }
}
