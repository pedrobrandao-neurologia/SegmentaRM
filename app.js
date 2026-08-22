// app.js — orquestração da interface.

import { readNifti, writeNifti } from './lib/nifti.js';
import { groupSeries, buildVolume } from './lib/dicom.js';
import { conform, normalizeRobust } from './lib/resample.js';
import { Model, hasWebGPU, gpuLimits } from './lib/infer.js';
import { mergeSegmentations, computeStats, toCSV, toJSON, toWideTable } from './lib/stats.js';
import { statsToSav } from './lib/sav.js';
import { loadFreeSurferLUT, labelInfo, mirrorOf } from './lib/lut.js';
import { Ortho } from './lib/viewer.js';

const $ = (s) => document.querySelector(s);
const state = {
  volume: null, series: [], conformed: null, labels: null,
  stats: null, cohort: [], models: {}, viewer: null,
};

const SLOTS = [
  {
    id: 'main', title: 'Segmentação principal', required: true,
    hint: 'aseg + parcelação cortical (SynthSeg). Obrigatório.', task: 'segment', replaces: null,
  },
  {
    id: 'cerebellum', title: 'Cerebelo', required: false,
    hint: 'Subdivide o cerebelo. Substitui os rótulos 7, 8, 46 e 47.', task: 'segment', replaces: [7, 8, 46, 47],
  },
  {
    id: 'brainstem', title: 'Tronco encefálico', required: false,
    hint: 'Mesencéfalo, ponte, bulbo, PCS. Substitui o rótulo 16.', task: 'segment', replaces: [16],
  },
  {
    id: 'synthsr', title: 'Síntese T1 (SynthSR)', required: false,
    hint: 'Só para visualização; não entra no cálculo dos volumes.', task: 'regress', replaces: null,
  },
];

/* ------------------------------------------------------------------ log */
const logBox = $('#console');
function log(msg, kind = '') {
  const p = document.createElement('p');
  p.textContent = msg;
  if (kind) p.className = kind;
  logBox.append(p);
  logBox.scrollTop = logBox.scrollHeight;
}
function progress(frac) { $('#progress').style.width = `${Math.round((frac || 0) * 100)}%`; }

/* --------------------------------------------------------------- OPFS */
async function opfsDir() {
  if (!navigator.storage?.getDirectory) return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('models', { create: true });
  } catch { return null; }
}
async function opfsPut(name, data) {
  const dir = await opfsDir();
  if (!dir) return false;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
  return true;
}
async function opfsGet(name) {
  const dir = await opfsDir();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(name);
    return await fh.getFile();
  } catch { return null; }
}
async function opfsDelete(name) {
  const dir = await opfsDir();
  if (!dir) return;
  try { await dir.removeEntry(name); } catch { /* já não existe */ }
}

/* -------------------------------------------------------------- slots */
function renderSlots() {
  const host = $('#slots');
  host.innerHTML = '';
  for (const s of SLOTS) {
    const entry = state.models[s.id];
    const el = document.createElement('div');
    el.className = 'slot';
    el.innerHTML = `
      <header>
        <h3>${s.title}${s.required ? '' : ' <span style="color:var(--faint);font-weight:400">· opcional</span>'}</h3>
        <span class="state" data-on="${entry ? 1 : 0}">${entry ? 'pronto' : 'vazio'}</span>
      </header>
      <p>${entry ? `${entry.spec.name || s.id} · ${(entry.size / 1048576).toFixed(1)} MB` : s.hint}</p>
      <footer>
        <button class="btn small" data-add="${s.id}">${entry ? 'Substituir' : 'Adicionar'}</button>
        ${entry ? `<button class="btn small ghost" data-del="${s.id}">Remover</button>` : ''}
      </footer>`;
    host.append(el);
  }
  host.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => pickModel(b.dataset.add)));
  host.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.del;
    delete state.models[id];
    await opfsDelete(`${id}.onnx`);
    await opfsDelete(`${id}.json`);
    renderSlots(); refreshRun();
    log(`Modelo removido do slot "${id}".`);
  }));
}

function pickModel(slotId) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.multiple = true;
  inp.accept = '.onnx,.json';
  inp.addEventListener('change', () => registerModel(slotId, [...inp.files]));
  inp.click();
}

