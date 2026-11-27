# Normas SegmentaRM — validação deixando um sítio de fora

Gerado por `tools/normas_relatorio.py` em 2026-11-27 (normas versão 2.0). Não edite à mão: rode o pipeline de `docs/normas-proprias.md` §4.

## 1. Amostra

1026 exames de 35 sítios (sítio = scanner × protocolo); idades 18–89 anos; 548 F / 478 M. Volumes SUAVES do SynthSeg 1.0 do app (bloco 128³, espelhamento E/D); VIC = eTIV afim do app.

| Sítio | Base | Scanner | n | Idades | F/M |
|---|---|---|---|---|---|
| aomic_id1000 | ds003097 | Philips Intera 3T | 20 | 19–26 | 10/10 |
| aomic_piop1 | ds002785 | Philips Achieva 3T | 15 | 19–26 | 9/6 |
| aomic_piop2 | ds002790 | Philips Achieva 3T | 15 | 19–26 | 9/6 |
| dlbs | ds004856 | Philips Achieva 3T | 201 | 21–89 | 104/97 |
| ds3592_s1 | ds003592 | Siemens 3T (incerto) 3T | 35 | 19–83 | 18/17 |
| ds3592_s2 | ds003592 | Siemens 3T (incerto) 3T | 25 | 18–82 | 18/7 |
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
| la5c | ds000030 | Siemens Trio 3T | 30 | 21–50 | 18/12 |
| mrart | ds004173 | Siemens Prisma 3T | 40 | 19–75 | 21/19 |
| nimh_fspgr | ds005752 | GE DISCOVERY MR750 3T | 20 | 18–72 | 12/8 |
| nimh_mprage | ds005752 | GE DISCOVERY MR750 3T | 40 | 19–71 | 23/17 |
| pan_atlanta | ds007522 | Siemens MAGNETOM Prisma Fit 3T | 50 | 49–78 | 26/24 |
| pan_baltimore | ds007522 | Philips Ingenia Elition X 3T | 50 | 51–79 | 26/24 |
| pan_miami | ds007522 | Siemens MAGNETOM Vida 3T | 50 | 50–78 | 26/24 |
| pan_tucson | ds007522 | Siemens Skyra 3T | 50 | 50–79 | 26/24 |

Por década (F/M): 10s 31/27 · 20s 141/112 · 30s 48/53 · 40s 45/44 · 50s 91/69 · 60s 86/70 · 70s 71/75 · 80+ 35/28.

## 2. Modelos

GAMLSS por fenótipo: ln V ~ SHASHo (ou normal, pelo BIC); μ = P-spline da idade + sexo + sítio aleatório; σ = P-spline da idade + sexo. σ_sítio = DP do efeito de sítio; em z, dividido pelo σ aos 60 anos (F). Erro da curva = erro-padrão do μ populacional por bootstrap de sítios, em z, aos 60 e aos 85 anos.

