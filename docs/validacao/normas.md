# Normas SegmentaRM — validação deixando um sítio de fora

Gerado por `tools/normas_relatorio.py` em 2026-11-27 (normas versão 1.1). Não edite à mão: rode o pipeline de `docs/normas-proprias.md` §4.

## 1. Amostra

641 exames de 14 sítios (sítio = scanner × protocolo); idades 18–89 anos; 346 F / 295 M. Volumes SUAVES do SynthSeg 1.0 do app (bloco 128³, espelhamento E/D); VIC = eTIV afim do app.

| Sítio | Base | Scanner | n | Idades | F/M |
|---|---|---|---|---|---|
| aomic_id1000 | ds003097 | Philips Intera 3T | 20 | 19–26 | 10/10 |
| aomic_piop1 | ds002785 | Philips Achieva 3T | 15 | 19–26 | 9/6 |
| aomic_piop2 | ds002790 | Philips Achieva 3T | 15 | 19–26 | 9/6 |
| dlbs | ds004856 | Philips Achieva 3T | 201 | 21–89 | 104/97 |
| ds3592_s1 | ds003592 | Siemens 3T (incerto) 3T | 35 | 19–83 | 18/17 |
| ds3592_s2 | ds003592 | Siemens 3T (incerto) 3T | 25 | 18–82 | 18/7 |
| la5c | ds000030 | Siemens Trio 3T | 30 | 21–50 | 18/12 |
| mrart | ds004173 | Siemens Prisma 3T | 40 | 19–75 | 21/19 |
| nimh_fspgr | ds005752 | GE DISCOVERY MR750 3T | 20 | 18–72 | 12/8 |
| nimh_mprage | ds005752 | GE DISCOVERY MR750 3T | 40 | 19–71 | 23/17 |
| pan_atlanta | ds007522 | Siemens MAGNETOM Prisma Fit 3T | 50 | 49–78 | 26/24 |
| pan_baltimore | ds007522 | Philips Ingenia Elition X 3T | 50 | 51–79 | 26/24 |
| pan_miami | ds007522 | Siemens MAGNETOM Vida 3T | 50 | 50–78 | 26/24 |
| pan_tucson | ds007522 | Siemens Skyra 3T | 50 | 50–79 | 26/24 |

Por década (F/M): 10s 15/11 · 20s 58/44 · 30s 26/24 · 40s 22/20 · 50s 65/49 · 60s 64/60 · 70s 62/60 · 80+ 34/27.

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

Mesmos exames, cada sítio com n ≥ 10 deixado de fora do ajuste das normas próprias. Ideal num sítio não visto: média ≈ 0, DP ≈ √(1 + σ_sítio²) e |z| > 1,96 em ≈ 5% × o excesso pelo sítio. "RMS sítio" = raiz da média dos quadrados das médias por sítio (viés típico de um sítio). A recentragem do pipeline atual foi ajustada no DLBS, por isso as métricas saem também sem ele.

