# Recentragem pelo método e referências do mesmo método (DLBS)

_Gerado por `tools/referencias_dlbs.py` e `tools/recentragem_dlbs.mjs` — não edite à mão; rode os scripts de novo._

**Amostra:** 201 controles saudáveis do Dallas Lifespan Brain Study (onda 1; 21–89 anos; 104 F / 97 M; Philips 3 T MPRAGE), OpenNeuro ds004856 (CC0; Park et al., *Sci Data* 2025), com FreeSurfer 5.3 editado à mão e revisado por outra equipe. **SynthSeg:** o núcleo do app (`lib/synthseg-core.js`) em Node, volume suave, espelhamento E/D — o mesmo valor principal do app. **Conjunto externo:** 17 adultos jovens (19–30 anos) do OpenNeuro ds000001/ds000005, outro scanner, com FreeSurfer 6.0.1 dos derivados públicos do OpenNeuro. Todos os z usam as tabelas e o código do app.

## Por que recentrar, e não traduzir para a escala do FreeSurfer

z médio (DP) de pessoas **saudáveis** contra as normas embarcadas — o esperado, se o método e a norma estivessem na mesma escala, é média 0 e DP 1. O próprio FreeSurfer fica longe disso no córtex (GMV do BrainChart), nos dois conjuntos, e em várias subcorticais no DLBS. Traduzir o SynthSeg para a escala do FreeSurfer 5.3 levaria os controles, por construção, aos z das colunas do FreeSurfer — herdaria esses desvios. O nível A recentra contra a **própria norma**, com controles medidos pelo mesmo método do paciente.

| Medida | DLBS: SynthSeg cru | DLBS: FreeSurfer 5.3 | FreeSurfer 5.3, > 75 anos | externo: SynthSeg cru | externo: FreeSurfer 6.0.1 |
|---|---:|---:|---:|---:|---:|
| Córtex cerebral (GMV) | +0,41 (0,95) | −1,47 (0,95) | −1,73 | −0,64 (0,83) | −1,85 |
| Substância branca (WMV) | −0,59 (0,76) | +0,29 (1,02) | +0,55 | −0,38 (0,82) | +0,04 |
| Cinzenta subcortical (sGMV) | −0,90 (1,04) | +0,10 (1,16) | −0,15 | −0,96 (0,84) | −0,44 |
| Ventrículos | +0,12 (0,90) | −0,24 (1,02) | −0,30 | +0,58 (0,49) | +0,19 |
| Cérebro total (TCV) | −0,22 (0,90) | −0,65 (0,97) | −0,68 | −0,59 (0,84) | −0,98 |
| Tálamo E | −0,67 (1,19) | +1,74 (1,36) | +1,61 | −0,89 (0,95) | −0,38 |
| Tálamo D | −1,06 (1,25) | +0,28 (1,51) | +0,37 | −0,92 (0,93) | −0,30 |
| Caudado E | +0,27 (0,93) | +0,28 (1,27) | +0,34 | +1,12 (0,99) | −0,09 |
| Caudado D | +0,11 (0,96) | −0,25 (1,41) | −0,34 | +0,79 (0,95) | −0,17 |
| Putâmen E | +0,44 (0,97) | −0,31 (1,37) | −0,35 | +0,12 (0,68) | −0,69 |
| Putâmen D | −0,01 (1,02) | −0,17 (1,41) | −0,53 | −0,15 (0,77) | −0,51 |
| Pálido E | −3,27 (1,45) | −1,90 (1,76) | −1,37 | −1,66 (0,74) | +0,02 |
| Pálido D | −2,59 (1,39) | −1,42 (1,71) | −1,56 | −1,31 (0,83) | +0,26 |
| Hipocampo E | −0,19 (1,12) | −0,13 (1,59) | −0,70 | −0,87 (0,83) | −0,99 |
| Hipocampo D | −0,24 (1,23) | −0,27 (1,70) | −0,83 | −0,49 (0,93) | −0,78 |
| Amígdala E | +0,06 (1,13) | −0,51 (1,45) | −0,75 | −0,21 (0,85) | −0,11 |
| Amígdala D | −0,37 (1,05) | −0,57 (1,40) | −0,71 | −0,45 (0,77) | +0,26 |
| Accumbens E | +1,17 (0,82) | −0,61 (1,53) | −0,50 | +1,45 (0,67) | +0,96 |
| Accumbens D | +0,55 (0,94) | −0,72 (1,36) | −1,03 | +0,88 (0,66) | −0,08 |

