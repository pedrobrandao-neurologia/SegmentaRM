// SegmentaRM — orquestrador.
// Fluxo: entrada (DICOM→dcm2niix WASM | NIfTI) → régua de qualidade → pipeline
// (padrão: conformação | robusto: reamostragem cúbica + correção de viés → conformação)
// → segmentação (worker brainchop, tfjs) → estatísticas → exportações e coorte.

import { Niivue, NVImage, NVMesh, SLICE_TYPE } from './vendor/niivue.js'
import { Dcm2niix } from './vendor/dcm2niix/index.jpeg.js'
import { inferenceModelsList, brainChopOpts } from './brainchop/brainchop-parameters.js'
import { assessQuality } from './lib/quality.js'
import { computeStats, statsToCSV, statsToJSON, statsToWideRow } from './lib/stats.js'
import { GROUP_PT, ptNameOf } from './lib/labels.js'
import { writeNifti, gzipBuffer } from './lib/nifti-writer.js'
import { tableToSav } from './lib/sav.js'
import { buildReport } from './lib/report.js'
import { makeZip } from './lib/zip.js'
import { fuseDKT } from './lib/dkt-fusion.js'
import { loadNorms, compareToNorms } from './lib/normative.js'
import { scanDicomSeries, directSeriesToNifti } from './lib/dicom-scan.js'

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
  synthsr: null,       // { vol: NVImage, buf, flip } — MP-RAGE T1 1 mm sintético (SynthSR)
  bet: null,           // { mask, brain, f, voxels, normalized, cleanupLog } no espaço conformado
  surf: null,          // { meshes:[{name,kind,hemi,mz3}], stats:[...] } do passo de superfícies
  wl: null,            // janela de exibição atual { min, max } do volume base
  wlRange: 255,        // amplitude de referência (p99−p1) para escalar o arrasto
  rebuilding: false,
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

// ---------- log de erros exportável + tutorial em pop-up ----------
// cada erro de etapa vira um registro com contexto completo (entrada, seleções,
// diagnóstico do worker, últimas linhas do console) — persistido em localStorage
// (últimos 20) e exportável em .txt para diagnóstico e reprocessamento
const ERRLOG_KEY = 'segmentarm-errlog'
const errorLog = (() => {
  try { const a = JSON.parse(localStorage.getItem(ERRLOG_KEY) || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
})()

function gpuName () {
  try {
    const gl = state.nv && state.nv.gl
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info')
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null
  } catch { return null }
}

function errorContext () {
  const val = (id) => { const el = document.getElementById(id); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null }
  let ctx = { versao: VERSION, navegador: navigator.userAgent }
  try {
    ctx = {
      versao: VERSION,
      navegador: navigator.userAgent,
      gpu: gpuName(),
      memoriaJS_MB: (performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576)) || null,
      entrada: state.inputDesc || null,
      qualidade: state.quality ? { nivel: state.quality.grade, achados: (state.quality.findings || []).map(f => f.txt) } : null,
      pipeline: state.pipelineUsed || null,
      modelo: state.modelUsed || null,
      segKind: state.segKind || null,
      dimsBruto: state.rawVol ? [state.rawVol.hdr.dims[1], state.rawVol.hdr.dims[2], state.rawVol.hdr.dims[3]] : null,
      dimsConformado: state.conformed ? dimsOf(state.conformed) : null,
      selecoes: {
        pipeline: val('pipeline'), modelo: val('model'), execucao: val('backend'), memoria: val('mem'),
        fonteDkt: val('parc-source'), betF: val('bet-f'),
        reorient: val('opt-reorient'), recorte: val('opt-crop'), vies: val('opt-bias'), suavizacao: val('opt-smooth'),
        bet: val('opt-bet'), normalizacao: val('opt-norm'), synthsr: val('opt-synthsr'), synthsrFlip: val('opt-synthsr-flip')
      },
      ultimasLinhasConsole: Array.from(consoleEl.querySelectorAll('p')).slice(-15).map(p => p.textContent)
    }
  } catch { /* contexto parcial já é útil */ }
  return ctx
}

function recordError (etapa, err, diagnostico = null) {
  const entry = {
    quando: new Date().toISOString(),
    etapa,
    mensagem: err && err.message ? err.message : String(err),
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 10).join('\n') : null,
    diagnostico: diagnostico || null,
    contexto: errorContext()
  }
  errorLog.push(entry)
  while (errorLog.length > 20) errorLog.shift()
  try { localStorage.setItem(ERRLOG_KEY, JSON.stringify(errorLog)) } catch { /* armazenamento cheio/indisponível */ }
  const btn = document.querySelector('[data-export="errlog"]')
  if (btn) btn.disabled = false
  return entry
}

function errorLogText () {
  const L = []
  L.push('SegmentaRM — log de erros (para diagnóstico e reprocessamento)')
  L.push(`Gerado em ${new Date().toISOString()} · versão ${VERSION} · ${errorLog.length} registro(s)`)
  L.push('Anexe este arquivo ao reportar o problema (issue no GitHub ou ao desenvolvedor).')
  L.push('='.repeat(72))
  for (const e of errorLog) {
    L.push('')
    L.push(`[${e.quando}] etapa: ${e.etapa}`)
    L.push(`mensagem: ${e.mensagem}`)
    if (e.diagnostico) L.push('diagnóstico: ' + JSON.stringify(e.diagnostico))
    const c = e.contexto || {}
    L.push(`entrada: ${c.entrada || '—'} · qualidade: ${c.qualidade ? c.qualidade.nivel : '—'} · pipeline: ${c.pipeline || '—'}`)
    L.push(`modelo: ${c.modelo || '—'} · segKind: ${c.segKind || '—'} · dims: ${(c.dimsConformado || c.dimsBruto || []).join('×') || '—'}`)
    if (c.selecoes) L.push('seleções: ' + JSON.stringify(c.selecoes))
    L.push(`navegador: ${c.navegador || '—'}${c.gpu ? ' · gpu: ' + c.gpu : ''}`)
    if (c.ultimasLinhasConsole && c.ultimasLinhasConsole.length) {
      L.push('últimas linhas do console:')
      for (const ln of c.ultimasLinhasConsole) L.push('  | ' + ln)
    }
    if (e.stack) L.push('stack:\n' + e.stack)
    L.push('-'.repeat(72))
  }
  L.push('')
  L.push('JSON completo (para análise automática):')
  L.push(JSON.stringify(errorLog, null, 2))
  return L.join('\n')
}

