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
import { fuseDKT } from './lib/dkt-fusion.js'
import { loadNorms, compareToNorms } from './lib/normative.js'

const VERSION = '1.0.0'
const $ = (id) => document.getElementById(id)

// seleção de modelo → índice em inferenceModelsList (ids 1-based)
// 'synthseg' é especial: usa a rede SynthSeg 1.0 original (worker próprio)
const MODEL_MAP = {
  synthseg: { synth: true, pt: 'SynthSeg 1.0 — rede original de Billot/Iglesias (32 estruturas)' },
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
  segKind: null,
  norms: null,
  native: null,        // { vol: NVImage, prov } — pré-processado no espaço nativo
  bet: null,           // { mask, brain, f, voxels, normalized, cleanupLog } no espaço conformado
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
    backColor: [0.027, 0.031, 0.039, 1],
    show3Dcrosshair: true,
    crosshairColor: [0.88, 0.45, 0.4, 1]
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
  state.segKind = null
  state.stats = null
  state.native = null
  state.bet = null
  $('run-dkt').disabled = true
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
  let svg = `<svg viewBox="0 0 ${w} 72" role="img" aria-label="Qualidade nível ${q.grade}">`
  for (let i = 0; i < 4; i++) {
    const active = i === gi
    svg += `<rect x="${i * seg + 1}" y="18" width="${seg - 4}" height="10" rx="1" fill="${active ? 'var(--accent)' : 'rgba(255,255,255,0.14)'}"/>`
    svg += `<text x="${i * seg + 1}" y="46" font-family="JetBrains Mono,monospace" font-size="11" font-weight="${active ? 700 : 400}" fill="${active ? 'var(--accent-strong)' : 'var(--faint)'}">${grades[i]}</text>`
  }
  // marcas de régua
  for (let i = 0; i <= 16; i++) {
    svg += `<line x1="${i * w / 16}" y1="8" x2="${i * w / 16}" y2="${i % 4 === 0 ? 15 : 12}" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`
  }
  svg += `<text x="1" y="66" font-family="JetBrains Mono,monospace" font-size="10" fill="var(--dim)">${q.gradeTxt}</text></svg>`
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
function dimsOf (vol) { return [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]] }
function pixDimsOf (vol) { return [Math.abs(vol.hdr.pixDims[1]), Math.abs(vol.hdr.pixDims[2]), Math.abs(vol.hdr.pixDims[3])] }
function voxVolOf (vol) { const p = pixDimsOf(vol); return p[0] * p[1] * p[2] }
function datatypeOf (img) {
  return img instanceof Uint8Array ? 'uint8' : img instanceof Int16Array ? 'int16' : 'float32'
}

// pré-processamento no espaço nativo (reorientação RAS ≈ fslreorient2std, recorte de
// pescoço ≈ robustfov, reamostragem do ramo robusto, viés, suavização) num Web Worker
async function preprocessNative (vol, flags) {
  const dims = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
  const pixDims = [vol.hdr.pixDims[1], vol.hdr.pixDims[2], vol.hdr.pixDims[3]]
  const src = new Float32Array(vol.img.length)
  const slope = vol.hdr.scl_slope || 1
  const inter = vol.hdr.scl_inter || 0
  for (let i = 0; i < src.length; i++) src[i] = vol.img[i] * slope + inter
  const A = affineOf(vol)
  const worker = new Worker('./workers/preprocess.worker.js', { type: 'module' })
  const result = await new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { log('· ' + m.txt); progress(0.15 + m.frac * 0.2) }
      else if (m.cmd === 'done') resolve(m)
      else if (m.cmd === 'error') reject(new Error(m.message))
    }
    worker.onerror = (e) => reject(new Error(e.message || 'falha no worker de pré-processamento'))
    worker.postMessage({
      data: src, dims, pixDims, affine: A.flat(), targetIso: 1.0, ...flags
    }, [src.buffer])
  })
  worker.terminate()
  const newA = [0, 1, 2, 3].map(r => result.affine.slice(r * 4, r * 4 + 4))
  const buf = writeNifti({ dims: result.dims, pixDims: result.pixDims, affine: newA, datatype: 'float32', description: 'segmentarm preproc nativo' }, result.data)
  const file = new File([buf], 'preprocessado.nii')
  const nvol = await NVImage.loadFromFile({ file, name: 'preprocessado.nii' })
  return { vol: nvol, prov: result.prov, buf }
}

