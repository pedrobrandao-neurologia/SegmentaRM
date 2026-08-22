// lut.js — nomes, cores e agrupamento anatômico dos rótulos.
// As estruturas subcorticais usam as cores oficiais do FreeSurferColorLUT.
// Parcelas corticais recebem cores geradas; carregue o FreeSurferColorLUT.txt
// pelo painel de rótulos se quiser as cores originais.

const ASEG = [
  [0, 'Unknown', [0, 0, 0]],
  [2, 'Left-Cerebral-White-Matter', [245, 245, 245]],
  [3, 'Left-Cerebral-Cortex', [205, 62, 78]],
  [4, 'Left-Lateral-Ventricle', [120, 18, 134]],
  [5, 'Left-Inf-Lat-Vent', [196, 58, 250]],
  [7, 'Left-Cerebellum-White-Matter', [220, 248, 164]],
  [8, 'Left-Cerebellum-Cortex', [230, 148, 34]],
  [10, 'Left-Thalamus', [0, 118, 14]],
  [11, 'Left-Caudate', [122, 186, 220]],
  [12, 'Left-Putamen', [236, 13, 176]],
  [13, 'Left-Pallidum', [12, 48, 255]],
  [14, '3rd-Ventricle', [204, 182, 142]],
  [15, '4th-Ventricle', [42, 204, 164]],
  [16, 'Brain-Stem', [119, 159, 176]],
  [17, 'Left-Hippocampus', [220, 216, 20]],
  [18, 'Left-Amygdala', [103, 255, 255]],
  [24, 'CSF', [60, 60, 60]],
  [26, 'Left-Accumbens-area', [255, 165, 0]],
  [28, 'Left-VentralDC', [165, 42, 42]],
  [41, 'Right-Cerebral-White-Matter', [245, 245, 245]],
  [42, 'Right-Cerebral-Cortex', [205, 62, 78]],
  [43, 'Right-Lateral-Ventricle', [120, 18, 134]],
  [44, 'Right-Inf-Lat-Vent', [196, 58, 250]],
  [46, 'Right-Cerebellum-White-Matter', [220, 248, 164]],
  [47, 'Right-Cerebellum-Cortex', [230, 148, 34]],
  [49, 'Right-Thalamus', [0, 118, 14]],
  [50, 'Right-Caudate', [122, 186, 220]],
  [51, 'Right-Putamen', [236, 13, 176]],
  [52, 'Right-Pallidum', [13, 48, 255]],
  [53, 'Right-Hippocampus', [220, 216, 20]],
  [54, 'Right-Amygdala', [103, 255, 255]],
  [58, 'Right-Accumbens-area', [255, 165, 0]],
  [60, 'Right-VentralDC', [165, 42, 42]],
];

// Substruturas do tronco (segmentBS)
const BRAINSTEM = [
  [173, 'Midbrain', [242, 104, 76]],
  [174, 'Pons', [206, 195, 58]],
  [175, 'Medulla', [119, 159, 176]],
  [178, 'SCP', [142, 182, 0]],
];

// Parcelas DKT (31 por hemisfério). lh = 1000+n, rh = 2000+n.
const DKT = [
  [2, 'caudalanteriorcingulate'], [3, 'caudalmiddlefrontal'], [5, 'cuneus'],
  [6, 'entorhinal'], [7, 'fusiform'], [8, 'inferiorparietal'], [9, 'inferiortemporal'],
  [10, 'isthmuscingulate'], [11, 'lateraloccipital'], [12, 'lateralorbitofrontal'],
  [13, 'lingual'], [14, 'medialorbitofrontal'], [15, 'middletemporal'],
  [16, 'parahippocampal'], [17, 'paracentral'], [18, 'parsopercularis'],
  [19, 'parsorbitalis'], [20, 'parstriangularis'], [21, 'pericalcarine'],
  [22, 'postcentral'], [23, 'posteriorcingulate'], [24, 'precentral'],
  [25, 'precuneus'], [26, 'rostralanteriorcingulate'], [27, 'rostralmiddlefrontal'],
  [28, 'superiorfrontal'], [29, 'superiorparietal'], [30, 'superiortemporal'],
  [31, 'supramarginal'], [34, 'transversetemporal'], [35, 'insula'],
];

