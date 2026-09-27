# Recentragem pelo método e referências do mesmo método (DLBS)

_Gerado por `tools/referencias_dlbs.py` e `tools/recentragem_dlbs.mjs` — não edite à mão; rode os scripts de novo._

**Amostra:** 101 controles saudáveis do Dallas Lifespan Brain Study (onda 1; 21–89 anos; 47 F / 54 M; Philips 3 T MPRAGE), OpenNeuro ds004856 (CC0; Park et al., *Sci Data* 2025), com FreeSurfer 5.3 editado à mão e revisado por outra equipe. **SynthSeg:** o núcleo do app (`lib/synthseg-core.js`) em Node, volume suave, espelhamento E/D — o mesmo valor principal do app. **Conjunto externo:** 17 adultos jovens (19–30 anos) do OpenNeuro ds000001/ds000005, outro scanner, com FreeSurfer 6.0.1 dos derivados públicos do OpenNeuro. Todos os z usam as tabelas e o código do app.

## Por que recentrar, e não traduzir para a escala do FreeSurfer

z médio (DP) de pessoas **saudáveis** contra as normas embarcadas — o esperado, se o método e a norma estivessem na mesma escala, é média 0 e DP 1. O próprio FreeSurfer fica longe disso no córtex (GMV do BrainChart), nos dois conjuntos, e em várias subcorticais no DLBS. Traduzir o SynthSeg para a escala do FreeSurfer 5.3 levaria os controles, por construção, aos z das colunas do FreeSurfer — herdaria esses desvios. O nível A recentra contra a **própria norma**, com controles medidos pelo mesmo método do paciente.

| Medida | DLBS: SynthSeg cru | DLBS: FreeSurfer 5.3 | FreeSurfer 5.3, > 76 anos | externo: SynthSeg cru | externo: FreeSurfer 6.0.1 |
|---|---:|---:|---:|---:|---:|
| Córtex cerebral (GMV) | +0,39 (0,87) | −1,49 (0,88) | −1,70 | −0,64 (0,83) | −1,85 |
| Substância branca (WMV) | −0,58 (0,75) | +0,24 (1,06) | +0,35 | −0,38 (0,82) | +0,04 |
| Cinzenta subcortical (sGMV) | −0,87 (0,98) | +0,15 (1,08) | −0,25 | −0,96 (0,84) | −0,44 |
| Ventrículos | +0,14 (0,86) | −0,20 (0,97) | −0,36 | +0,58 (0,49) | +0,19 |
| Cérebro total (TCV) | +0,40 (0,88) | 0,00 (1,01) | −0,12 | +0,04 (0,87) | −0,33 |
| Tálamo E | −0,72 (1,19) | +1,76 (1,37) | +1,37 | −0,89 (0,95) | −0,38 |
| Tálamo D | −1,02 (1,23) | +0,38 (1,38) | +0,44 | −0,92 (0,93) | −0,30 |
| Caudado E | +0,23 (0,86) | +0,31 (1,24) | +0,23 | +1,12 (0,99) | −0,09 |
| Caudado D | +0,06 (0,92) | −0,34 (1,36) | −0,44 | +0,79 (0,95) | −0,17 |
| Putâmen E | +0,54 (0,87) | −0,21 (1,35) | −0,37 | +0,12 (0,68) | −0,69 |
| Putâmen D | +0,11 (0,97) | −0,05 (1,39) | −0,36 | −0,15 (0,77) | −0,51 |
| Pálido E | −3,05 (1,21) | −1,57 (1,69) | −1,13 | −1,66 (0,74) | +0,02 |
| Pálido D | −2,54 (1,27) | −1,40 (1,90) | −1,58 | −1,31 (0,83) | +0,26 |
| Hipocampo E | −0,23 (1,02) | −0,16 (1,56) | −0,62 | −0,87 (0,83) | −0,99 |
| Hipocampo D | −0,19 (1,11) | −0,21 (1,43) | −0,86 | −0,49 (0,93) | −0,78 |
| Amígdala E | +0,06 (1,01) | −0,43 (1,38) | −0,74 | −0,21 (0,85) | −0,11 |
| Amígdala D | −0,30 (1,00) | −0,46 (1,30) | −0,58 | −0,45 (0,77) | +0,26 |
| Accumbens E | +1,20 (0,79) | −0,62 (1,50) | −0,62 | +1,45 (0,67) | +0,96 |
| Accumbens D | +0,60 (0,93) | −0,69 (1,15) | −0,91 | +0,88 (0,66) | −0,08 |