// ---------- execução de redes (workers) ----------
function runWorker (url, message, pFrom, pTo) {
  return new Promise((resolve, reject) => {
    const w = new Worker(url, { type: 'module' })
    state.worker = w
    const t0 = performance.now()
    w.onmessage = (ev) => {
      const d = ev.data
      if (d.cmd === 'ui') {
        if (d.message) log('· ' + d.message)
        if (typeof d.progressFrac === 'number' && d.progressFrac >= 0) progress(pFrom + d.progressFrac * (pTo - pFrom))
        if (d.modalMessage) { w.terminate(); state.worker = null; reject(new Error(d.modalMessage)) }
      } else if (d.cmd === 'img') {
        w.terminate(); state.worker = null
        log(`Inferência concluída em ${((performance.now() - t0) / 1000).toFixed(1)} s.`, 'ok')
        resolve(new Uint8Array(d.img))
      }
    }
    w.onerror = (e) => { w.terminate(); state.worker = null; reject(new Error(e.message || 'falha no worker de segmentação')) }
    w.postMessage(message)
  })
}

function runSynthsegModel (conformed, isGPU, tile, pFrom, pTo, imgOverride = null) {
  log(`SynthSeg 1.0 — ${isGPU ? 'WebGL' : 'CPU'}, blocos de ${tile}³…`)
  return runWorker('./workers/synthseg.worker.js', {
    modelUrl: new URL('./models/synthseg1/model.json', location.href).href, // o worker resolve URLs relativas contra /workers/
    img: imgOverride || conformed.img,
    dims: dimsOf(conformed),
    affine: affineOf(conformed),
    isGPU,
    tile,
    overlap: 32
  }, pFrom, pTo)
}

function runBrainchopModel (modelId, conformed, isGPU, pFrom, pTo, { imgOverride = null, entryPatch = null } = {}) {
  const modelEntry = structuredClone(inferenceModelsList[modelId - 1])
  if (entryPatch) Object.assign(modelEntry, entryPatch)
  modelEntry.isNvidia = false
  try {
    const dbg = state.nv.gl.getExtension('WEBGL_debug_renderer_info')
    if (dbg) modelEntry.isNvidia = String(state.nv.gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).includes('NVIDIA')
  } catch { /* segue como não-NVIDIA */ }
  const opts = Object.assign({}, brainChopOpts)
  opts.rootURL = new URL('.', location.href).href.replace(/\/$/, '')
  opts.isGPU = isGPU
  opts.telemetryFlag = false
  log(`Rede ${modelEntry.modelName.replace(/[^\x20-\x7E]+\s*/g, '')} — ${isGPU ? 'WebGL' : 'CPU'}…`)
  return {
    seg: runWorker('./brainchop/brainchop-webworker.js', {
      opts,
      modelEntry,
      niftiHeader: { datatypeCode: conformed.hdr.datatypeCode, dims: conformed.hdr.dims },
      niftiImage: imgOverride || conformed.img
    }, pFrom, pTo),
    modelEntry
  }
}

// ---------- extração cerebral (≈ BET) ----------
function runMaskWorker ({ prob, intensity, dims, f, normalize }) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./workers/mask.worker.js', { type: 'module' })
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { log('· ' + m.txt); progress(0.72 + m.frac * 0.06) }
      else if (m.cmd === 'done') { w.terminate(); resolve(m) }
      else if (m.cmd === 'error') { w.terminate(); reject(new Error(m.message)) }
    }
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'falha no worker de máscara')) }
    w.postMessage({ prob, intensity: Uint8Array.from(intensity), dims, f, normalize }, [prob.buffer])
  })
}

