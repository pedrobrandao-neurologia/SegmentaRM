# Normas SegmentaRM — validação externa (sítios que não entraram no ajuste)

Gerado por `tools/normas_relatorio.py` em 2026-11-27 (normas versão 1.1). Não edite à mão: rode o pipeline de `docs/normas-proprias.md` §4.

## 1. Amostra

385 exames de 21 sítios (sítio = scanner × protocolo); idades 18–85 anos; 202 F / 183 M. Volumes SUAVES do SynthSeg 1.0 do app (bloco 128³, espelhamento E/D); VIC = eTIV afim do app.

| Sítio | Base | Scanner | n | Idades | F/M |
|---|---|---|---|---|---|
| fcon_annarbor_a | fcon1000 | não informado | 8 | 18–41 | 2/6 |
| fcon_annarbor_b | fcon1000 | não informado | 30 | 19–80 | 16/14 |
| fcon_atlanta | fcon1000 | não informado | 20 | 22–57 | 11/9 |
| fcon_baltimore | fcon1000 | não informado | 12 | 20–40 | 8/4 |
| fcon_bangor | fcon1000 | não informado | 10 | 19–38 | 0/10 |
| fcon_beijing_zang | fcon1000 | não informado | 25 | 18–26 | 13/12 |
| fcon_berlin_margulies | fcon1000 | não informado | 12 | 23–44 | 7/5 |
| fcon_cambridge_buckner | fcon1000 | não informado | 12 | 18–30 | 7/5 |
| fcon_icbm | fcon1000 | não informado | 86 | 19–85 | 45/41 |
| fcon_leiden_2180 | fcon1000 | não informado | 6 | 20–27 | 0/6 |
| fcon_leiden_2200 | fcon1000 | não informado | 6 | 18–28 | 2/4 |
| fcon_milwaukee_b | fcon1000 | não informado | 46 | 44–65 | 31/15 |
| fcon_munchen | fcon1000 | não informado | 16 | 63–74 | 6/10 |
| fcon_newark | fcon1000 | não informado | 10 | 22–26 | 7/3 |
| fcon_newyork_b | fcon1000 | não informado | 12 | 18–46 | 6/6 |
| fcon_orangeburg | fcon1000 | não informado | 15 | 20–55 | 4/11 |
| fcon_oulu | fcon1000 | não informado | 15 | 21–22 | 8/7 |
| fcon_oxford | fcon1000 | não informado | 10 | 20–35 | 7/3 |
| fcon_paloalto | fcon1000 | não informado | 12 | 23–46 | 10/2 |
| fcon_queensland | fcon1000 | não informado | 12 | 21–34 | 5/7 |
| fcon_saintlouis | fcon1000 | não informado | 10 | 21–27 | 7/3 |

Por década (F/M): 10s 16/16 · 20s 83/68 · 30s 22/29 · 40s 23/24 · 50s 26/20 · 60s 22/10 · 70s 9/15 · 80+ 1/1.

## 2. Modelos

GAMLSS por fenótipo: ln V ~ SHASHo (ou normal, pelo BIC); μ = P-spline da idade + sexo + sítio aleatório; σ = P-spline da idade + sexo. σ_sítio = DP do efeito de sítio; em z, dividido pelo σ aos 60 anos (F). Erro da curva = erro-padrão do μ populacional por bootstrap de sítios, em z, aos 60 e aos 85 anos.

