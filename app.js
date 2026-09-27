// SegmentaRM — orquestrador.
// Fluxo: entrada (DICOM→dcm2niix WASM | NIfTI) → régua de qualidade → pipeline
// (padrão: conformação | robusto: reamostragem cúbica + correção de viés → conformação)
// → segmentação (worker brainchop, tfjs) → estatísticas → exportações e coorte.

import { Niivue, NVImage, NVMesh, SLICE_TYPE } from './vendor/niivue.js'
import { Dcm2niix } from './vendor/dcm2niix/index.jpeg.js'
import { inferenceModelsList, brainChopOpts } from './brainchop/brainchop-parameters.js'
import { assessQuality } from './lib/quality.js'
import { computeStats, aplicarVolumesSuaves, statsToCSV, statsToJSON, statsToWideRow, AVISO_ESPESSURA } from './lib/stats.js'
import { GROUP_PT, ptNameOf } from './lib/labels.js'
import { writeNifti, gzipBuffer } from './lib/nifti-writer.js'
import { tableToSav } from './lib/sav.js'
import { buildReport } from './lib/report.js'
import { makeZip } from './lib/zip.js'
import { fuseDKT } from './lib/dkt-fusion.js'
import { loadNorms, compareToNorms, formatPercentil, seloNorma } from './lib/normative.js'
import { scanDicomSeries, directSeriesToNifti, correcaoDistorcao } from './lib/dicom-scan.js'
import { protocoloDe } from './lib/protocolo.js'
import { avaliarRegras, ocupacaoHipocampal, alvosDeCaptura } from './lib/qcrules.js'
import { carregarAssimetria, anotarAssimetria, referenciaAssimetria, zHoc } from './lib/assimetria.js'
import { calcularCalibracao, salvarCalibracao, calibracaoPara, calibracaoDesatualizada, lerCalibracoes, importarCalibracoes, N_MIN_DESLOCAMENTO, N_MIN_ESCALA } from './lib/calibracao.js'
import { computeSegQC, qcToCSV } from './lib/segqc.js'

const VERSION = '1.1.0'
// Superfícies corticais (passo 05) em revisão: a malha gerada não está confiável, então
// NADA do passo 05 entra nas exportações (CSV/JSON/SAV/PDF/ZIP/coorte, MZ3, norm,
// talairach.xfm). Reative aqui quando o passo estiver validado.
const SURF_EXPORT = false
// Espessura cortical volumétrica (passo 05): validada em fantomas, ainda sem comparação
// com o FreeSurfer nos mesmos exames — exportada SEMPRE acompanhada do aviso
// metodológico (AVISO_ESPESSURA, em lib/stats.js) no CSV, JSON, SAV, PDF e coorte.
const THICK_EXPORT = true
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
  segConf: null,       // Uint8Array — posterior máxima por voxel (confiança da rede)
  segVolSoft: null,    // Float64Array — volume soft por canal do SynthSeg (voxels; soma dos posteriors, como o --vol oficial)
  qc: null,            // { grupos, estruturas, resumo } — QC por grupo tecidual
  bet: null,           // { mask, brain, f, voxels, normalized, cleanupLog } no espaço conformado
  surf: null,          // { meshes:[{name,kind,hemi,mz3}], stats:[...] } do passo de superfícies
  wl: null,            // janela de exibição atual { min, max } do volume base
  wlRange: 255,        // amplitude de referência (p99−p1) para escalar o arrasto
  rebuilding: false,
  clinicalChain: false, // pipeline completo 03→04→05 em curso (mantém o botão travado entre etapas)
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

// devolve a thread principal ao navegador entre blocos síncronos pesados (conformação,
// fusão, estatísticas, QC) para a UI pintar o progresso e responder a cliques;
// scheduler.yield não sofre o estrangulamento de timers em aba oculta
function yieldUI () {
  try { if (globalThis.scheduler && typeof scheduler.yield === 'function') return scheduler.yield() } catch { /* segue com timer */ }
  return new Promise(resolve => setTimeout(resolve, 0))
}

// ---------- tarefas em Web Worker: registro único para cancelar e liberar memória ----------
// cada worker de etapa registra-se aqui; "Cancelar" termina o worker (libera a
// memória e a GPU dele na hora) e rejeita a promessa pendente com err.cancelled
const jobs = new Set()
let cancelPending = false // pedido feito num trecho sem worker: vale para o próximo
function cancelledError () {
  const err = new Error('etapa cancelada pelo usuário')
  err.cancelled = true
  return err
}
function trackWorker (w, reject) {
  const job = { w, reject }
  if (cancelPending) {
    cancelPending = false
    try { w.terminate() } catch { /* nada */ }
    queueMicrotask(() => reject(cancelledError()))
    return () => {}
  }
  jobs.add(job)
  return () => { jobs.delete(job); try { w.terminate() } catch { /* já terminado */ } }
}
function cancelJobs () {
  if (!jobs.size) { cancelPending = state.running; return false }
  for (const job of [...jobs]) {
    jobs.delete(job)
    try { job.w.terminate() } catch { /* já terminado */ }
    job.reject(cancelledError())
  }
  state.worker = null
  return true
}

// estado dos botões de etapa num só lugar — derivado do estado, não de cada caminho
function syncButtons () {
  const busy = state.running
  const has = (id) => !!$(id)
  $('run').disabled = busy || !state.rawVol
  if (has('run-clinical')) $('run-clinical').disabled = busy || state.clinicalChain || !state.rawVol
  $('run-dkt').disabled = busy || !(state.seg && DKT_SOURCES[state.segKind])
  $('run-surf').disabled = busy || !(state.seg && /-dkt$/.test(state.segKind || ''))
  $('show-surf').disabled = !state.surf
  if (has('cancel')) $('cancel').hidden = !busy
  for (const id of ['pick-file', 'pick-folder', 'load-example']) if (has(id)) $(id).disabled = busy
  if (has('series')) $('series').disabled = busy
}
function setBusy (on) {
  state.running = on
  if (!on) cancelPending = false
  syncButtons()
}
// entrada nova no meio de uma etapa corromperia o estado (a etapa terminaria sobre outro exame)
function refuseWhileBusy () {
  if (!state.running) return false
  log('Há uma etapa em execução — aguarde terminar ou clique em "Cancelar" antes de abrir outro exame.', 'err')
  return true
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
      'Re-rode o passo 04 · Parcelação DKT. Se falhar ou parcelar só um lado, troque a fonte (FastSurfer 3 vistas ↔ axial+coronal ↔ rede brainchop) ou mude Memória para Baixa mantendo a GPU (WebGL). Evite CPU no FastSurfer: leva horas — se não houver GPU, prefira a fonte axial+coronal ou a rede brainchop.',
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
      'Feche outras abas e rode de novo na GPU — a GPU (WebGL) é o caminho viável para todas as redes.',
      'Só então troque "Execução" para CPU: estável, porém lento (SynthSeg: vários minutos; FastSurfer/DKT: horas — nele prefira a fonte axial+coronal ou a rede brainchop).',
      'Em estudos DICOM grandes, abra só a série necessária na triagem.',
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
      'Se repetir, troque "Memória" para Baixa; CPU só como último recurso (lento — no FastSurfer/DKT, horas).',
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
  if (err && err.cancelled) {
    // cancelamento é escolha do usuário: sem pop-up nem registro no log de erros
    const key = TL.current
    if (key) { tlNote(key, 'cancelada pelo usuário', 'warn'); tlDone(key, [], 'warn') }
    return
  }
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
    else if (kind === 'norm') base = state.surf && state.surf.norm && await intermediateVol('norm', state.surf.norm, 'float32', 'norm sintético recon-clinical')
    else if (kind === 'confmap') base = state.segConf && await intermediateVol('confmap', state.segConf, 'uint8', 'confianca da rede (posterior maxima)')
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
    // as malhas viviam no contexto perdido: recarrega se o 3D estava ativo
    if (state.surf && $('show-surf').checked) await showSurfaces(true)
    else applySliceType()
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
      el.title = String(name)
      el.dataset.gpu = '1'
      // libera o contexto de sonda (o navegador limita contextos WebGL vivos por aba)
      try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext() } catch { /* sem extensão */ }
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
  if (refuseWhileBusy()) return
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
      let done = false
      if (plan.direct && g.supportedDirect) {
        log(`Série "${g.desc}": leitura direta (${g.count} cortes, ${(g.bytes / 1048576).toFixed(0)} MB)…`)
        try {
          const { file, sidecar } = await directSeriesToNifti(g, (k, n) =>
            progress(0.15 + 0.75 * ((i + k / n) / plan.selected.length)))
          entries.push({ file, sidecar })
          done = true
        } catch (err) {
          // leitura direta cobre só o caso simples; o dcm2niix é o caminho geral
          log(`Série "${g.desc}": leitura direta falhou (${err.message}) — tentando o dcm2niix…`, 'err')
        }
      }
      if (!done) {
        log(`Série "${g.desc}": convertendo com dcm2niix (${g.count} arquivos)…`)
        const conv = await convertDicom(g.files)
        // o sidecar do dcm2niix (anonimizado) não traz a idade na data do exame nem o sexo:
        // completa com a leitura de cabeçalho da própria série (sem datas)
        entries.push({ ...conv, sidecar: { ...(g.sidecar || {}), ...(conv.sidecar || {}) } })
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
    try { await loadVolumeFile(en.file, en.sidecar, `DICOM → ${en.file.name}`) } catch (err) { log('Erro ao abrir a série: ' + err.message, 'err'); progress(0) }
  }
  const en = entries[best]
  await loadVolumeFile(en.file, en.sidecar, `DICOM → ${en.file.name}`)
}

async function convertDicom (files) {
  log(`Convertendo ${files.length} arquivos DICOM com dcm2niix (WASM)…`)
  progress(0.05)
  const d = new Dcm2niix()
  let out
  try {
    await d.init()
    // o wrapper não escuta 'error' durante run(): um abort do WASM (memória) deixaria
    // a promessa pendente para sempre — corre contra o evento de erro do worker
    const crashed = new Promise((resolve, reject) => {
      d.worker.addEventListener('error', (e) => reject(new Error('dcm2niix interrompido: ' + (e.message || 'falha no worker (memória?)'))))
    })
    out = await Promise.race([d.input(files).b('y').z('n').f('%p_%s_%d').run(), crashed])
  } finally {
    // cada conversão cria um worker com heap WASM próprio (centenas de MB em estudos
    // grandes); os File de saída já foram clonados para esta thread
    try { if (d.worker) d.worker.terminate() } catch { /* já terminado */ }
  }
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
    try { await loadVolumeFile(f, await readSidecar(f), `DICOM → ${f.name}`) } catch (err) { log('Erro ao abrir a série: ' + err.message, 'err'); progress(0) }
  }
  const f = niis[best]
  return { file: f, sidecar: await readSidecar(f) }
}

// descarta tudo o que deriva de uma segmentação (e, com withConformed, a conformação
// e os intermediários): nada de estatística/exportação de uma execução ficar pareado
// com o volume de outra — ex.: refazer o 03 com outras opções e ele falhar no meio
async function clearSegmentationState ({ withConformed = false } = {}) {
  if (withConformed) {
    state.conformed = null
    state.native = null
    state.synthsr = null
    state.bet = null
    state.icv = null
    state.pipelineUsed = ''
  }
  state.seg = null
  state.segKind = null
  state.segConf = null
  state.segVolSoft = null
  state.segVolSoftUnit = null
  state.labelsMap = null
  state.colormap = null
  state.stats = null
  state.norms = null
  state.qc = null
  state.surf = null
  state.thick = null
  state.modelUsed = ''
  viewCache.clear()
  $('show-surf').checked = false
  if (state.nv && state.nv.meshes && state.nv.meshes.length) await showSurfaces(false)
  $('surf-panel').hidden = true
  $('qc-panel').hidden = true
  $('norm-panel').hidden = true
  $('results').hidden = true
  $('step-export').hidden = true
  delete $('step-run').dataset.done
  updateIntermediateExports()
  syncButtons()
}

