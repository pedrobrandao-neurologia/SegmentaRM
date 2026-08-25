// Relatório PDF do SegmentaRM — diagramação de impresso no espírito apple-design:
// tinta quase-preta sobre papel, hierarquia tipográfica com muito respiro, fios
// finos, painéis de preenchimento suave e o vermelho-córtex usado com parcimônia.
// Seções: capa (com QC normativo em destaque quando houver flag) · comparação
// normativa com medidores de percentil · lobos corticais · estruturas · assimetria
// · métodos e ressalvas.

import { PDF, wrapText, textWidth } from './pdf.js'
import { GROUP_PT } from './labels.js'

const INK = [0.114, 0.114, 0.122]        // #1D1D1F
const GRAY = [0.42, 0.42, 0.45]          // #6E6E73
const HAIR = [0.824, 0.824, 0.843]       // #D2D2D7
const PANEL = [0.961, 0.961, 0.969]      // #F5F5F7
const ACCENT = [0.71, 0.263, 0.227]      // vermelho-córtex
const OKGREEN = [0.24, 0.55, 0.38]
const WARN = [0.72, 0.53, 0.13]
const M = 56                              // margem generosa

const fmtCm3 = (v) => (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })
const fmtMm3 = (v) => Math.round(v).toLocaleString('pt-BR')
const fmtZ = (z) => (z >= 0 ? '+' : '-') + Math.abs(z).toFixed(2)
const fmtP = (p) => p < 1 ? p.toFixed(1) : p > 99 ? p.toFixed(1) : Math.round(p).toString()