### Todos os sítios (641 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | −0,03 · 1,03 · 5,0% · 0,37 | +0,02 · 0,95 · 4,2% · 0,30 | +0,31 · 1,01 · 7,0% · 0,37 |
| Substância branca | −0,05 · 1,03 · 4,5% · 0,29 | +0,11 · 0,86 · 1,9% · 0,31 | −0,47 · 0,86 · 3,7% · 0,47 |
| Cinzenta subcortical | −0,13 · 1,12 · 8,0% · 0,36 | +0,36 · 1,00 · 6,4% · 0,54 | −0,47 · 1,03 · 7,3% · 0,48 |
| Ventrículos | −0,02 · 1,04 · 5,3% · 0,15 | +0,01 · 0,88 · 2,7% · 0,22 | +0,21 · 0,93 · 3,1% · 0,50 |
| Cérebro total (GMV+WMV) | −0,03 · 1,02 · 4,8% · 0,31 | +0,07 · 0,96 · 3,6% · 0,31 | −0,19 · 0,96 · 3,4% · 0,30 |
| Tálamo E | +0,05 · 1,08 · 7,3% · 0,45 | −0,02 · 1,15 · 9,4% · 0,62 | −0,54 · 1,11 · 10,8% · 0,63 |
| Tálamo D | −0,06 · 1,10 · 7,6% · 0,38 | +0,24 · 1,15 · 9,2% · 0,48 | −0,69 · 1,15 · 13,4% · 0,71 |
| Caudado E | −0,08 · 1,05 · 5,5% · 0,29 | +0,26 · 0,93 · 3,7% · 0,46 | +0,63 · 0,99 · 8,9% · 0,90 |
| Caudado D | −0,08 · 1,06 · 6,4% · 0,29 | +0,27 · 0,93 · 2,8% · 0,46 | +0,52 · 1,01 · 8,1% · 0,82 |
| Putâmen E | −0,08 · 1,10 · 7,0% · 0,34 | +0,29 · 0,94 · 4,2% · 0,50 | +0,67 · 0,95 · 8,4% · 0,75 |
| Putâmen D | −0,09 · 1,08 · 5,8% · 0,32 | +0,37 · 1,01 · 6,2% · 0,61 | +0,32 · 1,00 · 6,1% · 0,47 |
| Pálido E | −0,40 · 1,37 · 15,0% · 0,76 | +1,07 · 1,39 · 28,9% · 1,74 | −2,20 · 1,38 · 50,2% · 1,90 |
| Pálido D | −0,33 · 1,27 · 11,9% · 0,62 | +0,77 · 1,20 · 17,0% · 1,27 | −1,63 · 1,29 · 34,5% · 1,35 |
| Hipocampo E | −0,06 · 1,10 · 8,3% · 0,37 | +0,20 · 1,06 · 8,3% · 0,39 | +0,03 · 1,07 · 6,9% · 0,35 |
| Hipocampo D | −0,12 · 1,15 · 8,3% · 0,36 | +0,24 · 1,15 · 8,4% · 0,44 | +0,04 · 1,16 · 7,2% · 0,35 |
| Amígdala E | −0,17 · 1,13 · 9,0% · 0,32 | +0,40 · 1,03 · 6,2% · 0,59 | +0,43 · 1,03 · 6,9% · 0,60 |
| Amígdala D | −0,18 · 1,10 · 7,8% · 0,39 | +0,48 · 1,00 · 6,4% · 0,71 | +0,13 · 1,00 · 5,1% · 0,43 |
| Accumbens E | −0,14 · 1,12 · 8,9% · 0,45 | +0,45 · 0,88 · 6,2% · 0,73 | +1,51 · 0,87 · 30,0% · 1,67 |
| Accumbens D | −0,20 · 1,16 · 8,4% · 0,51 | +0,46 · 0,95 · 6,7% · 0,76 | +0,98 · 0,95 · 16,7% · 1,19 |
| **Média das medidas** (\|média\|) | **0,12 · 1,11 · 7,6% · 0,38** | **0,32 · 1,02 · 7,5% · 0,60** | **0,63 · 1,04 · 12,5% · 0,75** |