async function loadVolumeFile (file, sidecar, desc) {
  if (refuseWhileBusy()) return
  progress(0.15)
  const vol = await NVImage.loadFromFile({ file, name: file.name })
  const nv = state.nv
  while (nv.volumes.length) await nv.removeVolume(nv.volumes[0])
  await nv.addVolume(vol)
  state.rawVol = vol
  await clearSegmentationState({ withConformed: true })
  state.sidecar = sidecar || null
  if (state.sidecar && !state.sidecar.CorrecaoDistorcao) state.sidecar.CorrecaoDistorcao = correcaoDistorcao(state.sidecar)
  state.inputDesc = desc
  preencherIdadeSexo(state.sidecar)
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
  try { state.protocolo = await protocoloDe(state.sidecar, pixDims) } catch { state.protocolo = null }
  atualizarCalibracao()
  renderQuality(state.quality)
  $('step-quality').hidden = false
  $('step-run').hidden = false
  syncButtons()
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

// idade NA DATA DO EXAME e sexo lidos do DICOM: um exame novo é outro paciente, então os
// valores do cabeçalho substituem os dos campos (o usuário pode corrigir depois)
function preencherIdadeSexo (sc) {
  state.idadeFonte = null
  if (!sc) return
  const age = $('age'); const sex = $('sex')
  if (sc.IdadeNoExame > 0) {
    const antes = parseFloat(age.value)
    age.value = String(sc.IdadeNoExame)
    state.idadeFonte = sc.IdadeFonte
    log(`Idade preenchida do DICOM: ${String(sc.IdadeNoExame).replace('.', ',')} anos na data do exame (${sc.IdadeFonte})` +
      (antes > 0 && Math.abs(antes - sc.IdadeNoExame) > 0.05 ? ` — substituiu o valor anterior (${antes}).` : '.'), 'ok')
  }
  if (sc.PatientSex === 'M' || sc.PatientSex === 'F') sex.value = sc.PatientSex
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
  let release = () => {}
  let result
  try {
    result = await new Promise((resolve, reject) => {
      release = trackWorker(worker, reject)
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
  } finally {
    release() // termina o worker também no erro (antes vazava a cópia float32 do volume)
  }
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
    const release = trackWorker(w, reject)
    const end = () => { release(); state.worker = null }
    w.onmessage = (ev) => {
      const d = ev.data
      if (d.cmd === 'ui') {
        if (d.message) log('· ' + d.message)
        if (typeof d.progressFrac === 'number' && d.progressFrac >= 0) progress(pFrom + d.progressFrac * (pTo - pFrom))
        if (d.modalMessage) { end(); reject(new Error(d.modalMessage)) }
      } else if (d.cmd === 'img') {
        end()
        resolve(d)
      }
    }
    w.onerror = (e) => { end(); reject(new Error(e.message || 'falha no worker SynthSR')) }
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
    const release = trackWorker(w, reject)
    let end = () => { release(); state.worker = null }
    const t0 = performance.now()
    // cão de guarda: com WebGL, um worker mudo por muito tempo quase sempre é GPU
    // travada ou contexto perdido (o tfjs espera a GPU para sempre, sem erro). Com CPU
    // uma única camada pode levar minutos, então não há limite.
    let watchdog = null
    let silentMs = 0
    const arm = () => {
      if (!silentMs) return
      clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        end()
        reject(new Error(`a GPU parou de responder (${Math.round(silentMs / 60000)} min sem progresso) — provável falta de memória de vídeo ou contexto WebGL perdido. Tente "Memória: Baixa" (blocos menores), feche outras abas que usam a GPU ou, em último caso, CPU.`))
      }, silentMs)
    }
    const end0 = end
    end = () => { clearTimeout(watchdog); end0() }
    w.onmessage = (ev) => {
      const d = ev.data
      if (d.cmd === 'backend') { silentMs = d.name === 'webgl' ? 8 * 60000 : 0; arm(); return }
      arm()
      if (d.cmd === 'ui') {
        if (d.message) log('· ' + d.message)
        if (typeof d.progressFrac === 'number' && d.progressFrac >= 0) progress(pFrom + d.progressFrac * (pTo - pFrom))
        if (d.modalMessage) { end(); reject(new Error(d.modalMessage)) }
      } else if (d.cmd === 'img') {
        end()
        // posterior máxima por voxel (0–255), quando a rede a devolve: é a
        // confiança usada pelo QC por grupo tecidual. Só sobrescreve quando vem —
        // o passo DKT roda outra rede (FastSurfer/brainchop, sem posteriores) e não
        // pode apagar a confiança da segmentação que ele está refinando; a limpeza
        // por execução fica no início de runSegmentation.
        if (d.conf) state.segConf = new Uint8Array(d.conf)
        if (d.volumes) { state.segVolSoft = new Float64Array(d.volumes); state.segVolSoftUnit = d.volumesUnit || 'voxels' }
        log(`Inferência concluída em ${((performance.now() - t0) / 1000).toFixed(1)} s.`, 'ok')
        resolve(new Uint8Array(d.img))
      }
    }
    w.onerror = (e) => { end(); reject(new Error(e.message || 'falha no worker de segmentação')) }
    // a imagem nativa (dezenas de MB) vai transferida, não clonada
    w.postMessage(message, message.native && message.native.data ? [message.native.data.buffer] : [])
  })
}

function runSynthsegModel (conformed, isGPU, tile, pFrom, pTo, imgOverride = null, nativeVol = null) {
  const flip = !$('opt-synthseg-flip') || $('opt-synthseg-flip').checked
  // caminho oficial: a rede vê a imagem NATIVA pré-processada como no predict_synthseg
  // (reamostragem 1 mm, RAS, percentis do volume reamostrado); o conformado só define a
  // grade de saída. Com extração cerebral a entrada é o cérebro conformado (sem nativa).
  let native = null
  if (nativeVol && !imgOverride) {
    const d = dimsOf(nativeVol)
    const n = d[0] * d[1] * d[2]
    const slope = nativeVol.hdr.scl_slope || 1
    const inter = nativeVol.hdr.scl_inter || 0
    const data = new Float32Array(n)
    for (let i = 0; i < n; i++) data[i] = nativeVol.img[i] * slope + inter
    native = { data, dims: d, affine: affineOf(nativeVol) }
  }
  log(`SynthSeg 1.0 — ${isGPU ? 'WebGL' : 'CPU'}, blocos de ${tile}³${flip ? ', média com o volume espelhado E/D (como o predict.py oficial)' : ', sem espelhamento'}…`)
  return runWorker('./workers/synthseg.worker.js', {
    modelUrl: new URL('./models/synthseg1/model.json', location.href).href, // o worker resolve URLs relativas contra /workers/
    img: imgOverride || conformed.img,
    dims: dimsOf(conformed),
    affine: affineOf(conformed),
    isGPU,
    tile,
    // sobreposição 64: contra o SynthSeg oficial (volume inteiro), Dice médio 0,991 → 0,998
    // no T1 de teste, em geral com o mesmo número de blocos de 128³
    overlap: 64,
    flip,
    native
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
    const release = trackWorker(w, reject)
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { log('· ' + m.txt); progress(0.72 + m.frac * 0.06) }
      else if (m.cmd === 'done') { release(); resolve(m) }
      else if (m.cmd === 'error') { release(); reject(new Error(m.message)) }
    }
    w.onerror = (e) => { release(); reject(new Error(e.message || 'falha no worker de máscara')) }
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
  if (q('nii-norm')) { q('nii-norm').hidden = !SURF_EXPORT; q('nii-norm').disabled = !(SURF_EXPORT && state.surf && state.surf.norm) }
  if (q('xfm')) { q('xfm').hidden = !SURF_EXPORT; q('xfm').disabled = !(SURF_EXPORT && state.surf && state.surf.xfm) }
  if (q('qc-csv')) q('qc-csv').disabled = !state.qc
  if (q('nii-conf')) q('nii-conf').disabled = !state.conformed
  if (q('nii-confmap')) q('nii-confmap').disabled = !state.segConf
}

// JSON do app (rótulos/colormaps): um 404 ou página de erro vira mensagem clara,
// não "Unexpected token <" no meio da etapa
async function fetchJson (url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`não consegui carregar ${url} (HTTP ${r.status}) — verifique a conexão na primeira execução`)
  return r.json()
}

// "volume encefálico" = BrainSegVol (FreeSurfer 7: sem tronco, com líquor); brainVol é
// o total rotulado (inclui tronco e líquor) e só aparece quando o agregado não existe
function brainVolTxt (stats) {
  const bsv = (stats.composites || []).find(c => c.id === 'BrainSegVol')
  return bsv && bsv.volMm3 > 0
    ? `Volume encefálico (BrainSegVol): ${(bsv.volMm3 / 1000).toFixed(0)} cm³ · total rotulado ${(stats.brainVol / 1000).toFixed(0)} cm³`
    : `Total rotulado: ${(stats.brainVol / 1000).toFixed(0)} cm³`
}

