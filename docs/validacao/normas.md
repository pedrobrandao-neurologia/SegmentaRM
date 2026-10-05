# Normas SegmentaRM — validação deixando um sítio de fora

Gerado por `tools/normas_relatorio.py` em 2026-10-05 (normas versão 1.0). Não edite à mão: rode o pipeline de `docs/normas-proprias.md` §4.

## 1. Amostra

641 exames de 14 sítios (sítio = scanner × protocolo); idades 18–89 anos; 346 F / 295 M. Volumes SUAVES do SynthSeg 1.0 do app (bloco 128³, espelhamento E/D); VIC = eTIV afim do app.

| Sítio | Base | Scanner | n | Idades | F/M |
|---|---|---|---|---|---|
| aomic_id1000 | ds003097 | Philips Intera 3T | 20 | 19–26 | 10/10 |
| aomic_piop1 | ds002785 | Philips Achieva 3T | 15 | 18–26 | 9/6 |
| aomic_piop2 | ds002790 | Philips Achieva 3T | 15 | 19–25 | 9/6 |
| dlbs | ds004856 | Philips Achieva 3T | 201 | 21–89 | 104/97 |
| ds3592_s1 | ds003592 | Siemens 3T (incerto) 3T | 35 | 19–83 | 18/17 |
| ds3592_s2 | ds003592 | Siemens 3T (incerto) 3T | 25 | 18–82 | 18/7 |
| la5c | ds000030 | Siemens Trio 3T | 30 | 21–50 | 18/12 |
| mrart | ds004173 | Siemens Prisma 3T | 40 | 19–75 | 21/19 |
| nimh_fspgr | ds005752 | GE DISCOVERY MR750 3T | 20 | 18–72 | 12/8 |
| nimh_mprage | ds005752 | GE DISCOVERY MR750 3T | 40 | 19–71 | 23/17 |
| pan_atlanta | ds007522 | Siemens MAGNETOM Prisma Fit 3T | 50 | 49–78 | 26/24 |
| pan_baltimore | ds007522 | Philips Ingenia Elition X 3T | 50 | 49–79 | 26/24 |
| pan_miami | ds007522 | Siemens MAGNETOM Vida 3T | 50 | 50–79 | 26/24 |
| pan_tucson | ds007522 | Siemens Skyra 3T | 50 | 50–79 | 26/24 |

Por década (F/M): 10s 15/11 · 20s 58/44 · 30s 26/24 · 40s 23/20 · 50s 64/49 · 60s 64/60 · 70s 62/60 · 80+ 34/27.

## 2. Modelos

GAMLSS por fenótipo: ln V ~ SHASHo (ou normal, pelo BIC); μ = P-spline da idade + sexo + sítio aleatório; σ = P-spline da idade + sexo. σ_sítio = DP do efeito de sítio; em z, dividido pelo σ aos 60 anos (F). Erro da curva = erro-padrão do μ populacional por bootstrap de sítios, em z, aos 60 e aos 85 anos.