### Sem o DLBS (440 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | −0,03 · 1,06 · 6,1% · 0,38 | +0,03 · 0,97 · 4,3% · 0,32 | +0,26 · 1,03 · 6,8% · 0,36 |
| Substância branca | +0,02 · 1,08 · 5,9% · 0,29 | +0,17 · 0,90 · 2,5% · 0,32 | −0,42 · 0,90 · 4,8% · 0,46 |
| Cinzenta subcortical | +0,09 · 1,03 · 5,7% · 0,33 | +0,53 · 0,96 · 7,0% · 0,56 | −0,27 · 0,97 · 3,9% · 0,43 |
| Ventrículos | −0,01 · 1,02 · 4,1% · 0,16 | +0,01 · 0,88 · 2,5% · 0,23 | +0,26 · 0,94 · 3,6% · 0,52 |
| Cérebro total (GMV+WMV) | +0,01 · 1,07 · 6,1% · 0,32 | +0,11 · 0,98 · 4,3% · 0,33 | −0,17 · 0,99 · 4,5% · 0,31 |
| Tálamo E | +0,07 · 1,07 · 7,0% · 0,46 | −0,04 · 1,15 · 9,8% · 0,64 | −0,47 · 1,08 · 10,0% · 0,63 |
| Tálamo D | +0,09 · 1,04 · 5,9% · 0,38 | +0,35 · 1,10 · 8,9% · 0,50 | −0,52 · 1,07 · 9,1% · 0,67 |
| Caudado E | +0,05 · 1,03 · 4,5% · 0,28 | +0,38 · 0,93 · 4,3% · 0,48 | +0,80 · 0,97 · 10,7% · 0,93 |
| Caudado D | +0,06 · 1,03 · 5,0% · 0,28 | +0,39 · 0,92 · 3,4% · 0,48 | +0,71 · 0,97 · 9,5% · 0,85 |
| Putâmen E | +0,07 · 1,03 · 5,9% · 0,33 | +0,42 · 0,91 · 4,8% · 0,51 | +0,77 · 0,92 · 8,9% · 0,76 |
| Putâmen D | +0,08 · 1,01 · 5,0% · 0,30 | +0,55 · 0,96 · 6,6% · 0,63 | +0,47 · 0,95 · 6,4% · 0,49 |
| Pálido E | +0,14 · 1,01 · 5,0% · 0,65 | +1,55 · 1,08 · 35,2% · 1,80 | −1,71 · 1,02 · 36,1% · 1,75 |
| Pálido D | +0,10 · 1,04 · 5,5% · 0,54 | +1,13 · 0,98 · 18,6% · 1,32 | −1,19 · 0,97 · 19,5% · 1,20 |
| Hipocampo E | +0,06 · 1,07 · 7,5% · 0,37 | +0,29 · 1,03 · 8,2% · 0,40 | +0,12 · 1,03 · 6,8% · 0,35 |
| Hipocampo D | +0,07 · 1,03 · 6,4% · 0,34 | +0,37 · 1,02 · 8,2% · 0,46 | +0,19 · 1,02 · 6,4% · 0,35 |
| Amígdala E | +0,08 · 0,99 · 5,7% · 0,27 | +0,58 · 0,93 · 5,9% · 0,61 | +0,60 · 0,94 · 6,6% · 0,62 |
| Amígdala D | +0,10 · 0,99 · 5,0% · 0,34 | +0,70 · 0,89 · 6,1% · 0,74 | +0,36 · 0,89 · 3,4% · 0,43 |
| Accumbens E | +0,10 · 1,10 · 8,2% · 0,42 | +0,65 · 0,84 · 8,2% · 0,76 | +1,67 · 0,85 · 36,1% · 1,70 |
| Accumbens D | +0,07 · 1,06 · 5,7% · 0,48 | +0,67 · 0,89 · 7,5% · 0,79 | +1,18 · 0,89 · 20,9% · 1,22 |
| **Média das medidas** (\|média\|) | **0,07 · 1,04 · 5,8% · 0,37** | **0,47 · 0,96 · 8,2% · 0,63** | **0,64 · 0,97 · 11,3% · 0,74** |

Medidas só das normas próprias (sem equivalente no pipeline atual):

| Medida | média · DP · \|z\|>1,96 · RMS sítio |
|---|---|
| Corno temporal E | −0,06 · 1,05 · 6,2% · 0,37 |
| Corno temporal D | −0,01 · 1,08 · 6,7% · 0,31 |
| Ventrículo lateral E | −0,03 · 1,04 · 5,8% · 0,18 |
| Ventrículo lateral D | −0,02 · 1,03 · 6,2% · 0,13 |
| Cerebelo | −0,06 · 1,04 · 6,7% · 0,24 |
| Tronco | −0,07 · 1,04 · 5,6% · 0,26 |
| VIC (eTIV) | +0,06 · 1,05 · 5,6% · 0,38 |

## 4. Por década, sexo e fabricante (sítio não visto)