// recarrega rótulos/colormap, recalcula as estatísticas e re-renderiza
async function applySegmentationResult (labelsPath, colormapPath) {
  await ensureViewerAlive()
  state.labelsMap = labelsPath ? await fetchJson(labelsPath) : null
  state.colormap = colormapPath ? await fetchJson(colormapPath) : null
  await refreshOverlay()
  if (state.labelsMap) {
    log('Calculando estatísticas por estrutura…')
    progress(0.95)
    await yieldUI()
    state.stats = computeStats(state.seg, state.conformed.img, dimsOf(state.conformed), state.labelsMap, affineOf(state.conformed), voxVolOf(state.conformed))
    // volume SUAVE (soma das posteriores — o --vol do SynthSeg oficial) como valor principal;
    // a contagem de voxels fica como auditoria. Vale também depois do DKT: os índices 0–31 do
    // mapa combinado são os do SynthSeg e o córtex suave é redistribuído entre as parcelas
    if (/^synthseg/.test(state.segKind || '') && state.segVolSoft) {
      const vv = state.segVolSoftUnit === 'mm3' ? 1 : (state.stats.voxVol || voxVolOf(state.conformed))
      const suave = {}
      for (let i = 1; i < state.segVolSoft.length; i++) {
        const nm = state.labelsMap && state.labelsMap[i]
        if (nm) suave[nm] = state.segVolSoft[i] * vv
      }
      state.stats = aplicarVolumesSuaves(state.stats, suave)
    }
    renderResults()
    await yieldUI()
    // QC automático por grupo tecidual (grupos do regressor do SynthSeg 2.0)
    try {
      state.qc = computeSegQC({
        seg: state.seg,
        conf: state.segConf,
        dims: dimsOf(state.conformed),
        labelsMap: state.labelsMap,
        voxVol: voxVolOf(state.conformed)
      })
      renderQC()
      const r = state.qc.resumo
      const alertas = r.gruposEmAlerta.length
      log(`Índice de confiança interno (não validado): mínimo ${r.escoreMinimo.toFixed(2)}, médio ${r.escoreMedio.toFixed(2)}` +
        (alertas ? ` — ${alertas} grupo(s) abaixo de 0,65: ${r.gruposEmAlerta.join(', ')}.` : ' — nenhum grupo em alerta.'),
      alertas ? 'err' : 'ok')
      if (TL.current) {
        tlNote(TL.current, `índice de confiança interno (não validado): mínimo ${r.escoreMinimo.toFixed(2)} · médio ${r.escoreMedio.toFixed(2)}` +
          (alertas ? ` — em alerta: ${r.gruposEmAlerta.join(', ')}` : ' — nenhum grupo em alerta'), alertas ? 'warn' : 'info')
        if (!r.confiancaDisponivel) tlNote(TL.current, 'rede sem posteriores — QC usa só coesão e simetria', 'warn')
      }
    } catch (e) {
      log('QC não calculado: ' + e.message, 'err')
      state.qc = null
    }
    await updateIcv()
    await updateNorms()
    $('step-export').hidden = false
    updateIntermediateExports()
    $('step-run').dataset.done = '1'
    log(`${brainVolTxt(state.stats)}.`, 'ok')
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
  setBusy(true)
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
    await yieldUI()
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
        log(`Atenção: a fusão não deixou parcelas DKT no hemisfério ${!lhP && !rhP ? 'esquerdo NEM no direito' : (!lhP ? 'esquerdo' : 'direito')} — o passo 05 sairá incompleto. Re-rode o DKT com outra fonte (FastSurfer 3 vistas / axial+coronal / brainchop) ou memória baixa na GPU (FastSurfer em CPU leva horas).`, 'err')
        tlNote('dkt', `sem parcelas no hemisfério ${!lhP && !rhP ? 'esquerdo nem no direito' : (!lhP ? 'esquerdo' : 'direito')} — o passo 05 sairá incompleto; re-rode com outra fonte ou memória baixa na GPU`, 'warn')
      }
      var dktHemiOk = !!(lhP && rhP) // usado no fechamento da etapa abaixo
    }
    state.surf = null
    viewCache.delete('norm')
    $('show-surf').checked = false
    await showSurfaces(false)
    $('surf-panel').hidden = true
    await applySegmentationResult(src.labels, src.colormap)
    tlNote('dkt', `fusão: ${s.cortexVox.toLocaleString('pt-BR')} voxels de córtex — ${s.direct.toLocaleString('pt-BR')} diretos, ${s.filled.toLocaleString('pt-BR')} por vizinhança, ${s.residual.toLocaleString('pt-BR')} residuais`)
    tlDone('dkt', [{ label: 'ver parcelação DKT', view: 'seg' }], dktHemiOk ? 'ok' : 'warn')
  } catch (e) {
    log(`Erro no passo DKT — o resultado ${src.pt} permanece intacto: ` + e.message, 'err')
    stepError('04 · Parcelação DKT', e)
    progress(0)
  } finally {
    setBusy(false)
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
  setBusy(true)
  viewCache.delete('norm')
  // 1) espessura volumétrica (as medidas): roda primeiro e sobrevive a uma falha da malha
  try {
    log('Espessura cortical volumétrica: Laplace entre as bordas do córtex (Yezzi & Prince 2003), sulcos fechados reconstruídos pela linha média (CAT12/PBT)…')
    const t0 = performance.now()
    state.thick = await runThicknessWorker()
    renderThick()
    const h = state.thick.hemisferios || {}
    const f = (x) => x == null ? '—' : x.toFixed(2)
    log(`Espessura volumétrica pronta em ${((performance.now() - t0) / 1000).toFixed(0)} s: média E ${f(h.lh && h.lh.espessura_media_mm)} · D ${f(h.rh && h.rh.espessura_media_mm)} mm (${state.thick.regioes.length} regiões).`, 'ok')
    tlNote('surf', `espessura volumétrica (Laplace + reconstrução sulcal): média E ${f(h.lh && h.lh.espessura_media_mm)} · D ${f(h.rh && h.rh.espessura_media_mm)} mm`, 'info')
  } catch (e) {
    state.thick = null
    if (e && e.cancelled) { // cancelar interrompe o passo 05, não vira "falha da espessura"
      stepError('05 · Superfícies', e); progress(0); setBusy(false); return
    }
    log('Espessura volumétrica não calculada: ' + e.message, 'err')
    tlNote('surf', 'espessura volumétrica falhou: ' + e.message, 'warn')
  }
  // 2) malhas white/pial — só para visualização
  try {
    // motor recon-all-clinical: SDF da rede SynthDist quando os pesos convertidos
    // estiverem em models/synthsurf/ (traga-seus-pesos; licença do FreeSurfer),
    // senão SDF por EDT exata das máscaras (fallback declarado)
    let engine = $('surf-engine') ? $('surf-engine').value : 'edt'
    if (engine === 'net') {
      // GET (não HEAD): o service worker só serve GET do cache — offline, um HEAD
      // falharia e cairia para EDT mesmo com a rede já baixada
      const have = await fetch('./models/synthsurf/model.json').then(r2 => { const ok = r2.ok; try { r2.body && r2.body.cancel() } catch { /* nada */ } return ok }).catch(() => false)
      if (!have) {
        log('Rede SynthDist não instalada (models/synthsurf/ ausente) — usando SDF por EDT. Veja licenses/synthsurf.txt para instalar os pesos.', 'err')
        tlNote('surf', 'rede SynthDist ausente — caindo para SDF por EDT das máscaras', 'warn')
        engine = 'edt'
      }
    }
    log(`Malhas para visualização: SDFs ${engine === 'net' ? 'pela rede SynthDist' : 'por EDT das máscaras'} → white pela energia da Eq. 5 → pial por raio a partir da white…`)
    const r = await new Promise((resolve, reject) => {
      const w = new Worker('./workers/reconsurf.worker.js', { type: 'module' })
      const release = trackWorker(w, reject)
      w.onmessage = (ev) => {
        const m = ev.data
        if (m.cmd === 'progress') { if (m.txt) log('· ' + m.txt); progress(0.1 + m.frac * 0.85) }
        else if (m.cmd === 'done') { release(); resolve(m) }
        else if (m.cmd === 'error') { release(); const err = new Error(m.message); err.diag = m.diag || null; reject(err) }
      }
      w.onerror = (e) => { release(); reject(new Error(e.message || 'falha no worker de superfícies')) }
      // cópias transferidas (não clonadas): sem duplicar ~84 MB nem travar a thread
      // principal na clonagem; state.seg/conformed.img seguem intactos aqui
      const segCopy = new Uint8Array(state.seg)
      const imgCopy = engine === 'net' ? Float32Array.from(state.conformed.img) : null
      w.postMessage({
        seg: segCopy,
        dims: dimsOf(state.conformed),
        affine: affineOf(state.conformed).flat(),
        labels: state.labelsMap,
        colormap: state.colormap,
        voxVol: voxVolOf(state.conformed),
        engine,
        img: imgCopy,
        modelUrl: engine === 'net' ? new URL('./models/synthsurf/model.json', location.href).href : null,
        isGPU: $('backend').value !== 'cpu',
        tile: $('mem').value === 'low' ? 64 : 96
      }, imgCopy ? [segCopy.buffer, imgCopy.buffer] : [segCopy.buffer])
    })
    if (r.aviso) { log('Aviso: ' + r.aviso, 'err'); tlNote('surf', r.aviso, 'warn') }
    for (const reg of r.stats) reg.pt = ptNameOf(reg.name)
    state.surf = {
      meshes: r.meshes,
      stats: r.stats,
      euler: r.euler || null,
      motor: r.engineUsed === 'net' ? 'rede SynthDist' : 'SDF por EDT das máscaras',
      xfm: r.xfm || null,
      talairachRotulos: r.talairach ? r.talairach.nUsed : 0,
      norm: r.norm || null,
      qcMalha: r.qcMalha || null,
      malhaConfiavel: r.malhaConfiavel !== false
    }
    // a malha serve à VISUALIZAÇÃO; as medidas (espessura) vêm do método volumétrico
    if (r.qcMalha) {
      for (const [h, q] of Object.entries(r.qcMalha)) {
        if (!q) continue
        const txt = `malha ${h === 'lh' ? 'esquerda' : 'direita'}: dobras ${q.dobrasPialPct.toFixed(1)}% · faces invertidas ${q.invertidasPct.toFixed(1)}% · aresta p99 ${q.arestaP99Pial_mm.toFixed(1)} mm · χ ${q.euler}` + (q.confiavel ? ' — boa para visualização' : ' — ABAIXO do limite de qualidade')
        log('· QC ' + txt, q.confiavel ? '' : 'err')
        tlNote('surf', 'QC da ' + txt, q.confiavel ? 'info' : 'warn')
      }
    }
    $('show-surf').checked = true
    syncButtons()
    await ensureViewerAlive()
    await showSurfaces(true)
    updateIntermediateExports()
    const eulTxt = r.euler ? `χ de Euler E/D = ${r.euler.lh ?? '—'}/${r.euler.rh ?? '—'}` : ''
    const eulOk = r.euler && r.euler.lh === 2 && r.euler.rh === 2
    log(`Superfícies prontas (${state.surf.motor}): ${r.meshes.length} malhas, ${r.stats.length} regiões. ${eulTxt}${eulOk ? ' (topologia esférica ✓)' : ''}`, 'ok')
    if (r.euler && !eulOk) log(`QC: ${eulTxt} ≠ 2 — defeitos topológicos não corrigidos (sem mris_fix_topology); interprete espessuras locais com cautela.`, 'err')
    tlNote('surf', `motor: ${state.surf.motor} → colocação Eq. 5 → espessura Fischl–Dale (teto 5 mm)`, 'decision')
    if (r.euler) tlNote('surf', `QC de topologia: ${eulTxt}${eulOk ? ' — esférica ✓' : ' — defeitos NÃO corrigidos'}`, eulOk ? 'info' : 'warn')
    if (r.xfm) tlNote('surf', `talairach.xfm por centros de massa (${state.surf.talairachRotulos} rótulos casados com o MNI)`)
    tlNote('surf', `${r.meshes.length} malhas white/pial · ${r.stats.length} regiões com espessura/área`)
    tlDone('surf', [
      { label: 'malhas 3D', view: 'surf' },
      { label: 'norm sintético', view: 'norm' },
      { label: 'voltar à parcelação', view: 'seg' }
    ], (r.aviso || (r.euler && !eulOk)) ? 'warn' : 'ok')
    progress(0)
  } catch (e) {
    log('Erro nas malhas — o resultado DKT' + (state.thick ? ' e a espessura volumétrica permanecem' : ' permanece') + ' intacto: ' + e.message, 'err')
    stepError('05 · Superfícies', e, e.diag || null)
    progress(0)
  } finally {
    setBusy(false)
  }
}

// espessura cortical volumétrica em worker próprio (lib/thickness.js)
// ---------- volume intracraniano estimado (VIC ≈ eTIV) ----------
// registro afim do T1 conformado (cabeça inteira, antes de qualquer extração cerebral) ao
// MNI152 2009c embutido em lib/icv.js; VIC = K × det(A) na escala do eTIV do FreeSurfer.
// Calculado uma vez por conformação (não depende dos rótulos; a segmentação só valida).
function runIcvWorker () {
  return new Promise((resolve, reject) => {
    const w = new Worker('./workers/icv.worker.js', { type: 'module' })
    const release = trackWorker(w, reject)
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { progress(0.95 + (m.frac || 0) * 0.04) }
      else if (m.cmd === 'done') { release(); resolve(m) }
      else if (m.cmd === 'error') { release(); reject(new Error(m.message)) }
    }
    w.onerror = (e) => { release(); reject(new Error(e.message || 'falha no worker do VIC')) }
    const src = state.conformed.img
    const img = src instanceof Uint8Array ? new Uint8Array(src) : Uint8Array.from(src, v => Math.max(0, Math.min(255, Math.round(v))))
    const seg = state.seg ? new Uint8Array(state.seg) : null
    w.postMessage({
      img, dims: dimsOf(state.conformed), affine: affineOf(state.conformed).flat(), seg, labels: state.labelsMap
    }, seg ? [img.buffer, seg.buffer] : [img.buffer])
  })
}

async function updateIcv () {
  if (state.icv || !state.conformed) return
  if (state.synthsr) {
    log('VIC não estimado: o SynthSR gera um T1 sintético sem crânio — o registro ao template precisa da cabeça inteira.')
    return
  }
  try {
    log('Estimando o volume intracraniano (eTIV: registro afim ao MNI152)…')
    await yieldUI()
    const r = await runIcvWorker()
    state.icv = { vic_mm3: r.vic_mm3, metodo: r.metodo, aviso: r.aviso, detalhes: r.detalhes }
    const fc = r.detalhes && r.detalhes.frac_cerebral
    log(`Volume intracraniano (eTIV): ${(r.vic_mm3 / 1000).toFixed(0)} cm³` +
      (fc != null ? ` · fração cerebral ${fc.toFixed(2)}` : '') +
      (r.detalhes && r.detalhes.tempo_ms ? ` (${(r.detalhes.tempo_ms / 1000).toFixed(1)} s)` : '') + '.', r.aviso ? '' : 'ok')
    if (r.aviso) log('VIC — atenção: ' + r.aviso, 'err')
    if (TL.current) tlNote(TL.current, `VIC (eTIV) ${(r.vic_mm3 / 1000).toFixed(0)} cm³` + (r.aviso ? ' — ' + r.aviso : ''), r.aviso ? 'warn' : 'info')
    if (state.stats) renderResults()
  } catch (e) {
    state.icv = null
    // cancelar durante o VIC encerra só ele: a segmentação já pronta permanece (e o
    // pipeline completo para, via state.chainCancelled)
    if (e && e.cancelled) { log('VIC cancelado — a segmentação permanece.', 'err'); return }
    log('VIC não estimado: ' + e.message, 'err')
  }
}

