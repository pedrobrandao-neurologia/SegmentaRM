// SegmentaRM — orquestrador.
// Fluxo: entrada (DICOM→dcm2niix WASM | NIfTI) → régua de qualidade → pipeline
// (padrão: conformação | robusto: reamostragem cúbica + correção de viés → conformação)
// → segmentação (worker brainchop, tfjs) → estatísticas → exportações e coorte.

import { Niivue, NVImage, SLICE_TYPE } from './vendor/niivue.js'
import { Dcm2niix } from './vendor/dcm2niix/index.jpeg.js'
import { inferenceModelsList, brainChopOpts } from './brainchop/brainchop-parameters.js'
import { assessQuality } from './lib/quality.js'
import { computeStats, statsToCSV, statsToJSON, statsToWideRow } from './lib/stats.js'
import { GROUP_PT } from './lib/labels.js'
import { writeNifti, gzipBuffer } from './lib/nifti-writer.js'
import { tableToSav } from './lib/sav.js'
import { buildReport } from './lib/report.js'
import { makeZip } from './lib/zip.js'

const VERSION = '1.0.0'
const $ = (id) => document.getElementById(id)

// seleção de modelo → índice em inferenceModelsList (ids 1-based)
const MODEL_MAP = {
  aparc104: { high: 14, low: 15, pt: 'Aparc+Aseg 104 classes (córtex E/D, cerebelo, tronco, corpo caloso)' },
  aparc50: { high: 8, low: 9, pt: 'Aparc+Aseg 50 classes' },
  aseg18: { high: 4, low: 5, pt: 'Subcortical 18 classes (aseg compacta)' },
  tissue: { high: 2, low: 3, pt: 'Tecidos — cinzenta/branca' },
  tissueLight: { high: 1, low: 1, pt: 'Tecidos — leve (5 filtros, GPUs integradas/CPU)' },
  mask: { high: 12, low: 13, pt: 'Máscara encefálica' }
}

const state = {
  nv: null,
  rawVol: null,        // NVImage carregado (antes do pipeline)
  conformed: null,     // NVImage 256³ após conformação
  seg: null,           // Uint8Array 256³
  labelsMap: null,
  colormap: null,
  stats: null,
  quality: null,
  sidecar: null,
  inputDesc: '',
  pipelineUsed: '',
  modelUsed: '',
  worker: null,
  running: false,
  cohort: []
}

// ---------- console ----------
const consoleEl = $('console')
function log (txt, cls = '') {
  const p = document.createElement('p')
  p.textContent = txt
  if (cls) p.className = cls
  consoleEl.appendChild(p)
  consoleEl.scrollTop = consoleEl.scrollHeight
  while (consoleEl.children.length > 120) consoleEl.removeChild(consoleEl.children[1])
}
function progress (frac) {
  $('progress').style.width = Math.max(0, Math.min(100, frac * 100)) + '%'
}

// ---------- visualizador ----------
async function initViewer () {
  const nv = new Niivue({
    dragAndDropEnabled: false,
    backColor: [0.063, 0.07, 0.086, 1],
    show3Dcrosshair: true,
    crosshairColor: [0.71, 0.26, 0.23, 1]
  })
  await nv.attachToCanvas($('gl'))
  nv.setSliceType(nv.sliceTypeMultiplanar)
  nv.onLocationChange = (data) => {
    try {
      const mm = data.mm ? Array.from(data.mm).slice(0, 3).map(v => v.toFixed(0)).join(' ') : ''
      let labelTxt = ''
      if (data.values && data.values.length > 1 && state.labelsMap) {
        const idx = Math.round(data.values[1].value)
        const name = state.labelsMap[String(idx)]
        if (name && idx > 0) labelTxt = ' · ' + name
      }
      $('loc').textContent = mm ? `RAS ${mm} mm${labelTxt}` : '—'
    } catch { /* localizações fora do volume */ }
  }
  state.nv = nv
}