function exportErrorLog () {
  if (!errorLog.length) { log('Nenhum erro registrado neste navegador.', 'ok'); return }
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  saveBlob(errorLogText(), `segmentarm_log_erros_${ts}.txt`, 'text/plain;charset=utf-8')
  log(`Log de erros exportado (${errorLog.length} registro(s)).`, 'ok')
}

// tutoriais por tipo de erro — o último é o genérico
const ERROR_GUIDES = [
  {
    match: /córtex parcelado|córtex sem parcela|córtex classificável|rode o passo (04|DKT)/i,
    titulo: 'As superfícies precisam da parcelação DKT',
    porque: 'O passo 05 reconstrói as superfícies a partir dos rótulos de córtex parcelado ' +
      '(ctx-lh-*/ctx-rh-*) que o passo 04 grava na fita cortical. A segmentação atual não tem ' +
      'essas parcelas em um ou nos dois hemisférios — em geral porque o passo 04 não chegou a ' +
      'parcelar (rede sem memória na GPU, entrada fora do domínio T1, resultado descartado) ou ' +
      'porque a segmentação (passo 03) foi refeita depois do DKT, o que apaga as parcelas. ' +
      'Nada foi perdido: o resultado anterior permanece intacto.',
    passos: [
      'Confira no visualizador se o overlay mostra as parcelas coloridas do DKT nos DOIS hemisférios (isso indica que o passo 04 concluiu).',
      'Re-rode o passo 04 · Parcelação DKT. Se falhar ou parcelar só um lado, troque a fonte (FastSurfer 3 vistas ↔ axial+coronal ↔ rede brainchop) ou mude Execução para CPU / Memória para Baixa.',
      'Entrada de baixa qualidade ou não-T1 (régua C/D)? Reprocesse desde o passo 03 com "MP-RAGE sintético 1 mm (SynthSR)" marcado no passo 02.',
      'Com o DKT refeito, rode o passo 05 · Superfícies de novo. Se só um hemisfério tiver parcelas, o passo agora prossegue com esse lado e avisa no console.',
      'Se o problema persistir, baixe o log de erro abaixo e anexe ao reportar — ele registra o contexto completo para diagnóstico.'
    ]
  },
  {
    match: /memory|memória|texture|alloc|framebuffer|context lost|contexto/i,
    titulo: 'Memória de GPU ou do navegador insuficiente',
    porque: 'A inferência não coube na memória da GPU (WebGL) ou do navegador. É comum em GPUs ' +
      'integradas, notebooks e abas com muitos volumes abertos. Nada foi perdido: o resultado da ' +
      'etapa anterior permanece intacto.',
    passos: [
      'Troque "Memória" para Baixa (blocos menores) e rode a etapa de novo.',
      'Se repetir, troque "Execução" para CPU — mais lento, porém estável.',
      'Feche outras abas e aplicativos pesados; em estudos DICOM grandes, abra só a série necessária na triagem.',
      'Se o visualizador ficar branco, ele se recupera sozinho; aguarde ou recarregue a página (o cache offline preserva os modelos).',
      'Persistindo, baixe o log de erro abaixo e anexe ao reportar.'
    ]
  },
  {
    match: null,
    titulo: 'Algo falhou nesta etapa',
    porque: 'Ocorreu um erro inesperado. Nada foi perdido: o resultado da etapa anterior permanece ' +
      'intacto e você pode rodar a etapa novamente.',
    passos: [
      'Rode a etapa novamente — falhas transitórias (memória, GPU ocupada) costumam sumir.',
      'Se repetir, troque "Execução" para CPU ou "Memória" para Baixa.',
      'Confira a régua de qualidade (passo 02): entrada não-T1 ou muito anisotrópica degrada todas as redes — considere o SynthSR.',
      'Baixe o log de erro abaixo — ele registra o contexto completo (entrada, seleções, mensagens) para diagnóstico e para reprocessar depois.'
    ]
  }
]

function showErrorDialog (etapa, err) {
  const dlg = $('dlg-error')
  if (!dlg) return
  const msg = err && err.message ? err.message : String(err)
  const g = ERROR_GUIDES.find(x => x.match && x.match.test(msg)) || ERROR_GUIDES[ERROR_GUIDES.length - 1]
  $('err-title').textContent = g.titulo
  $('err-stage').textContent = etapa
  $('err-msg').textContent = msg
  $('err-why').textContent = g.porque
  const ol = $('err-steps')
  ol.innerHTML = ''
  for (const p of g.passos) {
    const li = document.createElement('li')
    li.textContent = p
    ol.appendChild(li)
  }
  try { if (!dlg.open) dlg.showModal() } catch { /* dialog indisponível */ }
}

// registra e explica um erro de etapa num só lugar
function stepError (etapa, err, diagnostico = null) {
  recordError(etapa, err, diagnostico)
  showErrorDialog(etapa, err)
  tlFail(null, err, etapa)
}

// ---------- linha do tempo do processamento (inspetor direito) ----------
// cada etapa vira um item sequencial com status (rodando/ok/aviso/erro), notas de
// decisões e avisos, e chips de um clique para ver o entregável no visualizador
const TL = { items: new Map(), current: null }

function tlReset () {
  TL.items.clear()
  TL.current = null
  const el = $('timeline')
  if (el) el.innerHTML = ''
  const p = $('tl-panel')
  if (p) p.hidden = true
}

function tlRemove (id) {
  const it = TL.items.get(id)
  if (it) { it.li.remove(); TL.items.delete(id) }
  if (TL.current === id) TL.current = null
}

function tlStage (id, title) {
  const panel = $('tl-panel')
  if (!panel) return
  panel.hidden = false
  tlRemove(id)
  const li = document.createElement('li')
  li.className = 'tl on'
  li.innerHTML = '<span class="tl-dot" aria-hidden="true"></span><div class="tl-body">' +
    `<div class="tl-head"><strong></strong><span class="tl-time">${new Date().toTimeString().slice(0, 8)}</span></div>` +
    '<div class="tl-notes"></div><div class="tl-acts" hidden></div></div>'
  li.querySelector('strong').textContent = title
  $('timeline').appendChild(li)
  TL.items.set(id, { li, notes: li.querySelector('.tl-notes'), acts: li.querySelector('.tl-acts') })
  TL.current = id
  try { li.scrollIntoView({ block: 'nearest' }) } catch { /* sem scroll */ }
}

/** kind: 'info' | 'decision' | 'warn' | 'errnote' */
function tlNote (id, text, kind = 'info') {
  const it = TL.items.get(id)
  if (!it) return
  const p = document.createElement('p')
  p.className = 'tl-note' + (kind !== 'info' ? ' ' + kind : '')
  p.textContent = text
  it.notes.appendChild(p)
}

