// Extrator de texto mínimo para os PDFs gerados por lib/pdf.js (streams sem compressão):
// textos em fontes Type0/Identity-H são decodificados pelos mapas ToUnicode de cada fonte;
// textos em Helvetica (WinAnsi) vêm das strings literais. Serve para os testes conferirem
// o conteúdo do laudo sem depender de bibliotecas externas.

export function textoDoPdf (buf) {
  const s = Buffer.from(buf).toString('latin1')
  // objetos: número → conteúdo
  const objs = new Map()
  const reObj = /(\d+) 0 obj\n([\s\S]*?)\nendobj/g
  let m
  while ((m = reObj.exec(s))) objs.set(+m[1], m[2])
  const streamDe = (id) => {
    const o = objs.get(id) || ''
    const i = o.indexOf('stream\n')
    const j = o.lastIndexOf('\nendstream')
    return i >= 0 && j > i ? o.slice(i + 7, j) : ''
  }
  // recurso de fonte (/FT400 …) → mapa GID → caractere
  const mapas = new Map()
  for (const [, o] of objs) {
    const r = /\/Font << ([^>]*) >>/.exec(o)
    if (!r) continue
    for (const par of r[1].matchAll(/\/(\w+) (\d+) 0 R/g)) {
      const fonte = objs.get(+par[2]) || ''
      const tu = /\/ToUnicode (\d+) 0 R/.exec(fonte)
      if (!tu || mapas.has(par[1])) continue
      const cmap = streamDe(+tu[1])
      const mp = new Map()
      for (const e of cmap.matchAll(/<([0-9A-Fa-f]{4})> <([0-9A-Fa-f]+)>/g)) {
        const u = e[2]
        let ch = ''
        for (let k = 0; k < u.length; k += 4) ch += String.fromCharCode(parseInt(u.slice(k, k + 4), 16))
        mp.set(parseInt(e[1], 16), ch)
      }
      mapas.set(par[1], mp)
    }
  }
  const winAnsi = (lit) => lit.replace(/\\([0-7]{3}|[()\\])/g, (_, c) => /^[0-7]{3}$/.test(c) ? String.fromCharCode(parseInt(c, 8)) : c)
  let out = ''
  // conteúdo das páginas: todos os streams que tenham operadores de texto
  for (const [id] of objs) {
    const st = streamDe(id)
    if (!/ Tf /.test(st)) continue
    for (const bt of st.matchAll(/BT \/(\w+) [\d.]+ Tf [-\d.]+ Tc [-\d.]+ [-\d.]+ Td (?:\[(.*?)\] TJ|\((.*?)\) Tj) ET/g)) {
      const mp = mapas.get(bt[1])
      if (bt[2] != null && mp) {
        for (const h of bt[2].matchAll(/<([0-9a-f]*)>/g)) {
          for (let k = 0; k < h[1].length; k += 4) out += mp.get(parseInt(h[1].slice(k, k + 4), 16)) || '?'
        }
      } else if (bt[3] != null) out += winAnsi(bt[3])
      out += '\n'
    }
  }
  return out
}