function deviceBadge () {
  const el = $('device-badge')
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL2'
      el.textContent = String(name).slice(0, 34)
      el.dataset.gpu = '1'
      return
    }
  } catch { /* sem WebGL */ }
  el.textContent = 'sem WebGL2 — usará CPU (lento)'
  el.dataset.gpu = '0'
  $('backend').value = 'cpu'
}

// ---------- entrada ----------
async function convertDicom (files) {
  log(`Convertendo ${files.length} arquivos DICOM com dcm2niix (WASM)…`)
  progress(0.05)
  const d = new Dcm2niix()
  await d.init()
  const out = await d.input(files).b('y').z('n').f('%p_%s_%d').run()
  const niis = out.filter(f => /\.nii$/i.test(f.name))
  const jsons = out.filter(f => /\.json$/i.test(f.name))
  if (!niis.length) throw new Error('dcm2niix não produziu nenhum NIfTI — a pasta contém uma série de imagem suportada?')
  log(`dcm2niix: ${niis.length} série(s) convertida(s).`, 'ok')
  const readSidecar = async (nii) => {
    const j = jsons.find(x => x.name.replace(/\.json$/i, '') === nii.name.replace(/\.nii$/i, ''))
    if (!j) return null
    try { return JSON.parse(await j.text()) } catch { return null }
  }
  if (niis.length === 1) {
    return { file: niis[0], sidecar: await readSidecar(niis[0]) }
  }
  // escolha de série
  const sel = $('series')
  sel.innerHTML = ''
  for (let i = 0; i < niis.length; i++) {
    const opt = document.createElement('option')
    const sc = await readSidecar(niis[i])
    opt.value = i
    opt.textContent = (sc && (sc.SeriesDescription || sc.ProtocolName)) ? `${sc.SeriesDescription || sc.ProtocolName} (${niis[i].name})` : niis[i].name
    sel.appendChild(opt)
  }
  $('series-field').hidden = false
  // maior série primeiro costuma ser a volumétrica
  let best = 0
  for (let i = 1; i < niis.length; i++) if (niis[i].size > niis[best].size) best = i
  sel.value = best
  sel.onchange = async () => {
    const f = niis[+sel.value]
    await loadVolumeFile(f, await readSidecar(f), `DICOM → ${f.name}`)
  }
  const f = niis[best]
  return { file: f, sidecar: await readSidecar(f) }
}

async function loadVolumeFile (file, sidecar, desc) {
  progress(0.15)
  const vol = await NVImage.loadFromFile({ file, name: file.name })
  const nv = state.nv
  while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
  await nv.addVolume(vol)
  state.rawVol = vol
  state.conformed = null
  state.seg = null
  state.stats = null
  state.sidecar = sidecar || null
  state.inputDesc = desc
  $('viewer-block').hidden = false
  $('empty').hidden = true
  $('results').hidden = true
  $('step-input').dataset.done = '1'

  // qualidade
  const dims = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
  const pixDims = [vol.hdr.pixDims[1], vol.hdr.pixDims[2], vol.hdr.pixDims[3]]
  state.quality = assessQuality({ dims, pixDims }, vol.img, sidecar)
  renderQuality(state.quality)
  $('step-quality').hidden = false
  $('step-run').hidden = false
  $('run').disabled = false
  $('stage-title').textContent = ($('subject').value || file.name.replace(/\.nii(\.gz)?$/i, ''))
  $('stage-lede').textContent = `${desc} — ${dims.join('×')} voxels de ${pixDims.map(p => Math.abs(p).toFixed(2)).join('×')} mm. ` +
    `Régua de qualidade: nível ${state.quality.grade} (${state.quality.gradeTxt}).`
  log(`Exame carregado: ${dims.join('×')} @ ${pixDims.map(p => Math.abs(p).toFixed(2)).join('×')} mm — nível ${state.quality.grade}.`, 'ok')
  progress(0)
}

