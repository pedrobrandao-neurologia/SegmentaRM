# Dados das normas próprias

- `manifesto.json` — exames selecionados por `tools/normas_selecao.py --indi` (base, sujeito, sítio,
  idade, sexo, licença e URL pública do T1). Não contém imagens.
- `resultados_f*.jsonl` — registro durável do lote (`tools/normas_lote.mjs --jsonl`): uma linha por
  exame com os volumes suaves do SynthSeg, o VIC e os metadados do manifesto. É o que permite
  reajustar as normas sem medir tudo de novo. Não contém imagens.

Origem e licença: bases CC0 do OpenNeuro (ver `licenses/normas_segmentarm.txt`) e, nas linhas com
`base = fcon1000`, o 1000 Functional Connectomes Project (INDI/NITRC, S3 público `fcp-indi`), de
uso **não comercial** (CC BY-NC). Os identificadores são os pseudônimos públicos de cada base.

Para (re)processar: `bash tools/normas_bloco.sh` até a última linha dizer `COMPLETO`, com commit
dos `resultados_*.jsonl` a cada bloco. Depois: `node tools/normas_preparar.mjs dados/normas tabela.csv`
e `Rscript tools/normas_ajuste.R …` (ver `docs/normas-proprias.md` §4).
