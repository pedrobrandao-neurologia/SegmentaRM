// Gerador de PDF mínimo, sem dependências: páginas A4, fontes de base Helvetica
// (codificação WinAnsi — cobre pt-BR e o símbolo ³), linhas, retângulos e imagens JPEG.

const A4 = { w: 595.28, h: 841.89 }

// mapeia code points fora de latin-1 que o WinAnsi cobre
const WINANSI = { 0x20AC: 128, 0x201A: 130, 0x0192: 131, 0x201E: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02C6: 136, 0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017D: 142, 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02DC: 152, 0x2122: 153, 0x0161: 154, 0x203A: 155, 0x0153: 156, 0x017E: 158, 0x0178: 159 }

// símbolos comuns fora do WinAnsi → substitutos ASCII legíveis (em vez de "?")
const SUBST = { 0x2192: '->', 0x2190: '<-', 0x2194: '<->', 0x21B3: '->', 0x2265: '>=', 0x2264: '<=', 0x2212: '-', 0x2248: '~' }

function winAnsi (str) {
  const out = []
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0)
    if (cp < 128) out.push(cp)
    else if (cp <= 255) out.push(cp)
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

export function textWidth (str, size, bold = false) {
  let w = 0
  for (const ch of String(str)) {
    w += (HELV_W[ch] || 556) * (bold ? 1.06 : 1)
  }
  return w / 1000 * size
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
    this.newPage()
  }

  newPage () {
    this.cur = { ops: [], imgs: new Set() }
    this.pages.push(this.cur)
  }

  setColor (r, g, b) { this.cur.ops.push(`${r} ${g} ${b} rg ${r} ${g} ${b} RG`) }
  setLineWidth (w) { this.cur.ops.push(`${w} w`) }

  text (x, y, str, size = 10, { bold = false, color } = {}) {
    if (color) this.setColor(...color)
    const font = bold ? '/F2' : '/F1'
    const bytes = winAnsi(str)
    this.cur.ops.push(`BT ${font} ${size} Tf ${x.toFixed(2)} ${(this.pageH - y).toFixed(2)} Td (${escapePdf(bytes)}) Tj ET`)
  }

  line (x1, y1, x2, y2) {
    this.cur.ops.push(`${x1.toFixed(2)} ${(this.pageH - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.pageH - y2).toFixed(2)} l S`)
  }

  rect (x, y, w, h, fill = false) {
    this.cur.ops.push(`${x.toFixed(2)} ${(this.pageH - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${fill ? 'f' : 'S'}`)
  }

  // bytes JPEG (Uint8Array) já no tamanho desejado; w/h em pontos
  jpeg (bytes, x, y, w, h, pxW, pxH) {
    const idx = this.images.length
    this.images.push({ bytes, w: pxW, h: pxH })
    this.cur.imgs.add(idx)
    this.cur.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(this.pageH - y - h).toFixed(2)} cm /Im${idx} Do Q`)
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
    const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)

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
    xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`
    w(enc.encode(xref))

    const total = parts.reduce((a, p) => a + p.length, 0)
    const out = new Uint8Array(total)
    let p2 = 0
    for (const p of parts) { out.set(p, p2); p2 += p.length }
    return out.buffer
  }
}
