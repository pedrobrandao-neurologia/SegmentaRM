// Gerador de PDF mínimo, sem dependências: páginas A4, fontes de base Helvetica
// (codificação WinAnsi — cobre pt-BR e o símbolo ³), linhas, retângulos (também com
// cantos arredondados), círculos, imagens JPEG (com recorte arredondado opcional),
// espaçamento entre letras (Tc), alinhamento e metadados do documento (/Info).

const A4 = { w: 595.28, h: 841.89 }

// mapeia code points fora de latin-1 que o WinAnsi cobre
const WINANSI = { 0x20AC: 128, 0x201A: 130, 0x0192: 131, 0x201E: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02C6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017D: 142, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02DC: 152, 0x2122: 153, 0x0161: 154, 0x203A: 155, 0x0153: 156, 0x017E: 158, 0x0178: 159 }

// símbolos comuns fora do WinAnsi → substitutos ASCII legíveis (em vez de "?")
const SUBST = { 0x2192: '->', 0x2190: '<-', 0x2194: '<->', 0x21B3: '->', 0x2265: '>=', 0x2264: '<=', 0x2212: '-', 0x2248: '~' }

// número PDF: nunca "NaN"/"Infinity"/notação exponencial (quebrariam o content stream)
const num = (v) => {
  const x = +v
  if (!isFinite(x)) return '0'
  const s = x.toFixed(2)
  return s === '-0.00' ? '0.00' : s
}

function winAnsi (str) {
  const out = []
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0)
    if (cp < 32) out.push(32)                 // controles (\t, \n) → espaço
    else if (cp < 128) out.push(cp)
    else if (cp >= 0xA0 && cp <= 255) out.push(cp) // 0x80–0x9F do Latin-1 são controles C1, não os glifos WinAnsi
    else if (WINANSI[cp] !== undefined) out.push(WINANSI[cp])
    else if (SUBST[cp]) { for (const c of SUBST[cp]) out.push(c.codePointAt(0)) }
    else out.push(63) // ?
  }
  return out
}

function escapePdf (bytes) {
  let s = ''
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b)
    else if (b >= 32 && b < 127) s += String.fromCharCode(b)
    else s += '\\' + b.toString(8).padStart(3, '0')
  }
  return s
}

// larguras Helvetica (AFM) — média aproximada por classe para quebra de linha
const HELV_W = { ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, 0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334, '~': 584 }

// Helvetica-Bold (AFM) para letras e algarismos — o negrito NÃO é só 6% mais largo:
// os algarismos têm a mesma largura (556), o que importa para alinhar números à direita
const HELVB_W = { ' ': 278, 0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556, '.': 278, ',': 278, '-': 333, '+': 584, '%': 889, '(': 333, ')': 333, '/': 278, ':': 333, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556, y: 556, z: 500 }

export function textWidth (str, size, bold = false, tracking = 0) {
  let w = 0
  let n = 0
  for (const ch of String(str)) {
    // letras acentuadas medem como a letra-base (á → a)
    const b = HELV_W[ch] !== undefined ? ch : (ch.normalize('NFD')[0] || ch)
    w += bold ? (HELVB_W[b] ?? (HELV_W[b] || 556) * 1.06) : (HELV_W[b] || 556)
    n++
  }
  return w / 1000 * size + (n > 1 ? tracking * (n - 1) : 0)
}

