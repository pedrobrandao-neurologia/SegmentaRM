# Auditoria da camada normativa (outubro de 2026)

De onde vêm os números de referência do SegmentaRM, quão fiel é o cálculo do z e o que foi
corrigido. As verificações contra o R usaram os modelos oficiais clonados e o `gamlss` 5.5,
compilado a partir do código-fonte.

## 1. Proveniência

| Arquivo | Fonte | Licença | n | Idades | Gerador |
|---|---|---|---|---|---|
| `brainchart.json` | Bethlehem et al., *Nature* 2022 — modelos `Share/OriginalModels/FIT_*.rds` de [brainchart/Lifespan](https://github.com/brainchart/Lifespan). Família gama generalizada; μ e σ com sexo, fs_version, polinômio fracionário da idade e efeito aleatório de estudo. | **CC BY-NC-ND 4.0** (uso não comercial) | GMV 77 157 (100 estudos); WMV e TCV 77 031; sGMV 75 646; ventrículos 70 000; regiões DK ~58–61 mil | 1–100 | `tools/gerar_brainchart_json.R` (novo; reproduz o arquivo antigo byte a byte nas 13 probabilidades originais) |
| `subcortical.json` | CentileBrain, Ge et al., *Lancet Digit Health* 2024. Modelos GAMLSS por sexo (BCCGo/BCPEo/BCTo) e MFPR sem medidas globais. | Sem licença ("for research purpose") | F ≈ 19 mil; M ≈ 17 mil por estrutura | 3–90 | `tools/extract_centilebrain_subcortical.R` |
| `recentragem_synthseg.json` | 201 controles do DLBS (ds004856, CC0) medidos com o SynthSeg do app | CC0 | 201 | 21–89 | `tools/referencias_dlbs.py` + `tools/recentragem_dlbs.mjs` |
| `referencia_mesmo_metodo.json` | O mesmo DLBS (assimetria e HOC) | CC0 | 197–201 | 21–89 | `tools/referencias_dlbs.py` |
| `erro_medida.json` | van Nederpelt 2023 (SynthSeg 1.0, 3 scanners) e Kondrateva 2025 (preprint); "estimativa" nos ventrículos | — | — | — | curado à mão |

**O que a curva do BrainChart representa:**
- não é "a versão-base do FreeSurfer";
- é a curva **sem o efeito de estudo (sítio)** e **sem nível de pipeline**: com o contraste do modelo, isso é a média não ponderada dos 6 níveis de fs_version.

Efeito de cada nível de pipeline sobre a mediana da GMV:

| Custom | Custom_T1T2 | FS53 | FS6_T1 | FS6_T1T2 | FSInfant |
|---|---|---|---|---|---|
| −4,7% | +20,5% | −8,4% | −7,9% | +3,4% | −0,1% |

Por isso, controles medidos com o FreeSurfer 6 ficam em ≈ −0,9 z na GMV desta curva.

O DLBS é um dos estudos de treino do BrainChart: a amostra da recentragem não é independente da norma.

## 2. Acurácia do cálculo do z

O z é obtido de quantis tabelados, com interpolação linear na escala probit. Valores medidos contra a CDF exata no R (fixtures em `tests/fixtures/*_exato_R.json`):

| | Antes | Agora |
|---|---|---|
| BrainChart, adultos, \|z\| ≤ 3 | ≤ 0,036 | ≤ 0,036 |
| BrainChart, 3 < \|z\| ≤ 6 | ventrículos: z 4 → 4,8; z 6 → 16–20; WMV −6 → −5,6 | ≤ 0,003 |
| BrainChart, 1,5 / 2,5 / 3,5 anos | 0,35 / 0,12 / 0,05 | ≤ 0,03 |
| CentileBrain, \|z\| ≤ 3 | ≤ 0,04 | ≤ 0,04 |
| CentileBrain, 3 < \|z\| ≤ 6 | putâmen (BCTo): +5 → +7,1 | ≤ 0,02 |

Os números "antes" vieram da extrapolação da reta probit para além de P0,1/P99,9, que superestimava muito o \|z\| nas distribuições assimétricas. As tabelas agora trazem as caudas até ±6 DP (23 probabilidades), e o BrainChart tem uma grade de 0,25 ano até os 6 anos.

A função qnorm/pnorm (erro < 2e-7) e o procedimento de Holm (sem discordâncias em 20 mil casos) estão corretos.

## 3. Bugs corrigidos

1. **TCV com definição errada.** O app somava GMV + WMV + sGMV, mas o TCV do BrainChart é **GMV + WMV**. Duas evidências:
   - a mediana tabelada acompanha GMV + WMV (−1% a +1,7% em todas as idades);
   - o N do modelo é o da WMV, não o da sGMV.

   Efeito: o z bruto do TCV saía ≈ +0,6 alto. Com a recentragem ligada, o coeficiente compensava o erro em média; sem ela (volume rígido, outras redes, opção desligada), o erro aparecia inteiro.

   A recentragem do TCV foi reajustada com a definição certa. Os demais coeficientes não mudaram, porque só mudou a data de geração. Isso invalida as calibrações de sítio feitas com a versão anterior; o app avisa.
2. **Caudas e idades pediátricas.** Ver §2.
3. **Percentil-limite.** O valor exibido saía "< 1" ou "> 99" em vez de "< 0,1" ou "> 99,9".
4. **"Mediana" com calibração do sítio.** O volume mostrado ignorava o deslocamento do sítio: um paciente exatamente nessa "mediana" saía com z ≠ 0.
5. **Par de assimetria do córtex com DKT.** O par usava só o resíduo de córtex não parcelado. Um resíduo de 120 contra 30 voxels gerava IA de 120% e alerta de "assimetria extrema", com z +127. Agora o par usa o córtex total do hemisfério, a mesma grandeza da referência.
6. **Aviso "fusão sem parcelas no hemisfério".** Por um erro de um índice, o aviso nunca disparava.
7. **Calibração do sítio misturava métodos.** Controles SynthSeg (suave) e MeshNet (rígido) entravam juntos. Com isso, o deslocamento do córtex ia de 1,25 para 2,08 z, e uma calibração feita com um método era aplicada a outro. Agora o filtro e a chave usam o método (rede + convenção de volume).
8. **Referências do mesmo método aplicadas a outro método.** O zIA e o z da HOC usavam a referência SynthSeg-suave do DLBS também para MeshNet e outras redes, o que podia disparar alertas. Agora:
   - eles só são calculados quando a medida é SynthSeg com volume suave;
   - a nova regra de QC `entrada_fora_do_dominio` avisa quando a entrada da rede difere da dos controles (extração cerebral, SynthSR, recorte, suavização ou sem espelhamento).

## 4. Limitações que continuam, em ordem de impacto

1. **Efeito de sítio fora do intervalo.**
   - O BrainChart é avaliado sem o efeito aleatório de estudo. O DP desse efeito, convertido em z, é de 1,10 (GMV), 1,26–1,35 (WMV), 1,03–1,09 (sGMV), 0,94–1,02 (ventrículos), 0,57 (TCV) e ≈ 0,5 nas regiões.
   - O IC 90% mostrado só traz o erro de medida e as incertezas da recentragem e da calibração.
   - O próprio BrainChart diz que o modelo não serve para indivíduos sem uma linha de base de **≥ 100 controles** do sítio. O app calibra com 10 controles (só deslocamento) ou com 30 (também escala).
2. **Recentragem de um único sítio** (DLBS, Philips 3T), **sem correção de escala.** O DP dos controles recentrados vai de 0,77 a 1,26. Consequência: no hipocampo D, P(\|z\| > 2) ≈ 11% em saudáveis, contra 4,6% nominais.
3. **Sem ajuste por volume intracraniano** nas duas normas: o z inclui o tamanho da cabeça.
4. **CentileBrain:** treinado com dados harmonizados por ComBat-GAM e com remoção de valores além de 1,5×IQR. A referência é estreita, e um exame isolado não passa por essa harmonização.
5. **Regiões DK:** a norma é a média dos dois hemisférios, o app usa o atlas DKT contra a norma DK, e o efeito de estudo é ≈ 0,5 z. Hoje são só exploratórias.
6. **Licenças.**
   - BrainChart CC BY-NC-ND: uso não comercial. Se tabelar quantis conta como "derivado" é uma pergunta em aberto, e convém confirmar com os autores.
   - CentileBrain: sem licença.
7. **Definição de "Ventricles" no BrainChart:** não pôde ser conferida. O suplemento estava inacessível; se a norma não incluir o 3º e o 4º ventrículos, o desvio é de ≈ 0,2–0,3 z.

O caminho para atacar os itens 1–4 de uma vez é ter normas próprias, medidas com o mesmo método e com o sítio modelado: ver [`normas-proprias.md`](normas-proprias.md).