function renderQuality (q) {
  const grades = ['A', 'B', 'C', 'D']
  const gi = grades.indexOf(q.grade)
  const w = 320, seg = w / 4
  let svg = `<svg viewBox="0 0 ${w} 56" role="img" aria-label="Qualidade nível ${q.grade}">`
  for (let i = 0; i < 4; i++) {
    const active = i === gi
    svg += `<rect x="${i * seg + 1}" y="18" width="${seg - 4}" height="10" rx="1" fill="${active ? '#B5433A' : '#D8D3C9'}"/>`
    svg += `<text x="${i * seg + 1}" y="46" font-family="JetBrains Mono,monospace" font-size="11" font-weight="${active ? 700 : 400}" fill="${active ? '#8E332C' : '#9BA0A6'}">${grades[i]}</text>`
  }
  // marcas de régua
  for (let i = 0; i <= 16; i++) {
    svg += `<line x1="${i * w / 16}" y1="8" x2="${i * w / 16}" y2="${i % 4 === 0 ? 15 : 12}" stroke="#C6C0B4" stroke-width="1"/>`
  }
  svg += `<text x="${w}" y="46" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10" fill="#6B7076">${q.gradeTxt}</text></svg>`
  $('ruler').innerHTML = svg
  const ul = $('findings')
  ul.innerHTML = ''
  for (const f of q.findings) {
    const li = document.createElement('li')
    li.textContent = f.txt
    if (f.bad) li.className = 'bad'
    ul.appendChild(li)
  }
}

// ---------- pipeline ----------
function effectivePipeline () {
  const sel = $('pipeline').value
  if (sel === 'auto') return state.quality && state.quality.robustRecommended ? 'robust' : 'standard'
  return sel
}

function affineOf (vol) {
  const a = vol.hdr.affine
  return Array.isArray(a[0]) ? a.map(r => Array.from(r)) : [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => a[r * 4 + c]))
}

async function robustPreprocess (vol) {
  const dims = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
  const pixDims = [vol.hdr.pixDims[1], vol.hdr.pixDims[2], vol.hdr.pixDims[3]]
  const src = new Float32Array(vol.img.length)
  const slope = vol.hdr.scl_slope || 1
  const inter = vol.hdr.scl_inter || 0
  for (let i = 0; i < src.length; i++) src[i] = vol.img[i] * slope + inter
  const worker = new Worker('./workers/preprocess.worker.js')
  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { log('· ' + m.txt); progress(0.15 + m.frac * 0.2) }
      else if (m.cmd === 'done') resolve(m)
      else if (m.cmd === 'error') reject(new Error(m.message))
    }
    worker.onerror = (e) => reject(new Error(e.message || 'falha no worker de pré-processamento'))
    worker.postMessage({
      data: src, dims, pixDims, targetIso: 1.0,
      doBias: $('opt-bias').checked, doSmooth: $('opt-smooth').checked
    }, [src.buffer])
  })
  worker.terminate()
  // ajusta o affine: colunas escalam pela razão de reamostragem; origem desloca meio voxel
  const A = affineOf(vol)
  const newA = A.map(r => r.slice())
  for (let ax = 0; ax < 3; ax++) {
    const scale = dims[ax] / result.dims[ax]
    for (let r = 0; r < 3; r++) {
      newA[r][3] += A[r][ax] * (0.5 * scale - 0.5)
      newA[r][ax] = A[r][ax] * scale
    }
  }
  const buf = writeNifti({ dims: result.dims, pixDims: result.pixDims, affine: newA, datatype: 'float32', description: 'segmentarm robust pre' }, result.data)
  const file = new File([buf], 'preprocessado.nii')
  return await NVImage.loadFromFile({ file, name: 'preprocessado.nii' })
}