| Fenótipo | Família | n | Excluídos (\|z\| > 5) | σ_sítio (z) | Erro da curva 60 / 85 anos (z) |
|---|---|---|---|---|---|
| Córtex cerebral | NO | 641 | 0 | 0,18 | 0,06 / 0,12 |
| Substância branca | NO | 641 | 0 | 0,18 | 0,07 / 0,23 |
| Cinzenta subcortical | NO | 641 | 0 | 0,28 | 0,11 / 0,20 |
| Ventrículos | SHASHo | 641 | 0 | 0,00 | 0,16 / 0,28 |
| Cérebro total (GMV+WMV) | NO | 641 | 0 | 0,18 | 0,06 / 0,10 |
| Tálamo E | NO | 641 | 0 | 0,31 | 0,13 / 0,17 |
| Tálamo D | NO | 641 | 0 | 0,29 | 0,10 / 0,21 |
| Caudado E | NO | 641 | 0 | 0,20 | 0,09 / 0,32 |
| Caudado D | NO | 641 | 0 | 0,21 | 0,08 / 0,29 |
| Putâmen E | NO | 641 | 0 | 0,26 | 0,10 / 0,11 |
| Putâmen D | NO | 641 | 0 | 0,26 | 0,10 / 0,11 |
| Pálido E | SHASHo | 641 | 0 | 0,88 | 0,25 / 0,59 |
| Pálido D | SHASHo | 641 | 0 | 0,65 | 0,25 / 0,43 |
| Hipocampo E | NO | 641 | 0 | 0,27 | 0,09 / 0,16 |
| Hipocampo D | SHASHo | 641 | 0 | 0,36 | 0,12 / 0,22 |
| Amígdala E | NO | 641 | 0 | 0,27 | 0,11 / 0,21 |
| Amígdala D | SHASHo | 641 | 0 | 0,39 | 0,19 / 0,55 |
| Accumbens E | SHASHo | 641 | 0 | 0,37 | 0,13 / 0,26 |
| Accumbens D | NO | 641 | 0 | 0,37 | 0,11 / 0,13 |
| Corno temporal E | SHASHo | 641 | 0 | 0,27 | 0,30 / 0,74 |
| Corno temporal D | SHASHo | 641 | 0 | 0,24 | 0,27 / 0,30 |
| Ventrículo lateral E | SHASHo | 641 | 0 | 0,00 | 0,19 / 0,47 |
| Ventrículo lateral D | SHASHo | 641 | 0 | 0,00 | 0,19 / 0,21 |
| Cerebelo | NO | 641 | 0 | 0,13 | 0,10 / 0,21 |
| Tronco | NO | 641 | 0 | 0,19 | 0,09 / 0,22 |
| VIC (eTIV) | NO | 572 | 0 | 0,23 | 0,09 / 0,13 |

## 3. Sítio não visto: própria × pipeline atual

Exames de sítios que NÃO entraram no ajuste destas normas, avaliados pela curva populacional. Ideal num sítio não visto: média ≈ 0, DP ≈ √(1 + σ_sítio²) e |z| > 1,96 em ≈ 5% × o excesso pelo sítio. "RMS sítio" = raiz da média dos quadrados das médias por sítio (viés típico de um sítio). A recentragem do pipeline atual foi ajustada no DLBS, por isso as métricas saem também sem ele.