## Recentragem (nível A): validação

Deslocamento (em z) que o app desconta, para uma mulher aos 30, 60 e 85 anos, e o termo de sexo masculino. Validação cruzada (10 partes) no DLBS: z médio depois da recentragem por terço de idade (o esperado é 0) e DP. Externo: z médio (DP) antes e depois.

| Medida | n | desloc. 30 · 60 · 85 anos | masc. | VC por terço (≤ 55 · 55–75 · > 75) | DP VC | externo: cru → recentrado |
|---|---:|---|---:|---|---:|---|
| Córtex cerebral (GMV) | 201 | −0,19 · +0,47 · +0,52 | +0,10 | −0,02 · +0,01 · +0,01 | 0,92 | −0,64 → −0,29 (0,85) |
| Substância branca (WMV) | 201 | −0,67 · −0,58 · −0,71 | +0,11 | −0,01 · −0,01 · +0,02 | 0,77 | −0,38 → +0,29 (0,84) |
| Cinzenta subcortical (sGMV) | 201 | −0,79 · −0,77 · −1,31 | +0,12 | −0,01 · −0,01 · +0,01 | 1,03 | −0,96 → −0,12 (0,84) |
| Ventrículos | 201 | +0,40 · +0,10 · −0,14 | +0,10 | +0,02 · −0,05 · +0,02 | 0,90 | +0,58 → +0,07 (0,47) |
| Cérebro total (TCV) | 201 | −0,50 · −0,16 · −0,32 | +0,12 | −0,01 · 0,00 · +0,02 | 0,91 | −0,59 → 0,00 (0,87) |
| Tálamo E | 201 | +0,03 · −0,73 · −0,95 | −0,01 | −0,03 · −0,01 · +0,03 | 1,15 | −0,89 → −1,12 (0,93) |
| Tálamo D | 201 | −0,62 · −0,98 · −1,40 | 0,00 | −0,03 · 0,00 · +0,03 | 1,24 | −0,92 → −0,35 (0,92) |
| Caudado E | 201 | +0,60 · +0,32 · −0,06 | +0,05 | −0,03 · +0,08 · −0,04 | 0,92 | +1,12 → +0,47 (0,98) |
| Caudado D | 201 | +0,59 · +0,26 · −0,31 | −0,02 | −0,02 · +0,05 · −0,04 | 0,93 | +0,79 → +0,19 (0,95) |
| Putâmen E | 201 | +0,03 · +0,45 · +0,33 | +0,22 | +0,04 · −0,06 · +0,02 | 0,96 | +0,12 → +0,16 (0,70) |
| Putâmen D | 201 | −0,34 · +0,15 · −0,09 | +0,04 | −0,01 · +0,02 · −0,02 | 1,02 | −0,15 → +0,37 (0,77) |
| Pálido E | 201 | −3,67 · −3,27 · −3,83 | +0,55 | +0,02 · −0,16 · +0,13 | 1,43 | −1,66 → +2,01 (0,83) |
| Pálido D | 201 | −2,25 · −2,18 · −3,55 | +0,15 | −0,04 · −0,01 · +0,04 | 1,28 | −1,31 → +1,12 (0,85) |
| Hipocampo E | 201 | −0,15 · −0,04 · −0,24 | −0,11 | −0,06 · +0,12 · −0,05 | 1,14 | −0,87 → −0,60 (0,84) |
| Hipocampo D | 200 (−1) | −0,19 · −0,13 · −0,44 | +0,02 | −0,03 · +0,08 · −0,03 | 1,25 | −0,49 → −0,25 (0,92) |
| Amígdala E | 201 | −0,05 · +0,07 · +0,11 | −0,01 | −0,01 · −0,04 · +0,05 | 1,15 | −0,21 → −0,13 (0,85) |
| Amígdala D | 201 | −0,30 · −0,28 · −0,45 | −0,06 | +0,01 · −0,05 · +0,05 | 1,06 | −0,45 → −0,09 (0,75) |
| Accumbens E | 201 | +0,81 · +1,03 · +1,46 | +0,07 | −0,03 · +0,06 · −0,02 | 0,81 | +1,45 → +0,61 (0,67) |
| Accumbens D | 201 | +0,46 · +0,67 · +0,67 | −0,16 | −0,04 · +0,13 · −0,08 | 0,95 | +0,88 → +0,55 (0,67) |

