// Referências do MESMO método: índice de assimetria IA = 200·(E − D)/(E + D) e ocupação hipocampal
// (HOC) medidos com o SynthSeg 1.0 do SegmentaRM (volume suave) em controles saudáveis do Dallas
// Lifespan Brain Study (OpenNeuro ds004856, CC0), com média e DP dependentes da idade — geradas
// offline por tools/referencias_dlbs.py e embarcadas em models/normative/referencia_mesmo_metodo.json
// (só coeficientes; nenhuma imagem).
//
// Por que do mesmo método: a assimetria de uma ferramenta não é a de outra (fronteiras diferentes,
// espelhamento E/D do SynthSeg na inferência). As médias do ENIGMA (Guadalupe et al., Brain Imaging
// Behav 2017) são de FreeSurfer 4–5.3 e ficam no JSON só como comparação.
//
// Parcelas corticais DKT não têm referência do mesmo método (exigiria rodar a parcelação nos
// controles): o IA delas é descritivo — sem z e sem cor.

let REF = null

export async function carregarAssimetria (src = './models/normative/referencia_mesmo_metodo.json') {
  if (REF) return REF
  try {
    const d = typeof src === 'string' ? await (await fetch(src)).json() : src
    REF = d && d.assimetria && d.assimetria.estruturas ? d : null
  } catch (e) { REF = null }
  return REF
}

export function referenciaAssimetria () { return REF }

// idade centrada, presa à faixa do ajuste (sem extrapolar)
function tIdade (ref, idade) {
  const fx = ref.idadeFaixa || [0, 200]
  const r = ref.idadeRef || 60
  return Math.min(fx[1], Math.max(fx[0], idade > 0 ? idade : r)) - r
}

/** média e DP do IA esperados na idade */
export function iaEsperado (ref, base, idade) {
  const e = ref && ref.assimetria && ref.assimetria.estruturas[base]
  if (!e) return null
  const t = tIdade(ref, idade)
  const fx = ref.idadeFaixa || [0, 200]
  return { media: e.media0 + (e.media1 || 0) * t, dp: Math.max(e.dpMin || 0.1, e.dp0 + (e.dp1 || 0) * t), foraDaFaixa: idade < fx[0] || idade > fx[1] }
}

/** z da ocupação hipocampal (HOC) de um lado ('E' | 'D') contra controles do mesmo método */
export function zHoc (hoc, lado, idade, ref = REF) {
  const e = ref && ref.hoc && ref.hoc.lados && ref.hoc.lados[lado]
  if (!e || !(hoc > 0)) return null
  const t = tIdade(ref, idade)
  const media = e.media0 + e.media1 * t + (e.media2 || 0) * t * t
  const dp = Math.max(e.dpMin || 0.002, e.dp0 + (e.dp1 || 0) * t)
  return { z: (hoc - media) / dp, media, dp }
}

/**
 * Anota os pares E/D (stats.pairs) com zIA quando há referência para a estrutura.
 * → [{ ...par, nomeE, zIA, iaMedia, iaDp, refAssimetria }]
 */
export function anotarAssimetria (pairs, idade, ref = REF) {
  return (pairs || []).map(p => {
    const cortical = p.group === 'cortex' && !/^Cerebral-Cortex$/.test(p.base)
    const out = { ...p, nomeE: cortical ? `ctx-lh-${p.base}` : `Left-${p.base}` }
    const esp = cortical ? null : iaEsperado(ref, p.base, idade)
    if (esp && isFinite(p.ai)) {
      out.zIA = (p.ai - esp.media) / esp.dp
      out.iaMedia = esp.media
      out.iaDp = esp.dp
      out.refAssimetria = { fonte: ref.fonteCurta || ref.fonte, n: ref.assimetria.estruturas[p.base].n, idadeFaixa: ref.idadeFaixa, foraDaFaixa: esp.foraDaFaixa }
    }
    return out
  })
}
