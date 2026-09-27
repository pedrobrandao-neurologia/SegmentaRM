#!/usr/bin/env node
// Gera models/manifest-sha256.json: SHA-256 de cada arquivo de pesos/normas/modelos que
// entra num resultado do SegmentaRM, e um SHA-256 combinado por componente (hash da lista
// ordenada "arquivo:sha256"). O laudo e o JSON citam o combinado do componente usado —
// reprodutibilidade: dois laudos com o mesmo hash usaram exatamente os mesmos pesos/normas.
// Uso: node tools/manifesto_sha256.mjs   (na raiz do repositório; os testes conferem que o
// manifesto bate com os arquivos, então rode-o sempre que trocar um modelo ou uma norma)
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// componente → arquivos (relativos à raiz); pastas entram inteiras, sem arquivos auxiliares
const COMPONENTES = {
  synthseg1: { descricao: 'SynthSeg 1.0 (pesos tfjs convertidos do synthseg_1.0.h5 oficial)', pasta: 'models/synthseg1', filtro: f => /^(model\.json|group1-shard\d+of\d+\.bin|labels(_dkt)?\.json)$/.test(f) },
  fastsurfer: { descricao: 'FastSurferCNN v1 (3 vistas; parcelação DKT)', pasta: 'models/fastsurfer', filtro: f => /\.(bin|json)$/.test(f) },
  synthsr: { descricao: 'SynthSR v1.0', pasta: 'models/synthsr', filtro: f => /\.(bin|json)$/.test(f) },
  normas_brainchart: { descricao: 'BrainChart — quantis tabelados (Bethlehem et al., Nature 2022)', arquivos: ['models/normative/brainchart.json'] },
  normas_centilebrain: { descricao: 'CentileBrain — quantis subcorticais (Ge et al., 2024)', arquivos: ['models/normative/subcortical.json'] },
  vic_template: { descricao: 'VIC: template MNI152 2009c embutido e constante de calibração', arquivos: ['lib/icv.js'] },
  tradutor: { descricao: 'Tradutor SynthSeg → FreeSurfer (nível A; deslocamento por idade e sexo ajustado no DLBS)', arquivos: ['models/normative/tradutor_synthseg_fs.json'] },
  referencia_mesmo_metodo: { descricao: 'Assimetria e HOC por idade — SynthSeg 1.0 do SegmentaRM em controles do DLBS', arquivos: ['models/normative/referencia_mesmo_metodo.json'] },
  erro_medida: { descricao: 'Erro de medida teste-reteste por estrutura (intervalo de 90% do z)', arquivos: ['models/normative/erro_medida.json'] },
  regras_qc: { descricao: 'Regras declarativas de QC', arquivos: ['models/qc_rules.json'] }
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const saida = { gerado: new Date().toISOString().slice(0, 10), componentes: {} }
for (const [nome, c] of Object.entries(COMPONENTES)) {
  let arquivos = c.arquivos || []
  if (c.pasta) {
    const dir = path.join(RAIZ, c.pasta)
    if (!fs.existsSync(dir)) continue
    arquivos = fs.readdirSync(dir).filter(c.filtro).sort().map(f => path.join(c.pasta, f))
  }
  arquivos = arquivos.filter(f => fs.existsSync(path.join(RAIZ, f)))
  if (!arquivos.length) continue
  const lista = arquivos.map(f => ({ arquivo: f, sha256: sha(fs.readFileSync(path.join(RAIZ, f))) }))
  saida.componentes[nome] = {
    descricao: c.descricao,
    sha256: sha(lista.map(x => `${x.arquivo}:${x.sha256}`).join('\n')),
    arquivos: lista
  }
}
fs.writeFileSync(path.join(RAIZ, 'models/manifest-sha256.json'), JSON.stringify(saida, null, 1) + '\n')
console.log(Object.entries(saida.componentes).map(([k, v]) => `${k} ${v.sha256.slice(0, 16)}… (${v.arquivos.length} arquivos)`).join('\n'))
