// Relatório PDF: capa com o visualizador, régua de qualidade, pipeline, agregados,
// tabela de estruturas, assimetria e página de métodos com as ressalvas.

import { PDF, wrapText, textWidth } from './pdf.js'
import { GROUP_PT } from './labels.js'

const INK = [0.13, 0.13, 0.14]
const DIM = [0.45, 0.47, 0.49]
const LINE = [0.82, 0.83, 0.84]
const ACCENT = [0.72, 0.26, 0.22]   // vermelho-córtex
const M = 52                        // margem

export function buildReport ({ stats, meta, snapshot }) {
  const pdf = new PDF()
  let y = 0

  const header = (title) => {
    pdf.setColor(...ACCENT)
    pdf.rect(M, 40, 22, 3, true)
    pdf.text(M, 62, 'SegmentaRM — morfometria no navegador', 8, { color: DIM })
    pdf.text(pdf.pageW - M - textWidth(meta.date, 8), 62, meta.date, 8, { color: DIM })
    pdf.text(M, 92, title, 20, { bold: true, color: INK })
    return 118
  }
  const footer = (n, total) => {
    pdf.text(M, pdf.pageH - 30, 'Uso em pesquisa e ensino — não é dispositivo médico e não substitui leitura radiológica.', 7.5, { color: DIM })
    const pg = `${n} / ${total}`
    pdf.text(pdf.pageW - M - textWidth(pg, 8), pdf.pageH - 30, pg, 8, { color: DIM })
  }
  const rule = (yy) => { pdf.setColor(...LINE); pdf.setLineWidth(0.6); pdf.line(M, yy, pdf.pageW - M, yy) }
  const kv = (yy, k, v) => {
    pdf.text(M, yy, k, 8.5, { color: DIM })
    pdf.text(M + 170, yy, String(v), 9.5, { color: INK })
    return yy + 16
  }
  const fmtV = (x) => (x >= 10000 ? (x / 1000).toFixed(1) + ' cm³' : Math.round(x).toLocaleString('pt-BR') + ' mm³')

  // ---------- página 1: capa ----------
  y = header('Relatório volumétrico')
  y = kv(y, 'Exame', meta.subject || '—')
  y = kv(y, 'Entrada', meta.input || '—')
  if (meta.quality) {
    y = kv(y, 'Qualidade da entrada', `nível ${meta.quality.grade} — ${meta.quality.gradeTxt}`)
    y = kv(y, 'Voxel original', meta.quality.voxel.map(v => v.toFixed(2)).join(' × ') + ' mm')
  }
  y = kv(y, 'Pipeline', meta.pipeline || '—')
  y = kv(y, 'Modelo', meta.model || '—')
  y += 6
  rule(y); y += 18

  if (snapshot && snapshot.bytes) {
    const maxW = pdf.pageW - 2 * M
    const scale = Math.min(maxW / snapshot.w, 300 / snapshot.h)
    const w = snapshot.w * scale, h = snapshot.h * scale
    pdf.jpeg(snapshot.bytes, M + (maxW - w) / 2, y, w, h, snapshot.w, snapshot.h)
    y += h + 10
    pdf.text(M, y, 'Segmentação sobreposta à imagem conformada (256³, 1 mm).', 8, { color: DIM })
    y += 22
  }

  pdf.text(M, y, 'Agregados', 12, { bold: true, color: INK }); y += 18
  for (const c of stats.composites) {
    if (y > pdf.pageH - 80) break
    pdf.text(M, y, c.ptName, 9, { color: INK })
    const v = fmtV(c.volMm3)
    pdf.text(pdf.pageW - M - textWidth(v, 9, true), y, v, 9, { bold: true, color: INK })
    pdf.setColor(...LINE); pdf.setLineWidth(0.4)
    pdf.line(M, y + 4, pdf.pageW - M, y + 4)
    y += 16
  }

  // ---------- página 2: qualidade + assimetria ----------
  pdf.newPage()
  y = header('Qualidade e assimetria')
  if (meta.quality) {
    pdf.text(M, y, 'Régua de qualidade', 12, { bold: true, color: INK }); y += 8
    // régua A–D
    const rw = (pdf.pageW - 2 * M) / 4
    const grades = ['A', 'B', 'C', 'D']
    y += 10
    for (let i = 0; i < 4; i++) {
      const active = grades[i] === meta.quality.grade
      pdf.setColor(...(active ? ACCENT : LINE))
      pdf.rect(M + i * rw, y, rw - 4, 8, true)
      pdf.text(M + i * rw, y + 22, grades[i], 9, { bold: active, color: active ? ACCENT : DIM })
    }
    y += 38
    for (const f of meta.quality.findings) {
      const lines = wrapText((f.bad ? '• ' : '· ') + f.txt, 9, pdf.pageW - 2 * M)
      for (const ln of lines) {
        pdf.text(M, y, ln, 9, { color: f.bad ? ACCENT : INK })
        y += 13
      }
    }
    y += 10; rule(y); y += 20
  }

  pdf.text(M, y, 'Índice de assimetria — IA = 200·(E−D)/(E+D)', 12, { bold: true, color: INK }); y += 20
  const pairs = stats.pairs.slice(0, 28)
  const mid = pdf.pageW / 2
  const half = (pdf.pageW - 2 * M) / 2 - 30
  const maxAI = Math.max(10, ...pairs.map(p => Math.abs(p.ai)))
  for (const p of pairs) {
    if (y > pdf.pageH - 70) break
    const name = p.ptName.length > 38 ? p.ptName.slice(0, 37) + '…' : p.ptName
    pdf.text(M, y, name, 8, { color: INK })
    const w = Math.abs(p.ai) / maxAI * half
    pdf.setColor(...(Math.abs(p.ai) > 10 ? ACCENT : DIM))
    if (p.ai >= 0) pdf.rect(mid, y - 7, Math.max(1, w), 7, true)   // E maior → barra à direita do eixo
    else pdf.rect(mid - w, y - 7, Math.max(1, w), 7, true)
    const t = p.ai.toFixed(1) + '%'
    pdf.text(pdf.pageW - M - textWidth(t, 8), y, t, 8, { color: INK })
    y += 14
  }
  pdf.setColor(...LINE); pdf.setLineWidth(0.6)
  pdf.line(mid, y - pairs.length * 14 - 8, mid, y - 6)

  // ---------- páginas de tabela ----------
  const rows = stats.rows.filter(r => r.group !== 'fundo' && r.volMm3 > 0)
  let page = 0
  let i = 0
  while (i < rows.length) {
    pdf.newPage()
    y = header(page === 0 ? 'Volumes por estrutura' : 'Volumes por estrutura (continuação)')
    // cabeçalho da tabela
    pdf.text(M, y, 'Estrutura', 8, { bold: true, color: DIM })
    pdf.text(mid + 30, y, 'Grupo', 8, { bold: true, color: DIM })
    const h1 = 'Volume (mm³)'; const h2 = '% encéfalo'
    pdf.text(pdf.pageW - M - 150 - textWidth(h1, 8, true), y, h1, 8, { bold: true, color: DIM })
    pdf.text(pdf.pageW - M - textWidth(h2, 8, true), y, h2, 8, { bold: true, color: DIM })
    y += 6; rule(y); y += 14
    let lastGroup = null
    while (i < rows.length && y < pdf.pageH - 60) {
      const r = rows[i]
      if (r.group !== lastGroup) {
        pdf.text(M, y, (GROUP_PT[r.group] || r.group).toUpperCase(), 7.5, { bold: true, color: ACCENT })
        y += 13
        lastGroup = r.group
      }
      const nm = r.ptName.length > 46 ? r.ptName.slice(0, 45) + '…' : r.ptName
      pdf.text(M + 6, y, nm, 8.5, { color: INK })
      const v1 = Math.round(r.volMm3).toLocaleString('pt-BR')
      const v2 = r.pctBrain.toFixed(2)
      pdf.text(pdf.pageW - M - 150 - textWidth(v1, 8.5), y, v1, 8.5, { color: INK })
      pdf.text(pdf.pageW - M - textWidth(v2, 8.5), y, v2, 8.5, { color: INK })
      y += 13
      i++
    }
    page++
    if (page > 12) break
  }

  // ---------- métodos ----------
  pdf.newPage()
  y = header('Métodos e ressalvas')
  const paras = [
    ['Como o volume foi medido', `A imagem foi conformada à grade de 256³ voxels de 1 mm (reamostragem ${meta.pipeline && meta.pipeline.includes('robusto') ? 'cúbica no modo robusto e ' : ''}linear na conformação, normalização robusta de intensidade), no espírito do conform do FreeSurfer. A segmentação usa o modelo ${meta.model || '—'} da família brainchop (MeshNet, TensorFlow.js), executado inteiramente no navegador. O volume de cada estrutura é a contagem de voxels rotulados em mm³.`],
    ['Hemisférios', `Divisão por ${stats.hemiMethod}.`],
    ['Modo robusto', 'Quando a entrada é anisotrópica ou de baixa qualidade, o aplicativo reamostra os eixos espessos com interpolação cúbica (Catmull-Rom), aplica correção homomórfica de campo de viés e suavização leve antes da conformação. É uma aproximação clássica, inspirada no papel do SynthSR no recon-all-clinical, mas não é a rede SynthSR: reamostrar não cria informação nova.'],
    ['Ressalvas de interpretação', 'Volumes derivados de exames clínicos anisotrópicos têm erro maior que os de aquisições volumétricas de 1 mm. Use estes números para estudo de grupo e triagem; para inferência individual seja conservador e reporte sempre a sequência e a resolução de origem. Os modelos foram treinados em T1: sequências T2/FLAIR degradam o resultado.'],
    ['Privacidade', 'Nenhuma imagem sai do dispositivo: conversão DICOM→NIfTI (dcm2niix WASM), segmentação e estatísticas rodam localmente.'],
    ['Créditos', 'brainchop (Masoud, Hu & Plis) e brain2print (grupo de Chris Rorden) — modelos MIT; NiiVue; dcm2niix (Rorden). Linhagem conceitual: SynthSeg/SynthSR/recon-all-clinical (Billot, Gopinath, Iglesias e colaboradores, Martinos Center).']
  ]
  for (const [t, body] of paras) {
    pdf.text(M, y, t, 11, { bold: true, color: INK }); y += 16
    for (const ln of wrapText(body, 9.5, pdf.pageW - 2 * M)) {
      pdf.text(M, y, ln, 9.5, { color: INK }); y += 13.5
    }
    y += 10
  }

  // rodapés com total correto
  const total = pdf.pages.length
  for (let p = 0; p < total; p++) {
    pdf.cur = pdf.pages[p]
    footer(p + 1, total)
  }
  return pdf.build()
}
