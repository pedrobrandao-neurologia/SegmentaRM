// Motor das regras de QC declarativas (models/qc_rules.json). Os limiares e textos ficam no
// JSON — editáveis, com status "provisório"/"validado" e fonte —; aqui fica só a lógica de
// cada TIPO de regra, sem avaliar expressões arbitrárias. Entrada: o contexto já calculado
// (normas, estatísticas, QC interno, VIC, HOC, assimetria); saída: os alertas disparados,
// cada um com as capturas de corte que pede para a inspeção guiada.

const fmtZ = (z) => (z >= 0 ? '+' : '−') + Math.abs(z).toFixed(2).replace('.', ',')
const fmt = (v, d = 2) => (+v).toFixed(d).replace('.', ',')
const preenche = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? String(vars[k]) : '—')

/**
 * Ocupação hipocampal por lado: HOC = V_hip / (V_hip + V_corno_temporal).
 * Reduz o efeito do tamanho da cabeça e cai com a expansão do corno temporal.
 * → { E: {hoc, hip, cornoTemporal}, D: {...} } (lados sem os dois rótulos ficam de fora)
 */
export function ocupacaoHipocampal (stats) {
  const out = {}
  if (!stats || !stats.rows) return out
  for (const [lado, pre] of [['E', 'Left'], ['D', 'Right']]) {
    const hip = stats.rows.find(r => r.name === `${pre}-Hippocampus`)
    const ilv = stats.rows.find(r => r.name === `${pre}-Inf-Lat-Vent`)
    if (hip && ilv && hip.volMm3 > 0 && ilv.volMm3 >= 0) {
      out[lado] = { hoc: hip.volMm3 / (hip.volMm3 + ilv.volMm3), hip: hip.volMm3, cornoTemporal: ilv.volMm3 }
    }
  }
  return out
}

const TIPOS = {
  z_extremo (p, c) {
    const itens = (c.normas && c.normas.flags || []).filter(f => Math.abs(f.z) >= p.zAbs)
    return itens.map(f => ({ vars: { estrutura: f.pt, z: fmtZ(f.z) }, estruturas: [f.pt] }))
  },
  desvios_em_bloco (p, c) {
    const m = c.normas && c.normas.multiplicidade
    if (!m || !m.m) return []
    const frac = m.fracPositivos > 0.5 ? m.fracPositivos : 1 - m.fracPositivos
    if (m.observadoAbs2 >= p.minObservados && m.observadoAbs2 > p.fatorEsperado * m.esperadoAbs2 && frac >= p.fracMesmoSinal) {
      return [{ vars: { observados: m.observadoAbs2, m: m.m, esperado: fmt(m.esperadoAbs2, 1), pct: Math.round(100 * frac) } }]
    }
    return []
  },
  fronteira_sc_sb (p, c) {
    const g = (c.normas && c.normas.globals) || []
    const gm = g.find(x => x.pheno === 'GMV')
    const wm = g.find(x => x.pheno === 'WMV')
    if (!gm || !wm || !(c.idade >= p.idadeMin)) return []
    if (gm.z >= p.zCortexMin && wm.z <= p.zSBMax) return [{ vars: { zc: fmtZ(gm.z), zb: fmtZ(wm.z), idade: fmt(c.idade, 0) } }]
    return []
  },
  hipocampo_corno_temporal (p, c) {
    const sub = (c.normas && c.normas.subcorticais) || []
    const out = []
    for (const [lado, nome] of [['E', 'esquerdo'], ['D', 'direito']]) {
      const h = sub.find(x => x.pheno === 'Hippocampus' && x.hemi === lado)
      const hoc = c.hoc && c.hoc[lado]
      // com referência do mesmo método, o corte é o z da HOC para a idade; sem ela, o corte fixo
      const baixa = hoc && (hoc.z != null && p.zHocMax != null ? hoc.z <= p.zHocMax : hoc.hoc < p.hocMax)
      if (h && hoc && h.z >= p.zHipMin && baixa) {
        out.push({ vars: { lado: `Lado ${nome}`, z: fmtZ(h.z), hoc: fmt(hoc.hoc, 2) + (hoc.z != null ? ` (z ${fmtZ(hoc.z)} para a idade)` : '') }, estruturas: [`${lado === 'E' ? 'Left' : 'Right'}-Hippocampus`] })
      }
    }
    return out
  },
  idade_borda (p, c) {
    const pv = c.normas && c.normas.proveniencia
    if (!pv) return []
    const nomes = [pv.brainchart, pv.centilebrain].filter(x => x && x.borda).map(x => x.norma)
    return nomes.length ? [{ vars: { normas: nomes.join(' e '), anos: p.anos } }] : []
  },
  confianca_baixa (p, c) {
    const r = c.qc && c.qc.resumo
    if (!r || !r.gruposEmAlerta || !r.gruposEmAlerta.length) return []
    return [{ vars: { corte: fmt(p.corte, 2), grupos: r.gruposEmAlerta.join(', ') } }]
  },
  vic_aviso (p, c) {
    return c.icv && c.icv.aviso ? [{ vars: { aviso: c.icv.aviso } }] : []
  },
  recentragem_fora_do_dominio (p, c) {
    const pv = c.normas && c.normas.proveniencia
    const rc = pv && pv.recentragem
    // com o sítio calibrado (nível C) o deslocamento residual já foi medido nos controles locais
    if (!rc || !rc.dominio || pv.calibracao) return []
    const aq = c.aquisicao || {}
    const difs = []
    if (!aq.fabricante && !aq.campoT) difs.push('aquisição desconhecida (entrada sem cabeçalho DICOM)')
    if (aq.fabricante && rc.dominio.fabricante && !new RegExp(rc.dominio.fabricante, 'i').test(aq.fabricante)) difs.push(`fabricante ${aq.fabricante}`)
    if (aq.campoT && rc.dominio.campoT && Math.abs(aq.campoT - rc.dominio.campoT) > 0.25) difs.push(`campo de ${fmt(aq.campoT, 1)} T`)
    return difs.length ? [{ vars: { difs: difs.join(', '), dominio: rc.dominio.descricao || '' } }] : []
  },
  assimetria_extrema (p, c) {
    const pares = (c.assimetria || []).filter(x => x.zIA != null && Math.abs(x.zIA) >= p.zAbs)
    if (!pares.length) return []
    return [{ vars: { estruturas: pares.map(x => `${x.ptName}: IA ${fmt(x.ai, 1)}% (z ${fmtZ(x.zIA)})`).join('; ') }, estruturas: pares.map(x => x.nomeE).filter(Boolean) }]
  }
}