// ?mockbet — pseudo-probabilidade a partir da intensidade conformada, para testar o
// encadeamento (limpeza, overlay, exportações) sem custo de inferência
function mockBrainProb (conformed) {
  const prob = new Uint8Array(conformed.img.length)
  for (let i = 0; i < prob.length; i++) prob[i] = Math.min(255, conformed.img[i] * 1.6)
  return prob
}

/** máscara MeshNet (probabilidade via isScalar) + limpeza morfológica; QC overlay no NiiVue */
async function runBrainExtraction (conformed, isGPU, variant) {
  const f = parseFloat($('bet-f').value) || 0.5
  let prob
  if (new URLSearchParams(location.search).has('mockbet')) {
    log('MOCK: máscara cerebral por limiar de intensidade')
    prob = mockBrainProb(conformed)
  } else {
    log('Extração cerebral (≈ BET): inferindo probabilidade de cérebro…')
    // isScalar devolve a softmax de "cérebro" (0–255) em vez do argmax;
    // type Segmentation evita a binarização do caminho Brain_Masking do worker.
    // Sempre o modelo FAST (id 12): o caminho de subvolumes dos modelos de
    // memória baixa ignora isScalar e devolveria só o argmax binário.
    prob = await runBrainchopModel(MODEL_MAP.mask.high, conformed, isGPU, 0.55, 0.72,
      { entryPatch: { isScalar: true, type: 'Segmentation' } }).seg
  }
  const m = await runMaskWorker({ prob, intensity: conformed.img, dims: dimsOf(conformed), f, normalize: $('opt-norm').checked })
  if (!m.voxels) throw new Error(`extração cerebral produziu máscara vazia (f=${f}) — reduza o limiar f ou desmarque a extração cerebral`)
  state.bet = { mask: new Uint8Array(m.mask), brain: new Uint8Array(m.brain), f, voxels: m.voxels, normalized: !!m.normalized, cleanupLog: m.log }
  const cm3 = m.voxels / 1000
  if (cm3 < 700) log(`Máscara pequena (${cm3.toFixed(0)} cm³) — limiar f=${f} pode estar alto; confira a sobreposição.`, 'err')
  // QC: sobrepõe a máscara para inspeção (o slider de rótulos controla a opacidade)
  const nv = state.nv
  while (nv.volumes.length > 1) await nv.removeVolume(nv.volumes[1])
  const overlay = await conformed.clone()
  overlay.zeroImage()
  overlay.hdr.scl_slope = 1
  overlay.hdr.scl_inter = 0
  overlay.img = new Uint8Array(state.bet.mask)
  overlay.colormap = 'red'
  overlay.opacity = (+$('opacity').value) / 100
  await nv.addVolume(overlay)
  log(`Máscara cerebral: ${cm3.toFixed(0)} cm³ (f=${f}${state.bet.normalized ? ', intensidade normalizada na máscara' : ''}) — sobreposta para inspeção.`, 'ok')
  return state.bet
}

// reconstrói a sobreposição de rótulos a partir de state.seg/state.colormap
async function refreshOverlay () {
  const nv = state.nv
  while (nv.volumes.length > 1) await nv.removeVolume(nv.volumes[1])
  const overlay = await state.conformed.clone()
  overlay.zeroImage()
  overlay.hdr.scl_slope = 1
  overlay.hdr.scl_inter = 0
  overlay.img = new Uint8Array(state.seg)
  if (state.colormap) {
    overlay.setColormapLabel(state.colormap)
    overlay.hdr.intent_code = 1002
  } else {
    overlay.colormap = 'actc'
  }
  overlay.opacity = (+$('opacity').value) / 100
  await nv.addVolume(overlay)
}

// habilita os botões de intermediários conforme o que esta execução produziu
function updateIntermediateExports () {
  const q = (k) => document.querySelector(`[data-export="${k}"]`)
  if (q('nii-native')) q('nii-native').disabled = !state.native
  if (q('nii-mask')) q('nii-mask').disabled = !state.bet
  if (q('nii-brain')) q('nii-brain').disabled = !state.bet
}