### Todos os sítios (385 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | −0,23 · 1,00 · 4,7% · 0,50 | −0,15 · 0,89 · 3,4% · 0,39 | −0,16 · 1,02 · 7,5% · 0,55 |
| Substância branca | +0,00 · 1,02 · 6,0% · 0,38 | +0,19 · 0,88 · 2,9% · 0,34 | −0,42 · 0,88 · 5,7% · 0,59 |
| Cinzenta subcortical | −0,37 · 1,14 · 9,6% · 0,78 | +0,13 · 1,00 · 4,9% · 0,49 | −0,65 · 1,01 · 10,1% · 0,92 |
| Ventrículos | −0,08 · 1,01 · 5,7% · 0,25 | +0,05 · 0,87 · 3,6% · 0,32 | +0,42 · 0,94 · 5,5% · 0,70 |
| Cérebro total (GMV+WMV) | −0,13 · 1,02 · 5,7% · 0,44 | +0,03 · 0,91 · 4,4% · 0,32 | −0,36 · 0,96 · 5,7% · 0,61 |
| Tálamo E | −0,48 · 1,12 · 9,9% · 0,93 | −0,75 · 1,19 · 16,6% · 1,22 | −0,90 · 1,09 · 16,6% · 1,18 |
| Tálamo D | −0,40 · 0,99 · 7,8% · 0,71 | −0,24 · 1,06 · 6,8% · 0,68 | −0,97 · 1,03 · 16,4% · 1,16 |
| Caudado E | −0,23 · 1,12 · 8,1% · 0,49 | +0,19 · 1,02 · 5,2% · 0,36 | +0,72 · 1,02 · 12,5% · 0,81 |
| Caudado D | −0,29 · 1,12 · 7,8% · 0,52 | +0,14 · 1,01 · 6,2% · 0,36 | +0,61 · 1,02 · 9,9% · 0,73 |
| Putâmen E | −0,21 · 1,11 · 8,1% · 0,64 | +0,25 · 0,98 · 5,7% · 0,48 | +0,45 · 0,99 · 7,5% · 0,56 |
| Putâmen D | −0,21 · 1,07 · 5,2% · 0,58 | +0,39 · 0,98 · 7,3% · 0,55 | +0,14 · 0,99 · 4,9% · 0,45 |
| Pálido E | +0,15 · 1,04 · 6,0% · 0,59 | +1,66 · 1,10 · 40,8% · 1,90 | −1,72 · 1,03 · 35,8% · 1,69 |
| Pálido D | −0,14 · 1,02 · 3,9% · 0,47 | +1,02 · 0,93 · 16,4% · 1,21 | −1,27 · 0,88 · 21,0% · 1,24 |
| Hipocampo E | −0,32 · 1,22 · 10,1% · 0,76 | −0,06 · 1,08 · 6,0% · 0,52 | −0,26 · 1,09 · 7,3% · 0,66 |
| Hipocampo D | −0,26 · 1,13 · 8,6% · 0,66 | +0,01 · 1,09 · 7,3% · 0,51 | −0,18 · 1,09 · 7,3% · 0,61 |
| Amígdala E | −0,41 · 1,20 · 12,7% · 0,81 | +0,15 · 1,07 · 6,0% · 0,55 | +0,13 · 1,07 · 6,0% · 0,55 |
| Amígdala D | −0,49 · 1,20 · 11,9% · 0,90 | +0,20 · 1,07 · 6,8% · 0,62 | −0,14 · 1,08 · 6,2% · 0,63 |
| Accumbens E | −0,12 · 1,09 · 6,8% · 0,42 | +0,57 · 0,82 · 4,7% · 0,58 | +1,50 · 0,83 · 27,0% · 1,45 |
| Accumbens D | −0,11 · 1,12 · 8,8% · 0,35 | +0,57 · 0,91 · 6,0% · 0,60 | +1,00 · 0,92 · 16,4% · 0,97 |
| **Média das medidas** (\|média\|) | **0,24 · 1,09 · 7,8% · 0,59** | **0,36 · 0,99 · 8,5% · 0,63** | **0,63 · 1,00 · 12,1% · 0,84** |

Medidas só das normas próprias (sem equivalente no pipeline atual):

| Medida | média · DP · \|z\|>1,96 · RMS sítio |
|---|---|
| Corno temporal E | +0,09 · 0,96 · 3,9% · 0,44 |
| Corno temporal D | +0,08 · 0,90 · 2,6% · 0,45 |
| Ventrículo lateral E | −0,05 · 1,04 · 6,0% · 0,26 |
| Ventrículo lateral D | −0,08 · 0,97 · 4,9% · 0,26 |
| Cerebelo | −0,29 · 1,06 · 7,3% · 0,52 |
| Tronco | −0,33 · 1,01 · 6,5% · 0,52 |
| VIC (eTIV) | −0,02 · 1,11 · 7,6% · 0,48 |

## 4. Por década, sexo e fabricante (sítio não visto)