## Recentragem (nível A): validação

Deslocamento (em z) que o app desconta, para uma mulher aos 30, 60 e 85 anos, e o termo de sexo masculino. Validação cruzada (10 partes) no DLBS: z médio depois da recentragem por terço de idade (o esperado é 0) e DP. Externo: z médio (DP) antes e depois.

| Medida | n | desloc. 30 · 60 · 85 anos | masc. | VC por terço (≤ 54 · 54–76 · > 76) | DP VC | externo: cru → recentrado |
|---|---:|---|---:|---|---:|---|
| Córtex cerebral (GMV) | 101 | −0,12 · +0,39 · +0,56 | +0,09 | −0,05 · +0,14 · −0,05 | 0,87 | −0,64 → −0,42 (0,84) |
| Substância branca (WMV) | 101 | −0,61 · −0,57 · −0,73 | +0,10 | −0,06 · +0,11 · −0,03 | 0,77 | −0,38 → +0,23 (0,84) |
| Cinzenta subcortical (sGMV) | 101 | −0,69 · −0,69 · −1,23 | +0,02 | −0,07 · +0,12 · −0,05 | 1,00 | −0,96 → −0,19 (0,84) |
| Ventrículos | 101 | +0,42 · +0,09 · −0,28 | +0,21 | +0,05 · −0,02 · +0,01 | 0,86 | +0,58 → +0,02 (0,48) |
| Cérebro total (TCV) | 101 | +0,21 · +0,46 · +0,31 | +0,08 | −0,09 · +0,14 · −0,06 | 0,92 | +0,04 → −0,10 (0,88) |
| Tálamo E | 101 | −0,14 · −0,70 · −1,08 | +0,01 | −0,09 · +0,13 · −0,05 | 1,18 | −0,89 → −0,87 (0,94) |
| Tálamo D | 101 | −0,63 · −0,81 · −1,36 | −0,11 | −0,11 · +0,18 · −0,06 | 1,25 | −0,92 → −0,22 (0,93) |
| Caudado E | 101 | +0,64 · +0,26 · +0,08 | −0,09 | −0,06 · +0,18 · −0,10 | 0,88 | +1,12 → +0,42 (0,97) |
| Caudado D | 101 | +0,65 · +0,21 · −0,16 | −0,20 | −0,08 · +0,17 · −0,11 | 0,91 | +0,79 → +0,14 (0,96) |
| Putâmen E | 101 | +0,14 · +0,55 · +0,43 | +0,21 | −0,01 · +0,08 · −0,04 | 0,90 | +0,12 → +0,05 (0,70) |
| Putâmen D | 101 | −0,14 · +0,30 · +0,08 | −0,04 | −0,09 · +0,12 · −0,04 | 0,98 | −0,15 → +0,19 (0,77) |
| Pálido E | 101 | −3,16 · −3,00 · −3,51 | +0,29 | +0,11 · −0,32 · +0,18 | 1,24 | −1,66 → +1,52 (0,78) |
| Pálido D | 101 | −2,05 · −2,11 · −3,42 | +0,02 | −0,05 · −0,08 · +0,12 | 1,20 | −1,31 → +0,91 (0,84) |
| Hipocampo E | 101 | −0,04 · −0,13 · −0,19 | −0,18 | −0,07 · +0,23 · −0,13 | 1,06 | −0,87 → −0,78 (0,85) |
| Hipocampo D | 101 | −0,20 · −0,20 · −0,36 | +0,12 | −0,06 · +0,24 · −0,12 | 1,15 | −0,49 → −0,31 (0,92) |
| Amígdala E | 101 | +0,21 · +0,12 · +0,24 | −0,23 | −0,10 · +0,07 · +0,02 | 1,04 | −0,21 → −0,38 (0,86) |
| Amígdala D | 101 | −0,10 · −0,06 · −0,34 | −0,26 | −0,03 · +0,07 · −0,01 | 1,02 | −0,45 → −0,18 (0,74) |
| Accumbens E | 101 | +0,76 · +1,06 · +1,39 | +0,15 | −0,06 · +0,17 · −0,09 | 0,79 | +1,45 → +0,67 (0,68) |
| Accumbens D | 101 | +0,47 · +0,74 · +0,73 | −0,16 | −0,06 · +0,20 · −0,14 | 0,95 | +0,88 → +0,57 (0,67) |