// recarrega rótulos/colormap, recalcula as estatísticas e re-renderiza
async function applySegmentationResult (labelsPath, colormapPath) {
  state.labelsMap = labelsPath ? await (await fetch(labelsPath)).json() : null
  state.colormap = colormapPath ? await (await fetch(colormapPath)).json() : null
  await refreshOverlay()
  if (state.labelsMap) {
    log('Calculando estatísticas por estrutura…')
    progress(0.95)
    state.stats = computeStats(state.seg, state.conformed.img, dimsOf(state.conformed), state.labelsMap, affineOf(state.conformed), voxVolOf(state.conformed))
    renderResults()
    await updateNorms()
    $('step-export').hidden = false
    updateIntermediateExports()
    $('step-run').dataset.done = '1'
    log(`Volume encefálico segmentado: ${(state.stats.brainVol / 1000).toFixed(0)} cm³.`, 'ok')
  } else {
    log('Modelo sem tabela de rótulos (máscara) — estatísticas limitadas.', 'ok')
    $('step-export').hidden = false
    updateIntermediateExports()
  }
  progress(0)
}

// ---------- passo adicional: parcelação DKT sobre um resultado SynthSeg pronto ----------
// fontes que aceitam o passo DKT e como fundir cada uma
const DKT_SOURCES = {
  synthseg: {
    pt: 'SynthSeg 1.0',
    fuse: { leftCtx: 2, rightCtx: 19, lhBase: 31, rhBase: 65 }, // córtex E/D do SynthSeg manda no hemisfério
    labels: './models/synthseg1/labels_dkt.json',
    colormap: './models/synthseg1/colormap_dkt.json'
  },
  aseg18: {
    pt: 'Subcortical 18 (aseg compacta)',
    fuse: { leftCtx: -1, rightCtx: -1, bothCtx: 2, lhBase: 17, rhBase: 51 }, // córtex bilateral: hemisfério vem da rede DKT
    labels: './models/model30chan18cls/labels_dkt.json',
    colormap: './models/model30chan18cls/colormap_dkt.json'
  }
}

// máscara de córtex da segmentação-fonte (rótulos de córtex do DKT_SOURCES)
function cortexMaskOf (seg, fuse) {
  const mask = new Uint8Array(seg.length)
  for (let v = 0; v < seg.length; v++) {
    const s = seg[v]
    if (s === fuse.leftCtx || s === fuse.rightCtx || s === fuse.bothCtx) mask[v] = 1
  }
  return mask
}

async function runDktStep () {
  if (state.running) return
  const src = DKT_SOURCES[state.segKind]
  if (!state.seg || !src) {
    log('O passo DKT parcela um resultado SynthSeg ou aseg compacta pronto — rode a segmentação primeiro.', 'err')
    return
  }
  state.running = true
  $('run').disabled = true
  $('run-dkt').disabled = true
  try {
    const isGPU = $('backend').value !== 'cpu'
    const variant = $('mem').value === 'low' ? 'low' : 'high'
    const parcSrc = $('parc-source').value
    log(`Parcelação DKT (passo adicional): a segmentação ${src.pt} atual fica preservada até a fusão dar certo.`)
    let segDkt, parcName
    if (parcSrc === 'brainchop') {
      parcName = 'rede DKT brainchop'
      segDkt = await runBrainchopModel(variant === 'low' ? 15 : 14, state.conformed, isGPU, 0.1, 0.85).seg
    } else {
      const views = parcSrc === 'fastsurfer2' ? ['coronal', 'axial'] : ['coronal', 'axial', 'sagittal']
      parcName = `FastSurfer (${views.length} vistas)`
      log(`FastSurferCNN (Deep-MI, Apache 2.0): agregação de ${views.length} vistas restrita à fita cortical…`)
      segDkt = await runWorker('./workers/fastsurfer.worker.js', {
        baseUrl: location.href,
        img: state.conformed.img,
        dims: dimsOf(state.conformed),
        affine: affineOf(state.conformed).flat(),
        mask: cortexMaskOf(state.seg, src.fuse),
        isGPU,
        views,
        batch: variant === 'low' ? 1 : 2
      }, 0.05, 0.85)
    }
    log(`Fundindo a parcelação (${parcName}) na fita cortical (esquema do predict_synthseg: seg==córtex recebe a parcela)…`)
    const fused = fuseDKT(state.seg, segDkt, dimsOf(state.conformed), src.fuse)
    const s = fused.stats
    // só troca o estado depois da fusão completa
    const prevKind = state.segKind
    state.seg = fused.seg
    state.segKind = prevKind + '-dkt'
    state.modelUsed = `${src.pt} + parcelação DKT ${parcName === 'rede DKT brainchop' ? '(rede brainchop)' : `(${parcName})`}`
    log(`Fusão DKT: ${s.cortexVox.toLocaleString('pt-BR')} voxels de córtex — ${s.direct.toLocaleString('pt-BR')} diretos, ${s.filled.toLocaleString('pt-BR')} por vizinhança, ${s.residual.toLocaleString('pt-BR')} residuais.`, 'ok')
    await applySegmentationResult(src.labels, src.colormap)
  } catch (e) {
    log(`Erro no passo DKT — o resultado ${src.pt} permanece intacto: ` + e.message, 'err')
    progress(0)
    $('run-dkt').disabled = false
  } finally {
    state.running = false
    $('run').disabled = false
  }
}