| Fenótipo | Família | n | Excluídos (\|z\| > 5) | σ_sítio (z) | Erro da curva 60 / 85 anos (z) |
|---|---|---|---|---|---|
| Córtex cerebral | NO | 641 | 0 | 0,22 | 0,08 / 0,15 |
| Substância branca | NO | 641 | 0 | 0,22 | 0,07 / 0,19 |
| Cinzenta subcortical | NO | 641 | 0 | 0,26 | 0,11 / 0,24 |
| Ventrículos | SHASHo | 641 | 0 | 0,00 | 0,10 / 0,32 |
| Cérebro total (GMV+WMV) | NO | 641 | 0 | 0,22 | 0,09 / 0,23 |
| Tálamo E | NO | 641 | 0 | 0,25 | 0,11 / 0,31 |
| Tálamo D | NO | 641 | 0 | 0,27 | 0,10 / 0,31 |
| Caudado E | NO | 641 | 0 | 0,19 | 0,11 / 0,17 |
| Caudado D | NO | 641 | 0 | 0,17 | 0,10 / 0,19 |
| Putâmen E | NO | 641 | 0 | 0,21 | 0,12 / 0,17 |
| Putâmen D | NO | 641 | 0 | 0,21 | 0,11 / 0,22 |
| Pálido E | SHASHo | 641 | 0 | 1,03 | 0,25 / 0,59 |
| Pálido D | SHASHo | 641 | 0 | 0,65 | 0,22 / 0,58 |
| Hipocampo E | NO | 641 | 0 | 0,22 | 0,08 / 0,18 |
| Hipocampo D | SHASHo | 641 | 0 | 0,31 | 0,17 / 0,23 |
| Amígdala E | NO | 641 | 0 | 0,29 | 0,11 / 0,20 |
| Amígdala D | SHASHo | 641 | 0 | 0,35 | 0,17 / 0,35 |
| Accumbens E | SHASHo | 641 | 0 | 0,37 | 0,14 / 0,29 |
| Accumbens D | SHASHo | 641 | 0 | 0,36 | 0,14 / 0,30 |
| Corno temporal E | SHASHo | 641 | 0 | 0,11 | 0,23 / 1,12 |
| Corno temporal D | SHASHo | 641 | 0 | 0,15 | 0,16 / 0,57 |
| Ventrículo lateral E | SHASHo | 641 | 0 | 0,00 | 0,10 / 0,23 |
| Ventrículo lateral D | SHASHo | 641 | 0 | 0,05 | 0,12 / 0,16 |
| Cerebelo | NO | 641 | 0 | 0,22 | 0,10 / 0,25 |
| Tronco | NO | 641 | 0 | 0,13 | 0,09 / 0,20 |
| VIC (eTIV) | NO | 573 | 0 | 0,26 | 0,08 / 0,22 |

## 3. Sítio não visto: própria × pipeline atual

Mesmos exames, cada sítio com n ≥ 10 deixado de fora do ajuste das normas próprias. Ideal num sítio não visto: média ≈ 0, DP ≈ √(1 + σ_sítio²) e |z| > 1,96 em ≈ 5% × o excesso pelo sítio. "RMS sítio" = raiz da média dos quadrados das médias por sítio (viés típico de um sítio). A recentragem do pipeline atual foi ajustada no DLBS, por isso as métricas saem também sem ele.