async function registerModel(slotId, files) {
  const onnx = files.find((f) => f.name.toLowerCase().endsWith('.onnx'));
  const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (!onnx) { log('Selecione o arquivo .onnx do modelo.', 'err'); return; }
  let spec = { name: onnx.name.replace(/\.onnx$/i, ''), layout: 'NDHWC', tile: 0, overlap: 16, labels: null };
  if (json) {
    try { spec = { ...spec, ...JSON.parse(await json.text()) }; }
    catch (e) { log(`Não consegui ler o .json do modelo: ${e.message}`, 'err'); return; }
  } else {
    log(`Sem .json para "${slotId}": usando NDHWC e canal = índice do rótulo. Se a saída vier errada, forneça o descritor.`, 'err');
  }
  const bytes = await onnx.arrayBuffer();
  const ok = await opfsPut(`${slotId}.onnx`, bytes);
  if (ok) await opfsPut(`${slotId}.json`, new Blob([JSON.stringify(spec)]));
  state.models[slotId] = { spec, bytes, size: bytes.byteLength, persisted: ok };
  renderSlots(); refreshRun();
  log(`Modelo "${spec.name}" registrado em "${slotId}"${ok ? ' e guardado no dispositivo' : ' (só nesta sessão)'}.`, 'ok');
}

async function restoreModels() {
  for (const s of SLOTS) {
    const f = await opfsGet(`${s.id}.onnx`);
    if (!f) continue;
    const j = await opfsGet(`${s.id}.json`);
    let spec = { name: s.id, layout: 'NDHWC', tile: 0, overlap: 16, labels: null };
    if (j) { try { spec = { ...spec, ...JSON.parse(await j.text()) }; } catch { /* mantém padrão */ } }
    state.models[s.id] = { spec, bytes: await f.arrayBuffer(), size: f.size, persisted: true };
  }
  renderSlots(); refreshRun();
}

/* -------------------------------------------------------------- entrada */
function markStep(id, done) { $(id).dataset.state = done ? 'done' : ''; }

function refreshRun() {
  const ready = !!state.volume && !!state.models.main;
  $('#run').disabled = !ready;
  markStep('#step-input', !!state.volume);
  markStep('#step-models', !!state.models.main);
}

async function loadNiftiFile(file) {
  log(`Lendo ${file.name}…`);
  try {
    const vol = await readNifti(await file.arrayBuffer());
    state.volume = vol;
    state.series = [];
    $('#series-field').hidden = true;
    if (!$('#subject').value) $('#subject').value = file.name.replace(/\.nii(\.gz)?$/i, '');
    log(`Volume ${vol.dims.join('×')} · ${vol.pixdim.map((p) => p.toFixed(2)).join('×')} mm`, 'ok');
    setStage(file.name, `${vol.dims.join(' × ')} voxels, ${vol.pixdim.map((p) => p.toFixed(2)).join(' × ')} mm.`);
    refreshRun();
  } catch (e) { log(e.message, 'err'); }
}

async function loadDicomFolder(files) {
  const dcm = files.filter((f) => f.size > 1000);
  log(`Lendo ${dcm.length} arquivos…`);
  try {
    const { series, compressedCount } = await groupSeries(dcm, (m, f) => { log(m); progress(f * 0.4); });
    if (compressedCount) {
      log(`${compressedCount} arquivos com pixel data comprimido foram ignorados. Converta com dcm2niix.`, 'err');
    }
    if (!series.length) { log('Nenhuma série DICOM legível nessa pasta.', 'err'); progress(0); return; }
    state.series = series;
    const sel = $('#series');
    sel.innerHTML = series
      .map((s, i) => `<option value="${i}">${s.number || '?'} · ${s.description} · ${s.files.length} cortes · ${s.modality}</option>`)
      .join('');
    $('#series-field').hidden = false;
    await selectSeries(0);
  } catch (e) { log(e.message, 'err'); progress(0); }
}

async function selectSeries(idx) {
  const serie = state.series[idx];
  if (!serie) return;
  log(`Montando a série "${serie.description}"…`);
  try {
    const vol = await buildVolume(serie, (m, f) => { log(m); progress(0.4 + f * 0.5); });
    state.volume = vol;
    if (!$('#subject').value) $('#subject').value = (serie.patientId || 'exame') + '_' + (serie.number || idx);
    log(`Volume ${vol.dims.join('×')} · ${vol.pixdim.map((p) => p.toFixed(2)).join('×')} mm`, 'ok');
    setStage(serie.description, `${vol.dims.join(' × ')} voxels, ${vol.pixdim.map((p) => p.toFixed(2)).join(' × ')} mm · ${serie.modality}.`);
    progress(0);
    refreshRun();
  } catch (e) { log(e.message, 'err'); progress(0); }
}