**Resumo.** |z| médio dos controles externos: 0,73 sem recentragem → 0,43 com recentragem; no terço mais velho do DLBS (> 76 anos), em validação cruzada: 0,83 → 0,07. O que resta no conjunto externo (outro scanner e protocolo, adultos jovens) é o desvio próprio de cada sítio e protocolo — por isso a calibração com controles locais (nível C) continua necessária para uso sério.

## SynthSeg × FreeSurfer 5.3 editado: o viés de método

Viés do SynthSeg = média geométrica de V_SS / V_FS − 1, no total e por terço de idade; r = correlação dos resíduos (idade e sexo) entre as ferramentas; DP (log, depois de idade e sexo) do SynthSeg, do FreeSurfer e o σ da própria norma nas mesmas idades; DP individual = DP de log(V_FS/V_SS). A última coluna compara o deslocamento FS/SS de um ajuste só deste lado com o de E e D juntos — a diferença é o artefato E/D do FreeSurfer do DLBS (ver a tabela de assimetria). Estes números explicam os z crus; o app não traduz para a escala do FreeSurfer (ver acima).

| Medida | n | r | viés SS | viés por terço de idade | DP SS · FS · norma (log) | DP individual | FS/SS só deste lado · E e D juntos |
|---|---:|---:|---:|---|---|---:|---|
| Córtex cerebral | 99 | 0,90 | +18,5% | +13,9 · +19,1 · +22,9 | 0,070 · 0,078 · 0,088 | 3,4% | −15,6% · −15,6% |
| Substância branca cerebral | 99 | 0,92 | −8,9% | −7,0 · −9,4 · −10,6 | 0,086 · 0,104 · 0,112 | 4,2% | +10,4% · +10,4% |
| Cinzenta subcortical | 101 | 0,78 | −8,0% | −7,5 · −8,7 · −7,7 | 0,080 · 0,083 · 0,080 | 5,3% | +6,3% · +6,3% |
| Ventrículos | 101 | 1,00 | +14,8% | +20,0 · +14,6 · +9,9 | 0,353 · 0,398 · 0,421 | 5,7% | −15,2% · −15,2% |
| Cérebro total (GMV+WMV+sGMV) | 99 | 0,99 | +3,3% | +2,5 · +3,3 · +4,2 | 0,074 · 0,079 · 0,088 | 1,2% | −3,1% · −3,1% |
| Tálamo E | 101 | 0,47 | −21,1% | −19,6 · −21,9 · −21,9 | 0,108 · 0,122 · 0,096 | 12,1% | +23,8% · +17,3% |
| Tálamo D | 101 | 0,66 | −11,8% | −8,3 · −11,8 · −15,2 | 0,102 · 0,125 · 0,090 | 9,7% | +11,1% · +17,3% |
| Caudado E | 101 | 0,59 | −1,6% | +3,1 · −3,4 · −4,4 | 0,102 · 0,157 · 0,125 | 12,8% | −2,3% · −5,8% |
| Caudado D | 99 | 0,65 | +6,1% | +8,4 · +4,9 · +5,0 | 0,107 · 0,157 · 0,126 | 12,0% | −9,2% · −5,8% |
| Putâmen E | 101 | 0,56 | +10,1% | +6,3 · +11,5 · +12,9 | 0,101 · 0,174 · 0,114 | 14,4% | −10,5% · −7,0% |
| Putâmen D | 100 | 0,46 | +2,8% | +1,3 · +1,2 · +5,9 | 0,108 · 0,145 · 0,109 | 13,7% | −3,4% · −7,0% |
| Pálido E | 101 | 0,30 | −19,9% | −11,3 · −21,0 · −26,8 | 0,207 · 0,220 · 0,128 | 25,4% | +9,4% · +8,1% |
| Pálido D | 101 | 0,24 | −13,8% | −5,1 · −16,7 · −19,5 | 0,166 · 0,226 · 0,119 | 24,6% | +6,8% · +8,1% |
| Hipocampo E | 99 | 0,79 | −1,3% | −3,4 · −0,8 · +0,4 | 0,097 · 0,128 · 0,093 | 7,8% | +2,4% · +1,8% |
| Hipocampo D | 100 | 0,86 | 0,0% | −1,9 · −1,4 · +3,6 | 0,106 · 0,131 · 0,093 | 6,8% | +1,2% · +1,8% |
| Amígdala E | 100 | 0,71 | +6,3% | +3,0 · +5,0 · +11,4 | 0,131 · 0,168 · 0,128 | 12,2% | −5,6% · −4,1% |
| Amígdala D | 101 | 0,54 | +2,2% | +4,6 · −0,7 · +2,6 | 0,127 · 0,168 · 0,123 | 14,7% | −2,5% · −4,1% |
| Accumbens E | 97 | 0,34 | +46,5% | +36,7 · +48,3 · +56,2 | 0,146 · 0,330 · 0,220 | 31,3% | −34,4% · −29,2% |
| Accumbens D | 101 | 0,48 | +28,4% | +19,1 · +31,4 · +35,8 | 0,167 · 0,228 · 0,185 | 20,9% | −23,7% · −29,2% |