### Todos os sítios (641 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | −0,02 · 1,04 · 5,9% · 0,33 | −0,02 · 0,95 · 4,4% · 0,25 | +0,28 · 1,03 · 7,6% · 0,37 |
| Substância branca | −0,04 · 1,04 · 5,0% · 0,30 | +0,08 · 0,86 · 1,9% · 0,25 | −0,50 · 0,86 · 3,6% · 0,53 |
| Cinzenta subcortical | −0,15 · 1,13 · 7,8% · 0,32 | +0,33 · 1,00 · 6,2% · 0,47 | −0,50 · 1,02 · 8,0% · 0,53 |
| Ventrículos | −0,01 · 1,02 · 5,0% · 0,18 | −0,00 · 0,88 · 2,8% · 0,24 | +0,20 · 0,92 · 3,4% · 0,50 |
| Cérebro total (GMV+WMV) | −0,03 · 1,04 · 4,4% · 0,30 | +0,04 · 0,95 · 3,0% · 0,26 | −0,22 · 0,98 · 3,4% · 0,37 |
| Tálamo E | −0,02 · 1,08 · 7,2% · 0,36 | −0,02 · 1,15 · 9,0% · 0,58 | −0,54 · 1,10 · 10,6% · 0,61 |
| Tálamo D | −0,13 · 1,18 · 9,4% · 0,36 | +0,22 · 1,16 · 9,2% · 0,46 | −0,71 · 1,15 · 14,4% · 0,74 |
| Caudado E | −0,09 · 1,05 · 7,0% · 0,26 | +0,25 · 0,93 · 4,5% · 0,40 | +0,62 · 0,96 · 8,1% · 0,83 |
| Caudado D | −0,09 · 1,06 · 6,6% · 0,25 | +0,24 · 0,93 · 3,6% · 0,37 | +0,49 · 0,99 · 6,9% · 0,72 |
| Putâmen E | −0,10 · 1,09 · 6,2% · 0,28 | +0,25 · 0,91 · 3,3% · 0,40 | +0,63 · 0,92 · 7,5% · 0,68 |
| Putâmen D | −0,12 · 1,08 · 5,6% · 0,26 | +0,33 · 0,97 · 5,6% · 0,51 | +0,28 · 0,98 · 5,0% · 0,40 |
| Pálido E | −0,37 · 1,34 · 14,2% · 0,74 | +1,07 · 1,36 · 29,2% · 1,68 | −2,20 · 1,35 · 50,4% · 1,92 |
| Pálido D | −0,28 · 1,21 · 10,0% · 0,57 | +0,75 · 1,20 · 16,8% · 1,19 | −1,65 · 1,28 · 34,0% · 1,38 |
| Hipocampo E | −0,06 · 1,09 · 8,1% · 0,32 | +0,14 · 1,06 · 7,5% · 0,34 | −0,03 · 1,07 · 6,9% · 0,36 |
| Hipocampo D | −0,10 · 1,12 · 7,5% · 0,32 | +0,19 · 1,18 · 8,9% · 0,37 | −0,01 · 1,19 · 8,1% · 0,33 |
| Amígdala E | −0,19 · 1,17 · 8,4% · 0,32 | +0,40 · 1,00 · 6,4% · 0,59 | +0,43 · 1,00 · 7,0% · 0,59 |
| Amígdala D | −0,20 · 1,16 · 8,6% · 0,36 | +0,48 · 0,99 · 7,5% · 0,70 | +0,13 · 0,99 · 4,5% · 0,41 |
| Accumbens E | −0,17 · 1,10 · 8,7% · 0,41 | +0,40 · 0,85 · 4,4% · 0,63 | +1,47 · 0,86 · 27,6% · 1,58 |
| Accumbens D | −0,17 · 1,11 · 8,3% · 0,42 | +0,44 · 0,96 · 7,5% · 0,66 | +0,96 · 0,97 · 15,6% · 1,11 |
| **Média das medidas** (\|média\|) | **0,12 · 1,11 · 7,6% · 0,35** | **0,30 · 1,01 · 7,5% · 0,54** | **0,62 · 1,03 · 12,2% · 0,74** |