async function runSegmentation () {
  if (state.running || !state.rawVol) return
  state.running = true
  $('run').disabled = true
  try {
    const nv = state.nv
    const pipeline = effectivePipeline()
    let workVol = state.rawVol
    if (pipeline === 'robust') {
      log('Modo robusto: reamostragem cúbica + correção de campo de viés (aproximação clássica; não é a rede SynthSR).')
      workVol = await robustPreprocess(state.rawVol)
      state.pipelineUsed = 'robusto (reamostragem cúbica Catmull-Rom' + ($('opt-bias').checked ? ' + correção de viés' : '') + ($('opt-smooth').checked ? ' + suavização' : '') + ') → conformação'
    } else {
      state.pipelineUsed = 'padrão (conformação direta)'
    }

    log('Conformando para 256³ · 1 mm (estilo FreeSurfer)…')
    progress(0.4)
    while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
    await nv.addVolume(workVol)
    const conformed = await nv.conform(workVol, false, true, false, true)
    while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
    await nv.addVolume(conformed)
    state.conformed = conformed
    log('Conformação concluída.', 'ok')

    // modelo
    const kind = $('model').value
    const variant = $('mem').value === 'low' ? 'low' : 'high'
    const modelId = MODEL_MAP[kind][variant]
    const modelEntry = structuredClone(inferenceModelsList[modelId - 1])
    modelEntry.isNvidia = false
    try {
      const dbg = nv.gl.getExtension('WEBGL_debug_renderer_info')
      if (dbg) modelEntry.isNvidia = String(nv.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).includes('NVIDIA')
    } catch { /* segue como não-NVIDIA */ }
    state.modelUsed = MODEL_MAP[kind].pt + (variant === 'low' ? ' · memória baixa' : '')

    const opts = Object.assign({}, brainChopOpts)
    opts.rootURL = new URL('.', location.href).href.replace(/\/$/, '')
    opts.isGPU = $('backend').value !== 'cpu'
    opts.telemetryFlag = false

    log(`Segmentando com ${state.modelUsed} — ${opts.isGPU ? 'WebGL' : 'CPU'}…`)
    const seg = await new Promise((resolve, reject) => {
      const w = new Worker('./brainchop/brainchop-webworker.js', { type: 'module' })
      state.worker = w
      const t0 = performance.now()
      w.onmessage = (ev) => {
        const d = ev.data
        if (d.cmd === 'ui') {
          if (d.message) log('· ' + d.message)
          if (typeof d.progressFrac === 'number' && d.progressFrac >= 0) progress(0.45 + d.progressFrac * 0.45)
          if (d.modalMessage) { w.terminate(); state.worker = null; reject(new Error(d.modalMessage)) }
        } else if (d.cmd === 'img') {
          w.terminate(); state.worker = null
          log(`Inferência concluída em ${((performance.now() - t0) / 1000).toFixed(1)} s.`, 'ok')
          resolve(new Uint8Array(d.img))
        }
      }
      w.onerror = (e) => { w.terminate(); state.worker = null; reject(new Error(e.message || 'falha no worker de segmentação')) }
      w.postMessage({
        opts,
        modelEntry,
        niftiHeader: { datatypeCode: conformed.hdr.datatypeCode, dims: conformed.hdr.dims },
        niftiImage: conformed.img
      })
    })
    state.seg = seg

    // rótulos e colormap
    state.labelsMap = modelEntry.labelsPath ? await (await fetch(modelEntry.labelsPath)).json() : null
    state.colormap = modelEntry.colormapPath ? await (await fetch(modelEntry.colormapPath)).json() : null

    // sobreposição
    const overlay = await conformed.clone()
    overlay.zeroImage()
    overlay.hdr.scl_slope = 1
    overlay.hdr.scl_inter = 0
    overlay.img = new Uint8Array(seg)
    if (state.colormap) {
      overlay.setColormapLabel(state.colormap)
      overlay.hdr.intent_code = 1002
    } else {
      overlay.colormap = 'actc'
    }
    overlay.opacity = (+$('opacity').value) / 100
    await nv.addVolume(overlay)

    // estatísticas
    if (state.labelsMap) {
      log('Calculando estatísticas por estrutura…')
      progress(0.95)
      const affine = affineOf(conformed)
      state.stats = computeStats(seg, conformed.img, [256, 256, 256], state.labelsMap, affine, 1)
      renderResults()
      $('step-export').hidden = false
      $('step-run').dataset.done = '1'
      log(`Volume encefálico segmentado: ${(state.stats.brainVol / 1000).toFixed(0)} cm³.`, 'ok')
    } else {
      log('Modelo sem tabela de rótulos (máscara) — estatísticas limitadas.', 'ok')
      $('step-export').hidden = false
    }
    progress(0)
  } catch (e) {
    log('Erro: ' + e.message, 'err')
    if (/memory|memória|texture|alloc/i.test(String(e.message))) {
      log('Sugestão: troque "Memória" para Baixa, ou a execução para CPU.', 'err')
    }
    progress(0)
  } finally {
    state.running = false
    $('run').disabled = false
  }
}

