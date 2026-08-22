// stats.js — volumetria a partir do mapa de rótulos.

import { labelInfo, groupOf, sideOf, mirrorOf } from './lut.js';

/**
 * Sobrepõe uma segmentação de refinamento sobre a base.
 * @param {Uint16Array} base
 * @param {Uint16Array} refine
 * @param {number[]|null} replaces  rótulos da base que podem ser substituídos (null = todos)
 */
export function mergeSegmentations(base, refine, replaces = null) {
  const out = new Uint16Array(base);
  const allow = replaces ? new Set(replaces) : null;
  for (let i = 0; i < base.length; i++) {
    const r = refine[i];
    if (!r) continue;
    if (allow && !allow.has(base[i])) continue;
    out[i] = r;
  }
  return out;
}

/** Conta voxels por rótulo. */
export function labelCounts(labels) {
  const counts = new Map();
  for (let i = 0; i < labels.length; i++) {
    const v = labels[i];
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}

const CSF_LIKE = new Set([4, 5, 14, 15, 24, 43, 44, 72]);

/**
 * @param {Uint16Array} labels
 * @param {number} voxelVolume  mm³ por voxel
 * @param {{eTIV?:number, subject?:string}} meta
 */
export function computeStats(labels, voxelVolume, meta = {}) {
  const counts = labelCounts(labels);
  const rows = [];
  let brainVol = 0;
  for (const [id, n] of counts) {
    const info = labelInfo(id);
    const vol = n * voxelVolume;
    if (!CSF_LIKE.has(id)) brainVol += vol;
    rows.push({
      id,
      name: info.name,
      group: groupOf(id, info.name),
      side: sideOf(id, info.name),
      voxels: n,
      volume_mm3: vol,
      color: info.color,
    });
  }
  const denom = meta.eTIV && meta.eTIV > 0 ? meta.eTIV : brainVol;
  const denomLabel = meta.eTIV && meta.eTIV > 0 ? 'eTIV' : 'volume cerebral segmentado';
  for (const r of rows) r.pct_of_reference = denom ? (r.volume_mm3 / denom) * 100 : null;

  // índice de assimetria
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    const m = mirrorOf(r.id, r.name);
    if (m == null || !byId.has(m)) { r.asymmetry_index = null; continue; }
    if (r.side !== 'L') { r.asymmetry_index = null; continue; }
    const other = byId.get(m);
    const s = r.volume_mm3 + other.volume_mm3;
    r.asymmetry_index = s ? (200 * (r.volume_mm3 - other.volume_mm3)) / s : null;
  }

  rows.sort((a, b) => (a.group === b.group ? b.volume_mm3 - a.volume_mm3 : a.group.localeCompare(b.group)));

  const sumWhere = (fn) => rows.filter(fn).reduce((s, r) => s + r.volume_mm3, 0);
  const derived = [
    { key: 'BrainSegVol', label: 'Volume cerebral segmentado', value: brainVol },
    { key: 'CerebralCortexVol', label: 'Córtex cerebral', value: sumWhere((r) => /Cerebral-Cortex/.test(r.name) || /^ctx-/.test(r.name)) },
    { key: 'CerebralWMVol', label: 'Substância branca cerebral', value: sumWhere((r) => /Cerebral-White-Matter|^wm-/.test(r.name)) },
    { key: 'CerebellumVol', label: 'Cerebelo (total)', value: sumWhere((r) => r.group === 'Cerebelo') },
    { key: 'BrainstemVol', label: 'Tronco encefálico', value: sumWhere((r) => r.group === 'Tronco encefálico') },
    { key: 'VentricleVol', label: 'Ventrículos + liquor', value: sumWhere((r) => r.group === 'Liquor / ventrículos') },
    { key: 'SubcorticalGrayVol', label: 'Cinzenta subcortical', value: sumWhere((r) => r.group === 'Subcortical') },
  ];
  if (meta.eTIV) derived.unshift({ key: 'eTIV', label: 'eTIV informado', value: meta.eTIV });

  return { rows, derived, brainVol, denom, denomLabel, voxelVolume, subject: meta.subject || 'subject' };
}

export function toCSV(stats, { decimal = '.' } = {}) {
  const sep = decimal === ',' ? ';' : ',';
  const fmt = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'number') return String(v);
    const s = v.toFixed(3);
    return decimal === ',' ? s.replace('.', ',') : s;
  };
  const head = ['subject', 'label_id', 'structure', 'group', 'side', 'voxels', 'volume_mm3', 'pct_of_reference', 'asymmetry_index'];
  const lines = [head.join(sep)];
  for (const r of stats.rows) {
    lines.push([
      stats.subject, r.id, r.name, r.group, r.side, r.voxels,
      fmt(r.volume_mm3), fmt(r.pct_of_reference), fmt(r.asymmetry_index),
    ].join(sep));
  }
  for (const d of stats.derived) {
    lines.push([stats.subject, '', d.key, 'Derivado', '', '', fmt(d.value), '', ''].join(sep));
  }
  return lines.join('\n');
}

export function toJSON(stats, extra = {}) {
  return JSON.stringify({
    subject: stats.subject,
    generated_at: new Date().toISOString(),
    voxel_volume_mm3: stats.voxelVolume,
    normalization_reference: stats.denomLabel,
    normalization_value_mm3: stats.denom,
    derived: stats.derived,
    structures: stats.rows.map(({ color, ...r }) => r),
    ...extra,
  }, null, 2);
}

/** Formato largo: uma linha por sujeito, uma coluna por estrutura. */
export function toWideTable(sessions) {
  const cols = new Map();
  for (const s of sessions) {
    for (const r of s.rows) cols.set(r.name, true);
    for (const d of s.derived) cols.set(d.key, true);
  }
  const names = [...cols.keys()];
  const rows = sessions.map((s) => {
    const byName = new Map(s.rows.map((r) => [r.name, r.volume_mm3]));
    for (const d of s.derived) byName.set(d.key, d.value);
    return { subject: s.subject, values: names.map((n) => (byName.has(n) ? byName.get(n) : null)) };
  });
  return { names, rows };
}