async function runSegmentation () {
  if (state.running || !state.rawVol) return
  state.running = true
  $('run').disabled = true
  try {
    const nv = state.nv
    const pipeline = effectivePipeline()
    state.native = null
    state.bet = null
    // etapas nativas (≈ FSL), antes da conformação: reorientação → recorte → reamostragem
    // (só no robusto) → viés → suavização — a imagem corrigida alimenta todo o resto
    const flags = {
      doReorient: $('opt-reorient').checked,
      doCrop: $('opt-crop').checked,
      doResample: pipeline === 'robust',
      doBias: $('opt-bias').checked,
      doSmooth: $('opt-smooth').checked
    }
    let workVol = state.rawVol
    if (flags.doReorient || flags.doCrop || flags.doResample || flags.doBias || flags.doSmooth) {
      if (pipeline === 'robust') log('Modo robusto: reamostragem cúbica + correção de campo de viés (aproximação clássica; não é a rede SynthSR).')
      state.native = await preprocessNative(state.rawVol, flags)
      workVol = state.native.vol
    }
    const steps = []
    if (flags.doReorient) steps.push('reorientação RAS')
    if (flags.doCrop) steps.push('recorte de pescoço')
    if (flags.doResample) steps.push('reamostragem cúbica Catmull-Rom')
    if (flags.doBias) steps.push('correção de viés')
    if (flags.doSmooth) steps.push('suavização')
    state.pipelineUsed = (pipeline === 'robust' ? 'robusto (' : 'padrão (') +
      (steps.length ? steps.join(' + ') + ' → ' : '') + 'conformação direta)'

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
    const isGPU = $('backend').value !== 'cpu'
    let labelsPath, colormapPath, seg

    // extração cerebral (≈ BET) sobre o volume conformado, antes da segmentação;
    // a rede recebe o cérebro extraído (e normalizado, se marcado)
    let infImg = null
    if ($('opt-bet').checked && kind !== 'mask') {
      await runBrainExtraction(conformed, isGPU, variant)
      infImg = state.bet.brain
    }

    if (MODEL_MAP[kind].synth) {
      state.modelUsed = MODEL_MAP[kind].pt + (variant === 'low' ? ' · blocos menores' : '')
      log(`Segmentando com ${state.modelUsed}…`)
      seg = await runSynthsegModel(conformed, isGPU, variant === 'low' ? 96 : 128, infImg ? 0.75 : 0.45, 0.93, infImg)
      labelsPath = './models/synthseg1/labels.json'
      colormapPath = './models/synthseg1/colormap.json'
    } else {
      state.modelUsed = MODEL_MAP[kind].pt + (variant === 'low' ? ' · memória baixa' : '')
      log(`Segmentando com ${state.modelUsed}…`)
      const r = runBrainchopModel(MODEL_MAP[kind][variant], conformed, isGPU, infImg ? 0.75 : 0.45, 0.93, { imgOverride: infImg })
      labelsPath = r.modelEntry.labelsPath
      colormapPath = r.modelEntry.colormapPath
      seg = await r.seg
    }
    state.seg = seg
    state.segKind = kind
    $('run-dkt').disabled = !DKT_SOURCES[kind]
    await applySegmentationResult(labelsPath, colormapPath)
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
  svg += `<line x1="${mid}" y1="8" x2="${mid}" y2="${H - 20}" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]
    const y = 14 + i * rowH
    const wl = p.left / maxV * (half - 6)
    const wr = p.right / maxV * (half - 6)
    const name = p.ptName.length > 34 ? p.ptName.slice(0, 33) + '…' : p.ptName
    svg += `<text x="${left - 10}" y="${y + 9}" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10.5" fill="var(--ink)">${escapeXml(name)}</text>`
    svg += `<rect x="${mid - wl}" y="${y}" width="${Math.max(1, wl)}" height="12" fill="var(--accent)" rx="2"><title>${escapeXml(p.ptName)} E: ${Math.round(p.left)} mm³</title></rect>`
    svg += `<rect x="${mid}" y="${y}" width="${Math.max(1, wr)}" height="12" fill="#5E7286" rx="2"><title>${escapeXml(p.ptName)} D: ${Math.round(p.right)} mm³</title></rect>`
    const aiTxt = (p.ai > 0 ? '+' : '') + p.ai.toFixed(1) + '%'
    svg += `<text x="${W - 4}" y="${y + 9}" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10" fill="${Math.abs(p.ai) > 10 ? 'var(--accent-strong)' : 'var(--dim)'}">${aiTxt}</text>`
  }
  svg += '</svg>'
  el.innerHTML = svg
}

