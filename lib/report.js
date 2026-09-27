// Relatório PDF do SegmentaRM — diagramação de impresso no espírito da Apple:
// hierarquia construída com peso + tamanho + entrelinha (não com caixa-alta vermelha),
// espaçamento entre letras por tamanho (títulos apertados, rótulos pequenos abertos),
// cartões de cantos arredondados em cinza-papel, fios finíssimos só onde separam
// linhas, e cor usada com propósito: azul = informação, laranja = atípico,
// vermelho = possível erro. Números alinhados à direita, unidades discretas.
// Tipografia: Inter (SIL OFL; a alternativa aberta mais próxima da SF Pro, cujo uso a
// licença da Apple restringe às plataformas dela), embutida com kerning e algarismos
// tabulares; espaçamento entre letras pela fórmula de métricas dinâmicas da Inter.
// Sem as fontes (ex.: offline sem cache), cai na Helvetica de base do PDF.
// Seções: capa · QC da segmentação · comparação normativa · volumes por região (lobo ×
// hemisfério, com o índice de assimetria como coluna) · espessura cortical (com aviso
// metodológico) · métodos e ressalvas.

import { PDF } from './pdf.js'
import { GROUP_PT, parseLabelName, lobeOf, ptNameOf } from './labels.js'
import { AVISO_ESPESSURA } from './stats.js'

// ---------- paleta (sistema claro) ----------
const INK = [0.114, 0.114, 0.122]        // #1D1D1F — texto principal
const SECOND = [0.431, 0.431, 0.451]     // #6E6E73 — texto secundário
const TERT = [0.525, 0.525, 0.545]       // #86868B — legendas e rodapé
const HAIR = [0.898, 0.898, 0.918]       // #E5E5EA — separador de linhas
const HAIR2 = [0.824, 0.824, 0.843]      // #D2D2D7 — base do cabeçalho de tabela
const PANEL = [0.961, 0.961, 0.969]      // #F5F5F7 — cartões
const TRACK = [0.910, 0.910, 0.929]      // #E8E8ED — trilhos de medidores
const WHITE = [1, 1, 1]
const BLUE = [0, 0.443, 0.89]            // #0071E3
const BLUE_BAND = [0.800, 0.878, 0.976]  // faixa P5–P95
const BLUE_TINT = [0.925, 0.957, 0.996]
const ORANGE = [0.769, 0.333, 0]         // #C45500
const ORANGE_TINT = [1, 0.957, 0.902]
const RED = [0.843, 0, 0.082]            // #D70015
const RED_TINT = [0.992, 0.929, 0.937]
const GREEN = [0.141, 0.541, 0.239]      // #248A3D
const TONES = {
  blue: { ink: BLUE, tint: BLUE_TINT },
  orange: { ink: ORANGE, tint: ORANGE_TINT },
  red: { ink: RED, tint: RED_TINT }
}

const M = 54                              // margem lateral
const RADIUS = 10                         // raio dos cartões

// espaçamento entre letras por tamanho, em pontos — métricas dinâmicas da Inter
// (tracking = −0,0223 + 0,185·e^(−0,1745·tamanho) em em): títulos grandes apertam, texto
// pequeno abre; rótulos em caixa-alta ganham +0,06 em
const trackFor = (size, caps = false) => size * ((-0.0223 + 0.185 * Math.exp(-0.1745 * size)) + (caps ? 0.06 : 0))