/** conclui a etapa; views = [{label, view}] vira chips que trocam o visualizador */
function tlDone (id, views = [], status = 'ok') {
  const it = TL.items.get(id)
  if (!it) return
  it.li.className = 'tl ' + status
  for (const v of views) {
    const b = document.createElement('button')
    b.className = 'chip'
    b.type = 'button'
    b.textContent = v.label
    b.onclick = () => viewDeliverable(v.view, v.label)
    it.acts.appendChild(b)
  }
  if (it.acts.children.length) it.acts.hidden = false
  if (TL.current === id) TL.current = null
}

function tlFail (id, err, etapa = '') {
  const key = id || TL.current
  const it = TL.items.get(key)
  if (!it) return
  it.li.className = 'tl err'
  tlNote(key, err && err.message ? err.message : String(err), 'errnote')
  const b1 = document.createElement('button')
  b1.className = 'chip'
  b1.type = 'button'
  b1.textContent = 'o que fazer'
  b1.onclick = () => showErrorDialog(etapa || 'Etapa com erro', err)
  const b2 = document.createElement('button')
  b2.className = 'chip'
  b2.type = 'button'
  b2.textContent = 'baixar log de erro'
  b2.onclick = exportErrorLog
  it.acts.append(b1, b2)
  it.acts.hidden = false
  if (TL.current === key) TL.current = null
}

// ---------- visualização de entregáveis (um clique na linha do tempo) ----------
const viewCache = new Map() // intermediários reconstruídos como NVImage sob demanda

async function intermediateVol (key, img, datatype, desc) {
  if (viewCache.has(key)) return viewCache.get(key)
  const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype, description: desc }, img)
  const nvol = await NVImage.loadFromFile({ file: new File([buf], key + '.nii'), name: key + '.nii' })
  viewCache.set(key, nvol)
  return nvol
}