| Fenótipo | Família | n | Excluídos (\|z\| > 5) | σ_sítio (z) | Erro da curva 60 / 85 anos (z) |
|---|---|---|---|---|---|
| Córtex cerebral | NO | 1026 | 0 | 0,28 | 0,08 / 0,22 |
| Substância branca | NO | 1026 | 0 | 0,21 | 0,06 / 0,14 |
| Cinzenta subcortical | NO | 1026 | 0 | 0,40 | 0,10 / 0,19 |
| Ventrículos | SHASHo | 1025 | 1 | 0,00 | 0,10 / 0,19 |
| Cérebro total (GMV+WMV) | SHASHo | 1026 | 0 | 0,24 | 0,11 / 0,18 |
| Tálamo E | NO | 1026 | 0 | 0,53 | 0,14 / 0,18 |
| Tálamo D | NO | 1026 | 0 | 0,42 | 0,12 / 0,17 |
| Caudado E | NO | 1026 | 0 | 0,19 | 0,06 / 0,24 |
| Caudado D | SHASHo | 1026 | 0 | 0,19 | 0,07 / 0,16 |
| Putâmen E | SHASHo | 1026 | 0 | 0,50 | 0,13 / 0,21 |
| Putâmen D | SHASHo | 1026 | 0 | 0,38 | 0,09 / 0,19 |
| Pálido E | SHASHo | 1026 | 0 | 0,77 | 0,14 / 0,47 |
| Pálido D | SHASHo | 1026 | 0 | 0,49 | 0,22 / 0,38 |
| Hipocampo E | NO | 1026 | 0 | 0,40 | 0,09 / 0,27 |
| Hipocampo D | SHASHo | 1026 | 0 | 0,49 | 0,14 / 0,19 |
| Amígdala E | SHASHo | 1026 | 0 | 0,55 | 0,12 / 0,20 |
| Amígdala D | SHASHo | 1026 | 0 | 0,68 | 0,15 / 0,23 |
| Accumbens E | SHASHo | 1026 | 0 | 0,34 | 0,15 / 0,20 |
| Accumbens D | SHASHo | 1026 | 0 | 0,27 | 0,11 / 0,24 |
| Corno temporal E | SHASHo | 1026 | 0 | 0,40 | 0,22 / 0,60 |
| Corno temporal D | SHASHo | 1026 | 0 | 0,38 | 0,26 / 0,23 |
| Ventrículo lateral E | SHASHo | 1026 | 0 | 0,00 | 0,12 / 0,20 |
| Ventrículo lateral D | SHASHo | 1025 | 1 | 0,00 | 0,12 / 0,20 |
| Cerebelo | NO | 1026 | 0 | 0,28 | 0,08 / 0,16 |
| Tronco | NO | 1026 | 0 | 0,24 | 0,05 / 0,15 |
| VIC (eTIV) | NO | 915 | 0 | 0,32 | 0,09 / 0,13 |

## 3. Sítio não visto: própria × pipeline atual

Mesmos exames, cada sítio com n ≥ 10 deixado de fora do ajuste das normas próprias. Ideal num sítio não visto: média ≈ 0, DP ≈ √(1 + σ_sítio²) e |z| > 1,96 em ≈ 5% × o excesso pelo sítio. "RMS sítio" = raiz da média dos quadrados das médias por sítio (viés típico de um sítio). A recentragem do pipeline atual foi ajustada no DLBS, por isso as métricas saem também sem ele.

### Todos os sítios (1026 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | +0,01 · 1,06 · 5,8% · 0,46 | −0,04 · 0,93 · 3,9% · 0,36 | +0,13 · 1,04 · 7,2% · 0,48 |
| Substância branca | −0,03 · 1,04 · 5,7% · 0,36 | +0,14 · 0,87 · 2,2% · 0,33 | −0,45 · 0,87 · 4,5% · 0,54 |
| Cinzenta subcortical | +0,03 · 1,13 · 8,1% · 0,57 | +0,28 · 1,01 · 5,8% · 0,51 | −0,53 · 1,03 · 8,4% · 0,78 |
| Ventrículos | −0,01 · 1,01 · 5,1% · 0,24 | +0,03 · 0,87 · 3,0% · 0,29 | +0,29 · 0,94 · 4,0% · 0,63 |
| Cérebro total (GMV+WMV) | −0,00 · 1,04 · 5,5% · 0,39 | +0,06 · 0,94 · 3,9% · 0,32 | −0,25 · 0,97 · 4,3% · 0,51 |
| Tálamo E | +0,20 · 1,18 · 10,0% · 0,72 | −0,30 · 1,21 · 12,1% · 1,02 | −0,67 · 1,12 · 13,0% · 0,99 |
| Tálamo D | +0,07 · 1,12 · 8,1% · 0,57 | +0,06 · 1,14 · 8,3% · 0,61 | −0,79 · 1,12 · 14,5% · 1,00 |
| Caudado E | −0,02 · 1,04 · 5,3% · 0,34 | +0,24 · 0,97 · 4,3% · 0,41 | +0,67 · 1,00 · 10,2% · 0,84 |
| Caudado D | −0,02 · 1,04 · 6,0% · 0,35 | +0,22 · 0,97 · 4,1% · 0,41 | +0,55 · 1,01 · 8,8% · 0,77 |
| Putâmen E | +0,05 · 1,10 · 7,1% · 0,50 | +0,27 · 0,96 · 4,8% · 0,49 | +0,59 · 0,97 · 8,1% · 0,64 |
| Putâmen D | +0,02 · 1,09 · 6,3% · 0,46 | +0,38 · 1,00 · 6,6% · 0,57 | +0,25 · 1,00 · 5,7% · 0,46 |
| Pálido E | −0,32 · 1,32 · 13,2% · 0,68 | +1,29 · 1,32 · 33,3% · 1,84 | −2,02 · 1,28 · 44,8% · 1,77 |
| Pálido D | −0,22 · 1,22 · 9,5% · 0,54 | +0,87 · 1,11 · 16,8% · 1,24 | −1,50 · 1,17 · 29,4% · 1,29 |
| Hipocampo E | +0,08 · 1,13 · 7,9% · 0,52 | +0,10 · 1,07 · 7,4% · 0,47 | −0,08 · 1,08 · 7,0% · 0,56 |
| Hipocampo D | +0,05 · 1,19 · 8,6% · 0,53 | +0,16 · 1,13 · 8,0% · 0,49 | −0,04 · 1,14 · 7,2% · 0,52 |
| Amígdala E | +0,05 · 1,16 · 8,7% · 0,60 | +0,31 · 1,05 · 6,1% · 0,57 | +0,32 · 1,06 · 6,5% · 0,57 |
| Amígdala D | +0,02 · 1,19 · 9,0% · 0,70 | +0,38 · 1,03 · 6,5% · 0,66 | +0,03 · 1,04 · 5,6% · 0,56 |
| Accumbens E | −0,07 · 1,09 · 7,7% · 0,41 | +0,49 · 0,86 · 5,7% · 0,65 | +1,51 · 0,85 · 28,8% · 1,54 |
| Accumbens D | −0,09 · 1,09 · 7,0% · 0,39 | +0,50 · 0,94 · 6,4% · 0,67 | +0,99 · 0,94 · 16,6% · 1,06 |
| **Média das medidas** (\|média\|) | **0,07 · 1,12 · 7,6% · 0,49** | **0,32 · 1,02 · 7,9% · 0,63** | **0,61 · 1,03 · 12,3% · 0,82** |