function runThicknessWorker () {
  return new Promise((resolve, reject) => {
    const w = new Worker('./workers/thickness.worker.js', { type: 'module' })
    const release = trackWorker(w, reject)
    w.onmessage = (ev) => {
      const m = ev.data
      if (m.cmd === 'progress') { if (m.txt) log('· ' + m.txt); progress(0.05 + (m.frac || 0) * 0.3) }
      else if (m.cmd === 'done') { release(); resolve(m) }
      else if (m.cmd === 'error') { release(); reject(new Error(m.message)) }
    }
    w.onerror = (e) => { release(); reject(new Error(e.message || 'falha no worker de espessura')) }
    const segCopy = new Uint8Array(state.seg)
    w.postMessage({
      seg: segCopy,
      dims: dimsOf(state.conformed),
      affine: affineOf(state.conformed).flat(),
      labels: state.labelsMap,
      voxVol: voxVolOf(state.conformed)
    }, [segCopy.buffer])
  })
}

function renderThick () {
  const t = state.thick
  if (!t) return
  const tb = $('surf-table')
  const fmt = (x, d = 2) => x == null || !isFinite(x) ? '—' : (+x).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
  tb.querySelector('thead').innerHTML = '<tr><th>Região</th><th>H</th><th title="média ponderada por área na superfície média ± DP">Espessura (mm)</th><th>Mediana</th><th title="área da superfície média (u = 0,5)">Área (cm²)</th></tr>'
  const rows = t.regioes.slice().sort((a, b) => String(a.parcela).localeCompare(String(b.parcela)) || String(a.hemi).localeCompare(String(b.hemi)))
  tb.querySelector('tbody').innerHTML = rows.map(r =>
    `<tr><td>${ptNameOf(r.name).replace(/ — (esquerd|direit)[oa]$/, '')}</td><td>${r.hemi === 'lh' || r.hemi === 'E' ? 'E' : 'D'}</td>` +
    `<td>${fmt(r.espessura_media_mm)} ± ${fmt(r.espessura_dp_mm)}</td><td>${fmt(r.espessura_mediana_mm)}</td>` +
    `<td>${fmt(r.area_superficie_media_mm2 / 100, 1)}</td></tr>`).join('')
  const h = t.hemisferios || {}
  const hs = (k, nm) => h[k] ? `${nm} ${fmt(h[k].espessura_media_mm)} mm (mediana ${fmt(h[k].espessura_mediana_mm)})` : null
  const qh = (t.qc && t.qc.hemisferios) || {}
  const trunc = Object.values(qh).map(q => q.frac_truncados_5mm).filter(x => x != null)
  $('thick-summary').textContent = [hs('lh', 'Esquerdo'), hs('rh', 'Direito')].filter(Boolean).join(' · ') +
    (trunc.length ? ` · ${fmt(100 * Math.max(...trunc), 1)}% no teto de 5 mm` : '') +
    (t.regioes.length ? '' : ' · sem parcelas DKT: só as médias por hemisfério')
  $('surf-panel').hidden = false
}

// ---------- pipeline completo recon-all-clinical (03 → 04 → 05) ----------
// encadeia SynthSeg → parcelação DKT → superfícies por SDF; cada etapa preserva
// a anterior e os erros passam pelo tutorial/log normais de cada passo
async function runReconClinical () {
  if (state.running || !state.rawVol) return
  const btn = $('run-clinical')
  if (btn) btn.disabled = true
  state.clinicalChain = true
  state.chainCancelled = false
  try {
    log('Pipeline (navegador): segmentação SynthSeg → parcelação DKT.', 'ok')
    if ($('model').value !== 'synthseg') {
      $('model').value = 'synthseg'
      log('Modelo ajustado para SynthSeg 1.0 — o recon-all-clinical segmenta com o SynthSeg (agnóstico a contraste/resolução).')
    }
    await runSegmentation()
    if (!state.seg || state.segKind !== 'synthseg') { log('Pipeline interrompido: a segmentação não concluiu.', 'err'); return }
    if (state.chainCancelled) { log('Pipeline interrompido pelo usuário — o resultado SynthSeg permanece.', 'err'); return }
    await runDktStep()
    if (!/-dkt$/.test(state.segKind)) { log('Pipeline interrompido: a parcelação DKT não concluiu — o resultado SynthSeg permanece.', 'err'); return }
    // o passo 05 (superfícies) está em revisão e fica de fora do encadeamento
    log('Pipeline concluído até a parcelação DKT (volumes + parcelação prontos para exportação). O passo 05 (superfícies) está em revisão e não roda automaticamente.', 'ok')
  } finally {
    state.clinicalChain = false
    syncButtons()
  }
}