Terços de idade: até 54 · 54–76 · acima de 76 anos.

## Assimetria do mesmo método

IA = 200·(E − D)/(E + D) do volume suave do SynthSeg; média e DP por idade no JSON. Comparação com o FreeSurfer 5.3 nos mesmos sujeitos e com o ENIGMA (Guadalupe et al., Brain Imaging Behav 2017; FreeSurfer 4–5.3; DP intra-dataset).

| Estrutura | n | IA médio (SS) | DP (SS) | inclinação/década | IA FS 5.3 | DP FS 5.3 | ENIGMA média ± DP |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tálamo | 101 | +5,5 | 6,3 | −1,1 | +16,6 | 13,3 | +4,2 ± 6,0 |
| Caudado | 101 | −1,6 | 4,6 | +0,3 | +5,5 | 17,1 | −1,9 ± 4,9 |
| Putâmen | 101 | +6,0 | 6,1 | +0,2 | −1,5 | 21,5 | +3,9 ± 5,7 |
| Pálido | 101 | −6,8 | 18,7 | +0,8 | +0,3 | 29,4 | +3,6 ± 10,4 |
| Hipocampo | 100 | −3,1 | 6,2 | −0,2 | −2,1 | 11,8 | −1,3 ± 5,7 |
| Amígdala | 101 | −4,2 | 9,4 | −0,2 | −8,9 | 18,2 | −4,1 ± 10,4 |
| Accumbens | 101 | +0,8 | 12,1 | −0,2 | −16,6 | 39,2 | −1,4 ± 15,6 |
| Diencéfalo ventral | 101 | +2,4 | 5,8 | +0,4 | +2,2 | 14,7 | — |
| Ventrículo lateral | 101 | +6,9 | 17,2 | +0,1 | +6,2 | 22,6 | — |
| Corno temporal | 101 | −2,0 | 24,1 | +1,0 | +11,8 | 51,4 | — |
| Córtex cerebral | 99 | −0,2 | 1,0 | +0,0 | — | — | — |
| SB cerebral | 101 | −0,3 | 1,2 | +0,0 | — | — | — |
| Córtex cerebelar | 101 | +0,9 | 3,2 | +0,2 | −2,8 | 4,9 | — |
| SB cerebelar | 101 | −0,4 | 3,0 | +0,0 | −4,4 | 14,4 | — |

## Ocupação hipocampal (HOC) do mesmo método

HOC = V_hip / (V_hip + V_corno temporal), volume suave; média quadrática e DP linear na idade.

| Lado | n | HOC aos 30 | aos 60 | aos 85 | DP aos 60 |
|---|---:|---:|---:|---:|---:|
| esquerdo | 98 | 0,891 | 0,857 | 0,774 | 0,040 |
| direito | 100 | 0,888 | 0,854 | 0,769 | 0,051 |

## Como regenerar

Veja `docs/plano-metodologico.md` ("Como regenerar os coeficientes").