| Década | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| 10s | 32 | +0,02 (0,78) / −0,11 (0,69) | −0,05 (0,82) / +0,17 (0,73) | −0,05 (1,00) / +0,41 (0,76) | +0,07 (0,95) / +0,22 (0,79) | −0,09 (0,92) / +0,19 (0,76) |
| 20s | 151 | −0,36 (1,00) / −0,26 (0,83) | −0,34 (0,97) / −0,10 (0,82) | +0,03 (0,90) / +0,33 (0,70) | −0,61 (1,34) / −0,29 (1,09) | −0,47 (1,19) / −0,18 (1,09) |
| 30s | 51 | −0,47 (0,98) / −0,30 (0,86) | −0,25 (1,08) / −0,10 (0,95) | −0,13 (1,02) / −0,04 (0,82) | −0,33 (1,11) / −0,08 (1,02) | −0,25 (1,00) / −0,04 (1,02) |
| 40s | 47 | −0,30 (1,16) / −0,15 (1,08) | −0,09 (1,12) / −0,02 (1,03) | −0,13 (1,05) / −0,22 (0,85) | −0,13 (1,40) / +0,08 (1,33) | −0,07 (1,40) / +0,10 (1,39) |
| 50s | 46 | +0,03 (0,94) / +0,10 (0,90) | +0,17 (0,96) / +0,19 (0,91) | −0,25 (1,10) / −0,40 (0,92) | −0,20 (1,06) / +0,03 (1,03) | −0,12 (1,03) / +0,14 (0,96) |
| 60s | 32 | +0,07 (1,07) / +0,11 (1,06) | +0,30 (1,15) / +0,36 (1,16) | −0,10 (1,21) / −0,19 (1,05) | −0,13 (1,02) / +0,10 (1,00) | −0,20 (1,12) / +0,10 (1,14) |
| 70s | 24 | +0,06 (0,82) / +0,06 (0,76) | +0,22 (0,82) / +0,27 (0,76) | −0,30 (1,19) / −0,29 (0,99) | +0,09 (0,78) / +0,44 (0,82) | +0,04 (0,81) / +0,52 (0,89) |
| 80+ | 2 | — | — | — | — | — |

| Sexo | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| F | 202 | −0,20 (0,91) / −0,15 (0,87) | −0,10 (0,95) / +0,03 (0,90) | −0,10 (0,98) / +0,07 (0,87) | −0,21 (1,07) / −0,01 (1,05) | −0,23 (1,12) / +0,05 (1,13) |
| M | 183 | −0,26 (1,10) / −0,14 (0,91) | −0,15 (1,09) / +0,03 (0,92) | −0,06 (1,05) / +0,03 (0,87) | −0,45 (1,36) / −0,10 (1,11) | −0,29 (1,15) / −0,03 (1,04) |

| Fabricante | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|

Valores: média do z (DP).

## 5. Com controles locais (calibração do app)

O z de cada sítio é deslocado pela média de k controles sorteados do próprio sítio; métricas nos demais exames do sítio (sítios com n ≥ k + 10; 200 sorteios). Ideal: RMS da média → 0, DP → 1, |z| > 1,96 → 5%.

| k | Própria: RMS média · DP · \|z\|>1,96 | Atual (recentrado) |
|---|---|---|
| sem | 0,59 · 1,09 · 7,8% | 0,63 · 0,99 · 8,5% |
| 5 | 0,54 · 1,04 · 9,1% | 0,49 · 0,94 · 6,4% |
| 10 | 0,39 · 0,99 · 6,1% | 0,36 · 0,90 · 4,3% |
| 20 | 0,33 · 1,00 · 5,9% | 0,30 · 0,93 · 4,2% |
| 30 | 0,26 · 0,95 · 4,2% | 0,24 · 0,88 · 3,1% |

Médias sobre as medidas comuns (globais e subcorticais E/D).

## 6. Leitura

Ver a seção "Validação" de `docs/normas-proprias.md` para a interpretação e as limitações.