const fmtCm3 = (v) => (v / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const fmtMm3 = (v) => Math.round(v).toLocaleString('pt-BR')
const fmtZ = (z) => (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(2).replace('.', ',')
const fmtP = (p) => (p < 1 || p > 99 ? p.toFixed(1) : Math.round(p).toString()).replace('.', ',')
const fmtN = (v, d = 2) => v == null || !isFinite(v) ? '—' : (+v).toFixed(d).replace('.', ',')
const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// fonts (opcional): { 400: ArrayBuffer, 600: ArrayBuffer, 700: ArrayBuffer, kern: { 400: '…', … } }
// ---------- agrupamento anatômico ----------
const LOBO_ORDEM = ['frontal', 'temporal', 'parietal', 'occipital', 'ínsula']
const LOBO_TIT = { frontal: 'Lobo frontal', temporal: 'Lobo temporal', parietal: 'Lobo parietal', occipital: 'Lobo occipital', 'ínsula': 'Ínsula' }
const GRUPO_ORDEM = ['córtex', 'cortex', 'substância branca', 'subcortical', 'cerebelo', 'ventrículos', 'caloso', 'tronco', 'líquor', 'outros']
const GRUPO_TIT = { 'córtex': 'Córtex cerebral', cortex: 'Córtex — outras regiões', subcortical: 'Substância cinzenta profunda' }
const semHemi = (s) => String(s).replace(/ — (esquerd|direit)[oa]$/, '')

// seções do laudo: parcelas DKT por lobo (frontal, temporal, parietal, occipital, ínsula),
// depois os grupos teciduais; a mesma estrutura dos dois lados vira uma linha E | D
function regionSections (rows) {
  const secs = new Map()
  for (const r of rows) {
    if (r.group === 'fundo' || !(r.volMm3 > 0)) continue
    const { hemi, base } = parseLabelName(r.name)
    const lobo = lobeOf(r.name)
    const key = lobo ? 'lobo:' + lobo : 'g:' + r.group
    if (!secs.has(key)) {
      const gi = GRUPO_ORDEM.indexOf(r.group)
      secs.set(key, {
        titulo: lobo ? (LOBO_TIT[lobo] || lobo) : (GRUPO_TIT[r.group] || GROUP_PT[r.group] || r.group),
        ordem: lobo ? LOBO_ORDEM.indexOf(lobo) : 10 + (gi < 0 ? 99 : gi),
        map: new Map()
      })
    }
    const sct = secs.get(key)
    const it = sct.map.get(base) || { nome: semHemi(r.ptName || ptNameOf(r.name)), E: null, D: null, M: null }
    const lado = hemi === 'E' ? 'E' : hemi === 'D' ? 'D' : 'M'
    it[lado] = (it[lado] || 0) + r.volMm3
    sct.map.set(base, it)
  }
  const soma = (xs, k) => xs.some(x => x[k] != null) ? xs.reduce((a, x) => a + (x[k] || 0), 0) : null
  return [...secs.values()].sort((a, b) => a.ordem - b.ordem).map(sct => {
    const itens = [...sct.map.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    return { titulo: sct.titulo, itens, subtotal: itens.length > 1 ? { E: soma(itens, 'E'), D: soma(itens, 'D'), M: soma(itens, 'M') } : null }
  })
}

export function buildReport ({ stats, meta, snapshot, fonts = null }) {
  const pdf = new PDF()
  if (fonts) {
    for (const w of [400, 600, 700]) {
      if (fonts[w]) { try { pdf.addFont(w, fonts[w], fonts.kern && fonts.kern[w]) } catch (e) { /* fonte inválida: Helvetica */ } }
    }
  }
  const W = pdf.pageW
  const CW = W - 2 * M
  const BOTTOM = pdf.pageH - 64
  const norms = meta.norms && meta.norms.available ? meta.norms : null
  const hasError = norms && norms.flags.some(f => Math.abs(f.z) >= 4)
  const hasAtyp = norms && norms.flags.length > 0
  const vic = meta.icv && meta.icv.vic_mm3 > 0 ? meta.icv.vic_mm3 : null
  pdf.setInfo({
    Title: `Relatório volumétrico — ${meta.subject || 'exame'}`,
    Subject: 'Volumetria encefálica por segmentação automática (uso em pesquisa)',
    Creator: `SegmentaRM ${meta.version || ''}`.trim()
  })

  // ---------- primitivas tipográficas ----------
  // pesos: 400 texto, 600 ênfase/rótulos, 700 títulos e números de destaque
  const wOf = (o) => o.weight || (o.bold ? 700 : 400)
  const T = (x, y, s, size, o = {}) => pdf.text(x, y, s, size, { color: INK, tracking: trackFor(size, o.caps), ...o, weight: wOf(o) })
  const TW = (s, size, o = {}) => pdf.textWidth(s, size, { weight: wOf(o), tracking: trackFor(size, o.caps) })
  const wrap = (s, size, maxW, o = {}) => pdf.wrap(String(s), size, maxW, { weight: wOf(o), tracking: trackFor(size, o.caps) })
  const caps = (x, y, s, size = 6.8, o = {}) => T(x, y, String(s).toUpperCase(), size, { weight: 600, color: SECOND, caps: true, ...o })
  const para = (x, y, s, size, maxW, o = {}) => {
    const lead = o.lead || size * 1.45
    for (const ln of wrap(s, size, maxW, o)) { T(x, y, ln, size, o); y += lead }
    return y
  }
  const paraHeight = (s, size, maxW, lead = size * 1.45, o = {}) => wrap(s, size, maxW, o).length * lead
  const card = (x, y, w, h, fill = PANEL, r = RADIUS) => { pdf.setColor(...fill); pdf.roundRect(x, y, w, h, r, true) }
  const hair = (y, color = HAIR, x0 = M, x1 = W - M, lw = 0.5) => { pdf.setColor(...color); pdf.setLineWidth(lw); pdf.line(x0, y, x1, y) }

  // ---------- estrutura de página ----------
  const header = (title, subtitle = null) => {
    caps(M, 40, 'SegmentaRM', 6.8, { color: SECOND })
    T(W - M, 40, `${clip(meta.subject || 'exame', 40)} · ${meta.date || ''}`, 7, { color: TERT, align: 'right' })
    T(M, 82, title, 24, { bold: true })
    if (subtitle) { T(M, 101, subtitle, 10.5, { color: SECOND }); return 128 }
    return 112
  }
  const newPage = (title, subtitle) => { pdf.newPage(); return header(title, subtitle) }
  const footer = (n, total) => {
    T(M, pdf.pageH - 30, 'SegmentaRM · uso em pesquisa e ensino — não é dispositivo médico nem substitui a leitura radiológica.', 6.8, { color: TERT })
    T(W - M, pdf.pageH - 30, `${n} / ${total}`, 6.8, { color: TERT, align: 'right' })
  }
  const sectionTitle = (y, title, note = null) => {
    T(M, y, title, 13.5, { weight: 600 })
    y += 8
    if (note) { y = para(M, y + 8, note, 8.3, CW, { color: SECOND }) - 2 }
    return y + 14
  }

  // cartão de aviso/nota com pastilha de cor, título e corpo; quebra de página se não couber
  const callout = (y, { tone = 'blue', title, body, contTitle }) => {
    const tn = TONES[tone]
    const pad = 14
    const bodies = Array.isArray(body) ? body : [body]
    const textW = CW - 2 * pad - 12
    const bh = bodies.reduce((a, b) => a + paraHeight(b, 8.3, textW, 12) + 4, 0)
    const h = bh + 38
    if (y + h > BOTTOM) y = newPage(contTitle || 'Continuação')
    card(M, y, CW, h, tn.tint)
    pdf.setColor(...tn.ink); pdf.circle(M + pad + 3, y + pad + 4.2, 3, true)
    T(M + pad + 12, y + pad + 7, title, 9, { weight: 600, color: tn.ink })
    let yy = y + pad + 22
    for (const b of bodies) yy = para(M + pad + 12, yy, b, 8.3, textW, { color: INK, lead: 12 }) + 4
    return y + h + 16
  }

  // tabela: cabeçalho + linhas com fio fino; reabre o cabeçalho ao virar a página
  const table = (y, cols, rows, { rowH = 16, contTitle, drawRow }) => {
    const head = (yy) => {
      for (const c of cols) caps(c.x, yy, c.label, 6.5, { align: c.align || 'left' })
      hair(yy + 6, HAIR2, M, W - M, 0.6)
      return yy + 6 + 14
    }
    y = head(y)
    rows.forEach((r, i) => {
      const extra = r.__extraH || 0
      if (y + extra > BOTTOM) { y = newPage(contTitle); y = head(y) }
      drawRow(r, y)
      y += extra
      if (i < rows.length - 1) hair(y + 5.5)
      y += rowH
    })
    return y + 6
  }

  // medidor de percentil: trilho, faixa P5–P95, marca da mediana e ponto do exame
  const gauge = (x, y, w, pct, tone) => {
    const yc = y - 3
    pdf.setColor(...TRACK); pdf.roundRect(x, yc - 2, w, 4, 2, true)
    pdf.setColor(...BLUE_BAND); pdf.roundRect(x + w * 0.05, yc - 2, w * 0.90, 4, 2, true)
    pdf.setColor(...SECOND); pdf.rect(x + w * 0.5 - 0.4, yc - 4, 0.8, 8, true)
    const cx = x + w * Math.min(99.5, Math.max(0.5, pct)) / 100
    pdf.setColor(...WHITE); pdf.circle(cx, yc, 4.6, true)
    pdf.setColor(...(tone ? TONES[tone].ink : BLUE)); pdf.circle(cx, yc, 3.3, true)
  }

  // ================= capa =================
  let y = 0
  caps(M, 40, 'SegmentaRM', 6.8)
  T(W - M, 40, meta.date || '', 7, { color: TERT, align: 'right' })
  T(M, 104, 'Relatório volumétrico', 32, { bold: true })
  T(M, 128, clip(meta.subject || 'Exame', 60), 14, { color: SECOND })
  y = 160

  // ficha do exame em cartão
  const spec = [
    ['Idade · sexo', meta.age ? `${meta.age} anos · ${meta.sex === 'M' ? 'masculino' : meta.sex === 'F' ? 'feminino' : '—'}` : 'não informados'],
    ['Qualidade da entrada', meta.quality ? `nível ${meta.quality.grade} — ${meta.quality.gradeTxt}` : '—'],
    ['Entrada', (meta.input || '—').replace(/→/g, '›')],
    ['Voxel original', meta.quality ? meta.quality.voxel.map(v => v.toFixed(2).replace('.', ',')).join(' × ') + ' mm' : '—'],
    ['Modelo', meta.model || '—'],
    ['Pipeline', (meta.pipeline || '—').replace(/→/g, '›')],
    ...(vic ? [['Volume intracraniano (eTIV)', `${fmtCm3(vic)} cm³ · registro afim ao MNI152`]] : [])
  ]
  {
    const pad = 18
    const colW = (CW - 2 * pad - 20) / 2
    const cells = spec.map(([k, v]) => ({ k, lines: wrap(String(v), 9.5, colW).slice(0, 2) }))
    const rowHs = []
    for (let i = 0; i < cells.length; i += 2) {
      const n = Math.max(cells[i].lines.length, cells[i + 1] ? cells[i + 1].lines.length : 1)
      rowHs.push(14 + n * 12.5 + 10)
    }
    const h = pad + rowHs.reduce((a, b) => a + b, 0) + pad - 10
    card(M, y, CW, h)
    let yy = y + pad + 6
    cells.forEach((c, i) => {
      const cx = M + pad + (i % 2) * (colW + 20)
      const ry = yy + rowHs.slice(0, Math.floor(i / 2)).reduce((a, b) => a + b, 0)
      caps(cx, ry, c.k, 6.3, { color: TERT })
      c.lines.forEach((ln, li) => T(cx, ry + 14 + li * 12.5, ln, 9.5))
    })
    y += h + 18
  }

  // alerta do QC normativo
  if (hasError || hasAtyp) {
    const worst = norms.flags[0]
    y = callout(y, {
      tone: hasError ? 'red' : 'orange',
      title: hasError ? 'Verificar a segmentação' : 'Achados atípicos no QC normativo',
      body: hasError
        ? `${worst.pt}: z ${fmtZ(worst.z)} — um desvio de ${Math.abs(worst.z).toFixed(0)} DP do previsto para idade e sexo sugere erro de segmentação. Confira a sobreposição antes de usar os números.`
        : `${norms.flags.length} medida(s) com |z| >= 3 (a mais extrema: ${worst.pt}, z ${fmtZ(worst.z)}). Reveja a segmentação sobre a imagem.`
    })
  }
  if (meta.icv && meta.icv.aviso) {
    y = callout(y, { tone: 'orange', title: 'Volume intracraniano — atenção', body: meta.icv.aviso })
  }

  // captura do visualizador com cantos arredondados — dimensionada para deixar
  // espaço aos mostradores logo abaixo
  const kpis = stats.composites.filter(c => ['BrainSegVol', 'CortexVol', 'CerebralWhiteMatterVol', 'VentricleVol'].includes(c.id)).slice(0, 4)
  if (snapshot && snapshot.bytes) {
    const room = BOTTOM - y - 34 - (kpis.length ? 100 : 0)
    const scale = Math.min(CW / snapshot.w, Math.min(300, room) / snapshot.h)
    const w = snapshot.w * scale; const h = snapshot.h * scale
    if (h >= 120) {
      const x = M + (CW - w) / 2
      pdf.jpeg(snapshot.bytes, x, y, w, h, snapshot.w, snapshot.h, RADIUS)
      y += h + 12
      T(W / 2, y, 'Segmentação sobreposta ao volume de análise', 7.2, { color: TERT, align: 'center' })
      y += 22
    }
  }

  // mostradores dos agregados principais
  if (kpis.length && y + 90 <= BOTTOM) {
    const gap = 10
    const kw = (CW - (kpis.length - 1) * gap) / kpis.length
    kpis.forEach((c, i) => {
      const x = M + i * (kw + gap)
      card(x, y, kw, 86)
      const lab = wrap(c.ptName.replace(/\s*\(.*\)$/, ''), 7.3, kw - 24).slice(0, 2)
      lab.forEach((ln, li) => T(x + 12, y + 17 + li * 9.5, ln, 7.3, { color: SECOND }))
      const v = fmtCm3(c.volMm3)
      T(x + 12, y + 58, v, 20, { bold: true })
      T(x + 14 + TW(v, 20, { bold: true }), y + 58, 'cm³', 8, { color: SECOND })
      T(x + 12, y + 74, vic ? `${(100 * c.volMm3 / vic).toFixed(1).replace('.', ',')}% do VIC` : `${c.pctBrain.toFixed(1).replace('.', ',')}% do total rotulado`, 6.8, { color: TERT })
    })
    y += 100
  }

  // ================= QC automático da segmentação =================
  if (meta.qc && meta.qc.grupos && meta.qc.grupos.length) {
    const rq = meta.qc.resumo || {}
    y = newPage('QC da segmentação', 'Escore automático por grupo tecidual')
    const alert = rq.gruposEmAlerta && rq.gruposEmAlerta.length
    // resumo em dois mostradores
    const kw = (CW - 10) / 2
    ;[['Escore mínimo', rq.escoreMinimo], ['Escore médio', rq.escoreMedio]].forEach(([k, v], i) => {
      const x = M + i * (kw + 10)
      card(x, y, kw, 62)
      T(x + 14, y + 19, k, 7.5, { color: SECOND })
      T(x + 14, y + 46, fmtN(v ?? 0), 22, { bold: true, color: i === 0 && alert ? RED : INK })
    })
    y += 78
    const cq = [
      { label: 'Grupo', x: M },
      { label: 'Escore', x: M + 226 },
      { label: '', x: M + 262 },
      { label: 'Conf.', x: M + 399, align: 'right' },
      { label: 'Coesão', x: M + 443, align: 'right' },
      { label: 'Simetria', x: W - M, align: 'right' }
    ]
    y = table(y, cq, meta.qc.grupos.filter(g => g.voxels > 0), {
      rowH: 16,
      contTitle: 'QC da segmentação (cont.)',
      drawRow: (q, yy) => {
        const bad = q.alerta
        T(M, yy, clip(q.pt, 40), 8.6, { color: bad ? RED : INK, bold: !!bad })
        T(M + 226, yy, fmtN(q.escore), 8.6, { bold: true, color: bad ? RED : INK })
        const bx = M + 262; const bw = 100
        pdf.setColor(...TRACK); pdf.roundRect(bx, yy - 6, bw, 5, 2.5, true)
        pdf.setColor(...(bad ? RED : GREEN)); pdf.roundRect(bx, yy - 6, Math.max(5, bw * Math.max(0, Math.min(1, q.escore))), 5, 2.5, true)
        T(M + 399, yy, fmtN(q.confianca), 8.3, { color: SECOND, align: 'right' })
        T(M + 443, yy, fmtN(q.coesao), 8.3, { color: SECOND, align: 'right' })
        T(W - M, yy, fmtN(q.simetria), 8.3, { color: SECOND, align: 'right' })
      }
    })
    y = callout(y + 6, {
      tone: alert ? 'red' : 'blue',
      title: alert ? `Em alerta: ${rq.gruposEmAlerta.join(', ')}` : 'Nenhum grupo abaixo do corte de 0,65',
      body: [
        'Escore = confiança (posterior máxima da rede) × coesão (maior componente conexo) × simetria (excesso E/D). ' +
        'Grupos e nomes seguem o regressor de QC do SynthSeg 2.0; o escore é próprio e NÃO é o Dice predito daquele regressor. ' +
        'Corte de referência 0,65 (Billot et al., PNAS 2023) — calibre o seu na coorte.' +
        (rq.confiancaDisponivel === false ? ' Rede sem posteriores: confiança neutra nesta execução.' : '')
      ],
      contTitle: 'QC da segmentação (cont.)'
    })
  }

  // ================= comparação normativa =================
  y = newPage('Comparação normativa', norms
    ? `${norms.age} anos · sexo ${norms.sex === 'M' ? 'masculino' : 'feminino'} · percentil e z do valor previsto para idade e sexo`
    : 'Percentis e z-scores ajustados por idade e sexo')
  if (!norms) {
    y = callout(y, {
      tone: 'blue',
      title: 'Informe idade e sexo',
      body: 'Com idade e sexo preenchidos no aplicativo, os volumes são comparados às curvas de referência (Bethlehem et al., Nature 2022; CentileBrain para as estruturas subcorticais).'
    })
  } else {
    if (norms.foraDaFaixaEtaria) {
      y = callout(y, { tone: 'orange', title: 'Idade fora da faixa das curvas', body: 'Fora de 1–100 anos é usada a curva da borda, sem extrapolação — interprete com cautela.' })
    }
    // legenda do medidor
    T(W - M, y - 8, 'Medidor: faixa azul P5–P95 · traço na mediana · ponto = este exame', 7, { color: TERT, align: 'right' })
    y += 6
    const tableNorm = (title, note, rows) => {
      if (!rows.length) return
      if (y + 80 > BOTTOM) y = newPage('Comparação normativa (cont.)')
      y = sectionTitle(y, title, note)
      const cols = [
        { label: 'Medida', x: M },
        { label: 'cm³', x: M + 246, align: 'right' },
        { label: 'Mediana', x: M + 296, align: 'right' },
        { label: 'P', x: M + 326, align: 'right' },
        { label: 'z', x: M + 368, align: 'right' },
        { label: 'P5 · P50 · P95', x: M + 386 }
      ]
      for (const g of rows) g.__extraH = g.flag ? 11 : 0
      y = table(y, cols, rows, {
        rowH: 17,
        contTitle: 'Comparação normativa (cont.)',
        drawRow: (g, yy) => {
          const tone = g.flag === 'erro?' ? 'red' : g.flag ? 'orange' : null
          const tc = tone ? TONES[tone].ink : INK
          T(M, yy, clip(g.pt, 42), 8.6, { color: tc, bold: !!tone })
          T(M + 246, yy, fmtCm3(g.value), 8.6, { align: 'right' })
          T(M + 296, yy, g.median != null ? fmtCm3(g.median) : (g.mean != null ? fmtCm3(g.mean) : '—'), 8.6, { color: SECOND, align: 'right' })
          T(M + 326, yy, g.percentile != null ? fmtP(g.percentile) : '—', 8.6, { align: 'right' })
          T(M + 368, yy, g.z != null ? fmtZ(g.z) : '—', 8.6, { color: tc, bold: !!tone, align: 'right' })
          if (g.percentile != null) gauge(M + 386, yy, W - M - (M + 386), g.percentile, tone)
          if (tone) T(M + 8, yy + 11, g.flag === 'erro?' ? 'Desvio extremo — possível erro de segmentação' : 'Fora do intervalo típico (|z| >= 3)', 7.2, { color: tc })
        }
      })
      y += 12
    }
    tableNorm('Volumes globais', null, norms.globals)
    tableNorm('Lobos corticais', 'Volume por hemisfério; z conservador pela soma das parcelas.', norms.lobes)
    if (norms.subcorticais && norms.subcorticais.length) {
      tableNorm('Estruturas subcorticais', 'CentileBrain (ENIGMA Lifespan) · por hemisfério e sexo.', norms.subcorticais)
      const info = norms.subcorticalInfo || {}
      y = callout(y, {
        tone: 'blue',
        title: 'Sobre as normas subcorticais',
        body: [
          'Fonte: CentileBrain (Ge et al., Lancet Digit Health 2024;6:e211–e221), grupo ENIGMA Lifespan (Dima et al., Hum Brain Mapp 2022).',
          ...(info.avisos || []),
          ...(info.foraDaFaixaEtaria ? [`Idade fora da faixa de treino (${(info.faixaTreino || []).map(v => v.toFixed(0)).join('–')} anos): usada a curva da borda.`] : [])
        ],
        contTitle: 'Comparação normativa (cont.)'
      })
    }
  }

  // ================= volumes por região: lobo × hemisfério, IA como coluna =================
  {
    const secs = regionSections(stats.rows)
    const nPar = secs.reduce((a, sct) => a + sct.itens.length, 0)
    y = newPage('Volumes por região', `Esquerdo e direito lado a lado · mm³ por contagem de voxels${vic ? ` · VIC (eTIV) ${fmtCm3(vic)} cm³` : ''}`)
    const X = { e: M + 244, d: M + 306, t: M + 372, p: M + 428, ia: W - M }
    const cols = [
      { label: 'Região', x: M },
      { label: 'Esquerdo', x: X.e, align: 'right' },
      { label: 'Direito', x: X.d, align: 'right' },
      { label: 'Total', x: X.t, align: 'right' },
      { label: vic ? '% VIC' : '% rot.', x: X.p, align: 'right' },
      { label: 'IA %', x: X.ia, align: 'right' }
    ]
    const den = vic || stats.brainVol
    const fIA = (e, d) => e > 0 && d > 0 ? 200 * (e - d) / (e + d) : null
    const cells = (o, yy, size, weight, colorNum) => {
      const tot = (o.E || 0) + (o.D || 0) + (o.M || 0)
      if (o.E != null) T(X.e, yy, fmtMm3(o.E), size, { weight, align: 'right', color: colorNum })
      if (o.D != null) T(X.d, yy, fmtMm3(o.D), size, { weight, align: 'right', color: colorNum })
      T(X.t, yy, fmtMm3(tot), size, { weight: weight === 400 ? 600 : weight, align: 'right' })
      if (den) T(X.p, yy, (100 * tot / den).toFixed(tot / den >= 0.1 ? 1 : 2).replace('.', ','), size, { weight, align: 'right', color: SECOND })
      const ia = fIA(o.E, o.D)
      if (ia != null) {
        const big = Math.abs(ia) > 10
        T(X.ia, yy, (ia >= 0 ? '+' : '−') + Math.abs(ia).toFixed(1).replace('.', ','), size, { weight: big ? 600 : weight, align: 'right', color: big ? ORANGE : SECOND })
      }
    }
    // linhas: cabeçalho de seção (com subtotais) + regiões; a 1ª de cada seção leva a altura extra
    const items = []
    for (const sct of secs) {
      // seção de uma estrutura só: a própria linha de título leva os valores
      if (sct.itens.length === 1) items.push({ sct, it: sct.itens[0], solo: true, __extraH: 16 })
      else sct.itens.forEach((it, i) => items.push({ sct, it, first: i === 0, __extraH: i === 0 ? 30 : 0 }))
    }
    y = table(y, cols, items, {
      rowH: 14.2,
      contTitle: 'Volumes por região (cont.)',
      drawRow: ({ sct, it, first, solo }, yy) => {
        if (solo) {
          T(M, yy + 10, it.nome, 10, { weight: 600 })
          cells(it, yy + 10, 8.4, 600, INK)
          return
        }
        if (first) {
          T(M, yy + 10, sct.titulo, 10, { weight: 600 })
          if (sct.subtotal) cells(sct.subtotal, yy + 10, 8.4, 600, INK)
          hair(yy + 16, HAIR2, M, W - M, 0.5)
        }
        const ry = first ? yy + 30 : yy
        T(M + 10, ry, clip(it.nome, 44), 8.3)
        cells(it, ry, 8.3, 400, INK)
      }
    })
    y = para(M, y + 4, `IA = 200 · (E − D) / (E + D): positivo = esquerda maior; em laranja, |IA| > 10%. ${nPar} regiões; as parcelas DKT são agrupadas por lobo com o cíngulo anterior no frontal e o posterior e o istmo no parietal. "% ${vic ? 'VIC' : 'rot.'}" = total da região sobre o ${vic ? 'volume intracraniano estimado' : 'total rotulado'}.`, 7.3, CW, { color: TERT, lead: 10.5 })
  }

  // ================= espessura cortical volumétrica =================
  if (meta.espessura && meta.espessura.regioes && meta.espessura.regioes.length) {
    y = newPage('Espessura cortical', 'Volumétrica, por região DKT · média ponderada por área ± DP (área e medianas no CSV/JSON)')
    y = callout(y, { tone: 'orange', title: 'Sobre o método — leia antes de usar', body: AVISO_ESPESSURA })
    // mostradores por hemisfério
    const hh = meta.espessura.hemisferios || {}
    const qh = (meta.espessura.qc && meta.espessura.qc.hemisferios) || {}
    const tiles = [
      ['Hemisfério esquerdo', hh.lh, qh.lh],
      ['Hemisfério direito', hh.rh, qh.rh]
    ].filter(t => t[1])
    if (tiles.length) {
      const kw = (CW - 10 * (tiles.length - 1)) / tiles.length
      tiles.forEach(([k, h, q], i) => {
        const x = M + i * (kw + 10)
        card(x, y, kw, 58)
        T(x + 14, y + 16, k, 7.5, { color: SECOND })
        const v = fmtN(h.espessura_media_mm)
        T(x + 14, y + 38, v, 20, { bold: true })
        T(x + 16 + TW(v, 20, { bold: true }), y + 38, 'mm', 8, { color: SECOND })
        T(x + 14, y + 51, `mediana ${fmtN(h.espessura_mediana_mm)} mm` + (q && q.frac_truncados_5mm != null ? ` · ${(100 * q.frac_truncados_5mm).toFixed(1).replace('.', ',')}% no teto de 5 mm` : ''), 6.8, { color: TERT })
      })
      y += 72
    }
    // uma linha por região, E e D lado a lado, com régua 1–4,5 mm
    const byReg = new Map()
    for (const r of meta.espessura.regioes) {
      const k = r.parcela || r.name
      if (!byReg.has(k)) byReg.set(k, { nome: (r.pt || r.parcela || '').replace(/ — (esquerd|direit)[oa]$/, ''), E: null, D: null })
      byReg.get(k)[r.hemi === 'lh' || r.hemi === 'E' ? 'E' : 'D'] = r
    }
    // agrupadas por lobo, na mesma ordem da seção de volumes
    const regs = [...byReg.values()]
      .map(g => ({ ...g, lobo: lobeOf((g.E || g.D).name) }))
      .sort((a, b) => (LOBO_ORDEM.indexOf(a.lobo) - LOBO_ORDEM.indexOf(b.lobo)) || a.nome.localeCompare(b.nome, 'pt-BR'))
    regs.forEach((g, i) => { g.first = i === 0 || regs[i - 1].lobo !== g.lobo; g.__extraH = g.first ? 22 : 0 })
    const sx = M + 344; const sw = W - M - sx
    const lo = 1; const hi = 4.5
    const px = (v) => sx + sw * Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
    const cols = [
      { label: 'Região', x: M },
      { label: 'Esquerdo (mm)', x: M + 214, align: 'right' },
      { label: 'Direito (mm)', x: M + 312, align: 'right' },
      { label: '1 — 4,5 mm', x: sx }
    ]
    // legenda dos pontos no próprio cabeçalho da régua
    pdf.setColor(...BLUE); pdf.circle(W - M - 58, y - 2.4, 2.6, true)
    T(W - M - 53, y, 'E', 6.5, { bold: true, color: SECOND })
    pdf.setColor(...TERT); pdf.circle(W - M - 30, y - 2.4, 2.6, true)
    T(W - M - 25, y, 'D', 6.5, { bold: true, color: SECOND })
    const ms = (r) => r ? `${fmtN(r.espessura_media_mm)} ± ${fmtN(r.espessura_dp_mm)}` : '—'
    y = table(y, cols, regs, {
      rowH: 13.4,
      contTitle: 'Espessura cortical (cont.)',
      drawRow: (g, yy) => {
        if (g.first) T(M, yy + 8, LOBO_TIT[g.lobo] || 'Outras regiões', 9.5, { weight: 600 })
        const ry = g.first ? yy + 22 : yy
        T(M + 10, ry, clip(g.nome, 36), 8.2)
        T(M + 214, ry, ms(g.E), 8.2, { align: 'right' })
        T(M + 312, ry, ms(g.D), 8.2, { align: 'right', color: SECOND })
        pdf.setColor(...TRACK); pdf.roundRect(sx, ry - 5, sw, 3, 1.5, true)
        if (g.D && isFinite(g.D.espessura_media_mm)) { pdf.setColor(...TERT); pdf.circle(px(g.D.espessura_media_mm), ry - 3.5, 3, true) }
        if (g.E && isFinite(g.E.espessura_media_mm)) { pdf.setColor(...BLUE); pdf.circle(px(g.E.espessura_media_mm), ry - 3.5, 3, true) }
      }
    })
  }

  // ================= superfície cortical (malha; só com SURF_EXPORT) =================
  if (meta.surf && meta.surf.regioes && meta.surf.regioes.length) {
    y = newPage('Superfície cortical', 'Espessura e área pela malha')
    const eu = meta.surf.euler
    y = callout(y, {
      tone: 'orange',
      title: 'Malha experimental',
      body: `Fluxo recon-all-clinical no navegador: SDFs white/pial (${meta.surf.motorSdf || 'SDF por EDT'}) → colocação pela energia do artigo (Gopinath 2025) → espessura Fischl & Dale (teto de 5 mm). Sem mris_fix_topology/sphere.reg. Característica de Euler (esfera = 2): E = ${eu && eu.lh !== undefined ? eu.lh : '—'} · D = ${eu && eu.rh !== undefined ? eu.rh : '—'}.`
    })
    const cols = [
      { label: 'Região', x: M },
      { label: 'H', x: M + 200 },
      { label: 'Espessura (mm)', x: M + 320, align: 'right' },
      { label: 'Área (cm²)', x: M + 400, align: 'right' },
      { label: 'Volume (cm³)', x: W - M, align: 'right' }
    ]
    const f = (v, d, k = 1) => v == null || !isFinite(v) ? '—' : (v / k).toFixed(d).replace('.', ',')
    y = table(y, cols, meta.surf.regioes, {
      rowH: 14.5,
      contTitle: 'Superfície cortical (cont.)',
      drawRow: (r, yy) => {
        T(M, yy, clip((r.pt || r.base).replace(/ — (esquerd|direit)[oa]$/, ''), 38), 8.3)
        T(M + 200, yy, r.hemi, 8.3, { color: SECOND })
        T(M + 320, yy, `${f(r.thickAvg, 2)} ± ${f(r.thickStd, 2)}`, 8.3, { align: 'right' })
        T(M + 400, yy, f(r.area_mm2, 1, 100), 8.3, { align: 'right' })
        T(W - M, yy, f(r.volume_mm3, 1, 1000), 8.3, { align: 'right' })
      }
    })
  }

  // ================= métodos e ressalvas =================
  y = newPage('Métodos e ressalvas')
  const paras = [
    ['Medida', `Imagem conformada a 256³ voxels de 1 mm (estilo FreeSurfer). Segmentação: ${meta.model || '—'}, executada localmente no navegador. Volume = contagem de voxels rotulados × volume do voxel (|det| da affine). Agregados com nomes do FreeSurfer seguem as definições do FreeSurfer 7 (BrainSegVol exclui o tronco encefálico e inclui o líquor; CerebralWhiteMatterVol inclui o corpo caloso), aproximadas por voxels — CortexVol aqui é a soma dos rótulos corticais, não pial − white. O SynthSeg oficial soma posteriores (volume suave): diferenças de 1–3% são esperadas. Hemisférios: ${stats.hemiMethod}.`],
    ...(vic ? [['Volume intracraniano', 'eTIV por registro afim de 12 parâmetros ao template MNI152 2009c (correlação normalizada; resoluções de 8, 4 e 2 mm): VIC = 2 172 000 mm³ × det(A), na escala do eTIV do FreeSurfer (Buckner et al., NeuroImage 2004). Em 31 adultos: r = 0,92 com o eTIV do FreeSurfer, erro individual típico de 3–4% — prefira-o como covariável em análises de grupo.']] : []),
    ['Comparação normativa', 'Percentis e z-scores das curvas populacionais dos brain charts (Bethlehem et al., Nature 2022) — modelos GAMLSS ajustados por idade e sexo, na versão-base do estudo, sem efeito de sítio. Estruturas subcorticais: modelos GAMLSS do CentileBrain (Ge et al., Lancet Digit Health 2024), por hemisfério e sexo. As normas foram estimadas em volumes do FreeSurfer; os deste relatório vêm do SynthSeg/DKT — a comparação é uma APROXIMAÇÃO útil para triagem e controle de qualidade, não para uso clínico. Lobos: DP = soma dos DP das parcelas (z conservador).'],
    ['Bandeiras de QC', 'z é o desvio do valor previsto para idade e sexo. |z| >= 3 marca achado atípico; |z| >= 4 é tratado como possível erro de segmentação — desvios dessa magnitude quase sempre indicam falha técnica (máscara, contraste fora do domínio, movimento) e exigem inspeção visual da sobreposição.'],
    ...(meta.espessura ? [['Espessura cortical', AVISO_ESPESSURA]] : []),
    ['Privacidade', 'Nenhuma imagem sai do dispositivo: conversão DICOM › NIfTI (dcm2niix WASM), segmentação, estatísticas e este relatório são gerados localmente.'],
    ['Créditos', 'SynthSeg — Billot, Iglesias e col. (Apache 2.0); FastSurfer — Henschel, Reuter e col. (Apache 2.0); brainchop/brain2print — Masoud, Hu, Plis; grupo de C. Rorden (MIT); NiiVue; dcm2niix; brain charts — Bethlehem, Seidlitz e col. (Nature 2022); CentileBrain — Ge e col. (2024); MNI152 2009c — Fonov, Collins e col. (MNI/McGill). Cite os artigos originais em trabalhos que usem estes números.']
  ]
  for (const [t, body] of paras) {
    const need = 22 + paraHeight(body, 8.8, CW, 13.2)
    if (y + Math.min(need, 80) > BOTTOM) y = newPage('Métodos e ressalvas (cont.)')
    T(M, y, t, 11, { weight: 600 }); y += 16
    for (const ln of wrap(body, 8.8, CW)) {
      if (y > BOTTOM) y = newPage('Métodos e ressalvas (cont.)')
      T(M, y, ln, 8.8, { color: SECOND }); y += 13.2
    }
    y += 12
  }

  const total = pdf.pages.length
  for (let p = 0; p < total; p++) {
    pdf.cur = pdf.pages[p]
    footer(p + 1, total)
  }
  return pdf.build()
}