/** troca o visualizador central para um entregável: raw | native | synthsr | conf | mask | brain | seg | surf */
async function viewDeliverable (kind, label = '') {
  try {
    await ensureViewerAlive()
    const nv = state.nv
    if (kind === 'surf') {
      if (!state.surf) { log('Sem malhas de superfície — rode o passo 05.', 'err'); return }
      $('show-surf').checked = true
      await showSurfaces(true)
      log('Visualizador: malhas 3D das superfícies.', 'ok')
      return
    }
    if (nv.meshes && nv.meshes.length) { $('show-surf').checked = false; await showSurfaces(false) }
    let base = null
    if (kind === 'raw') base = state.rawVol
    else if (kind === 'native') base = state.native && state.native.vol
    else if (kind === 'synthsr') base = state.synthsr && state.synthsr.vol
    else if (kind === 'conf' || kind === 'seg' || kind === 'mask') base = state.conformed
    else if (kind === 'brain') base = state.bet && await intermediateVol('brain', state.bet.brain, 'uint8', 'cérebro extraído')
    if (!base) { log('Este entregável não está mais disponível — rode a etapa de novo.', 'err'); return }
    while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
    await nv.addVolume(base)
    state.wl = null
    autoWindow()
    if (kind === 'seg' && state.seg) await refreshOverlay()
    if (kind === 'mask' && state.bet) {
      const overlay = await state.conformed.clone()
      overlay.zeroImage()
      overlay.hdr.scl_slope = 1
      overlay.hdr.scl_inter = 0
      overlay.img = new Uint8Array(state.bet.mask)
      overlay.colormap = 'red'
      overlay.opacity = (+$('opacity').value) / 100
      await nv.addVolume(overlay)
    }
    nv.drawScene()
    log(`Visualizador: ${label || kind}.`, 'ok')
  } catch (e) {
    log('Não consegui exibir este entregável: ' + e.message, 'err')
  }
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

function applySliceType () {
  const nv = state.nv
  const v = $('slicetype').value
  if (v === 'multi') nv.setSliceType(SLICE_TYPE.MULTIPLANAR)
  else if (v === 'axial') nv.setSliceType(SLICE_TYPE.AXIAL)
  else if (v === 'coronal') nv.setSliceType(SLICE_TYPE.CORONAL)
  else if (v === 'sagittal') nv.setSliceType(SLICE_TYPE.SAGITTAL)
  else nv.setSliceType(SLICE_TYPE.RENDER)
}

// ---------- janelamento (window/level) ----------
function baseVol () {
  return state.nv && state.nv.volumes.length ? state.nv.volumes[0] : null
}

function applyWindow (min, max) {
  const v = baseVol()
  if (!v) return
  v.cal_min = min
  v.cal_max = max
  state.wl = { min, max }
  try { state.nv.updateGLVolume() } catch { /* contexto pode estar perdido; o guard reconstrói */ }
}

// janela automática: percentis 1–99 dos voxels acima do fundo (amostrado)
function autoWindow () {
  const v = baseVol()
  if (!v || !v.img || !v.img.length) return
  const img = v.img
  const slope = v.hdr && v.hdr.scl_slope ? v.hdr.scl_slope : 1
  const inter = (v.hdr && v.hdr.scl_inter) || 0
  const step = Math.max(1, Math.floor(img.length / 400000))
  const vals = []
  for (let i = 0; i < img.length; i += step) {
    const x = img[i]
    if (x > 0) vals.push(x)
  }
  if (vals.length < 100) return
  vals.sort((a, b) => a - b)
  const p1 = vals[Math.floor(0.01 * (vals.length - 1))] * slope + inter
  const p99 = vals[Math.floor(0.99 * (vals.length - 1))] * slope + inter
  if (!(p99 > p1)) return
  state.wlRange = p99 - p1
  applyWindow(p1, p99)
}

// arrasto de janelamento: ↔ ajusta a largura (contraste), ↕ o nível (brilho);
// resposta no pointer-down, 1:1 com o mouse via rAF, duplo clique volta ao automático
function initWindowing () {
  const layer = $('wl-layer')
  const btn = $('wl-toggle')
  const readout = $('loc')
  btn.onclick = () => {
    const on = btn.getAttribute('aria-pressed') !== 'true'
    btn.setAttribute('aria-pressed', String(on))
    layer.hidden = !on
    if (on) {
      if (!state.wl) autoWindow()
      const w = state.wl ? state.wl.max - state.wl.min : 0
      const l = state.wl ? (state.wl.max + state.wl.min) / 2 : 0
      readout.textContent = `janela ${w.toFixed(0)} · nível ${l.toFixed(0)} — arraste (↔ contraste · ↕ brilho); duplo clique = automático`
    } else {
      readout.textContent = '—'
    }
  }
  let dragging = false
  let sx = 0, sy = 0, w0 = 0, l0 = 0
  let raf = 0
  let last = null
  const apply = () => {
    raf = 0
    if (!last) return
    const k = (state.wlRange || 255) / 300
    const w = Math.max((state.wlRange || 255) / 128, w0 + (last.clientX - sx) * k)
    const l = l0 + (last.clientY - sy) * k
    applyWindow(l - w / 2, l + w / 2)
    readout.textContent = `janela ${w.toFixed(0)} · nível ${l.toFixed(0)}`
  }
  layer.addEventListener('pointerdown', (e) => {
    if (!baseVol()) return
    layer.setPointerCapture(e.pointerId)
    dragging = true
    if (!state.wl) autoWindow()
    sx = e.clientX; sy = e.clientY
    w0 = state.wl.max - state.wl.min
    l0 = (state.wl.max + state.wl.min) / 2
    last = e
    apply()
    e.preventDefault()
  })
  layer.addEventListener('pointermove', (e) => {
    if (!dragging) return
    last = e
    if (!raf) raf = requestAnimationFrame(apply)
  })
  const end = (e) => { dragging = false; last = null }
  layer.addEventListener('pointerup', end)
  layer.addEventListener('pointercancel', end)
  layer.addEventListener('dblclick', () => {
    autoWindow()
    readout.textContent = 'janelamento automático'
  })
}

// ---------- resiliência: perda de contexto WebGL (comum após inferência pesada na GPU) ----------
function armContextGuard () {
  const c = $('gl')
  c.addEventListener('webglcontextlost', (e) => {
    e.preventDefault()
    log('Contexto WebGL do visualizador perdido (pressão de GPU) — reconstruindo…', 'err')
    setTimeout(() => { rebuildViewer() }, 250)
  })
}

async function rebuildViewer () {
  if (state.rebuilding) return
  state.rebuilding = true
  try {
    const old = $('gl')
    const fresh = old.cloneNode(false)
    old.replaceWith(fresh)
    await initViewer()
    armContextGuard()
    const vol = state.conformed || state.rawVol
    if (vol) {
      await state.nv.addVolume(vol)
      if (state.seg && state.conformed) await refreshOverlay()
    }
    if (state.wl) applyWindow(state.wl.min, state.wl.max)
    else autoWindow()
    applySliceType()
    log('Visualizador restaurado.', 'ok')
  } catch (e) {
    log('Não consegui restaurar o visualizador: ' + e.message, 'err')
  } finally {
    state.rebuilding = false
  }
}

async function ensureViewerAlive () {
  try {
    if (state.nv && state.nv.gl && state.nv.gl.isContextLost && state.nv.gl.isContextLost()) {
      log('Visualizador com contexto WebGL perdido — restaurando antes de continuar…')
      await rebuildViewer()
    }
  } catch { /* melhor seguir do que travar o fluxo */ }
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
// acima deste tamanho o estudo mostra a triagem mesmo com uma série só;
// abrir menos séries de uma vez mantém o pico de memória no tamanho de UMA série
const PICKER_MIN_FILES = 200

/** Diálogo de triagem: escolher séries e o modo de abertura (estilo LUME). */
function showSeriesPicker (groups, totalFiles) {
  return new Promise((resolve) => {
    const dlg = $('dlg-series')
    const totalMB = groups.reduce((s, g) => s + g.bytes, 0) / 1048576
    const big = totalFiles > 800 || totalMB > 800
    $('series-info').textContent =
      `${groups.length} série(s) · ${totalFiles} arquivo(s) · ${totalMB.toFixed(0)} MB. ` +
      `Abrir menos séries de uma vez poupa memória${big ? ' — estudo grande: selecione só o necessário.' : '.'}`
    const esc = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
    $('series-list').innerHTML = groups.map((g, i) => `
      <li><label><input type="checkbox" data-g="${i}" ${big ? '' : 'checked'}>
        <span class="pick-desc"><strong>${esc(g.desc)}</strong>
        <span class="pick-meta">${esc(g.sidecar.Modality || '?')} · ${g.count} img · ${(g.bytes / 1048576).toFixed(1)} MB${g.supportedDirect ? '' : ' · só conversão'}</span></span>
      </label></li>`).join('')
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      if (dlg.open) dlg.close()
      resolve(value)
    }
    $('series-all').onclick = () => dlg.querySelectorAll('input[data-g]').forEach(c => { c.checked = true })
    $('series-none').onclick = () => dlg.querySelectorAll('input[data-g]').forEach(c => { c.checked = false })
    $('series-cancel').onclick = () => done(null)
    dlg.oncancel = () => done(null)
    $('series-open').onclick = () => {
      const selected = [...dlg.querySelectorAll('input[data-g]:checked')].map(c => groups[+c.dataset.g])
      if (!selected.length) { log('Selecione ao menos uma série.', 'err'); return }
      done({ selected, direct: $('series-direct').checked })
    }
    dlg.showModal()
  })
}

/**
 * Entrada DICOM com triagem por série: lê só os cabeçalhos (≈128 KB/arquivo),
 * agrupa por SeriesInstanceUID e converte UMA série por vez — o pico de memória
 * é o de uma série, não o do estudo inteiro (evita ArrayBuffer allocation failed
 * em estudos com milhares de arquivos).
 */
async function handleDicomInput (allFiles) {
  log(`Lendo cabeçalhos de ${allFiles.length} arquivo(s) DICOM (triagem por série)…`)
  progress(0.03)
  let groups = []
  try {
    groups = await scanDicomSeries(allFiles, (k, n) => { progress(0.03 + 0.1 * k / n) })
  } catch (e) { log('Triagem falhou (' + e.message + ') — seguindo com a conversão em bloco.', 'err') }
  if (!groups.length) {
    const { file, sidecar } = await convertDicom(allFiles)
    await loadVolumeFile(file, sidecar, `DICOM → ${file.name}`)
    return
  }
  log(`${groups.length} série(s) encontrada(s).`, 'ok')
  let plan
  if (groups.length === 1 && allFiles.length <= PICKER_MIN_FILES) {
    plan = { selected: groups, direct: true } // estudo pequeno de uma série: abre sem perguntar
  } else {
    plan = await showSeriesPicker(groups, allFiles.length)
  }
  if (!plan || !plan.selected.length) { progress(0); log('Abertura cancelada.'); return }

  const entries = []
  for (let i = 0; i < plan.selected.length; i++) {
    const g = plan.selected[i]
    progress(0.15 + 0.75 * (i / plan.selected.length))
    try {
      if (plan.direct && g.supportedDirect) {
        log(`Série "${g.desc}": leitura direta (${g.count} cortes, ${(g.bytes / 1048576).toFixed(0)} MB)…`)
        const { file, sidecar } = await directSeriesToNifti(g, (k, n) =>
          progress(0.15 + 0.75 * ((i + k / n) / plan.selected.length)))
        entries.push({ file, sidecar })
      } else {
        log(`Série "${g.desc}": convertendo com dcm2niix (${g.count} arquivos)…`)
        entries.push(await convertDicom(g.files))
      }
    } catch (err) {
      log(`Série "${g.desc}" falhou: ${err.message} — seguindo para a próxima.`, 'err')
    }
  }
  if (!entries.length) throw new Error('nenhuma série selecionada pôde ser aberta')

  // popula o seletor de séries; a maior costuma ser a volumétrica
  const sel = $('series')
  sel.innerHTML = ''
  entries.forEach((en, i) => {
    const opt = document.createElement('option')
    opt.value = i
    opt.textContent = (en.sidecar && (en.sidecar.SeriesDescription || en.sidecar.ProtocolName)) || en.file.name
    sel.appendChild(opt)
  })
  $('series-field').hidden = entries.length < 2
  let best = 0
  for (let i = 1; i < entries.length; i++) if (entries[i].file.size > entries[best].file.size) best = i
  sel.value = String(best)
  sel.onchange = async () => {
    const en = entries[+sel.value]
    await loadVolumeFile(en.file, en.sidecar, `DICOM → ${en.file.name}`)
  }
  const en = entries[best]
  await loadVolumeFile(en.file, en.sidecar, `DICOM → ${en.file.name}`)
}

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
  state.synthsr = null
  state.bet = null
  state.surf = null
  $('run-dkt').disabled = true
  $('run-surf').disabled = true
  $('show-surf').disabled = true
  $('show-surf').checked = false
  $('surf-panel').hidden = true
  state.sidecar = sidecar || null
  state.inputDesc = desc
  state.wl = null
  autoWindow()
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

  // linha do tempo: novo exame zera tudo e abre a primeira etapa
  tlReset()
  viewCache.clear()
  tlStage('load', '01 · Exame carregado')
  tlNote('load', `${desc} — ${dims.join('×')} @ ${pixDims.map(p => Math.abs(p).toFixed(2)).join('×')} mm`)
  tlNote('load', `régua de qualidade: nível ${state.quality.grade} (${state.quality.gradeTxt})`, state.quality.grade >= 'C' ? 'warn' : 'info')
  for (const f of (state.quality.findings || []).filter(f => f.bad)) tlNote('load', f.txt, 'warn')
  if (state.quality.robustRecommended) tlNote('load', 'a régua recomenda o pipeline robusto — será aplicado no modo "Automático"', 'decision')
  tlDone('load', [{ label: 'ver exame original', view: 'raw' }])
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

// ---------- SynthSR: MP-RAGE T1 1 mm sintético (recon-all-clinical) ----------
// Promise dedicada: a resposta é Float32Array [0,128] + dims/affine da grade RAS 1 mm
// (o runWorker genérico converteria os floats em Uint8Array e corromperia a imagem)
function runSynthsrWorker (message, pFrom, pTo) {
  return new Promise((resolve, reject) => {
    const w = new Worker('./workers/synthsr.worker.js', { type: 'module' })
    state.worker = w
    w.onmessage = (ev) => {
      const d = ev.data
      if (d.cmd === 'ui') {
        if (d.message) log('· ' + d.message)
        if (typeof d.progressFrac === 'number' && d.progressFrac >= 0) progress(pFrom + d.progressFrac * (pTo - pFrom))
        if (d.modalMessage) { w.terminate(); state.worker = null; reject(new Error(d.modalMessage)) }
      } else if (d.cmd === 'img') {
        w.terminate(); state.worker = null
        resolve(d)
      }
    }
    w.onerror = (e) => { w.terminate(); state.worker = null; reject(new Error(e.message || 'falha no worker SynthSR')) }
    w.postMessage(message, [message.img.buffer])
  })
}

/** roda o SynthSR sobre um NVImage e devolve { vol: NVImage 1 mm RAS, buf, flip } */
async function runSynthsrStep (vol, isGPU, lowMem, flip) {
  const t0 = performance.now()
  const src = new Float32Array(vol.img.length)
  const slope = vol.hdr.scl_slope || 1
  const inter = vol.hdr.scl_inter || 0
  for (let i = 0; i < src.length; i++) src[i] = vol.img[i] * slope + inter
  const r = await runSynthsrWorker({
    modelUrl: new URL('./models/synthsr/model.json', location.href).href,
    img: src,
    dims: dimsOf(vol),
    affine: affineOf(vol).flat(),
    isGPU,
    tile: lowMem ? 64 : 96,
    flip
  }, 0.16, 0.4)
  const rows = [0, 1, 2, 3].map(i => r.affine.slice(i * 4, i * 4 + 4))
  const buf = writeNifti({ dims: r.dims, pixDims: [1, 1, 1], affine: rows, datatype: 'float32', description: 'segmentarm synthsr mprage 1mm' }, r.img)
  const file = new File([buf], 'synthsr.nii')
  const nvol = await NVImage.loadFromFile({ file, name: 'synthsr.nii' })
  log(`SynthSR concluído em ${((performance.now() - t0) / 1000).toFixed(0)} s — grade ${r.dims.join('×')} @ 1 mm.`, 'ok')
  return { vol: nvol, buf, flip }
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
  await ensureViewerAlive()
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
  if (q('nii-synthsr')) q('nii-synthsr').disabled = !state.synthsr
  if (q('nii-mask')) q('nii-mask').disabled = !state.bet
  if (q('nii-brain')) q('nii-brain').disabled = !state.bet
}

// recarrega rótulos/colormap, recalcula as estatísticas e re-renderiza
async function applySegmentationResult (labelsPath, colormapPath) {
  await ensureViewerAlive()
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
  tlRemove('surf')
  tlStage('dkt', '04 · Parcelação DKT')
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
    tlNote('dkt', `fonte: ${parcName} sobre ${src.pt} — ${isGPU ? 'GPU (WebGL)' : 'CPU'}`, 'decision')
    log(`Fundindo a parcelação (${parcName}) na fita cortical (esquema do predict_synthseg: seg==córtex recebe a parcela)…`)
    const fused = fuseDKT(state.seg, segDkt, dimsOf(state.conformed), src.fuse)
    const s = fused.stats
    // só troca o estado depois da fusão completa
    const prevKind = state.segKind
    state.seg = fused.seg
    state.segKind = prevKind + '-dkt'
    state.modelUsed = `${src.pt} + parcelação DKT ${parcName === 'rede DKT brainchop' ? '(rede brainchop)' : `(${parcName})`}`
    log(`Fusão DKT: ${s.cortexVox.toLocaleString('pt-BR')} voxels de córtex — ${s.direct.toLocaleString('pt-BR')} diretos, ${s.filled.toLocaleString('pt-BR')} por vizinhança, ${s.residual.toLocaleString('pt-BR')} residuais.`, 'ok')
    // diagnóstico precoce para o passo 05: parcelas por hemisfério na fusão
    {
      const fu = src.fuse
      let lhP = 0, rhP = 0
      for (let v = 0; v < fused.seg.length; v++) {
        const s2 = fused.seg[v]
        if (s2 >= fu.lhBase && s2 < fu.lhBase + 34) lhP++
        else if (s2 >= fu.rhBase && s2 < fu.rhBase + 34) rhP++
      }
      if (!lhP || !rhP) {
        log(`Atenção: a fusão não deixou parcelas DKT no hemisfério ${!lhP && !rhP ? 'esquerdo NEM no direito' : (!lhP ? 'esquerdo' : 'direito')} — o passo 05 sairá incompleto. Re-rode o DKT com outra fonte (FastSurfer 3 vistas / axial+coronal / brainchop), em CPU ou memória baixa.`, 'err')
        tlNote('dkt', `sem parcelas no hemisfério ${!lhP && !rhP ? 'esquerdo nem no direito' : (!lhP ? 'esquerdo' : 'direito')} — o passo 05 sairá incompleto; re-rode com outra fonte, CPU ou memória baixa`, 'warn')
      }
      var dktHemiOk = !!(lhP && rhP) // usado no fechamento da etapa abaixo
    }
    state.surf = null
    await showSurfaces(false)
    $('run-surf').disabled = false
    $('show-surf').disabled = true
    $('show-surf').checked = false
    $('surf-panel').hidden = true
    await applySegmentationResult(src.labels, src.colormap)
    tlNote('dkt', `fusão: ${s.cortexVox.toLocaleString('pt-BR')} voxels de córtex — ${s.direct.toLocaleString('pt-BR')} diretos, ${s.filled.toLocaleString('pt-BR')} por vizinhança, ${s.residual.toLocaleString('pt-BR')} residuais`)
    tlDone('dkt', [{ label: 'ver parcelação DKT', view: 'seg' }], dktHemiOk ? 'ok' : 'warn')
  } catch (e) {
    log(`Erro no passo DKT — o resultado ${src.pt} permanece intacto: ` + e.message, 'err')
    stepError('04 · Parcelação DKT', e)
    progress(0)
    $('run-dkt').disabled = false
  } finally {
    state.running = false
    $('run').disabled = false
  }
}