**Resumo.** |z| médio dos controles externos: 0,76 sem recentragem → 0,46 com recentragem; no terço mais velho do DLBS (> 75 anos), em validação cruzada: 0,83 → 0,04. O que resta no conjunto externo (outro scanner e protocolo, adultos jovens) é o desvio próprio de cada sítio e protocolo — por isso a calibração com controles locais (nível C) continua necessária para uso sério.

## SynthSeg × FreeSurfer 5.3 editado: o viés de método

Viés do SynthSeg = média geométrica de V_SS / V_FS − 1, no total e por terço de idade; r = correlação dos resíduos (idade e sexo) entre as ferramentas; DP (log, depois de idade e sexo) do SynthSeg, do FreeSurfer e o σ da própria norma nas mesmas idades; DP individual = DP de log(V_FS/V_SS). A última coluna compara o deslocamento FS/SS de um ajuste só deste lado com o de E e D juntos — a diferença é o artefato E/D do FreeSurfer do DLBS (ver a tabela de assimetria). Estes números explicam os z crus; o app não traduz para a escala do FreeSurfer (ver acima).

| Medida | n | r | viés SS | viés por terço de idade | DP SS · FS · norma (log) | DP individual | FS/SS só deste lado · E e D juntos |
|---|---:|---:|---:|---|---|---:|---|
| Córtex cerebral | 196 | 0,93 | +18,3% | +13,8 · +18,7 · +23,0 | 0,076 · 0,084 · 0,094 | 3,2% | −15,2% · −15,2% |
| Substância branca cerebral | 198 | 0,89 | −9,3% | −6,9 · −9,3 · −11,8 | 0,087 · 0,102 · 0,106 | 4,6% | +10,5% · +10,5% |
| Cinzenta subcortical | 199 | 0,86 | −7,7% | −7,0 · −7,9 · −8,0 | 0,084 · 0,090 · 0,077 | 4,7% | +6,5% · +6,5% |
| Ventrículos | 201 | 0,99 | +15,7% | +20,8 · +15,2 · +11,1 | 0,378 · 0,420 · 0,275 | 6,1% | −15,4% · −15,4% |
| Cérebro total (GMV+WMV) | 198 | 0,98 | +3,8% | +3,2 · +4,0 · +4,4 | 0,078 · 0,083 · 0,088 | 1,4% | −3,4% · −3,4% |
| Tálamo E | 201 | 0,49 | −20,8% | −17,3 · −22,5 · −22,6 | 0,106 · 0,128 · 0,077 | 12,0% | +23,2% · +15,9% |
| Tálamo D | 201 | 0,62 | −11,1% | −7,5 · −11,8 · −14,0 | 0,102 · 0,133 · 0,068 | 10,6% | +9,1% · +15,9% |
| Caudado E | 200 | 0,69 | −0,4% | +4,7 · −0,8 · −4,9 | 0,109 · 0,161 · 0,109 | 11,7% | −3,9% · −5,6% |
| Caudado D | 199 | 0,63 | +4,4% | +8,3 · +3,9 · +0,9 | 0,110 · 0,164 · 0,106 | 12,8% | −7,4% · −5,6% |
| Putâmen E | 199 | 0,65 | +9,7% | +6,8 · +10,2 · +12,3 | 0,113 · 0,175 · 0,167 | 13,4% | −8,3% · −5,4% |
| Putâmen D | 200 | 0,58 | +2,7% | −1,0 · +2,8 · +6,7 | 0,114 · 0,160 · 0,133 | 13,3% | −2,4% · −5,4% |
| Pálido E | 200 | 0,34 | −17,4% | −11,4 · −15,1 · −25,4 | 0,211 · 0,243 · 0,120 | 26,3% | +11,5% · +10,4% |
| Pálido D | 201 | 0,27 | −13,7% | −8,4 · −12,5 · −20,1 | 0,167 · 0,204 · 0,111 | 22,6% | +9,4% · +10,4% |
| Hipocampo E | 197 | 0,81 | −1,1% | −4,4 · −0,9 · +2,2 | 0,104 · 0,125 · 0,087 | 7,3% | +2,6% · +2,2% |
| Hipocampo D | 197 | 0,89 | −0,2% | −1,9 · −1,7 · +3,4 | 0,126 · 0,149 · 0,085 | 7,0% | +1,8% · +2,2% |
| Amígdala E | 200 | 0,74 | +7,7% | +5,1 · +5,4 · +12,9 | 0,146 · 0,186 · 0,122 | 12,7% | −5,4% · −2,5% |
| Amígdala D | 199 | 0,62 | +3,0% | +3,1 · +0,7 · +5,1 | 0,131 · 0,176 · 0,123 | 14,0% | +0,4% · −2,5% |
| Accumbens E | 195 | 0,41 | +47,0% | +34,4 · +52,1 · +56,1 | 0,152 · 0,342 · 0,299 | 31,3% | −33,4% · −27,8% |
| Accumbens D | 199 | 0,51 | +27,0% | +18,5 · +28,3 · +35,2 | 0,174 · 0,255 · 0,207 | 22,6% | −21,7% · −27,8% |