function setStage(title, lede) {
  $('#stage-title').textContent = title;
  $('#stage-lede').textContent = lede;
}

/* ------------------------------------------------------------ execução */
async function run() {
  const btn = $('#run');
  btn.disabled = true;
  const t0 = performance.now();
  try {
    const size = +$('#grid').value;
    const device = $('#device').value;
    const ortUrl = $('#ort-url').value.trim() || undefined;

    log(`Reamostrando para ${size}³ a 1 mm…`);
    const grid = conform(state.volume, { size, mm: 1 });
    const input = normalizeRobust(grid.data);
    state.conformed = grid;

    const specOf = (id) => ({ ...state.models[id].spec, tile: state.models[id].spec.tile || size });

    log('Carregando o modelo principal…');
    const main = await Model.create(specOf('main'), state.models.main.bytes, { device, ortUrl });
    log(`Executando em ${main.device.toUpperCase()}.`);
    let { labels } = await main.segment(input, grid.dims, (m, f) => { log(m); progress(f * 0.7); });

    for (const slot of SLOTS.filter((s) => s.task === 'segment' && s.id !== 'main')) {
      if (!state.models[slot.id]) continue;
      log(`Refinando: ${slot.title}…`);
      const m = await Model.create(specOf(slot.id), state.models[slot.id].bytes, { device, ortUrl });
      const r = await m.segment(input, grid.dims, (msg, f) => { log(msg); progress(0.7 + f * 0.15); });
      labels = mergeSegmentations(labels, r.labels, slot.replaces);
    }

    let display = grid.data;
    if (state.models.synthsr) {
      log('Sintetizando T1 de 1 mm…');
      const m = await Model.create(specOf('synthsr'), state.models.synthsr.bytes, { device, ortUrl });
      display = await m.regress(input, grid.dims, (msg, f) => { log(msg); progress(0.85 + f * 0.1); });
    }

    state.labels = labels;
    const etiv = parseFloat($('#etiv').value);
    state.stats = computeStats(labels, 1.0, {
      eTIV: isFinite(etiv) ? etiv : undefined,
      subject: $('#subject').value.trim() || 'subject',
    });

    renderResults(display);
    progress(1);
    log(`Concluído em ${((performance.now() - t0) / 1000).toFixed(1)} s · ${state.stats.rows.length} estruturas.`, 'ok');
    setTimeout(() => progress(0), 1200);
  } catch (e) {
    log(e.message, 'err');
    progress(0);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ resultado */
function renderResults(displayVolume) {
  $('#results').hidden = false;
  if (!state.viewer) {
    state.viewer = new Ortho($('#planes'));
    $('#planes').addEventListener('crosshair', () => {
      const info = state.viewer.labelAtCrosshair();
      $('#hover').textContent = info ? `${info.name} (${info.id})` : 'fundo';
    });
  }
  state.viewer.setVolume(displayVolume, state.conformed.dims);
  state.viewer.setLabels(state.labels);
  state.viewer.setOpacity(+$('#opacity').value / 100);
  renderLadder();
  renderTable();
}

function renderLadder() {
  const rows = state.stats.rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pairs = [];
  for (const r of rows) {
    if (r.side !== 'L') continue;
    const m = mirrorOf(r.id, r.name);
    if (m == null || !byId.has(m)) continue;
    const right = byId.get(m);
    pairs.push({
      name: r.name.replace(/^Left-|^ctx-lh-|^wm-lh-/, ''),
      l: r.volume_mm3, r: right.volume_mm3, ai: r.asymmetry_index,
    });
  }
  pairs.sort((a, b) => (b.l + b.r) - (a.l + a.r));
  const top = pairs.slice(0, 16);
  const host = $('#ladder');
  if (!top.length) { host.innerHTML = '<p style="color:var(--dim)">Nenhum par bilateral nesta segmentação.</p>'; return; }

  const rowH = 22, padT = 16, gutter = 176, barMax = 210, aiW = 58;
  const W = gutter + barMax * 2 + aiW + 24;
  const H = padT + top.length * rowH + 16;
  const max = Math.max(...top.map((p) => Math.max(p.l, p.r)));
  const mid = aiW + barMax + 8;

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Volumes bilaterais">`;
  svg += `<line class="axis" x1="${mid}" y1="${padT - 8}" x2="${mid}" y2="${H - 10}"/>`;
  top.forEach((p, i) => {
    const y = padT + i * rowH;
    const wl = (p.l / max) * barMax, wr = (p.r / max) * barMax;
    svg += `<rect class="barL" x="${mid - wl}" y="${y + 3}" width="${wl}" height="11" rx="1"/>`;
    svg += `<rect class="barR" x="${mid + 1}" y="${y + 3}" width="${wr}" height="11" rx="1"/>`;
    svg += `<text class="lname" x="${mid + barMax + 12}" y="${y + 12}">${escapeHtml(p.name)}</text>`;
    svg += `<text class="lval" x="${mid - wl - 5}" y="${y + 12}" text-anchor="end">${Math.round(p.l)}</text>`;
    const ai = p.ai ?? 0;
    const col = Math.abs(ai) > 8 ? 'var(--red)' : 'var(--faint)';
    svg += `<text class="ai" x="4" y="${y + 12}" fill="${col}">${ai >= 0 ? '+' : ''}${ai.toFixed(1)}%</text>`;
  });
  svg += '</svg>';
  host.innerHTML = svg;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderTable() {
  const thead = $('#table thead'), tbody = $('#table tbody');
  thead.innerHTML = `<tr>
    <th>Estrutura</th><th>ID</th><th style="text-align:right">Voxels</th>
    <th style="text-align:right">Volume (mm³)</th><th style="text-align:right">% ref.</th>
    <th style="text-align:right">IA</th></tr>`;

  const groups = [...new Set(state.stats.rows.map((r) => r.group))];
  const gf = $('#group-filter');
  if (gf.options.length <= 1) {
    for (const g of groups) gf.append(new Option(g, g));
  }
  const q = $('#filter').value.toLowerCase();
  const gsel = gf.value;

  let html = '';
  let lastGroup = null;
  for (const r of state.stats.rows) {
    if (gsel && r.group !== gsel) continue;
    if (q && !r.name.toLowerCase().includes(q)) continue;
    if (r.group !== lastGroup) {
      html += `<tr class="groupsep"><td colspan="6">${escapeHtml(r.group)}</td></tr>`;
      lastGroup = r.group;
    }
    const c = r.color;
    html += `<tr>
      <td><span class="swatch" style="background:rgb(${c[0]},${c[1]},${c[2]})"></span>${escapeHtml(r.name)}</td>
      <td class="num">${r.id}</td>
      <td class="num">${r.voxels.toLocaleString('pt-BR')}</td>
      <td class="num">${r.volume_mm3.toFixed(1)}</td>
      <td class="num">${r.pct_of_reference == null ? '' : r.pct_of_reference.toFixed(3)}</td>
      <td class="num">${r.asymmetry_index == null ? '' : r.asymmetry_index.toFixed(1)}</td>
    </tr>`;
  }
  if (!gsel && !q) {
    html += `<tr class="groupsep"><td colspan="6">Derivados · referência: ${escapeHtml(state.stats.denomLabel)}</td></tr>`;
    for (const d of state.stats.derived) {
      html += `<tr><td>${escapeHtml(d.label)}</td><td class="num">—</td><td class="num">—</td>
        <td class="num">${d.value.toFixed(1)}</td><td class="num"></td><td class="num"></td></tr>`;
    }
  }
  tbody.innerHTML = html;
}

/* ---------------------------------------------------------- exportações */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function handleExport(kind) {
  const s = state.stats;
  if (!s && kind !== 'cohort') { log('Nada para exportar ainda.', 'err'); return; }
  const base = (s?.subject || 'coorte').replace(/[^\w.-]+/g, '_');
  if (kind === 'csv') {
    download(new Blob([toCSV(s, { decimal: $('#decimal').value })], { type: 'text/csv;charset=utf-8' }), `${base}_volumes.csv`);
  } else if (kind === 'json') {
    download(new Blob([toJSON(s, { grid: state.conformed.dims, models: Object.fromEntries(Object.entries(state.models).map(([k, v]) => [k, v.spec.name])) })], { type: 'application/json' }), `${base}_volumes.json`);
  } else if (kind === 'sav') {
    download(statsToSav(toWideTable([s]), `Volumetria ${base}`), `${base}_volumes.sav`);
  } else if (kind === 'nii') {
    const buf = writeNifti({
      data: new Uint16Array(state.labels), dims: state.conformed.dims,
      affine: state.conformed.affine, pixdim: [1, 1, 1], description: 'NeuroVol seg',
    });
    download(new Blob([buf], { type: 'application/octet-stream' }), `${base}_seg.nii`);
  } else if (kind === 'queue') {
    state.cohort.push(s);
    $('#queue').textContent = `Coorte: ${state.cohort.length} exame(s) — ${state.cohort.map((x) => x.subject).join(', ')}`;
    document.querySelector('[data-export="cohort"]').disabled = false;
    log(`"${s.subject}" adicionado à coorte.`, 'ok');
  } else if (kind === 'cohort') {
    const wide = toWideTable(state.cohort);
    const sep = $('#decimal').value === ',' ? ';' : ',';
    const dec = $('#decimal').value;
    const head = ['subject', ...wide.names].join(sep);
    const lines = wide.rows.map((r) => [r.subject, ...r.values.map((v) => {
      if (v == null) return '';
      const t = v.toFixed(3);
      return dec === ',' ? t.replace('.', ',') : t;
    })].join(sep));
    download(new Blob([[head, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }), 'coorte_volumes.csv');
    download(statsToSav(wide, 'Coorte NeuroVol'), 'coorte_volumes.sav');
  }
}

/* ------------------------------------------------------------- eventos */
function wire() {
  const drop = $('#drop');
  drop.addEventListener('click', () => $('#file-nifti').click());
  $('#pick-file').addEventListener('click', () => $('#file-nifti').click());
  $('#pick-folder').addEventListener('click', () => $('#file-dicom').click());
  $('#file-nifti').addEventListener('change', (e) => e.target.files[0] && loadNiftiFile(e.target.files[0]));
  $('#file-dicom').addEventListener('change', (e) => loadDicomFolder([...e.target.files]));
  $('#series').addEventListener('change', (e) => selectSeries(+e.target.value));

  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', async (e) => {
    const items = [...(e.dataTransfer.items || [])];
    const files = [];
    const walk = async (entry, depth = 0) => {
      if (!entry || depth > 6) return;
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { files.push(f); res(); }));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const en of batch) await walk(en, depth + 1);
        } while (batch.length);
      }
    };
    for (const it of items) {
      const en = it.webkitGetAsEntry?.();
      if (en) await walk(en); else if (it.getAsFile) files.push(it.getAsFile());
    }
    if (!files.length) return;
    const nii = files.find((f) => /\.nii(\.gz)?$/i.test(f.name));
    if (nii && files.length === 1) loadNiftiFile(nii); else loadDicomFolder(files);
  });

  $('#run').addEventListener('click', run);
  $('#opacity').addEventListener('input', (e) => state.viewer?.setOpacity(+e.target.value / 100));
  $('#filter').addEventListener('input', () => state.stats && renderTable());
  $('#group-filter').addEventListener('change', () => state.stats && renderTable());
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => handleExport(b.dataset.export)));

  $('#load-lut').addEventListener('click', () => $('#file-lut').click());
  $('#file-lut').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const n = loadFreeSurferLUT(await f.text());
    log(`LUT do FreeSurfer carregada: ${n} rótulos.`, 'ok');
    if (state.stats) {
      state.stats.rows.forEach((r) => { const i = labelInfo(r.id); r.name = i.name; r.color = i.color; });
      renderTable(); renderLadder(); state.viewer?.setLabels(state.labels);
    }
  });

  window.addEventListener('resize', () => state.viewer?.render());
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  wire();
  renderSlots();
  await restoreModels();

  const gpu = await hasWebGPU();
  const lim = gpu ? await gpuLimits() : null;
  const badge = $('#device-badge');
  if (gpu) {
    const mb = lim ? Math.round(lim.maxStorageBufferBindingSize / 1048576) : '?';
    badge.textContent = `WebGPU disponível · buffer ${mb} MB`;
  } else {
    badge.textContent = 'sem WebGPU · CPU (mais lento)';
    badge.style.color = 'var(--amber)';
    badge.style.borderColor = 'rgba(217,164,65,.3)';
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  log(Object.keys(state.models).length ? 'Modelos restaurados do dispositivo.' : 'Registre ao menos o modelo principal para começar.');
})();
