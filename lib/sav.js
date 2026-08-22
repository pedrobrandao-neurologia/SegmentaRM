// Escritor de arquivos SPSS .sav (system file, não comprimido, UTF-8).
// Cobre o que a exportação precisa: variáveis numéricas e de texto, rótulos de variável
// com acentos, nomes longos (registro 7/13), missing como sysmis.
// Validado contra pyreadstat e haven::read_sav.

const SYSMIS = -Number.MAX_VALUE

export function writeSav ({ vars, rows, fileLabel = '' }) {
  const enc = new TextEncoder()
  const chunks = []
  const push = (u8) => chunks.push(u8)
  const int32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b }
  const dbl = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b }
  const padded = (str, len, pad = 0x20) => {
    const b = new Uint8Array(len).fill(pad)
    b.set(enc.encode(str).slice(0, len))
    return b
  }

  // nomes curtos únicos de 8 bytes (VAR00001…) mapeados aos nomes longos no registro 7/13
  const shortNames = []
  const used = new Set()
  for (let i = 0; i < vars.length; i++) {
    let s = vars[i].name.toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8)
    if (!/^[A-Z]/.test(s) || used.has(s) || s.length === 0) s = 'V' + String(i + 1).padStart(7, '0')
    used.add(s)
    shortNames.push(s)
  }

  const elemsOf = (v) => v.type === 'string' ? Math.ceil(Math.max(1, v.width) / 8) : 1
  const nominalCaseSize = vars.reduce((a, v) => a + elemsOf(v), 0)

  // ---- cabeçalho (176 bytes) ----
  push(enc.encode('$FL2'))
  push(padded('@(#) SPSS DATA FILE - segmentarm (morfo)', 60))
  push(int32(2))                    // layout_code
  push(int32(nominalCaseSize))
  push(int32(0))                    // sem compressão
  push(int32(0))                    // weight_index
  push(int32(rows.length))
  push(dbl(100.0))                  // bias
  const now = new Date()
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][now.getMonth()]
  push(padded(String(now.getDate()).padStart(2, '0') + ' ' + mon + ' ' + String(now.getFullYear() % 100).padStart(2, '0'), 9))
  push(padded(now.toTimeString().slice(0, 8), 8))
  push(padded(fileLabel, 64))
  push(padded('', 3))

  // ---- registros de variável (tipo 2) ----
  for (let i = 0; i < vars.length; i++) {
    const v = vars[i]
    const isStr = v.type === 'string'
    const width = isStr ? Math.max(1, v.width) : 0
    const label = v.label || ''
    push(int32(2))
    push(int32(isStr ? width : 0))
    push(int32(label ? 1 : 0))
    push(int32(0))                  // sem missing values declarados
    const fmt = isStr ? (1 << 16) | (Math.min(width, 255) << 8) : (5 << 16) | (12 << 8) | 2 // A(w) | F12.2
    push(int32(fmt))
    push(int32(fmt))
    push(padded(shortNames[i], 8))
    if (label) {
      const lb = enc.encode(label).slice(0, 252)
      push(int32(lb.length))
      const padLen = Math.ceil(lb.length / 4) * 4
      const b = new Uint8Array(padLen)
      b.set(lb)
      push(b)
    }
    // continuações para strings largas
    for (let c = 1; c < elemsOf(v); c++) {
      push(int32(2)); push(int32(-1)); push(int32(0)); push(int32(0)); push(int32(0)); push(int32(0)); push(padded('', 8))
    }
  }

  // ---- registro 7/3: machine integer info ----
  push(int32(7)); push(int32(3)); push(int32(4)); push(int32(8))
  ;[1, 0, 0, -1, 1, 1, 2, 65001].forEach(v => push(int32(v)))
  // ---- registro 7/4: machine float info ----
  push(int32(7)); push(int32(4)); push(int32(8)); push(int32(3))
  push(dbl(SYSMIS)); push(dbl(Number.MAX_VALUE)); push(dbl(SYSMIS))
  // ---- registro 7/13: nomes longos ----
  const longPairs = vars.map((v, i) => shortNames[i] + '=' + v.name.slice(0, 64)).join('\t')
  const lp = enc.encode(longPairs)
  push(int32(7)); push(int32(13)); push(int32(1)); push(int32(lp.length)); push(lp)
  // ---- registro 7/20: encoding ----
  const encName = enc.encode('UTF-8')
  push(int32(7)); push(int32(20)); push(int32(1)); push(int32(encName.length)); push(encName)
  // ---- fim do dicionário ----
  push(int32(999)); push(int32(0))

  // ---- dados (não comprimidos) ----
  for (const row of rows) {
    for (const v of vars) {
      const val = row[v.name]
      if (v.type === 'string') {
        const w = elemsOf(v) * 8
        push(padded(val == null ? '' : String(val), w))
      } else {
        const num = (val == null || val === '' || !isFinite(val)) ? SYSMIS : +val
        push(dbl(num))
      }
    }
  }

  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out.buffer
}

// monta { vars, rows } a partir de linhas-objeto acumuladas (coorte) + rótulos
export function tableToSav (rowObjs, labels, fileLabel) {
  const keys = []
  const seen = new Set()
  for (const r of rowObjs) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); keys.push(k) }
    }
  }
  const vars = keys.map(k => {
    const isStr = rowObjs.some(r => typeof r[k] === 'string' && r[k] !== '')
    const width = isStr ? Math.min(255, Math.max(8, ...rowObjs.map(r => new TextEncoder().encode(String(r[k] ?? '')).length))) : 0
    return { name: k, label: (labels && labels[k]) || '', type: isStr ? 'string' : 'numeric', width }
  })
  return writeSav({ vars, rows: rowObjs, fileLabel })
}