// ---------- comparação normativa (idade/sexo) ----------
async function updateNorms () {
  const age = parseFloat($('age').value)
  const sex = $('sex').value
  if (!state.stats || !(age > 0) || !(sex === 'F' || sex === 'M')) {
    state.norms = null
    $('norm-panel').hidden = true
    return
  }
  try {
    await loadNorms()
    state.norms = compareToNorms(state.stats, { age, sex })
    renderNorms()
    if (state.norms.flags.length) {
      const worst = state.norms.flags[0]
      log(`QC normativo: ${state.norms.flags.length} região(ões) com |z| ≥ 3 — pior: ${worst.pt} (z ${worst.z.toFixed(1)})${Math.abs(worst.z) >= 4 ? ' — possível ERRO DE SEGMENTAÇÃO' : ''}`, Math.abs(worst.z) >= 4 ? 'err' : '')
    }
  } catch (e) {
    log('Normativo indisponível: ' + e.message, 'err')
  }
}

function renderNorms () {
  const n = state.norms
  if (!n || !n.available) { $('norm-panel').hidden = true; return }
  $('norm-panel').hidden = false
  const thead = $('norm-table').querySelector('thead')
  const tbody = $('norm-table').querySelector('tbody')
  thead.innerHTML = '<tr><th>Medida</th><th style="text-align:right">cm³</th><th style="text-align:right">P</th><th style="text-align:right">z</th><th></th></tr>'
  tbody.innerHTML = ''
  const rows = [...n.globals, ...n.lobes]
  for (const g of rows) {
    const tr = document.createElement('tr')
    const flagTxt = g.flag === 'erro?' ? '⚠ erro?' : g.flag === 'atipico' ? '· atípico' : ''
    tr.innerHTML = `<td>${g.pt}</td>` +
      `<td class="num">${(g.value / 1000).toFixed(1)}</td>` +
      `<td class="num">${g.percentile != null ? g.percentile.toFixed(g.percentile < 1 || g.percentile > 99 ? 1 : 0) : '—'}</td>` +
      `<td class="num">${g.z != null ? (g.z >= 0 ? '+' : '') + g.z.toFixed(2) : '—'}</td>` +
      `<td style="color:${g.flag === 'erro?' ? 'var(--accent-strong)' : 'var(--warn)'};font-family:var(--mono);font-size:10.5px">${flagTxt}</td>`
    tbody.appendChild(tr)
  }
}