// ---------- passo 05: superfícies corticais (análogo navegador do recon-surf) ----------
async function runSurfStep () {
  if (state.running) return
  tlStage('surf', '05 · Superfícies corticais')
  if (!state.seg || !/-dkt$/.test(state.segKind)) {
    const e = new Error('as superfícies partem de um resultado com parcelação DKT — rode o passo 04 antes')
    log('As superfícies partem de um resultado com parcelação DKT — rode o passo 04 antes.', 'err')
    stepError('05 · Superfícies (pré-checagem)', e, { segKind: state.segKind || null })
    return
  }
  // pré-checagem com diagnóstico: conta voxels de córtex parcelado por hemisfério
  // antes de gastar tempo no worker — e explica o que fazer se não houver parcela
  if (state.labelsMap) {
    const side = new Uint8Array(256)
    for (const [i, nm] of Object.entries(state.labelsMap)) {
      if (/^ctx-lh-/.test(nm)) side[+i] = 1
      else if (/^ctx-rh-/.test(nm)) side[+i] = 2
    }
    let lh = 0, rh = 0
    for (let v = 0; v < state.seg.length; v++) {
      const s = side[state.seg[v]]
      if (s === 1) lh++
      else if (s === 2) rh++
    }
    if (!lh && !rh) {
      const e = new Error('nenhum voxel de córtex parcelado (ctx-lh-*/ctx-rh-*) na segmentação atual — re-rode o passo 04 (DKT) antes das superfícies')
      log('Erro nas superfícies — o resultado atual permanece intacto: ' + e.message, 'err')
      stepError('05 · Superfícies (pré-checagem)', e, { cortexParceladoE_vox: lh, cortexParceladoD_vox: rh, segKind: state.segKind })
      progress(0)
      return
    }
    if (!lh || !rh) {
      log(`Aviso: córtex parcelado só no hemisfério ${lh ? 'esquerdo' : 'direito'} — as superfícies prosseguem só com esse lado; re-rode o passo 04 para recuperar o outro.`, 'err')
      tlNote('surf', `córtex parcelado só no hemisfério ${lh ? 'esquerdo' : 'direito'} — prosseguindo só com esse lado`, 'warn')
    }
  }
  state.running = true
  $('run-surf').disabled = true
  $('run').disabled = true
  try {
    log('Reconstruindo superfícies white/pial por hemisfério (surface nets + Taubin; espessura por EDT)…')
    const r = await new Promise((resolve, reject) => {
      const w = new Worker('./workers/surface.worker.js', { type: 'module' })
      w.onmessage = (ev) => {
        const m = ev.data
        if (m.cmd === 'progress') { if (m.txt) log('· ' + m.txt); progress(0.1 + m.frac * 0.85) }
        else if (m.cmd === 'done') { w.terminate(); resolve(m) }
        else if (m.cmd === 'error') { w.terminate(); const err = new Error(m.message); err.diag = m.diag || null; reject(err) }
      }
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'falha no worker de superfícies')) }
      w.postMessage({
        seg: new Uint8Array(state.seg),
        dims: dimsOf(state.conformed),
        affine: affineOf(state.conformed).flat(),
        labels: state.labelsMap,
        colormap: state.colormap,
        voxVol: voxVolOf(state.conformed)
      })
    })
    if (r.aviso) { log('Aviso: ' + r.aviso, 'err'); tlNote('surf', r.aviso, 'warn') }
    for (const reg of r.stats) reg.pt = ptNameOf(reg.name)
    state.surf = { meshes: r.meshes, stats: r.stats }
    renderSurfStats()
    $('show-surf').disabled = false
    $('show-surf').checked = true
    await ensureViewerAlive()
    await showSurfaces(true)
    log(`Superfícies prontas: ${r.meshes.length} malhas, ${r.stats.length} regiões com espessura/área.`, 'ok')
    tlNote('surf', `${r.meshes.length} malhas white/pial · ${r.stats.length} regiões com espessura/área (Fischl–Dale)`)
    tlDone('surf', [{ label: 'malhas 3D', view: 'surf' }, { label: 'voltar à parcelação', view: 'seg' }], r.aviso ? 'warn' : 'ok')
    progress(0)
  } catch (e) {
    log('Erro nas superfícies — o resultado DKT permanece intacto: ' + e.message, 'err')
    stepError('05 · Superfícies', e, e.diag || null)
    progress(0)
  } finally {
    state.running = false
    $('run').disabled = false
    $('run-surf').disabled = false
  }
}