export function wrapText (str, size, maxW, bold = false) {
  const words = String(str).split(/\s+/)
  const lines = []
  let cur = ''
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w
    if (textWidth(cand, size, bold) <= maxW || !cur) cur = cand
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

export class PDF {
  constructor () {
    this.pages = []
    this.images = []       // {bytes, w, h}
    this.pageW = A4.w
    this.pageH = A4.h
    this.info = {}
    this.newPage()
  }

  // metadados do documento (Título, Autor, Assunto…) — aparecem no leitor de PDF
  setInfo (o) { Object.assign(this.info, o) }

  newPage () {
    this.cur = { ops: [], imgs: new Set() }
    this.pages.push(this.cur)
  }

  setColor (r, g, b) {
    const c = [r, g, b].map(v => Math.max(0, Math.min(1, +v || 0)).toFixed(3)).join(' ')
    this.cur.ops.push(`${c} rg ${c} RG`)
  }
  setLineWidth (w) { this.cur.ops.push(`${num(w)} w`) }

  // tracking: espaço extra entre letras, em pontos (negativo aperta títulos grandes);
  // align 'right'/'center' ancora o texto em x pela largura medida
  text (x, y, str, size = 10, { bold = false, color, tracking = 0, align = 'left' } = {}) {
    if (color) this.setColor(...color)
    const font = bold ? '/F2' : '/F1'
    const bytes = winAnsi(str)
    if (align !== 'left') {
      const w = textWidth(str, size, bold, tracking)
      x -= align === 'right' ? w : w / 2
    }
    // Tc é estado de texto e persiste entre BT/ET: sempre explícito
    this.cur.ops.push(`BT ${font} ${num(size)} Tf ${num(tracking)} Tc ${num(x)} ${num(this.pageH - y)} Td (${escapePdf(bytes)}) Tj ET`)
  }

  line (x1, y1, x2, y2) {
    this.cur.ops.push(`${num(x1)} ${num(this.pageH - y1)} m ${num(x2)} ${num(this.pageH - y2)} l S`)
  }

  rect (x, y, w, h, fill = false) {
    this.cur.ops.push(`${num(x)} ${num(this.pageH - y - h)} ${num(w)} ${num(h)} re ${fill ? 'f' : 'S'}`)
  }

  // caminho de retângulo com cantos arredondados (Bézier, κ = 0,5523)
  _roundPath (x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2))
    const k = 0.5523 * r
    const X0 = x; const X1 = x + w
    const Y0 = this.pageH - y; const Y1 = this.pageH - y - h // topo e base em coordenadas PDF
    return [
      `${num(X0 + r)} ${num(Y0)} m`,
      `${num(X1 - r)} ${num(Y0)} l`,
      `${num(X1 - r + k)} ${num(Y0)} ${num(X1)} ${num(Y0 - r + k)} ${num(X1)} ${num(Y0 - r)} c`,
      `${num(X1)} ${num(Y1 + r)} l`,
      `${num(X1)} ${num(Y1 + r - k)} ${num(X1 - r + k)} ${num(Y1)} ${num(X1 - r)} ${num(Y1)} c`,
      `${num(X0 + r)} ${num(Y1)} l`,
      `${num(X0 + r - k)} ${num(Y1)} ${num(X0)} ${num(Y1 + r - k)} ${num(X0)} ${num(Y1 + r)} c`,
      `${num(X0)} ${num(Y0 - r)} l`,
      `${num(X0)} ${num(Y0 - r + k)} ${num(X0 + r - k)} ${num(Y0)} ${num(X0 + r)} ${num(Y0)} c`,
      'h'
    ].join(' ')
  }

  roundRect (x, y, w, h, r, fill = true) {
    if (!(w > 0) || !(h > 0)) return
    this.cur.ops.push(`${this._roundPath(x, y, w, h, r)} ${fill ? 'f' : 'S'}`)
  }

  circle (cx, cy, r, fill = true) {
    this.roundRect(cx - r, cy - r, 2 * r, 2 * r, r, fill)
  }

  // bytes JPEG (Uint8Array) já no tamanho desejado; w/h em pontos
  // radius > 0 recorta a imagem com cantos arredondados (caminho de recorte W n)
  jpeg (bytes, x, y, w, h, pxW, pxH, radius = 0) {
    const idx = this.images.length
    this.images.push({ bytes, w: pxW, h: pxH })
    this.cur.imgs.add(idx)
    const clip = radius > 0 ? `${this._roundPath(x, y, w, h, radius)} W n ` : ''
    this.cur.ops.push(`q ${clip}${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.pageH - y - h)} cm /Im${idx} Do Q`)
  }

  build () {
    const enc = new TextEncoder()
    const objs = [] // 1-based
    const addObj = (content) => { objs.push(content); return objs.length }

    const fontIds = [
      addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
      addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
      addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
    ]
    const imgIds = this.images.map(im =>
      addObj({ dict: `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>`, stream: im.bytes }))

    const pageIds = []
    const contentIds = []
    for (const p of this.pages) {
      const content = enc.encode(p.ops.join('\n'))
      contentIds.push(addObj({ dict: `<< /Length ${content.length} >>`, stream: content }))
      pageIds.push(null) // placeholder
    }
    const pagesId = objs.length + this.pages.length + 1
    for (let i = 0; i < this.pages.length; i++) {
      const xo = [...this.pages[i].imgs].map(ix => `/Im${ix} ${imgIds[ix]} 0 R`).join(' ')
      pageIds[i] = addObj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.pageW} ${this.pageH}] /Resources << /Font << /F1 ${fontIds[0]} 0 R /F2 ${fontIds[1]} 0 R /F3 ${fontIds[2]} 0 R >> /XObject << ${xo} >> >> /Contents ${contentIds[i]} 0 R >>`)
    }
    const realPagesId = addObj(`<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`)
    if (realPagesId !== pagesId) throw new Error('id de páginas inconsistente')
    const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`)
    // /Info: textos em hexadecimal UTF-16BE (acentos corretos em qualquer leitor)
    const hex16 = (str) => {
      let h = 'FEFF'
      for (let i = 0; i < str.length; i++) h += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase()
      return `<${h}>`
    }
    const d = new Date()
    const pad = (v) => String(v).padStart(2, '0')
    const pdfDate = `(D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z)`
    const infoEntries = Object.entries({ Producer: 'SegmentaRM', ...this.info })
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `/${k} ${hex16(String(v))}`).join(' ')
    const infoId = addObj(`<< ${infoEntries} /CreationDate ${pdfDate} >>`)

    // serialização
    const parts = []
    let off = 0
    const w = (b) => { parts.push(b); off += b.length }
    const offsets = [0]
    w(enc.encode('%PDF-1.4\n%\xB5\xB5\n'))
    for (let i = 0; i < objs.length; i++) {
      offsets.push(off)
      const o = objs[i]
      w(enc.encode(`${i + 1} 0 obj\n`))
      if (typeof o === 'string') w(enc.encode(o + '\n'))
      else {
        w(enc.encode(o.dict + '\nstream\n'))
        w(o.stream)
        w(enc.encode('\nendstream\n'))
      }
      w(enc.encode('endobj\n'))
    }
    const xrefOff = off
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    for (let i = 1; i <= objs.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`
    w(enc.encode(xref))

    const total = parts.reduce((a, p) => a + p.length, 0)
    const out = new Uint8Array(total)
    let p2 = 0
    for (const p of parts) { out.set(p, p2); p2 += p.length }
    return out.buffer
  }
}