function escapeXml (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// ---------- exportações ----------
function metaNow () {
  return {
    tool: 'SegmentaRM',
    version: VERSION,
    subject: $('subject').value || ($('stage-title').textContent || 'exame'),
    age: parseFloat($('age').value) || null,
    sex: $('sex').value || null,
    norms: state.norms,
    date: new Date().toISOString().slice(0, 10),
    input: state.inputDesc,
    quality: state.quality,
    pipeline: state.pipelineUsed,
    model: state.modelUsed,
    preproc: {
      nativo: state.native ? state.native.prov : null,
      extracaoCerebral: state.bet
        ? { aplicada: true, f: state.bet.f, mascara_cm3: +(state.bet.voxels / 1000).toFixed(1), normalizadaNaMascara: state.bet.normalized, limpeza: state.bet.cleanupLog }
        : { aplicada: false }
    },
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
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'uint8', description: 'segmentarm ' + meta.model.slice(0, 40) }, state.seg)
      return await gzipBuffer(buf)
    },
    niiConf: async () => {
      const img0 = state.conformed.img
      const img = (img0 instanceof Uint8Array || img0 instanceof Int16Array || img0 instanceof Float32Array) ? img0 : Float32Array.from(img0)
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: datatypeOf(img), description: 'segmentarm imagem de análise' }, img)
      return await gzipBuffer(buf)
    },
    niiNative: async () => state.native ? await gzipBuffer(state.native.buf) : null,
    niiMask: async () => {
      if (!state.bet) return null
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'uint8', description: `segmentarm mascara cerebral f=${state.bet.f}` }, state.bet.mask)
      return await gzipBuffer(buf)
    },
    niiBrain: async () => {
      if (!state.bet) return null
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'uint8', description: 'segmentarm cerebro extraido' }, state.bet.brain)
      return await gzipBuffer(buf)
    }
  }
}

async function handleExport (kind) {
  if (!state.stats && !['nii-conf', 'nii-native', 'nii-mask', 'nii-brain'].includes(kind) && !kind.startsWith('cohort')) {
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
      case 'nii-native': {
        const b = await ex.niiNative()
        if (b) saveBlob(b, `${sub}_preproc_nativo.nii.gz`)
        else log('Sem pré-processado nativo — nenhuma etapa nativa foi aplicada nesta execução.', 'err')
        break
      }
      case 'nii-mask': {
        const b = await ex.niiMask()
        if (b) saveBlob(b, `${sub}_mascara.nii.gz`)
        else log('Sem máscara cerebral — rode com "Extração cerebral" marcada.', 'err')
        break
      }
      case 'nii-brain': {
        const b = await ex.niiBrain()
        if (b) saveBlob(b, `${sub}_cerebro.nii.gz`)
        else log('Sem cérebro extraído — rode com "Extração cerebral" marcada.', 'err')
        break
      }
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
        if (state.native) files.push({ name: `${sub}_preproc_nativo.nii.gz`, data: new Uint8Array(await ex.niiNative()) })
        if (state.bet) {
          files.push({ name: `${sub}_mascara.nii.gz`, data: new Uint8Array(await ex.niiMask()) })
          files.push({ name: `${sub}_cerebro.nii.gz`, data: new Uint8Array(await ex.niiBrain()) })
        }
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
  $('run-dkt').onclick = runDktStep
  $('bet-f').oninput = () => { $('bet-f-out').textContent = (+$('bet-f').value).toFixed(2) }
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
  $('age').onchange = updateNorms
  $('sex').onchange = updateNorms
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
  window.__segrm = state // gancho de diagnóstico (console do navegador)
  log('SegmentaRM ' + VERSION + ' pronto. Nenhuma imagem sai do dispositivo.')
}

main().catch(e => log('Falha na inicialização: ' + e.message, 'err'))