### Sem o DLBS (825 exames)

| Medida | Própria: média · DP · \|z\|>1,96 · RMS sítio | Atual (recentrado) | BrainChart/CentileBrain cru |
|---|---|---|---|
| Córtex cerebral | +0,01 · 1,08 · 6,3% · 0,47 | −0,05 · 0,94 · 3,9% · 0,36 | +0,07 · 1,04 · 7,2% · 0,48 |
| Substância branca | +0,02 · 1,07 · 6,7% · 0,37 | +0,18 · 0,89 · 2,7% · 0,33 | −0,42 · 0,89 · 5,2% · 0,54 |
| Cinzenta subcortical | +0,13 · 1,11 · 8,0% · 0,57 | +0,34 · 1,00 · 6,1% · 0,51 | −0,44 · 1,01 · 6,8% · 0,77 |
| Ventrículos | −0,02 · 1,01 · 5,1% · 0,24 | +0,03 · 0,87 · 3,0% · 0,29 | +0,33 · 0,94 · 4,5% · 0,64 |
| Cérebro total (GMV+WMV) | +0,03 · 1,07 · 6,5% · 0,39 | +0,07 · 0,95 · 4,4% · 0,32 | −0,26 · 0,98 · 5,1% · 0,51 |
| Tálamo E | +0,17 · 1,18 · 9,7% · 0,73 | −0,37 · 1,22 · 13,0% · 1,04 | −0,67 · 1,10 · 13,1% · 1,00 |
| Tálamo D | +0,12 · 1,10 · 8,0% · 0,58 | +0,07 · 1,12 · 7,9% · 0,62 | −0,73 · 1,07 · 12,5% · 1,00 |
| Caudado E | +0,04 · 1,04 · 5,3% · 0,34 | +0,29 · 0,98 · 4,7% · 0,41 | +0,76 · 0,99 · 11,5% · 0,86 |
| Caudado D | +0,04 · 1,04 · 6,0% · 0,36 | +0,28 · 0,97 · 4,7% · 0,41 | +0,66 · 1,00 · 9,7% · 0,78 |
| Putâmen E | +0,12 · 1,09 · 6,8% · 0,51 | +0,34 · 0,95 · 5,2% · 0,49 | +0,62 · 0,97 · 8,2% · 0,64 |
| Putâmen D | +0,11 · 1,06 · 6,1% · 0,47 | +0,47 · 0,97 · 6,9% · 0,58 | +0,31 · 0,98 · 5,7% · 0,47 |
| Pálido E | +0,02 · 1,07 · 7,1% · 0,62 | +1,60 · 1,09 · 37,8% · 1,86 | −1,72 · 1,03 · 36,0% · 1,71 |
| Pálido D | +0,03 · 1,06 · 5,7% · 0,50 | +1,08 · 0,96 · 17,6% · 1,25 | −1,23 · 0,93 · 20,2% · 1,23 |
| Hipocampo E | +0,14 · 1,11 · 7,8% · 0,53 | +0,13 · 1,06 · 7,2% · 0,48 | −0,05 · 1,08 · 7,0% · 0,56 |
| Hipocampo D | +0,14 · 1,12 · 8,2% · 0,53 | +0,20 · 1,07 · 7,8% · 0,49 | +0,02 · 1,07 · 6,8% · 0,52 |
| Amígdala E | +0,16 · 1,14 · 8,4% · 0,60 | +0,38 · 1,02 · 5,9% · 0,58 | +0,38 · 1,03 · 6,3% · 0,58 |
| Amígdala D | +0,15 · 1,16 · 8,6% · 0,71 | +0,47 · 1,01 · 6,4% · 0,67 | +0,13 · 1,01 · 4,7% · 0,56 |
| Accumbens E | +0,07 · 1,08 · 7,1% · 0,40 | +0,61 · 0,83 · 6,5% · 0,66 | +1,59 · 0,84 · 31,9% · 1,55 |
| Accumbens D | +0,06 · 1,05 · 6,3% · 0,38 | +0,62 · 0,90 · 6,8% · 0,68 | +1,09 · 0,91 · 18,8% · 1,07 |
| **Média das medidas** (\|média\|) | **0,08 · 1,09 · 7,0% · 0,49** | **0,40 · 0,99 · 8,3% · 0,63** | **0,60 · 0,99 · 11,6% · 0,82** |

