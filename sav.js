// sav.js — escreve arquivos SPSS .sav (registro não comprimido, little-endian).
// Nomes curtos V1..Vn com o mapeamento para nomes longos no registro 7/13,
// que é como o próprio SPSS grava arquivos com nomes de variável extensos.

const SYSMIS = -Number.MAX_VALUE;

class Writer {
  constructor() { this.parts = []; this.len = 0; }
  bytes(u8) { this.parts.push(u8); this.len += u8.length; }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.bytes(b); }
  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this.bytes(b); }
  /** Escreve texto ASCII. `keepTabs` preserva \t, exigido pelo registro 7/13. */
  ascii(s, len = null, keepTabs = false) {
    let str = String(s).replace(keepTabs ? /[^\x09\x20-\x7e]/g : /[^\x20-\x7e]/g, '_');
    if (len !== null) str = str.length > len ? str.slice(0, len) : str.padEnd(len, ' ');
    const b = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i);
    this.bytes(b);
    return b.length;
  }
  blob() { return new Blob(this.parts, { type: 'application/x-spss-sav' }); }
}

function fmt(type, width, dec) { return ((type & 0xff) << 16) | ((width & 0xff) << 8) | (dec & 0xff); }
const F = 5, A = 1;

function sanitizeLong(name, used) {
  let s = String(name).replace(/[^A-Za-z0-9_.]/g, '_').replace(/^[^A-Za-z]/, 'V');
  s = s.slice(0, 60);
  let base = s, k = 1;
  while (used.has(s.toUpperCase())) s = `${base}_${k++}`;
  used.add(s.toUpperCase());
  return s;
}

/**
 * @param {{name:string, type?:'numeric'|'string', width?:number, decimals?:number, label?:string}[]} variables
 * @param {Array<Array<number|string|null>>} cases
 * @param {{fileLabel?:string}} opts
 * @returns {Blob}
 */
export function writeSav(variables, cases, opts = {}) {
  const used = new Set();
  const vars = variables.map((v, i) => ({
    short: `V${i + 1}`,
    long: sanitizeLong(v.name, used),
    type: v.type === 'string' ? 'string' : 'numeric',
    width: v.type === 'string' ? Math.max(1, Math.min(255, v.width || 32)) : 0,
    decimals: v.decimals ?? 3,
    label: v.label || v.name,
  }));

  const elements = vars.reduce((s, v) => s + (v.type === 'string' ? Math.ceil(v.width / 8) : 1), 0);
  const w = new Writer();
  const now = new Date();
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][now.getMonth()];
  const p2 = (n) => String(n).padStart(2, '0');

  // --- registro de cabeçalho
  w.ascii('$FL2');
  w.ascii('@(#) SPSS DATA FILE NeuroVol', 60);
  w.i32(2);            // layout code
  w.i32(elements);     // nominal case size
  w.i32(0);            // sem compressão
  w.i32(0);            // sem variável de peso
  w.i32(cases.length);
  w.f64(100.0);        // bias
  w.ascii(`${p2(now.getDate())} ${mon} ${String(now.getFullYear()).slice(2)}`, 9);
  w.ascii(`${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, 8);
  w.ascii(opts.fileLabel || 'Volumetria NeuroVol', 64);
  w.ascii('', 3);

  // --- registros de variáveis
  for (const v of vars) {
    const isStr = v.type === 'string';
    const width = isStr ? v.width : 8;
    const pf = isStr ? fmt(A, Math.min(width, 255), 0) : fmt(F, 12, v.decimals);
    const labelBytes = v.label ? Math.min(v.label.length, 120) : 0;
    w.i32(2);
    w.i32(isStr ? width : 0);
    w.i32(labelBytes ? 1 : 0);
    w.i32(0);
    w.i32(pf);
    w.i32(pf);
    w.ascii(v.short, 8);
    if (labelBytes) {
      const padded = Math.ceil(labelBytes / 4) * 4;
      w.i32(labelBytes);
      w.ascii(v.label.slice(0, labelBytes), padded);
    }
    if (isStr) {
      const cont = Math.ceil(v.width / 8) - 1;
      for (let c = 0; c < cont; c++) {
        w.i32(2); w.i32(-1); w.i32(0); w.i32(0); w.i32(0); w.i32(0);
        w.ascii('', 8);
      }
    }
  }

  // --- registro 7/13: nomes longos
  const mapping = vars.map((v) => `${v.short}=${v.long}`).join('\t');
  w.i32(7); w.i32(13); w.i32(1); w.i32(mapping.length);
  w.ascii(mapping, null, true);

  // --- registro 7/20: codificação
  w.i32(7); w.i32(20); w.i32(1); w.i32(5);
  w.ascii('UTF-8');

  // --- fim do dicionário
  w.i32(999); w.i32(0);

  // --- dados
  for (const row of cases) {
    vars.forEach((v, i) => {
      const val = row[i];
      if (v.type === 'string') {
        const segs = Math.ceil(v.width / 8) * 8;
        w.ascii(val == null ? '' : String(val), segs);
      } else {
        const n = typeof val === 'number' && isFinite(val) ? val : null;
        w.f64(n === null ? SYSMIS : n);
      }
    });
  }

  return w.blob();
}

/** Constrói o .sav a partir da tabela larga (uma linha por sujeito). */
export function statsToSav(wide, fileLabel) {
  const variables = [
    { name: 'subject', type: 'string', width: 32, label: 'Identificador do sujeito' },
    ...wide.names.map((n) => ({ name: n, type: 'numeric', decimals: 3, label: `${n} (mm3)` })),
  ];
  const cases = wide.rows.map((r) => [r.subject, ...r.values]);
  return writeSav(variables, cases, { fileLabel });
}