// ---------- resultados ----------
function fmtVol (v) {
  return v >= 10000 ? (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' cm³'
    : Math.round(v).toLocaleString('pt-BR') + ' mm³'
}

function colorOfIndex (idx) {
  const cm = state.colormap
  if (!cm || !cm.R) return null
  const i = (cm.I || []).indexOf(idx)
  if (i < 0) return null
  return `rgb(${cm.R[i]},${cm.G[i]},${cm.B[i]})`
}

function renderResults () {
  const s = state.stats
  $('results').hidden = false

  // cartões de agregados
  const cards = $('cards')
  cards.innerHTML = ''
  for (const c of s.composites) {
    const div = document.createElement('div')
    div.className = 'card'
    div.innerHTML = `<div class="k">${c.ptName}</div><div class="v">${fmtVol(c.volMm3)} <small>${c.pctBrain.toFixed(1)}%</small></div>`
    cards.appendChild(div)
  }

  // filtro de grupos
  const gf = $('group-filter')
  gf.innerHTML = '<option value="">todos os grupos</option>'
  const groups = [...new Set(s.rows.filter(r => r.group !== 'fundo').map(r => r.group))]
  for (const g of groups) {
    const o = document.createElement('option')
    o.value = g
    o.textContent = GROUP_PT[g] || g
    gf.appendChild(o)
  }
  renderTable()
  renderLadder()
}

function renderTable () {
  const s = state.stats
  if (!s) return
  const filter = ($('filter').value || '').toLowerCase()
  const gsel = $('group-filter').value
  const thead = $('table').querySelector('thead')
  const tbody = $('table').querySelector('tbody')
  thead.innerHTML = '<tr><th>Estrutura</th><th>Hemisfério</th><th style="text-align:right">Volume (mm³)</th><th style="text-align:right">% encéfalo</th><th style="text-align:right">Intensidade média</th></tr>'
  tbody.innerHTML = ''
  let lastGroup = null
  for (const r of s.rows) {
    if (r.group === 'fundo' || r.volMm3 <= 0) continue
    if (gsel && r.group !== gsel) continue
    if (filter && !r.ptName.toLowerCase().includes(filter) && !r.name.toLowerCase().includes(filter)) continue
    if (r.group !== lastGroup) {
      const tr = document.createElement('tr')
      tr.className = 'groupsep'
      tr.innerHTML = `<td colspan="5">${GROUP_PT[r.group] || r.group}</td>`
      tbody.appendChild(tr)
      lastGroup = r.group
    }
    const tr = document.createElement('tr')
    const sw = colorOfIndex(r.index)
    tr.innerHTML = `<td>${sw ? `<i class="swatch" style="background:${sw}"></i>` : ''}${r.ptName}</td>` +
      `<td>${r.hemi || '—'}</td>` +
      `<td class="num">${Math.round(r.volMm3).toLocaleString('pt-BR')}</td>` +
      `<td class="num">${r.pctBrain.toFixed(2)}</td>` +
      `<td class="num">${r.meanInt.toFixed(1)}</td>`
    if (r.centroid) {
      tr.title = 'Clique para centralizar a mira nesta estrutura'
      tr.onclick = () => {
        const nv = state.nv
        try {
          nv.scene.crosshairPos = nv.mm2frac(r.centroid)
          nv.drawScene()
        } catch { /* mira fora do campo */ }
      }
    }
    tbody.appendChild(tr)
  }
}

function renderLadder () {
  const s = state.stats
  const pairs = s.pairs.slice(0, 30)
  const el = $('ladder')
  if (!pairs.length) { el.innerHTML = '<p class="note">O modelo escolhido não separa hemisférios — sem pares para comparar.</p>'; return }
  const W = 860, rowH = 21, left = 245, right = 70
  const H = pairs.length * rowH + 30
  const mid = left + (W - left - right) / 2
  const half = (W - left - right) / 2
  const maxV = Math.max(...pairs.map(p => Math.max(p.left, p.right)))
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Assimetria esquerda-direita">`
  svg += `<line x1="${mid}" y1="8" x2="${mid}" y2="${H - 20}" stroke="#C6C0B4" stroke-width="1"/>`
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const y = 14 + i * rowH
    const wl = p.left / maxV * (half - 6)
    const wr = p.right / maxV * (half - 6)
    const name = p.ptName.length > 34 ? p.ptName.slice(0, 33) + '…' : p.ptName
    svg += `<text x="${left - 10}" y="${y + 9}" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10.5" fill="#23262A">${escapeXml(name)}</text>`
    svg += `<rect x="${mid - wl}" y="${y}" width="${Math.max(1, wl)}" height="12" fill="#B5433A" rx="1"><title>${escapeXml(p.ptName)} E: ${Math.round(p.left)} mm³</title></rect>`
    svg += `<rect x="${mid}" y="${y}" width="${Math.max(1, wr)}" height="12" fill="#5B6B7A" rx="1"><title>${escapeXml(p.ptName)} D: ${Math.round(p.right)} mm³</title></rect>`
    const aiTxt = (p.ai > 0 ? '+' : '') + p.ai.toFixed(1) + '%'
    svg += `<text x="${W - 4}" y="${y + 9}" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10" fill="${Math.abs(p.ai) > 10 ? '#8E332C' : '#6B7076'}">${aiTxt}</text>`
  }
  svg += '</svg>'
  el.innerHTML = svg
}