// mostra/esconde as malhas pial (coloridas por parcela DKT) no visualizador
async function showSurfaces (on) {
  const nv = state.nv
  if (!nv) return
  try {
    while (nv.meshes && nv.meshes.length) nv.removeMesh(nv.meshes[0])
    if (on && state.surf) {
      const kindSel = $('surf-show-kind') ? $('surf-show-kind').value : 'pial'
      for (const m of state.surf.meshes) {
        if (kindSel !== 'both' && m.kind !== kindSel) continue
        const file = new File([m.mz3], m.name + '.mz3')
        const mesh = await NVMesh.loadFromFile({ file, gl: nv.gl, name: m.name + '.mz3' })
        // com as duas, a pial fica translúcida para deixar ver a branca por dentro
        if (kindSel === 'both' && m.kind === 'pial') mesh.opacity = 0.35
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

// painel de QC: uma linha por grupo tecidual, com barra do escore e os três componentes
function renderQC () {
  if (!state.qc) { $('qc-panel').hidden = true; return }
  const fmt = (x, d = 2) => x == null ? '—' : (+x).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
  const tb = $('qc-table')
  tb.querySelector('thead').innerHTML =
    '<tr><th>Grupo tecidual</th><th title="Índice de confiança interno, não validado">Índice</th><th>Conf.</th><th>Coes.</th><th>Sim.</th></tr>'
  tb.querySelector('tbody').innerHTML = state.qc.grupos.filter(q => q.voxels > 0).map(q => {
    const pct = Math.max(0, Math.min(100, q.escore * 100))
    return `<tr class="${q.alerta ? 'bad' : ''}"><td title="${q.pt}">${q.curto || q.pt}</td>` +
      `<td><span class="qc-bar"><i style="width:${pct.toFixed(0)}%"></i></span>${fmt(q.escore)}</td>` +
      `<td>${fmt(q.confianca)}</td><td>${fmt(q.coesao)}</td><td>${q.simetria == null ? '—' : fmt(q.simetria)}</td></tr>`
  }).join('')
  const r = state.qc.resumo
  $('qc-summary').textContent = `Índice mínimo ${fmt(r.escoreMinimo)} · médio ${fmt(r.escoreMedio)}` +
    (r.gruposEmAlerta.length ? ` · ${r.gruposEmAlerta.length} grupo(s) abaixo de 0,65` : ' · nenhum grupo em alerta') +
    (r.confiancaDisponivel ? '' : ' · sem posteriores da rede (confiança neutra)')
  $('qc-panel').hidden = false
}

function renderSurfStats () {
  if (!state.surf) return
  const tb = $('surf-table')
  const fmt = (x, d = 2) => (+x).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d })
  // GrayVol (prisma white→pial, como o aparc.stats) quando o worker o devolve;
  // a contagem de voxels fica no title
  const hasGray = state.surf.stats.some(r => r.grayVol_mm3 != null)
  tb.querySelector('thead').innerHTML = '<tr><th>Região</th><th>H</th><th>Esp (mm)</th><th>Área (cm²)</th>' +
    (hasGray ? '<th title="GrayVol: volume entre white e pial (aparc.stats)">GrayVol (cm³)</th>' : '<th>Vol (cm³)</th>') + '</tr>'
  tb.querySelector('tbody').innerHTML = state.surf.stats.map(r =>
    `<tr><td>${(r.pt || r.base).replace(/ — (esquerd|direit)[oa]$/, '')}</td><td>${r.hemi}</td>` +
    `<td>${fmt(r.thickAvg)} ± ${fmt(r.thickStd)}</td><td>${fmt(r.area_mm2 / 100, 1)}</td>` +
    (hasGray && r.grayVol_mm3 != null
      ? `<td title="contagem de voxels: ${fmt(r.volume_mm3 / 1000, 1)} cm³">${fmt(r.grayVol_mm3 / 1000, 1)}</td>`
      : `<td>${fmt(r.volume_mm3 / 1000, 1)}</td>`) + '</tr>').join('')
  $('surf-panel').hidden = false
}

async function runSegmentation () {
  if (state.running || !state.rawVol) return
  setBusy(true)
  try {
    const pipeline = effectivePipeline()
    // uma nova execução invalida TODO o resultado anterior (conformado, seg, stats,
    // QC, superfícies): se ela falhar no meio, nada de exportar a segmentação antiga
    // pareada com a conformação/proveniência nova
    await clearSegmentationState({ withConformed: true })
    try { while (state.nv.volumes.length > 1) await state.nv.removeVolume(state.nv.volumes[1]) } catch { /* só a sobreposição antiga */ }
    // linha do tempo: uma nova execução invalida as etapas 02–05 anteriores
    for (const id of ['prep', 'synthsr', 'conform', 'bet', 'seg', 'dkt', 'surf']) tlRemove(id)
    // etapas nativas (≈ FSL), antes da conformação: reorientação → recorte → reamostragem
    // (só no robusto) → viés → suavização — a imagem corrigida alimenta todo o resto
    // o SynthSeg (predict.py oficial) recebe a imagem crua: a rede foi treinada com
    // campos de viés e resoluções sintéticos, e a correção de viés/reamostragem
    // clássicas antes dela só afastam o resultado do oficial
    const isSynthSeg = $('model').value === 'synthseg'
    const flags = {
      doReorient: $('opt-reorient').checked,
      doCrop: $('opt-crop').checked,
      doResample: pipeline === 'robust' && !isSynthSeg,
      doBias: $('opt-bias').checked && !isSynthSeg,
      doSmooth: $('opt-smooth').checked
    }
    const skipped = isSynthSeg && ($('opt-bias').checked || pipeline === 'robust')
    let workVol = state.rawVol
    if (skipped) {
      log('SynthSeg: correção de viés e reamostragem clássica NÃO aplicadas — a rede recebe a imagem crua, como no predict.py oficial (é robusta a viés e resolução por treino).')
    }
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
    // state.nv (não uma referência guardada): se o contexto WebGL cair durante a etapa,
    // o visualizador é reconstruído e a instância antiga fica morta
    await ensureViewerAlive()
    while (state.nv.volumes.length) await state.nv.removeVolume(state.nv.volumes[0])
    await state.nv.addVolume(workVol)
    await yieldUI() // a conformação é síncrona (~2–5 s na thread principal): pinta o aviso antes
    // escala do FreeSurfer/FastSurfer (getscale f_low=0, f_high=0.999 → uint8), não a
    // janela robusta: com isRobustMinMax=true o NiiVue usa cal_min/cal_max do volume,
    // i.e. a janela de EXIBIÇÃO (inclusive o arrasto manual de janelamento) mudaria a
    // entrada das redes, e a 2–98% satura ~2% dos voxels e clareia a imagem ~1,4×
    const conformed = await state.nv.conform(workVol, false, true, false, false)
    await yieldUI()
    await ensureViewerAlive()
    while (state.nv.volumes.length) await state.nv.removeVolume(state.nv.volumes[0])
    await state.nv.addVolume(conformed)
    state.conformed = conformed
    state.icv = null // o VIC é do volume conformado: nova conformação, novo VIC
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
    if ($('opt-bet').checked && kind === 'synthseg') {
      log('Nota: o SynthSeg oficial segmenta a cabeça inteira (foi treinado assim); a extração cerebral antes dele é opcional e afasta o resultado do oficial.')
    }
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
      // entrada nativa = o arquivo ORIGINAL (como o predict.py): a reorientação RAS é
      // uma permutação sem perda, mas a reamostragem oficial a 1 mm posiciona as
      // amostras a partir do voxel 0 de cada eixo — numa imagem espelhada a grade
      // cairia deslocada da oficial. Recorte de pescoço, suavização ou SynthSR mudam o
      // conteúdo, e aí a rede recebe a imagem transformada (escolha do usuário).
      const nativeForSeg = (flags.doCrop || flags.doSmooth || state.synthsr) ? workVol : state.rawVol
      seg = await runSynthsegModel(conformed, isGPU, variant === 'low' ? 96 : 128, infImg ? 0.75 : 0.45, 0.93, infImg, nativeForSeg)
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
    await applySegmentationResult(labelsPath, colormapPath)
    tlNote('seg', `${state.modelUsed} — ${isGPU ? 'GPU (WebGL)' : 'CPU'}`)
    if (state.stats) tlNote('seg', brainVolTxt(state.stats))
    const segViews = [{ label: 'ver segmentação', view: 'seg' }]
    if (state.segConf) segViews.push({ label: 'mapa de confiança', view: 'confmap' })
    tlDone('seg', segViews, state.qc && state.qc.resumo.gruposEmAlerta.length ? 'warn' : 'ok')
  } catch (e) {
    log('Erro: ' + e.message, 'err')
    if (/memory|memória|texture|alloc/i.test(String(e.message))) {
      log('Sugestão: troque "Memória" para Baixa e feche outras abas; CPU só como último recurso (bem mais lento).', 'err')
    }
    stepError('03 · Segmentação', e)
    progress(0)
  } finally {
    setBusy(false)
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
  if (state.icv && state.icv.vic_mm3 > 0) {
    const div = document.createElement('div')
    div.className = 'card'
    div.title = (state.icv.metodo || '') + (state.icv.aviso ? '\nAtenção: ' + state.icv.aviso : '')
    div.innerHTML = `<div class="k">Volume intracraniano (eTIV)${state.icv.aviso ? ' ⚠' : ''}</div><div class="v">${fmtVol(state.icv.vic_mm3)} <small>estimado</small></div>`
    cards.appendChild(div)
  }
  for (const c of s.composites) {
    const div = document.createElement('div')
    div.className = 'card'
    div.innerHTML = `<div class="k">${c.ptName}</div><div class="v">${fmtVol(c.volMm3)} <small title="% do total rotulado">${c.pctBrain.toFixed(1)}%</small></div>`
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
  const vic = state.icv && state.icv.vic_mm3 > 0 ? state.icv.vic_mm3 : null
  const thead = $('table').querySelector('thead')
  const tbody = $('table').querySelector('tbody')
  const suave = !!s.volumeSoft
  thead.innerHTML = '<tr><th>Estrutura</th><th>Hemisfério</th>' +
    `<th style="text-align:right" title="${suave ? 'Valor principal: volume SUAVE — soma das probabilidades posteriores da rede (convenção --vol do SynthSeg)' : 'Contagem de voxels rotulados (a rede não fornece posteriores)'}">Volume (mm³)${suave ? ' · suave' : ''}</th>` +
    (suave ? '<th style="text-align:right" title="Auditoria: contagem de voxels do argmax (volume rígido)">Rígido</th>' : '') +
    '<th style="text-align:right" title="Percentual do total rotulado (todos os rótulos, com tronco e líquor) — o mesmo denominador do CSV e do PDF">% total rotulado</th><th style="text-align:right">Intensidade média</th>' +
    (vic ? '<th style="text-align:right" title="Percentual do volume intracraniano estimado (eTIV) — volume normalizado pelo tamanho da cabeça">% VIC</th>' : '') + '</tr>'
  tbody.innerHTML = ''
  let lastGroup = null
  for (const r of s.rows) {
    if (r.group === 'fundo' || r.volMm3 <= 0) continue
    if (gsel && r.group !== gsel) continue
    if (filter && !r.ptName.toLowerCase().includes(filter) && !r.name.toLowerCase().includes(filter)) continue
    if (r.group !== lastGroup) {
      const tr = document.createElement('tr')
      tr.className = 'groupsep'
      tr.innerHTML = `<td colspan="${5 + (vic ? 1 : 0) + (suave ? 1 : 0)}">${GROUP_PT[r.group] || r.group}</td>`
      tbody.appendChild(tr)
      lastGroup = r.group
    }
    const tr = document.createElement('tr')
    const sw = colorOfIndex(r.index)
    tr.innerHTML = `<td>${sw ? `<i class="swatch" style="background:${sw}"></i>` : ''}${r.ptName}</td>` +
      `<td>${r.hemi || '—'}</td>` +
      `<td class="num">${Math.round(r.volMm3).toLocaleString('pt-BR')}</td>` +
      (suave ? `<td class="num" style="color:var(--muted)" title="${r.metodoVolume === 'suave-redistribuido' ? 'córtex suave redistribuído na proporção das parcelas' : ''}">${r.volHardMm3 != null ? Math.round(r.volHardMm3).toLocaleString('pt-BR') : '—'}</td>` : '') +
      `<td class="num">${r.pctBrain.toFixed(2)}</td>` +
      `<td class="num">${r.meanInt.toFixed(1)}</td>` +
      (vic ? `<td class="num">${(100 * r.volMm3 / vic).toFixed(3)}</td>` : '')
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
  // pares com referência do mesmo método primeiro (por |zIA|); depois os demais, por |IA|
  const anot = state.assimetria && state.assimetria.length ? state.assimetria : s.pairs
  const comRef = anot.filter(p => p.zIA != null).sort((a, b) => Math.abs(b.zIA) - Math.abs(a.zIA))
  const semRef = anot.filter(p => p.zIA == null).sort((a, b) => Math.abs(b.ai) - Math.abs(a.ai))
  const pairs = [...comRef, ...semRef].slice(0, 30)
  const el = $('ladder')
  if (!pairs.length) { el.innerHTML = '<p class="note">O modelo escolhido não separa hemisférios — sem pares para comparar.</p>'; return }
  const W = 860, rowH = 21, left = 245, right = 112
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
    // cor só com referência do mesmo método (|zIA| ≥ 2); sem referência, o IA é descritivo
    const aiTxt = (p.ai > 0 ? '+' : '') + p.ai.toFixed(1) + '%' + (p.zIA != null ? ` z${fmtZs(p.zIA, 1)}` : '')
    const tip = p.zIA != null ? `IA esperado ${p.iaMedia.toFixed(1)} ± ${p.iaDp.toFixed(1)}% (controles do mesmo método)` : 'sem referência do mesmo método: IA descritivo'
    svg += `<text x="${W - 4}" y="${y + 9}" text-anchor="end" font-family="JetBrains Mono,monospace" font-size="10" fill="${p.zIA != null && Math.abs(p.zIA) >= 2 ? 'var(--accent-strong)' : 'var(--dim)'}"><title>${escapeXml(tip)}</title>${aiTxt}</text>`
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
    atualizarAlertas()
    return
  }
  try {
    await loadNorms()
    atualizarRecentragem()
    atualizarCalibracao() // a calibração depende do modo (com/sem recentragem)
    state.norms = compareToNorms(state.stats, { age, sex }, normOpts())
    renderNorms()
    if (state.norms.flags.length) {
      const worst = state.norms.flags[0]
      log(`QC normativo: ${state.norms.flags.length} região(ões) com |z| ≥ 3 — pior: ${worst.pt} (z ${worst.z.toFixed(1)})${Math.abs(worst.z) >= 4 ? ' — possível ERRO DE SEGMENTAÇÃO' : ''}`, Math.abs(worst.z) >= 4 ? 'err' : '')
    }
  } catch (e) {
    log('Normativo indisponível: ' + e.message, 'err')
  }
  atualizarAlertas()
}

// ---------- alertas de QC (regras declarativas) ----------
function atualizarAlertas () {
  if (!state.stats) { state.alertasQC = []; state.hoc = null; state.assimetria = null; renderAlertas(); return }
  const idade = parseFloat($('age').value)
  state.hoc = ocupacaoHipocampal(state.stats)
  // HOC contra controles do mesmo método (quando há referência e idade)
  for (const lado of Object.keys(state.hoc)) {
    const zh = idade > 0 ? zHoc(state.hoc[lado].hoc, lado, idade) : null
    if (zh) Object.assign(state.hoc[lado], { z: zh.z, esperado: zh.media, dp: zh.dp })
  }
  // z do índice de assimetria contra controles medidos com o MESMO método (quando há referência)
  state.assimetria = anotarAssimetria(state.stats.pairs, idade > 0 ? idade : null)
  state.alertasQC = state.regrasQC
    ? avaliarRegras(state.regrasQC, {
      idade: idade > 0 ? idade : null,
      sexo: $('sex').value || null,
      normas: state.norms && state.norms.available ? state.norms : null,
      stats: state.stats,
      qc: state.qc,
      icv: state.icv,
      hoc: state.hoc,
      assimetria: state.assimetria || [],
      aquisicao: aquisicaoMeta()
    })
    : []
  renderAlertas()
  if ($('ladder') && state.stats.pairs) renderLadder()
  for (const a of state.alertasQC.filter(x => x.severidade !== 'info')) log(`Alerta de QC — ${a.titulo}: ${a.mensagem}`, a.severidade === 'alerta' ? 'err' : '')
}

function renderAlertas () {
  const ul = $('alertas-list')
  if (!ul) return
  const al = state.alertasQC || []
  $('alertas-panel').hidden = !state.stats
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const hoc = state.hoc || {}
  const hocTxt = ['E', 'D'].filter(l => hoc[l]).map(l => `${l} ${hoc[l].hoc.toFixed(2).replace('.', ',')}` + (hoc[l].z != null ? ` (z ${fmtZs(hoc[l].z, 1)})` : '')).join(' · ')
  const hocRef = ['E', 'D'].some(l => hoc[l] && hoc[l].z != null)
  ul.innerHTML = (al.length
    ? al.map(a => `<li class="al-${a.severidade}"><b>${esc(a.titulo)}</b> — ${esc(a.mensagem)}<br><span>${esc(a.recomendacao)}</span> <i>(${esc(a.status)})</i></li>`).join('')
    : '<li class="al-ok">Nenhuma regra disparada.</li>') +
    (hocTxt ? `<li class="al-info">Ocupação hipocampal (HOC = hipocampo ÷ [hipocampo + corno temporal]): ${hocTxt} — ${hocRef ? 'z contra controles do DLBS medidos com o mesmo SynthSeg, por idade' : 'descritiva (sem idade ou sem a referência do mesmo método)'}.</li>` : '')
}

// cortes automáticos para a inspeção guiada: um plano por vez, mira no ponto RAS do alvo,
// com a segmentação sobreposta; restaura o tipo de corte e a mira no fim
async function capturarCortes (alvos) {
  const nv = state.nv
  if (!nv || !state.conformed || !state.seg || !alvos.length) return []
  const out = []
  const mira = nv.scene && nv.scene.crosshairPos ? Array.from(nv.scene.crosshairPos) : null
  try {
    if (nv.volumes.length < 2) await viewDeliverable('seg', 'segmentação')
    for (const a of alvos) {
      try {
        nv.setSliceType(a.plano === 'coronal' ? nv.sliceTypeCoronal : a.plano === 'sagital' ? nv.sliceTypeSagittal : nv.sliceTypeAxial)
        nv.scene.crosshairPos = nv.mm2frac(a.mm)
        nv.drawScene()
        await new Promise(r => requestAnimationFrame(() => r()))
        nv.drawScene()
        const url = nv.canvas.toDataURL('image/jpeg', 0.88)
        const bin = atob(url.split(',')[1])
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        out.push({ bytes, w: nv.canvas.width, h: nv.canvas.height, legenda: a.legenda })
      } catch { /* corte fora do volume */ }
    }
  } finally {
    try {
      applySliceType()
      if (mira) nv.scene.crosshairPos = mira
      nv.drawScene()
    } catch { /* visualizador indisponível */ }
  }
  return out
}

// opções da comparação normativa: proveniência da medida do paciente, recentragem pelo método
// (nível A, se ligada) e calibração de sítio (nível C, se houver para o protocolo do exame)
function normOpts () {
  return {
    ferramentaPaciente: state.modelUsed || null,
    metodoVolume: state.stats && state.stats.volumeSoft ? 'suave' : 'rígido',
    recentragem: state.recentragemAtiva ? state.recentragem : null,
    calibracao: state.calibracao || null
  }
}

// z com sinal explícito (− tipográfico); d casas decimais
function fmtZs (z, d = 2) { return z == null || !isFinite(z) ? '—' : Math.abs(z) < 0.5 * 10 ** -d ? (0).toFixed(d) : (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(d) }

function renderNorms () {
  const n = state.norms
  if (!n || !n.available) { $('norm-panel').hidden = true; return }
  $('norm-panel').hidden = false
  const thead = $('norm-table').querySelector('thead')
  const tbody = $('norm-table').querySelector('tbody')
  thead.innerHTML = '<tr><th>Medida</th><th style="text-align:right">cm³</th><th style="text-align:right">P</th><th style="text-align:right">z</th><th style="text-align:right" title="Intervalo de 90% do z: erro de medida (teste-reteste publicado; entre scanners se o sítio não está calibrado) + recentragem + calibração. Não inclui a incerteza do próprio modelo normativo.">IC 90%</th><th></th></tr>'
  tbody.innerHTML = ''
  const sub = n.subcorticais || []
  const pv = n.proveniencia || {}
  const rows = [{ sep: 'Globais — BrainChart', selo: seloNorma(pv.brainchart, pv) }, ...n.globals,
    ...(sub.length ? [{ sep: 'Subcorticais — CentileBrain (por hemisfério)', selo: seloNorma(pv.centilebrain, pv) }] : []), ...sub]
  for (const g of rows) {
    const tr = document.createElement('tr')
    if (g.sep) {
      tr.innerHTML = `<td colspan="6" style="color:var(--muted);font-family:var(--mono);font-size:10.5px;padding-top:8px" title="${g.selo || ''}">${g.sep}</td>`
      tbody.appendChild(tr)
      continue
    }
    const flagTxt = g.flag === 'erro?' ? '⚠ erro?' : g.flag === 'atipico' ? '· atípico' : ''
    const marca = (g.holm ? ' *' : '') + (g.preEspecificada ? ' •' : '')
    // idade na borda da norma: z em cinza (estimativa instável)
    const cinza = g.extrapolacao ? 'color:var(--muted)' : ''
    const inc = g.incerteza
    tr.title = [g.extrapolacao ? (g.recentrado && g.recentrado.foraDaFaixa ? 'idade fora da faixa em que a recentragem foi ajustada — z instável' : 'idade na borda/fora da faixa da norma — z instável') : '', g.holm ? 'significativo após correção de Holm (α 5%)' : '', g.preEspecificada ? 'estrutura pré-especificada' : '', g.calibrado ? `calibrado (n = ${g.calibrado.n})` : '', g.recentrado ? `z recentrado pelo método (controles do mesmo método ficam em z ${fmtZs(g.recentrado.desloc)} nesta idade; z sem recentragem ${fmtZs(g.zBruto)})` : '',
      inc ? `IC 90%: medida ±${(1.645 * inc.medida).toFixed(2)} (${inc.entreScanners ? 'entre scanners' : 'mesmo scanner'}; ${inc.fonteMedida}${inc.aproximado ? ', aproximado' : ''})` + (inc.recentragem ? `, recentragem ±${(1.645 * inc.recentragem).toFixed(2)}` : '') + (inc.calibracao ? `, calibração ±${(1.645 * inc.calibracao).toFixed(2)}` : '') : ''].filter(Boolean).join(' · ')
    tr.innerHTML = `<td>${g.pt}${marca}</td>` +
      `<td class="num">${(g.value / 1000).toFixed(1)}</td>` +
      `<td class="num" style="${cinza}">${formatPercentil(g.percentile)}</td>` +
      `<td class="num" style="${cinza}">${g.z != null ? fmtZs(g.z) : '—'}</td>` +
      `<td class="num" style="color:var(--muted);font-size:10.5px">${g.ic90 ? `${fmtZs(g.ic90[0], 1)} a ${fmtZs(g.ic90[1], 1)}` : '—'}</td>` +
      `<td style="color:${g.flag === 'erro?' ? 'var(--accent-strong)' : 'var(--warn)'};font-family:var(--mono);font-size:10.5px">${flagTxt}</td>`
    tbody.appendChild(tr)
  }
  const note = $('norm-sub-note')
  if (note) {
    const m = n.multiplicidade
    const partes = []
    if (m && m.m) {
      partes.push(`${m.m} medidas comparadas: por acaso, espera-se ~${m.esperadoAbs2.toFixed(1).replace('.', ',')} com |z| > 2; observadas ${m.observadoAbs2}. Após a correção de Holm (α 5%, *), ${m.holmSignificativos} permanece(m). • = pré-especificada.`)
      if (m.observadoAbs2 >= 3 && m.observadoAbs2 > 3 * m.esperadoAbs2 && (m.fracPositivos > 0.8 || m.fracPositivos < 0.2)) {
        partes.push(`Desvios em bloco (${Math.round(100 * (m.fracPositivos > 0.5 ? m.fracPositivos : 1 - m.fracPositivos))}% no mesmo sentido): padrão típico de viés de medida/norma ou de sítio não calibrado, não de biologia.`)
      }
    }
    partes.push('As normas são de volumes FreeSurfer; o paciente é medido com outra ferramenta — sem a recentragem pelo método (controles do mesmo SynthSeg) ou a calibração do sítio, os z podem ter viés sistemático. z em cinza: idade na borda da norma. IC 90%: erro de medida (entre scanners enquanto o sítio não estiver calibrado) + recentragem + calibração; não inclui a incerteza do próprio modelo normativo.')
    note.hidden = false
    note.textContent = partes.join(' ')
  }
}

// fontes do laudo PDF (Inter, SIL OFL; subconjunto latino com algarismos tabulares e
// kerning — ver tools/inter_subset.py). Falhou (offline sem cache)? O PDF usa Helvetica.
let reportFontsP = null
function loadReportFonts () {
  if (!reportFontsP) {
    const base = './fonts/inter/'
    reportFontsP = Promise.all([
      ...[400, 600, 700].map(w => fetch(`${base}Inter-${w}.ttf`).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer() })),
      fetch(base + 'kern.json').then(r => r.ok ? r.json() : null).catch(() => null)
    ]).then(([r, sb, b, k]) => ({ 400: r, 600: sb, 700: b, kern: k ? k.pares : null }))
      .catch(e => { log('Fontes do laudo indisponíveis — o PDF usa Helvetica: ' + e.message); reportFontsP = null; return null })
  }
  return reportFontsP
}

function escapeXml (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// ---------- exportações ----------
// parâmetros de aquisição lidos do cabeçalho (nenhum identificador, nenhuma data)
function aquisicaoMeta () {
  const sc = state.sidecar || {}
  const ms = (v, d) => v != null && isFinite(v) ? +(v * 1000).toFixed(d) : null
  return {
    fabricante: sc.Manufacturer || null,
    modelo: sc.ManufacturersModelName || null,
    campoT: sc.MagneticFieldStrength || null,
    serie: sc.SeriesDescription || sc.ProtocolName || null,
    sequencia: sc.SequenceName || sc.ScanningSequence || null,
    tipoAquisicao: sc.MRAcquisitionType || null,
    trMs: ms(sc.RepetitionTime, 1), teMs: ms(sc.EchoTime, 2), tiMs: ms(sc.InversionTime, 0),
    anguloGraus: sc.FlipAngle || null,
    software: sc.SoftwareVersions || null,
    correcaoDistorcao: sc.CorrecaoDistorcao || (state.sidecar ? correcaoDistorcao(sc) : 'não verificado (entrada sem cabeçalho DICOM)'),
    voxelMm: state.quality ? state.quality.voxel.map(v => +v.toFixed(3)) : null
  }
}

// componentes que produziram este resultado, com o SHA-256 do manifesto
function reprodutibilidadeMeta () {
  const comp = (state.manifesto && state.manifesto.componentes) || {}
  const usados = []
  const add = (k) => { if (comp[k]) usados.push({ nome: k, descricao: comp[k].descricao, sha256: comp[k].sha256 }) }
  const modelo = state.modelUsed || ''
  if (/SynthSeg/i.test(modelo)) add('synthseg1')
  if (/FastSurfer/i.test(modelo)) add('fastsurfer')
  if (state.synthsr) add('synthsr')
  if (state.norms && state.norms.available) { add('normas_brainchart'); if (state.norms.subcorticais) add('normas_centilebrain') }
  if (state.icv) add('vic_template')
  if (state.norms && state.norms.available) {
    if (state.recentragemAtiva) add('recentragem')
    if (state.norms.globals.some(g => g.ic90) || (state.norms.subcorticais || []).some(g => g.ic90)) add('erro_medida')
  }
  if ((state.assimetria || []).some(p => p.zIA != null)) add('referencia_mesmo_metodo')
  if (state.regrasQC) add('regras_qc')
  return {
    versaoApp: VERSION,
    manifestoGerado: state.manifesto ? state.manifesto.gerado : null,
    componentes: usados,
    nota: usados.length ? null : 'manifesto de hashes indisponível nesta sessão'
  }
}

// referência de assimetria usada (fonte, n, faixa etária) — sem os coeficientes
function referenciaAssimetriaMeta () {
  const r = referenciaAssimetria()
  return r ? { fonte: r.fonte, fonteCurta: r.fonteCurta || null, metodo: r.metodo, n: r.n, idadeFaixa: r.idadeFaixa, versao: r.versao } : null
}

function metaNow () {
  return {
    tool: 'SegmentaRM',
    version: VERSION,
    idadeFonte: state.idadeFonte || null,
    controle: !!($('coorte-controle') && $('coorte-controle').checked),
    alertasQC: state.alertasQC || [],
    hoc: state.hoc || null,
    assimetria: state.assimetria || null,
    refAssimetria: referenciaAssimetriaMeta(),
    aquisicao: aquisicaoMeta(),
    protocolo: state.protocolo || null,
    reprodutibilidade: reprodutibilidadeMeta(),
    subject: $('subject').value || ($('stage-title').textContent || 'exame'),
    age: parseFloat($('age').value) || null,
    sex: $('sex').value || null,
    norms: state.norms,
    icv: state.icv || null,
    date: new Date().toISOString().slice(0, 10),
    input: state.inputDesc,
    quality: state.quality,
    pipeline: state.pipelineUsed,
    model: state.modelUsed,
    qc: state.qc ? { resumo: state.qc.resumo, grupos: state.qc.grupos } : null,
    espessura: THICK_EXPORT && state.thick
      ? {
          metodo: state.thick.metodo,
          hemisferios: state.thick.hemisferios,
          regioes: state.thick.regioes.map(r => ({ ...r, pt: ptNameOf(r.name) })),
          qc: state.thick.qc
        }
      : null,
    surf: SURF_EXPORT && state.surf
      ? {
          regioes: state.surf.stats,
          motorSdf: state.surf.motor || null,
          euler: state.surf.euler || null,
          talairachRotulos: state.surf.talairachRotulos || 0,
          fluxo: 'recon-all-clinical (navegador): máscaras wm.seg/filled → SDFs white/pial → colocação Eq. 5 (λ1=6e-4, λ2=2e-4, nsmooth 5) → Fischl–Dale (teto 5 mm); sem mris_fix_topology/sphere.reg (χ de Euler relatado como QC; parcelas por amostragem volumétrica)'
        }
      : null,
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
      'Modelos treinados em T1; sequências T2/FLAIR degradam o resultado.',
      ...(THICK_EXPORT && state.thick ? [AVISO_ESPESSURA] : [])
    ]
  }
}

function saveBlob (data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.hidden = true
  document.body.appendChild(a) // Firefox/Safari antigos ignoram click() em âncora solta
  a.click()
  a.remove()
  // 4 s era pouco para o Safari/Firefox começarem a gravar pacotes de centenas de MB
  setTimeout(() => URL.revokeObjectURL(a.href), 60000)
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
    pdf: async () => {
      const snapshot = await snapshotJpeg()
      // inspeção guiada: cortes pelas estruturas envolvidas nos alertas que pedem captura
      const alvos = alvosDeCaptura(state.alertasQC || [], state.stats)
      const imagens = alvos.length ? await capturarCortes(alvos) : []
      return buildReport({ stats: state.stats, meta: { ...meta, inspecao: { alertas: state.alertasQC || [], imagens, hoc: state.hoc || null } }, snapshot, fonts: await loadReportFonts() })
    },
    niiSeg: async () => {
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'uint8', description: 'segmentarm ' + meta.model.slice(0, 40) }, state.seg)
      return await gzipBuffer(buf)
    },
    niiConf: async () => {
      if (!state.conformed) return null
      const img0 = state.conformed.img
      const img = (img0 instanceof Uint8Array || img0 instanceof Int16Array || img0 instanceof Float32Array) ? img0 : Float32Array.from(img0)
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: datatypeOf(img), description: 'segmentarm imagem de análise' }, img)
      return await gzipBuffer(buf)
    },
    niiNative: async () => state.native ? await gzipBuffer(state.native.buf) : null,
    niiSynthsr: async () => state.synthsr ? await gzipBuffer(state.synthsr.buf) : null,
    niiNorm: async () => {
      if (!SURF_EXPORT || !state.surf || !state.surf.norm) return null
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'float32', description: 'segmentarm norm sintetico recon-clinical' }, state.surf.norm)
      return await gzipBuffer(buf)
    },
    xfm: () => SURF_EXPORT && state.surf && state.surf.xfm ? state.surf.xfm : null,
    qcCsv: () => state.qc ? qcToCSV(state.qc, meta, dec) : null,
    // mapa de confiança: chave própria — antes repetia "niiConf" e sobrescrevia o
    // exportador do volume conformado (o botão "Conformado" baixava a confiança)
    niiConfMap: async () => {
      if (!state.segConf) return null
      const buf = writeNifti({ dims: dimsOf(state.conformed), pixDims: pixDimsOf(state.conformed), affine: affineOf(state.conformed), datatype: 'uint8', description: 'segmentarm confianca da rede 0-255' }, state.segConf)
      return await gzipBuffer(buf)
    },
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
  if (!state.stats && !['nii-conf', 'nii-confmap', 'nii-native', 'nii-synthsr', 'nii-mask', 'nii-brain', 'nii-norm', 'xfm', 'qc-csv', 'errlog'].includes(kind) && !kind.startsWith('cohort')) {
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
      case 'nii-conf': {
        const b = await ex.niiConf()
        if (b) saveBlob(b, `${sub}_conformado.nii.gz`)
        else log('Sem volume conformado — rode a segmentação (passo 03).', 'err')
        break
      }
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
      case 'nii-norm': {
        const b = await ex.niiNorm()
        if (b) saveBlob(b, `${sub}_norm_sintetico.nii.gz`)
        else log('Sem norm sintético — rode o passo 05 (superfícies).', 'err')
        break
      }
      case 'xfm': {
        const b = ex.xfm()
        if (b) saveBlob(b, `${sub}_talairach.xfm`, 'text/plain;charset=utf-8')
        else log('Sem transformada de Talairach — rode o passo 05 (superfícies).', 'err')
        break
      }
      case 'qc-csv': {
        const b = ex.qcCsv()
        if (b) saveBlob(b, `${sub}_qc.csv`, 'text/csv;charset=utf-8')
        else log('Sem QC — rode a segmentação primeiro.', 'err')
        break
      }
      case 'nii-confmap': {
        const b = await ex.niiConfMap()
        if (b) saveBlob(b, `${sub}_confianca.nii.gz`)
        else log('Sem mapa de confiança — a rede usada não devolve posteriores (só o SynthSeg).', 'err')
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
        if (SURF_EXPORT && state.surf) {
          for (const m of state.surf.meshes) files.push({ name: `${sub}_${m.name}.mz3`, data: new Uint8Array(m.mz3) })
          if (state.surf.xfm) files.push({ name: `${sub}_talairach.xfm`, data: new TextEncoder().encode(state.surf.xfm) })
          if (state.surf.norm) files.push({ name: `${sub}_norm_sintetico.nii.gz`, data: new Uint8Array(await ex.niiNorm()) })
        }
        if (state.qc) files.push({ name: `${sub}_qc.csv`, data: ex.qcCsv() })
        if (state.segConf) files.push({ name: `${sub}_confianca.nii.gz`, data: new Uint8Array(await ex.niiConfMap()) })
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
        log(`Exame "${row.subject}" adicionado à coorte (${state.cohort.length})${row.controle ? ' como CONTROLE para a calibração do sítio' : ''}.`, 'ok')
        if ($('coorte-controle')) $('coorte-controle').checked = false
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

// ---------- recentragem pelo método (nível A) ----------
// os coeficientes (models/normative/recentragem_synthseg.json) vêm de controles saudáveis medidos
// com o MESMO SynthSeg do app (volume suave); só valem para essa medida
async function carregarRecentragem () {
  try {
    const r = await fetch('./models/normative/recentragem_synthseg.json')
    if (!r.ok) return
    state.recentragem = await r.json()
    let pref = null
    try { pref = localStorage.getItem('segmentarm_recentragem_ativa') } catch { /* modo privado */ }
    state.recentragemPreferida = pref == null ? !!state.recentragem.ativoPorPadrao : pref === '1'
    const cb = $('opt-recentragem')
    if (cb) {
      $('recentragem-wrap').hidden = false
      cb.checked = state.recentragemPreferida
      cb.onchange = () => {
        state.recentragemPreferida = cb.checked
        try { localStorage.setItem('segmentarm_recentragem_ativa', cb.checked ? '1' : '0') } catch { /* modo privado */ }
        atualizarRecentragem()
        atualizarCalibracao()
        updateNorms()
      }
    }
    atualizarRecentragem()
  } catch { /* sem recentragem: z crus contra as normas */ }
}

// a recentragem só se aplica quando a medida do paciente é a mesma dos controles de referência
function atualizarRecentragem () {
  const t = state.recentragem
  const origemOk = !!(t && state.stats && state.stats.volumeSoft && /SynthSeg/i.test(state.modelUsed || ''))
  state.recentragemAtiva = !!(t && state.recentragemPreferida && origemOk)
  const wrap = $('recentragem-wrap')
  if (wrap && t) wrap.title = `${t.fonte || ''} — n = ${t.n || '?'}; idades ${(t.idadeFaixa || []).join('–')}. ${t.metodo || ''}` + (origemOk ? '' : ' · indisponível para esta segmentação (só SynthSeg com volume suave)')
}

// ---------- calibração do sítio (nível C) ----------
function controlesDoProtocolo () {
  const fam = state.protocolo && state.protocolo.familia
  if (!fam) return []
  return state.cohort.map(e => e.row).filter(r => +r.controle === 1 && r.protocolo_familia === fam)
}

// escolhe a calibração deste protocolo (no mesmo modo — com ou sem recentragem) e atualiza o painel
function atualizarCalibracao () {
  const fam = state.protocolo && state.protocolo.familia
  state.calibracao = calibracaoPara(fam, state.recentragemAtiva ? state.recentragem : null)
  const el = $('calib-status')
  if (!el) return
  const n = controlesDoProtocolo().length
  $('calib-calcular').disabled = !fam || n < N_MIN_DESLOCAMENTO
  $('calib-exportar').disabled = !Object.keys(lerCalibracoes()).length
  if (!fam) { el.textContent = 'Sem exame carregado.'; return }
  const c = state.calibracao
  el.textContent = `Protocolo deste exame: ${state.protocolo.familiaTxt} (família ${fam}). Controles deste protocolo na coorte: ${n}` +
    (n < N_MIN_DESLOCAMENTO ? ` (mínimo ${N_MIN_DESLOCAMENTO}).` : '.') +
    (c ? ` Calibração ativa: n = ${c.n} (${c.n >= N_MIN_ESCALA ? 'deslocamento + escala' : 'só deslocamento'}), criada em ${c.criada}.` + resumoControles(c)
      : calibracaoDesatualizada(fam, state.recentragemAtiva ? state.recentragem : null) ? ' A calibração guardada foi feita com outra versão da recentragem pelo método — recalcule-a com os controles.'
        : ' Sem calibração: os z deste exame saem com o selo "não calibrado para este sítio".') +
    (state.protocolo.semDicom ? ' Atenção: entrada sem cabeçalho DICOM — o protocolo não pôde ser identificado.' : '')
}

// checagem da calibração: z dos controles locais contra a norma, ANTES do ajuste (média ~0 e
// DP ~1 = sítio compatível com a norma; |r| com a idade alto = deslocamento que muda com a idade)
function resumoControles (c) {
  const es = Object.values(c.estruturas || {}).filter(e => e && isFinite(e.media))
  if (!es.length) return ''
  const f = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace('.', ',')
  const med = es.map(e => e.media); const dps = es.map(e => e.dp).filter(isFinite)
  const rs = es.map(e => Math.abs(e.corrIdade)).filter(isFinite)
  return ` Controles × norma antes do ajuste (${es.length} medidas): z médio de ${f(Math.min(...med))} a ${f(Math.max(...med))}` +
    (dps.length ? `; DP de ${Math.min(...dps).toFixed(2).replace('.', ',')} a ${Math.max(...dps).toFixed(2).replace('.', ',')}` : '') +
    (rs.length ? `; |r| com a idade até ${Math.max(...rs).toFixed(2).replace('.', ',')}` : '') + '.'
}

function calcularCalibracaoSitio () {
  const linhas = controlesDoProtocolo()
  if (linhas.length < N_MIN_DESLOCAMENTO) { log(`Calibração: são necessários ≥ ${N_MIN_DESLOCAMENTO} controles deste protocolo na coorte (há ${linhas.length}).`, 'err'); return }
  const cal = calcularCalibracao(linhas, { protocolo: state.protocolo, recentragem: state.recentragemAtiva ? state.recentragem : null })
  salvarCalibracao(cal)
  log(`Calibração do sítio calculada com ${cal.n} controles (${cal.n >= N_MIN_ESCALA ? 'deslocamento + escala' : 'só deslocamento'}).` + (cal.avisos.length ? ' Avisos: ' + cal.avisos.join(' ') : ''), 'ok')
  atualizarCalibracao()
  updateNorms()
}

function cohortCSV () {
  const dec = $('decimal').value
  const sep = dec === ',' ? ';' : ','
  const keys = []
  const seen = new Set()
  for (const e of state.cohort) for (const k of Object.keys(e.row)) if (!seen.has(k)) { seen.add(k); keys.push(k) }
  const q = (v) => { const t = String(v); return /[";\r\n,]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t }
  const fmt = (v) => typeof v === 'number' ? (Number.isFinite(v) ? (dec === ',' ? v.toFixed(2).replace('.', ',') : v.toFixed(2)) : '') : (v == null ? '' : q(v))
  const lines = [keys.map(q).join(sep)]
  for (const e of state.cohort) lines.push(keys.map(k => fmt(e.row[k])).join(sep))
  // BOM: sem ele o Excel pt-BR lê UTF-8 como Latin-1 e estraga os acentos
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

function persistCohort () {
  try { localStorage.setItem('segmentarm_cohort_v1', JSON.stringify(state.cohort)) } catch { /* modo privado */ }
}
function renderCohort () {
  const n = state.cohort.length
  const nc = state.cohort.filter(e => +e.row.controle === 1).length
  $('queue').textContent = n ? `${n} exame(s) na coorte${nc ? ` (${nc} controle(s))` : ''}: ${state.cohort.map(e => e.row.subject + (+e.row.controle === 1 ? ' [controle]' : '')).join(', ')}` : 'Coorte vazia.'
  try { atualizarCalibracao() } catch { /* painel ainda não montado */ }
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
  // NIfTI avulso: o seletor de séries DICOM anterior não vale mais
  const hideSeries = () => { $('series-field').hidden = true; $('series').onchange = null }
  $('file-nifti').onchange = async (e) => {
    const input = e.target
    if (!input.files.length) return
    const f = input.files[0]
    input.value = '' // permite reabrir o MESMO arquivo (sem isso o change não dispara)
    if (refuseWhileBusy()) return
    try { hideSeries(); await loadVolumeFile(f, null, `NIfTI ${f.name}`) } catch (err) { log('Erro ao carregar: ' + err.message, 'err'); progress(0) }
  }
  $('file-dicom').onchange = async (e) => {
    const input = e.target
    if (!input.files.length) return
    const files = Array.from(input.files)
    input.value = ''
    try {
      await handleDicomInput(files)
    } catch (err) { log('Erro na conversão DICOM: ' + err.message, 'err'); progress(0) }
  }
  ;['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') }))
  ;['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over') }))
  // depois do primeiro exame a zona de soltura some: soltar um arquivo em qualquer
  // lugar da página fazia o navegador abri-lo/baixá-lo (perdendo a sessão) —
  // a janela inteira passa a aceitar a soltura
  window.addEventListener('dragover', (e) => { e.preventDefault() })
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!drop.contains(e.target)) handleDrop(e) // a zona tem o próprio ouvinte
  })
  drop.addEventListener('drop', handleDrop)
  async function handleDrop (e) {
    e.preventDefault()
    if (refuseWhileBusy()) return
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
      // as entradas têm de ser obtidas TODAS antes do primeiro await: depois do
      // despacho do evento os DataTransferItem ficam inválidos (só o 1º item vingava)
      const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean)
      const loose = entries.length ? [] : [...(e.dataTransfer.files || [])]
      for (const entry of entries) await walk(entry, '')
      files.push(...loose)
      if (!files.length) return
      const niiFile = files.find(f => /\.nii(\.gz)?$/i.test(f.name))
      if (files.length === 1 && niiFile) {
        hideSeries()
        await loadVolumeFile(niiFile, null, `NIfTI ${niiFile.name}`)
      } else {
        await handleDicomInput(files)
      }
    } catch (err) { log('Erro na entrada: ' + err.message, 'err'); progress(0) }
  }

  $('load-example').onclick = async () => {
    if (refuseWhileBusy()) return
    try {
      log('Baixando o exame de exemplo (T1 real, 3 MB)…')
      const resp = await fetch('./example/t1_exemplo.nii.gz')
      if (!resp.ok) throw new Error(`exemplo indisponível (HTTP ${resp.status})`)
      const blob = await resp.blob()
      hideSeries()
      const f = new File([blob], 't1_exemplo.nii.gz')
      if (!$('subject').value) $('subject').value = 'EXEMPLO-T1'
      await loadVolumeFile(f, { SeriesDescription: 'T1 MPRAGE exemplo (brain2print)' }, 'Exemplo T1 volumétrico')
    } catch (err) { log('Erro no exemplo: ' + err.message, 'err') }
  }

  $('run').onclick = runSegmentation
  $('cancel').onclick = () => {
    if (state.clinicalChain) state.chainCancelled = true
    if (cancelJobs()) log('Cancelando a etapa em execução — o worker foi encerrado e a memória dele liberada.', 'err')
    else if (state.running) log('Cancelamento pedido — a etapa para ao iniciar a próxima rede (o trecho atual roda na thread principal).', 'err')
  }
  $('run-clinical').onclick = runReconClinical
  $('run-dkt').onclick = runDktStep
  $('run-surf').onclick = runSurfStep
  $('show-surf').onchange = () => showSurfaces($('show-surf').checked)
  if ($('surf-show-kind')) $('surf-show-kind').onchange = () => { if ($('show-surf').checked) showSurfaces(true) }
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
  $('age').onchange = () => { state.idadeFonte = 'digitada pelo usuário'; updateNorms() }
  if ($('calib-calcular')) $('calib-calcular').onclick = calcularCalibracaoSitio
  if ($('calib-exportar')) {
    $('calib-exportar').onclick = () => {
      const blob = new Blob([JSON.stringify(lerCalibracoes(), null, 1)], { type: 'application/json' })
      saveBlob(blob, 'segmentarm_calibracoes_sitio.json', 'application/json')
    }
  }
  if ($('calib-importar')) {
    $('calib-importar').onchange = async (ev) => {
      const f = ev.target.files && ev.target.files[0]
      if (!f) return
      try {
        const k = importarCalibracoes(JSON.parse(await f.text()))
        log(`Calibrações importadas: ${k}.`, k ? 'ok' : 'err')
        atualizarCalibracao()
        updateNorms()
      } catch (e) { log('Arquivo de calibração inválido: ' + e.message, 'err') }
      ev.target.value = ''
    }
  }
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