/**
 * @param regras  conteúdo de models/qc_rules.json
 * @param ctx     { idade, sexo, normas, stats, qc, icv, hoc, assimetria, aquisicao }
 * @returns alertas [{ id, titulo, severidade, mensagem, recomendacao, status, fonte, capturas, estruturas }]
 */
export function avaliarRegras (regras, ctx) {
  const out = []
  for (const r of (regras && regras.regras) || []) {
    const fn = TIPOS[r.tipo]
    if (!fn) continue
    let hits = []
    try { hits = fn(r.params || {}, ctx) } catch { hits = [] }
    for (const h of hits) {
      out.push({
        id: r.id, titulo: r.titulo, severidade: r.severidade || 'atencao',
        mensagem: preenche(r.mensagem, h.vars || {}),
        recomendacao: r.recomendacao || '',
        status: r.status || 'provisório', fonte: r.fonte || '',
        capturas: r.capturas || [], estruturas: h.estruturas || []
      })
    }
  }
  const ordem = { alerta: 0, atencao: 1, info: 2 }
  return out.sort((a, b) => (ordem[a.severidade] ?? 3) - (ordem[b.severidade] ?? 3))
}

// centróide (RAS mm) ponderado pelo volume de um conjunto de linhas
function centroide (rows) {
  let w = 0; const c = [0, 0, 0]
  for (const r of rows) {
    if (!r || !r.centroid || !(r.volMm3 > 0)) continue
    for (let k = 0; k < 3; k++) c[k] += r.centroid[k] * r.volMm3
    w += r.volMm3
  }
  return w > 0 ? c.map(v => v / w) : null
}

/**
 * Alvos de captura (plano + ponto RAS + legenda) para os pedidos dos alertas:
 * 'hipocampo' (coronal pelos dois, sagitais E/D), 'occipital' (axial + sagitais E/D pelo lobo
 * occipital), 'cerebro' (3 planos pelo centro do encéfalo) e 'estrutura' (3 planos pelas
 * estruturas citadas no alerta).
 */
export function alvosDeCaptura (alertas, stats) {
  if (!stats || !stats.rows) return []
  const byName = (n) => stats.rows.find(r => r.name === n)
  const byPt = (pt) => stats.rows.find(r => r.ptName === pt || r.name === pt)
  const pedidos = new Set()
  const estruturas = new Set()
  for (const a of alertas) {
    for (const cap of a.capturas || []) pedidos.add(cap)
    for (const e of a.estruturas || []) estruturas.add(e)
  }
  const alvos = []
  const push = (plano, mm, legenda) => { if (mm) alvos.push({ plano, mm, legenda }) }
  if (pedidos.has('hipocampo')) {
    const hl = byName('Left-Hippocampus'); const hr = byName('Right-Hippocampus')
    push('coronal', centroide([hl, hr]), 'Hipocampos — coronal')
    push('sagital', hl && hl.centroid, 'Hipocampo esquerdo — sagital')
    push('sagital', hr && hr.centroid, 'Hipocampo direito — sagital')
  }
  if (pedidos.has('occipital')) {
    const occ = (pre) => stats.rows.filter(r => new RegExp(`^ctx-${pre}-(lateraloccipital|lingual|cuneus|pericalcarine)$`).test(r.name))
    const ol = centroide(occ('lh')); const or = centroide(occ('rh'))
    push('axial', centroide([...occ('lh'), ...occ('rh')]), 'Lobo occipital — axial')
    push('sagital', ol, 'Occipital esquerdo — sagital')
    push('sagital', or, 'Occipital direito — sagital')
  }
  if (pedidos.has('cerebro')) {
    const c = centroide(stats.rows.filter(r => /Cerebral-(White-Matter|Cortex)$|^ctx-/.test(r.name)))
    push('axial', c, 'Encéfalo — axial')
    push('coronal', c, 'Encéfalo — coronal')
    push('sagital', c, 'Encéfalo — sagital')
  }
  if (pedidos.has('estrutura')) {
    for (const e of [...estruturas].slice(0, 2)) {
      const r = byName(e) || byPt(e)
      if (!r || !r.centroid) continue
      push('coronal', r.centroid, `${r.ptName} — coronal`)
      push('axial', r.centroid, `${r.ptName} — axial`)
      push('sagital', r.centroid, `${r.ptName} — sagital`)
    }
  }
  // no máximo 9 cortes (3 linhas no PDF), sem repetir o mesmo plano/ponto
  const vistos = new Set()
  return alvos.filter(a => {
    const k = a.plano + a.mm.map(v => Math.round(v)).join(',')
    if (vistos.has(k)) return false
    vistos.add(k)
    return true
  }).slice(0, 9)
}