function escapeXml (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// ---------- exportações ----------
function metaNow () {
  return {
    tool: 'SegmentaRM',
    version: VERSION,
    subject: $('subject').value || ($('stage-title').textContent || 'exame'),
    date: new Date().toISOString().slice(0, 10),
    input: state.inputDesc,
    quality: state.quality,
    pipeline: state.pipelineUsed,
    model: state.modelUsed,
    caveats: [
      'Uso em pesquisa e ensino; não é dispositivo médico.',
      'Volumes de exames anisotrópicos têm erro maior; reporte sequência e resolução de origem.',
      'Modelos treinados em T1; sequências T2/FLAIR degradam o resultado.'
    ]
  }
}

function saveBlob (data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

async function snapshotJpeg () {
  try {
    const nv = state.nv
    nv.drawScene()
    const url = nv.canvas.toDataURL('image/jpeg', 0.9)
    const bin = atob(url.split(',')[1])
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, w: nv.canvas.width, h: nv.canvas.height }
  } catch { return null }
}

async function makeExports () {
  const meta = metaNow()
  const dec = $('decimal').value
  return {
    meta,
    csv: () => statsToCSV(state.stats, meta, dec),
    json: () => statsToJSON(state.stats, meta),
    sav: () => {
      const { row, labels } = statsToWideRow(state.stats, meta)
      return tableToSav([row], labels, 'SegmentaRM ' + meta.subject)
    },
    pdf: async () => buildReport({ stats: state.stats, meta, snapshot: await snapshotJpeg() }),
    niiSeg: async () => {
      const A = affineOf(state.conformed)
      const buf = writeNifti({ dims: [256, 256, 256], pixDims: [1, 1, 1], affine: A, datatype: 'uint8', description: 'segmentarm ' + meta.model.slice(0, 40) }, state.seg)
      return await gzipBuffer(buf)
    },
    niiConf: async () => {
      const A = affineOf(state.conformed)
      const buf = writeNifti({ dims: [256, 256, 256], pixDims: [1, 1, 1], affine: A, datatype: 'uint8', description: 'segmentarm conformado' }, state.conformed.img)
      return await gzipBuffer(buf)
    }
  }
}

async function handleExport (kind) {
  if (!state.stats && !['nii-conf'].includes(kind) && !kind.startsWith('cohort')) {
    log('Nada para exportar ainda — rode a segmentação primeiro.', 'err')
    return
  }
  const sub = ($('subject').value || 'exame').replace(/[^\w.-]+/g, '_')
  try {
    const ex = await makeExports()
    switch (kind) {
      case 'csv': saveBlob(ex.csv(), `${sub}_volumes.csv`, 'text/csv;charset=utf-8'); break
      case 'json': saveBlob(ex.json(), `${sub}_volumes.json`, 'application/json'); break
      case 'sav': saveBlob(ex.sav(), `${sub}_volumes.sav`); break
      case 'pdf': saveBlob(await ex.pdf(), `${sub}_relatorio.pdf`, 'application/pdf'); break
      case 'nii-seg': saveBlob(await ex.niiSeg(), `${sub}_segmentacao.nii.gz`); break
      case 'nii-conf': saveBlob(await ex.niiConf(), `${sub}_conformado.nii.gz`); break
      case 'zip': {
        log('Montando o pacote…')
        const files = [
          { name: `${sub}_volumes.csv`, data: ex.csv() },
          { name: `${sub}_volumes.json`, data: ex.json() },
          { name: `${sub}_volumes.sav`, data: new Uint8Array(ex.sav()) },
          { name: `${sub}_relatorio.pdf`, data: new Uint8Array(await ex.pdf()) },
          { name: `${sub}_segmentacao.nii.gz`, data: new Uint8Array(await ex.niiSeg()) },
          { name: `${sub}_conformado.nii.gz`, data: new Uint8Array(await ex.niiConf()) }
        ]
        saveBlob(makeZip(files), `${sub}_segmentarm.zip`, 'application/zip')
        log('Pacote exportado.', 'ok')
        break
      }
      case 'queue': {
        const { row, labels } = statsToWideRow(state.stats, ex.meta)
        state.cohort = state.cohort.filter(e => e.row.subject !== row.subject)
        state.cohort.push({ row, labels })
        persistCohort()
        renderCohort()
        log(`Exame "${row.subject}" adicionado à coorte (${state.cohort.length}).`, 'ok')
        break
      }
      case 'cohort-csv': saveBlob(cohortCSV(), 'coorte_volumes.csv', 'text/csv;charset=utf-8'); break
      case 'cohort-sav': {
        const labels = Object.assign({}, ...state.cohort.map(e => e.labels))
        saveBlob(tableToSav(state.cohort.map(e => e.row), labels, 'Coorte SegmentaRM'), 'coorte_volumes.sav')
        break
      }
      case 'cohort-clear': state.cohort = []; persistCohort(); renderCohort(); break
    }
  } catch (e) {
    log('Erro na exportação: ' + e.message, 'err')
  }
}

function cohortCSV () {
  const dec = $('decimal').value
  const sep = dec === ',' ? ';' : ','
  const keys = []
  const seen = new Set()
  for (const e of state.cohort) for (const k of Object.keys(e.row)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
  const fmt = (v) => typeof v === 'number' ? (dec === ',' ? v.toFixed(2).replace('.', ',') : v.toFixed(2)) : (v == null ? '' : /[";\n,]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v)
  const lines = [keys.join(sep)]
  for (const e of state.cohort) lines.push(keys.map(k => fmt(e.row[k])).join(sep))
  return lines.join('\r\n')
}

function persistCohort () {
  try { localStorage.setItem('segmentarm_cohort_v1', JSON.stringify(state.cohort)) } catch { /* modo privado */ }
}
function renderCohort () {
  const n = state.cohort.length
  $('queue').textContent = n ? `${n} exame(s) na coorte: ${state.cohort.map(e => e.row.subject).join(', ')}` : 'Coorte vazia.'
  document.querySelector('[data-export="cohort-csv"]').disabled = !n
  document.querySelector('[data-export="cohort-sav"]').disabled = !n
  document.querySelector('[data-export="cohort-clear"]').hidden = !n
}

// ---------- entrada: ligações ----------
function wireInputs () {
  const drop = $('drop')
  drop.onclick = () => $('file-nifti').click()
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') $('file-nifti').click() }
  $('pick-file').onclick = () => $('file-nifti').click()
  $('pick-folder').onclick = () => $('file-dicom').click()
  $('file-nifti').onchange = async (e) => {
    if (!e.target.files.length) return
    const f = e.target.files[0]
    try { await loadVolumeFile(f, null, `NIfTI ${f.name}`) } catch (err) { log('Erro ao carregar: ' + err.message, 'err') }
  }
  $('file-dicom').onchange = async (e) => {
    if (!e.target.files.length) return
    try {
      const { file, sidecar } = await convertDicom(Array.from(e.target.files))
      await loadVolumeFile(file, sidecar, `DICOM → ${file.name}`)
    } catch (err) { log('Erro na conversão DICOM: ' + err.message, 'err'); progress(0) }
  }
  ;['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') }))
  ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over') }))
  drop.addEventListener('drop', async (e) => {
    e.preventDefault()
    try {
      const items = [...e.dataTransfer.items]
      const files = []
      const walk = async (entry, path) => {
        if (entry.isFile) {
          const f = await new Promise((res, rej) => entry.file(res, rej))
          f._webkitRelativePath = path + f.name
          files.push(f)
        } else if (entry.isDirectory) {
          const reader = entry.createReader()
          let batch
          do {
            batch = await new Promise((res, rej) => reader.readEntries(res, rej))
            for (const en of batch) await walk(en, path + entry.name + '/')
          } while (batch.length)
        }
      }
      for (const it of items) {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry()
        if (entry) await walk(entry, '')
      }
      if (!files.length) return
      const niiFile = files.find(f => /\.nii(\.gz)?$/i.test(f.name))
      if (files.length === 1 && niiFile) {
        await loadVolumeFile(niiFile, null, `NIfTI ${niiFile.name}`)
      } else {
        const { file, sidecar } = await convertDicom(files)
        await loadVolumeFile(file, sidecar, `DICOM → ${file.name}`)
      }
    } catch (err) { log('Erro na entrada: ' + err.message, 'err'); progress(0) }
  })

  $('load-example').onclick = async () => {
    try {
      log('Baixando o exame de exemplo (T1 real, 3 MB)…')
      const resp = await fetch('./example/t1_exemplo.nii.gz')
      const blob = await resp.blob()
      const f = new File([blob], 't1_exemplo.nii.gz')
      if (!$('subject').value) $('subject').value = 'EXEMPLO-T1'
      await loadVolumeFile(f, { SeriesDescription: 'T1 MPRAGE exemplo (brain2print)' }, 'Exemplo T1 volumétrico')
    } catch (err) { log('Erro no exemplo: ' + err.message, 'err') }
  }

  $('run').onclick = runSegmentation
  $('opacity').oninput = () => {
    const nv = state.nv
    if (nv.volumes.length > 1) {
      nv.setOpacity(1, (+$('opacity').value) / 100)
      nv.drawScene()
    }
  }
  $('slicetype').onchange = () => {
    const nv = state.nv
    const v = $('slicetype').value
    if (v === 'multi') nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
    else if (v === 'axial') nv.setSliceType(SLICE_TYPE.AXIAL)
    else if (v === 'coronal') nv.setSliceType(SLICE_TYPE.CORONAL)
    else if (v === 'sagittal') nv.setSliceType(SLICE_TYPE.SAGITTAL)
    else nv.setSliceType(SLICE_TYPE.RENDER)
  }
  $('filter').oninput = renderTable
  $('group-filter').onchange = renderTable
  $('subject').oninput = () => { $('stage-title').textContent = $('subject').value || 'Exame' }
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.onclick = () => handleExport(btn.dataset.export)
  })
}

// ---------- arranque ----------
async function main () {
  deviceBadge()
  await initViewer()
  wireInputs()
  try {
    state.cohort = JSON.parse(localStorage.getItem('segmentarm_cohort_v1') || '[]')
  } catch { state.cohort = [] }
  renderCohort()
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
  log('SegmentaRM ' + VERSION + ' pronto. Nenhuma imagem sai do dispositivo.')
}

main().catch(e => log('Falha na inicialização: ' + e.message, 'err'))