// mostra/esconde as malhas pial (coloridas por parcela DKT) no visualizador
async function showSurfaces (on) {
  const nv = state.nv
  if (!nv) return
  try {
    while (nv.meshes && nv.meshes.length) nv.removeMesh(nv.meshes[0])
    if (on && state.surf) {
      for (const m of state.surf.meshes) {
        if (m.kind !== 'pial') continue
        const file = new File([m.mz3], m.name + '.mz3')
        const mesh = await NVMesh.loadFromFile({ file, gl: nv.gl, name: m.name + '.mz3' })
        nv.addMesh(mesh)
      }
      // o render volumétrico oclui as malhas: esconde os volumes enquanto o 3D está ativo
      for (let i = 0; i < nv.volumes.length; i++) nv.setOpacity(i, 0)
      $('slicetype').value = 'render'
      applySliceType()
    } else {
      if (nv.volumes.length > 0) nv.setOpacity(0, 1)
      if (nv.volumes.length > 1) nv.setOpacity(1, (+$('opacity').value) / 100)
      $('slicetype').value = 'multi'
      applySliceType()
    }
    nv.drawScene()
  } catch (e) {
    log('Não consegui exibir as malhas: ' + e.message, 'err')
  }
}

function renderSurfStats () {
  if (!state.surf) return
  const tb = $('surf-table')
  const fmt = (x, d = 2) => (+x).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
  tb.querySelector('thead').innerHTML = '<tr><th>Região</th><th>H</th><th>Esp (mm)</th><th>Área (cm²)</th><th>Vol (cm³)</th></tr>'
  tb.querySelector('tbody').innerHTML = state.surf.stats.map(r =>
    `<tr><td>${(r.pt || r.base).replace(/ — (esquerd|direit)[oa]$/, '')}</td><td>${r.hemi}</td>` +
    `<td>${fmt(r.thickAvg)} ± ${fmt(r.thickStd)}</td><td>${fmt(r.area_mm2 / 100, 1)}</td><td>${fmt(r.volume_mm3 / 1000, 1)}</td></tr>`).join('')
  $('surf-panel').hidden = false
}