| Década | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| 10s | 26 | +0,35 (1,20) / +0,24 (1,01) | +0,08 (1,10) / +0,30 (0,94) | +0,16 (0,96) / +0,56 (0,75) | +0,08 (1,26) / +0,26 (1,04) | +0,24 (1,24) / +0,47 (1,00) |
| 20s | 102 | +0,04 (1,02) / +0,11 (0,91) | −0,02 (1,03) / +0,19 (0,90) | −0,05 (1,05) / +0,27 (0,80) | −0,10 (0,96) / +0,12 (0,84) | −0,10 (0,95) / +0,17 (0,85) |
| 30s | 50 | −0,24 (1,01) / −0,09 (0,95) | −0,16 (1,04) / −0,03 (0,95) | −0,15 (1,08) / −0,01 (0,88) | +0,02 (1,34) / +0,26 (1,22) | −0,02 (1,30) / +0,21 (1,28) |
| 40s | 42 | −0,06 (1,04) / +0,05 (0,99) | +0,02 (1,03) / +0,08 (0,97) | +0,12 (1,09) / +0,02 (0,93) | −0,37 (1,03) / −0,13 (0,96) | −0,35 (1,04) / −0,14 (1,00) |
| 50s | 114 | −0,05 (0,98) / +0,02 (0,94) | +0,06 (0,99) / +0,09 (0,94) | +0,04 (1,07) / −0,14 (0,92) | +0,09 (1,04) / +0,31 (0,99) | +0,08 (1,00) / +0,33 (0,92) |
| 60s | 124 | −0,06 (1,06) / −0,01 (0,99) | +0,02 (1,06) / +0,07 (1,01) | −0,07 (0,96) / −0,21 (0,82) | +0,05 (0,98) / +0,29 (0,97) | −0,01 (1,06) / +0,32 (1,03) |
| 70s | 122 | −0,07 (1,07) / −0,05 (1,01) | −0,12 (1,07) / −0,02 (1,03) | +0,05 (0,99) / +0,03 (0,84) | −0,02 (1,13) / +0,31 (1,19) | −0,04 (1,09) / +0,47 (1,18) |
| 80+ | 61 | +0,01 (0,85) / +0,03 (0,82) | −0,16 (0,86) / +0,03 (0,85) | −0,25 (1,18) / +0,05 (0,94) | −0,55 (1,22) / −0,12 (1,28) | −0,97 (1,50) / −0,22 (1,87) |

| Sexo | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| F | 346 | −0,03 (1,03) / +0,01 (1,00) | −0,03 (1,02) / +0,06 (1,01) | −0,03 (1,05) / +0,04 (0,92) | −0,04 (1,10) / +0,15 (1,13) | −0,10 (1,10) / +0,23 (1,17) |
| M | 295 | −0,04 (1,03) / +0,03 (0,90) | −0,04 (1,02) / +0,09 (0,90) | −0,02 (1,03) / −0,02 (0,83) | −0,09 (1,10) / +0,26 (0,97) | −0,14 (1,20) / +0,25 (1,14) |

| Fabricante | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| GE | 60 | +0,01 (1,03) / +0,09 (0,95) | +0,08 (0,98) / +0,17 (0,90) | +0,07 (1,20) / +0,09 (0,94) | +0,11 (1,00) / +0,31 (0,96) | +0,19 (1,06) / +0,42 (1,01) |
| Philips | 301 | −0,02 (1,00) / +0,02 (0,94) | −0,10 (0,98) / +0,03 (0,94) | −0,04 (1,03) / +0,03 (0,85) | −0,35 (1,10) / −0,03 (1,07) | −0,44 (1,21) / −0,01 (1,25) |
| Siemens | 280 | −0,06 (1,06) / −0,00 (0,97) | +0,01 (1,07) / +0,10 (0,99) | −0,02 (1,02) / −0,03 (0,90) | +0,21 (1,05) / +0,43 (1,02) | +0,16 (1,00) / +0,47 (1,01) |

Valores: média do z (DP).

## 5. Com controles locais (calibração do app)

O z de cada sítio é deslocado pela média de k controles sorteados do próprio sítio; métricas nos demais exames do sítio (sítios com n ≥ k + 10; 200 sorteios). Ideal: RMS da média → 0, DP → 1, |z| > 1,96 → 5%.

| k | Própria: RMS média · DP · \|z\|>1,96 | Atual (recentrado) |
|---|---|---|
| sem | 0,38 · 1,11 · 7,6% | 0,60 · 1,02 · 7,5% |
| 5 | 0,50 · 0,99 · 7,5% | 0,46 · 0,92 · 5,6% |
| 10 | 0,39 · 1,00 · 6,5% | 0,36 · 0,93 · 4,9% |
| 20 | 0,31 · 0,99 · 5,9% | 0,29 · 0,93 · 4,4% |
| 30 | 0,30 · 0,98 · 5,5% | 0,28 · 0,92 · 4,2% |

Médias sobre as medidas comuns (globais e subcorticais E/D).

## 6. Leitura

Ver a seção "Validação" de `docs/normas-proprias.md` para a interpretação e as limitações.