### Sem o DLBS (440 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | −0,02 · 1,07 · 7,0% · 0,34 | −0,02 · 0,97 · 4,5% · 0,26 | +0,21 · 1,06 · 7,7% · 0,37 |
| Substância branca | +0,01 · 1,09 · 6,6% · 0,30 | +0,12 · 0,89 · 2,5% · 0,26 | −0,46 · 0,90 · 4,5% · 0,53 |
| Cinzenta subcortical | +0,09 · 1,01 · 5,0% · 0,27 | +0,48 · 0,95 · 6,8% · 0,49 | −0,31 · 0,96 · 4,8% · 0,48 |
| Ventrículos | −0,01 · 1,02 · 5,0% · 0,19 | −0,00 · 0,88 · 2,7% · 0,25 | +0,24 · 0,93 · 4,1% · 0,52 |
| Cérebro total (GMV+WMV) | +0,00 · 1,08 · 5,7% · 0,31 | +0,06 · 0,98 · 3,4% · 0,26 | −0,22 · 1,01 · 4,5% · 0,38 |
| Tálamo E | +0,05 · 1,03 · 6,4% · 0,37 | −0,03 · 1,16 · 9,3% · 0,60 | −0,48 · 1,06 · 9,8% · 0,60 |
| Tálamo D | +0,09 · 1,02 · 5,9% · 0,33 | +0,33 · 1,11 · 8,9% · 0,48 | −0,55 · 1,06 · 10,5% · 0,71 |
| Caudado E | +0,06 · 1,03 · 6,8% · 0,24 | +0,36 · 0,92 · 5,5% · 0,41 | +0,78 · 0,94 · 9,5% · 0,86 |
| Caudado D | +0,06 · 1,02 · 5,9% · 0,23 | +0,35 · 0,92 · 4,5% · 0,38 | +0,66 · 0,95 · 7,7% · 0,75 |
| Putâmen E | +0,07 · 1,00 · 4,1% · 0,26 | +0,36 · 0,87 · 3,4% · 0,41 | +0,72 · 0,89 · 7,5% · 0,69 |
| Putâmen D | +0,08 · 0,99 · 3,9% · 0,23 | +0,48 · 0,92 · 5,7% · 0,53 | +0,41 · 0,94 · 4,8% · 0,42 |
| Pálido E | +0,17 · 1,01 · 5,0% · 0,64 | +1,55 · 1,03 · 35,7% · 1,75 | −1,71 · 0,97 · 36,4% · 1,77 |
| Pálido D | +0,14 · 1,02 · 5,7% · 0,49 | +1,10 · 0,99 · 18,4% · 1,24 | −1,22 · 0,96 · 18,9% · 1,24 |
| Hipocampo E | +0,05 · 1,06 · 7,5% · 0,32 | +0,21 · 1,03 · 7,0% · 0,35 | +0,04 · 1,04 · 6,8% · 0,38 |
| Hipocampo D | +0,07 · 1,04 · 7,0% · 0,31 | +0,30 · 1,08 · 8,9% · 0,38 | +0,11 · 1,08 · 7,7% · 0,33 |
| Amígdala E | +0,07 · 0,97 · 4,1% · 0,26 | +0,58 · 0,88 · 6,1% · 0,61 | +0,60 · 0,89 · 6,8% · 0,61 |
| Amígdala D | +0,11 · 0,98 · 4,5% · 0,29 | +0,71 · 0,87 · 7,7% · 0,73 | +0,37 · 0,87 · 2,5% · 0,41 |
| Accumbens E | +0,10 · 1,08 · 8,2% · 0,37 | +0,58 · 0,82 · 5,5% · 0,66 | +1,61 · 0,84 · 32,7% · 1,61 |
| Accumbens D | +0,12 · 1,05 · 6,8% · 0,37 | +0,64 · 0,90 · 8,6% · 0,68 | +1,15 · 0,92 · 19,3% · 1,14 |
| **Média das medidas** (\|média\|) | **0,07 · 1,03 · 5,8% · 0,32** | **0,43 · 0,96 · 8,2% · 0,56** | **0,62 · 0,96 · 10,9% · 0,73** |

Medidas só das normas próprias (sem equivalente no pipeline atual):

| Medida | média · DP · \|z\|>1,96 · RMS sítio |
|---|---|
| Corno temporal E | −0,02 · 1,05 · 6,2% · 0,37 |
| Corno temporal D | +0,01 · 1,04 · 5,9% · 0,22 |
| Ventrículo lateral E | −0,02 · 1,02 · 5,8% · 0,16 |
| Ventrículo lateral D | −0,00 · 1,02 · 5,5% · 0,23 |
| Cerebelo | −0,06 · 1,06 · 7,3% · 0,31 |
| Tronco | −0,06 · 1,04 · 6,1% · 0,21 |
| VIC (eTIV) | +0,07 · 1,06 · 5,9% · 0,37 |

## 4. Por década, sexo e fabricante (sítio não visto)