async function runSegmentation () {
  if (state.running || !state.rawVol) return
  state.running = true
  $('run').disabled = true
  try {
    const nv = state.nv
    const pipeline = effectivePipeline()
    state.native = null
    state.synthsr = null
    state.bet = null
    // linha do tempo: uma nova execução invalida as etapas 02–05 anteriores
    for (const id of ['prep', 'synthsr', 'conform', 'bet', 'seg', 'dkt', 'surf']) tlRemove(id)
    viewCache.clear()
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
      tlStage('prep', '02 · Pré-processamento nativo')
      tlNote('prep', [flags.doReorient && 'reorientação RAS', flags.doCrop && 'recorte de pescoço',
        flags.doResample && 'reamostragem cúbica', flags.doBias && 'correção de viés',
        flags.doSmooth && 'suavização'].filter(Boolean).join(' + '))
      if (pipeline === 'robust') {
        log('Modo robusto: reamostragem cúbica + correção de campo de viés (aproximação clássica; para a rede SynthSR de verdade, marque "MP-RAGE sintético 1 mm").')
        tlNote('prep', $('pipeline').value === 'auto'
          ? 'pipeline robusto acionado pela régua de qualidade (entrada anisotrópica/ruidosa)'
          : 'pipeline robusto selecionado manualmente', 'decision')
      }
      state.native = await preprocessNative(state.rawVol, flags)
      workVol = state.native.vol
      tlDone('prep', [{ label: 'pré-processado nativo', view: 'native' }])
    }
    // SynthSR (recon-all-clinical): sintetiza um MP-RAGE T1 1 mm a partir de qualquer
    // contraste/resolução — a imagem sintética alimenta a conformação e os modelos
    // treinados em T1 (aseg/DKT/tecidos) e a visualização
    if ($('opt-synthsr') && $('opt-synthsr').checked) {
      tlStage('synthsr', 'SynthSR — MP-RAGE T1 1 mm sintético')
      tlNote('synthsr', 'síntese de um MP-RAGE 1 mm a partir do exame (recon-all-clinical) — alimenta a conformação e os modelos treinados em T1', 'decision')
      if ($('model').value === 'synthseg') {
        log('Nota: o SynthSeg é agnóstico a contraste/resolução — no recon-all-clinical ele segmenta a imagem ORIGINAL; aqui o SynthSR alimentará a rede mesmo assim, por sua escolha.')
        tlNote('synthsr', 'o SynthSeg é agnóstico a contraste — o SynthSR é dispensável para esse modelo', 'warn')
      }
      if ($('opt-synthsr-flip').checked) tlNote('synthsr', 'média com flip L/R ativa (dobra o tempo)')
      log('SynthSR v1.0 — sintetizando MP-RAGE T1 1 mm (Iglesias et al., Sci Adv 2023)…')
      state.synthsr = await runSynthsrStep(workVol, $('backend').value !== 'cpu', $('mem').value === 'low', $('opt-synthsr-flip').checked)
      workVol = state.synthsr.vol
      tlDone('synthsr', [{ label: 'MP-RAGE sintético', view: 'synthsr' }])
    }
    const steps = []
    if (flags.doReorient) steps.push('reorientação RAS')
    if (flags.doCrop) steps.push('recorte de pescoço')
    if (flags.doResample) steps.push('reamostragem cúbica Catmull-Rom')
    if (flags.doBias) steps.push('correção de viés')
    if (flags.doSmooth) steps.push('suavização')
    if (state.synthsr) steps.push('SynthSR → MP-RAGE T1 1 mm sintético' + (state.synthsr.flip ? ' (média L/R)' : ''))
    state.pipelineUsed = (pipeline === 'robust' ? 'robusto (' : 'padrão (') +
      (steps.length ? steps.join(' + ') + ' → ' : '') + 'conformação direta)'

    log('Conformando para 256³ · 1 mm (estilo FreeSurfer)…')
    tlStage('conform', 'Conformação 256³ · 1 mm')
    progress(0.4)
    while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
    await nv.addVolume(workVol)
    const conformed = await nv.conform(workVol, false, true, false, true)
    while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
    await nv.addVolume(conformed)
    state.conformed = conformed
    state.wl = null
    autoWindow()
    log('Conformação concluída.', 'ok')
    tlDone('conform', [{ label: 'volume conformado', view: 'conf' }])

    // modelo
    const kind = $('model').value
    const variant = $('mem').value === 'low' ? 'low' : 'high'
    const isGPU = $('backend').value !== 'cpu'
    let labelsPath, colormapPath, seg

    // extração cerebral (≈ BET) sobre o volume conformado, antes da segmentação;
    // a rede recebe o cérebro extraído (e normalizado, se marcado)
    let infImg = null
    if ($('opt-bet').checked && kind !== 'mask') {
      tlStage('bet', 'Extração cerebral (≈ BET)')
      await runBrainExtraction(conformed, isGPU, variant)
      infImg = state.bet.brain
      const cm3 = state.bet.voxels / 1000
      tlNote('bet', `máscara de ${cm3.toFixed(0)} cm³ · f=${state.bet.f}${state.bet.normalized ? ' · intensidade normalizada na máscara' : ''}`)
      if (cm3 < 700) tlNote('bet', 'máscara pequena — o limiar f pode estar alto; confira a sobreposição', 'warn')
      tlNote('bet', 'a rede de segmentação receberá só o cérebro extraído', 'decision')
      tlDone('bet', [{ label: 'máscara (QC)', view: 'mask' }, { label: 'cérebro extraído', view: 'brain' }], cm3 < 700 ? 'warn' : 'ok')
    }

    tlStage('seg', '03 · Segmentação')
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
    state.surf = null
    await showSurfaces(false)
    $('run-dkt').disabled = !DKT_SOURCES[kind]
    $('run-surf').disabled = true
    $('show-surf').disabled = true
    $('show-surf').checked = false
    $('surf-panel').hidden = true
    await applySegmentationResult(labelsPath, colormapPath)
    tlNote('seg', `${state.modelUsed} — ${isGPU ? 'GPU (WebGL)' : 'CPU'}`)
    if (state.stats) tlNote('seg', `volume encefálico segmentado: ${(state.stats.brainVol / 1000).toFixed(0)} cm³`)
    tlDone('seg', [{ label: 'ver segmentação', view: 'seg' }])
  } catch (e) {
    log('Erro: ' + e.message, 'err')
    if (/memory|memória|texture|alloc/i.test(String(e.message))) {
      log('Sugestão: troque "Memória" para Baixa, ou a execução para CPU.', 'err')
    }
    stepError('03 · Segmentação', e)
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
    surf: state.surf ? { regioes: state.surf.stats } : null,
    preproc: {
      nativo: state.native ? state.native.prov : null,
      synthsr: state.synthsr
        ? { aplicado: true, flipLR: state.synthsr.flip, rede: 'SynthSR v1.0 (Iglesias et al., Sci Adv 2023)', papel: 'MP-RAGE T1 1 mm sintético alimentou a conformação e a segmentação (estilo recon-all-clinical)' }
        : { aplicado: false },
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
    niiSynthsr: async () => state.synthsr ? await gzipBuffer(state.synthsr.buf) : null,
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
  if (!state.stats && !['nii-conf', 'nii-native', 'nii-synthsr', 'nii-mask', 'nii-brain', 'errlog'].includes(kind) && !kind.startsWith('cohort')) {
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
      case 'nii-synthsr': {
        const b = await ex.niiSynthsr()
        if (b) saveBlob(b, `${sub}_synthsr_mprage.nii.gz`)
        else log('Sem MP-RAGE sintético — rode com "MP-RAGE sintético 1 mm (SynthSR)" marcado.', 'err')
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
        if (state.surf) {
          for (const m of state.surf.meshes) files.push({ name: `${sub}_${m.name}.mz3`, data: new Uint8Array(m.mz3) })
        }
        if (state.native) files.push({ name: `${sub}_preproc_nativo.nii.gz`, data: new Uint8Array(await ex.niiNative()) })
        if (state.synthsr) files.push({ name: `${sub}_synthsr_mprage.nii.gz`, data: new Uint8Array(await ex.niiSynthsr()) })
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
      case 'errlog': exportErrorLog(); break
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
      await handleDicomInput(Array.from(e.target.files))
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
        await handleDicomInput(files)
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
  $('run-surf').onclick = runSurfStep
  $('show-surf').onchange = () => showSurfaces($('show-surf').checked)
  $('bet-f').oninput = () => { $('bet-f-out').textContent = (+$('bet-f').value).toFixed(2) }
  $('opacity').oninput = () => {
    const nv = state.nv
    if (nv.volumes.length > 1) {
      nv.setOpacity(1, (+$('opacity').value) / 100)
      nv.drawScene()
    }
  }
  $('slicetype').onchange = applySliceType
  $('filter').oninput = renderTable
  $('group-filter').onchange = renderTable
  $('subject').oninput = () => { $('stage-title').textContent = $('subject').value || 'Exame' }
  $('age').onchange = updateNorms
  $('sex').onchange = updateNorms
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.onclick = () => handleExport(btn.dataset.export)
  })

  // diálogo de erro (tutorial) + log exportável
  $('err-download').onclick = exportErrorLog
  $('err-close').onclick = () => $('dlg-error').close()
  const errBtn = document.querySelector('[data-export="errlog"]')
  if (errBtn) errBtn.disabled = !errorLog.length
  // erros fora das etapas também entram no log (sem pop-up — podem ser benignos)
  window.addEventListener('error', (ev) => {
    try { recordError('global', ev.error || new Error(String(ev.message || 'erro de script'))) } catch { /* nunca propaga */ }
  })
  window.addEventListener('unhandledrejection', (ev) => {
    try { recordError('promise', ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason))) } catch { /* nunca propaga */ }
  })
}

// ---------- arranque ----------
async function main () {
  deviceBadge()
  await initViewer()
  armContextGuard()
  initWindowing()
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