export function buildReport ({ stats, meta, snapshot }) {
  const pdf = new PDF()
  const W = pdf.pageW
  const norms = meta.norms && meta.norms.available ? meta.norms : null
  const hasError = norms && norms.flags.some(f => Math.abs(f.z) >= 4)
  const hasAtyp = norms && norms.flags.length > 0

  // ---------- utilidades de diagramação ----------
  const header = (title, kicker = 'SegmentaRM · Relatório volumétrico') => {
    pdf.setColor(...ACCENT); pdf.rect(M, 42, 20, 2.6, true)
    pdf.text(M + 30, 47, kicker.toUpperCase(), 7, { color: GRAY })
    pdf.text(W - M - textWidth(meta.date, 7), 47, meta.date, 7, { color: GRAY })
    pdf.text(M, 84, title, 22, { bold: true, color: INK })
    return 112
  }
  const footer = (n, total) => {
    pdf.setColor(...HAIR); pdf.setLineWidth(0.5); pdf.line(M, pdf.pageH - 44, W - M, pdf.pageH - 44)
    pdf.text(M, pdf.pageH - 30, 'Uso em pesquisa e ensino — não é dispositivo médico; não substitui leitura radiológica.', 7, { color: GRAY })
    const pg = `${n} de ${total}`
    pdf.text(W - M - textWidth(pg, 7), pdf.pageH - 30, pg, 7, { color: GRAY })
  }
  const sectionLabel = (y, txt) => {
    pdf.text(M, y, txt.toUpperCase(), 7.5, { bold: true, color: ACCENT })
    pdf.setColor(...HAIR); pdf.setLineWidth(0.5)
    pdf.line(M + textWidth(txt.toUpperCase(), 7.5, true) + 10, y - 2.5, W - M, y - 2.5)
    return y + 16
  }
  const hairline = (y) => { pdf.setColor(...HAIR); pdf.setLineWidth(0.4); pdf.line(M, y, W - M, y) }
  const panel = (x, y, w, h, fill = PANEL) => { pdf.setColor(...fill); pdf.rect(x, y, w, h, true) }

  // medidor de percentil: trilho com marcas P5/P50/P95 e ponto no percentil do exame
  const gauge = (x, y, w, pct, flagged) => {
    pdf.setColor(...HAIR); pdf.rect(x, y - 2.6, w, 2.6, true)
    pdf.setColor(0.72, 0.72, 0.75)
    for (const p of [5, 50, 95]) pdf.rect(x + w * p / 100 - 0.4, y - 5, 0.8, 7.5, true)
    const cx = x + w * Math.min(99.5, Math.max(0.5, pct)) / 100
    pdf.setColor(...(flagged ? ACCENT : INK))
    pdf.rect(cx - 2.1, y - 5.2, 4.2, 8, true)
  }

  // ---------- página 1 · capa ----------
  let y = header('Relatório volumétrico')

  // grade de especificações do exame (duas colunas, estilo spec-sheet)
  const spec = [
    ['Exame', meta.subject || '—'],
    ['Idade · sexo', meta.age ? `${meta.age} anos · ${meta.sex === 'M' ? 'masculino' : meta.sex === 'F' ? 'feminino' : '—'}` : 'não informados'],
    ['Entrada', (meta.input || '—').replace(/→/g, '›')],
    ['Qualidade', meta.quality ? `nível ${meta.quality.grade} — ${meta.quality.gradeTxt}` : '—'],
    ['Voxel original', meta.quality ? meta.quality.voxel.map(v => v.toFixed(2)).join(' × ') + ' mm' : '—'],
    ['Pipeline', meta.pipeline || '—'],
    ['Modelo', meta.model || '—']
  ]
  const colW = (W - 2 * M) / 2
  spec.forEach(([k, v], i) => {
    const cx = M + (i % 2) * colW
    const cy = y + Math.floor(i / 2) * 30
    pdf.text(cx, cy, k.toUpperCase(), 6.5, { color: GRAY })
    const lines = wrapText(String(v), 9.5, colW - 18)
    pdf.text(cx, cy + 13, lines[0] || '—', 9.5, { color: INK })
  })
  y += Math.ceil(spec.length / 2) * 30 + 8

  // banner de QC normativo
  if (hasError || hasAtyp) {
    const worst = norms.flags[0]
    const h = 54
    panel(M, y, W - 2 * M, h, hasError ? [0.973, 0.918, 0.91] : [0.976, 0.953, 0.894])
    pdf.setColor(...(hasError ? ACCENT : WARN)); pdf.rect(M, y, 3, h, true)
    pdf.text(M + 16, y + 17, hasError ? 'VERIFICAR SEGMENTAÇÃO' : 'ACHADOS ATÍPICOS NO QC NORMATIVO', 8, { bold: true, color: hasError ? ACCENT : WARN })
    const msg = hasError
      ? `${worst.pt}: z ${fmtZ(worst.z)} — desvio de ${Math.abs(worst.z).toFixed(0)} DP do previsto para idade/sexo sugere erro de segmentação. Confira a sobreposição antes de usar os números.`
      : `${norms.flags.length} medida(s) com |z| >= 3 (pior: ${worst.pt}, z ${fmtZ(worst.z)}). Reveja a segmentação sobre a imagem.`
    const msgLines = wrapText(msg, 8.5, W - 2 * M - 32).slice(0, 2)
    msgLines.forEach((ln, li) => pdf.text(M + 16, y + 30 + li * 11, ln, 8.5, { color: INK }))
    y += h + (msgLines.length > 1 ? 12 : 0) + 14
  }

  // captura do visualizador
  if (snapshot && snapshot.bytes) {
    const maxW = W - 2 * M
    const scale = Math.min(maxW / snapshot.w, (hasError || hasAtyp ? 250 : 290) / snapshot.h)
    const w = snapshot.w * scale; const h = snapshot.h * scale
    const x = M + (maxW - w) / 2
    pdf.setColor(...HAIR); pdf.setLineWidth(0.6); pdf.rect(x - 1, y - 1, w + 2, h + 2)
    pdf.jpeg(snapshot.bytes, x, y, w, h, snapshot.w, snapshot.h)
    y += h + 9
    pdf.text(M, y, 'Segmentação sobreposta ao volume de análise.', 7, { color: GRAY })
    y += 20
  }

  // agregados essenciais em fila de mostradores
  const kpis = stats.composites.filter(c => ['BrainSegVol', 'CortexVol', 'CerebralWhiteMatterVol', 'VentricleVol'].includes(c.id)).slice(0, 4)
  if (kpis.length && y < pdf.pageH - 130) {
    const kw = (W - 2 * M - (kpis.length - 1) * 10) / kpis.length
    kpis.forEach((c, i) => {
      const x = M + i * (kw + 10)
      panel(x, y, kw, 52)
      pdf.text(x + 10, y + 15, c.ptName.length > 30 ? c.ptName.slice(0, 29) + '…' : c.ptName, 6.5, { color: GRAY })
      pdf.text(x + 10, y + 34, fmtCm3(c.volMm3), 15, { bold: true, color: INK })
      pdf.text(x + 12 + textWidth(fmtCm3(c.volMm3), 15, true), y + 34, 'cm³', 7.5, { color: GRAY })
      pdf.text(x + 10, y + 45, c.pctBrain.toFixed(1) + '% do encéfalo', 6.5, { color: GRAY })
    })
    y += 66
  }

  // ---------- página 2 · comparação normativa ----------
  pdf.newPage()
  y = header('Comparação normativa')
  if (!norms) {
    pdf.text(M, y + 8, 'Informe idade e sexo no aplicativo para habilitar percentis e z-scores', 10, { color: GRAY })
    pdf.text(M, y + 24, 'ajustados às curvas de referência (Bethlehem et al., Nature 2022).', 10, { color: GRAY })
  } else {
    pdf.text(M, y, `Referência: ${norms.age} anos, sexo ${norms.sex === 'M' ? 'masculino' : 'feminino'} — curvas GAMLSS dos brain charts (~100 mil exames). P = percentil; z do valor previsto.`, 8.5, { color: GRAY })
    y += 22

    const tableNorm = (title, rows) => {
      if (!rows.length) return
      y = sectionLabel(y, title)
      // cabeçalho
      const cols = { name: M, val: M + 218, med: M + 268, p: M + 318, z: M + 352, gauge: M + 392 }
      pdf.text(cols.name, y, 'MEDIDA', 6.5, { bold: true, color: GRAY })
      pdf.text(cols.val, y, 'CM³', 6.5, { bold: true, color: GRAY })
      pdf.text(cols.med, y, 'MEDIANA', 6.5, { bold: true, color: GRAY })
      pdf.text(cols.p, y, 'P', 6.5, { bold: true, color: GRAY })
      pdf.text(cols.z, y, 'Z', 6.5, { bold: true, color: GRAY })
      pdf.text(cols.gauge, y, 'P1 — P50 — P99', 6.5, { bold: true, color: GRAY })
      y += 5; hairline(y); y += 13
      for (const g of rows) {
        if (y > pdf.pageH - 70) { pdf.newPage(); y = header('Comparação normativa (cont.)') }
        const flagged = !!g.flag
        const nm = g.pt.length > 40 ? g.pt.slice(0, 39) + '…' : g.pt
        pdf.text(cols.name, y, nm, 8.5, { bold: flagged, color: flagged ? ACCENT : INK })
        pdf.text(cols.val, y, fmtCm3(g.value), 8.5, { color: INK })
        pdf.text(cols.med, y, g.median != null ? fmtCm3(g.median) : (g.mean != null ? fmtCm3(g.mean) : '—'), 8.5, { color: GRAY })
        pdf.text(cols.p, y, g.percentile != null ? fmtP(g.percentile) : '—', 8.5, { color: INK })
        pdf.text(cols.z, y, g.z != null ? fmtZ(g.z) : '—', 8.5, { color: flagged ? ACCENT : INK })
        if (g.percentile != null) gauge(cols.gauge, y, W - M - cols.gauge, g.percentile, flagged)
        if (flagged) {
          y += 11
          pdf.text(cols.name + 8, y, g.flag === 'erro?' ? '! desvio extremo — possível erro de segmentação' : '· fora do intervalo típico (|z| >= 3)', 7, { color: g.flag === 'erro?' ? ACCENT : WARN })
        }
        y += 16
      }
      y += 8
    }

    tableNorm('Volumes globais', norms.globals)
    tableNorm('Lobos corticais (volume por hemisfério; z aproximado por soma de parcelas)', norms.lobes)
  }

  // ---------- lobos corticais (volumes, sempre que houver DKT) ----------
  const lobes = stats.lobes || []
  if (lobes.length) {
    if (y > pdf.pageH - 200) { pdf.newPage(); y = header('Lobos corticais') } else { y = sectionLabel(y, 'Volume cortical por lobo') }
    // total bilateral por lobo
    const byLobe = {}
    for (const lb of lobes) {
      byLobe[lb.lobe] = byLobe[lb.lobe] || { E: null, D: null }
      if (lb.hemi === 'E') byLobe[lb.lobe].E = lb.volMm3
      else if (lb.hemi === 'D') byLobe[lb.lobe].D = lb.volMm3
    }
    const colsL = { name: M, e: M + 190, d: M + 260, tot: M + 330, pct: M + 410 }
    pdf.text(colsL.name, y, 'LOBO', 6.5, { bold: true, color: GRAY })
    pdf.text(colsL.e, y, 'ESQ. (CM³)', 6.5, { bold: true, color: GRAY })
    pdf.text(colsL.d, y, 'DIR. (CM³)', 6.5, { bold: true, color: GRAY })
    pdf.text(colsL.tot, y, 'TOTAL (CM³)', 6.5, { bold: true, color: GRAY })
    pdf.text(colsL.pct, y, '% ENCÉFALO', 6.5, { bold: true, color: GRAY })
    y += 5; hairline(y); y += 13
    const order = ['frontal', 'parietal', 'temporal', 'occipital', 'ínsula', 'cíngulo']
    const LOBE_NAME = { frontal: 'Frontal', parietal: 'Parietal', temporal: 'Temporal', occipital: 'Occipital', 'ínsula': 'Ínsula', 'cíngulo': 'Cíngulo' }
    for (const lb of order) {
      const d = byLobe[lb]
      if (!d) continue
      const tot = (d.E || 0) + (d.D || 0)
      pdf.text(colsL.name, y, LOBE_NAME[lb] || lb, 9, { color: INK })
      pdf.text(colsL.e, y, d.E != null ? fmtCm3(d.E) : '—', 9, { color: INK })
      pdf.text(colsL.d, y, d.D != null ? fmtCm3(d.D) : '—', 9, { color: INK })
      pdf.text(colsL.tot, y, fmtCm3(tot), 9, { bold: true, color: INK })
      pdf.text(colsL.pct, y, stats.brainVol ? (100 * tot / stats.brainVol).toFixed(1) : '—', 9, { color: GRAY })
      y += 15
    }
    y += 6
  } else if (!norms) {
    y += 6
    pdf.text(M, y, 'Volumes por lobo exigem a parcelação DKT (passo 04) sobre o resultado SynthSeg.', 8.5, { color: GRAY })
  }

  // ---------- estruturas ----------
  const rows = stats.rows.filter(r => r.group !== 'fundo' && r.volMm3 > 0)
  let i = 0; let page = 0
  while (i < rows.length && page < 12) {
    pdf.newPage()
    y = header(page === 0 ? 'Volumes por estrutura' : 'Volumes por estrutura (cont.)')
    const cols = { name: M, hemi: M + 250, vol: M + 320, pct: M + 400 }
    pdf.text(cols.name, y, 'ESTRUTURA', 6.5, { bold: true, color: GRAY })
    pdf.text(cols.hemi, y, 'HEM.', 6.5, { bold: true, color: GRAY })
    pdf.text(cols.vol, y, 'VOLUME (MM³)', 6.5, { bold: true, color: GRAY })
    pdf.text(cols.pct, y, '% ENCÉFALO', 6.5, { bold: true, color: GRAY })
    y += 5; hairline(y); y += 13
    let lastGroup = null
    while (i < rows.length && y < pdf.pageH - 62) {
      const r = rows[i]
      if (r.group !== lastGroup) {
        pdf.text(cols.name, y, (GROUP_PT[r.group] || r.group).toUpperCase(), 6.8, { bold: true, color: ACCENT })
        y += 13
        lastGroup = r.group
      }
      const nm = r.ptName.length > 52 ? r.ptName.slice(0, 51) + '…' : r.ptName
      pdf.text(cols.name + 6, y, nm, 8.3, { color: INK })
      pdf.text(cols.hemi, y, r.hemi || '—', 8.3, { color: GRAY })
      const v1 = fmtMm3(r.volMm3)
      pdf.text(cols.vol + 60 - textWidth(v1, 8.3), y, v1, 8.3, { color: INK })
      const v2 = r.pctBrain.toFixed(2)
      pdf.text(cols.pct + 44 - textWidth(v2, 8.3), y, v2, 8.3, { color: GRAY })
      y += 12.5
      i++
    }
    page++
  }

  // ---------- assimetria ----------
  if (stats.pairs.length) {
    pdf.newPage()
    y = header('Assimetria — esquerda contra direita')
    pdf.text(M, y, 'IA = 200 · (E - D) / (E + D). Barras à esquerda do eixo: direita maior; à direita: esquerda maior.', 8, { color: GRAY })
    y += 22
    const pairs = stats.pairs.slice(0, 34)
    const mid = W / 2 + 60
    const half = (W - M - mid) - 34
    const maxAI = Math.max(10, ...pairs.map(p => Math.abs(p.ai)))
    for (const p of pairs) {
      if (y > pdf.pageH - 64) break
      const name = p.ptName.length > 42 ? p.ptName.slice(0, 41) + '…' : p.ptName
      pdf.text(M, y, name, 8, { color: INK })
      const w = Math.abs(p.ai) / maxAI * half
      pdf.setColor(...(Math.abs(p.ai) > 10 ? ACCENT : [0.6, 0.6, 0.63]))
      if (p.ai >= 0) pdf.rect(mid, y - 6.5, Math.max(1, w), 6.5, true)
      else pdf.rect(mid - w, y - 6.5, Math.max(1, w), 6.5, true)
      const t = (p.ai >= 0 ? '+' : '-') + Math.abs(p.ai).toFixed(1) + '%'
      pdf.text(W - M - textWidth(t, 7.5), y, t, 7.5, { color: Math.abs(p.ai) > 10 ? ACCENT : GRAY })
      y += 13.5
    }
    pdf.setColor(...HAIR); pdf.setLineWidth(0.6)
    pdf.line(mid, 118, mid, y - 4)
  }

  // ---------- superfície cortical (espessura/área por região DKT) ----------
  if (meta.surf && meta.surf.regioes && meta.surf.regioes.length) {
    pdf.newPage()
    y = header('Superfície cortical — espessura e área')
    pdf.text(M, y, 'Malhas white/pial reconstruídas da parcelação DKT (surface nets + suavização de Taubin);', 8.5, { color: GRAY })
    y += 11
    pdf.text(M, y, 'espessura por transformada de distância — aproximação, não é o mris_place_surface do FreeSurfer.', 8.5, { color: GRAY })
    y += 18
    y = sectionLabel(y, 'Por região (Desikan-Killiany)')
    const cols = [M, M + 190, M + 235, M + 310, M + 385, M + 455]
    const heads = ['REGIÃO', 'H', 'ESPESSURA (mm)', 'ÁREA (cm²)', 'VOLUME (cm³)']
    pdf.text(cols[0], y, heads[0], 6.5, { color: GRAY })
    pdf.text(cols[1], y, heads[1], 6.5, { color: GRAY })
    pdf.text(cols[2], y, heads[2], 6.5, { color: GRAY })
    pdf.text(cols[3], y, heads[3], 6.5, { color: GRAY })
    pdf.text(cols[4], y, heads[4], 6.5, { color: GRAY })
    y += 4
    pdf.setColor(...HAIR); pdf.setLineWidth(0.6); pdf.line(M, y, W - M, y)
    y += 11
    for (const r of meta.surf.regioes) {
      if (y > pdf.pageH - 56) { pdf.newPage(); y = header('Superfície cortical (cont.)') + 6 }
      const nome = (r.pt || r.base).replace(/ — (esquerd|direit)[oa]$/, '')
      pdf.text(cols[0], y, nome.length > 40 ? nome.slice(0, 39) + '…' : nome, 8, { color: INK })
      pdf.text(cols[1], y, r.hemi, 8, { color: GRAY })
      pdf.text(cols[2], y, `${r.thickAvg.toFixed(2)} ± ${r.thickStd.toFixed(2)}`, 8, { color: INK })
      pdf.text(cols[3], y, (r.area_mm2 / 100).toFixed(1), 8, { color: INK })
      pdf.text(cols[4], y, (r.volume_mm3 / 1000).toFixed(1), 8, { color: INK })
      y += 11.5
    }
  }

  // ---------- métodos ----------
  pdf.newPage()
  y = header('Métodos e ressalvas')
  const paras = [
    ['Medida', `Imagem conformada a 256³ voxels de 1 mm (estilo FreeSurfer). Segmentação: ${meta.model || '—'}, executada localmente no navegador. Volume = contagem de voxels rotulados. Hemisférios: ${stats.hemiMethod}.`],
    ['Comparação normativa', 'Percentis e z-scores derivados das curvas populacionais dos brain charts (Bethlehem et al., "Brain charts for the human lifespan", Nature 2022) — modelos GAMLSS de distribuição gama generalizada, ajustados por idade e sexo, avaliados na versão-base do estudo sem efeito de sítio. As normas foram estimadas em volumes processados por FreeSurfer harmonizado; os volumes deste relatório vêm do SynthSeg/DKT — a comparação é uma APROXIMAÇÃO útil para triagem e controle de qualidade, não para uso clínico. Lobos: z aproximado pela soma dos momentos das parcelas (independência assumida).'],
    ['Bandeiras de QC', 'z é o desvio do valor previsto para idade e sexo. |z| >= 3 marca achado atípico; |z| >= 4 é tratado como possível erro de segmentação — desvios dessa magnitude quase sempre indicam falha técnica (máscara, contraste fora do domínio, movimento) e exigem inspeção visual da sobreposição.'],
    ['Privacidade', 'Nenhuma imagem sai do dispositivo: conversão DICOM›NIfTI (dcm2niix WASM), segmentação e estatísticas rodam localmente.'],
    ['Créditos', 'SynthSeg — Billot, Iglesias e col. (Apache 2.0); brainchop/brain2print — Masoud, Hu, Plis; grupo de C. Rorden (MIT); NiiVue; dcm2niix; brain charts — Bethlehem, Seidlitz e col. (Nature 2022). Cite os artigos originais em trabalhos que usem estes números.']
  ]
  for (const [t, body] of paras) {
    pdf.text(M, y, t, 10.5, { bold: true, color: INK }); y += 15
    for (const ln of wrapText(body, 8.8, W - 2 * M)) {
      pdf.text(M, y, ln, 8.8, { color: INK }); y += 12.5
    }
    y += 9
  }

  const total = pdf.pages.length
  for (let p = 0; p < total; p++) {
    pdf.cur = pdf.pages[p]
    footer(p + 1, total)
  }
  return pdf.build()
}