Medidas só das normas próprias (sem equivalente no pipeline atual):

| Medida | média · DP · \|z\|>1,96 · RMS sítio |
|---|---|
| Corno temporal E | −0,09 · 1,07 · 6,5% · 0,44 |
| Corno temporal D | −0,08 · 1,10 · 7,4% · 0,46 |
| Ventrículo lateral E | −0,01 · 1,02 · 4,8% · 0,23 |
| Ventrículo lateral D | −0,00 · 1,01 · 5,4% · 0,24 |
| Cerebelo | −0,03 · 1,06 · 6,7% · 0,42 |
| Tronco | +0,00 · 1,05 · 6,0% · 0,36 |
| VIC (eTIV) | +0,09 · 1,08 · 6,4% · 0,48 |

## 4. Por década, sexo e fabricante (sítio não visto)

| Década | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| 10s | 58 | +0,33 (1,13) / +0,04 (0,86) | +0,21 (1,02) / +0,23 (0,82) | +0,08 (1,07) / +0,47 (0,75) | +0,40 (0,98) / +0,24 (0,90) | +0,37 (1,04) / +0,32 (0,88) |
| 20s | 253 | −0,00 (1,11) / −0,11 (0,88) | −0,04 (1,06) / +0,02 (0,86) | −0,04 (0,95) / +0,30 (0,74) | −0,02 (1,13) / −0,13 (1,01) | −0,00 (1,14) / −0,04 (1,01) |
| 30s | 101 | −0,12 (1,07) / −0,19 (0,90) | −0,07 (1,10) / −0,07 (0,95) | −0,08 (1,08) / −0,02 (0,84) | +0,18 (1,20) / +0,09 (1,13) | +0,14 (1,20) / +0,08 (1,16) |
| 40s | 89 | +0,01 (1,14) / −0,06 (1,03) | +0,06 (1,10) / +0,03 (1,00) | +0,09 (1,09) / −0,10 (0,89) | −0,04 (1,27) / −0,02 (1,17) | −0,02 (1,31) / −0,01 (1,22) |
| 50s | 160 | +0,07 (0,97) / +0,05 (0,93) | +0,12 (1,00) / +0,12 (0,93) | +0,02 (1,09) / −0,22 (0,93) | +0,15 (1,05) / +0,23 (1,01) | +0,19 (1,02) / +0,27 (0,93) |
| 60s | 156 | +0,01 (1,07) / +0,01 (1,00) | +0,07 (1,08) / +0,13 (1,04) | −0,04 (0,98) / −0,21 (0,87) | +0,18 (1,00) / +0,25 (0,98) | +0,12 (1,11) / +0,27 (1,05) |
| 70s | 146 | −0,03 (1,03) / −0,03 (0,97) | −0,11 (1,01) / +0,03 (0,99) | +0,03 (0,96) / −0,02 (0,87) | +0,16 (1,11) / +0,33 (1,14) | +0,12 (1,08) / +0,48 (1,13) |
| 80+ | 63 | −0,06 (0,85) / +0,01 (0,82) | −0,26 (0,82) / +0,02 (0,85) | −0,06 (1,02) / +0,05 (0,95) | −0,40 (1,29) / −0,12 (1,27) | −0,81 (1,69) / −0,19 (1,85) |