| Década | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| 10s | 26 | +0,08 (1,21) / −0,13 (1,10) | −0,15 (1,19) / −0,08 (1,07) | +0,21 (0,98) / +0,56 (0,71) | −0,02 (1,15) / −0,01 (0,97) | +0,02 (1,18) / +0,13 (1,04) |
| 20s | 102 | +0,10 (1,01) / +0,03 (0,92) | +0,05 (1,00) / +0,09 (0,90) | −0,05 (0,94) / +0,24 (0,69) | −0,09 (0,97) / −0,10 (0,86) | −0,06 (0,98) / +0,02 (0,92) |
| 30s | 50 | −0,18 (1,01) / −0,14 (0,95) | −0,05 (1,05) / −0,02 (0,97) | −0,14 (1,18) / −0,06 (0,90) | +0,06 (1,31) / +0,09 (1,23) | −0,05 (1,26) / +0,03 (1,24) |
| 40s | 43 | −0,15 (1,05) / −0,09 (0,99) | −0,11 (1,05) / −0,06 (0,98) | +0,10 (1,07) / −0,04 (0,88) | −0,19 (1,05) / −0,05 (0,98) | −0,17 (1,06) / −0,02 (1,02) |
| 50s | 113 | +0,01 (0,95) / +0,03 (0,91) | +0,10 (0,97) / +0,14 (0,93) | +0,02 (1,14) / −0,14 (0,97) | +0,10 (1,01) / +0,32 (0,96) | +0,11 (0,97) / +0,32 (0,96) |
| 60s | 124 | −0,04 (1,10) / −0,02 (1,02) | −0,03 (1,08) / +0,04 (1,00) | −0,06 (0,89) / −0,19 (0,79) | −0,01 (0,98) / +0,24 (0,94) | −0,04 (1,00) / +0,24 (1,00) |
| 70s | 122 | −0,05 (1,11) / −0,02 (0,98) | −0,09 (1,11) / −0,00 (1,00) | +0,06 (1,02) / +0,01 (0,92) | +0,00 (1,14) / +0,33 (1,20) | +0,02 (1,13) / +0,51 (1,28) |
| 80+ | 61 | −0,03 (0,92) / +0,02 (0,83) | −0,18 (0,93) / +0,02 (0,85) | −0,13 (1,01) / +0,05 (0,94) | −0,56 (1,25) / −0,10 (1,28) | −0,93 (1,42) / −0,20 (1,87) |

| Sexo | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| F | 346 | −0,02 (1,03) / −0,05 (0,97) | −0,03 (1,04) / +0,01 (0,97) | −0,03 (1,02) / +0,02 (0,88) | −0,04 (1,09) / +0,09 (1,10) | −0,09 (1,10) / +0,18 (1,15) |
| M | 295 | −0,02 (1,04) / +0,02 (0,94) | −0,03 (1,04) / +0,07 (0,94) | +0,01 (1,02) / −0,03 (0,87) | −0,08 (1,10) / +0,20 (1,01) | −0,11 (1,16) / +0,21 (1,22) |

| Fabricante | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| GE | 60 | −0,00 (0,89) / −0,01 (0,84) | +0,07 (0,84) / +0,09 (0,79) | +0,00 (0,97) / +0,03 (0,79) | +0,08 (1,05) / +0,17 (0,98) | +0,19 (1,01) / +0,33 (1,01) |
| Philips | 301 | −0,05 (1,05) / −0,03 (0,95) | −0,13 (1,03) / −0,03 (0,94) | −0,02 (0,98) / +0,02 (0,85) | −0,33 (1,07) / −0,06 (1,04) | −0,40 (1,14) / −0,03 (1,24) |
| Siemens | 280 | +0,00 (1,06) / −0,00 (0,98) | +0,06 (1,08) / +0,10 (0,99) | −0,00 (1,07) / −0,03 (0,92) | +0,20 (1,06) / +0,36 (1,05) | +0,16 (1,05) / +0,40 (1,11) |

Valores: média do z (DP).

## 5. Com controles locais (calibração do app)

O z de cada sítio é deslocado pela média de k controles sorteados do próprio sítio; métricas nos demais exames do sítio (sítios com n ≥ k + 10; 200 sorteios). Ideal: RMS da média → 0, DP → 1, |z| > 1,96 → 5%.

| k | Própria: RMS média · DP · \|z\|>1,96 | Atual (recentrado) |
|---|---|---|
| sem | 0,35 · 1,11 · 7,6% | 0,54 · 1,01 · 7,5% |
| 5 | 0,50 · 0,99 · 7,4% | 0,46 · 0,92 · 5,6% |
| 10 | 0,39 · 1,00 · 6,6% | 0,36 · 0,93 · 5,1% |
| 20 | 0,30 · 0,99 · 5,8% | 0,28 · 0,93 · 4,5% |
| 30 | 0,30 · 0,98 · 5,5% | 0,28 · 0,92 · 4,4% |

Médias sobre as medidas comuns (globais e subcorticais E/D).

## 6. Leitura

Ver a seção "Validação" de `docs/normas-proprias.md` para a interpretação e as limitações.