Terços de idade: até 55 · 55–75 · acima de 75 anos.

## Assimetria do mesmo método

IA = 200·(E − D)/(E + D) do volume suave do SynthSeg; média e DP por idade no JSON. Comparação com o FreeSurfer 5.3 nos mesmos sujeitos e com o ENIGMA (Guadalupe et al., Brain Imaging Behav 2017; FreeSurfer 4–5.3; DP intra-dataset).

| Estrutura | n | IA médio (SS) | DP (SS) | inclinação/década | IA FS 5.3 | DP FS 5.3 | ENIGMA média ± DP |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tálamo | 201 | +6,1 | 6,4 | −1,0 | +17,6 | 14,4 | +4,2 ± 6,0 |
| Caudado | 201 | −1,8 | 4,4 | +0,3 | +3,4 | 16,8 | −1,9 ± 4,9 |
| Putâmen | 201 | +6,2 | 6,0 | +0,2 | −1,2 | 20,2 | +3,9 ± 5,7 |
| Pálido | 201 | −9,0 | 19,4 | +0,9 | −4,1 | 28,0 | +3,6 ± 10,4 |
| Hipocampo | 197 | −2,4 | 6,6 | +0,0 | −1,0 | 12,0 | −1,3 ± 5,7 |
| Amígdala | 200 | −3,2 | 9,9 | +0,1 | −7,8 | 18,7 | −4,1 ± 10,4 |
| Accumbens | 200 | +0,8 | 11,8 | +0,1 | −15,0 | 43,7 | −1,4 ± 15,6 |
| Diencéfalo ventral | 201 | +2,6 | 5,8 | +0,4 | +0,5 | 15,5 | — |
| Ventrículo lateral | 201 | +6,0 | 16,7 | −0,1 | +6,1 | 22,4 | — |
| Corno temporal | 201 | −1,6 | 23,7 | +1,0 | +7,7 | 54,7 | — |
| Córtex cerebral | 199 | −0,2 | 1,0 | +0,0 | — | — | — |
| SB cerebral | 200 | −0,1 | 1,1 | +0,1 | — | — | — |
| Córtex cerebelar | 201 | +0,8 | 3,0 | +0,2 | −2,5 | 4,8 | — |
| SB cerebelar | 200 | −0,0 | 3,2 | +0,0 | −3,5 | 13,6 | — |

## Ocupação hipocampal (HOC) do mesmo método

HOC = V_hip / (V_hip + V_corno temporal), volume suave; média quadrática e DP linear na idade.

| Lado | n | HOC aos 30 | aos 60 | aos 85 | DP aos 60 |
|---|---:|---:|---:|---:|---:|
| esquerdo | 195 | 0,888 | 0,860 | 0,775 | 0,042 |
| direito | 198 | 0,885 | 0,858 | 0,770 | 0,050 |

## Como regenerar

Veja `docs/plano-metodologico.md` ("Como regenerar os coeficientes").