| Sexo | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| F | 548 | +0,01 (1,04) / −0,05 (0,95) | +0,00 (1,03) / +0,05 (0,97) | −0,02 (1,01) / +0,05 (0,90) | +0,08 (1,12) / +0,09 (1,10) | +0,05 (1,15) / +0,17 (1,15) |
| M | 478 | +0,01 (1,08) / −0,03 (0,91) | −0,01 (1,06) / +0,07 (0,90) | +0,00 (1,02) / −0,00 (0,84) | +0,08 (1,13) / +0,12 (1,04) | +0,04 (1,24) / +0,14 (1,11) |

| Fabricante | n | Córtex cerebral: própria / atual | Cérebro total (GMV+WMV): própria / atual | Ventrículos: própria / atual | Hipocampo E: própria / atual | Hipocampo D: própria / atual |
|---|---|---|---|---|---|---|
| GE | 60 | +0,19 (1,05) / +0,09 (0,95) | +0,17 (1,00) / +0,17 (0,90) | +0,02 (0,98) / +0,09 (0,94) | +0,34 (0,99) / +0,31 (0,96) | +0,42 (1,06) / +0,42 (1,01) |
| Philips | 301 | +0,06 (1,03) / +0,02 (0,94) | −0,07 (1,00) / +0,03 (0,94) | +0,02 (0,98) / +0,03 (0,85) | −0,13 (1,12) / −0,03 (1,07) | −0,23 (1,29) / −0,01 (1,25) |
| Siemens | 280 | +0,04 (1,08) / −0,00 (0,97) | +0,05 (1,07) / +0,10 (0,99) | +0,03 (1,03) / −0,03 (0,90) | +0,40 (1,03) / +0,43 (1,02) | +0,36 (1,01) / +0,47 (1,01) |

Valores: média do z (DP).

## 5. Com controles locais (calibração do app)

O z de cada sítio é deslocado pela média de k controles sorteados do próprio sítio; métricas nos demais exames do sítio (sítios com n ≥ k + 10; 200 sorteios). Ideal: RMS da média → 0, DP → 1, |z| > 1,96 → 5%.

| k | Própria: RMS média · DP · \|z\|>1,96 | Atual (recentrado) |
|---|---|---|
| sem | 0,49 · 1,12 · 7,6% | 0,63 · 1,02 · 7,9% |
| 5 | 0,52 · 1,02 · 8,3% | 0,47 · 0,93 · 5,8% |
| 10 | 0,40 · 1,01 · 6,6% | 0,36 · 0,92 · 4,8% |
| 20 | 0,32 · 1,00 · 5,9% | 0,30 · 0,93 · 4,4% |
| 30 | 0,29 · 0,98 · 5,2% | 0,27 · 0,91 · 4,0% |

Médias sobre as medidas comuns (globais e subcorticais E/D).

## 6. Leitura

Ver a seção "Validação" de `docs/normas-proprias.md` para a interpretação e as limitações.