// ---------- layout ajustável: divisores, painel ampliado, seções recolhíveis ----------
// As larguras ficam em --rail / --inspector no .app e são salvas no navegador (só as
// preferências de tela — nenhum dado de exame). O NiiVue observa o tamanho do canvas e
// se redesenha sozinho.
const LAYOUT_KEY = 'segmentarm-layout-v1'
function readLayout () { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {} } catch { return {} } }
function writeLayout (o) { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(o)) } catch { /* armazenamento indisponível */ } }
function initLayout () {
  const app = document.querySelector('.app')
  if (!app) return
  const lay = readLayout()
  const VIEW_MIN = 320 // o visualizador nunca some por arraste
  const limits = {
    rail: () => [200, Math.max(200, Math.min(560, window.innerWidth - VIEW_MIN - (lay.insp || 400) - 12))],
    insp: () => [300, Math.max(300, window.innerWidth - VIEW_MIN - (lay.rail || 268) - 12)]
  }
  const setVar = (side, px) => app.style.setProperty(side === 'rail' ? '--rail' : '--inspector', px + 'px')
  const apply = (side, px, save) => {
    const [lo, hi] = limits[side]()
    const v = Math.round(Math.min(hi, Math.max(lo, px)))
    lay[side] = v
    setVar(side, v)
    if (save) writeLayout(lay)
  }
  if (lay.rail) apply('rail', lay.rail, false)
  if (lay.insp) apply('insp', lay.insp, false)
  for (const [id, side] of [['split-rail', 'rail'], ['split-insp', 'insp']]) {
    const el = document.getElementById(id)
    if (!el) continue
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return
      ev.preventDefault()
      el.setPointerCapture(ev.pointerId)
      el.classList.add('dragging')
      document.body.classList.add('resizing')
      const box = app.getBoundingClientRect()
      const move = (e) => apply(side, side === 'rail' ? e.clientX - box.left - 3 : box.right - e.clientX - 3, false)
      const up = () => {
        el.removeEventListener('pointermove', move)
        el.classList.remove('dragging')
        document.body.classList.remove('resizing')
        writeLayout(lay)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up, { once: true })
      el.addEventListener('pointercancel', up, { once: true })
    })
    el.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 64 : 16
      const cur = lay[side] || (side === 'rail' ? 268 : 400)
      const grow = side === 'rail' ? ev.key === 'ArrowRight' : ev.key === 'ArrowLeft'
      const shrink = side === 'rail' ? ev.key === 'ArrowLeft' : ev.key === 'ArrowRight'
      if (grow || shrink) { ev.preventDefault(); apply(side, cur + (grow ? step : -step), true) }
    })
    el.addEventListener('dblclick', () => {
      delete lay[side]
      app.style.removeProperty(side === 'rail' ? '--rail' : '--inspector')
      writeLayout(lay)
    })
  }
  window.addEventListener('resize', () => {
    if (lay.rail) apply('rail', lay.rail, false)
    if (lay.insp) apply('insp', lay.insp, false)
  })

  // painel ampliado: cobre o visualizador; Esc volta
  const maxBtn = $('insp-max')
  const setMax = (on) => {
    app.classList.toggle('insp-max', on)
    if (maxBtn) { maxBtn.setAttribute('aria-pressed', String(on)); maxBtn.textContent = on ? 'Voltar ao visualizador' : 'Ampliar painel' }
  }
  if (maxBtn) maxBtn.onclick = () => setMax(!app.classList.contains('insp-max'))
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && app.classList.contains('insp-max') && !document.querySelector('dialog[open]')) setMax(false)
  })

  // seções recolhíveis: clique (ou Enter/Espaço) no título; estado salvo por seção
  const inspector = document.querySelector('.inspector')
  const keyOf = (panel) => panel.id || (panel.querySelector(':scope > h3') || {}).textContent || ''
  const collapsed = new Set(lay.collapsed || [])
  const heads = () => [...inspector.querySelectorAll('.panel > h3')]
  const setCollapsed = (panel, on, save = true) => {
    panel.classList.toggle('collapsed', on)
    const h = panel.querySelector(':scope > h3')
    if (h) h.setAttribute('aria-expanded', String(!on))
    const k = keyOf(panel).trim()
    if (on) collapsed.add(k); else collapsed.delete(k)
    if (save) { lay.collapsed = [...collapsed]; writeLayout(lay) }
  }
  for (const h of heads()) {
    h.setAttribute('role', 'button')
    h.setAttribute('tabindex', '0')
    h.setAttribute('aria-expanded', 'true')
    if (collapsed.has(keyOf(h.parentElement).trim())) setCollapsed(h.parentElement, true, false)
  }
  inspector.addEventListener('click', (ev) => {
    const h = ev.target.closest('.panel > h3')
    if (!h || ev.target.closest('button, a, select, input, label')) return
    setCollapsed(h.parentElement, !h.parentElement.classList.contains('collapsed'))
  })
  inspector.addEventListener('keydown', (ev) => {
    const h = ev.target.closest && ev.target.closest('.panel > h3')
    if (!h || (ev.key !== 'Enter' && ev.key !== ' ')) return
    ev.preventDefault()
    setCollapsed(h.parentElement, !h.parentElement.classList.contains('collapsed'))
  })
  const colBtn = $('insp-collapse')
  if (colBtn) {
    colBtn.onclick = () => {
      const all = heads().map(h => h.parentElement)
      const anyOpen = all.some(p => !p.classList.contains('collapsed'))
      for (const p of all) setCollapsed(p, anyOpen, false)
      lay.collapsed = [...collapsed]; writeLayout(lay)
      colBtn.textContent = anyOpen ? 'Abrir seções' : 'Recolher seções'
    }
  }
}

// ---------- arranque ----------
async function main () {
  deviceBadge()
  initLayout()
  await initViewer()
  armContextGuard()
  initWindowing()
  wireInputs()
  syncButtons()
  try {
    state.cohort = JSON.parse(localStorage.getItem('segmentarm_cohort_v1') || '[]')
  } catch { state.cohort = [] }
  renderCohort()
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
  window.__segrm = state // gancho de diagnóstico (console do navegador)
  // SHA-256 dos pesos e normas (tools/manifesto_sha256.mjs) — citados no laudo e no JSON
  fetch('./models/manifest-sha256.json').then(r => r.ok ? r.json() : null).then(m => { state.manifesto = m }).catch(() => {})
  fetch('./models/qc_rules.json').then(r => r.ok ? r.json() : null).then(m => { state.regrasQC = m }).catch(() => {})
  carregarAssimetria().then(() => { if (state.stats) atualizarAlertas() })
  carregarRecentragem()
  log('SegmentaRM ' + VERSION + ' pronto. Nenhuma imagem sai do dispositivo.')
}

main().catch(e => log('Falha na inicialização: ' + e.message, 'err'))
