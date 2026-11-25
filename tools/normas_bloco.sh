#!/bin/bash
# Um BLOCO do lote das normas próprias (docs/normas-proprias.md): roda as duas fatias de
# tools/normas_lote.mjs por até NORMAS_LIMITE segundos e imprime o estado na última linha.
# Feito para ambientes que limitam o tempo de uma tarefa (2 h): chame de novo até "COMPLETO".
# O registro durável fica em dados/normas/resultados_*.jsonl — faça commit dele a cada bloco;
# numa máquina nova o lote retoma a partir dele. Imagens ficam só em NORMAS_RES e são apagadas.
#
#   bash tools/normas_bloco.sh        # última linha: ESTADO: COMPLETO|CONTINUAR|SEM_PROGRESSO …
set -u
cd "$(dirname "$0")/.."
MAN=dados/normas/manifesto.json; DUR=dados/normas
RES=${NORMAS_RES:-/tmp/normas_res}; LIM=${NORMAS_LIMITE:-6000}; TFN=${NORMAS_TFN:-/tmp/normas_tfn}
mkdir -p "$RES"
if [ ! -d "$TFN/node_modules/@tensorflow/tfjs-node" ]; then
  mkdir -p "$TFN" && (cd "$TFN" && npm init -y >/dev/null 2>&1 && npm i --no-save @tensorflow/tfjs-node@4.22.0 >/dev/null 2>&1) \
    || { echo "ESTADO: FALHA instalação do tfjs-node"; exit 2; }
fi
export NODE_PATH="$TFN/node_modules"
contar () {
  node -e "
const fs=require('fs');const m=JSON.parse(fs.readFileSync('$MAN','utf8'));const f=new Set()
for(const a of fs.readdirSync('$DUR').filter(x=>/^resultados_.*\.jsonl$/.test(x)))for(const l of fs.readFileSync('$DUR/'+a,'utf8').split('\n')){try{const o=JSON.parse(l);if(o&&o.id&&o.soft)f.add(o.id)}catch{}}
console.log(m.filter(e=>f.has(e.id)).length+' '+m.length)"
}
read -r ANTES TOTAL <<< "$(contar)"
rm -f "$RES"/.t1/*.part 2>/dev/null
for k in 0 1; do
  timeout "$LIM" node tools/normas_lote.mjs "$MAN" "$RES" --jsonl "$DUR" --fatia $k/2 >> "$RES/lote$k.log" 2>&1 &
done
wait
read -r FEITOS TOTAL <<< "$(contar)"
ERROS=$( [ -f "$RES/erros.jsonl" ] && sort -u "$RES/erros.jsonl" | wc -l || echo 0 )
if [ "$FEITOS" -ge "$TOTAL" ]; then E=COMPLETO; elif [ "$FEITOS" -gt "$ANTES" ]; then E=CONTINUAR; else E=SEM_PROGRESSO; fi
echo "ESTADO: $E feitos=$FEITOS total=$TOTAL neste_bloco=$((FEITOS-ANTES)) erros_registrados=$ERROS"