// Lóbulos cerebelares — a numeração varia entre modelos (CerebNet, SUIT, NextBrain).
// Deixe vazio e carregue a LUT do seu modelo; o app aceita qualquer rótulo inteiro.
const CEREBELLUM = [];

function genColor(id) {
  const h = (id * 137.508) % 360;
  const s = 0.55, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export const LUT = new Map();
function put(id, name, color) { LUT.set(id, { id, name, color: color || genColor(id) }); }

ASEG.forEach(([id, name, c]) => put(id, name, c));
BRAINSTEM.forEach(([id, name, c]) => put(id, name, c));
DKT.forEach(([n, name]) => {
  put(1000 + n, `ctx-lh-${name}`);
  put(2000 + n, `ctx-rh-${name}`);
  put(3000 + n, `wm-lh-${name}`);
  put(4000 + n, `wm-rh-${name}`);
});
CEREBELLUM.forEach(([id, name, c]) => put(id, name, c));

export function labelInfo(id) {
  return LUT.get(id) || { id, name: `Label-${id}`, color: genColor(id) };
}

/** Substitui/estende a tabela com um FreeSurferColorLUT.txt. */
export function loadFreeSurferLUT(text) {
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = t.split(/\s+/);
    if (p.length < 5) continue;
    const id = parseInt(p[0], 10);
    if (Number.isNaN(id)) continue;
    LUT.set(id, { id, name: p[1], color: [+p[2], +p[3], +p[4]] });
    n++;
  }
  return n;
}

/** Classificação anatômica grosseira, usada para agrupar a tabela de estatísticas. */
export function groupOf(id, name) {
  const nm = (name || '').toLowerCase();
  if (id >= 1000 && id < 3000) return 'Córtex (parcelas)';
  if (id >= 3000 && id < 5000) return 'Substância branca (parcelas)';
  if (nm.includes('cerebellum') || nm.includes('cerebel') || (id >= 600 && id < 700)) return 'Cerebelo';
  if (nm.includes('brain-stem') || [173, 174, 175, 178].includes(id)) return 'Tronco encefálico';
  if (nm.includes('ventricle') || nm === 'csf' || nm.includes('vent')) return 'Liquor / ventrículos';
  if (nm.includes('white-matter')) return 'Substância branca';
  if (nm.includes('cortex')) return 'Córtex';
  return 'Subcortical';
}

/** Devolve o rótulo contralateral, se existir. */
export function mirrorOf(id, name) {
  if (id >= 1000 && id < 2000) return id + 1000;
  if (id >= 2000 && id < 3000) return id - 1000;
  if (id >= 3000 && id < 4000) return id + 1000;
  if (id >= 4000 && id < 5000) return id - 1000;
  const pairs = { 2: 41, 3: 42, 4: 43, 5: 44, 7: 46, 8: 47, 10: 49, 11: 50, 12: 51, 13: 52, 17: 53, 18: 54, 26: 58, 28: 60 };
  if (pairs[id]) return pairs[id];
  const rev = Object.fromEntries(Object.entries(pairs).map(([k, v]) => [v, +k]));
  if (rev[id]) return rev[id];
  return null;
}

export function sideOf(id, name) {
  const nm = (name || '').toLowerCase();
  if (id >= 1000 && id < 2000) return 'L';
  if (id >= 2000 && id < 3000) return 'R';
  if (id >= 3000 && id < 4000) return 'L';
  if (id >= 4000 && id < 5000) return 'R';
  if (nm.startsWith('left') || nm.includes('-lh-')) return 'L';
  if (nm.startsWith('right') || nm.includes('-rh-')) return 'R';
  return '';
}
